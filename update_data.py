"""Fetch recent per-map CS2 player stats for every active ranked team from bo3.gg -> players.json."""
import re, asyncio, json, datetime, time, aiohttp

def _canon(n):
    k = re.sub(r"[^a-z0-9]", "", str(n or "").lower())
    for a, b in (("0", "o"), ("1", "i"), ("3", "e"), ("4", "a"), ("5", "s"), ("7", "t")):
        k = k.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", k)


def wanted_names():
    """Players that have lines right now (from lines.json, combos split into their players), as loose keys.
    They are kept in players.json whenever they show up in a team's recent matches, even as a stand-in or a bench player."""
    try:
        d = json.load(open("lines.json", encoding="utf-8"))
    except Exception:
        return set()
    out = set()
    for l in d.get("lines", []):
        for n in str(l.get("player", "")).split("+"):
            if n.strip():
                out.add(_canon(n))
    print("players with lines to keep:", len(out))
    return out


WANTED = wanted_names()

SKIP_WORDS = {"team", "esports", "esport", "gaming", "club"}
def _tn(s):
    return "".join(w for w in re.split(r"[^a-z0-9]+", str(s or "").lower()) if w and w not in SKIP_WORDS)

# Players we are chasing: every time one shows up in any match we scan, the log says which team bo3.gg gave them
WATCH = {_canon(n) for n in ("kyousuke", "molodoy", "tO0RO", "kelieN", "YumsaN")}


B = "https://api.bo3.gg/api/v1"
H = {"accept": "application/json", "origin": "https://bo3.gg", "referer": "https://bo3.gg/",
     "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"}

MAX_TEAMS = 150          # ranked teams to consider
MAX_UNRANKED = 250       # extra active teams bo3.gg has no rank for (raise for more, run gets longer)
DISCOVERY_PAGES = 60     # pages of 100 recent matches scanned to find active unranked teams
TIME_LIMIT = 4.5 * 3600  # seconds; stop cleanly and save what we have
MATCHES_PER_TEAM = 15   # last 15 needs 15 matches per team (run takes longer)
ACTIVE_DAYS = 120        # skip teams with no match in this many days
DELAY = 0.3
# Optional per-map fields saved when bo3.gg returns them (names are guesses; the Actions log prints the real keys)
EXTRA_KEYS = ["rating", "player_rating", "kast", "first_kills", "first_deaths", "clutches_won", "clutches",
              "rounds_count", "rounds", "hits", "shots"]
EVENT_TYPE = {}   # tournament id -> "lan" / "online" / None
SAMPLE_PRINTED = False

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

def mk_log(date, m, g, p, et):
    log = {"date": date, "mid": m["id"], "n": g.get("number"),
           "map": (g.get("map_name") or "").replace("de_", "").capitalize(),
           "opp": p.get("enemy_clan_name", ""), "kills": p["kills"], "hs": p["headshots"],
           "d": p.get("death"), "a": p.get("assists"), "adr": p.get("adr")}
    if et:
        log["ev"] = et
    # round counts: bo3.gg gives the final round score of every map on the match list (no extra calls)
    ws, ls = g.get("winner_clan_score"), g.get("loser_clan_score")
    if isinstance(ws, (int, float)) and isinstance(ls, (int, float)):
        log["rd"] = int(ws + ls)  # total rounds played on the map
        wt = (g.get("winner_team_clan") or {}).get("team_id")
        pt = (p.get("team_clan") or {}).get("team_id")
        if wt is not None and pt is not None:
            log["rw"] = int(ws if wt == pt else ls)  # rounds this player's team won
    x = {k: p[k] for k in EXTRA_KEYS if isinstance(p.get(k), (int, float))}
    if x:
        log["x"] = x
    return log

async def event_type(s, m):
    """LAN/online label only exists on the match detail, so fetch once per tournament."""
    tid = (m.get("tournament") or {}).get("id")
    if tid is None:
        return None
    if tid not in EVENT_TYPE:
        try:
            det = await get(s, f"/matches/{m['slug']}")
            EVENT_TYPE[tid] = (det.get("tournament") or {}).get("event_type")
        except Exception as e:
            print("event type lookup failed:", tid, e)
            EVENT_TYPE[tid] = None
    return EVENT_TYPE[tid]

async def do_team(s, t, cutoff, out):
    global SAMPLE_PRINTED
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
        et = await event_type(s, m)
        for g in m.get("games", []):
            if g.get("state") != "done":
                continue
            stats = await get(s, f"/games/{g['id']}/players_stats")
            if stats and not SAMPLE_PRINTED:
                SAMPLE_PRINTED = True
                print("players_stats keys:", sorted(stats[0].keys()))
            for p in stats:
                tc = p.get("team_clan") or {}
                nick = (p.get("steam_profile") or {}).get("nickname", "")
                if _canon(nick) in WATCH:
                    print("WATCH", nick, "| scanning", tname, tid, "| team_clan:", {k: v for k, v in tc.items() if not isinstance(v, (dict, list))})
                same = tc.get("team_id") == tid
                if not same:
                    # bo3.gg sometimes lists a stand-in/new signing under another clan id: accept if the clan name is this team
                    cn = tc.get("name") or tc.get("clan_name") or tc.get("team_name") or ""
                    same = bool(cn) and _tn(cn) == _tn(tname)
                if not same:
                    continue
                rows.append({"mid": m["id"], "name": p["steam_profile"]["nickname"],
                             "log": mk_log(date, m, g, p, et)})
    if not rows:
        print("no data:", tname)
        return
    # Roster = newest lineup plus anyone who played 2+ of the 3 latest series (keeps regulars who sat out once)
    mids = []
    for r in rows:
        if r["mid"] not in mids:
            mids.append(r["mid"])
    recent = mids[:3]
    seen = {}
    for r in rows:
        if r["mid"] in recent:
            seen.setdefault(r["name"], set()).add(r["mid"])
    roster = {r["name"] for r in rows if r["mid"] == rows[0]["mid"]} | {n for n, v in seen.items() if len(v) >= 2}
    roster |= {r["name"] for r in rows if _canon(r["name"]) in WANTED}  # anyone on a line today who played for this team recently
    for r in rows:
        if r["name"] in roster:
            e = out.setdefault(f"{tname}|{r['name']}", {"name": r["name"], "team": tname, "logs": []})
            e["logs"].append(r["log"])
    print("done:", tname, sorted(roster))

UP_TEAMS = []   # every team in the next scheduled matches (they are scanned first, so anyone with a line today gets stats)

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
            for t in (t1, t2):
                if t.get("id") and t["id"] not in {x["id"] for x in UP_TEAMS}:
                    UP_TEAMS.append({"id": t["id"], "slug": t.get("slug", ""), "name": t.get("name") or t.get("slug", "")})
            start = m["start_date"]
            if not start.endswith("Z") and "+" not in start[10:]:
                start += "Z"
            games.append({"id": m["id"], "start": start, "team1": t1["name"], "team2": t2["name"],
                          "tournament": (m.get("tournament") or {}).get("name", ""),
                          "bo": m.get("bo_type")})
    except Exception as e:
        print("schedule fetch failed:", e)
    return games

async def unranked_teams(s, known_ids, cutoff):
    """Teams that played a match since cutoff but have no ranked listing. Best tier first, then most active."""
    found = {}
    for page in range(DISCOVERY_PAGES):
        try:
            d = await get(s, "/matches", {
                "scope": "widget-matches", "page[offset]": page * 100, "page[limit]": 100,
                "sort": "-start_date", "filter[matches.status][in]": "finished",
                "filter[matches.discipline_id][eq]": 1, "with": "teams,tournament"})
        except Exception as e:
            print("discovery stopped:", e)
            break
        res = d.get("results", [])
        if not res:
            break
        for m in res:
            if m["start_date"][:10] < cutoff:
                res = None
                break
            tier = (m.get("tournament") or {}).get("tier_rank") or 99
            for t in (m.get("team1"), m.get("team2")):
                if t and t.get("id") and t["id"] not in known_ids:
                    e = found.setdefault(t["id"], {"id": t["id"], "slug": t.get("slug", ""),
                                                   "name": t.get("name") or t.get("slug", ""), "n": 0, "tier": 99})
                    e["n"] += 1
                    e["tier"] = min(e["tier"], tier)
        if res is None:
            break
    out = sorted(found.values(), key=lambda e: (e["tier"], -e["n"]))
    print("unranked active teams found:", len(out))
    return out[:MAX_UNRANKED]

async def main():
    out = {}
    cutoff = (datetime.date.today() - datetime.timedelta(days=ACTIVE_DAYS)).isoformat()
    async with aiohttp.ClientSession(headers=H) as s:
        teams = await ranked_teams(s)
        ranks = {t.get("name", t["slug"]): t["rank"] for t in teams if t.get("rank")}
        games = await upcoming(s)
        print(len(teams), "ranked teams")
        extra = await unranked_teams(s, {t["id"] for t in teams}, cutoff)
        started = time.time()
        front_ids = {t["id"] for t in UP_TEAMS}
        queue = UP_TEAMS + [t for t in teams + extra if t["id"] not in front_ids]
        print("teams with upcoming matches (scanned first):", len(UP_TEAMS), "| total queue:", len(queue))
        for i, t in enumerate(queue):
            if time.time() - started > TIME_LIMIT:
                print(f"time limit reached after {i} teams, saving what we have")
                break
            try:
                await do_team(s, t, cutoff, out)
            except Exception as e:
                print("skip", t.get("slug"), e)
        print("teams with players:", len({v["team"] for v in out.values()}), "| players:", len(out))
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
