"""Quick results job: adds just-finished matches to players.json so the track record grades within hours.
Only adds games for players already in players.json. The daily update_data.py still decides who is in the data."""
import asyncio, json, datetime, re, aiohttp
import update_data as U

PAGES = 8          # pages of 100 recent finished matches to scan
LOOKBACK_DAYS = 3  # only matches that started within this many days


def tn(s):
    skip = {"team", "esports", "esport", "gaming", "club"}
    return "".join(w for w in re.split(r"[^a-z0-9]+", str(s or "").lower()) if w and w not in skip)


async def recent_matches(s, cutoff):
    out = []
    for page in range(PAGES):
        d = await U.get(s, "/matches", {
            "scope": "widget-matches", "page[offset]": page * 100, "page[limit]": 100,
            "sort": "-start_date", "filter[matches.status][in]": "finished",
            "filter[matches.discipline_id][eq]": 1, "with": "teams,tournament,games"})
        res = d.get("results", [])
        if not res:
            break
        stop = False
        for m in res:
            if m["start_date"][:10] < cutoff:
                stop = True
                break
            out.append(m)
        if stop:
            break
    return out


async def run(data, cutoff):
    entries = data["players"]
    by_team = {}
    for e in entries:
        by_team.setdefault(tn(e["team"]), {})[e["name"]] = e
    have = set()
    for e in entries:
        for l in e.get("logs", []):
            if "mid" in l:
                have.add((l["mid"], l.get("n")))
    added, new_games, skipped_players = 0, 0, set()
    async with aiohttp.ClientSession(headers=U.H) as s:
        matches = await recent_matches(s, cutoff)
        print("finished matches in the window:", len(matches))
        for m in matches:
            teams = [t for t in (m.get("team1"), m.get("team2")) if t and t.get("id")]
            known = [t for t in teams if tn(t.get("name")) in by_team]
            if not known:
                continue
            todo = [g for g in m.get("games", []) if g.get("state") == "done" and (m["id"], g.get("number")) not in have]
            if not todo:
                continue
            et = await U.event_type(s, m)
            date = m["start_date"][:10]
            for g in todo:
                stats = await U.get(s, f"/games/{g['id']}/players_stats")
                new_games += 1
                for p in stats or []:
                    tid = (p.get("team_clan") or {}).get("team_id")
                    t = next((x for x in teams if x["id"] == tid), None)
                    if not t:
                        continue
                    roster = by_team.get(tn(t.get("name")))
                    if not roster:
                        continue
                    nick = p["steam_profile"]["nickname"]
                    e = roster.get(nick)
                    if e is None:
                        c = [x for k, x in roster.items() if U._canon(k) == U._canon(nick)]
                        e = c[0] if len(c) == 1 else None
                    if e is None:
                        skipped_players.add(nick)
                        continue
                    e.setdefault("_new", []).append(U.mk_log(date, m, g, p, et))
                    added += 1
                have.add((m["id"], g.get("number")))
    for e in entries:
        new = e.pop("_new", None)
        if new:
            e["logs"] = sorted(new + e.get("logs", []), key=lambda l: l.get("date", ""), reverse=True)
    print("new games:", new_games, "| new player logs:", added)
    if skipped_players:
        print("players not in players.json (left to the daily job):", sorted(skipped_players))
    return added


def main():
    data = json.load(open("players.json", encoding="utf-8"))
    cutoff = (datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    added = asyncio.run(run(data, cutoff))
    if added:
        data["results_updated"] = datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z"
        json.dump(data, open("players.json", "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
        print("players.json updated")
    else:
        print("nothing new to add")


if __name__ == "__main__":
    main()
