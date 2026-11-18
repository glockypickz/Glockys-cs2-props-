// Web Push for Glockys Prop Grader (runs in the Cloudflare Worker; never served as a site file, see .assetsignore).
// Standard Web Push: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291), WebCrypto only, no libraries.
//
// Plain words: logged-in beta users tap "Turn on notifications"; their phone/browser gives us a push address which is saved
// under their account. When the lines job finds new lines / new grades it asks the Worker (admin key) to send a short
// notification to everyone who wants that type. Fail safe: with no VAPID keys everything here is off and the UI is hidden.
//
// KV keys (BETA namespace):
//   cfg:vapid                 {pub, d, at}  (public key raw b64url, private scalar b64url). Env VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY win.
//   push:sub:<user>:<id>      {endpoint, keys:{p256dh, auth}, u, created}
//   push:pref:<user>          {lines:true, grades:true}
//   push:last:<type>          ISO time of the last lines / grades send (debounce)
//   push:job:<id>             {payload, type, at}  a send in progress (fan-out is done in batches)
import { b64u, unb64u, sha256hex, identify, isAdmin, configProblems } from "./beta_auth.js";

const enc = new TextEncoder();
export const DEBOUNCE_MIN = 30;
const BATCH = 35;                 // pushes per request: stays under the Free plan's 50 subrequests per invocation
const SUBJECT = "https://x.com/GlockyPickz";

function concat(...arrs) {
  const n = arrs.reduce((s, a) => s + a.length, 0), out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json", "Cache-Control": "no-store" } });
}
async function body(request) { try { return (await request.json()) || {}; } catch (e) { return {}; } }

// ---------- keys ----------
function jwkFromRaw(pubRaw, d) {
  if (pubRaw.length !== 65 || pubRaw[0] !== 4) throw new Error("bad P-256 public key");
  const jwk = { kty: "EC", crv: "P-256", x: b64u(pubRaw.slice(1, 33)), y: b64u(pubRaw.slice(33, 65)), ext: true };
  if (d) jwk.d = typeof d === "string" ? d : b64u(d);
  return jwk;
}
export async function generateVapid() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { pub: b64u(pub), d: jwk.d };
}
export async function getVapid(env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { pub: String(env.VAPID_PUBLIC_KEY).trim(), d: String(env.VAPID_PRIVATE_KEY).trim(), from: "env" };
  if (!env.BETA) return null;
  try { const v = await env.BETA.get("cfg:vapid", "json"); return v && v.pub && v.d ? Object.assign(v, { from: "kv" }) : null; } catch (e) { return null; }
}
export async function pushReady(env) { return !configProblems(env).length && !!(await getVapid(env)); }

// ---------- VAPID (RFC 8292) ----------
export async function vapidHeader(endpoint, vapid, now) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor((now || Date.now()) / 1000) + 12 * 3600;
  const h = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = b64u(enc.encode(JSON.stringify({ aud, exp, sub: SUBJECT })));
  const key = await crypto.subtle.importKey("jwk", jwkFromRaw(unb64u(vapid.pub), vapid.d), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(h + "." + p)));   // raw r||s, what JWS wants
  return "vapid t=" + h + "." + p + "." + b64u(sig) + ", k=" + vapid.pub;
}

// ---------- payload encryption (RFC 8291, aes128gcm, one record) ----------
async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}
// opts.asPrivate (b64url d) + opts.asPublic (b64url raw) + opts.salt (b64url) only for the RFC test vector; normally random.
export async function encryptPayload(uaPublicB64, authB64, plaintext, opts) {
  opts = opts || {};
  const uaPub = unb64u(uaPublicB64), auth = unb64u(authB64);
  let asPriv, asPub;
  if (opts.asPrivate) {
    asPub = unb64u(opts.asPublic);
    asPriv = await crypto.subtle.importKey("jwk", jwkFromRaw(asPub, opts.asPrivate), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPriv = kp.privateKey;
    asPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPriv, 256));
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPub, asPub);
  const ikm = await hkdf(auth, ecdh, keyInfo, 32);
  const salt = opts.salt ? unb64u(opts.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const pt = typeof plaintext === "string" ? enc.encode(plaintext) : plaintext;
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(pt, new Uint8Array([2]))));
  const header = concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPub.length]), asPub);   // rs = 4096
  return { body: concat(header, ct), ikm, cek, nonce };
}

export async function sendOne(sub, payload, vapid, fetcher) {
  const { body } = await encryptPayload(sub.keys.p256dh, sub.keys.auth, JSON.stringify(payload));
  const r = await (fetcher || fetch)(sub.endpoint, { method: "POST", body,
    headers: { TTL: "21600", Urgency: "normal", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      Authorization: await vapidHeader(sub.endpoint, vapid) } });
  return r.status;
}

// ---------- subscriptions ----------
async function subId(endpoint) { return (await sha256hex(endpoint)).slice(0, 20); }
function validSub(s) {
  try {
    const u = new URL(s.endpoint);
    return u.protocol === "https:" && s.endpoint.length < 1024 && s.keys && unb64u(s.keys.p256dh).length === 65 && unb64u(s.keys.auth).length === 16;
  } catch (e) { return false; }
}
export async function removeUserSubs(env, u) {
  if (!env.BETA) return 0;
  let n = 0, cursor;
  do {
    const page = await env.BETA.list({ prefix: "push:sub:" + u + ":", cursor });
    for (const k of page.keys) { await env.BETA.delete(k.name); n++; }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return n;
}
async function prefs(env, u) {
  const p = (await env.BETA.get("push:pref:" + u, "json")) || {};
  return { lines: p.lines !== false, grades: p.grades !== false };
}

// ---------- /push/* (logged-in users) ----------
export async function handlePush(request, env, url, keyHash) {
  const path = url.pathname;
  const vapid = await pushReady(env) ? await getVapid(env) : null;
  const who = await identify(request, env, keyHash);
  const u = who && who.user;
  if (path === "/push/config") {
    if (!vapid) return json({ enabled: false });
    const out = { enabled: true, publicKey: vapid.pub, user: u || null };
    if (u) out.prefs = await prefs(env, u);
    return json(out);
  }
  if (!vapid) return json({ error: "notifications are not set up" }, 503);
  if (!u) return json({ error: "log in to get notifications" }, 401);
  if (request.method !== "POST" || !(request.headers.get("Content-Type") || "").includes("application/json")) return json({ error: "use POST JSON" }, 405);
  const b = await body(request);
  if (path === "/push/subscribe") {
    const s = b.subscription || {};
    if (!validSub(s)) return json({ error: "bad subscription" }, 400);
    const id = await subId(s.endpoint);
    await env.BETA.put("push:sub:" + u + ":" + id, JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, u, created: new Date().toISOString() }));
    if (b.prefs) await env.BETA.put("push:pref:" + u, JSON.stringify({ lines: b.prefs.lines !== false, grades: b.prefs.grades !== false }));
    return json({ ok: true, prefs: await prefs(env, u) });
  }
  if (path === "/push/unsubscribe") {
    if (b.endpoint) await env.BETA.delete("push:sub:" + u + ":" + (await subId(String(b.endpoint))));
    return json({ ok: true });
  }
  if (path === "/push/prefs") {
    const p = { lines: b.lines !== false, grades: b.grades !== false };
    await env.BETA.put("push:pref:" + u, JSON.stringify(p));
    return json({ ok: true, prefs: p });
  }
  return json({ error: "not found" }, 404);
}

// ---------- owner: /auth/admin/push/*  and  /auth/admin/notify ----------
export function isPushAdminPath(path) { return path === "/auth/admin/notify" || path.startsWith("/auth/admin/push/"); }

function cleanPayload(b, type) {
  const s = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
  let url = s(b.url, 200) || "/";
  if (!url.startsWith("/") || url.startsWith("//")) url = "/";
  return { title: s(b.title, 60) || "Glockys Prop Grader", body: s(b.body, 160), url, tag: type };
}

// One batch of the fan-out. Returns {sent, removed, failed, cursor|null}.
async function sendBatch(env, job, cursor, onlyUsers, fetcher) {
  const vapid = await getVapid(env);
  const page = await env.BETA.list({ prefix: "push:sub:", cursor, limit: BATCH });
  const users = {}, out = { sent: 0, removed: 0, failed: 0, skipped: 0 };
  for (const k of page.keys) {
    const sub = await env.BETA.get(k.name, "json");
    if (!sub) continue;
    if (!(sub.u in users)) {
      const rec = await env.BETA.get("user:" + sub.u, "json");
      users[sub.u] = { rec, p: await prefs(env, sub.u) };
    }
    const { rec, p } = users[sub.u];
    if (!rec || rec.disabled) { await env.BETA.delete(k.name); out.removed++; continue; }   // account gone / switched off
    if (onlyUsers && !onlyUsers(rec)) { out.skipped++; continue; }
    if ((job.type === "lines" && !p.lines) || (job.type === "grades" && !p.grades)) { out.skipped++; continue; }
    let st = 0;
    try { st = await sendOne(sub, job.payload, vapid, fetcher); } catch (e) { st = 0; }
    if (st === 404 || st === 410) { await env.BETA.delete(k.name); out.removed++; }
    else if (st >= 200 && st < 300) out.sent++;
    else out.failed++;
  }
  out.cursor = page.list_complete ? null : page.cursor;
  return out;
}

export async function handlePushAdmin(request, env, url, keyHash, fetcher) {
  const path = url.pathname;
  const who = await isAdmin(request, env, keyHash);
  if (!who) return json({ error: "admin key or admin account required" }, 403);
  const problems = configProblems(env);
  if (problems.length) return json({ error: "Login is not set up: " + problems.join("; ") }, 503);
  const KV = env.BETA, b = request.method === "POST" ? await body(request) : {};

  if (path === "/auth/admin/push/status") {
    const v = await getVapid(env);
    let subs = 0, cursor;
    do { const pg = await KV.list({ prefix: "push:sub:", cursor }); subs += pg.keys.length; cursor = pg.list_complete ? null : pg.cursor; } while (cursor);
    return json({ ready: !!v, from: v ? v.from : null, publicKey: v ? v.pub : null, subscriptions: subs,
      last: { lines: await KV.get("push:last:lines"), grades: await KV.get("push:last:grades") } });
  }
  if (path === "/auth/admin/push/setup" && request.method === "POST") {
    // Makes the VAPID key pair inside the Worker and keeps it in KV: the private key never leaves Cloudflare.
    const cur = await getVapid(env);
    if (cur && cur.from === "env") return json({ error: "VAPID keys come from Cloudflare secrets; change them there." }, 409);
    if (cur && !b.replace) return json({ ok: true, publicKey: cur.pub, note: "already set up" });
    const v = await generateVapid();
    await KV.put("cfg:vapid", JSON.stringify({ pub: v.pub, d: v.d, at: new Date().toISOString() }));
    let dropped = 0;
    if (cur) {           // old subscriptions are tied to the old key: drop them, phones re-subscribe on their next visit
      let c; do { const pg = await KV.list({ prefix: "push:sub:", cursor: c }); for (const k of pg.keys) { await KV.delete(k.name); dropped++; } c = pg.list_complete ? null : pg.cursor; } while (c);
    }
    return json({ ok: true, publicKey: v.pub, replaced: !!cur, dropped });
  }
  if (path === "/auth/admin/notify" && request.method === "POST") {
    if (!(await getVapid(env))) return json({ error: "notifications are not set up (no VAPID keys)" }, 503);
    let job, jobId = b.job ? String(b.job).replace(/[^a-z0-9]/gi, "").slice(0, 40) : "";
    if (jobId) {
      job = await KV.get("push:job:" + jobId, "json");
      if (!job) return json({ error: "no such job" }, 404);
    } else {
      const type = ["lines", "grades", "manual", "test"].includes(b.type) ? b.type : "manual";
      const payload = cleanPayload(b, type);
      if (!payload.body) return json({ error: "body required" }, 400);
      if ((type === "lines" || type === "grades") && !b.force) {
        const last = await KV.get("push:last:" + type);
        if (last && Date.now() - Date.parse(last) < DEBOUNCE_MIN * 60000)
          return json({ ok: true, skipped: "debounced", last, next_allowed: new Date(Date.parse(last) + DEBOUNCE_MIN * 60000).toISOString() });
      }
      if (type === "lines" || type === "grades") await KV.put("push:last:" + type, new Date().toISOString());
      jobId = b64u(crypto.getRandomValues(new Uint8Array(9))).replace(/[^a-z0-9]/gi, "x");
      job = { type, payload, at: new Date().toISOString(), by: who.user || "admin key", testUser: type === "test" ? (who.user || null) : null };
      await KV.put("push:job:" + jobId, JSON.stringify(job), { expirationTtl: 3600 });
    }
    // test: only the admin account that pressed the button (or every admin account when sent with the admin key)
    const only = job.type === "test" ? (rec) => (job.testUser ? rec.u === job.testUser : rec.role === "admin") : null;
    const r = await sendBatch(env, job, b.cursor || undefined, only, fetcher);
    return json(Object.assign({ ok: true, job: jobId, type: job.type }, r));
  }
  return json({ error: "not found" }, 404);
}

// ---------- direct sends (support chat) ----------
// Usernames of admin accounts (small beta: reads the user list).
export async function adminUsers(env) {
  const out = []; let cursor;
  do {
    const pg = await env.BETA.list({ prefix: "user:", cursor });
    for (const k of pg.keys) { const r = await env.BETA.get(k.name, "json"); if (r && r.role === "admin" && !r.disabled) out.push(r.u); }
    cursor = pg.list_complete ? null : pg.cursor;
  } while (cursor);
  return out;
}
// Push to every subscription of the given users. Returns {sent, removed, failed}.
export async function sendToUsers(env, usernames, payload, fetcher) {
  const vapid = await getVapid(env), out = { sent: 0, removed: 0, failed: 0 };
  if (!vapid) return out;
  for (const u of usernames.slice(0, 20)) {
    const rec = await env.BETA.get("user:" + u, "json");
    if (!rec || rec.disabled) { out.removed += await removeUserSubs(env, u); continue; }
    const pg = await env.BETA.list({ prefix: "push:sub:" + u + ":", limit: 10 });
    for (const k of pg.keys) {
      const sub = await env.BETA.get(k.name, "json");
      if (!sub) continue;
      let st = 0;
      try { st = await sendOne(sub, payload, vapid, fetcher); } catch (e) { st = 0; }
      if (st === 404 || st === 410) { await env.BETA.delete(k.name); out.removed++; }
      else if (st >= 200 && st < 300) out.sent++;
      else out.failed++;
    }
  }
  return out;
}
