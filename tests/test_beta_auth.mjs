// Beta login unit tests (no network, no Cloudflare): node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "../beta_auth.js";

const KEY = "test-admin-key-not-real";
const KEY_HASH = await A.sha256hex(KEY);
const SECRET = "x".repeat(40);

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, t) { const v = this.m.has(k) ? this.m.get(k) : null; return v != null && t === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix }) { return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; }
}
function mkEnv(extra) { A._resetGateCache(); return Object.assign({ BETA: new FakeKV(), SESSION_SECRET: SECRET, PBKDF2_ITERATIONS: "10000" }, extra || {}); }
const ORIGIN = "https://site.test";
function req(path, { method = "GET", body, cookie, key, accept, ip = "1.1.1.1" } = {}) {
  const h = { "CF-Connecting-IP": ip };
  if (body) h["Content-Type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  if (key) h["X-Admin-Key"] = key;
  if (accept) h.Accept = accept;
  return new Request(ORIGIN + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}
async function call(env, r) {
  const url = new URL(r.url);
  if (url.pathname.startsWith("/auth/")) return A.handleAuth(r, env, url, KEY_HASH);
  return (await A.gate(r, env, url, KEY_HASH)) || new Response("page", { status: 200 });
}
function cookieOf(res) { const c = res.headers.get("Set-Cookie") || ""; return c.split(";")[0]; }

test("PBKDF2 hashes verify and use a per-user salt", async () => {
  const a = await A.newPasswordRecord("hunter22!", 10000), b = await A.newPasswordRecord("hunter22!", 10000);
  assert.notEqual(a.salt, b.salt); assert.notEqual(a.hash, b.hash);
  assert.equal(await A.checkPassword("hunter22!", a), true);
  assert.equal(await A.checkPassword("hunter23!", a), false);
});

test("session tokens are HMAC signed and expire", async () => {
  const t = await A.signSession({ u: "bob", v: 0, exp: Date.now() + 60000 }, SECRET);
  assert.equal((await A.verifySession(t, SECRET)).u, "bob");
  assert.equal(await A.verifySession(t, "y".repeat(40)), null);
  const [b, s] = t.split(".");
  const forged = A.b64u(new TextEncoder().encode(JSON.stringify({ u: "admin", v: 0, exp: Date.now() + 60000 }))) + "." + s;
  assert.equal(await A.verifySession(forged, SECRET), null);
  assert.equal(await A.verifySession(await A.signSession({ u: "bob", exp: Date.now() - 1 }, SECRET), SECRET), null);
  assert.equal(await A.verifySession(b, SECRET), null);
});

test("fail safe: no KV / no secret -> gate open, login disabled", async () => {
  for (const env of [{}, { BETA: new FakeKV() }, { SESSION_SECRET: SECRET }, { BETA: new FakeKV(), SESSION_SECRET: "short" }]) {
    A._resetGateCache();
    assert.equal((await call(env, req("/players.json"))).status, 200);
    assert.equal((await call(env, req("/auth/login", { method: "POST", body: { username: "a", password: "b" } }))).status, 503);
    const me = await (await call(env, req("/auth/me"))).json();
    assert.equal(me.configured, false); assert.equal(me.gate, "off");
  }
});

test("gate starts OFF; owner turns it on; full customer flow", async () => {
  const env = mkEnv();
  assert.equal((await call(env, req("/players.json"))).status, 200, "gate off by default");
  assert.equal((await call(env, req("/auth/admin/gate", { method: "POST", body: { on: true } }))).status, 403, "needs admin");
  assert.equal((await call(env, req("/auth/admin/gate", { method: "POST", body: { on: true }, key: KEY }))).status, 200);
  for (const p of ["/players.json", "/lines.json", "/games.json", "/pregame.json", "/live/123", "/app.js"])
    assert.equal((await call(env, req(p))).status, 401, p);
  const nav = await call(env, req("/", { accept: "text/html" }));
  assert.equal(nav.status, 302); assert.match(nav.headers.get("Location"), /^\/login\?next=/);
  for (const p of ["/login", "/beta.css", "/beta-login.js", "/assets/logo-swing.png", "/assets/logo-tile.png", "/auth/me"])
    assert.equal((await call(env, req(p))).status, 200, p);
  assert.equal((await call(env, req("/players.json", { key: KEY }))).status, 200, "admin key bypasses");

  const inv = await (await call(env, req("/auth/admin/invite", { method: "POST", body: { note: "t", max: 1 }, key: KEY }))).json();
  const bad = await call(env, req("/auth/signup", { method: "POST", body: { invite: "NOPE", username: "bob", email: "b@x.io", password: "longpass1" } }));
  assert.equal(bad.status, 400);
  const su = await call(env, req("/auth/signup", { method: "POST", body: { invite: inv.invite.code, username: "Bob", email: "b@x.io", password: "longpass1" } }));
  assert.equal(su.status, 200);
  const sc = su.headers.get("Set-Cookie");
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/); assert.match(sc, /Secure/);
  const again = await call(env, req("/auth/signup", { method: "POST", body: { invite: inv.invite.code, username: "eve", email: "e@x.io", password: "longpass1" } }));
  assert.equal(again.status, 400, "single-use invite used up");

  const li = await call(env, req("/auth/login", { method: "POST", body: { username: "b@x.io", password: "longpass1" } }));
  assert.equal(li.status, 200);
  const ck = cookieOf(li);
  assert.equal((await call(env, req("/players.json", { cookie: ck }))).status, 200);
  const me = await (await call(env, req("/auth/me", { cookie: ck }))).json();
  assert.equal(me.user, "bob"); assert.equal(me.admin, false);
  assert.equal((await call(env, req("/auth/admin/state", { cookie: ck }))).status, 403, "customer can't use owner tools");

  // disable -> signed out everywhere; re-enable needs a new login (session version bumped)
  await call(env, req("/auth/admin/user/disable", { method: "POST", body: { u: "bob", disabled: true }, key: KEY }));
  assert.equal((await call(env, req("/players.json", { cookie: ck }))).status, 401);
  assert.equal((await call(env, req("/auth/login", { method: "POST", body: { username: "bob", password: "longpass1" } }))).status, 401);
  await call(env, req("/auth/admin/user/disable", { method: "POST", body: { u: "bob", disabled: false }, key: KEY }));
  const rs = await (await call(env, req("/auth/admin/user/reset", { method: "POST", body: { u: "bob" }, key: KEY }))).json();
  assert.equal((await call(env, req("/auth/login", { method: "POST", body: { username: "bob", password: "longpass1" } }))).status, 401, "old password dead");
  assert.equal((await call(env, req("/auth/login", { method: "POST", body: { username: "bob", password: rs.tempPassword } }))).status, 200);

  // logout clears the cookie
  const lo = await call(env, req("/auth/logout", { method: "POST" }));
  assert.match(lo.headers.get("Set-Cookie"), /Max-Age=0/);

  // revoke
  const inv2 = await (await call(env, req("/auth/admin/invite", { method: "POST", body: { max: 5 }, key: KEY }))).json();
  await call(env, req("/auth/admin/invite/revoke", { method: "POST", body: { code: inv2.invite.code }, key: KEY }));
  assert.equal((await call(env, req("/auth/signup", { method: "POST", body: { invite: inv2.invite.code, username: "zed", email: "z@x.io", password: "longpass1" } }))).status, 400);

  // gate off -> open again
  await call(env, req("/auth/admin/gate", { method: "POST", body: { on: false }, key: KEY }));
  assert.equal((await call(env, req("/players.json"))).status, 200);
});

test("BETA_GATE env var forces the gate", async () => {
  const env = mkEnv({ BETA_GATE: "off" });
  await env.BETA.put("cfg:gate", "on");
  assert.equal((await call(env, req("/players.json"))).status, 200);
  const on = mkEnv({ BETA_GATE: "on" });
  assert.equal((await call(on, req("/players.json"))).status, 401);
});

test("admin account: bootstrap with admin key, gets owner tools, promote / demote", async () => {
  const env = mkEnv({ BETA_GATE: "on" });
  const su = await call(env, req("/auth/signup", { method: "POST", body: { invite: KEY, username: "glocky", email: "g@x.io", password: "ownerpass1" } }));
  assert.equal(su.status, 200); assert.equal((await su.json()).role, "admin");
  assert.ok(!JSON.stringify([...env.BETA.m.values()]).includes(KEY), "admin key never stored");
  const ck = cookieOf(su);
  const me = await (await call(env, req("/auth/me", { cookie: ck }))).json();
  assert.equal(me.admin, true);
  const who = await A.isAdmin(req("/lines_history.json", { cookie: ck }), env, KEY_HASH);
  assert.ok(who, "admin account counts as admin for the Track Record");
  const st = await call(env, req("/auth/admin/state", { cookie: ck }));
  assert.equal(st.status, 200);
  // cross-site style write without JSON content type is refused for cookie auth
  const csrf = new Request(ORIGIN + "/auth/admin/gate", { method: "POST", headers: { Cookie: ck, Origin: "https://evil.test", "Content-Type": "application/json" }, body: "{}" });
  assert.equal((await call(env, csrf)).status, 403);

  const inv = await (await call(env, req("/auth/admin/invite", { method: "POST", body: { max: 2 }, cookie: ck }))).json();
  const c2 = cookieOf(await call(env, req("/auth/signup", { method: "POST", body: { invite: inv.invite.code, username: "cust", email: "c@x.io", password: "custpass1" } })));
  assert.equal(await A.isAdmin(req("/lines_history.json", { cookie: c2 }), env, KEY_HASH), null, "customer: no Track Record");
  await call(env, req("/auth/admin/user/role", { method: "POST", body: { u: "cust", admin: true }, cookie: ck }));
  assert.ok(await A.isAdmin(req("/lines_history.json", { cookie: c2 }), env, KEY_HASH), "promoted");
  await call(env, req("/auth/admin/user/role", { method: "POST", body: { u: "cust", admin: false }, cookie: ck }));
  assert.equal(await A.isAdmin(req("/lines_history.json", { cookie: c2 }), env, KEY_HASH), null, "demoted");
});

test("failed logins are rate limited per user and per IP", async () => {
  const env = mkEnv();
  const inv = await (await call(env, req("/auth/admin/invite", { method: "POST", body: { max: 1 }, key: KEY }))).json();
  await call(env, req("/auth/signup", { method: "POST", body: { invite: inv.invite.code, username: "ann", email: "a@x.io", password: "annpass11" } }));
  let last;
  for (let i = 0; i < 9; i++) last = await call(env, req("/auth/login", { method: "POST", body: { username: "ann", password: "wrong" + i }, ip: "9.9.9." + i }));
  assert.equal(last.status, 429, "per-user limit");
  assert.equal((await call(env, req("/auth/login", { method: "POST", body: { username: "ann", password: "annpass11" }, ip: "8.8.8.8" }))).status, 429);
  const env2 = mkEnv();
  for (let i = 0; i < 20; i++) await call(env2, req("/auth/login", { method: "POST", body: { username: "u" + i, password: "x" }, ip: "7.7.7.7" }));
  assert.equal((await call(env2, req("/auth/login", { method: "POST", body: { username: "zz", password: "x" }, ip: "7.7.7.7" }))).status, 429, "per-IP limit");
});
