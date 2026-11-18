// Push notifications + support chat tests (no network): node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "../beta_auth.js";
import * as P from "../push.js";
import * as S from "../support_api.js";

const enc = new TextEncoder(), dec = new TextDecoder();
const KEY = "test-admin-key-not-real", KEY_HASH = await A.sha256hex(KEY), SECRET = "s".repeat(40), ORIGIN = "https://site.test";
const join = (s) => s.replace(/\s+/g, "");

// RFC 8291 section 5 / appendix A
const V = {
  plaintext: "When I grow up, I want to be a watermelon",
  as_public: join("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
  as_private: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  ua_public: join("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
  ua_private: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw", auth: "BTBZMqHH6r4Tts7J_aSIgg",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg", cek: "oIhVW04MRdy2XN9CiKLxTg", nonce: "4h_95klXJ5E_qnoN",
  header: join("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8"),
  ct: join("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ"),
};

// receiver side (what a browser does), to check random-key encryption round-trips
async function decrypt(bodyBytes, uaPub, uaPriv, auth) {
  const salt = bodyBytes.slice(0, 16), idlen = bodyBytes[20], asPub = bodyBytes.slice(21, 21 + idlen), ct = bodyBytes.slice(21 + idlen);
  const up = A.unb64u(uaPub);
  const priv = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: A.b64u(up.slice(1, 33)), y: A.b64u(up.slice(33)), d: uaPriv }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
  const H = async (s, k, i, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info: i }, await crypto.subtle.importKey("raw", k, "HKDF", false, ["deriveBits"]), n * 8));
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...up, ...asPub]);
  const ikm = await H(A.unb64u(auth), ecdh, info, 32);
  const cek = await H(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await H(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
  assert.equal(pt[pt.length - 1], 2, "last-record delimiter");
  return dec.decode(pt.slice(0, -1));
}

test("RFC 8291 test vector: aes128gcm payload is byte-exact", async () => {
  const r = await P.encryptPayload(V.ua_public, V.auth, V.plaintext, { asPrivate: V.as_private, asPublic: V.as_public, salt: V.salt });
  assert.equal(A.b64u(r.ikm), V.ikm); assert.equal(A.b64u(r.cek), V.cek); assert.equal(A.b64u(r.nonce), V.nonce);
  assert.equal(A.b64u(r.body.slice(86)), V.ct, "ciphertext");
  assert.equal(r.body.length, 86 + A.unb64u(V.ct).length);
  assert.equal(A.b64u(r.body.slice(0, 86)), V.header);
});

test("random-key encryption decrypts on the receiver side", async () => {
  const r = await P.encryptPayload(V.ua_public, V.auth, JSON.stringify({ title: "New lines are up", body: "24 props" }));
  assert.deepEqual(JSON.parse(await decrypt(r.body, V.ua_public, V.ua_private, V.auth)), { title: "New lines are up", body: "24 props" });
});

test("VAPID header: ES256 JWT verifies with the public key, right audience", async () => {
  const v = await P.generateVapid();
  const h = await P.vapidHeader("https://fcm.googleapis.com/fcm/send/abc", v);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.ok(m); assert.equal(m[4], v.pub);
  const claims = JSON.parse(dec.decode(A.unb64u(m[2])));
  assert.equal(claims.aud, "https://fcm.googleapis.com"); assert.ok(claims.exp > Date.now() / 1000); assert.match(claims.sub, /^https:/);
  const pk = await crypto.subtle.importKey("raw", A.unb64u(v.pub), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pk, A.unb64u(m[3]), enc.encode(m[1] + "." + m[2])));
});

// ---------- endpoint tests ----------
class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, t) { const v = this.m.has(k) ? this.m.get(k) : null; return v != null && t === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix, cursor, limit }) {
    const all = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort(), start = cursor ? +cursor : 0, n = limit || 1000;
    const keys = all.slice(start, start + n).map((name) => ({ name }));
    return start + n >= all.length ? { keys, list_complete: true } : { keys, list_complete: false, cursor: String(start + n) };
  }
}
function req(path, { method = "GET", body, cookie, key } = {}) {
  const h = { "CF-Connecting-IP": "1.2.3.4" };
  if (body) h["Content-Type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  if (key) h["X-Admin-Key"] = key;
  return new Request(ORIGIN + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}
const cookieOf = (res) => (res.headers.get("Set-Cookie") || "").split(";")[0];
// fake push service: records deliveries (decrypting them), answers by endpoint
function pushService() {
  const got = [];
  const f = async (url, init) => {
    const ua = SUBS[url];
    got.push({ url, payload: JSON.parse(await decrypt(init.body, ua.pub, ua.priv, ua.auth)), auth: init.headers.Authorization, ce: init.headers["Content-Encoding"] });
    return new Response(null, { status: url.includes("gone") ? 410 : 201 });
  };
  f.got = got; return f;
}
const SUBS = {};
async function makeSub(name) {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = A.b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), priv = (await crypto.subtle.exportKey("jwk", kp.privateKey)).d;
  const auth = A.b64u(crypto.getRandomValues(new Uint8Array(16))), endpoint = "https://push.example/" + name;
  SUBS[endpoint] = { pub, priv, auth };
  return { endpoint, keys: { p256dh: pub, auth } };
}
async function setup() {
  A._resetGateCache();
  const env = { BETA: new FakeKV(), SESSION_SECRET: SECRET, PBKDF2_ITERATIONS: "10000", BETA_GATE: "on" };
  const call = (r, f) => {
    const url = new URL(r.url);
    if (P.isPushAdminPath(url.pathname)) return P.handlePushAdmin(r, env, url, KEY_HASH, f);
    if (S.isSupportAdminPath(url.pathname)) return S.handleSupportAdmin(r, env, url, KEY_HASH, null, f);
    if (url.pathname.startsWith("/auth/")) return A.handleAuth(r, env, url, KEY_HASH);
    if (url.pathname.startsWith("/push/")) return P.handlePush(r, env, url, KEY_HASH);
    if (url.pathname.startsWith("/support/")) return S.handleSupport(r, env, url, KEY_HASH, null, f);
  };
  const admin = cookieOf(await call(req("/auth/signup", { method: "POST", body: { invite: KEY, username: "glocky", email: "g@x.io", password: "ownerpass1" } })));
  const inv = await (await call(req("/auth/admin/invite", { method: "POST", body: { max: 5 }, key: KEY }))).json();
  const signup = async (u) => cookieOf(await call(req("/auth/signup", { method: "POST", body: { invite: inv.invite.code, username: u, email: u + "@x.io", password: "custpass1" } })));
  return { env, call, admin, signup };
}

test("fail safe: no VAPID keys -> config disabled, notify refused, UI hidden", async () => {
  const { call, admin } = await setup();
  assert.deepEqual(await (await call(req("/push/config", { cookie: admin }))).json(), { enabled: false });
  assert.equal((await call(req("/push/subscribe", { method: "POST", body: {}, cookie: admin }))).status, 503);
  assert.equal((await call(req("/auth/admin/notify", { method: "POST", body: { type: "manual", body: "x" }, key: KEY }))).status, 503);
  assert.equal((await (await call(req("/auth/admin/push/status", { key: KEY }))).json()).ready, false);
});

test("setup, subscribe, prefs, notify fan-out, 410 cleanup, debounce, test, permissions", async () => {
  const { env, call, admin, signup } = await setup();
  const cust = await signup("cust1"), cust2 = await signup("cust2");
  assert.equal((await call(req("/auth/admin/push/setup", { method: "POST", body: {}, cookie: cust }))).status, 403, "customers can't set up");
  const st = await (await call(req("/auth/admin/push/setup", { method: "POST", body: {}, key: KEY }))).json();
  assert.ok(st.ok && st.publicKey);
  const again = await (await call(req("/auth/admin/push/setup", { method: "POST", body: {}, key: KEY }))).json();
  assert.equal(again.publicKey, st.publicKey, "setup is idempotent");
  assert.ok(!JSON.stringify(await (await call(req("/auth/admin/push/status", { key: KEY }))).json()).includes((await env.BETA.get("cfg:vapid", "json")).d), "private key never returned");
  const cfg = await (await call(req("/push/config", { cookie: cust }))).json();
  assert.equal(cfg.enabled, true); assert.equal(cfg.publicKey, st.publicKey); assert.deepEqual(cfg.prefs, { lines: true, grades: true });

  assert.equal((await call(req("/push/subscribe", { method: "POST", body: { subscription: { endpoint: "http://bad" } }, cookie: cust }))).status, 400);
  await call(req("/push/subscribe", { method: "POST", body: { subscription: await makeSub("c1") }, cookie: cust }));
  await call(req("/push/subscribe", { method: "POST", body: { subscription: await makeSub("c2-gone") }, cookie: cust2 }));
  await call(req("/push/subscribe", { method: "POST", body: { subscription: await makeSub("admin") }, cookie: admin }));
  await call(req("/push/prefs", { method: "POST", body: { lines: false, grades: true }, cookie: cust }));   // cust1: grades only

  assert.equal((await call(req("/auth/admin/notify", { method: "POST", body: { type: "lines", body: "x" }, cookie: cust }))).status, 403, "customers can't send");
  let f = pushService();
  let r = await (await call(req("/auth/admin/notify", { method: "POST", body: { type: "lines", title: "New lines are up", body: "24 new props" }, key: KEY }), f)).json();
  assert.equal(r.sent, 1, "admin only (cust1 has lines off, cust2's endpoint is gone)"); assert.equal(r.removed, 1);
  assert.deepEqual(f.got.map((g) => g.url).sort(), ["https://push.example/admin", "https://push.example/c2-gone"]);
  assert.equal(f.got[0].ce, "aes128gcm"); assert.match(f.got[0].auth, /^vapid t=/);
  assert.equal(f.got.find((g) => g.url.endsWith("admin")).payload.body, "24 new props");
  assert.equal(await env.BETA.get("push:sub:cust2:" + (await A.sha256hex("https://push.example/c2-gone")).slice(0, 20)), null, "410 -> removed");

  r = await (await call(req("/auth/admin/notify", { method: "POST", body: { type: "lines", body: "again" }, key: KEY }), pushService())).json();
  assert.equal(r.skipped, "debounced");
  f = pushService();
  r = await (await call(req("/auth/admin/notify", { method: "POST", body: { type: "grades", body: "5 A+ picks" }, cookie: admin }), f)).json();
  assert.equal(r.sent, 2, "admin account can send; cust1 wants grades");
  f = pushService();
  r = await (await call(req("/auth/admin/notify", { method: "POST", body: { type: "test", body: "test" }, cookie: admin }), f)).json();
  assert.deepEqual(f.got.map((g) => g.url), ["https://push.example/admin"], "test only to the admin who pressed it");

  // disabling a user removes their subscriptions
  await call(req("/auth/admin/user/disable", { method: "POST", body: { u: "cust1", disabled: true }, key: KEY }));
  assert.equal((await env.BETA.list({ prefix: "push:sub:cust1:" })).keys.length, 0);
});

test("fan-out runs in batches with a cursor", async () => {
  const { env, call } = await setup();
  await call(req("/auth/admin/push/setup", { method: "POST", body: {}, key: KEY }));
  for (let i = 0; i < 40; i++) {
    const s = await makeSub("b" + i);
    await env.BETA.put("push:sub:glocky:" + String(i).padStart(3, "0"), JSON.stringify(Object.assign({ u: "glocky" }, s)));
  }
  const f = pushService();
  const a = await (await call(req("/auth/admin/notify", { method: "POST", body: { type: "manual", body: "hi" }, key: KEY }), f)).json();
  assert.equal(a.sent, 35); assert.ok(a.cursor);
  const b = await (await call(req("/auth/admin/notify", { method: "POST", body: { job: a.job, cursor: a.cursor }, key: KEY }), f)).json();
  assert.equal(b.sent, 5); assert.equal(b.cursor, null); assert.equal(f.got.length, 40);
});

test("support chat: send, limits, inbox unread, reply, push both ways, escaping is the page's job", async () => {
  const { env, call, admin, signup } = await setup();
  const cust = await signup("cust1");
  await call(req("/auth/admin/push/setup", { method: "POST", body: {}, key: KEY }));
  await call(req("/push/subscribe", { method: "POST", body: { subscription: await makeSub("adm") }, cookie: admin }));
  await call(req("/push/subscribe", { method: "POST", body: { subscription: await makeSub("cus") }, cookie: cust }));

  assert.equal((await call(req("/support/send", { method: "POST", body: { text: "hi" } }))).status, 401, "needs login");
  assert.equal((await call(req("/support/send", { method: "POST", body: { text: "x".repeat(1001) }, cookie: cust }))).status, 400);
  assert.equal((await call(req("/support/send", { method: "POST", body: { text: "   " }, cookie: cust }))).status, 400);
  let f = pushService();
  const s1 = await call(req("/support/send", { method: "POST", body: { text: "<img src=x onerror=alert(1)> is avid OVER good?" }, cookie: cust }), f);
  assert.equal(s1.status, 200);
  assert.deepEqual(f.got.map((g) => g.url), ["https://push.example/adm"], "owner notified");
  assert.equal(f.got[0].payload.title, "Support: cust1");
  assert.equal((await (await call(req("/support/thread", { cookie: cust }))).json()).msgs[0].t, "<img src=x onerror=alert(1)> is avid OVER good?", "stored as plain text");

  assert.equal((await call(req("/auth/admin/support/threads", { cookie: cust }))).status, 403, "customers can't read the inbox");
  let inbox = await (await call(req("/auth/admin/support/threads", { cookie: admin }))).json();
  assert.equal(inbox.unread, 1); assert.equal(inbox.threads[0].u, "cust1");
  await call(req("/auth/admin/support/thread?u=cust1", { cookie: admin }));
  inbox = await (await call(req("/auth/admin/support/threads", { key: KEY }))).json();
  assert.equal(inbox.unread, 0, "opening the thread marks it read");

  f = pushService();
  await call(req("/auth/admin/support/reply", { method: "POST", body: { u: "cust1", text: "Yes, A+ on Maps 1-2" }, cookie: admin }), f);
  assert.deepEqual(f.got.map((g) => g.url), ["https://push.example/cus"], "customer notified of reply");
  assert.equal((await (await call(req("/support/thread?peek=1", { cookie: cust }))).json()).unread, 1, "badge count");
  await call(req("/support/read", { method: "POST", body: {}, cookie: cust }));
  assert.equal((await (await call(req("/support/thread?peek=1", { cookie: cust }))).json()).unread, 0);
  const th = await (await call(req("/support/thread", { cookie: cust }))).json();
  assert.deepEqual(th.msgs.map((m) => m.f), ["u", "o"]);

  // rate limit: 12 sends per 10 minutes
  let last;
  for (let i = 0; i < 12; i++) last = await call(req("/support/send", { method: "POST", body: { text: "m" + i }, cookie: cust }), pushService());
  assert.equal(last.status, 429);
});
