"""Fetch recent per-map CS2 player stats from bo3.gg and write players.json."""
import asyncio, json, datetime, aiohttp

B = "https://api.bo3.gg/api/v1"
H = {"accept": "application/json", "origin": "https://bo3.gg", "referer": "https://bo3.gg/",
     "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"}

TEAM_SLUGS = []        # e.g. ["vitality", "falcons-esports"]; empty = auto-pick top teams
MAX_TEAMS = 20
MATCHES_PER_TEAM = 10
DELAY = 0.4

async def get(s, path, params=None):
    for attempt in range(4):
        async with s.get(B + path, params=params) as r:
            if r.status == 429:
                await asyncio.sleep(3 * (attempt + 1))
                continue
            r.raise_for_status()
            data = await r.json()
            await asyncio.sleep(DELAY)
            return data
    raise Exception("rate limited: " + path)

async def discover(s):
    d = await get(s, "/matches", {
        "scope": "widget-matches", "page[offset]": 0, "page[limit]": 100,
        "sort": "tier_rank,-start_date",
        "filter[matches.status][in]": "finished",
        "filter[matches.discipline_id][eq]": 1,
        "with": "teams,tournament,games"})
    out = []
    for m in d["results"]:
        for t in (m.get("team1"), m.get("team2")):
            if t and t["slug"] not in out:
                out.append(t["slug"])
    return out[:MAX_TEAMS]

async def main():
    out = {}
    async with aiohttp.ClientSession(headers=H) as s:
        slugs = TEAM_SLUGS or await discover(s)
        print(len(slugs), "teams:", slugs)
        for slug in slugs:
            try:
                team = await get(s, f"/teams/{slug}", {"prefer_locale": "en"})
                tid, tname = team["id"], team.get("name", slug)
                ms = (await get(s, "/matches", {
                    "scope": "widget-matches", "page[offset]": 0,
                    "page[limit]": MATCHES_PER_TEAM, "sort": "-start_date",
                    "filter[matches.status][in]": "finished",
                    "filter[matches.team_ids][overlap]": tid,
                    "filter[matches.discipline_id][eq]": 1,
                    "with": "teams,tournament,games"}))["results"]
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
                                         "log": {"date": date,
                                                 "map": g["map_name"].replace("de_", "").capitalize(),
                                                 "opp": p.get("enemy_clan_name", ""),
                                                 "kills": p["kills"], "hs": p["headshots"]}})
                if not rows:
                    print("  no data:", tname)
                    continue
                roster = {r["name"] for r in rows if r["mid"] == rows[0]["mid"]}
                for r in rows:
                    if r["name"] in roster:
                        e = out.setdefault(f"{tname}|{r['name']}",
                                           {"name": r["name"], "team": tname, "logs": []})
                        e["logs"].append(r["log"])
                print("done:", tname, sorted(roster))
            except Exception as e:
                print("skip", slug, e)

    if len(out) < 20:
        raise SystemExit(f"Only {len(out)} players fetched, keeping the old players.json")
    data = {"updated": datetime.date.today().isoformat(), "players": list(out.values())}
    json.dump(data, open("players.json", "w"), separators=(",", ":"), ensure_ascii=False)
    print("wrote players.json:", len(out), "players")

asyncio.run(main())
