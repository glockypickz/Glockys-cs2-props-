"""Diagnostic (changes nothing): can we get past meetings between two teams from bo3.gg, and do those old maps have
per-player kills and headshots? Takes the next upcoming matchups, tries several ways to ask for their past meetings,
and prints what comes back. Uses only the same bo3.gg calls the data job already uses."""
import asyncio, json, aiohttp
import update_data as U

WITH = "teams,tournament,games"
PAIRS = 6          # upcoming matchups to test
DEEP_PAGES = 4     # pages of 100 for the "walk one team's history" test


def short(o, n=700):
    t = json.dumps(o, ensure_ascii=False, default=str)
    return t if len(t) <= n else t[:n] + " ...[cut]"


def ids(m):
    return {(m.get("team1") or {}).get("id"), (m.get("team2") or {}).get("id")}


async def try_get(s, path, params):
    try:
        return await U.get(s, path, params), None
    except aiohttp.ClientResponseError as e:
        return None, "HTTP %s" % e.status
    except Exception as e:
        return None, type(e).__name__ + " " + str(e)[:120]


def base(extra):
    p = {"scope": "widget-matches", "page[offset]": 0, "page[limit]": 100, "sort": "-start_date",
         "filter[matches.status][in]": "finished", "filter[matches.discipline_id][eq]": 1, "with": WITH}
    p.update(extra)
    return p


async def main():
    # the live update_data.get waits on a shared limiter that the data job creates at its own startup; make one here
    if hasattr(U, "SEM") and U.SEM is None:
        U.SEM = asyncio.Semaphore(2)
    async with aiohttp.ClientSession(headers=U.H) as s:
        d = await U.get(s, "/matches", {
            "scope": "widget-matches", "page[offset]": 0, "page[limit]": 40, "sort": "start_date",
            "filter[matches.status][in]": "upcoming", "filter[matches.discipline_id][eq]": 1, "with": "teams"})
        up = [m for m in d.get("results", []) if (m.get("team1") or {}).get("id") and (m.get("team2") or {}).get("id")]
        print("upcoming matches:", len(up))
        sample_meeting = None
        for m in up[:PAIRS]:
            a, b = m["team1"], m["team2"]
            print("\n==== %s vs %s (ids %s / %s)" % (a.get("name"), b.get("name"), a["id"], b["id"]))
            both = {a["id"], b["id"]}
            for label, extra in (
                ("A: team_ids[contains]=A,B", {"filter[matches.team_ids][contains]": "%s,%s" % (a["id"], b["id"])}),
                ("B: team_ids[overlap]=A,B (any of the two)", {"filter[matches.team_ids][overlap]": "%s,%s" % (a["id"], b["id"])}),
                ("C: team_ids[overlap]=A (team A only)", {"filter[matches.team_ids][overlap]": a["id"]}),
            ):
                r, err = await try_get(s, "/matches", base(extra))
                if err:
                    print(label, "->", err)
                    continue
                res = r.get("results", [])
                meet = [x for x in res if ids(x) == both]
                print(label, "-> returned %d, of those %d are A vs B, total reported %s" %
                      (len(res), len(meet), (r.get("total") or {}).get("count")))
                if meet and sample_meeting is None:
                    sample_meeting = meet[0]
            # D: walk team A's history page by page and keep only meetings with B
            found, seen, oldest = [], 0, None
            for pg in range(DEEP_PAGES):
                r, err = await try_get(s, "/matches", base({"filter[matches.team_ids][overlap]": a["id"], "page[offset]": pg * 100}))
                if err or not r.get("results"):
                    if err:
                        print("D page", pg, err)
                    break
                res = r["results"]
                seen += len(res)
                oldest = res[-1].get("start_date")
                found += [x for x in res if ids(x) == both]
            print("D: walked team A history: %d matches back to %s -> %d meetings with B: %s" % (
                seen, (oldest or "?")[:10], len(found), [x.get("start_date", "")[:10] for x in found]))
            if found and sample_meeting is None:
                sample_meeting = found[0]
        if not sample_meeting:
            print("\nno past meeting found for the tested pairs, nothing to inspect")
            return
        m = sample_meeting
        print("\n==== SAMPLE MEETING:", (m.get("team1") or {}).get("name"), "vs", (m.get("team2") or {}).get("name"), m.get("start_date"))
        print("match scalar fields:", short({k: v for k, v in m.items() if not isinstance(v, (dict, list))}))
        for g in (m.get("games") or [])[:3]:
            print("game", g.get("number"), g.get("map_name"), "state", g.get("state"),
                  "score", g.get("winner_clan_score"), "-", g.get("loser_clan_score"))
        g = next((x for x in m.get("games", []) if x.get("state") == "done"), None)
        if g:
            r, err = await try_get(s, "/games/%s/players_stats" % g["id"], None)
            print("players_stats:", err or "%d rows" % len(r or []))
            for row in (r or [])[:10]:
                print("  ", row.get("nickname") or row.get("player_nickname") or row.get("player_id"),
                      "kills", row.get("kills"), "hs", row.get("headshots"), "team", (row.get("team_clan") or {}).get("name"))


if __name__ == "__main__":
    asyncio.run(main())
