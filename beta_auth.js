// Beta login for Glockys Prop Grader (runs inside the Cloudflare Worker; never served as a site file, see .assetsignore).
//
// What it does, in plain words:
//  - Beta customers sign up with an invite code the owner makes, pick a username + password, and get a login cookie.
//  - When the gate is ON, every app page and data file needs that cookie. When it is OFF the site works exactly as before.
//  - Admin ACCOUNTS (role "admin") get everything: the app, the full Track Record (lines_history.json) and /beta-admin.
//    The first admin account is made by typing the existing admin key into the invite-code box once at sign-up
//    (checked against KEY_HASH, never stored). Admins can then promote / demote other users at /beta-admin.
//  - The old admin key (X-Admin-Key header / #admin= link) still works as a fallback and always gets in.
//
// Fail safe: if the BETA KV binding or the SESSION_SECRET secret is missing, login is switched off and the site is open as
// it was before this change. The gate also starts OFF; the owner turns it on from /beta-admin.html (or BETA_GATE=on).
//
// Storage (KV namespace bound as BETA):
//   user:<username>   {u, email, role:"user"|"admin", salt, hash, iter, created, disabled, ver, invite, last}
//   email:<email>     <username>
//   invite:<code>     {code, note, max, uses, created, revoked, users:[]}
//   cfg:gate          "on" | "off"
//   rl:ip:<ip> / rl:u:<username>   failed-attempt counters (expire after 15 minutes)

import { removeUserSubs } from "./push.js";

export const COOKIE = "gp_sess";
const SESSION_DAYS = 30;
const ADMIN_SESSION_DAYS = 30;
const DEFAULT_ITER = 100000;          // Workers' WebCrypto PBKDF2 maximum; override with env PBKDF2_ITERATIONS
const RL_WINDOW = 900;                // seconds
const RL_MAX_IP = 20;                 // failed logins / bad invite codes per IP per window
const RL_MAX_USER = 8;                // failed logins per username per window

const enc = new TextEncoder();

// ---------- small helpers ----------
export function b64u(bytes) {
  let s = "";
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function safeEqual(a, b) {
  const x = typeof a === "string" ? enc.encode(a) : a, y = typeof b === "string" ? enc.encode(b) : b;
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
export async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(n) { return b64u(crypto.getRandomValues(new Uint8Array(n))); }
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I
export function randomCode(len) {
  const r = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_CHARS[r[i] % CODE_CHARS.length];
  return s;
}
function json(obj, status, extra) {
  const h = new Headers({ "content-type": "application/json", "Cache-Control": "no-store" });
  if (extra) for (const [k, v] of Object.entries(extra)) h.append(k, v);
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}
async function body(request) {
  try { return (await request.json()) || {}; } catch (e) { return {}; }
}
export function normUser(u) { return String(u || "").trim().toLowerCase(); }
export function validUser(u) { return /^[a-z0-9_.-]{3,24}$/.test(u); }
export function validEmail(e) { return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
export function validPassword(p) { return typeof p === "string" && p.length >= 8 && p.length <= 200; }

// ---------- passwords (PBKDF2-SHA256, per-user salt) ----------
export async function hashPassword(password, saltB64, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64u(saltB64), iterations: iter }, key, 256);
  return b64u(bits);
}
export async function newPasswordRecord(password, iter) {
  const salt = randomToken(16);
  return { salt, iter, hash: await hashPassword(password, salt, iter) };
}
export async function checkPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const h = await hashPassword(password, rec.salt, rec.iter || DEFAULT_ITER);
  return safeEqual(h, rec.hash);
}

// ---------- signed session cookie (HMAC-SHA256 with SESSION_SECRET) ----------
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function signSession(payload, secret) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return body + "." + b64u(sig);
}
export async function verifySession(token, secret, now) {
  if (!token || typeof token !== "string") return null;
  const i = token.indexOf(".");
  if (i < 1) return null;
  const body = token.slice(0, i);
  let sig;
  try { sig = unb64u(token.slice(i + 1)); } catch (e) { return null; }
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(body));
  if (!ok) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(unb64u(body))); } catch (e) { return null; }
  if (!p || typeof p.exp !== "number" || p.exp < (now || Date.now())) return null;
  return p;
}
export function readCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  for (const part of c.split(";")) {
    const j = part.indexOf("=");
    if (j > 0 && part.slice(0, j).trim() === name) return part.slice(j + 1).trim();
  }
  return null;
}
function cookieHeader(url, value, maxAge) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + secure;
}

// ---------- config / state ----------
export function configProblems(env) {
  const p = [];
  if (!env || !env.BETA || typeof env.BETA.get !== "function") p.push("KV binding BETA is missing");
  if (!env || !env.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) p.push("secret SESSION_SECRET is missing or shorter than 32 characters");
  return p;
}
let gateCache = { v: null, at: 0 };
export function _resetGateCache() { gateCache = { v: null, at: 0 }; }
async function gateFlag(env) {
  const forced = String(env.BETA_GATE || "").toLowerCase();
  if (forced === "off" || forced === "on") return forced;
  if (gateCache.v && Date.now() - gateCache.at < 15000) return gateCache.v;
  let v = "off";
  try { v = (await env.BETA.get("cfg:gate")) === "on" ? "on" : "off"; } catch (e) { v = "off"; }
  gateCache = { v, at: Date.now() };
  return v;
}
// "off" when login can't work (fail open = site behaves as before), else the gate flag.
export async function gateState(env) {
  if (configProblems(env).length) return "unconfigured";
  return gateFlag(env);
}

// ---------- rate limiting (KV counters; best effort, KV is eventually consistent) ----------
async function rlCount(env, key) {
  try { return parseInt((await env.BETA.get(key)) || "0", 10) || 0; } catch (e) { return 0; }
}
async function rlHit(env, key) {
  try { await env.BETA.put(key, String((await rlCount(env, key)) + 1), { expirationTtl: RL_WINDOW }); } catch (e) {}
}
function clientIp(request) { return request.headers.get("CF-Connecting-IP") || "local"; }

// ---------- admin key ----------
async function adminHeaderOk(request, keyHash) {
  const sent = String(request.headers.get("X-Admin-Key") || "").trim();
  return sent.length > 0 && safeEqual(await sha256hex(sent), keyHash);
}

// Who is this request? -> {admin:true} | {user:"name"} | null
export async function identify(request, env, keyHash) {
  if (await adminHeaderOk(request, keyHash)) return { admin: true, via: "header" };
  if (configProblems(env).length) return null;
  const p = await verifySession(readCookie(request, COOKIE), env.SESSION_SECRET);
  if (!p) return null;
  if (p.r === "admin") return p.k === keyHash.slice(0, 16) ? { admin: true, via: "cookie" } : null;   // dies when the admin key changes
  if (!p.u) return null;
  const rec = await env.BETA.get("user:" + p.u, "json");
  if (!rec || rec.disabled || (rec.ver || 0) !== (p.v || 0)) return null;
  return rec.role === "admin" ? { user: p.u, admin: true, via: "account" } : { user: p.u };
}

// Admin = admin key header, or an admin login cookie (admin account / key-swapped session).
// Cookie-authenticated writes must be same-origin JSON (SameSite=Lax already blocks cross-site cookies; this is belt and braces).
export async function isAdmin(request, env, keyHash) {
  const who = await identify(request, env, keyHash);
  if (!who || !who.admin) return null;
  if (who.via !== "header" && request.method !== "GET") {
    const o = request.headers.get("Origin");
    if (o && o !== new URL(request.url).origin) return null;
    if (!(request.headers.get("Content-Type") || "").includes("application/json")) return null;
  }
  return who;
}

// ---------- the gate ----------
// Paths anyone may load while the gate is on (the login page and what it needs).
const OPEN = new Set(["/login", "/beta-login", "/beta-login.html", "/beta-admin", "/beta-admin.html", "/beta.css", "/beta-login.js", "/beta-admin.js",
  "/assets/logo-swing.png", "/assets/logo-tile.png", "/assets/logo.png", "/apple-touch-icon.png", "/favicon.ico", "/lockcheck.html",
  "/sw.js", "/manifest.webmanifest", "/assets/icon-192.png", "/assets/icon-512.png"]);   // service worker + manifest: iOS fetches them without cookies
export function isOpenPath(path) { return OPEN.has(path) || path.startsWith("/auth/"); }
function wantsHtml(request, path) {
  if (path === "/" || path.endsWith(".html") || !/\.[a-z0-9]{1,5}$/i.test(path)) return true;
  return (request.headers.get("Accept") || "").includes("text/html");
}
// Returns a Response to send instead of the page, or null to let the request through.
export async function gate(request, env, url, keyHash) {
  const path = url.pathname;
  if (isOpenPath(path)) return null;
  if ((await gateState(env)) !== "on") return null;
  if (await identify(request, env, keyHash)) return null;
  if (wantsHtml(request, path) && request.method === "GET" && !/\.json$/i.test(path) && !/^\/(live|push|support|wins|ai)\//.test(path)) {
    const next = path + url.search;
    return new Response(null, { status: 302, headers: { Location: "/login?next=" + encodeURIComponent(next), "Cache-Control": "no-store" } });
  }
  return json({ error: "login required", login: "/login" }, 401);
}

// ---------- /auth/* API ----------
function safeNext(n) { n = String(n || "/"); return n.startsWith("/") && !n.startsWith("//") ? n : "/"; }

export async function handleAuth(request, env, url, keyHash) {
  const path = url.pathname, method = request.method;
  const problems = configProblems(env);

  if (path === "/auth/me") {
    const who = await identify(request, env, keyHash);
    return json({ configured: !problems.length, problems, gate: problems.length ? "off" : await gateFlag(env),
      user: who && who.user ? who.user : null, admin: !!(who && who.admin) });
  }

  // ---- owner (admin key) API ----
  if (path.startsWith("/auth/admin")) {
    if (path === "/auth/admin/session" && method === "POST") {
      if (!(await adminHeaderOk(request, keyHash))) return json({ error: "admin key required" }, 403);
      // Swap the admin key (sent as a header by the page that has it in localStorage) for an HttpOnly cookie so plain page
      // loads get through the gate on this device.
      if (problems.length) return json({ ok: true, note: "login is not set up, the site is open" });
      const tok = await signSession({ r: "admin", k: keyHash.slice(0, 16), exp: Date.now() + ADMIN_SESSION_DAYS * 864e5 }, env.SESSION_SECRET);
      return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(url, tok, ADMIN_SESSION_DAYS * 86400) });
    }
    if (!(await isAdmin(request, env, keyHash))) return json({ error: "admin key or admin account required" }, 403);
    if (problems.length) return json({ error: "Login is not set up yet: " + problems.join("; ") + ".", problems }, 503);
    const KV = env.BETA, b = method === "POST" ? await body(request) : {};
    if (path === "/auth/admin/state" && method === "GET") {
      const users = [], invites = [];
      for (const [prefix, arr] of [["user:", users], ["invite:", invites]]) {
        let cursor;
        do {
          const page = await KV.list({ prefix, cursor });
          for (const k of page.keys) {
            const r = await KV.get(k.name, "json");
            if (!r) continue;
            if (prefix === "user:") arr.push({ u: r.u, email: r.email, role: r.role === "admin" ? "admin" : "user", created: r.created, last: r.last || null, disabled: !!r.disabled, invite: r.invite || null });
            else arr.push(r);
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
      }
      users.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
      invites.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
      return json({ gate: await gateFlag(env), forced: ["on", "off"].includes(String(env.BETA_GATE || "").toLowerCase()) ? String(env.BETA_GATE).toLowerCase() : null, users, invites });
    }
    if (path === "/auth/admin/gate" && method === "POST") {
      const v = b.on ? "on" : "off";
      await KV.put("cfg:gate", v);
      gateCache = { v, at: Date.now() };
      return json({ ok: true, gate: v, note: "Other Cloudflare locations can take up to a minute to see the change." });
    }
    if (path === "/auth/admin/invite" && method === "POST") {
      const max = Math.max(1, Math.min(1000, parseInt(b.max, 10) || 1));
      const code = randomCode(10);
      const inv = { code, note: String(b.note || "").slice(0, 80), max, uses: 0, created: new Date().toISOString(), revoked: false, users: [] };
      await KV.put("invite:" + code, JSON.stringify(inv));
      return json({ ok: true, invite: inv });
    }
    if (path === "/auth/admin/invite/revoke" && method === "POST") {
      const code = String(b.code || "").trim().toUpperCase();
      const inv = await KV.get("invite:" + code, "json");
      if (!inv) return json({ error: "no such invite" }, 404);
      inv.revoked = true;
      await KV.put("invite:" + code, JSON.stringify(inv));
      return json({ ok: true, invite: inv });
    }
    if (path === "/auth/admin/user/disable" && method === "POST") {
      const u = normUser(b.u), rec = await KV.get("user:" + u, "json");
      if (!rec) return json({ error: "no such user" }, 404);
      rec.disabled = !!b.disabled;
      rec.ver = (rec.ver || 0) + 1;          // signs the user out everywhere
      await KV.put("user:" + u, JSON.stringify(rec));
      if (rec.disabled) await removeUserSubs(env, u);   // and stops their push notifications
      return json({ ok: true, u, disabled: rec.disabled });
    }
    if (path === "/auth/admin/user/role" && method === "POST") {
      const u = normUser(b.u), rec = await KV.get("user:" + u, "json");
      if (!rec) return json({ error: "no such user" }, 404);
      rec.role = b.admin ? "admin" : "user";
      await KV.put("user:" + u, JSON.stringify(rec));
      return json({ ok: true, u, role: rec.role });
    }
    if (path === "/auth/admin/user/reset" && method === "POST") {
      const u = normUser(b.u), rec = await KV.get("user:" + u, "json");
      if (!rec) return json({ error: "no such user" }, 404);
      const temp = randomCode(4) + "-" + randomCode(4) + "-" + randomCode(4);
      Object.assign(rec, await newPasswordRecord(temp, iterations(env)));
      rec.ver = (rec.ver || 0) + 1;
      await KV.put("user:" + u, JSON.stringify(rec));
      return json({ ok: true, u, tempPassword: temp });
    }
    return json({ error: "not found" }, 404);
  }

  // ---- customer API ----
  if (path === "/auth/logout") {
    return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(url, "", 0) });
  }
  if (problems.length) return json({ error: "Beta login is not switched on yet.", problems }, 503);
  if (method !== "POST") return json({ error: "use POST" }, 405);
  const KV = env.BETA, b = await body(request), ip = clientIp(request);

  if (path === "/auth/signup") {
    if ((await rlCount(env, "rl:ip:" + ip)) >= RL_MAX_IP) return json({ error: "Too many tries. Wait 15 minutes and try again." }, 429);
    const code = String(b.invite || "").trim().toUpperCase(), u = normUser(b.username), email = String(b.email || "").trim().toLowerCase();
    if (!validUser(u)) return json({ error: "Username must be 3-24 characters: letters, numbers, dot, dash or underscore." }, 400);
    if (!validEmail(email)) return json({ error: "Enter a valid email." }, 400);
    if (!validPassword(b.password)) return json({ error: "Password must be at least 8 characters." }, 400);
    // Owner bootstrap: the existing admin key typed into the invite box makes an ADMIN account (key is only hashed + compared).
    const adminClaim = String(b.invite || "").trim().length > 0 && safeEqual(await sha256hex(String(b.invite).trim()), keyHash);
    const inv = adminClaim ? null : code ? await KV.get("invite:" + code, "json") : null;
    if (!adminClaim && (!inv || inv.revoked || inv.uses >= inv.max)) { await rlHit(env, "rl:ip:" + ip); return json({ error: "That invite code isn't valid or has been used up." }, 400); }
    if (await KV.get("user:" + u)) return json({ error: "That username is taken." }, 409);
    if (await KV.get("email:" + email)) return json({ error: "That email already has an account. Log in instead." }, 409);
    const rec = Object.assign({ u, email, role: adminClaim ? "admin" : "user", created: new Date().toISOString(), disabled: false, ver: 0,
      invite: adminClaim ? "(admin key)" : code, last: new Date().toISOString() },
      await newPasswordRecord(b.password, iterations(env)));
    await KV.put("user:" + u, JSON.stringify(rec));
    await KV.put("email:" + email, u);
    if (inv) {
      inv.uses = (inv.uses || 0) + 1;
      inv.users = (inv.users || []).concat(u).slice(-50);
      await KV.put("invite:" + code, JSON.stringify(inv));
    }
    const tok = await signSession({ u, v: 0, exp: Date.now() + SESSION_DAYS * 864e5 }, env.SESSION_SECRET);
    return json({ ok: true, user: u, role: rec.role, next: safeNext(b.next) }, 200, { "Set-Cookie": cookieHeader(url, tok, SESSION_DAYS * 86400) });
  }

  if (path === "/auth/login") {
    let u = normUser(b.username);
    if (u.includes("@")) u = (await KV.get("email:" + u)) || u;
    if ((await rlCount(env, "rl:ip:" + ip)) >= RL_MAX_IP || (await rlCount(env, "rl:u:" + u)) >= RL_MAX_USER)
      return json({ error: "Too many failed logins. Wait 15 minutes and try again." }, 429);
    const rec = validUser(u) ? await KV.get("user:" + u, "json") : null;
    const ok = rec ? await checkPassword(String(b.password || ""), rec) : (await hashPassword("x", "AAAAAAAAAAAAAAAAAAAAAA", iterations(env)), false);
    if (!ok || rec.disabled) {
      await rlHit(env, "rl:ip:" + ip);
      if (validUser(u)) await rlHit(env, "rl:u:" + u);
      return json({ error: rec && rec.disabled && ok ? "This account is switched off. Contact @GlockyPickz." : "Wrong username or password." }, 401);
    }
    rec.last = new Date().toISOString();
    await KV.put("user:" + u, JSON.stringify(rec));
    const tok = await signSession({ u, v: rec.ver || 0, exp: Date.now() + SESSION_DAYS * 864e5 }, env.SESSION_SECRET);
    return json({ ok: true, user: u, role: rec.role === "admin" ? "admin" : "user", next: safeNext(b.next) }, 200, { "Set-Cookie": cookieHeader(url, tok, SESSION_DAYS * 86400) });
  }
  return json({ error: "not found" }, 404);
}

function iterations(env) {
  const n = parseInt(env.PBKDF2_ITERATIONS, 10);
  return n >= 10000 && n <= 100000 ? n : DEFAULT_ITER;
}
