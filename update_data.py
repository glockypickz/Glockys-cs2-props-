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
    if not ms or ms[0]["start_date

