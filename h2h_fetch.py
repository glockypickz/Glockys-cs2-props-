"""Past meetings for today's upcoming matchups -> h2h.json (extra head-to-head maps for the grader).

For each upcoming pair of teams: ONE bo3.gg request returns every finished match where both teams played
(filter matches.team_ids contains A,B, verified by h2h_probe.py). For each meeting that is not already in players.json,
the stats of Map 1 and Map 2 (one request each) give every player's kills / headshots / rounds. Only Maps 1-2 are kept.
A pair is looked up once per REFRESH_DAYS days. h2h.json only grows; the grader uses it for head-to-head only and
never counts a meeting twice. If anything fails the old h2h.json is kept."""
import asyncio, json, datetime, time, aiohttp
import update_data as U

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
    if hasattr(U, "SEM") and U.SEM is None:
        U.SEM = asyncio.Semaphore(2)
    data = load(OUT, {"pairs": {}, "logs": []})
    data.setdefault("pairs", {})
    data.setdefault("logs", [])
    have = {(r["name"], str(r["log"].get("mid")), r["log"].get("n")) for r in data["logs"]}
    mids = known_mids()
    today = datetime.date.today()
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
    data["updated"] = today.isoformat()
    json.dump(data, open(OUT, "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
    print("h2h.json: looked up %d pairs, +%d meetings, +%d player-map rows, %d rows in total" % (looked, new_meet, new_logs, len(data["logs"])))


if __name__ == "__main__":
    asyncio.run(main())
