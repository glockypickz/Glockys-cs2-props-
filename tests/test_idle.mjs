// Idle sign-out (30 min sliding session) tests: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "../beta_auth.js";
import worker from "../worker.js";

const KEY = "test-admin-key-not-real", KEY_HASH = await A.sha256hex(KEY), SECRET = "q".repeat(40), ORIGIN = "https://site.test";
class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, t) { const v = this.m.has(k) ? this.m.get(k) : null; return v != null && t === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix }) { return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; }
}
function mkEnv(extra) {
  A._resetGateCache();
  return Object.assign({ BETA: new FakeKV(), SESSION_SECRET: SECRET, BETA_GATE: "on", PBKDF2_ITERATIONS: "10000",
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } }, extra || {});
}
async function userEnv() {
  const env = mkEnv();
  await env.BETA.put("user:bob", JSON.stringify({ u: "bob", role: "user", ver: 0 }));
  await env.BETA.put("user:boss", JSON.stringify({ u: "boss", role: "admin", ver: 0 }));
  return env;
}
const tok = (p) => A.signSession(Object.assign({ v: 0, exp: Date.now() + 864e5 }, p), SECRET);
function req(path, { method = "GET", cookie, key, nav, body } = {}) {
  const h = {};
  if (cookie) h.Cookie = A.COOKIE + "=" + cookie;
  if (key) h["X-Admin-Key"] = key;
  if (nav) { h["Sec-Fetch-Mode"] = "navigate"; h.Accept = "text/html"; } else h["Sec-Fetch-Mode"] = "cors";
  if (body) h["Content-Type"] = "application/json";
  return new Request(ORIGIN + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}
const run = (env, r) => worker.fetch(r, env, { waitUntil() {} });
const MIN = 60000;

test("active session works; idle > 30 min is rejected and the cookie is cleared", async () => {
  const env = await userEnv();
  assert.equal((await run(env, req("/players.json", { cookie: await tok({ u: "bob", la: Date.now() - 5 * MIN }) }))).status, 200);
  const r = await run(env, req("/players.json", { cookie: await tok({ u: "bob", la: Date.now() - 31 * MIN }) }));
  assert.equal(r.status, 401); assert.match(r.headers.get("Set-Cookie"), /Max-Age=0/);
  const nav = await run(env, req("/", { nav: true, cookie: await tok({ u: "bob", la: Date.now() - 31 * MIN }) }));
  assert.equal(nav.status, 302); assert.match(nav.headers.get("Location"), /^\/login/);
});

test("sessions from before idle sign-out (no last-activity) count as expired", async () => {
  const env = await userEnv();
  assert.equal((await run(env, req("/players.json", { cookie: await tok({ u: "bob" }) }))).status, 401);
});

test("admin accounts and key-swapped admin cookies idle out too; the admin key header never does", async () => {
  const env = await userEnv();
  assert.equal((await run(env, req("/lines_history.json", { cookie: await tok({ u: "boss", la: Date.now() - MIN }) }))).status, 200);
  assert.equal((await run(env, req("/lines_history.json", { cookie: await tok({ u: "boss", la: Date.now() - 40 * MIN }) }))).status, 401);
  // admin-key parts use the test key hash directly (worker.js has the real KEY_HASH baked in)
  const id = (r) => A.identify(r, env, KEY_HASH);
  assert.ok(await id(req("/x", { cookie: await tok({ r: "admin", k: KEY_HASH.slice(0, 16), la: Date.now() - MIN }) })));
  assert.equal(await id(req("/x", { cookie: await tok({ r: "admin", k: KEY_HASH.slice(0, 16), la: Date.now() - 40 * MIN }) })), null);
  assert.equal((await id(req("/x", { key: KEY }))).via, "header");
  assert.equal((await id(req("/x", { key: KEY, cookie: await tok({ u: "bob", la: Date.now() - 99 * MIN }) }))).via, "header");
  assert.equal((await A.gate(req("/players.json", { key: KEY }), env, new URL(ORIGIN + "/players.json"), KEY_HASH)), null, "key header passes the gate");
});

test("page loads and /auth/ping slide the session; background fetches don't", async () => {
  const env = await userEnv();
  const old = await tok({ u: "bob", la: Date.now() - 20 * MIN });
  const bg = await run(env, req("/players.json", { cookie: old }));
  assert.equal(bg.status, 200); assert.equal(bg.headers.get("Set-Cookie"), null, "data polling is not activity");
  const nav = await run(env, req("/", { nav: true, cookie: old }));
  const sc = nav.headers.get("Set-Cookie");
  assert.match(sc, /gp_sess=.+HttpOnly; SameSite=Lax/);
  const p = await A.verifySession(sc.split(";")[0].slice(A.COOKIE.length + 1), SECRET);
  assert.ok(Date.now() - p.la < 2000, "last activity is now"); assert.equal(p.u, "bob");
  const pg = await run(env, req("/auth/ping", { method: "POST", cookie: old }));
  assert.equal(pg.status, 200); assert.equal((await pg.json()).idleMin, 30);
  assert.ok((await A.verifySession(pg.headers.get("Set-Cookie").split(";")[0].slice(A.COOKIE.length + 1), SECRET)).la > Date.now() - 2000);
  const dead = await run(env, req("/auth/ping", { method: "POST", cookie: await tok({ u: "bob", la: Date.now() - 31 * MIN }) }));
  assert.equal(dead.status, 401, "ping can't revive an idle session");
  assert.equal((await run(env, req("/auth/ping", { method: "POST", key: KEY }))).status, 401, "key holders have nothing to ping");
});

test("/auth/me reports the window; SESSION_IDLE_MIN overrides it", async () => {
  const env = await userEnv();
  assert.equal((await (await run(env, req("/auth/me", { cookie: await tok({ u: "bob", la: Date.now() }) }))).json()).idleMin, 30);
  const env2 = Object.assign(await userEnv(), { SESSION_IDLE_MIN: "40" });
  assert.equal((await (await run(env2, req("/auth/me"))).json()).idleMin, 40);
  assert.equal((await run(env2, req("/players.json", { cookie: await tok({ u: "bob", la: Date.now() - 35 * MIN }) }))).status, 200);
});

test("login issues a session with last activity; support + push still work with it", async () => {
  const env = await userEnv();
  await env.BETA.put("invite:TESTCODE01", JSON.stringify({ code: "TESTCODE01", max: 1, uses: 0, revoked: false, users: [] }));
  const su = await run(env, req("/auth/signup", { method: "POST", body: { invite: "TESTCODE01", username: "cara", email: "c@x.io", password: "carapass1" } }));
  const c = su.headers.get("Set-Cookie").split(";")[0].slice(A.COOKIE.length + 1);
  assert.ok((await A.verifySession(c, SECRET)).la > Date.now() - 5000);
  assert.equal((await run(env, req("/support/thread", { cookie: c }))).status, 200);
  assert.equal((await run(env, req("/push/config", { cookie: c }))).status, 200);
  const idle = await tok({ u: "cara", la: Date.now() - 31 * MIN });
  assert.equal((await run(env, req("/support/thread?peek=1", { cookie: idle }))).status, 401);
});
