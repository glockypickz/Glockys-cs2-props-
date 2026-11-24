// Community Wins board (Cloudflare Worker only). Clients post their own slip
// screenshots. This is not the grader Track Record and never reads lines_history.json.
// Storage: KV binding WINS (post JSON + daily quotas) and R2 binding WINS_R2 (images).
import { identify, isAdmin } from "./beta_auth.js";

export const MAX_BYTES = 5 * 1024 * 1024;
export const DAILY_LIMIT = 5;
export const CAPTION_MAX = 280;
export const PICKS_MAX = 400;
export const PAYOUT_MAX = 40;
export const SETUP_MSG = "The Wins board isn't set up yet.";
export const TZ = "America/Chicago";

const ID_RE = /^[a-f0-9]{32}$/;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json", "Cache-Control": "no-store" }
  });
}

export function isWinsPath(path) {
  return path === "/wins/feed" || path === "/wins/submit" || path === "/wins/setup"
    || path.startsWith("/wins/img/") || path.startsWith("/wins/admin/");
}

export function storageReady(env) {
  return !!(env && env.WINS && typeof env.WINS.get === "function"
    && env.WINS_R2 && typeof env.WINS_R2.get === "function");
}

export function sameOrigin(request) {
  const origin = new URL(request.url).origin;
  const o = request.headers.get("Origin");
  if (o) return o === origin;
  const ref = request.headers.get("Referer");
  if (!ref) return false;
  try { return new URL(ref).origin === origin; } catch (e) { return false; }
}

export function ctDate(nowMs, tz) {
  const d = nowMs == null ? new Date() : new Date(nowMs);
  if (isNaN(d)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || TZ, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}

export function cleanText(t, max) {
  let s = String(t == null ? "" : t)
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

export function sniffImage(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u.length >= 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff)
    return { type: "image/jpeg", ext: "jpg" };
  if (u.length >= 8 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47
    && u[4] === 0x0d && u[5] === 0x0a && u[6] === 0x1a && u[7] === 0x0a)
    return { type: "image/png", ext: "png" };
  if (u.length >= 12 && u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46
    && u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50)
    return { type: "image/webp", ext: "webp" };
  return null;
}

function readU32BE(u, i) {
  return ((u[i] << 24) >>> 0) + (u[i + 1] << 16) + (u[i + 2] << 8) + u[i + 3];
}
function readU32LE(u, i) {
  return (u[i] | (u[i + 1] << 8) | (u[i + 2] << 16) | (u[i + 3] << 24)) >>> 0;
}

export function stripJpeg(input) {
  const u = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u.length < 4 || u[0] !== 0xff || u[1] !== 0xd8) throw new Error("not jpeg");
  const out = [0xff, 0xd8];
  let i = 2;
  while (i < u.length) {
    if (u[i] !== 0xff) {
      for (let j = i; j < u.length; j++) out.push(u[j]);
      break;
    }
    while (i < u.length && u[i] === 0xff) i++;
    if (i >= u.length) break;
    const marker = u[i++];
    if (marker === 0xd9) { out.push(0xff, 0xd9); break; }
    if (marker === 0xda) {
      out.push(0xff, 0xda);
      for (let j = i; j < u.length; j++) out.push(u[j]);
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(0xff, marker);
      continue;
    }
    if (i + 1 >= u.length) break;
    const len = (u[i] << 8) | u[i + 1];
    const next = i + len;
    if (next > u.length) break;
    // Strip EXIF/XMP (APP1), most other APPn metadata, and COM. Keep JFIF (APP0), ICC (APP2), Adobe (APP14).
    const strip = marker === 0xe1 || marker === 0xfe || (marker >= 0xe3 && marker <= 0xed) || marker === 0xef;
    if (!strip) {
      out.push(0xff, marker);
      for (let j = i; j < next; j++) out.push(u[j]);
    }
    i = next;
  }
  return new Uint8Array(out);
}

export function stripPng(input) {
  const u = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u.length < 8 || u[0] !== 0x89 || u[1] !== 0x50) throw new Error("not png");
  const drop = { eXIf: 1, tEXt: 1, zTXt: 1, iTXt: 1, tIME: 1, dSIG: 1 };
  const parts = [u.slice(0, 8)];
  let i = 8;
  while (i + 12 <= u.length) {
    const len = readU32BE(u, i);
    const type = String.fromCharCode(u[i + 4], u[i + 5], u[i + 6], u[i + 7]);
    const end = i + 12 + len;
    if (end > u.length) break;
    if (!drop[type]) parts.push(u.slice(i, end));
    i = end;
    if (type === "IEND") break;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function stripWebp(input) {
  const u = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u.length < 12) throw new Error("not webp");
  const chunks = [];
  let i = 12;
  while (i + 8 <= u.length) {
    const fourcc = String.fromCharCode(u[i], u[i + 1], u[i + 2], u[i + 3]);
    const size = readU32LE(u, i + 4);
    const dataStart = i + 8;
    const dataEnd = dataStart + size;
    const padded = dataEnd + (size & 1);
    if (dataEnd > u.length) break;
    chunks.push({ fourcc, data: u.slice(dataStart, dataEnd) });
    i = padded;
  }
  const kept = chunks.filter((c) => c.fourcc !== "EXIF" && c.fourcc !== "XMP " && c.fourcc !== "XMP");
  for (const c of kept) {
    if (c.fourcc === "VP8X" && c.data.length >= 1) {
      const d = new Uint8Array(c.data);
      d[0] = d[0] & ~(1 << 3) & ~(1 << 4);
      c.data = d;
    }
  }
  let payload = 4;
  for (const c of kept) payload += 8 + c.data.length + (c.data.length & 1);
  const out = new Uint8Array(8 + payload);
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46;
  out[4] = payload & 255; out[5] = (payload >> 8) & 255;
  out[6] = (payload >> 16) & 255; out[7] = (payload >> 24) & 255;
  out[8] = 0x57; out[9] = 0x45; out[10] = 0x42; out[11] = 0x50;
  let o = 12;
  for (const c of kept) {
    for (let k = 0; k < 4; k++) out[o++] = c.fourcc.charCodeAt(k) || 32;
    const n = c.data.length;
    out[o++] = n & 255; out[o++] = (n >> 8) & 255;
    out[o++] = (n >> 16) & 255; out[o++] = (n >> 24) & 255;
    out.set(c.data, o); o += n;
    if (n & 1) out[o++] = 0;
  }
  return out;
}

export function stripMetadata(buf, type) {
  if (type === "image/jpeg") return stripJpeg(buf);
  if (type === "image/png") return stripPng(buf);
  if (type === "image/webp") return stripWebp(buf);
  throw new Error("unsupported");
}

export function hasJpegExif(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let i = 2;
  while (i + 4 < u.length && u[i] === 0xff) {
    while (i < u.length && u[i] === 0xff) i++;
    if (i >= u.length) break;
    const marker = u[i++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 1 >= u.length) break;
    const len = (u[i] << 8) | u[i + 1];
    if (marker === 0xe1) return true;
    i += len;
  }
  return false;
}

function newId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function metaOf(p) {
  return { id: p.id, at: p.at, featured: !!p.featured, hidden: !!p.hidden };
}

export function publicPost(p) {
  if (!p) return null;
  return {
    id: p.id,
    user: p.user,
    at: p.at,
    caption: p.caption || "",
    picks: p.picks || "",
    payout: p.payout || "",
    featured: !!p.featured,
    image: "/wins/img/" + p.id
  };
}

export function sortFeed(index) {
  return (index || []).slice().sort((a, b) => {
    const fa = a.featured ? 0 : 1, fb = b.featured ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const ta = a.at || "", tb = b.at || "";
    if (ta !== tb) return ta < tb ? 1 : -1;
    return String(a.id) < String(b.id) ? 1 : -1;
  });
}

async function loadIndex(env) {
  const idx = await env.WINS.get("index", "json");
  if (Array.isArray(idx)) return idx;
  const posts = [];
  let cursor;
  do {
    const pg = await env.WINS.list({ prefix: "post:", cursor });
    for (const k of pg.keys) {
      const p = await env.WINS.get(k.name, "json");
      if (p && p.id) posts.push(metaOf(p));
    }
    cursor = pg.list_complete ? null : pg.cursor;
  } while (cursor);
  await env.WINS.put("index", JSON.stringify(posts));
  return posts;
}

async function saveIndex(env, index) {
  await env.WINS.put("index", JSON.stringify(index));
}

async function quotaUsed(env, user, day) {
  const n = parseInt((await env.WINS.get("quota:" + user + ":" + day)) || "0", 10);
  return n || 0;
}

async function quotaBump(env, user, day) {
  const used = await quotaUsed(env, user, day);
  await env.WINS.put("quota:" + user + ":" + day, String(used + 1), { expirationTtl: 172800 });
  return used + 1;
}

export async function handleWins(request, env, url, keyHash) {
  const path = url.pathname, method = request.method;
  if (!isWinsPath(path)) return json({ error: "not found" }, 404);

  if (!storageReady(env)) {
    if (path === "/wins/setup" || path === "/wins/feed") return json({ setup: false, error: SETUP_MSG, posts: [] }, 200);
    return json({ error: SETUP_MSG, setup: false }, 503);
  }

  const who = await identify(request, env, keyHash);

  if (path === "/wins/setup" && method === "GET") {
    return json({ setup: true, user: who && who.user ? who.user : null, admin: !!(who && who.admin), dailyLimit: DAILY_LIMIT });
  }

  if (path === "/wins/feed" && method === "GET") {
    const adminView = !!(who && who.admin && url.searchParams.get("admin") === "1");
    const index = sortFeed(await loadIndex(env));
    const posts = [];
    for (const m of index) {
      if (m.hidden && !adminView) continue;
      const p = await env.WINS.get("post:" + m.id, "json");
      if (!p) continue;
      if (p.hidden && !adminView) continue;
      const row = publicPost(p);
      if (adminView) row.hidden = !!p.hidden;
      posts.push(row);
    }
    const day = ctDate(Date.now());
    const used = who && who.user ? await quotaUsed(env, who.user, day) : 0;
    return json({
      setup: true,
      posts,
      me: { user: who && who.user ? who.user : null, admin: !!(who && who.admin) },
      dailyLimit: DAILY_LIMIT,
      remaining: who && who.user ? Math.max(0, DAILY_LIMIT - used) : 0
    });
  }

  const img = path.match(/^\/wins\/img\/([a-f0-9]{32})$/);
  if (img && method === "GET") {
    const p = await env.WINS.get("post:" + img[1], "json");
    if (!p) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    if (p.hidden && !(who && who.admin)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    const obj = await env.WINS_R2.get("img/" + img[1]);
    if (!obj) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    const type = (obj.httpMetadata && obj.httpMetadata.contentType) || p.type || "application/octet-stream";
    const headers = { "content-type": type, "Cache-Control": p.hidden ? "no-store" : "private, max-age=3600", "X-Content-Type-Options": "nosniff" };
    return new Response(obj.body, { status: 200, headers });
  }

  if (path.startsWith("/wins/img/")) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

  if (!sameOrigin(request)) return json({ error: "bad origin" }, 403);

  if (path === "/wins/submit" && method === "POST") {
    if (!who || !who.user) return json({ error: "Sign in to post a win." }, 401);
    const cl = parseInt(request.headers.get("content-length") || "0", 10) || 0;
    if (cl > MAX_BYTES + 65536) return json({ error: "That photo is too large. Screenshots can be up to 5 MB." }, 413);
    let form;
    try { form = await request.formData(); } catch (e) { return json({ error: "Could not read the upload." }, 400); }
    const file = form.get("photo") || form.get("file") || form.get("image");
    if (!file || typeof file.arrayBuffer !== "function") return json({ error: "Add a slip screenshot (PNG, JPG, or WebP)." }, 400);
    if (file.size > MAX_BYTES) return json({ error: "That photo is too large. Screenshots can be up to 5 MB." }, 413);
    const raw = new Uint8Array(await file.arrayBuffer());
    if (raw.byteLength > MAX_BYTES) return json({ error: "That photo is too large. Screenshots can be up to 5 MB." }, 413);
    const kind = sniffImage(raw);
    if (!kind) return json({ error: "That file doesn't look like a PNG, JPG, or WebP screenshot." }, 400);
    let cleaned;
    try { cleaned = stripMetadata(raw, kind.type); }
    catch (e) { return json({ error: "Could not read that image. Try another screenshot." }, 400); }
    const day = ctDate(Date.now());
    const used = await quotaUsed(env, who.user, day);
    if (used >= DAILY_LIMIT) return json({ error: "You can post 5 wins per day. Try again tomorrow." }, 429);
    const id = newId();
    const post = {
      id,
      user: who.user,
      at: new Date().toISOString(),
      caption: cleanText(form.get("caption"), CAPTION_MAX),
      picks: cleanText(form.get("picks"), PICKS_MAX),
      payout: cleanText(form.get("payout"), PAYOUT_MAX),
      type: kind.type,
      featured: false,
      hidden: false
    };
    await env.WINS_R2.put("img/" + id, cleaned, { httpMetadata: { contentType: kind.type } });
    await env.WINS.put("post:" + id, JSON.stringify(post));
    const index = await loadIndex(env);
    if (!index.some((m) => m.id === id)) index.push(metaOf(post));
    await saveIndex(env, index);
    await quotaBump(env, who.user, day);
    return json({ ok: true, post: publicPost(post), remaining: Math.max(0, DAILY_LIMIT - used - 1) }, 201);
  }

  if (path.startsWith("/wins/admin/")) {
    const admin = await isAdmin(request, env, keyHash);
    if (!admin) return json({ error: "admin key or admin account required" }, 403);
    if (method !== "POST") return json({ error: "use POST JSON" }, 405);
    if (!(request.headers.get("Content-Type") || "").includes("application/json")) return json({ error: "use POST JSON" }, 405);
    let b = {};
    try { b = (await request.json()) || {}; } catch (e) { b = {}; }
    const id = String(b.id || "").trim();
    if (!ID_RE.test(id)) return json({ error: "bad id" }, 400);
    const p = await env.WINS.get("post:" + id, "json");
    if (!p) return json({ error: "post not found" }, 404);

    if (path === "/wins/admin/hide") {
      p.hidden = b.hidden === false ? false : true;
      await env.WINS.put("post:" + id, JSON.stringify(p));
      const index = await loadIndex(env);
      index.forEach((m) => { if (m.id === id) m.hidden = p.hidden; });
      await saveIndex(env, index);
      return json({ ok: true, id, hidden: p.hidden });
    }
    if (path === "/wins/admin/feature") {
      p.featured = b.featured === false ? false : true;
      await env.WINS.put("post:" + id, JSON.stringify(p));
      const index = await loadIndex(env);
      index.forEach((m) => { if (m.id === id) m.featured = p.featured; });
      await saveIndex(env, index);
      return json({ ok: true, id, featured: p.featured });
    }
    if (path === "/wins/admin/delete") {
      await env.WINS.delete("post:" + id);
      try { await env.WINS_R2.delete("img/" + id); } catch (e) {}
      const index = (await loadIndex(env)).filter((m) => m.id !== id);
      await saveIndex(env, index);
      return json({ ok: true, id, deleted: true });
    }
    return json({ error: "not found" }, 404);
  }

  return json({ error: "not found" }, 404);
}

export const _test = {
  SETUP_MSG, MAX_BYTES, DAILY_LIMIT, newId, metaOf, hasJpegExif
};
