"""bo3.gg probe 3 (changes nothing): get the ANALYTICS INSIGHTS data itself.
Probe 2 showed: the site lists 'insights' and 'ai_predictions' among the extra pieces ('with' options) a match can be asked for, and it has a
WidgetMatchInsights component. This probe
1  asks the match API for those pieces (alone and combined) and prints what comes back, especially anything named insights
2  reads the source of the WidgetMatchInsights component, so we see which fields it shows
About 25 requests. Set MATCH_SLUG to probe a different match."""
import os, sys, re, json, time, urllib.request, urllib.error, urllib.parse

API = os.environ.get("BO3_API", "https://api.bo3.gg/api/v1").rstrip("/")
SITE = os.environ.get("BO3_SITE", "https://bo3.gg").rstrip("/")
SLUG = (os.environ.get("MATCH_SLUG") or "ex-rustec-vs-hype-tech-21-11-2026").strip()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
HJ = {"accept": "application/json", "origin": SITE, "referer": SITE + "/", "user-agent": UA}
HH = {"accept": "*/*", "user-agent": UA, "referer": SITE + "/"}


def short(o, n=420):
    t = o if isinstance(o, str) else json.dumps(o, ensure_ascii=False, default=str)
    t = re.sub(r"\s+", " ", t)
    return t if len(t) <= n else t[:n] + " ...[cut]"


def get(url, headers, limit=3_000_000, delay=0.3):
    time.sleep(delay)
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read(limit).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(1500).decode("utf-8", "replace")
    except Exception as ex:
        return 0, "%s %s" % (type(ex).__name__, str(ex)[:150])


def jget(path, params=None):
    q = urllib.parse.urlencode(params or {}, safe=",[]")
    st, body = get(API + path + ("?" + q if q else ""), HJ)
    try:
        return st, json.loads(body)
    except Exception:
        return st, body


def main():
    print("match slug:", SLUG, "| api:", API, "| site:", SITE)
    st, base = jget("/matches/" + urllib.parse.quote(SLUG))
    b = base if isinstance(base, dict) else {}
    mid = b.get("id")
    print("base match record HTTP %s, id %s, %d keys" % (st, mid, len(b)))

    print("\n=== 1  the match API with extra pieces asked for")
    withs = ["insights", "ai_predictions", "insights,ai_predictions", "teams,tournament,insights", "teams", "teams,tournament", "games", "teams,tournament,games"]
    got_insights = None
    for w in withs:
        st, o = jget("/matches/" + urllib.parse.quote(SLUG), {"with": w})
        if st != 200 or not isinstance(o, dict):
            print("  with=%-28s HTTP %s %s" % (w, st, short(o, 200)))
            continue
        new = [k for k in o if k not in b]
        print("  with=%-28s HTTP 200, %d keys, new keys: %s" % (w, len(o), new))
        for k in new:
            v = o[k]
            print("      new key '%s' (%s): %s" % (k, type(v).__name__, short(v, 2800 if "insight" in k else 600)))
            if "insight" in k and v:
                got_insights = got_insights or v
    for p, par in (("/matches", {"filter[matches.id][eq]": mid, "with": "insights"}), ("/matches", {"filter[matches.slug][eq]": SLUG, "with": "insights,ai_predictions"})):
        st, o = jget(p, par)
        res = o.get("results") if isinstance(o, dict) else None
        print("  list %s %s -> HTTP %s, %s" % (p, par, st, ("%d results, keys of the first: %s" % (len(res), sorted(res[0].keys())[:60])) if res else short(o, 200)))
        if res and isinstance(res[0], dict) and res[0].get("insights"):
            print("      insights: %s" % short(res[0]["insights"], 2800))

    # ---- 2 the component source
    print("\n=== 2  source of the WidgetMatchInsights component")
    page = "%s/matches/%s" % (SITE, urllib.parse.quote(SLUG))
    st, html = get(page, dict(HH, accept="text/html"))
    entry = None
    for s in re.findall(r"(?:src|href)=\"([^\"]+\.js)\"", html):
        u = urllib.parse.urljoin(page, s)
        if not u.startswith(SITE):
            continue
        st, js = get(u, HH, delay=0.15)
        if st == 200 and "WidgetMatchInsights" in js:
            entry = (u, js)
            break
    if not entry:
        print("  the script that registers WidgetMatchInsights was not found on the page")
        return
    u, js = entry
    mt = re.search(r"\[\"WidgetMatchInsights\",([A-Za-z0-9_$]+)\]", js)
    var = mt.group(1) if mt else None
    print("  registered in %s as variable %s" % (u.rsplit("/", 1)[-1], var))
    chunk = None
    if var:
        m2 = re.search(re.escape(var) + r"\s*=\s*\(\)\s*=>\s*[A-Za-z0-9_$]+\(\(\)\s*=>\s*import\(\"\./([A-Za-z0-9_\-]+\.js)\"\)", js)
        if not m2:
            m2 = re.search(r"\b" + re.escape(var) + r"=[^;]{0,80}?import\(\"\./([A-Za-z0-9_\-]+\.js)\"\)", js)
        chunk = m2.group(1) if m2 else None
    print("  component file:", chunk)
    if chunk:
        st, src = get(urllib.parse.urljoin(u, "./" + chunk), HH)
        src = re.sub(r"\s+", " ", src)
        print("  HTTP %s, %d bytes. Source:" % (st, len(src)))
        print("  " + src[:5000])
        deps = sorted(set(re.findall(r"\"\./([A-Za-z0-9_\-]+\.js)\"", src)))
        print("  it imports:", deps[:20])
    print("\ndone.")


if __name__ == "__main__":
    main()
