"""Second Cito diagnostic (changes nothing): the questions that decide how far Cito can be the MAIN source.
1 rate limit headers   2 stats of an OLD meeting (2024): readable? what does it cost?   3 a team's results history: how
many matches back, how paged, cost   4 how many of the props on the board (lines.json) Cito finds by team name
5 how many Cito player names match players.json   6 the six matches the old odds feed lacked: are they in Cito, with odds?
Needs CITO_API_KEY. Never prints the key. About 30 calls."""
import os, sys, json, time, urllib.request, urllib.error, urllib.parse, datetime

KEY = os.environ.get("CITO_API_KEY", "")
BASE = "https://api.citoapi.com/api/v1"
SUM = []
LAST = {"rem": None, "hist": None, "headers": False}


def short(o, n=600):
    t = json.dumps(o, ensure_ascii=False, default=str)
    return t if len(t) <= n else t[:n] + " ...[cut]"


def call(path, params=None, label=None):
    q = urllib.parse.urlencode(params or {})
    url = BASE + path + ("?" + q if q else "")
    req = urllib.request.Request(url, headers={"x-api-key": KEY, "Accept": "application/json", "User-Agent": "glockys-prop-grader"})
    time.sleep(0.8)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            h, body, st = r.headers, json.load(r), r.status
    except urllib.error.HTTPError as e:
        h, st = e.headers, e.code
        body = {"error": e.read().decode("utf-8", "replace")[:300].replace(KEY, "***")}
    except Exception as ex:
        return 0, {"error": type(ex).__name__ + " " + str(ex)[:120]}
    if not LAST["headers"]:
        LAST["headers"] = True
        print("response headers about limits / credits:", {k: v for k, v in h.items() if k.lower().startswith(("x-ratelimit", "x-cito", "retry", "ratelimit"))})
    used = hist = None
    try:
        rem, hr = h.get("X-Cito-Credits-Remaining"), h.get("X-RateLimit-Historical-Remaining")
        if rem is not None and LAST["rem"] is not None:
            used = int(float(LAST["rem"])) - int(float(rem))
        if hr is not None and LAST["hist"] is not None:
            hist = int(float(LAST["hist"])) - int(float(hr))
        LAST["rem"], LAST["hist"] = rem or LAST["rem"], hr or LAST["hist"]
    except ValueError:
        pass
    print("\n[%s] GET %s%s -> HTTP %s | credits used: %s | deep-history credits used: %s | credits left: %s" % (
        label or path, path, ("?" + q) if q else "", st, used, hist, LAST["rem"]))
    SUM.append("%s: HTTP %s, credits %s, deep-history %s" % (label or path, st, used, hist))
    return st, body


def rows(body):
    d = body.get("data") if isinstance(body, dict) else None
    if isinstance(d, list):
        return d
    if isinstance(d, dict):
        for k in ("meetings", "matches", "results", "items", "players", "playerStats", "stats", "maps"):
            if isinstance(d.get(k), list):
                return d[k]
    return []


def try_grader():
    try:
        sys.path.insert(0, ".")
        import grader
        return grader
    except Exception as e:
        print("grader not importable:", e)
        return None


def main():
    if not KEY:
        sys.exit("CITO_API_KEY is empty: the secret is missing or named differently")
    G = try_grader()
    teq = (lambda a, b: G.teq(a, b)) if G else (lambda a, b: str(a).lower() == str(b).lower())

    # 2. OLD meeting stats
    st, b = call("/cs2/h2h/gamerlegion/big", None, "h2h GamerLegion vs BIG")
    ms = rows(b)
    ms = sorted([m for m in ms if isinstance(m, dict)], key=lambda m: str(m.get("startsAt")))
    if ms:
        old = ms[0]
        print("   oldest listed meeting:", old.get("matchId"), str(old.get("startsAt"))[:10], "| maps listed in the h2h row:", len(old.get("maps") or []))
        print("   one h2h map row:", short((old.get("maps") or [None])[0], 400))
        st, b = call("/cs2/matches/%s/player-stats" % old["matchId"], None, "player-stats of the %s meeting" % str(old.get("startsAt"))[:10])
        pl = rows(b)
        print("   lines:", len(pl), "|", short(b if st != 200 else (pl[0] if pl else b), 400))
        SUM.append("OLD meeting %s (%s): HTTP %s, %d player lines, headshots present: %s" % (
            old.get("matchId"), str(old.get("startsAt"))[:10], st, len(pl), bool(pl and pl[0].get("headshots") is not None)))

    # 3. team results history
    for params in ({"limit": 100}, {"limit": 100, "page": 2}):
        st, b = call("/cs2/teams/gamerlegion/results", params, "GamerLegion results %s" % params)
        rs = rows(b)
        dates = sorted(str(m.get("startsAt"))[:10] for m in rs if isinstance(m, dict))
        meta = b.get("meta") if isinstance(b, dict) else None
        print("   rows:", len(rs), "| dates %s .. %s" % (dates[0] if dates else "?", dates[-1] if dates else "?"), "| meta:", short(meta, 300))
        if rs:
            print("   one row keys:", list(rs[0].keys())[:30])
        SUM.append("GamerLegion results %s: %d rows %s .. %s, meta %s" % (params, len(rs), dates[0] if dates else "?", dates[-1] if dates else "?", short(meta, 150)))

    # 4. board coverage
    board = []
    try:
        now = datetime.datetime.now(datetime.timezone.utc)
        for l in json.load(open("lines.json", encoding="utf-8")).get("lines", []):
            t0 = datetime.datetime.fromisoformat(str(l.get("starts_at")).replace("Z", "+00:00"))
            if 0 < (t0 - now).total_seconds() < 72 * 3600 and l.get("team") and l.get("opponent"):
                board.append((l["team"], l["opponent"]))
    except Exception as e:
        print("lines.json not read:", e)
    pairs = sorted(set(tuple(sorted(p)) for p in board))
    st, b = call("/cs2/matches/upcoming", {"limit": 100}, "upcoming limit 100")
    up = rows(b)
    print("   upcoming rows:", len(up), "| meta:", short(b.get("meta"), 200))
    with_odds = sum(1 for m in up if any(o.get("market") == "h2h" for o in (m.get("odds") or [])))
    SUM.append("upcoming: %d matches, %d with match-winner odds" % (len(up), with_odds))
    found, miss = [], []
    for a, c in pairs:
        hit = next((m for m in up if (teq(m.get("team1Name"), a) and teq(m.get("team2Name"), c)) or (teq(m.get("team1Name"), c) and teq(m.get("team2Name"), a))), None)
        (found if hit else miss).append((a, c, hit))
    print("   board matches in the next 72h: %d | found in Cito upcoming: %d | not found: %d" % (len(pairs), len(found), len(miss)))
    print("   not found:", [(a, c) for a, c, _ in miss][:25])
    SUM.append("board matches (72h): %d, found in Cito upcoming %d, missing %d: %s" % (len(pairs), len(found), len(miss), [(a, c) for a, c, _ in miss][:12]))
    for a, c, _ in miss[:6]:
        for nm in (a, c):
            st, bb = call("/cs2/autocomplete", {"q": nm}, "autocomplete " + nm)
            print("   candidates:", [(r.get("name"), r.get("slug")) for r in rows(bb)[:4]])

    # 6. the six matches the old odds feed lacked
    want = ["kuusamo", "walczaki", "forze", "baks", "nexus gaming", "envy", "metizport", "sinners", "copenhagen", "xi esport"]
    hits = [m for m in up if any(w in (str(m.get("team1Name")) + " " + str(m.get("team2Name"))).lower() for w in want)]
    for m in hits:
        mk = [o.get("market") for o in (m.get("odds") or [])][:4]
        print("   %s vs %s | %s | odds markets: %s" % (m.get("team1Name"), m.get("team2Name"), str(m.get("startsAt"))[:16], mk))
    SUM.append("matches the old odds feed lacked, present in Cito: %s" % [(m.get("team1Name"), m.get("team2Name"), bool(m.get("odds"))) for m in hits][:10])

    # 5. player-name match against players.json
    if G:
        try:
            d = G.load_players("players.json")
            known = {G.canon(p["name"]) for p in d.get("players", [])}
            st, b = call("/cs2/matches/recent", {"limit": 20}, "recent")
            ids = [m["id"] for m in rows(b) if m.get("status") == "finished"][:3]
            tot = hit = 0
            miss_names = []
            for mid in ids:
                st, bb = call("/cs2/matches/%s/player-stats" % mid, None, "player-stats " + mid)
                for r in rows(bb):
                    if r.get("mapId", "").endswith("map-1"):
                        tot += 1
                        if G.canon(r.get("playerName") or "") in known:
                            hit += 1
                        else:
                            miss_names.append(r.get("playerName"))
            print("   Cito players on Map 1 of %d recent matches: %d, found in players.json: %d, not found: %s" % (len(ids), tot, hit, miss_names[:15]))
            SUM.append("player names: %d of %d Cito players found in players.json; missing e.g. %s" % (hit, tot, miss_names[:8]))
        except Exception as e:
            print("player-name check skipped:", type(e).__name__, e)

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
