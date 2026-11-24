// Slip reader API: signed-in users only when the beta gate is on. Gemini (vision) only
// extracts picks from the uploaded image. All grades come from our grader. The API key
// is a Worker secret and must never be logged, returned, or shown. Images are not stored.
import { identify, gateState } from "./beta_auth.js";
import { hasGeminiKey, geminiModel, geminiRequest, loadStore, formatGeminiDetail, sanitizeDetail } from "./ask_ai.js";
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
  if (!hasGeminiKey(env)) return json({ error: SETUP_MSG, setup: false }, 503);

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

  const rl = await rateLimit(env, whoKey(who, request));
  if (!rl.ok) return json({ error: rl.msg }, 429);

  const img = await readImage(request);
  if (img.error) return json({ error: img.error }, 400);

  const imageBytes = img.bytes ? img.bytes.length : 0;
  const b64 = bytesToB64(img.bytes);
  const mime = img.mime;
  // Drop the raw bytes before calling Gemini. loadStore is deferred until
  // after the image is also dropped, so we never hold a 5 MB upload and the
  // 8 MB players.json in the Worker's 128 MB isolate at the same time.
  img.bytes = null;
  const g = await geminiRequest(env, {
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

  if (!g.ok) {
    const payload = { error: "Glocky couldn't read that slip just now. Try again in a moment." };
    if (who && who.admin) payload.detail = sanitizeDetail(formatGeminiDetail(Object.assign({ imageBytes: imageBytes, mime: mime }, g)), env.GEMINI_API_KEY);
    return json(payload, 502);
  }
  const parsed = parseGeminiJson(g.text);
  if (!parsed) {
    const payload = { error: "We couldn't read that image. Try a clearer screenshot of a CS2 slip." };
    if (who && who.admin) {
      const snippet = g.text ? String(g.text).slice(0, 80) : "";
      payload.detail = sanitizeDetail("parse error: model text was not JSON" + (snippet ? " (" + snippet + ")" : ""), env.GEMINI_API_KEY);
    }
    return json(payload, 422);
  }

  const extracted = parseExtracted(parsed);
  if (!extracted.readable) {
    return json({
      readable: false,
      cs2: extracted.cs2,
      error: "We couldn't read that image. Try a clearer screenshot of a CS2 slip.",
      note: extracted.note || "",
      picks: []
    }, 422);
  }
  if (!extracted.cs2 && !extracted.picks.some((p) => p.stat)) {
    return json({
      readable: true,
      cs2: false,
      error: "That slip doesn't look like CS2 props. We only grade CS2 kills and headshots.",
      note: extracted.note || "",
      picks: []
    }, 422);
  }

  let store;
  try { store = await loadStore(env, url.origin); }
  catch (e) { return json({ error: "Glocky couldn't load our data just now. Try again in a moment." }, 503); }

  const picks = extracted.picks.map((p) => matchPick(store, p));
  if (!picks.length) {
    return json({
      readable: true,
      cs2: extracted.cs2,
      error: "We couldn't find any CS2 kills or headshots picks on that slip.",
      note: extracted.note || "",
      picks: []
    }, 422);
  }

  return json({
    readable: true,
    cs2: extracted.cs2,
    book: extracted.book || "",
    entry: extracted.entry,
    payout: extracted.payout,
    note: extracted.note || "",
    picks: picks.map(publicPick),
    setup: true,
    left: rl.left
  });
}

export const _test = {
  hasGeminiKey, geminiModel, USER_DAILY, COOLDOWN_MS, MAX_BYTES, SETUP_MSG,
  sniffMime, b64ToBytes, whoKey, utcDay, lastHit
};
