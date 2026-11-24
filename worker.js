// Glockys Prop Grader: serves the site files, but only hands out lines_history.json (locked picks and results) to the admin.
// The file stores only a fingerprint (SHA-256 hash) of the admin key, so the key itself is never in the public repo.
import { gate, handleAuth, isAdmin } from "./beta_auth.js";
import { handlePush, handlePushAdmin, isPushAdminPath } from "./push.js";
import { handleSupport, handleSupportAdmin, isSupportAdminPath } from "./support_api.js";
import { handleAsk, isAskPath } from "./ask_ai.js";
import { handleSlip, isSlipPath } from "./slip_ai.js";

const KEY_HASH = "07ba3c41d62c5e42aee4040361070343a7454bafdc5ed8490c3b5c1ae2271a4d";

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Live prop tracker: /live/<bo3.gg match id> -> Maps 1-2 status and per-player kills / headshots for maps bo3.gg has
// posted (it publishes a map's player stats only after the map ends). Read-only proxy (bo3.gg sends no CORS header),
// cached 60 s at the edge so many viewers cause at most one bo3.gg call per match per minute.
const BO3 = "https://api.bo3.gg/api/v1";
const BO3_H = { accept: "application/json", origin: "https://bo3.gg", referer: "https://bo3.gg/",
  "user-agent": "Mozilla/5.0 (compatible; GlockysPropGrader/1.0)" };

function liveJson(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200,
    headers: { "content-type": "application/json", "Cache-Control": "public, max-age=60" } });
}

async function live(url, ctx) {
  const id = (url.pathname.match(/^\/live\/(\d{1,9})$/) || [])[1];
  if (!id) return liveJson({ error: "bad match id" }, 400);
  const cache = caches.default, key = new Request("https://live-cache.internal/" + id);
  const hit = await cache.match(key);
  if (hit) return hit;
  const q = new URLSearchParams({ "filter[matches.id][eq]": id, with: "games" });
  const r = await fetch(BO3 + "/matches?" + q.toString(), { headers: BO3_H });
  if (!r.ok) return liveJson({ id: +id, error: "bo3.gg " + r.status }, 502);
  const m = ((await r.json()).results || [])[0];
  if (!m) return liveJson({ id: +id, found: false, maps: [], players: [] });
  const games = (m.games || []).filter((g) => g.number === 1 || g.number === 2).sort((a, b) => a.number - b.number);
  const maps = [], players = [];
  for (const g of games) {
    maps.push({ n: g.number, map: g.map_name || null, status: g.status || null,
      score: [g.winner_clan_score ?? null, g.loser_clan_score ?? null] });
    if (g.status !== "finished" && g.status !== "current") continue;
    const ps = await fetch(BO3 + "/games/" + g.id + "/players_stats", { headers: BO3_H });
    if (!ps.ok) continue;
    for (const p of (await ps.json()) || []) {
      const sp = p.steam_profile || {};
      const name = sp.nickname || (sp.player || {}).nickname;
      if (name) players.push({ n: g.number, name, team: p.clan_name || null, kills: p.kills ?? null, hs: p.headshots ?? null });
    }
  }
  const out = liveJson({ id: +id, at: new Date().toISOString(), status: m.status || null,
    score: [m.team1_score ?? null, m.team2_score ?? null], maps, players });
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Beta login (beta_auth.js). Off / fail-open unless the BETA KV binding + SESSION_SECRET exist and the owner turned the gate on.
    // Push notifications (push.js) and support chat (support_api.js): owner side first, then the shared /auth/* API.
    if (isPushAdminPath(url.pathname)) return handlePushAdmin(request, env, url, KEY_HASH);
    if (isSupportAdminPath(url.pathname)) return handleSupportAdmin(request, env, url, KEY_HASH, ctx);
    if (url.pathname.startsWith("/auth/")) return handleAuth(request, env, url, KEY_HASH);
    if (url.pathname === "/login") return env.ASSETS.fetch(new Request(url.origin + "/beta-login", request));
    if (url.pathname === "/beta-admin.html") return Response.redirect(url.origin + "/beta-admin", 302);
    const blocked = await gate(request, env, url, KEY_HASH);
    if (blocked) return blocked;
    if (url.pathname.startsWith("/push/")) return handlePush(request, env, url, KEY_HASH);
    if (url.pathname.startsWith("/support/")) return handleSupport(request, env, url, KEY_HASH, ctx);
    if (isAskPath(url.pathname)) return handleAsk(request, env, url, KEY_HASH);
    if (isSlipPath(url.pathname)) return handleSlip(request, env, url, KEY_HASH);
    if (url.pathname.startsWith("/live/")) return live(url, ctx);
    if (url.pathname === "/lines_history.json") {
      // Admin only: the admin key header (as before) or a logged-in admin account / admin session cookie.
      const sent = String(request.headers.get("X-Admin-Key") || "").trim();
      const ok = (sent.length > 0 && (await sha256(sent)) === KEY_HASH) || !!(await isAdmin(request, env, KEY_HASH));
      if (!ok) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      const res = await env.ASSETS.fetch(new Request(url.origin + "/lines_history.json"));
      const out = new Response(res.body, res);
      out.headers.set("Cache-Control", "no-store");
      return out;
    }
    return env.ASSETS.fetch(request);
  },
};
