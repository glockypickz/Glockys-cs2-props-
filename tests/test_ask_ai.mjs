// Ask Glocky Worker handler tests (no live Gemini calls; fetch is stubbed).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as A from "../beta_auth.js";
import { handleAsk, isAskPath, loadGPModelFromSource, systemPrompt, fallbackPhrase, _test as T } from "../ask_ai.js";
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

test("loadGPModelFromSource installs the same v1e API", () => {
  const src = readFileSync(join(root, "model.js"), "utf8");
  const api = loadGPModelFromSource(src);
  assert.equal(api.VERSION, "v1e");
  assert.equal(typeof api.grade, "function");
  assert.equal(typeof api.decodePlayers, "function");
});

test("Gemini URL must not include the secret (header only); phrasing is stripped of a leading Glocky says", async () => {
  const env = mkEnv({ GEMINI_API_KEY: "not-a-real-key" });
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: opts && opts.headers });
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
    }
  } finally {
    globalThis.fetch = orig;
  }
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
