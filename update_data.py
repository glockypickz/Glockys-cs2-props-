"""Fetch recent per-map CS2 player stats for every active ranked team from bo3.gg -> players.json."""
import asyncio, json, datetime, aiohttp

B = "https://api.bo3.gg/api/v1"
H = {"accept": "application/json", "origin": "https://bo3.gg", "referer": "https://bo3.gg/",
     "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"}

MAX_TEAMS = 150          # ranked teams to consider
MATCHES_PER_TEAM = 10
ACTIVE_DAYS = 120        # skip teams with no match in this many days
DELAY = 0.3

async def get(s, path, params=None):
    for attempt in range(5):
        async with s.get(B + path, params=params) as r:
            if r.status == 429:
                await asyncio.sleep(3 * (attempt + 1))
                continue
            r.raise_for_status()
            data = await r.json()
            await asyncio.sleep(DELAY)
            return data
    raise Exception("rate limited: " + path)

async def ranked_teams(s):
    out, offset = [], 0
    while len(out) < MAX_TEAMS:
        d = await get(s, "/teams", {"page[offset]": offset, "page[limit]": 50,
                                    "filter[teams.rank][gt]": 0, "sort": "rank"})
        res = d.get("results", [])
        if not res:
            break
        out += res
        offset += len(res)
        if offset >= d.get("total", {}).get("count", 0):
            break
    return out[:MAX_TEAMS]

async def do_team(s, t, cutoff, out):
    tid, tname = t["id"], t.get("name", t["slug"])
    ms = (await get(s, "/matches", {
        "scope": "widget-matches", "page[offset]": 0, "page[limit]": MATCHES_PER_TEAM,
        "sort": "-start_date", "filter[matches.status][in]": "finished",
        "filter[matches.team_ids][overlap]": tid,
        "filter[matches.discipline_id][eq]": 1, "with": "teams,tournament,games"}))["results"]
    if not ms or ms[0]["start_date"][:10] < cutoff:
        print("inactive:", tname)
        return
    rows = []
    for m in ms:
        date = m["start_date"][:10]
        for g in m.get("games", []):
            if g.get("state") != "done":
                continue
            stats = await get(s, f"/games/{g['id']}/players_stats")
            for p in stats:
                if p["team_clan"]["team_id"] != tid:
                    continue
                rows.append({"mid": m["id"], "name": p["steam_profile"]["nickname"],
                             "log": {"date": date, "mid": m["id"], "n": g.get("number"),
                                     "map": (g.get("map_name") or "").replace("de_", "").capitalize(),
                                     "opp": p.get("enemy_clan_name", ""),
                                     "kills": p["kills"], "hs": p["headshots"]}})
    if not rows:
        print("no data:", tname)
        return
    roster = {r["name"] for r in rows if r["mid"] == rows[0]["mid"]}
    for r in rows:
        if r["name"] in roster:
            e = out.setdefault(f"{tname}|{r['name']}", {"name": r["name"], "team": tname, "logs": []})
            e["logs"].append(r["log"])
    print("done:", tname, sorted(roster))

async def upcoming(s):
    """Scheduled / running matches -> games.json entries (no scores, no odds)."""
    games = []
    try:
        d = await get(s, "/matches", {
            "scope": "widget-matches", "page[offset]": 0, "page[limit]": 100,
            "sort": "start_date", "filter[matches.status][in]": "upcoming,current",
            "filter[matches.discipline_id][eq]": 1, "with": "teams,tournament,games"})
        for m in d.get("results", []):
            t1, t2 = m.get("team1") or {}, m.get("team2") or {}
            if not t1.get("name") or not t2.get("name") or not m.get("start_date"):
                continue
            start = m["start_date"]
            if not start.endswith("Z") and "+" not in start[10:]:
                start += "Z"
            games.append({"id": m["id"], "start": start, "team1": t1["name"], "team2": t2["name"],
                          "tournament": (m.get("tournament") or {}).get("name", ""),
                          "bo": m.get("bo_type")})
    except Exception as e:
        print("schedule fetch failed:", e)
    return games

async def main():
    out = {}
    cutoff = (datetime.date.today() - datetime.timedelta(days=ACTIVE_DAYS)).isoformat()
    async with aiohttp.ClientSession(headers=H) as s:
        teams = await ranked_teams(s)
        ranks = {t.get("name", t["slug"]): t["rank"] for t in teams if t.get("rank")}
        games = await upcoming(s)
        print(len(teams), "ranked teams")
        for t in teams:
            try:
                await do_team(s, t, cutoff, out)
            except Exception as e:
                print("skip", t.get("slug"), e)
    if len(out) < 20:
        raise SystemExit(f"Only {len(out)} players fetched, keeping the old players.json")
    today = datetime.date.today().isoformat()
    if games:
        json.dump({"updated": today, "games": games}, open("games.json", "w"),
                  separators=(",", ":"), ensure_ascii=False)
        print("wrote games.json:", len(games), "games")
    data = {"updated": today, "ranks": ranks, "players": list(out.values())}
    json.dump(data, open("players.json", "w"), separators=(",", ":"), ensure_ascii=False)
    print("wrote players.json:", len(out), "players")

if __name__ == "__main__":
    asyncio.run(main())
