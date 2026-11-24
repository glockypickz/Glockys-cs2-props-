// Slip reader Worker handler tests (no live Gemini calls; fetch is stubbed).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as A from "../beta_auth.js";
import { handleSlip, isSlipPath, extractPrompt, _test as T } from "../slip_ai.js";
import { handleAsk, isAskPath, setRetryDelaysForTest, _test as AT } from "../ask_ai.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
globalThis.GPModel = require(join(root, "model.js"));

const KEY = "test-admin-key-not-real";
const KEY_HASH = await A.sha256hex(KEY);
const SECRET = "x".repeat(40);
const ORIGIN = "https://site.test";

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, t) { const v = this.m.has(k) ? this.m.get(k) : null; return v != null && t === "json" ? JSON.parse(v) : v; }
  async put(k, v, _o) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix }) { return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; }
}
class FakeAssets {
  async fetch(req) {
    const path = new URL(typeof req === "string" ? req : req.url).pathname;
    const allowed = new Set(["/model.js", "/players.json", "/team_strength.json", "/games.json", "/lines.json"]);
    if (!allowed.has(path)) return new Response("no", { status: 404 });
    const file = join(root, path.slice(1));
    if (!existsSync(file)) return new Response("no", { status: 404 });
    const body = readFileSync(file);
    const type = path.endsWith(".js") ? "text/javascript" : "application/json";
    return new Response(body, { headers: { "content-type": type } });
  }
}
function mkEnv(extra) {
  A._resetGateCache();
  T.lastHit.clear();
  return Object.assign({ BETA: new FakeKV(), SESSION_SECRET: SECRET, PBKDF2_ITERATIONS: "10000", ASSETS: new FakeAssets() }, extra || {});
}
function req(path, { method = "POST", body, cookie, ip = "1.1.1.1", contentType, adminKey } = {}) {
  const h = { "CF-Connecting-IP": ip, Origin: ORIGIN };
  if (body !== undefined) h["Content-Type"] = contentType || "application/json";
  if (cookie) h.Cookie = cookie;
  if (adminKey) h["X-Admin-Key"] = adminKey;
  return new Request(ORIGIN + path, { method, headers: h, body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
}

// 1x1 PNG
const PNG = Uint8Array.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
  0x89,0x00,0x00,0x00,0x0a,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0x00,0x01,0x00,0x00,
  0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,
  0x42,0x60,0x82
]);
function pngB64() {
  return Buffer.from(PNG).toString("base64");
}

test("slip paths and setup message never mention keys or vendors", () => {
  assert.equal(isSlipPath("/ai/slip/read"), true);
  assert.equal(isSlipPath("/ai/slip/grade"), true);
  assert.equal(isSlipPath("/ai/ask"), false);
  assert.equal(isAskPath("/ai/slip/read"), false);
  assert.equal(T.SETUP_MSG, "Slip reader isn't set up yet.");
  assert.doesNotMatch(T.SETUP_MSG, /api|key|secret|gemini|token|google/i);
  assert.doesNotMatch(extractPrompt(), /GEMINI_API_KEY|api key/i);
  assert.equal(T.USER_DAILY, 10);
  assert.equal(T.MAX_BYTES, 5 * 1024 * 1024);
});

test("sniffMime accepts png/jpeg/webp and rejects other bytes", () => {
  assert.equal(T.sniffMime(PNG, ""), "image/png");
  const jpeg = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(T.sniffMime(jpeg, ""), "image/jpeg");
  // Resize outputs JPEG bytes; trust the sniffed bytes, not a stale HEIC hint.
  assert.equal(T.sniffMime(jpeg, "image/heic"), "image/jpeg");
  const webp = new Uint8Array(12);
  webp.set([0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x45,0x42,0x50]);
  assert.equal(T.sniffMime(webp, ""), "image/webp");
  assert.equal(T.sniffMime(Uint8Array.from([0,1,2,3,4,5,6,7,8,9,10,11]), "image/gif"), null);
});

test("b64ToBytes strips a data URL prefix and matches raw base64", () => {
  const raw = pngB64();
  const dataUrl = "data:image/png;base64," + raw;
  const a = T.b64ToBytes(dataUrl);
  const b = T.b64ToBytes(raw);
  assert.ok(a && b && a.length === b.length && a.length === PNG.length);
  assert.deepEqual(Array.from(a), Array.from(PNG));
  assert.deepEqual(Array.from(a), Array.from(b));
});

test("POST without the Worker secret returns the friendly setup message", async () => {
  const env = mkEnv();
  const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" } }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
  const j = await r.json();
  assert.equal(r.status, 503);
  assert.equal(j.error, "Slip reader isn't set up yet.");
  assert.equal(JSON.stringify(j).includes("GEMINI"), false);
  assert.doesNotMatch(JSON.stringify(j), /api key|secret/i);
});

test("gate on: signed-out users cannot read a slip", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  await env.BETA.put("cfg:gate", "on");
  A._resetGateCache();
  const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" } }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
  const j = await r.json();
  assert.equal(r.status, 401);
  assert.equal(j.login, "/login");
});

test("vision request uses the header for the secret and only extracts, then our grader grades", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: opts && opts.headers, body: opts && opts.body });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        readable: true, cs2: true, book: "PrizePicks", entry: 20, payout: 60,
        picks: [
          { player: "EL1GE", stat: "kills", line: 35.5, period: "Maps 1-2", side: "over", book: "PrizePicks" },
          { player: "ZzNobody", stat: "kills", line: 20.5, period: "Maps 1-2", side: "under" }
        ]
      }) }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" } }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.picks.length, 2);
    assert.equal(j.picks[0].matched && j.picks[0].matched.name, "EliGE");
    assert.ok(j.picks[1].error);
    assert.equal(JSON.stringify(j).includes("not-a-real-key"), false);
    assert.ok(seen.length >= 1);
    for (const s of seen) {
      assert.equal(s.url.includes("not-a-real-key"), false);
      assert.doesNotMatch(s.url, /key=/i);
    }
    const body = JSON.parse(seen[0].body);
    assert.ok(body.contents[0].parts.some((p) => p.inlineData && p.inlineData.mimeType === "image/png"));
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "low");
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, undefined);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.match(seen[0].url, /models\/gemini-3\.8-flash:generateContent/);
    assert.ok(body.generationConfig.maxOutputTokens >= 2048);
  } finally {
    globalThis.fetch = orig;
  }

  const g = await handleSlip(req("/ai/slip/grade", { body: { picks: [
    { player: "EliGE", stat: "kills", line: 35.5, period: "Maps 1-2", side: "over", opponent: "FaZe", book: "PrizePicks" }
  ] } }), env, new URL(ORIGIN + "/ai/slip/grade"), KEY_HASH);
  const gj = await g.json();
  assert.equal(g.status, 200);
  assert.equal(gj.results.length, 1);
  assert.ok(gj.results[0].grade);
  assert.equal(gj.results[0].grade.model, globalThis.GPModel.VERSION);
  assert.ok(gj.results[0].verdict === "agree" || gj.results[0].verdict === "disagree");
  assert.equal(gj.summary.total, 1);
  assert.equal(JSON.stringify(gj).includes("not-a-real-key"), false);
});

test("unreadable and non-CS2 slips return a clear error", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ readable: false, cs2: false, picks: [] }) }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" } }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 422);
    assert.match(j.error, /couldn'?t read that image/i);
  } finally {
    globalThis.fetch = orig;
  }

  T.lastHit.clear();
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ readable: true, cs2: false, picks: [{ player: "Mahomes", stat: "passing yards", line: 275.5, side: "over" }] }) }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, ip: "2.2.2.2" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 422);
    assert.match(j.error, /doesn't look like CS2/i);
  } finally {
    globalThis.fetch = orig;
  }
});

test("daily slip cap returns a friendly 429 and does not call the model", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const day = new Date().toISOString().slice(0, 10);
  await env.BETA.put("slip:day:" + day + ":ip:9.9.9.9", String(T.USER_DAILY));
  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return new Response("{}", { status: 500 }); };
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, ip: "9.9.9.9" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 429);
    assert.match(j.error, /today's slip limit/i);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("rejected file types and oversize payloads never mention vendors", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const r = await handleSlip(req("/ai/slip/read", { body: { image: Buffer.from("GIF89a").toString("base64"), mime: "image/gif" } }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
  const j = await r.json();
  assert.equal(r.status, 400);
  assert.match(j.error, /PNG, JPG, or WebP/i);
  assert.doesNotMatch(JSON.stringify(j), /gemini|api key|google/i);
});

test("UI source has Upload slip on the Grader path and never mentions keys", () => {
  const wrangler = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"ai"\s*:\s*\{\s*"binding"\s*:\s*"AI"/);
  assert.equal(T.WORKERS_AI_MODEL, "@cf/meta/llama-4-scout-17b-16e-instruct");
  const app = readFileSync(join(root, "app.js"), "utf8");
  const css = readFileSync(join(root, "styles.css"), "utf8");
  assert.match(app, /Upload slip/);
  assert.match(app, /Upload image/);
  assert.match(app, /function prepareSlipImage/);
  assert.match(app, /var max=1600/);
  assert.match(app, /toDataURL/);
  assert.match(app, /function slipReadFile[\s\S]*prepareSlipImage\(file/);
  assert.match(app, /function chatSlipFile[\s\S]*prepareSlipImage\(file/);
  assert.match(app, /function slipErrText/);
  assert.match(app, /function slipReadFile[\s\S]*slipErrText\(/);
  assert.match(app, /function chatSlipFile[\s\S]*slipErrText\(/);
  assert.match(app, /d\.detail/);
  assert.doesNotMatch(app, /Choose file|No file chosen/i);
  assert.match(app, /slipReaderHtml/);
  assert.match(app, /viewGrader[\s\S]*slipReaderHtml\(\)/);
  assert.match(app, /aislip/);
  assert.match(app, /class="slip-file"/);
  assert.match(css, /\.slip-file/);
  assert.doesNotMatch(app, /GP_AI_URL|GEMINI_API_KEY|api key/i);
  assert.doesNotMatch(app, /Ask AI/);
  assert.match(css, /slip-reader/);
  const worker = readFileSync(join(root, "worker.js"), "utf8");
  assert.match(worker, /isSlipPath/);
});

test("slip read drops the image and only then loads our data; assets are not fetched via the public origin", () => {
  const slip = readFileSync(join(root, "slip_ai.js"), "utf8");
  const ask = readFileSync(join(root, "ask_ai.js"), "utf8");
  const readAt = slip.indexOf("const img = await readImage(request)");
  const dropAt = slip.indexOf("img.bytes = null");
  const dropB64At = slip.lastIndexOf('b64 = ""');
  const loadAt = slip.lastIndexOf("store = await loadStore(env, url.origin)");
  assert.ok(readAt >= 0 && dropAt > readAt, "image is dropped after it is read");
  assert.ok(dropB64At > dropAt, "base64 vision payload is cleared after the raw bytes");
  assert.ok(loadAt > dropB64At, "loadStore on the read path runs after the vision payload is dropped");
  assert.doesNotMatch(slip, /image:\s*Array\.from|Array\.from\(\s*(?:img\.)?bytes/);
  const gradeFn = slip.indexOf('if (path === "/ai/slip/grade")');
  const gradeLoad = slip.indexOf("store = await loadStore(env, url.origin)", gradeFn);
  assert.ok(gradeFn >= 0 && gradeLoad > gradeFn && gradeLoad < readAt, "grade path still loads data without an image");
  assert.match(ask, /https:\/\/assets\.local/);
  assert.doesNotMatch(ask, /ASSETS\.fetch\(new Request\(origin \+/);
});

test("customers get the friendly 502; admins also get the real Gemini reason, never the key", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 400, message: "Request contains an invalid argument. key=not-a-real-key", status: "INVALID_ARGUMENT" }
  }), { status: 400, headers: { "content-type": "application/json" } });
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" } }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 502);
    assert.match(j.error, /couldn'?t read that slip just now/i);
    assert.equal(j.detail, undefined);
    assert.equal(JSON.stringify(j).includes("not-a-real-key"), false);
  } finally {
    globalThis.fetch = orig;
  }

  T.lastHit.clear();
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 400, message: "Request contains an invalid argument. key=not-a-real-key", status: "INVALID_ARGUMENT" }
  }), { status: 400, headers: { "content-type": "application/json" } });
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, adminKey: KEY, ip: "3.3.3.3" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 502);
    assert.match(j.error, /couldn'?t read that slip just now/i);
    assert.match(j.detail, /HTTP 400/);
    assert.match(j.detail, /INVALID_ARGUMENT/);
    assert.match(j.detail, /image=\d+B/);
    assert.match(j.detail, /mime=image\/png/);
    assert.equal(String(j.detail).includes("not-a-real-key"), false);
    assert.doesNotMatch(j.detail, /AIza/);
    assert.equal(JSON.stringify(j).includes("not-a-real-key"), false);
  } finally {
    globalThis.fetch = orig;
  }
});

test("admin 502 includes finishReason and blockReason when the model returns empty text", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ thought: true, text: "thinking..." }] } }],
    promptFeedback: { blockReason: "SAFETY" },
    usageMetadata: { thoughtsTokenCount: 2048, candidatesTokenCount: 0 }
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, adminKey: KEY }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 502);
    assert.match(j.error, /couldn'?t read that slip just now/i);
    assert.match(j.detail, /finishReason=MAX_TOKENS/);
    assert.match(j.detail, /blockReason=SAFETY/);
    assert.match(j.detail, /thoughtTokens=2048/);
    assert.match(j.detail, /empty text/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("admin 422 includes a parse error when the model text is not JSON", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "sorry, I cannot help with that" }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, adminKey: KEY }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 422);
    assert.match(j.error, /couldn'?t read that image/i);
    assert.match(j.detail, /parse error/i);
    assert.doesNotMatch(j.detail, /not-a-real-key/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("a 400 from thinking or json-mime is retried once without those options", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  const seen = [];
  let n = 0;
  globalThis.fetch = async (url, opts) => {
    seen.push(JSON.parse(opts.body));
    n++;
    if (n === 1) {
      return new Response(JSON.stringify({
        error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" }
      }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        readable: true, cs2: true, book: "PrizePicks", picks: [
          { player: "EliGE", stat: "kills", line: 35.5, period: "Maps 1-2", side: "over" }
        ]
      }) }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" } }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.picks.length, 1);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].generationConfig.thinkingConfig.thinkingLevel, "low");
    assert.equal(seen[0].generationConfig.thinkingConfig.thinkingBudget, undefined);
    assert.equal(seen[0].generationConfig.responseMimeType, "application/json");
    assert.equal(seen[1].generationConfig.thinkingConfig, undefined);
    assert.equal(seen[1].generationConfig.responseMimeType, undefined);
    assert.ok((seen[0].safetySettings || []).length >= 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test("404 NOT_FOUND on a retired model id is retried on gemini-3.8-flash", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key", GEMINI_MODEL: "models-not-real" });
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), body: JSON.parse(opts.body) });
    if (String(url).includes("models-not-real")) {
      return new Response(JSON.stringify({
        error: { code: 404, message: "This model models/models-not-real is no longer available to new users. Please update your code to use models/gemini-3.8-flash.", status: "NOT_FOUND" }
      }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        readable: true, cs2: true, book: "PrizePicks", picks: [
          { player: "EliGE", stat: "kills", line: 35.5, period: "Maps 1-2", side: "over" }
        ]
      }) }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, adminKey: KEY }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.picks.length, 1);
    assert.ok(seen[0].url.includes("models-not-real"));
    assert.match(seen[1].url, /models\/gemini-3\.8-flash:generateContent/);
    assert.equal(seen[1].body.generationConfig.thinkingConfig.thinkingLevel, "low");
    assert.ok(seen.every((s) => !s.url.includes("not-a-real-key")));
  } finally {
    globalThis.fetch = orig;
  }
});

function busy503() {
  return new Response(JSON.stringify({
    error: { code: 503, message: "This model is currently experiencing high demand. Please try again later.", status: "UNAVAILABLE" }
  }), { status: 503, headers: { "content-type": "application/json" } });
}

function slipOk() {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      readable: true, cs2: true, book: "PrizePicks", picks: [
        { player: "EliGE", stat: "kills", line: 35.5, period: "Maps 1-2", side: "over" }
      ]
    }) }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("503 UNAVAILABLE retries the same model twice, then falls back to gemini-3.5-flash-lite", async () => {
  setRetryDelaysForTest([0, 0]);
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(String(url));
    if (String(url).includes("gemini-3.8-flash")) return busy503();
    if (String(url).includes("gemini-3.5-flash-lite")) return slipOk();
    return busy503();
  };
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, ip: "4.4.4.4" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.picks.length, 1);
    const flash = seen.filter((u) => u.includes("gemini-3.8-flash"));
    assert.equal(flash.length, 3, "initial attempt plus two busy retries");
    assert.ok(seen.some((u) => u.includes("gemini-3.5-flash-lite")));
    assert.ok(seen.every((u) => !u.includes("not-a-real-key")));
    assert.equal(AT.thinkingConfigFor("gemini-3.5-flash-lite").thinkingLevel, "minimal");
    assert.equal(AT.thinkingConfigFor("gemini-3.6-flash").thinkingLevel, "minimal");
  } finally {
    globalThis.fetch = orig;
    setRetryDelaysForTest(null);
  }
});

test("when every model stays busy, customers get a busy message and admins see the models tried", async () => {
  setRetryDelaysForTest([0, 0]);
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => busy503();
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, ip: "4.4.4.5" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 502);
    assert.match(j.error, /a bit busy/i);
    assert.equal(j.detail, undefined);
    assert.equal(JSON.stringify(j).includes("not-a-real-key"), false);
  } finally {
    globalThis.fetch = orig;
  }

  T.lastHit.clear();
  globalThis.fetch = async () => busy503();
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, adminKey: KEY, ip: "4.4.4.6" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 502);
    assert.match(j.error, /a bit busy/i);
    assert.match(j.detail, /HTTP 503/);
    assert.match(j.detail, /UNAVAILABLE/);
    assert.match(j.detail, /tried=gemini-3\.8-flash, gemini-3\.5-flash-lite, gemini-3\.6-flash/);
    assert.match(j.detail, /retried on busy/);
    assert.equal(String(j.detail).includes("not-a-real-key"), false);
  } finally {
    globalThis.fetch = orig;
    setRetryDelaysForTest(null);
  }
});

function slipJsonText() {
  return JSON.stringify({
    readable: true, cs2: true, book: "PrizePicks", picks: [
      { player: "EliGE", stat: "kills", line: 35.5, period: "Maps 1-2", side: "over" }
    ]
  });
}

test("Workers AI is the main slip reader and does not call Gemini when it returns JSON", async () => {
  let geminiCalled = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { geminiCalled++; return new Response("no", { status: 500 }); };
  const env = mkEnv({
    AI: { run: async (model, input) => {
      assert.equal(model, T.WORKERS_AI_MODEL);
      assert.ok(input.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url" && /^data:image\//.test(c.image_url.url))));
      return { response: slipJsonText() };
    } }
  });
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, ip: "10.1.1.1" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.picks.length, 1);
    assert.equal(j.picks[0].matched && j.picks[0].matched.name, "EliGE");
    assert.equal(j.detail, undefined);
    assert.equal(geminiCalled, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("admin detail names the Workers AI model on a successful read", async () => {
  const env = mkEnv({
    AI: { run: async () => ({ response: slipJsonText() }) }
  });
  const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, adminKey: KEY, ip: "10.1.1.2" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.match(j.detail, /provider=workers-ai/);
  assert.match(j.detail, /llama-4-scout-17b-16e-instruct/);
  assert.doesNotMatch(j.detail, /not-a-real-key|AIza|GEMINI_API_KEY/i);
});

test("empty or unparseable Workers AI output falls back to Gemini", async () => {
  const orig = globalThis.fetch;
  const envBase = () => mkEnv({
    GEMINI_API_KEY: "not-a-real-key",
    AI: { run: async () => ({ response: "" }) }
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: slipJsonText() }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, adminKey: KEY, ip: "10.1.1.3" }), envBase(), new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.picks.length, 1);
    assert.match(j.detail, /provider=gemini/);
    assert.match(j.detail, /workers-ai=empty text/);
    assert.equal(JSON.stringify(j).includes("not-a-real-key"), false);
  } finally {
    globalThis.fetch = orig;
  }

  T.lastHit.clear();
  const env = mkEnv({
    GEMINI_API_KEY: "not-a-real-key",
    AI: { run: async () => ({ response: "sorry, I cannot help with that" }) }
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: slipJsonText() }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, adminKey: KEY, ip: "10.1.1.4" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.match(j.detail, /provider=gemini/);
    assert.match(j.detail, /workers-ai=unparseable/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("when Workers AI and Gemini both fail, admins see both attempts", async () => {
  const orig = globalThis.fetch;
  const env = mkEnv({
    GEMINI_API_KEY: "not-a-real-key",
    AI: { run: async () => { throw new Error("model overloaded"); } }
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" }
  }), { status: 503, headers: { "content-type": "application/json" } });
  const { setRetryDelaysForTest } = await import("../ask_ai.js");
  setRetryDelaysForTest([0, 0]);
  try {
    const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, adminKey: KEY, ip: "10.1.1.5" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 502);
    assert.match(j.error, /couldn'?t read that slip|a bit busy/i);
    assert.match(j.detail, /workers-ai=model overloaded/);
    assert.match(j.detail, /HTTP 503|UNAVAILABLE|gemini-3\.8-flash/);
    assert.equal(JSON.stringify(j).includes("not-a-real-key"), false);
  } finally {
    globalThis.fetch = orig;
    setRetryDelaysForTest(null);
  }
});

test("Workers AI alone is enough to set up the slip reader; Ask Glocky never calls it", async () => {
  const env = mkEnv({
    AI: { run: async () => { throw new Error("Ask Glocky should not call Workers AI"); } }
  });
  // no GEMINI_API_KEY
  const setup = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, ip: "10.1.1.6" }), mkEnv({
    AI: { run: async () => ({ response: slipJsonText() }) }
  }), new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
  const sj = await setup.json();
  assert.equal(setup.status, 200, sj.error);
  assert.equal(sj.picks.length, 1);

  const { handleAsk } = await import("../ask_ai.js");
  let ran = 0;
  const askEnv = mkEnv({
    GEMINI_API_KEY: "not-a-real-key",
    AI: { run: async () => { ran++; return { response: "nope" }; } }
  });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "EliGE's headshot percentage on LAN is 56.97%." }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const r = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's headshot percentage on LAN" }, ip: "10.1.1.7" }), askEnv, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.match(j.answer, /56\.97/);
    assert.equal(ran, 0);
  } finally {
    globalThis.fetch = orig;
  }
});


test("JSON slip uploads keep one base64 string and only sniff header bytes", () => {
  const raw = pngB64();
  assert.equal(T.stripDataUrl("data:image/png;base64," + raw), raw);
  assert.equal(T.b64ByteLength(raw), PNG.length);
  const slip = readFileSync(join(root, "slip_ai.js"), "utf8");
  const readFn = slip.indexOf("async function readImage");
  const jsonPath = slip.indexOf("body.image || body.data || body.file", readFn);
  const fullDecode = slip.indexOf("b64ToBytes(body && (body.image", readFn);
  assert.ok(jsonPath > readFn);
  assert.ok(fullDecode < 0 || fullDecode < readFn, "JSON path must not decode the whole image to bytes");
  assert.match(slip, /b64ToBytes\(raw\.slice\(0, 24\)\)/);
});

test("data-load failures include admin detail with the real reason, never the key", async () => {
  AT.resetDataCache();
  const env = mkEnv({
    GEMINI_API_KEY: "not-a-real-key",
    AI: { run: async () => ({ response: slipJsonText() }) },
    ASSETS: { fetch: async () => { throw new Error("Memory limit exceeded"); } }
  });
  const customer = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, ip: "10.2.1.1" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
  const cj = await customer.json();
  assert.equal(customer.status, 503);
  assert.match(cj.error, /couldn't load our data/i);
  assert.equal(cj.detail, undefined);
  assert.equal(JSON.stringify(cj).includes("not-a-real-key"), false);
  assert.doesNotMatch(JSON.stringify(cj), /Memory limit exceeded|workers-ai|llama-4/i);

  AT.resetDataCache();
  T.lastHit.clear();
  const admin = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, adminKey: KEY, ip: "10.2.1.2" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
  const aj = await admin.json();
  assert.equal(admin.status, 503);
  assert.match(aj.error, /couldn't load our data/i);
  assert.match(aj.detail, /data-load=Memory limit exceeded/);
  assert.match(aj.detail, /provider=workers-ai/);
  assert.match(aj.detail, /llama-4-scout-17b-16e-instruct/);
  assert.match(aj.detail, /image=\d+B/);
  assert.equal(String(aj.detail).includes("not-a-real-key"), false);
  assert.doesNotMatch(aj.error, /Memory limit exceeded|workers-ai|llama-4|Gemini/i);

  AT.resetDataCache();
  T.lastHit.clear();
  const grade = await handleSlip(req("/ai/slip/grade", { body: { picks: [{ player: "EliGE", stat: "kills", line: 35.5, period: "Maps 1-2", side: "over" }] }, adminKey: KEY, ip: "10.2.1.3" }), env, new URL(ORIGIN + "/ai/slip/grade"), KEY_HASH);
  const gj = await grade.json();
  assert.equal(grade.status, 503);
  assert.match(gj.error, /couldn't load our data/i);
  assert.match(gj.detail, /data-load=Memory limit exceeded/);
  assert.equal(String(gj.detail).includes("not-a-real-key"), false);
});

test("slip read loads our data without fetching model.js from ASSETS", async () => {
  AT.resetDataCache();
  const inner = new FakeAssets();
  const env = mkEnv({
    AI: { run: async () => ({ response: slipJsonText() }) },
    ASSETS: {
      async fetch(req) {
        const path = new URL(typeof req === "string" ? req : req.url).pathname;
        assert.notEqual(path, "/model.js", "model.js must come from the static bundle, not ASSETS");
        return inner.fetch(req);
      }
    }
  });
  const r = await handleSlip(req("/ai/slip/read", { body: { image: pngB64(), mime: "image/png" }, ip: "10.3.1.1" }), env, new URL(ORIGIN + "/ai/slip/read"), KEY_HASH);
  const j = await r.json();
  assert.equal(r.status, 200, j.error);
  assert.equal(j.picks.length, 1);
  assert.equal(j.picks[0].matched && j.picks[0].matched.name, "EliGE");
});
