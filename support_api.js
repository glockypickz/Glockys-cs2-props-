// Support chat between logged-in beta customers and the owner (runs in the Worker; not a site file, see .assetsignore).
// KV (BETA):  sup:thread:<user>  {u, msgs:[{f:"u"|"o", t, at, by?}], unreadOwner, unreadUser, updated}
//             sup:rl:<user>      sends in the current 10-minute window
// Messages are plain text (max 1000 chars); the pages always insert them with textContent, never as HTML.
import { identify, isAdmin, configProblems, normUser } from "./beta_auth.js";
import { sendToUsers, adminUsers, pushReady } from "./push.js";

export const MAX_LEN = 1000;
const KEEP = 200;              // messages kept per thread
const RL_MAX = 12, RL_TTL = 600;

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json", "Cache-Control": "no-store" } });
}
async function body(request) { try { return (await request.json()) || {}; } catch (e) { return {}; } }
export function cleanText(t) {
  return String(t == null ? "" : t).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
}
function jsonPost(request) { return request.method === "POST" && (request.headers.get("Content-Type") || "").includes("application/json"); }
async function getThread(env, u) { return (await env.BETA.get("sup:thread:" + u, "json")) || { u, msgs: [], unreadOwner: 0, unreadUser: 0, updated: null }; }
async function putThread(env, th) { th.msgs = th.msgs.slice(-KEEP); await env.BETA.put("sup:thread:" + th.u, JSON.stringify(th)); }
function later(ctx, p) { if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {})); else return p.catch(() => {}); }
function preview(t) { return t.length > 110 ? t.slice(0, 107) + "..." : t; }

// /support/*  (logged-in customer or admin account, for their own thread)
export async function handleSupport(request, env, url, keyHash, ctx, fetcher) {
  if (configProblems(env).length) return json({ error: "support chat is not set up" }, 503);
  const who = await identify(request, env, keyHash);
  if (!who || !who.user) return json({ error: "log in to message us" }, 401);
  const u = who.user, path = url.pathname;
  if (path === "/support/thread" && request.method === "GET") {
    const th = await getThread(env, u);
    if (url.searchParams.get("peek") === "1") return json({ unread: th.unreadUser || 0 });
    return json({ msgs: th.msgs, unread: th.unreadUser || 0 });
  }
  if (!jsonPost(request)) return json({ error: "use POST JSON" }, 405);
  if (path === "/support/read") {
    const th = await getThread(env, u);
    if (th.unreadUser) { th.unreadUser = 0; await putThread(env, th); }
    return json({ ok: true });
  }
  if (path === "/support/send") {
    const b = await body(request), t = cleanText(b.text);
    if (!t) return json({ error: "Type a message first." }, 400);
    if (t.length > MAX_LEN) return json({ error: "Messages can be up to " + MAX_LEN + " characters." }, 400);
    const n = parseInt((await env.BETA.get("sup:rl:" + u)) || "0", 10) || 0;
    if (n >= RL_MAX) return json({ error: "You're sending a lot. Wait a few minutes and try again." }, 429);
    await env.BETA.put("sup:rl:" + u, String(n + 1), { expirationTtl: RL_TTL });
    const th = await getThread(env, u);
    th.msgs.push({ f: "u", t, at: new Date().toISOString() });
    th.unreadOwner = (th.unreadOwner || 0) + 1; th.updated = new Date().toISOString();
    await putThread(env, th);
    if (await pushReady(env)) {
      const p = later(ctx, adminUsers(env).then((admins) => sendToUsers(env, admins.filter((a) => a !== u),
        { title: "Support: " + u, body: preview(t), url: "/beta-admin#support=" + encodeURIComponent(u), tag: "support-" + u }, fetcher)));
      if (p) await p;
    }
    return json({ ok: true, msgs: th.msgs });
  }
  return json({ error: "not found" }, 404);
}

// /auth/admin/support/*  (admin key or admin account)
export function isSupportAdminPath(path) { return path.startsWith("/auth/admin/support/"); }
export async function handleSupportAdmin(request, env, url, keyHash, ctx, fetcher) {
  const who = await isAdmin(request, env, keyHash);
  if (!who) return json({ error: "admin key or admin account required" }, 403);
  if (configProblems(env).length) return json({ error: "support chat is not set up" }, 503);
  const path = url.pathname, KV = env.BETA;
  if (path === "/auth/admin/support/threads") {
    const out = []; let cursor;
    do {
      const pg = await KV.list({ prefix: "sup:thread:", cursor });
      for (const k of pg.keys) {
        const th = await KV.get(k.name, "json");
        if (!th || !th.msgs.length) continue;
        const last = th.msgs[th.msgs.length - 1];
        out.push({ u: th.u, unread: th.unreadOwner || 0, updated: th.updated, count: th.msgs.length, last: { f: last.f, t: preview(last.t), at: last.at } });
      }
      cursor = pg.list_complete ? null : pg.cursor;
    } while (cursor);
    out.sort((a, b) => (b.unread > 0) - (a.unread > 0) || (b.updated || "").localeCompare(a.updated || ""));
    return json({ threads: out, unread: out.reduce((s, t) => s + t.unread, 0) });
  }
  if (path === "/auth/admin/support/thread") {
    const u = normUser(url.searchParams.get("u"));
    const th = await KV.get("sup:thread:" + u, "json");
    if (!th) return json({ error: "no such thread" }, 404);
    if (th.unreadOwner) { th.unreadOwner = 0; await putThread(env, th); }
    return json({ u, msgs: th.msgs });
  }
  if (path === "/auth/admin/support/reply") {
    if (!jsonPost(request)) return json({ error: "use POST JSON" }, 405);
    const b = await body(request), u = normUser(b.u), t = cleanText(b.text);
    if (!t) return json({ error: "Type a reply first." }, 400);
    if (t.length > MAX_LEN) return json({ error: "Replies can be up to " + MAX_LEN + " characters." }, 400);
    const th = await KV.get("sup:thread:" + u, "json");
    if (!th) return json({ error: "no such thread" }, 404);
    th.msgs.push({ f: "o", t, at: new Date().toISOString(), by: who.user || "owner" });
    th.unreadUser = (th.unreadUser || 0) + 1; th.unreadOwner = 0; th.updated = new Date().toISOString();
    await putThread(env, th);
    if (await pushReady(env)) {
      const p = later(ctx, sendToUsers(env, [u], { title: "GlockyPickz replied", body: preview(t), url: "/#support", tag: "support-reply" }, fetcher));
      if (p) await p;
    }
    return json({ ok: true, msgs: th.msgs });
  }
  return json({ error: "not found" }, 404);
}
