// Glockys Prop Grader: serves the site files, but only hands out lines_history.json (locked picks and results) to the admin.
// The file stores only a fingerprint (SHA-256 hash) of the admin key, so the key itself is never in the public repo.
const KEY_HASH = "1d2187ea34c9f5b14b63ef338c7534a280956244736f086d6c82708706fe5c49";

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/lines_history.json") {
      const sent = String(request.headers.get("X-Admin-Key") || "").trim();
      const ok = sent.length > 0 && (await sha256(sent)) === KEY_HASH;
      if (!ok) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      const res = await env.ASSETS.fetch(new Request(url.origin + "/lines_history.json"));
      const out = new Response(res.body, res);
      out.headers.set("Cache-Control", "no-store");
      return out;
    }
    return env.ASSETS.fetch(request);
  },
};
