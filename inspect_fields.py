"""Diagnostic: print every field bo3.gg returns for a finished match, a game and a player's stats row,
so we can see whether round counts and map scores are available. Changes nothing."""
import asyncio, json, aiohttp
import update_data as U


def short(o, n=1800):
    t = json.dumps(o, ensure_ascii=False, default=str)
    return t if len(t) <= n else t[:n] + " ...[cut]"


async def main():
    async with aiohttp.ClientSession(headers=U.H) as s:
        d = await U.get(s, "/matches", {
            "scope": "widget-matches", "page[offset]": 0, "page[limit]": 5,
            "sort": "-start_date", "filter[matches.status][in]": "finished",
            "filter[matches.discipline_id][eq]": 1, "with": "teams,tournament,games"})
        ms = d.get("results", [])
        print("matches returned:", len(ms))
        for m in ms[:2]:
            print("\n=== MATCH keys:", sorted(m.keys()))
            print("scalar fields:", short({k: v for k, v in m.items() if not isinstance(v, (dict, list))}))
            for g in (m.get("games") or [])[:2]:
                print("\n--- GAME keys:", sorted(g.keys()))
                print("GAME:", short(g))
        m = ms[0]
        g = next((x for x in m.get("games", []) if x.get("state") == "done"), None)
        if g:
            stats = await U.get(s, f"/games/{g['id']}/players_stats")
            print("\n=== PLAYER STATS rows:", len(stats or []))
            if stats:
                print("keys:", sorted(stats[0].keys()))
                print("first row:", short(stats[0], 3000))
        try:
            det = await U.get(s, f"/matches/{m['slug']}")
            print("\n=== MATCH DETAIL keys:", sorted(det.keys()))
            for gg in (det.get("games") or [])[:2]:
                print("DETAIL GAME:", short(gg))
        except Exception as e:
            print("match detail failed:", e)


if __name__ == "__main__":
    asyncio.run(main())
