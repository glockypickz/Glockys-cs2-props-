// Ask Glocky Worker handler tests (no live Gemini calls; fetch is stubbed).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as A from "../beta_auth.js";
import { handleAsk, isAskPath, installGPModel, systemPrompt, fallbackPhrase, scrubProviders, setRetryDelaysForTest, _test as T } from "../ask_ai.js";
import * as L from "../ask_lookup.js";

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
  return Object.assign({ BETA: new FakeKV(), SESSION_SECRET: SECRET, PBKDF2_ITERATIONS: "10000", ASSETS: new FakeAssets() }, extra || {});
}
function req(path, { method = "POST", body, cookie, ip = "1.1.1.1" } = {}) {
  const h = { "CF-Connecting-IP": ip, Origin: ORIGIN };
  if (body) h["Content-Type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  return new Request(ORIGIN + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}

test("Ask Glocky paths and setup message never mention keys", () => {
  assert.equal(isAskPath("/ai/ask"), true);
  assert.equal(isAskPath("/ai/status"), true);
  assert.equal(isAskPath("/auth/me"), false);
  assert.equal(T.SETUP_MSG, "Ask Glocky isn't set up yet.");
  assert.doesNotMatch(T.SETUP_MSG, /api|key|secret|gemini|token/i);
  const prompt = systemPrompt();
  assert.match(prompt, /You are Glocky/);
  assert.match(prompt, /don't have that in our data/);
  assert.doesNotMatch(prompt, /GEMINI_API_KEY|api key/i);
});

test("status is setup:false without a secret; POST returns the friendly message", async () => {
  const env = mkEnv();
  const st = await handleAsk(req("/ai/status", { method: "GET" }), env, new URL(ORIGIN + "/ai/status"), KEY_HASH);
  const sj = await st.json();
  assert.equal(st.status, 200);
  assert.equal(sj.setup, false);
  assert.equal(sj.name, "Glocky");
  const r = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's HS% on LAN" } }), env, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
  const j = await r.json();
  assert.equal(r.status, 503);
  assert.equal(j.error, "Ask Glocky isn't set up yet.");
  assert.equal(JSON.stringify(j).includes("GEMINI"), false);
  assert.doesNotMatch(JSON.stringify(j), /api key|secret/i);
});

test("gate on: signed-out users cannot ask", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  await env.BETA.put("cfg:gate", "on");
  A._resetGateCache();
  const r = await handleAsk(req("/ai/ask", { body: { question: "hi" } }), env, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
  const j = await r.json();
  assert.equal(r.status, 401);
  assert.equal(j.login, "/login");
});

test("installGPModel installs the same current grader API", () => {
  const api = installGPModel(require(join(root, "model.js")));
  assert.equal(api.VERSION, "v1f");
  assert.equal(typeof api.grade, "function");
  assert.equal(typeof api.decodePlayers, "function");
  assert.equal(globalThis.GPModel, api);
});

test("Gemini URL must not include the secret (header only); phrasing is stripped of a leading Glocky says", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: opts && opts.headers, body: opts && opts.body });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Glocky says EliGE's headshot percentage on LAN is 56.97%." }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's headshot percentage on LAN" } }), env, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.match(j.answer, /56\.97/);
    assert.doesNotMatch(j.answer, /^Glocky says/i);
    assert.ok(seen.length >= 1);
    for (const s of seen) {
      assert.equal(s.url.includes("not-a-real-key"), false);
      assert.doesNotMatch(s.url, /key=/i);
      assert.match(s.url, /models\/gemini-3\.8-flash:generateContent/);
      if (s.body) {
        const body = JSON.parse(s.body);
        assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "low");
        assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, undefined);
      }
    }
  } finally {
    globalThis.fetch = orig;
  }
});

test("extractText ignores thought parts and keeps visible text", () => {
  const emptyThought = T.extractText({
    candidates: [{ content: { parts: [{ thought: true, text: "secret reasoning" }] }, finishReason: "MAX_TOKENS" }]
  });
  assert.equal(emptyThought, "");
  const mixed = T.extractText({
    candidates: [{ content: { parts: [{ thought: true, text: "hmm" }, { text: "EliGE 56.97%" }] } }]
  });
  assert.equal(mixed, "EliGE 56.97%");
});

test("per-user daily limit returns a friendly 429", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const day = new Date().toISOString().slice(0, 10);
  await env.BETA.put("ai:day:" + day + ":ip:9.9.9.9", String(T.USER_DAILY));
  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return new Response("{}", { status: 500 }); };
  try {
    const r = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's HS% on LAN" }, ip: "9.9.9.9" }), env, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 429);
    assert.match(j.error, /today's Ask Glocky limit/i);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fallbackPhrase uses our grade numbers, not invented ones", () => {
  const text = fallbackPhrase({
    missing: false,
    grade: { player: "EliGE", pick: "UNDER", line: 35.5, stat: "kills", period: "Maps 1-2", grade: "D", proj: 33.1, bait: false, lan: false, source: "asked" }
  });
  assert.match(text, /EliGE/);
  assert.match(text, /UNDER/);
  assert.match(text, /35\.5/);
  assert.match(text, /D/);
  assert.match(text, /33\.1/);
  assert.equal(fallbackPhrase({ missing: true }), "I don't have that in our data.");
});

test("UI source uses Ask Glocky labels and does not mention keys", () => {
  const app = readFileSync(join(root, "app.js"), "utf8");
  const css = readFileSync(join(root, "styles.css"), "utf8");
  assert.match(app, /Ask Glocky/);
  assert.match(app, /Glocky says/);
  assert.doesNotMatch(app, /Ask AI/);
  assert.doesNotMatch(app, /GP_AI_URL|GEMINI_API_KEY|api key/i);
  assert.match(css, /Ask Glocky/);
  assert.doesNotMatch(css, /Ask AI/);
  assert.match(app, /GPCards\.html/);
});

test("scrubbers strip provider names, including from a model reply", async () => {
  const dirty = "According to Cito and bo3.gg, EliGE is at 56.97%. Gemini agrees.";
  const clean = scrubProviders(dirty);
  assert.doesNotMatch(clean, /\b(cito|bo3(?:\.gg)?|kash\s*rock|hltv|gemini|google)\b/i);
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: dirty }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const r = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's headshot percentage on LAN" }, ip: "7.7.7.7" }), env, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200, j.error || j.answer);
    assert.doesNotMatch(j.answer, /\b(cito|bo3(?:\.gg)?|kash\s*rock|hltv|gemini|google)\b/i);
  } finally {
    globalThis.fetch = orig;
  }
  const app = readFileSync(join(root, "app.js"), "utf8");
  const welcome = app.match(/I only answer from[^"]+/);
  assert.ok(welcome);
  assert.doesNotMatch(welcome[0], /\b(cito|bo3(?:\.gg)?|kash\s*rock|hltv|gemini)\b/i);
  assert.doesNotMatch(systemPrompt(), /\b(cito|bo3(?:\.gg)?|kash\s*rock|hltv|gemini|google)\b/i);
});

test("thinkingConfigFor disables thinking on 2.5 and uses a low level on 3.x", () => {
  assert.equal(T.DEFAULT_MODEL, "gemini-3.8-flash");
  assert.equal(T.geminiModel({}), "gemini-3.8-flash");
  assert.equal(T.geminiModel({ GEMINI_MODEL: "gemini-2.5-flash" }), "gemini-3.8-flash");
  assert.equal(T.geminiModel({ GEMINI_MODEL: "gemini-3.5-flash-lite" }), "gemini-3.5-flash-lite");
  assert.deepEqual(T.thinkingConfigFor("gemini-2.5-flash", 0), { thinkingBudget: 0 });
  assert.deepEqual(T.thinkingConfigFor("gemini-3.8-flash"), { thinkingLevel: "low" });
  assert.deepEqual(T.thinkingConfigFor("gemini-3.5-flash-lite"), { thinkingLevel: "minimal" });
  assert.deepEqual(T.thinkingConfigFor("gemini-3.6-flash"), { thinkingLevel: "minimal" });
  assert.ok(T.FALLBACK_MODELS.includes("gemini-3.5-flash-lite"));
  assert.ok(T.FALLBACK_MODELS.includes("gemini-3.6-flash"));
  assert.deepEqual(T.RETRY_DELAYS_MS, [1000, 2500]);
  assert.equal(T.thinkingConfigFor("some-other-model"), null);
});

test("sanitizeDetail redacts keys and keeps a short reason", () => {
  const s = T.sanitizeDetail("HTTP 400: bad key=AIzaSyDummyKeyValue1234567890 and secret not-a-real-key-value", "not-a-real-key-value");
  assert.match(s, /HTTP 400/);
  assert.doesNotMatch(s, /AIza/);
  assert.doesNotMatch(s, /not-a-real-key-value/);
  assert.match(s, /\[redacted\]/);
});

test("404 NOT_FOUND on an unknown model retries gemini-3.8-flash", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key", GEMINI_MODEL: "gemini-ghost-model" });
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(String(url));
    if (String(url).includes("gemini-ghost-model")) {
      return new Response(JSON.stringify({
        error: { code: 404, message: "This model models/gemini-ghost-model is no longer available to new users.", status: "NOT_FOUND" }
      }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "EliGE's headshot percentage on LAN is 56.97%." }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's headshot percentage on LAN" }, ip: "5.5.5.5" }), env, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.match(j.answer, /56\.97/);
    assert.ok(seen.some((u) => u.includes("gemini-ghost-model")));
    assert.ok(seen.some((u) => u.includes("gemini-3.8-flash")));
    assert.ok(seen.every((u) => !u.includes("not-a-real-key") && !/key=/i.test(u)));
  } finally {
    globalThis.fetch = orig;
  }
});

test("Ask Glocky retries a 503 and falls back to another Flash model", async () => {
  setRetryDelaysForTest([0, 0]);
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("gemini-3.8-flash")) {
      return new Response(JSON.stringify({
        error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" }
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "EliGE's headshot percentage on LAN is 56.97%." }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's headshot percentage on LAN" }, ip: "6.6.6.6" }), env, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.match(j.answer, /56\.97/);
    assert.equal(j.busy, false);
    assert.equal(seen.filter((u) => u.includes("gemini-3.8-flash")).length, 3);
    assert.ok(seen.some((u) => u.includes("gemini-3.5-flash-lite")));
    assert.ok(seen.every((u) => !u.includes("not-a-real-key")));
  } finally {
    globalThis.fetch = orig;
    setRetryDelaysForTest(null);
  }
});

test("Ask Glocky tells the user it is busy when every model stays unavailable", async () => {
  setRetryDelaysForTest([0, 0]);
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" }
  }), { status: 503, headers: { "content-type": "application/json" } });
  try {
    const r = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's headshot percentage on LAN" }, ip: "6.6.6.7" }), env, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.busy, true);
    assert.match(j.answer, /a bit busy/i);
    assert.doesNotMatch(j.answer, /not-a-real-key/);
  } finally {
    globalThis.fetch = orig;
    setRetryDelaysForTest(null);
  }
});

test("Ask Glocky loads our data without fetching model.js from ASSETS", async () => {
  T.resetDataCache();
  const inner = new FakeAssets();
  const env = mkEnv({
    GEMINI_API_KEY: "not-a-real-key",
    ASSETS: {
      async fetch(req) {
        const path = new URL(typeof req === "string" ? req : req.url).pathname;
        assert.notEqual(path, "/model.js", "model.js must come from the static bundle, not ASSETS");
        return inner.fetch(req);
      }
    }
  });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "EliGE's headshot percentage on LAN is 56.97%." }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const r = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's headshot percentage on LAN" }, ip: "10.9.9.1" }), env, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
    const j = await r.json();
    assert.equal(r.status, 200, j.error);
    assert.match(j.answer, /56\.97/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("failed Ask Glocky data-load does not count toward the daily cap; admins are exempt", async () => {
  T.resetDataCache();
  const env = mkEnv({
    GEMINI_API_KEY: "not-a-real-key",
    ASSETS: { fetch: async () => { throw new Error("players.json missing"); } }
  });
  const day = new Date().toISOString().slice(0, 10);
  const kvKey = "ai:day:" + day + ":ip:10.8.2.1";
  await env.BETA.put(kvKey, "19");
  const fail = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's HS% on LAN" }, ip: "10.8.2.1" }), env, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
  const fj = await fail.json();
  assert.equal(fail.status, 503);
  assert.match(fj.error, /couldn't load our data/i);
  assert.equal(await env.BETA.get(kvKey), "19");

  T.lastHit.clear();
  T.resetDataCache();
  const okEnv = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  await okEnv.BETA.put(kvKey, "19");
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "EliGE's headshot percentage on LAN is 56.97%." }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const ok = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's HS% on LAN" }, ip: "10.8.2.1" }), okEnv, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
    const oj = await ok.json();
    assert.equal(ok.status, 200, oj.error);
    assert.equal(await okEnv.BETA.get(kvKey), "20");

    T.lastHit.clear();
    const blocked = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's HS% on LAN" }, ip: "10.8.2.1" }), okEnv, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
    assert.equal(blocked.status, 429);

    T.lastHit.clear();
    await okEnv.BETA.put("user:GlockyPickz", JSON.stringify({ u: "GlockyPickz", role: "admin", ver: 0, disabled: false }));
    const tok = await A.signSession({ u: "GlockyPickz", v: 0, exp: Date.now() + 600000 }, SECRET);
    await okEnv.BETA.put("ai:day:" + day + ":u:GlockyPickz", String(T.USER_DAILY));
    await okEnv.BETA.put("ai:day:" + day + ":admin", String(T.USER_DAILY));
    const admin = await handleAsk(req("/ai/ask", { body: { question: "what's EliGE's HS% on LAN" }, cookie: A.COOKIE + "=" + tok, ip: "10.8.2.2" }), okEnv, new URL(ORIGIN + "/ai/ask"), KEY_HASH);
    const aj = await admin.json();
    assert.equal(admin.status, 200, aj.error);
    assert.match(aj.answer, /56\.97|EliGE/i);
  } finally {
    globalThis.fetch = orig;
  }
});

