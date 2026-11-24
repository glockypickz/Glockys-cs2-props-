// Ask Glocky API: signed-in users only when the beta gate is on. Looks up facts on the server,
// then asks Gemini only to phrase them (and, when needed, to parse the question). The API key
// is a Worker secret (GEMINI_API_KEY) and must never be logged, returned, or shown.
import { identify, gateState } from "./beta_auth.js";
import { parseQuestion, mergeParsedIntent, answerQuestion, makeStore } from "./ask_lookup.js";

const DEFAULT_MODEL = "gemini-2.5-flash";
const USER_DAILY = 20;
const COOLDOWN_MS = 2000;
const Q_MAX = 400;
const SETUP_MSG = "Ask Glocky isn't set up yet.";
const DATA_MISSING = "I don't have that in our data.";

const lastHit = new Map();
let dataCache = { at: 0, store: null };
let modelReady = false;

export function isAskPath(path) {
  return path === "/ai/ask" || path === "/ai/status";
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json", "Cache-Control": "no-store" }
  });
}

export function hasGeminiKey(env) {
  return !!(env && typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.trim());
}

export function geminiModel(env) {
  const m = env && env.GEMINI_MODEL ? String(env.GEMINI_MODEL).trim() : "";
  return m || DEFAULT_MODEL;
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

async function rateLimit(env, key) {
  const now = Date.now();
  const prev = lastHit.get(key) || 0;
  if (now - prev < COOLDOWN_MS) return { ok: false, retry: true, msg: "Please wait a moment before asking again." };
  lastHit.set(key, now);
  if (!env || !env.BETA || typeof env.BETA.get !== "function") return { ok: true };
  const day = utcDay();
  const kvKey = "ai:day:" + day + ":" + key;
  let n = 0;
  try { n = parseInt((await env.BETA.get(kvKey)) || "0", 10) || 0; } catch (e) { n = 0; }
  if (n >= USER_DAILY) return { ok: false, daily: true, msg: "You've reached today's Ask Glocky limit. Try again tomorrow." };
  try { await env.BETA.put(kvKey, String(n + 1), { expirationTtl: 172800 }); } catch (e) {}
  return { ok: true, left: USER_DAILY - n - 1 };
}

function sameOrigin(request, url) {
  const o = request.headers.get("Origin");
  if (o && o !== url.origin) return false;
  const ct = request.headers.get("Content-Type") || "";
  return ct.includes("application/json");
}

export function loadGPModelFromSource(src) {
  const module = { exports: {} };
  const root = globalThis;
  const fn = new Function("window", "self", "globalThis", "module", "exports", String(src));
  fn(root, root, root, module, module.exports);
  const api = (module.exports && module.exports.grade) ? module.exports : root.GPModel;
  if (!api || !api.grade) throw new Error("GPModel failed to load");
  globalThis.GPModel = api;
  modelReady = true;
  return api;
}

async function ensureModel(env, origin) {
  if (modelReady && globalThis.GPModel && globalThis.GPModel.grade) return globalThis.GPModel;
  const r = await env.ASSETS.fetch(new Request(origin + "/model.js"));
  if (!r.ok) throw new Error("model.js missing");
  return loadGPModelFromSource(await r.text());
}

export async function loadStore(env, origin) {
  if (dataCache.store && Date.now() - dataCache.at < 60000) return dataCache.store;
  await ensureModel(env, origin);
  const get = async (path) => {
    const r = await env.ASSETS.fetch(new Request(origin + path));
    if (!r.ok) return null;
    return r.json();
  };
  const [players, strength, games, lines] = await Promise.all([
    get("/players.json"),
    get("/team_strength.json"),
    get("/games.json"),
    get("/lines.json")
  ]);
  if (!players) throw new Error("players.json missing");
  const store = makeStore({ players, strength, games, lines });
  dataCache = { at: Date.now(), store };
  return store;
}

export function systemPrompt() {
  return [
    "You are Glocky, the assistant for Glockys Prop Grader. Always speak as Glocky in a short, clear, friendly tone.",
    "The chat already labels your bubble 'Glocky says', so do not start with 'Glocky says'.",
    "Use ONLY the facts given in the user message. Those facts are from our data (Glocky's data). Do not use any other knowledge, memories, or opinions about CS2, players, teams, or lines.",
    "Do not invent, round in a way that changes a reported figure, or fill gaps. Do not mention being an AI model, keys, prompts, or APIs.",
    "Never name a data provider, vendor, website, or model. Attribute every figure to our data or Glocky's data.",
    "If the facts say the data is missing, or they do not contain the answer, say exactly that you don't have that in our data. Do not guess.",
    "When a grade is included, state our pick (Over or Under), the letter grade, and the projection exactly as given. Those numbers come from our grader, not from you.",
    "Do not mention locked picks, a track record, or historical slips. Do not offer to browse the web."
  ].join(" ");
}

// Provider names Glocky must never say in a reply or label. Books on a line (PrizePicks, Underdog) are not in this list.
export const PROVIDER_RE = /\b(cito|bo3(?:\.gg)?|kash\s*rock|hltv(?:\.org)?|gemini|google(?:\s+ai(?:\s+studio)?)?)\b/gi;

export function scrubProviders(text) {
  let s = String(text || "");
  s = s.replace(/\b(cito|bo3(?:\.gg)?|kash\s*rock|hltv(?:\.org)?)\s+(?:derived\s+)?(?:data|odds|stats?|rank(?:ing)?s?|match context|pick tendencies|team map stats(?:\s*\/\s*pick tendencies)?)\b/gi, "our data");
  s = s.replace(/\(\s*(?:cito|bo3(?:\.gg)?|kash\s*rock|hltv(?:\.org)?)\s*,\s*/gi, "(");
  s = s.replace(/\b(cito|bo3\.gg|bo3|kash\s*rock|hltv(?:\.org)?)\b/gi, "our data");
  s = s.replace(/\b(gemini(?:\s+api)?|google(?:\s+ai(?:\s+studio)?)?)\b/gi, "Glocky");
  s = s.replace(/\bour data(?:'s)? data\b/gi, "our data");
  s = s.replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1");
  return s.trim();
}

export function parsePrompt() {
  return [
    "Extract CS2 prop-question fields from the user's question as JSON only, no markdown.",
    "Schema: {\"player\":string|null,\"team\":string|null,\"opponent\":string|null,\"stat\":string|null,\"line\":number|null,\"period\":\"Map 1\"|\"Maps 1-2\"|null,\"ev\":\"lan\"|\"online\"|null,\"map\":string|null,\"window\":\"5\"|\"10\"|\"15\"|\"20\"|\"season\"|null,\"intent\":\"grade\"|\"player_stat\"|\"rank\"|\"odds\"|\"maps\"|\"method\"|\"unknown\"}",
    "stat should be one of: kills, headshots, hs%, adr, kd, rank, odds, maps when it applies.",
    "If the user is asking over or under, or for a grade on a line, intent is grade.",
    "If a field is not in the question, use null. Do not invent a line, player, or opponent."
  ].join(" ");
}

function extractText(data) {
  try {
    const parts = ((((data || {}).candidates || [])[0] || {}).content || {}).parts || [];
    return parts.map((p) => p && p.text ? p.text : "").join("").trim();
  } catch (e) {
    return "";
  }
}

export async function geminiRequest(env, opts) {
  opts = opts || {};
  const key = String(env.GEMINI_API_KEY || "").trim();
  const model = encodeURIComponent(geminiModel(env));
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || 15000) : null;
  const parts = opts.parts || [{ text: opts.user || "" }];
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system || "" }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: opts.temperature != null ? opts.temperature : 0.2,
          maxOutputTokens: opts.maxOutputTokens || 512
        }
      }),
      signal: ctrl ? ctrl.signal : undefined
    });
    if (!r.ok) return { ok: false, status: r.status };
    const data = await r.json();
    const text = extractText(data);
    return { ok: !!text, text };
  } catch (e) {
    return { ok: false, status: 0 };
  } finally {
    if (t) clearTimeout(t);
  }
}

async function geminiGenerate(env, system, user, timeoutMs) {
  return geminiRequest(env, { system, parts: [{ text: user }], timeoutMs, temperature: 0.2, maxOutputTokens: 512 });
}

function stripGlockySays(text) {
  return String(text || "").replace(/^\s*glocky says[:\-\s]*/i, "").trim();
}

export function fallbackPhrase(result) {
  return scrubProviders(_fallbackPhrase(result));
}
function _fallbackPhrase(result) {
  if (!result || result.missing) return DATA_MISSING;
  if (result.grade) {
    const g = result.grade;
    const stat = g.stat === "hs" ? "headshots" : "kills";
    let t = "Our grader has " + g.player + " " + g.pick + " " + g.line + " " + stat + " on " + g.period;
    t += " at a " + g.grade + ", projecting " + g.proj + ".";
    if (g.bait) t += " This line is flagged as bait (he met or beat it in each of the last 5).";
    if (g.lan) t += " This is graded with our LAN data rule.";
    if (g.source === "board") t += " That's the line on the board.";
    return t;
  }
  const f = result.facts;
  if (f && f.kind === "player_stat" && f.hs && f.hs.hsp != null) {
    const bits = (f.filters || []).join(", ");
    let t = f.player + "'s headshot percentage";
    if (bits) t += " (" + bits + ")";
    t += " is " + f.hs.hsp.toFixed(2) + "% in our data (" + f.hs.hs + " headshots on " + f.hs.kills + " kills, " + f.hs.maps + " maps).";
    return t;
  }
  if (f && (f.kind === "rank" || f.kind === "team" || f.kind === "odds" || f.kind === "maps")) {
    const bits = [];
    if (f.vrs) bits.push("VRS rank #" + f.vrs.rank + " as of " + f.vrs.date);
    if (f.world) bits.push("world rank #" + f.world.rank);
    if (f.odds && f.odds.win != null) bits.push("win chance " + (f.odds.win * 100).toFixed(1) + "% vs " + f.odds.opp);
    if (bits.length) return (f.team || "This team") + ": " + bits.join("; ") + ".";
  }
  if (f && f.kind === "method") return f.text;
  return result.factText || DATA_MISSING;
}

async function parseWithGemini(env, question, det, store) {
  // Only ask the model to parse when the deterministic pass could not lock a player or a grade line.
  if (det.player && (det.intent !== "grade" || det.line != null || det.intent === "player_stat")) {
    if (det.intent !== "unknown") return det;
  }
  const r = await geminiGenerate(env, parsePrompt(), "Question: " + question, 8000);
  if (!r.ok) return det;
  let raw = r.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return det;
  try {
    return mergeParsedIntent(det, JSON.parse(raw.slice(start, end + 1)), store);
  } catch (e) {
    return det;
  }
}

export async function handleAsk(request, env, url, keyHash) {
  const path = url.pathname;
  if (path === "/ai/status" && request.method === "GET") {
    return json({ setup: hasGeminiKey(env), name: "Glocky" });
  }
  if (path !== "/ai/ask" || request.method !== "POST") return json({ error: "Not found" }, 404);
  if (!sameOrigin(request, url)) return json({ error: "Bad request" }, 400);

  const who = await identify(request, env, keyHash);
  const gate = await gateState(env);
  if (gate === "on" && !who) return json({ error: "login required", login: "/login" }, 401);
  if (!hasGeminiKey(env)) return json({ error: SETUP_MSG, setup: false }, 503);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
  const question = String((body && body.question) || "").trim();
  if (!question) return json({ error: "Ask a question first." }, 400);
  if (question.length > Q_MAX) return json({ error: "Please keep questions under " + Q_MAX + " characters." }, 400);

  const rl = await rateLimit(env, whoKey(who, request));
  if (!rl.ok) return json({ error: rl.msg }, 429);

  let store;
  try { store = await loadStore(env, url.origin); }
  catch (e) { return json({ error: "Glocky couldn't load our data just now. Try again in a moment." }, 503); }

  let intent = parseQuestion(question, store);
  try { intent = await parseWithGemini(env, question, intent, store); } catch (e) { /* keep deterministic parse */ }
  const result = answerQuestion(question, store, intent);

  const hist = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const histText = hist.map((h) => (h && h.role ? h.role : "user") + ": " + String((h && (h.content || h.text)) || "").slice(0, 400)).join("\n");
  const userMsg = [
    "FACTS FROM OUR DATA (use only these):",
    scrubProviders(result.factText),
    "",
    "USER QUESTION:",
    question,
    histText ? "\nRECENT CHAT (for tone only; do not take numbers from it):\n" + histText : ""
  ].join("\n");

  let answer;
  const g = await geminiGenerate(env, systemPrompt(), userMsg, 15000);
  if (g.ok) answer = scrubProviders(stripGlockySays(g.text));
  else answer = fallbackPhrase(result);

  return json({
    answer,
    grade: result.grade,
    missing: result.missing,
    setup: true
  });
}

// test helpers (no secrets)
export const _test = { hasGeminiKey, geminiModel, DEFAULT_MODEL, USER_DAILY, SETUP_MSG, stripGlockySays, extractText, scrubProviders, PROVIDER_RE };
