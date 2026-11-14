// Glockys Prop Grader: serves the site files, but only hands out lines_history.json (locked picks and results) to the admin.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/lines_history.json") {
      const key = request.headers.get("X-Admin-Key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      out.headers.set("Cache-Control", "no-store");
      return out;
    }
    return env.ASSETS.fetch(request);
  },
};
