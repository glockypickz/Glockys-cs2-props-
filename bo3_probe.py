"""bo3.gg probe (changes nothing): where does the match page's ANALYTICS INSIGHTS panel come from?
1  the match record from the API (/matches/{slug}): every key whose name looks like insights / analytics / strengths / prediction
2  guessed sub-endpoints and ?with= options: which ones answer, and what they contain
3  the match web page: is the panel text in the HTML, and which API paths do the site's own scripts mention near 'insight' / 'analytics'
Needs no key. About 50 requests, spaced out. Set MATCH_SLUG to probe a different match."""
import os, sys, re, json, time, urllib.request, urllib.error, urllib.parse

API = os.environ.get("BO3_API", "https://api.bo3.gg/api/v1").rstrip("/")
SITE = os.environ.get("BO3_SITE", "https://bo3.gg").rstrip("/")
SLUG = (os.environ.get("MATCH_SLUG") or "ex-rustec-vs-hype-tech-21-11-2026").strip()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
HJ = {"accept": "application/json", "origin": SITE, "referer": SITE + "/", "user-agent": UA}
HH = {"accept": "text/html,application/xhtml+xml", "user-agent": UA}
KEY_RX = re.compile(r"insight|analytic|strength|weak|predict|summary|summar|(^|_)ai(_|$)|win_?prob|pros|cons", re.I)
NOISE = re.compile(r"google|gtag|ga\(|googletag|yandex|metrika|hotjar|segment|amplitude|plausible|umami|sentry", re.I)


def short(o, n=420):
    t = o if isinstance(o, str) else json.dumps(o, ensure_ascii=False, default=str)
    t = re.sub(r"\s+", " ", t)
    return t if len(t) <= n else t[:n] + " ...[cut]"


def get(url, headers, limit=3_000_000):
    time.sleep(0.6)
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            body = r.read(limit)
            return r.status, body.decode("utf-8", "replace"), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(2000).decode("utf-8", "replace"), ""
    except Exception as ex:
        return 0, "%s %s" % (type(ex).__name__, str(ex)[:150]), ""


def jget(path, params=None):
    q = urllib.parse.urlencode(params or {})
    st, body, ct = get(API + path + ("?" + q if q else ""), HJ)
    try:
        return st, json.loads(body)
    except Exception:
        return st, body


def walk(o, path=""):
    """every (path, key, value) whose key name looks like insights / analytics / strengths ..."""
    if isinstance(o, dict):
        for k, v in o.items():
            p = path + "." + str(k) if path else str(k)
            if KEY_RX.search(str(k)):
                yield p, k, v
            yield from walk(v, p)
    elif isinstance(o, list):
        for i, v in enumerate(o[:30]):
            yield from walk(v, "%s[%d]" % (path, i))


def count_keys(obj):
    return len(list(walk(obj))) if isinstance(obj, (dict, list)) else 0


def report_keys(tag, obj):
    if not isinstance(obj, (dict, list)):
        return 0
    hits = list(walk(obj))
    for p, k, v in hits[:25]:
        print("   [%s] %s = %s" % (tag, p, short(v, 300)))
    return len(hits)


def main():
    print("match slug:", SLUG, "| api:", API, "| site:", SITE)

    # ---- 1 the match record
    st, m = jget("/matches/" + urllib.parse.quote(SLUG))
    print("\n=== 1  GET /matches/%s -> HTTP %s" % (SLUG, st))
    mid = None
    base_n = 0
    if isinstance(m, dict):
        print("   top-level keys:", {k: (type(v).__name__ + (":%d" % len(v) if hasattr(v, "__len__") else "")) for k, v in m.items()})
        d = m.get("data") if isinstance(m.get("data"), dict) else m
        mid = d.get("id")
        print("   match id:", mid, "| status:", d.get("status"), "| start:", d.get("start_date"))
        base_n = report_keys("match", m)
        print("   insight-like keys in the match record: %d" % base_n)
    else:
        print("   not JSON:", short(m, 300))

    # ---- 2 guessed endpoints
    names = ["analytics", "insights", "analytics_insights", "ai_insights", "ai_analytics", "ai", "predictions", "prediction",
             "preview", "analysis", "pre_match", "prematch", "head_to_head", "h2h", "teams_stats", "team_stats", "stats"]
    idents = [SLUG] + ([str(mid)] if mid else [])
    print("\n=== 2  guessed sub-endpoints (only answers other than 404 are listed)")
    dead = 0
    for ident in idents:
        for nm in names:
            path = "/matches/%s/%s" % (urllib.parse.quote(ident), nm)
            st2, o = jget(path)
            if st2 in (404, 405):
                dead += 1
                continue
            print("  HTTP %s %s -> %s" % (st2, path, short(o, 360)))
            report_keys(nm, o)
    print("  (%d guesses answered 404/405)" % dead)
    for w in ("insights", "analytics", "ai_insights", "predictions", "analytics_insights"):
        st3, o = jget("/matches/" + urllib.parse.quote(SLUG), {"with": "teams,tournament,games," + w})
        extra = count_keys(o) if st3 == 200 else 0
        print("  with=...,%s -> HTTP %s, insight-like keys: %s (match record without it: %s)" % (w, st3, extra, base_n))
        if st3 == 200 and extra > base_n:
            report_keys("with=" + w, o)

    # ---- 3 the web page and the site's own scripts
    page = "%s/matches/%s" % (SITE, urllib.parse.quote(SLUG))
    st4, html, ct = get(page, HH)
    print("\n=== 3  GET %s -> HTTP %s, %d bytes, %s" % (page, st4, len(html), ct))
    low = html.lower()
    print("   'analytics insights' in the HTML: %s | 'insight' mentions: %d | __NUXT__: %s | __NEXT_DATA__: %s" % (
        "analytics insights" in low, low.count("insight"), "__nuxt__" in low or "window.__nuxt" in low, "__next_data__" in low))
    shown = 0
    for mt in re.finditer(r"(.{0,100})(insight)(.{0,140})", html, re.I | re.S):
        if shown < 6 and not NOISE.search(mt.group(1)[-30:] + mt.group(2) + mt.group(3)[:30]):
            shown += 1
            print("   html: ..." + short(mt.group(0), 260))
    blobs = re.findall(r"<script[^>]*type=\"application/json\"[^>]*>(.*?)</script>", html, re.S | re.I)
    for b in blobs[:4]:
        try:
            o = json.loads(b)
            print("   embedded JSON blob: %d bytes, insight-like keys: %d" % (len(b), report_keys("blob", o)))
        except Exception:
            pass
    srcs = []
    for s in re.findall(r"<script[^>]+src=\"([^\"]+)\"", html, re.I) + re.findall(r"(?:href|src)=\"([^\"]+\.js)\"", html, re.I):
        u = urllib.parse.urljoin(page, s)
        if u not in srcs and ("bo3.gg" in u or u.startswith(SITE)):
            srcs.append(u)
    print("   scripts on the page: %d (reading up to 30)" % len(srcs))
    hits, paths = [], set()
    for u in srcs[:30]:
        st5, js, _ = get(u, HH, 2_500_000)
        if st5 != 200:
            continue
        for mt in re.finditer(r"(.{0,120})(insight|analytics)(.{0,160})", js, re.I | re.S):
            if len(hits) < 14 and not NOISE.search(mt.group(1)[-30:] + mt.group(2) + mt.group(3)[:30]):
                hits.append((u.rsplit("/", 1)[-1], short(mt.group(0), 300)))
        for mt in re.finditer(r"[\"'`](/?(?:api/v1)?/?(?:matches|analytics|insights|predictions|ai)[A-Za-z0-9_/\-\${}.:]*)[\"'`]", js):
            paths.add(mt.group(1))
    print("   script mentions of insights / analytics (noise filtered):")
    for f, c in hits:
        print("     %s: ...%s" % (f, c))
    print("   API-looking paths in the scripts (%d, first 40):" % len(paths), sorted(paths)[:40])
    print("\ndone.")


if __name__ == "__main__":
    main()
