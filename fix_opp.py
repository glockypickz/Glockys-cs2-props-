"""One-time repair: fills blank 'opp' on stored players.json logs.
1) From the other team's logs in the same match (update_data.fill_blank_opp, no API calls).
2) Leftovers (opponent not stored): the match's two team names from bo3.gg, 100 matches per request.
Only blank 'opp' values are written; everything else in players.json stays as it is.
Run: python fix_opp.py   (add --no-api to skip step 2)"""
import asyncio, sys, aiohttp
import update_data as U
from grader import load_players, save_players


async def match_teams(mids):
    out = {}
    U.SEM = asyncio.Semaphore(max(1, U.CONCURRENCY))
    mids = sorted(mids)
    async with aiohttp.ClientSession(headers=U.H) as s:
        async def one(chunk):
            try:
                d = await U.get(s, "/matches", {"filter[matches.id][in]": ",".join(map(str, chunk)),
                                                "with": "teams", "page[limit]": 100})
            except Exception as e:
                print("lookup failed for", len(chunk), "matches:", e)
                return
            for m in d.get("results") or []:
                t1, t2 = (m.get("team1") or {}).get("name"), (m.get("team2") or {}).get("name")
                if t1 and t2:
                    out[m["id"]] = (t1, t2)
        await asyncio.gather(*(one(mids[i:i + 100]) for i in range(0, len(mids), 100)))
    return out


def main():
    data = load_players("players.json")
    P = data["players"]
    before = sum(1 for e in P for l in e["logs"] if not l.get("opp"))
    f, left = U.fill_blank_opp(P)
    print("blank before:", before, "| filled from paired team logs:", f, "| still blank:", left)
    if left and "--no-api" not in sys.argv:
        mids = {l["mid"] for e in P for l in e["logs"] if not l.get("opp") and l.get("mid") is not None}
        teams = asyncio.run(match_teams(mids))
        n = 0
        for e in P:
            k = U._tn(e.get("team"))
            for l in e["logs"]:
                if l.get("opp") or l.get("mid") not in teams:
                    continue
                t1, t2 = teams[l["mid"]]
                if k and k == U._tn(t1) and k != U._tn(t2):
                    l["opp"] = t2; n += 1
                elif k and k == U._tn(t2) and k != U._tn(t1):
                    l["opp"] = t1; n += 1
        left = sum(1 for e in P for l in e["logs"] if not l.get("opp"))
        print("matches looked up:", len(teams), "of", len(mids), "| filled from bo3.gg match teams:", n, "| still blank:", left)
    save_players(data, "players.json")
    print("players.json saved")


if __name__ == "__main__":
    main()
