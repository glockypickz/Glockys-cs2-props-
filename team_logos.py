"""Team logo URLs for the trading cards -> team_logos.json ({"updated", "logos": {team: url}, "miss": {team: date}}).

Display only: never used by the grader. Looks up every team in players.json / games.json that has no logo yet with
bo3.gg's public team search (`/teams?filter[teams.name][eq]=<name>`), the same source as the Games tab data, and
keeps the files.bo3.gg image_url (that host sends a CORS header, so the card can still be exported as an image).
Teams bo3.gg doesn't know are remembered in "miss" and retried after a week. The site falls back to a monogram badge.
Never fails the job: on any error the old file is kept.
"""
import asyncio, json, datetime, os, aiohttp

B = "https://api.bo3.gg/api/v1"
H = {"accept": "application/json", "origin": "https://bo3.gg", "referer": "https://bo3.gg/",
     "user-agent": "Mozilla/5.0 (compatible; GlockysPropGrader/1.0)"}
MAX_LOOKUPS = int(os.environ.get("LOGO_MAX", "400"))
RETRY_DAYS = 7


def load(path, default):
    try:
        return json.load(open(path))
    except Exception:
        return default


async def one(s, sem, name):
    async with sem:
        for attempt in range(3):
            try:
                async with s.get(B + "/teams", params={"filter[teams.name][eq]": name, "page[limit]": 5}) as r:
                    if r.status == 429:
                        await asyncio.sleep(3 * (attempt + 1)); continue
                    if r.status != 200:
                        return name, None
                    res = (await r.json()).get("results") or []
                    for t in res:
                        u = t.get("image_url")
                        if t.get("name") == name and isinstance(u, str) and u.startswith("https://files.bo3.gg/"):
                            return name, u
                    return name, None
            except Exception:
                await asyncio.sleep(1)
        return name, None


async def main():
    today = datetime.date.today()
    out = load("team_logos.json", {})
    logos, miss = out.get("logos") or {}, out.get("miss") or {}
    teams = {p.get("team") for p in load("players.json", {}).get("players", [])}
    for g in load("games.json", {}).get("games", []):
        teams.update([g.get("team1"), g.get("team2")])
    todo = []
    for t in sorted(x for x in teams if x):
        if t in logos:
            continue
        try:
            if (today - datetime.date.fromisoformat(miss.get(t, "2000-01-01"))).days < RETRY_DAYS:
                continue
        except ValueError:
            pass
        todo.append(t)
    todo = todo[:MAX_LOOKUPS]
    if not todo:
        return print("team logos up to date:", len(logos))
    sem = asyncio.Semaphore(4)
    async with aiohttp.ClientSession(headers=H) as s:
        for name, url in await asyncio.gather(*(one(s, sem, n) for n in todo)):
            if url:
                logos[name] = url; miss.pop(name, None)
            else:
                miss[name] = today.isoformat()
    json.dump({"updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
               "logos": dict(sorted(logos.items())), "miss": dict(sorted(miss.items()))},
              open("team_logos.json", "w"), separators=(",", ":"), ensure_ascii=False)
    print("team logos:", len(logos), "found,", len(miss), "unknown to bo3.gg,", len(todo), "looked up")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print("team logo refresh failed, keeping the old file:", e)
