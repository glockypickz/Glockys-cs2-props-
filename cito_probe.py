"""Diagnostic (changes nothing): what does the Cito CS2 API give on this key (Pro)?
Tests: plan / credit cost per call, head-to-head (record + meetings, how far back), per-player map stats (are
HEADSHOTS in there?), recent finished matches, live list, and name -> team id lookup.
Known pairs are compared with bo3.gg / Ball Don't Lie: GamerLegion vs BIG (7 / 8 meetings, back to 2021), aimclub vs Nexus (2 / 3).
Needs the CITO_API_KEY secret. Never prints the key. About 20-30 calls."""
import os, sys, json, time, urllib.request, urllib.error, urllib.parse

KEY = os.environ.get("CITO_API_KEY", "")
BASE = "https://api.citoapi.com/api/v1"
SUM = []
LAST = {"remaining": None}


def short(o, n=700):
    t = json.dumps(o, ensure_ascii=False, default=str)
    return t if len(t) <= n else t[:n] + " ...[cut]"


def call(path, params=None, label=None):
    """-> (status, body). Prints status and how many credits the call used."""
    q = urllib.parse.urlencode(params or {})
    url = BASE + path + ("?" + q if q else "")
    req = urllib.request.Request(url, headers={"x-api-key": KEY, "Accept": "application/json", "User-Agent": "glockys-prop-grader"})
    for attempt in range(2):
        time.sleep(1.0)
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                h, body, st = r.headers, json.load(r), r.status
        except urllib.error.HTTPError as e:
            h, st = e.headers, e.code
            body = {"error": e.read().decode("utf-8", "replace")[:300].replace(KEY, "***")}
            if st == 429 and attempt == 0 and "ARCHIVE" not in json.dumps(body):
                wait = min(int(h.get("Retry-After") or 20), 70)
                print("   429, waiting %ds" % wait)
                time.sleep(wait)
                continue
        except Exception as ex:
            return 0, {"error": type(ex).__name__ + " " + str(ex)[:120]}
        rem = h.get("X-Cito-Credits-Remaining")
        used = None
        try:
            if rem is not None and LAST["remaining"] is not None:
                used = int(float(LAST["remaining"])) - int(float(rem))
            if rem is not None:
                LAST["remaining"] = rem
        except ValueError:
            pass
        print("\n[%s] GET %s%s -> HTTP %s | credits used by this call: %s | remaining: %s | historical remaining: %s" % (
            label or path, path, ("?" + q) if q else "", st, used if used is not None else "?", rem, h.get("X-RateLimit-Historical-Remaining")))
        SUM.append("%s: HTTP %s, credits %s" % (label or path, st, used if used is not None else "?"))
        return st, body
    return 429, None


def rows(body):
    d = body.get("data") if isinstance(body, dict) else None
    if isinstance(d, list):
        return d
    if isinstance(d, dict):
        for k in ("meetings", "matches", "results", "items", "players", "playerStats", "stats", "maps"):
            if isinstance(d.get(k), list):
                return d[k]
    return []


def keys(o):
    return list(o.keys())[:40] if isinstance(o, dict) else type(o).__name__


def find_id(m):
    for k in ("matchId", "match_id", "id"):
        if isinstance(m, dict) and str(m.get(k, "")).startswith("cs2-match"):
            return m[k]
    return None


def team_id(name):
    st, b = call("/cs2/autocomplete", {"q": name}, "autocomplete " + name)
    hits = [r for r in rows(b) if isinstance(r, dict)]
    teams = [r for r in hits if str(r.get("type")).lower() == "team"] or hits
    print("   candidates:", [(r.get("id"), r.get("name"), r.get("slug")) for r in teams[:6]])
    for r in teams:
        if str(r.get("name", "")).lower() == name.lower():
            return r.get("slug") or r.get("id")
    return (teams[0].get("slug") or teams[0].get("id")) if teams else None


def test_h2h(na, nb, known):
    print("\n==== H2H %s vs %s (known meetings: %s)" % (na, nb, known))
    a, b = team_id(na), team_id(nb)
    if not a or not b:
        SUM.append("%s vs %s: team not found by autocomplete" % (na, nb))
        return None
    st, body = call("/cs2/h2h/%s/%s" % (a, b), None, "h2h %s vs %s" % (na, nb))
    if st != 200:
        print("  ", short(body, 400))
        SUM.append("h2h %s vs %s failed: %s" % (na, nb, short(body, 200)))
        return None
    d = body.get("data")
    print("   data keys:", keys(d))
    print("   sample:", short(d, 900))
    ms = rows(body)
    dates = sorted(str(m.get("startsAt") or m.get("date") or m.get("startedAt") or "")[:10] for m in ms if isinstance(m, dict))
    print("   meetings listed: %d | dates: %s" % (len(ms), dates))
    if ms:
        print("   one meeting keys:", keys(ms[0]))
    SUM.append("h2h %s vs %s: %d meetings %s | bo3.gg/BDL: %s | top keys %s" % (na, nb, len(ms), dates[-8:], known, keys(d)))
    return [m for m in ms if isinstance(m, dict)]


def test_stats(mid, why):
    print("\n==== STATS test: %s (%s)" % (mid, why))
    st, b = call("/cs2/matches/%s/maps" % mid, None, "maps " + mid)
    mp = rows(b)
    print("   maps:", len(mp), "| keys:", keys(mp[0]) if mp else None)
    if mp:
        print("   sample:", short(mp[0], 500))
    st, b = call("/cs2/matches/%s/player-stats" % mid, None, "player-stats " + mid)
    if st != 200:
        print("  ", short(b, 300))
        return
    pl = rows(b)
    print("   player lines:", len(pl), "| keys of one line:", keys(pl[0]) if pl else keys(b.get("data")))
    for r in pl[:3]:
        print("   sample:", short(r, 500))
    hs = [k for k in (pl[0] if pl else {}) if "head" in k.lower() or k.lower() in ("hs", "hsp", "hspct")]
    maps_in = sorted({str(r.get("mapNumber") or r.get("map") or r.get("mapId") or "?") for r in pl if isinstance(r, dict)})
    print("   headshot fields:", hs, "| distinct map markers in lines:", maps_in[:6])
    SUM.append("player-stats %s: %d lines, headshot fields %s, map markers %s" % (mid, len(pl), hs, maps_in[:4]))


def main():
    if not KEY:
        sys.exit("CITO_API_KEY is empty: the secret is missing or named differently")
    print("key present, %d characters" % len(KEY))
    st, b = call("/cs2/matches/upcoming", {"limit": 50}, "upcoming")
    up = rows(b)
    print("   upcoming rows:", len(up), "| keys:", keys(up[0]) if up else None)
    if up:
        print("   sample:", short(up[0], 600))
    fresh = None
    st, b = call("/cs2/matches/recent", {"limit": 20}, "recent")
    rc = rows(b)
    print("   recent rows:", len(rc), "| keys:", keys(rc[0]) if rc else None)
    for m in rc:
        if find_id(m) and str(m.get("status", "")).lower() in ("finished", "final", "completed", "done", "ended"):
            fresh = find_id(m)
            break
    fresh = fresh or (find_id(rc[0]) if rc else None)
    st, b = call("/cs2/live", None, "live list")
    lv = rows(b)
    print("   live matches:", len(lv), "| keys:", keys(lv[0]) if lv else None)
    SUM.append("live list: %d matches" % len(lv))
    m1 = test_h2h("GamerLegion", "BIG", "7 (bo3.gg) / 8 (BDL, back to 2021-11-10)")
    m2 = test_h2h("aimclub", "Nexus", "2 (bo3.gg) / 3 (BDL)")
    if fresh:
        test_stats(fresh, "most recent finished match")
    old = next((find_id(m) for m in (m1 or []) if find_id(m)), None)
    if old:
        test_stats(old, "a meeting from the head-to-head list (is old data readable, and what does it cost?)")
    print("\n===== SUMMARY =====")
    for x in SUM:
        print(" ", x)
    print("done")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("\nprobe stopped early:", type(e).__name__, e)
        print("===== SUMMARY =====")
        for x in SUM:
            print(" ", x)
