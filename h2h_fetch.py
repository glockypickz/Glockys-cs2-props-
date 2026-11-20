"""Past meetings for upcoming matchups -> h2h.json (extra head-to-head maps for the grader). Cito first (head-to-head route, exact
headshot counts, all maps in one stats call), bo3.gg second (older meetings Cito does not hold). The grader counts a meeting once.

For each upcoming pair of teams: ONE bo3.gg request returns every finished match where both teams played
(filter matches.team_ids contains A,B, verified by h2h_probe.py). For each meeting that is not already in players.json,
the stats of Map 1 and Map 2 (one request each) give every player's kills / headshots / rounds. Only Maps 1-2 are kept.
A pair is looked up once per REFRESH_DAYS days. h2h.json only grows; the grader uses it for head-to-head only and
never counts a meeting twice. If anything fails the old h2h.json is kept."""
import asyncio, json, datetime, time
import cito_api
try:
    import aiohttp
    import update_data as U
except Exception as _e:          # bo3.gg part unavailable: the Cito part still runs
    aiohttp = U = None
    print("bo3.gg part unavailable:", _e)

OUT = "h2h.json"
REFRESH_DAYS = 14
TIME_LIMIT = 40 * 60
MAX_PAIRS = 80          # per run
MAX_MEETINGS = 12       # newest meetings kept per pair (older ones add little)


def load(p, d):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return d


def known_mids():
    """Every match id already in players.json logs (those meetings need no extra requests)."""
    try:
        from grader import load_players
        d = load_players("players.json")
    except Exception as e:
        print("players.json not read, no meetings skipped:", e)
        d = {}
    return {str(l.get("mid")) for p in d.get("players", []) for l in (p.get("logs") or [])}


# ---------------------------------------------------------------- Cito (main source)
CITO_MAX_PAIRS = 60      # pairs per run (about 4 credits for the h2h call + ~4 per new meeting)


def _day(d):
    return datetime.date.fromisoformat(str(d)[:10])


def known_keys():
    """(date, team, opponent) of every map already in players.json, so meetings we already hold cost no Cito calls."""
    out = set()
    try:
        from grader import load_players, canon
        for p in load_players("players.json").get("players", []):
            t = canon(p.get("team") or "")
            for l in p.get("logs") or []:
                if l.get("date"):
                    out.add((str(l["date"])[:10], t, canon(l.get("opp") or "")))
    except Exception as e:
        print("known meetings not read:", e)
    return out


def _held(known, canon, date, a, b):
    d = _day(date)
    for k in (-1, 0, 1):
        ds = (d + datetime.timedelta(days=k)).isoformat()
        if (ds, canon(a), canon(b)) in known or (ds, canon(b), canon(a)) in known:
            return True
    return False


def cito_logs(mid, date):
    """Player-map rows (Maps 1-2) of one Cito match: kills, exact headshots, deaths, assists, ADR, rounds."""
    m = (cito_api.get("/cs2/matches/%s" % mid).get("data") or {})
    t1, t2 = m.get("team1Id"), m.get("team2Id")
    n1, n2 = m.get("team1Name"), m.get("team2Name")
    maps = {}
    for r in cito_api.rows(cito_api.get("/cs2/matches/%s/maps" % mid), "maps"):
        if r.get("mapNumber") in (1, 2) and str(r.get("status")).lower() in ("completed", "finished", "done") \
                and r.get("team1Score") is not None and r.get("team2Score") is not None:
            maps[r["mapNumber"]] = r
    out = []
    if not maps:
        return out
    for r in cito_api.rows(cito_api.get("/cs2/matches/%s/player-stats" % mid), "playerStats", "players", "stats"):
        try:
            n = int(str(r.get("mapId")).rsplit("-map-", 1)[1])
        except Exception:
            continue
        mp = maps.get(n)
        if not mp or not r.get("playerName") or r.get("kills") is None or r.get("headshots") is None:
            continue
        mine = r.get("teamId")
        if mine not in (t1, t2):
            continue
        s1, s2 = mp["team1Score"], mp["team2Score"]
        out.append({"name": r["playerName"], "team": r.get("teamName") or (n1 if mine == t1 else n2), "src": "cito",
                    "log": {"date": date, "mid": "c" + str(mid).rsplit("-", 1)[-1], "n": n, "map": mp.get("mapName"),
                            "opp": n2 if mine == t1 else n1, "kills": r["kills"], "hs": r["headshots"], "d": r.get("deaths"),
                            "a": r.get("assists"), "adr": r.get("adr"), "rd": s1 + s2, "rw": s1 if mine == t1 else s2}})
    return out


def run_cito(data, today):
    if not cito_api.have_key():
        print("cito: no CITO_API_KEY, skipped")
        return 0, 0, 0
    from grader import canon
    known = known_keys()
    for r in data["logs"]:      # meetings already saved in h2h.json (from bo3.gg earlier) need no Cito calls either
        l = r["log"]
        if l.get("date"):
            known.add((str(l["date"])[:10], canon(r.get("team") or ""), canon(l.get("opp") or "")))
    have = {(r["name"], str(r["log"].get("mid")), r["log"].get("n")) for r in data["logs"]}
    looked = new_meet = new_logs = 0
    try:
        up = cito_api.rows(cito_api.get("/cs2/matches/upcoming", {"limit": 100}))
    except Exception as e:
        print("cito upcoming failed:", e)
        return 0, 0, 0
    pairs = {}
    for m in up:
        a, b = m.get("team1Id"), m.get("team2Id")
        if a and b:
            pairs[tuple(sorted([a, b]))] = (a, b, m.get("team1Name"), m.get("team2Name"))
    print("cito upcoming pairs:", len(pairs))
    for key, (a, b, na, nb) in pairs.items():
        pk = "cito:%s|%s" % key
        last = data["pairs"].get(pk)
        if last and (today - datetime.date.fromisoformat(last)).days < REFRESH_DAYS:
            continue
        if looked >= CITO_MAX_PAIRS:
            print("cito: pair limit reached, the rest next run")
            break
        looked += 1
        try:
            ms = cito_api.rows(cito_api.get("/cs2/h2h/%s/%s" % (a, b)), "matches", "meetings")
            for m in ms[:MAX_MEETINGS]:
                mid, date = m.get("matchId"), str(m.get("startsAt") or "")[:10]
                if not mid or not date or str(m.get("status", "")).lower() in ("upcoming", "live", "scheduled", "in_progress", "current"):
                    continue
                if m.get("teamScore") is None or m.get("isForfeit"):
                    continue
                if _held(known, canon, date, na, nb):
                    continue
                rows = [r for r in cito_logs(mid, date) if (r["name"], str(r["log"]["mid"]), r["log"]["n"]) not in have]
                for r in rows:
                    data["logs"].append(r)
                    have.add((r["name"], str(r["log"]["mid"]), r["log"]["n"]))
                if rows:
                    new_meet += 1
                    new_logs += len(rows)
            data["pairs"][pk] = today.isoformat()
        except Exception as e:
            print("cito pair %s vs %s failed: %s" % (na, nb, e))
    return looked, new_meet, new_logs


async def pairs_today(s):
    d = await U.get(s, "/matches", {
        "scope": "widget-matches", "page[offset]": 0, "page[limit]": 100, "sort": "start_date",
        "filter[matches.status][in]": "upcoming,current", "filter[matches.discipline_id][eq]": 1, "with": "teams"})
    out = {}
    for m in d.get("results", []):
        a, b = m.get("team1") or {}, m.get("team2") or {}
        if a.get("id") and b.get("id"):
            out[tuple(sorted([a["id"], b["id"]]))] = (a, b)
    return out


async def main():
    data = load(OUT, {"pairs": {}, "logs": []})
    data.setdefault("pairs", {})
    data.setdefault("logs", [])
    today = datetime.date.today()
    c_pairs = c_meet = c_logs = 0
    try:
        c_pairs, c_meet, c_logs = run_cito(data, today)
    except Exception as e:
        print("cito part failed (bo3.gg part still runs):", type(e).__name__, e)
    print("cito: looked up %d pairs, +%d meetings, +%d player-map rows (%d calls)" % (c_pairs, c_meet, c_logs, cito_api.STATS["calls"]))
    if U is not None:
        try:
            await run_bo3(data, today)
        except Exception as e:
            print("bo3.gg part failed:", type(e).__name__, e)
    data["updated"] = today.isoformat()
    json.dump(data, open(OUT, "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
    print("h2h.json: %d rows in total" % len(data["logs"]))


async def run_bo3(data, today):
    if hasattr(U, "SEM") and U.SEM is None:
        U.SEM = asyncio.Semaphore(2)
    have = {(r["name"], str(r["log"].get("mid")), r["log"].get("n")) for r in data["logs"]}
    mids = known_mids()
    started = time.time()
    new_logs = new_meet = looked = 0
    async with aiohttp.ClientSession(headers=U.H) as s:
        pairs = await pairs_today(s)
        print("upcoming pairs:", len(pairs))
        for key, (a, b) in pairs.items():
            pk = "%s-%s" % key
            last = data["pairs"].get(pk)
            if last and (today - datetime.date.fromisoformat(last)).days < REFRESH_DAYS:
                continue
            if looked >= MAX_PAIRS or time.time() - started > TIME_LIMIT:
                print("limit reached, the rest next run")
                break
            looked += 1
            try:
                r = await U.get(s, "/matches", {
                    "scope": "widget-matches", "page[offset]": 0, "page[limit]": 100, "sort": "-start_date",
                    "filter[matches.status][in]": "finished", "filter[matches.discipline_id][eq]": 1,
                    "filter[matches.team_ids][contains]": "%s,%s" % key, "with": "teams,tournament,games"})
                for m in (r.get("results") or [])[:MAX_MEETINGS]:
                    t1, t2 = m.get("team1") or {}, m.get("team2") or {}
                    if {t1.get("id"), t2.get("id")} != set(key) or str(m["id"]) in mids:
                        continue
                    date = m["start_date"][:10]
                    got = 0
                    for g in m.get("games", []):
                        if g.get("state") != "done" or g.get("number") not in (1, 2):
                            continue
                        stats = await U.get(s, "/games/%s/players_stats" % g["id"])
                        for p in stats or []:
                            nick = (p.get("steam_profile") or {}).get("nickname")
                            tid = (p.get("team_clan") or {}).get("team_id")
                            team = t1 if tid == t1.get("id") else t2 if tid == t2.get("id") else None
                            if not nick or team is None or p.get("kills") is None or p.get("headshots") is None:
                                continue
                            if (nick, str(m["id"]), g.get("number")) in have:
                                continue
                            data["logs"].append({"name": nick, "team": team.get("name"), "log": U.mk_log(date, m, g, p, None)})
                            have.add((nick, str(m["id"]), g.get("number")))
                            new_logs += 1
                            got += 1
                    if got:
                        new_meet += 1
                data["pairs"][pk] = today.isoformat()      # only marked done when the whole pair worked
            except Exception as e:
                print("pair %s vs %s failed: %s" % (a.get("name"), b.get("name"), e))
    print("bo3.gg: looked up %d pairs, +%d meetings, +%d player-map rows" % (looked, new_meet, new_logs))


if __name__ == "__main__":
    asyncio.run(main())
