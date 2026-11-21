"""bo3.gg probe 2 (changes nothing): find the exact source of the ANALYTICS INSIGHTS panel.
Probe 1 showed: the match record has no insights field, the page HTML has no panel text (it is drawn in the browser),
the site has an /analytics/:slug page and its code mentions ai_predictions.
1  read the script chunks the site loads (following its dynamic imports) and print where 'ai_predictions', 'strengths' / 'weaknesses'
   and 'insights' appear, plus the API paths written in the same chunks
2  try likely API paths built from the match id, and print every one that answers
About 300 small requests. Set MATCH_SLUG to probe a different match."""
import os, sys, re, json, time, urllib.request, urllib.error, urllib.parse

API = os.environ.get("BO3_API", "https://api.bo3.gg/api/v1").rstrip("/")
SITE = os.environ.get("BO3_SITE", "https://bo3.gg").rstrip("/")
SLUG = (os.environ.get("MATCH_SLUG") or "ex-rustec-vs-hype-tech-21-11-2026").strip()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
HJ = {"accept": "application/json", "origin": SITE, "referer": SITE + "/", "user-agent": UA}
HH = {"accept": "*/*", "user-agent": UA, "referer": SITE + "/"}
NOISE = re.compile(r"google|gtag|cloudflare|yandex|metrika|hotjar|sentry|amplitude|plausible", re.I)
KEYWORDS = re.compile(r"predict|insight|analytic|(^|[/_])ai[_/]|strength|weak|summar|preview", re.I)
MAX_CHUNKS = int(os.environ.get("MAX_CHUNKS", "400"))


def short(o, n=420):
    t = o if isinstance(o, str) else json.dumps(o, ensure_ascii=False, default=str)
    t = re.sub(r"\s+", " ", t)
    return t if len(t) <= n else t[:n] + " ...[cut]"


def get(url, headers, limit=3_000_000, delay=0.15):
    time.sleep(delay)
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read(limit).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(1500).decode("utf-8", "replace")
    except Exception as ex:
        return 0, "%s %s" % (type(ex).__name__, str(ex)[:150])


def jget(path):
    st, body = get(API + path, HJ, delay=0.5)
    try:
        return st, json.loads(body)
    except Exception:
        return st, body


def ctx(text, rx, width=220, cap=5):
    """up to `cap` contexts around a regex, skipping analytics-vendor noise near the match"""
    out = []
    for mt in re.finditer(rx, text):
        a, b = max(0, mt.start() - width), min(len(text), mt.end() + width)
        if NOISE.search(text[max(0, mt.start() - 40):mt.end() + 40]):
            continue
        out.append(re.sub(r"\s+", " ", text[a:b]))
        if len(out) >= cap:
            break
    return out


def main():
    print("match slug:", SLUG, "| api:", API, "| site:", SITE)
    st, m = jget("/matches/" + urllib.parse.quote(SLUG))
    d = m if isinstance(m, dict) else {}
    mid, t1, t2 = d.get("id"), d.get("team1_id"), d.get("team2_id")
    print("match record HTTP %s: id %s, team ids %s / %s, tournament id %s" % (st, mid, t1, t2, d.get("tournament_id")))

    # ---- 1 crawl the site's own script chunks
    page = "%s/matches/%s" % (SITE, urllib.parse.quote(SLUG))
    st, html = get(page, dict(HH, accept="text/html"))
    entry = []
    for s in re.findall(r"(?:src|href)=\"([^\"]+\.js)\"", html):
        u = urllib.parse.urljoin(page, s)
        if u.startswith(SITE) and u not in entry:
            entry.append(u)
    print("\n=== 1  page HTTP %s, %d script files on the page; crawling their dynamic imports (max %d chunks)" % (st, len(entry), MAX_CHUNKS))
    seen, queue, bodies = set(entry), list(entry), {}
    chunk_rx = re.compile(r"[\"'](?:\./|/?_nuxt/)?([A-Za-z0-9_\-]{6,14}\.js)[\"']")
    while queue and len(bodies) < MAX_CHUNKS:
        u = queue.pop(0)
        stc, js = get(u, HH)
        if stc != 200:
            continue
        bodies[u] = js
        for name in set(chunk_rx.findall(js)):
            nu = urllib.parse.urljoin(u, "./" + name)
            if nu not in seen:
                seen.add(nu)
                queue.append(nu)
    print("   read %d script files, %.1f MB in total" % (len(bodies), sum(len(v) for v in bodies.values()) / 1e6))

    terms = [("ai_predictions", r"ai_predictions|aiPredictions"), ("strengths / weaknesses", r"strengths|weaknesses"), ("insights", r"[Ii]nsights|analytics_insights")]
    hot = set()
    for label, rx in terms:
        n = 0
        print("\n--- '%s' in the site's code" % label)
        for u, js in bodies.items():
            hits = ctx(js, rx, 230, 3)
            if hits:
                hot.add(u)
                for h in hits:
                    if n < 8:
                        n += 1
                        print("   %s: ...%s..." % (u.rsplit("/", 1)[-1], h))
        if n == 0:
            print("   no hits")
    for u in bodies:
        if u.endswith("DhyZUSU1.js"):
            hot.add(u)
    lit_rx = re.compile(r"[`\"'](/[A-Za-z0-9_\-/${}.:?=\[\]&,]{2,140})[`\"']")
    print("\n--- API-looking paths written in the chunks that mention those words (and the /analytics page chunk)")
    for u in sorted(hot)[:12]:
        lits = []
        for l in lit_rx.findall(bodies[u]):
            if l not in lits and (KEYWORDS.search(l) or "/matches" in l or l.startswith("/games")):
                lits.append(l)
        print("   %s (%d KB): %s" % (u.rsplit("/", 1)[-1], len(bodies[u]) // 1024, lits[:30]))
    allp = []
    for js in bodies.values():
        for l in lit_rx.findall(js):
            if KEYWORDS.search(l) and l not in allp:
                allp.append(l)
    print("\n--- every path-like string in all chunks that looks like predictions / insights / analytics (%d):" % len(allp), sorted(allp)[:70])

    # ---- 2 guessed endpoints
    print("\n=== 2  guessed API paths (answers other than 404 are listed)")
    q = "filter[%s.match_id][eq]=" + str(mid)
    paths = ["/ai_predictions?" + q % "ai_predictions", "/ai_predictions?filter[match_id][eq]=%s" % mid, "/ai_predictions/%s" % mid, "/ai_predictions/%s" % SLUG,
             "/ai_predictions?limit=1", "/analytics/%s" % SLUG, "/analytics/%s" % mid, "/analytics?" + q % "analytics", "/analytics?limit=1",
             "/analytics/matches/%s" % SLUG, "/analytics/matches/%s" % mid, "/matches/%s/analytics" % mid, "/matches/%s/ai_predictions" % mid,
             "/matches/%s/ai_predictions" % SLUG, "/predictions?" + q % "predictions", "/predictions?limit=1", "/matches/%s/insights" % mid,
             "/matches/%s/ai_insights" % mid, "/insights/%s" % SLUG, "/ai_insights/%s" % mid, "/ai_insights?" + q % "ai_insights",
             "/matches/%s/preview" % mid, "/match_analytics/%s" % mid, "/matches_analytics/%s" % mid, "/matches/%s/team_analytics" % mid,
             "/teams/%s/analytics" % t1, "/teams/%s/insights" % t1]
    dead = 0
    for p in paths:
        s2, o = jget(p)
        if s2 in (404, 405):
            dead += 1
            continue
        print("  HTTP %s %s -> %s" % (s2, p, short(o, 700)))
    print("  (%d guesses answered 404/405)" % dead)
    print("\ndone.")


if __name__ == "__main__":
    main()
