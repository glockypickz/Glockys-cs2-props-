"""Fourth Cito diagnostic (changes nothing): does Cito carry MAP VETO data - what each team bans / picks, and in what order?
That decides whether we can simulate the veto (which maps land in Maps 1-2) the way Scout does.
1 /cs2/matches/upcoming: any veto / ban / pick fields on an upcoming match?
2 /cs2/teams/{team}/map-stats for 4 teams: every field of a map row, and any ban / pick / first-pick / decider / win-rate fields
3 /cs2/teams/{team}/results -> 3 finished matches -> /cs2/matches/{id} and /maps: any veto sequence (who banned / picked what, in order)
4 a few guessed veto endpoints (HTTP status only)
Needs CITO_API_KEY (never printed). About 25 calls."""
import os, sys, json, re, time, urllib.request, urllib.error, urllib.parse

KEY = os.environ.get("CITO_API_KEY", "")
BASE = os.environ.get("CITO_BASE", "https://api.citoapi.com/api/v1")
LAST = {"rem": None}
RX = re.compile(r"veto|\bban|banned|pick|decider|first_?pick|second_?pick|remaining|left_?over|order|sequence|side_?choice|win_?rate|winpct|win_?percent", re.I)
FOUND = []


def call(path, params=None, quiet=False):
    q = urllib.parse.urlencode(params or {})
    url = BASE + path + ("?" + q if q else "")
    req = urllib.request.Request(url, headers={"x-api-key": KEY, "Accept": "application/json", "User-Agent": "glockys-prop-grader"})
    time.sleep(0.8)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            LAST["rem"] = r.headers.get("X-Cito-Credits-Remaining") or LAST["rem"]
            body, st = json.load(r), r.status
    except urllib.error.HTTPError as e:
        body, st = {"error": e.read().decode("utf-8", "replace")[:200].replace(KEY, "***")}, e.code
    except Exception as ex:
        body, st = {"error": type(ex).__name__ + " " + str(ex)[:120]}, 0
    if not quiet:
        print("\n[GET %s%s] -> HTTP %s | credits remaining %s" % (path, ("?" + q) if q else "", st, LAST["rem"]))
    return st, body


def short(o, n=600):
    t = json.dumps(o, ensure_ascii=False, default=str)
    return t if len(t) <= n else t[:n] + " ...[cut]"


def data(b):
    return b.get("data") if isinstance(b, dict) and "data" in b else b


def rows(b):
    d = data(b)
    if isinstance(d, list):
        return d
    if isinstance(d, dict):
        for k in ("matches", "results", "items", "maps", "mapStats", "stats", "vetoes", "veto"):
            if isinstance(d.get(k), list):
                return d[k]
    return []


def walk(o, path=""):
    if isinstance(o, dict):
        for k, v in o.items():
            p = path + "." + str(k) if path else str(k)
            yield p, k, v
            yield from walk(v, p)
    elif isinstance(o, list):
        for i, v in enumerate(o[:40]):
            yield from walk(v, path + "[%d]" % i)


def scan(o, where):
    """print every key whose name looks like veto / ban / pick / order / win rate, with its value"""
    n = 0
    for p, k, v in walk(o):
        if RX.search(str(k)):
            n += 1
            if n <= 25:
                print("     %s = %s" % (p, short(v, 160)))
            FOUND.append("%s: %s" % (where, re.sub(r"\[\d+\]", "[]", p)))
    if not n:
        print("     (no veto / ban / pick / order / win-rate field names)")
    return n


def team_ref(name):
    st, b = call("/cs2/autocomplete", {"q": name}, True)
    hits = [r for r in rows(b) if isinstance(r, dict)]
    teams = [r for r in hits if str(r.get("type")).lower() == "team"] or hits
    for r in teams:
        if str(r.get("name", "")).lower() == name.lower():
            return r.get("slug") or r.get("id"), r.get("id")
    return ((teams[0].get("slug") or teams[0].get("id")), teams[0].get("id")) if teams else (None, None)


def main():
    if not KEY:
        sys.exit("CITO_API_KEY is empty: the secret is missing or named differently")
    print("key present, %d characters" % len(KEY))

    print("\n=== 1  upcoming matches")
    st, b = call("/cs2/matches/upcoming", {"limit": 20})
    up = [r for r in rows(b) if isinstance(r, dict)]
    print("   rows:", len(up), "| keys of one:", list(up[0].keys())[:40] if up else None)
    if up:
        print("   sample:", short(up[0], 700))
        scan(up[0], "upcoming match")

    print("\n=== 2  team map stats (/cs2/teams/{team}/map-stats)")
    teams = []
    for name in ("Vitality", "MOUZ", "Natus Vincere", "FaZe Clan"):
        slug, tid = team_ref(name)
        print("   %s -> slug %s, id %s" % (name, slug, tid))
        if slug:
            teams.append((name, slug, tid))
    for name, slug, tid in teams[:3]:
        for ref in dict.fromkeys([slug, tid]):
            if not ref:
                continue
            st, b = call("/cs2/teams/%s/map-stats" % ref)
            if st != 200:
                print("   ", short(b, 200))
                continue
            d = data(b) or {}
            print("   data keys:", list(d.keys())[:30] if isinstance(d, dict) else type(d).__name__)
            mp = d.get("maps") if isinstance(d, dict) else None
            if isinstance(mp, list) and mp:
                print("   map-row keys:", list(mp[0].keys()))
                print("   one full row:", short(mp[0], 900))
                scan(d, "team map-stats (%s)" % name)
            break

    print("\n=== 3  finished matches: is there a veto sequence?")
    mids = []
    if teams:
        st, b = call("/cs2/teams/%s/results" % teams[0][1], {"limit": 5})
        for m in rows(b):
            if isinstance(m, dict):
                for k in ("matchId", "match_id", "id"):
                    if str(m.get(k, "")).startswith("cs2-match"):
                        mids.append(m[k])
                        break
        print("   match ids found:", mids[:5])
    for mid in mids[:3]:
        st, b = call("/cs2/matches/%s" % mid)
        if st == 200:
            d = data(b)
            print("   match keys:", list(d.keys())[:45] if isinstance(d, dict) else type(d).__name__)
            scan(d, "match detail")
        st, b = call("/cs2/matches/%s/maps" % mid)
        if st == 200:
            mp = rows(b)
            print("   maps rows: %d | keys of one: %s" % (len(mp), list(mp[0].keys())[:40] if mp and isinstance(mp[0], dict) else None))
            if mp:
                print("   sample:", short(mp[0], 600))
                scan(mp, "match maps")

    print("\n=== 4  guessed veto endpoints (status only)")
    if mids:
        for tail in ("veto", "vetoes", "map-veto", "picks-bans", "bans"):
            st, b = call("/cs2/matches/%s/%s" % (mids[0], tail), None, True)
            print("   /cs2/matches/{id}/%s -> HTTP %s %s" % (tail, st, short(b, 160) if st == 200 else ""))
            if st == 200:
                FOUND.append("endpoint /cs2/matches/{id}/%s works" % tail)

    print("\n=== SUMMARY")
    uniq = list(dict.fromkeys(FOUND))
    print("fields / endpoints that look like veto, ban, pick, order or win rate:")
    for u in uniq[:40]:
        print("  -", u)
    if not uniq:
        print("  none found: Cito does not appear to carry veto data in what was probed")
    print("credits remaining at the end:", LAST["rem"])


if __name__ == "__main__":
    main()
