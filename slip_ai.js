// Slip reader API: signed-in users only when the beta gate is on. Gemini (vision) only
// extracts picks from the uploaded image. All grades come from our grader. The API key
// is a Worker secret and must never be logged, returned, or shown. Images are not stored.
import { identify, gateState } from "./beta_auth.js";
import { hasGeminiKey, geminiModel, geminiRequest, loadStore, formatGeminiDetail, sanitizeDetail } from "./ask_ai.js";

// Current Workers AI vision model (newer than Llama 3.2 11B Vision). Official docs
// do not require a one-time "agree" prompt for this model (Llama 3.2 11B does).
export const WORKERS_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const WORKERS_AI_TIMEOUT_MS = 12000;

import { parseExtracted, parseGeminiJson, matchPick, gradePicks, summarizeSlip } from "./slip_reader.js";

const USER_DAILY = 10;
const COOLDOWN_MS = 5000;
const MAX_BYTES = 5 * 1024 * 1024;
const SETUP_MSG = "Slip reader isn't set up yet.";
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);
const lastHit = new Map();

export function isSlipPath(path) {
  return path === "/ai/slip/read" || path === "/ai/slip/grade";
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json", "Cache-Control": "no-store" }
  });
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "local";
}

function utcDay(d) {
  return new Date(d || Date.now()).toISOString().slice(0, 10);
}

function whoKey(who, request) {
  if (who && who.user) return "u:" + who.user;
  if (who && who.admin) return "admin";
  return "ip:" + clientIp(request);
}

function sameOrigin(request, url) {
  const o = request.headers.get("Origin");
  if (o && o !== url.origin) return false;
  return true;
}

async function rateLimit(env, key) {
  const now = Date.now();
  const prev = lastHit.get(key) || 0;
  if (now - prev < COOLDOWN_MS) return { ok: false, retry: true, msg: "Please wait a moment before uploading again." };
  lastHit.set(key, now);
  if (!env || !env.BETA || typeof env.BETA.get !== "function") return { ok: true };
  const day = utcDay();
  const kvKey = "slip:day:" + day + ":" + key;
  let n = 0;
  try { n = parseInt((await env.BETA.get(kvKey)) || "0", 10) || 0; } catch (e) { n = 0; }
  if (n >= USER_DAILY) return { ok: false, daily: true, msg: "You've reached today's slip limit (10). Try again tomorrow." };
  try { await env.BETA.put(kvKey, String(n + 1), { expirationTtl: 172800 }); } catch (e) {}
  return { ok: true, left: USER_DAILY - n - 1 };
}

function sniffMime(bytes, hinted) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    const tag = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (tag === "WEBP") return "image/webp";
  }
  const h = String(hinted || "").toLowerCase();
  if (h === "image/jpg") return "image/jpeg";
  if (ALLOWED.has(h)) return h;
  return null;
}

function b64ToBytes(b64) {
  const s = String(b64 || "").replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "").replace(/\s+/g, "");
  if (!s) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    return null;
  }
}

function bytesToB64(bytes) {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(s);
}

async function readImage(request) {
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (ct.includes("multipart/form-data")) {
    let form;
    try { form = await request.formData(); } catch (e) { return { error: "Could not read that upload." }; }
    const file = form.get("image") || form.get("file") || form.get("slip");
    if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
      return { error: "Please upload a PNG, JPG, or WebP image of your slip." };
    }
    const hinted = file.type || "";
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length > MAX_BYTES) return { error: "Please use an image under 5 MB." };
    const mime = sniffMime(buf, hinted);
    if (!mime || !ALLOWED.has(mime)) return { error: "Please upload a PNG, JPG, or WebP image of your slip." };
    return { mime, bytes: buf };
  }
  let body;
  try { body = await request.json(); } catch (e) { return { error: "Bad request" }; }
  const bytes = b64ToBytes(body && (body.image || body.data || body.file));
  if (!bytes) return { error: "Please upload a PNG, JPG, or WebP image of your slip." };
  if (bytes.length > MAX_BYTES) return { error: "Please use an image under 5 MB." };
  const mime = sniffMime(bytes, body.mime || body.type);
  if (!mime || !ALLOWED.has(mime)) return { error: "Please upload a PNG, JPG, or WebP image of your slip." };
  return { mime, bytes };
}

export function extractPrompt() {
  return [
    "You extract CS2 player-prop legs from a sportsbook slip screenshot (PrizePicks, Underdog, or similar).",
    "Reply with JSON only, no markdown, no commentary.",
    "Schema: {\"readable\":boolean,\"cs2\":boolean,\"book\":string|null,\"entry\":number|null,\"payout\":number|null,\"note\":string|null,\"picks\":[{\"player\":string,\"team\":string|null,\"opponent\":string|null,\"stat\":\"kills\"|\"headshots\"|string,\"line\":number,\"period\":\"Map 1\"|\"Maps 1-2\"|null,\"side\":\"over\"|\"under\"|null,\"book\":string|null}]}",
    "readable is false if the image is blank, too blurry, or is not a slip. cs2 is false if the slip is not Counter-Strike 2 player props.",
    "stat should be kills or headshots when that is what the slip shows. period is Map 1 or Maps 1-2 when visible, otherwise null.",
    "side is the user's over or under on that leg. entry and payout are dollars when visible.",
    "Only include legs you can actually see. Do not invent a player, line, side, or book. If a field is not visible, use null.",
    "Ignore parlay bonuses, promo banners, and non-prop chrome. If some legs are not CS2, still return the CS2 ones and mention the others in note."
  ].join(" ");
}


export function hasWorkersAi(env) {
  return !!(env && env.AI && typeof env.AI.run === "function");
}

export function workersAiText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result.trim();
  if (typeof result.response === "string") return result.response.trim();
  if (result.result && typeof result.result.response === "string") return result.result.response.trim();
  if (result.result && typeof result.result === "string") return result.result.trim();
  const choice = result.choices && result.choices[0] && result.choices[0].message;
  if (choice && typeof choice.content === "string") return choice.content.trim();
  if (Array.isArray(result.picks) || result.readable != null) return JSON.stringify(result);
  return "";
}

const SLIP_GUIDED_JSON = {
  type: "object",
  properties: {
    readable: { type: "boolean" },
    cs2: { type: "boolean" },
    book: { type: ["string", "null"] },
    entry: { type: ["number", "null"] },
    payout: { type: ["number", "null"] },
    note: { type: ["string", "null"] },
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          player: { type: "string" },
          team: { type: ["string", "null"] },
          opponent: { type: ["string", "null"] },
          stat: { type: "string" },
          line: { type: "number" },
          period: { type: ["string", "null"] },
          side: { type: ["string", "null"] },
          book: { type: ["string", "null"] }
        },
        required: ["player", "stat", "line"]
      }
    }
  },
  required: ["readable", "cs2", "picks"]
};

export async function workersAiExtract(env, opts) {
  opts = opts || {};
  const model = WORKERS_AI_MODEL;
  const provider = "workers-ai";
  if (!hasWorkersAi(env)) return { ok: false, provider, model, error: "Workers AI is not bound", text: "" };
  const mime = opts.mime || "image/jpeg";
  const b64 = opts.b64 || "";
  const dataUrl = "data:" + mime + ";base64," + b64;
  const timeoutMs = opts.timeoutMs || WORKERS_AI_TIMEOUT_MS;
  const input = {
    messages: [
      { role: "system", content: extractPrompt() },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract the CS2 slip in this image as JSON." },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ],
    max_tokens: 2048,
    temperature: 0,
    guided_json: SLIP_GUIDED_JSON
  };
  try {
    let timer;
    const result = await Promise.race([
      env.AI.run(model, input),
      new Promise(function (_, reject) {
        timer = setTimeout(function () { reject(new Error("timeout")); }, timeoutMs);
      })
    ]);
    if (timer) clearTimeout(timer);
    const text = workersAiText(result);
    return { ok: !!text, text, provider, model, error: text ? "" : "empty text" };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "Workers AI error";
    const aborted = /timeout/i.test(msg);
    return { ok: false, text: "", provider, model, error: aborted ? ("timeout after " + timeoutMs + "ms") : msg, aborted: aborted };
  }
}

export function formatSlipReadDetail(opts) {
  opts = opts || {};
  const bits = [];
  if (opts.source) {
    bits.push("provider=" + (opts.source.provider || ""));
    if (opts.source.model) bits.push("model=" + opts.source.model);
  }
  if (opts.workers && (!opts.source || opts.source.provider !== "workers-ai")) {
    bits.push("workers-ai=" + (opts.workers.parseError ? "unparseable" : (opts.workers.error || "failed")));
    if (opts.workers.model) bits.push("workersAiModel=" + opts.workers.model);
  }
  if (opts.gemini && (!opts.source || opts.source.provider !== "gemini")) {
    bits.push(formatGeminiDetail(Object.assign({ provider: "gemini" }, opts.gemini)));
  } else if (opts.gemini && opts.source && opts.source.provider === "gemini") {
    if (opts.gemini.tried && opts.gemini.tried.length) bits.push("tried=" + opts.gemini.tried.join(", "));
    if (opts.gemini.busy) bits.push("retried on busy");
  }
  if (opts.parseError) bits.push("parse error: model text was not JSON");
  if (opts.imageBytes != null) bits.push("image=" + opts.imageBytes + "B");
  if (opts.mime) bits.push("mime=" + opts.mime);
  return sanitizeDetail(bits.filter(Boolean).join(", ") || "unknown read failure", opts.secret);
}

function publicPick(p) {
  return {
    player: p.player || "",
    team: p.team || "",
    opponent: p.opponent || "",
    stat: p.stat || "",
    line: p.line,
    period: p.period || "Maps 1-2",
    side: p.side || "",
    book: p.book || "",
    matched: p.matched || null,
    boardNote: p.boardNote || null,
    error: p.error || null
  };
}

function publicResult(r) {
  return {
    pick: publicPick(r.pick || {}),
    grade: r.grade || null,
    verdict: r.verdict,
    like: !!r.like,
    flags: r.flags || [],
    error: r.error || null
  };
}

export async function handleSlip(request, env, url, keyHash) {
  const path = url.pathname;
  if (!isSlipPath(path) || request.method !== "POST") return json({ error: "Not found" }, 404);
  if (!sameOrigin(request, url)) return json({ error: "Bad request" }, 400);

  const who = await identify(request, env, keyHash);
  const gate = await gateState(env);
  if (gate === "on" && !who) return json({ error: "login required", login: "/login" }, 401);

  if (path === "/ai/slip/grade") {
    let store;
    try { store = await loadStore(env, url.origin); }
    catch (e) { return json({ error: "Glocky couldn't load our data just now. Try again in a moment." }, 503); }
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const rawPicks = Array.isArray(body && body.picks) ? body.picks : [];
    if (!rawPicks.length) return json({ error: "Add at least one pick to grade." }, 400);
    if (rawPicks.length > 20) return json({ error: "Please keep slips to 20 legs or fewer." }, 400);
    const results = gradePicks(store, rawPicks);
    const summary = summarizeSlip(results, { book: body && body.book, entry: body && body.entry, payout: body && body.payout });
    return json({ results: results.map(publicResult), summary, setup: true });
  }

  if (!hasWorkersAi(env) && !hasGeminiKey(env)) return json({ error: SETUP_MSG, setup: false }, 503);

  const rl = await rateLimit(env, whoKey(who, request));
  if (!rl.ok) return json({ error: rl.msg }, 429);

  const img = await readImage(request);
  if (img.error) return json({ error: img.error }, 400);

  const imageBytes = img.bytes ? img.bytes.length : 0;
  const b64 = bytesToB64(img.bytes);
  const mime = img.mime;
  // Drop the raw bytes before calling a model. loadStore is deferred until
  // after the image is also dropped, so we never hold a 5 MB upload and the
  // 8 MB players.json in the Worker's 128 MB isolate at the same time.
  img.bytes = null;

  let workers = null;
  let g = null;
  let parsed = null;
  let source = null;

  // Workers AI is the main slip reader. Gemini is the fallback only.
  if (hasWorkersAi(env)) {
    workers = await workersAiExtract(env, { mime, b64 });
    if (workers.ok) {
      parsed = parseGeminiJson(workers.text);
      if (parsed) source = workers;
      else workers.parseError = true;
    }
  }

  if (!parsed && hasGeminiKey(env)) {
    g = await geminiRequest(env, {
      system: extractPrompt(),
      parts: [
        { text: "Extract the CS2 slip in this image as JSON." },
        { inlineData: { mimeType: mime, data: b64 } }
      ],
      timeoutMs: 25000,
      temperature: 0,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
      thinkingBudget: 0,
      // Sportsbook slips can trip default image filters; this is the user's own
      // screenshot, and we only extract visible player-prop fields.
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    });
    if (g.ok) {
      parsed = parseGeminiJson(g.text);
      if (parsed) source = Object.assign({ provider: "gemini" }, g);
    }
  }

  function readDetail(extra) {
    return formatSlipReadDetail(Object.assign({
      source, workers, gemini: g, imageBytes, mime, secret: env.GEMINI_API_KEY
    }, extra || {}));
  }
  function withAdminDetail(payload, extra) {
    if (who && who.admin) payload.detail = readDetail(extra);
    return payload;
  }

  if (!parsed) {
    const parseFail = (workers && workers.parseError) || (g && g.ok && !parseGeminiJson(g.text));
    const busy = !!(g && g.busy);
    const payload = {
      error: parseFail
        ? "We couldn't read that image. Try a clearer screenshot of a CS2 slip."
        : (busy
          ? "Glocky is a bit busy right now and couldn't read that slip. Try again in a moment."
          : "Glocky couldn't read that slip just now. Try again in a moment.")
    };
    return json(withAdminDetail(payload, { parseError: parseFail }), parseFail ? 422 : 502);
  }

  const extracted = parseExtracted(parsed);
  if (!extracted.readable) {
    return json(withAdminDetail({
      readable: false,
      cs2: extracted.cs2,
      error: "We couldn't read that image. Try a clearer screenshot of a CS2 slip.",
      note: extracted.note || "",
      picks: []
    }), 422);
  }
  if (!extracted.cs2 && !extracted.picks.some((p) => p.stat)) {
    return json(withAdminDetail({
      readable: true,
      cs2: false,
      error: "That slip doesn't look like CS2 props. We only grade CS2 kills and headshots.",
      note: extracted.note || "",
      picks: []
    }), 422);
  }

  let store;
  try { store = await loadStore(env, url.origin); }
  catch (e) { return json({ error: "Glocky couldn't load our data just now. Try again in a moment." }, 503); }

  const picks = extracted.picks.map((p) => matchPick(store, p));
  if (!picks.length) {
    return json(withAdminDetail({
      readable: true,
      cs2: extracted.cs2,
      error: "We couldn't find any CS2 kills or headshots picks on that slip.",
      note: extracted.note || "",
      picks: []
    }), 422);
  }

  return json(withAdminDetail({
    readable: true,
    cs2: extracted.cs2,
    book: extracted.book || "",
    entry: extracted.entry,
    payout: extracted.payout,
    note: extracted.note || "",
    picks: picks.map(publicPick),
    setup: true,
    left: rl.left
  }));
}

export const _test = {
  hasGeminiKey, geminiModel, USER_DAILY, COOLDOWN_MS, MAX_BYTES, SETUP_MSG,
  sniffMime, b64ToBytes, whoKey, utcDay, lastHit,
  hasWorkersAi, workersAiText, workersAiExtract, WORKERS_AI_MODEL, formatSlipReadDetail
};
