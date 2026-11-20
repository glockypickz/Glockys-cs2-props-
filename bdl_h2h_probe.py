"""Diagnostic (changes nothing): does Ball Don't Lie hold full head-to-head history?
For a few pairs it pages through ONE team's whole match history (the team filter means 'either team'), keeps only the
matches against the other team, and prints the count and dates. Known pairs are compared with what bo3.gg gave us
(GamerLegion vs BIG: 7 meetings back to 2022; aimclub vs Nexus: 2). Needs the BALLDONTLIE_KEY secret."""
import os, sys, json, time, datetime, urllib.request, urllib.error, urllib.parse

KEY = os.environ.get("BALLDONTLIE_KEY", "")
BASE = "https://api.balldontlie.io/cs/v1"
PACE = [1.0]
MAX_PAGES = 10          # pages of 100 matches per team
SUM = []
KNOWN = [("GamerLegion", "BIG", 7), ("aimclub", "Nexus", 2)]     # name, name, meetings bo3.gg found


def call(path, params=None):
    q = urllib.parse.urlencode(params or {}, doseq=True)
    req = urllib.request.Request(BASE + path + ("?" + q if q else ""), headers={"Authorization": KEY, "User-Agent": "glockys-prop-grader"})
    for attempt in range(3):
        time.sleep(PACE[0])
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                lim = r.headers.get("X-RateLimit-Limit")
                if lim and not getattr(call, "told", False):
                    call.told = True
                    print("rate limit header: %s per minute" % lim)
                    PACE[0] = 13.0 if int(lim) <= 5 else 60.0 / int(lim) + 0.2
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                print("   429, waiting 65s")
                time.sleep(65)
                continue
            return e.code, {"error": e.read().decode("utf-8", "replace")[:200].replace(KEY, "***")}
        except Exception as ex:
            return 0, {"error": type(ex).__name__ + " " + str(ex)[:120]}
    return 429, None


def find_team(name):
    st, d = call("/teams", {"search": name, "per_page": 25})
    rows = (d or {}).get("data") or []
    print("  search %r -> HTTP %s, %d candidates: %s" % (name, st, len(rows), [(r["id"], r["name"]) for r in rows[:6]]))
    for r in rows:
        if str(r.get("name", "")).lower() == name.lower():
            return r
    return rows[0] if rows else None


def history(team):
    """Every match of one team, newest pages first as returned. -> (matches, pages, complete)"""
    out, cursor, pages = [], None, 0
    while pages < MAX_PAGES:
        p = {"team_ids[]": [team["id"]], "per_page": 100}
        if cursor:
            p["cursor"] = cursor
        st, d = call("/matches", p)
        if st != 200:
            print("  page %d -> HTTP %s %s" % (pages + 1, st, json.dumps(d)[:200]))
            return out, pages, False
        pages += 1
        out += d.get("data") or []
        cursor = (d.get("meta") or {}).get("next_cursor")
        if not cursor:
            return out, pages, True
    return out, pages, False


def both(m, a, b):
    ids = {(m.get("team1") or {}).get("id"), (m.get("team2") or {}).get("id")}
    return ids == {a["id"], b["id"]}


def nm(t):
    return t if isinstance(t, str) else (t.get("name") or "id %s" % t.get("id"))


def test_pair(na, nb, bo3):
    print("\n==== %s vs %s (bo3.gg found %s)" % (nm(na), nm(nb), bo3 if bo3 is not None else "n/a"))
    a, b = find_team(na) if isinstance(na, str) else na, find_team(nb) if isinstance(nb, str) else nb
    if not a or not b:
        SUM.append("%s vs %s: team not found in Ball Don't Lie" % (nm(na), nm(nb)))
        return
    ms, pages, done = history(a)
    dates = sorted(str(m.get("start_time"))[:10] for m in ms if m.get("start_time"))
    meet = sorted(str(m.get("start_time"))[:10] for m in ms if both(m, a, b) and str(m.get("status")) == "finished")
    print("  %s (id %s): %d matches over %d pages%s, from %s to %s" % (nm(a), a["id"], len(ms), pages,
          "" if done else " (stopped at page cap)", dates[0] if dates else "?", dates[-1] if dates else "?"))
    print("  meetings with %s: %d finished -> %s" % (nm(b), len(meet), meet))
    SUM.append("%s vs %s: Ball Don't Lie %d finished meetings %s | bo3.gg %s | history %d matches back to %s%s" % (
        nm(a), nm(b), len(meet), meet[-8:], bo3 if bo3 is not None else "n/a", len(ms), dates[0] if dates else "?", "" if done else " (capped)"))


def main():
    if not KEY:
        sys.exit("BALLDONTLIE_KEY is empty: the secret is missing or named differently")
    for na, nb, bo3 in KNOWN:
        test_pair(na, nb, bo3)
    # two of the next scheduled pairs (ids come straight from the matches list)
    today = datetime.date.today()
    st, d = call("/matches", {"dates[]": [(today + datetime.timedelta(days=k)).isoformat() for k in (0, 1)], "per_page": 100})
    pairs = [m for m in (d or {}).get("data", []) if (m.get("team1") or {}).get("id") and (m.get("team2") or {}).get("id") and m.get("status") == "upcoming"]
    for m in pairs[:2]:
        test_pair(m["team1"], m["team2"], None)
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
