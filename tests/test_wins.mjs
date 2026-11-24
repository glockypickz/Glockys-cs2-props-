// Community Wins board: public feed never includes hidden/deleted posts or track-record data.
// Run: node --test tests/test_wins.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as A from "../beta_auth.js";
import {
  handleWins, isWinsPath, storageReady, sameOrigin, ctDate, cleanText,
  sniffImage, stripMetadata, hasJpegExif, publicPost, sortFeed,
  SETUP_MSG, MAX_BYTES, DAILY_LIMIT, CAPTION_MAX
} from "../wins_api.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-admin-key-not-real";
const KEY_HASH = await A.sha256hex(KEY);
const SECRET = "x".repeat(40);
const ORIGIN = "https://site.test";

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, t) {
    const v = this.m.has(k) ? this.m.get(k) : null;
    return v != null && t === "json" ? JSON.parse(v) : v;
  }
  async put(k, v, _o) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix, cursor } = {}) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix || "")).map((name) => ({ name }));
    return { keys, list_complete: true, cursor };
  }
}
class FakeR2 {
  constructor() { this.m = new Map(); }
  async put(k, body, opts) {
    const buf = body instanceof Uint8Array ? body : new Uint8Array(await (body.arrayBuffer ? body.arrayBuffer() : body));
    this.m.set(k, { body: buf, httpMetadata: (opts && opts.httpMetadata) || {} });
  }
  async get(k) {
    const v = this.m.get(k);
    if (!v) return null;
    return { body: v.body, httpMetadata: v.httpMetadata, arrayBuffer: async () => v.body.buffer };
  }
  async delete(k) { this.m.delete(k); }
}

function mkEnv(extra) {
  A._resetGateCache();
  return Object.assign({
    BETA: new FakeKV(),
    WINS: new FakeKV(),
    WINS_R2: new FakeR2(),
    SESSION_SECRET: SECRET,
    PBKDF2_ITERATIONS: "10000"
  }, extra || {});
}

async function signup(env, username, { admin = false } = {}) {
  const invite = admin ? KEY : "WELCOME1";
  if (!admin) await env.BETA.put("invite:WELCOME1", JSON.stringify({ code: "WELCOME1", max: 50, uses: 0, created: new Date().toISOString(), revoked: false, users: [] }));
  const r = await A.handleAuth(new Request(ORIGIN + "/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ username, email: username + "@ex.com", password: "password1", invite })
  }), env, new URL(ORIGIN + "/auth/signup"), KEY_HASH);
  const set = r.headers.get("Set-Cookie") || "";
  const m = /gp_sess=([^;]+)/.exec(set);
  assert.ok(m, "signup sets a session cookie for " + username + " status " + r.status + " " + await r.clone().text());
  return "gp_sess=" + m[1];
}

function req(path, { method = "GET", cookie, body, form, ip = "1.1.1.1", origin = ORIGIN, adminKey, headers } = {}) {
  const h = { "CF-Connecting-IP": ip };
  if (origin) h.Origin = origin;
  if (cookie) h.Cookie = cookie;
  if (adminKey) h["X-Admin-Key"] = adminKey;
  let payload;
  if (form) { payload = form; }
  else if (body !== undefined) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  Object.assign(h, headers || {});
  return new Request(ORIGIN + path, { method, headers: h, body: payload });
}

async function call(env, path, opts) {
  const r = req(path, opts);
  return handleWins(r, env, new URL(r.url), KEY_HASH);
}

// --- tiny image fixtures ---
// 1x1 black PNG (67 bytes), plus a tEXt chunk we'll inject in a test.
const PNG_1X1 = Uint8Array.from(Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C6300000002000100CF000105F06D640000000049454E44AE426082",
  "hex"
));

function pngWithText() {
  // Insert a tEXt chunk (key "Comment", value "secret-gps") before IEND.
  const iend = Buffer.from("0000000049454E44AE426082", "hex");
  const raw = Buffer.from(PNG_1X1);
  const body = Buffer.from("Comment\0secret-gps");
  const type = Buffer.from("tEXt");
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  // CRC over type+body
  const crc = crc32(Buffer.concat([type, body]));
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc >>> 0);
  const text = Buffer.concat([len, type, body, crcBuf]);
  const head = raw.subarray(0, raw.length - iend.length);
  return new Uint8Array(Buffer.concat([head, text, iend]));
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function jpegWithExif() {
  // SOI + APP1 (Exif) + APP0 JFIF + EOI. Enough for our parser; not a displayable image.
  const soi = Buffer.from([0xff, 0xd8]);
  const exifBody = Buffer.from("Exif\0\0SECRETLOC\0");
  const app1 = Buffer.alloc(4 + exifBody.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  app1[2] = ((exifBody.length + 2) >> 8) & 255;
  app1[3] = (exifBody.length + 2) & 255;
  Buffer.from(exifBody).copy(app1, 4);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return new Uint8Array(Buffer.concat([soi, app1, app0, eoi]));
}

function webpWithExif() {
  // RIFF/WEBP with VP8X (EXIF flag set) + a tiny VP8L stub + EXIF chunk.
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 1 << 3; // EXIF present
  const vp8l = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x10]); // dummy
  const exif = Buffer.from("Exif\0\0GPS-SECRET");
  function chunk(name, data) {
    const h = Buffer.alloc(8);
    h.write(name);
    h.writeUInt32LE(data.length, 4);
    const pad = data.length & 1 ? Buffer.from([0]) : Buffer.alloc(0);
    return Buffer.concat([h, data, pad]);
  }
  const payload = Buffer.concat([Buffer.from("WEBP"), chunk("VP8X", vp8x), chunk("VP8L", vp8l), chunk("EXIF", exif)]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF"); riff.writeUInt32LE(payload.length, 4);
  return new Uint8Array(Buffer.concat([riff, payload]));
}

function pngFile(name, bytes) {
  return new File([bytes || PNG_1X1], name || "slip.png", { type: "image/png" });
}

async function submit(env, cookie, { file, caption, picks, payout, origin } = {}) {
  const fd = new FormData();
  fd.append("photo", file || pngFile());
  if (caption != null) fd.append("caption", caption);
  if (picks != null) fd.append("picks", picks);
  if (payout != null) fd.append("payout", payout);
  return call(env, "/wins/submit", { method: "POST", cookie, form: fd, origin: origin === undefined ? ORIGIN : origin });
}

test("paths and setup message never mention secrets or the track record", () => {
  assert.equal(isWinsPath("/wins/feed"), true);
  assert.equal(isWinsPath("/wins/submit"), true);
  assert.equal(isWinsPath("/wins/admin/hide"), true);
  assert.equal(isWinsPath("/wins/img/" + "a".repeat(32)), true);
  assert.equal(isWinsPath("/lines_history.json"), false);
  assert.equal(isWinsPath("/auth/me"), false);
  assert.equal(SETUP_MSG, "The Wins board isn't set up yet.");
  assert.doesNotMatch(SETUP_MSG, /api|key|secret|token|gemini/i);
  const src = readFileSync(join(root, "wins_api.js"), "utf8");
  assert.doesNotMatch(src, /fetch\([^)]*lines_history|ASSETS\.fetch\([^)]*lines_history|import .*lines_history/);
  assert.match(src, /not the grader Track Record/i);
});

test("storageReady requires both WINS KV and WINS_R2", () => {
  assert.equal(storageReady({}), false);
  assert.equal(storageReady({ WINS: { get() {} } }), false);
  assert.equal(storageReady(mkEnv()), true);
});

test("feed without storage still does not 500, and never includes history", async () => {
  const env = mkEnv({ WINS: undefined, WINS_R2: undefined });
  const r = await call(env, "/wins/feed");
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.setup, false);
  assert.deepEqual(j.posts, []);
  assert.equal(JSON.stringify(j).includes("lines_history"), false);
  assert.doesNotMatch(JSON.stringify(j), /hit rate|units|track record/i);
});

test("same-origin is required for POST", () => {
  const good = req("/wins/submit", { method: "POST" });
  assert.equal(sameOrigin(good), true);
  const bad = req("/wins/submit", { method: "POST", origin: "https://evil.test" });
  assert.equal(sameOrigin(bad), false);
});

test("ctDate is a calendar day in America/Chicago", () => {
  // 2026-11-24 03:12 AM CT = 09:12 UTC
  assert.equal(ctDate(Date.parse("2026-11-24T09:12:00Z")), "2026-11-24");
  // 11:30 PM CT on Nov 23 is already Nov 24 UTC
  assert.equal(ctDate(Date.parse("2026-11-24T05:30:00Z")), "2026-11-23");
});

test("cleanText strips tags and control chars and caps length", () => {
  assert.equal(cleanText("<script>alert(1)</script>won big", 80), "alert(1)won big");
  assert.equal(cleanText("hi\x00\x07there", 80), "hithere");
  assert.equal(cleanText("a".repeat(CAPTION_MAX + 20), CAPTION_MAX).length, CAPTION_MAX);
});

test("sniffImage uses magic bytes, not the filename", () => {
  assert.equal(sniffImage(PNG_1X1).type, "image/png");
  assert.equal(sniffImage(jpegWithExif()).type, "image/jpeg");
  assert.equal(sniffImage(webpWithExif()).type, "image/webp");
  assert.equal(sniffImage(Buffer.from("GIF89a....")), null);
  assert.equal(sniffImage(Buffer.from("%PDF-1.4")), null);
});

test("stripMetadata removes JPEG EXIF", () => {
  const raw = jpegWithExif();
  assert.equal(hasJpegExif(raw), true);
  assert.ok(Buffer.from(raw).includes("SECRETLOC"));
  const out = stripMetadata(raw, "image/jpeg");
  assert.equal(sniffImage(out).type, "image/jpeg");
  assert.equal(hasJpegExif(out), false);
  assert.equal(Buffer.from(out).includes("SECRETLOC"), false);
  assert.ok(Buffer.from(out).includes("JFIF"));
});

test("stripMetadata removes PNG tEXt and WebP EXIF", () => {
  const png = pngWithText();
  assert.ok(Buffer.from(png).includes("secret-gps"));
  const pngOut = stripMetadata(png, "image/png");
  assert.equal(sniffImage(pngOut).type, "image/png");
  assert.equal(Buffer.from(pngOut).includes("secret-gps"), false);
  assert.equal(Buffer.from(pngOut).includes("tEXt"), false);

  const webp = webpWithExif();
  assert.ok(Buffer.from(webp).includes("GPS-SECRET"));
  const webpOut = stripMetadata(webp, "image/webp");
  assert.equal(sniffImage(webpOut).type, "image/webp");
  assert.equal(Buffer.from(webpOut).includes("GPS-SECRET"), false);
  assert.equal(Buffer.from(webpOut).includes("EXIF"), false);
});

test("sortFeed pins featured posts first, then newest", () => {
  const rows = sortFeed([
    { id: "a", at: "2026-11-24T10:00:00Z", featured: false },
    { id: "b", at: "2026-11-23T10:00:00Z", featured: true },
    { id: "c", at: "2026-11-24T12:00:00Z", featured: false },
    { id: "d", at: "2026-11-24T11:00:00Z", featured: true }
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["d", "b", "c", "a"]);
});

test("publicPost only exposes safe fields", () => {
  const p = publicPost({
    id: "aa".repeat(16), user: "alex", at: "2026-11-24T10:00:00Z",
    caption: "hit", picks: "donk over 25.5", payout: "$80",
    type: "image/png", featured: true, hidden: true, email: "alex@ex.com",
    secret: "nope"
  });
  assert.deepEqual(Object.keys(p).sort(), ["at", "caption", "featured", "id", "image", "payout", "picks", "user"].sort());
  assert.equal(p.image, "/wins/img/" + p.id);
  assert.equal(p.hidden, undefined);
  assert.equal(p.email, undefined);
  assert.equal(p.secret, undefined);
});

test("signed-in customer can submit a win; feed is newest first and has no losses or track record", async () => {
  const env = mkEnv();
  const ck = await signup(env, "alex");
  const r1 = await submit(env, ck, { caption: "first", picks: "donk Over 25.5", payout: "$40" });
  assert.equal(r1.status, 201, await r1.clone().text());
  const j1 = await r1.json();
  assert.equal(j1.ok, true);
  assert.equal(j1.post.user, "alex");
  assert.equal(j1.post.caption, "first");
  assert.equal(j1.remaining, DAILY_LIMIT - 1);
  // second post is newer
  const r2 = await submit(env, ck, { caption: "second" });
  assert.equal(r2.status, 201);
  const feed = await (await call(env, "/wins/feed", { cookie: ck })).json();
  assert.equal(feed.setup, true);
  assert.equal(feed.posts.length, 2);
  assert.equal(feed.posts[0].caption, "second");
  assert.equal(feed.posts[1].caption, "first");
  const blob = JSON.stringify(feed);
  assert.doesNotMatch(blob, /lines_history|hit rate|units|track record|\"miss\"|\"loss\"/i);
  assert.equal(blob.includes("email"), false);
  assert.ok(env.WINS_R2.m.has("img/" + j1.post.id));
  const img = env.WINS_R2.m.get("img/" + j1.post.id).body;
  assert.equal(sniffImage(img).type, "image/png");
});

test("JPEG upload is stored without EXIF", async () => {
  const env = mkEnv();
  const ck = await signup(env, "jordan");
  const r = await submit(env, ck, { file: new File([jpegWithExif()], "slip.jpg", { type: "image/jpeg" }) });
  assert.equal(r.status, 201, await r.clone().text());
  const id = (await r.json()).post.id;
  const stored = env.WINS_R2.m.get("img/" + id).body;
  assert.equal(hasJpegExif(stored), false);
  assert.equal(Buffer.from(stored).includes("SECRETLOC"), false);
});

test("rejects non-images, bad types, oversize, and cross-origin posts", async () => {
  const env = mkEnv();
  const ck = await signup(env, "sammy");
  const txt = await submit(env, ck, { file: new File([Buffer.from("not an image")], "slip.jpg", { type: "image/jpeg" }) });
  assert.equal(txt.status, 400);
  assert.match((await txt.json()).error, /PNG, JPG, or WebP/i);

  const gif = await submit(env, ck, { file: new File([Buffer.from("GIF89a....")], "slip.gif", { type: "image/gif" }) });
  assert.equal(gif.status, 400);

  const big = new Uint8Array(MAX_BYTES + 1);
  big.set(PNG_1X1, 0); // starts like a PNG but is over the cap
  const huge = await submit(env, ck, { file: new File([big], "big.png", { type: "image/png" }) });
  assert.equal(huge.status, 413);

  const csrf = await submit(env, ck, { origin: "https://evil.test" });
  assert.equal(csrf.status, 403);
});

test("unsigned users cannot post; 5 posts per calendar day in Chicago", async () => {
  const env = mkEnv();
  const anon = await submit(env, null);
  assert.equal(anon.status, 401);

  const ck = await signup(env, "riley");
  for (let i = 0; i < DAILY_LIMIT; i++) {
    const r = await submit(env, ck, { caption: "n" + i });
    assert.equal(r.status, 201, "post " + (i + 1) + " " + await r.clone().text());
  }
  const sixth = await submit(env, ck, { caption: "too many" });
  assert.equal(sixth.status, 429);
  const err = await sixth.json();
  assert.match(err.error, /5 wins per day/i);
  const feed = await (await call(env, "/wins/feed", { cookie: ck })).json();
  assert.equal(feed.posts.length, DAILY_LIMIT);
  assert.equal(feed.remaining, 0);
});

test("signed-out or customer feed never includes hidden posts or hidden images", async () => {
  const env = mkEnv();
  const userCk = await signup(env, "casey");
  const adminCk = await signup(env, "owner", { admin: true });
  const posted = await submit(env, userCk, { caption: "keep me" });
  const posted2 = await submit(env, userCk, { caption: "hide me" });
  const hideId = (await posted2.json()).post.id;
  const hide = await call(env, "/wins/admin/hide", { method: "POST", cookie: adminCk, body: { id: hideId, hidden: true } });
  assert.equal(hide.status, 200, await hide.clone().text());

  const publicFeed = await (await call(env, "/wins/feed", { cookie: userCk })).json();
  assert.equal(publicFeed.posts.length, 1);
  assert.equal(publicFeed.posts[0].caption, "keep me");
  assert.equal(publicFeed.posts.some((p) => p.hidden || p.id === hideId), false);
  assert.equal(JSON.stringify(publicFeed).includes("hide me"), false);

  const img = await call(env, "/wins/img/" + hideId, { cookie: userCk });
  assert.equal(img.status, 404);

  const adminFeed = await (await call(env, "/wins/feed?admin=1", { cookie: adminCk })).json();
  assert.equal(adminFeed.posts.length, 2);
  const hidden = adminFeed.posts.find((p) => p.id === hideId);
  assert.equal(hidden.hidden, true);
  const adminImg = await call(env, "/wins/img/" + hideId, { cookie: adminCk });
  assert.equal(adminImg.status, 200);
});

test("customers cannot moderate; admin can feature, hide, and delete (R2 too)", async () => {
  const env = mkEnv();
  const userCk = await signup(env, "drew");
  const adminCk = await signup(env, "boss", { admin: true });
  const posted = await submit(env, userCk, { caption: "pin me" });
  const id = (await posted.json()).post.id;

  const nope = await call(env, "/wins/admin/feature", { method: "POST", cookie: userCk, body: { id, featured: true } });
  assert.equal(nope.status, 403);

  const feat = await call(env, "/wins/admin/feature", { method: "POST", cookie: adminCk, body: { id, featured: true } });
  assert.equal(feat.status, 200);
  const feed = await (await call(env, "/wins/feed", { cookie: userCk })).json();
  assert.equal(feed.posts[0].featured, true);

  const del = await call(env, "/wins/admin/delete", { method: "POST", cookie: adminCk, body: { id } });
  assert.equal(del.status, 200);
  const after = await (await call(env, "/wins/feed", { cookie: userCk })).json();
  assert.equal(after.posts.length, 0);
  assert.equal(env.WINS_R2.m.has("img/" + id), false);
  assert.equal(await env.WINS.get("post:" + id), null);
});

test("bad image ids do not traverse storage", async () => {
  const env = mkEnv();
  const r = await call(env, "/wins/img/../post:abc");
  assert.equal(r.status, 404);
  const r2 = await call(env, "/wins/img/" + "z".repeat(32));
  assert.equal(r2.status, 404);
});

test("UI copy never sells a hit rate or fetches the track record", () => {
  const ui = readFileSync(join(root, "wins.js"), "utf8");
  assert.doesNotMatch(ui, /fetch\([^)]*lines_history|getJSON\([^)]*lines_history/);
  assert.match(ui, /not the grader track record/i);
  assert.doesNotMatch(ui, /hit rate|\bW-L\b|units won/i);
});
