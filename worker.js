// Glockys Prop Grader: serves the site files, but only hands out lines_history.json (locked picks and results) to the admin.
// TEMPORARY DEBUG: /lines_history.json?debug=1 reports what the Worker sees (lengths and yes/no only, never the key itself).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/lines_history.json") {
      const secret = String(env.ADMIN_KEY || "").trim();
      const sent = String(request.headers.get("X-Admin-Key") || "").trim();
      const ok = secret.length > 0 && sent === secret;
      if (url.searchParams.get("debug") === "1") {
        let assetStatus = "n/a";
        try { assetStatus = (await env.ASSETS.fetch(new Request(url.origin + "/lines_history.json"))).status; } catch (e) { assetStatus = "error " + e; }
        return new Response(JSON.stringify({
          workerRan: true, secretSet: secret.length > 0, secretLength: secret.length,
          keyHeaderPresent: sent.length > 0, keyLength: sent.length, match: ok, fileInAssetsStatus: assetStatus,
        }, null, 1), { headers: { "content-type": "application/json", "Cache-Control": "no-store" } });
      }
      if (!ok) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      const res = await env.ASSETS.fetch(new Request(url.origin + "/lines_history.json"));
      const out = new Response(res.body, res);
      out.headers.set("Cache-Control", "no-store");
      return out;
    }
    return env.ASSETS.fetch(request);
  },
};
