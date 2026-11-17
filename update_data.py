"""Full-season per-map CS2 player stats for every active team from bo3.gg -> players.json.

Incremental (players.json and season_state.json are kept between runs):
  1. Update: for every team, only matches newer than the ones already stored are fetched (pages of PAGE_LIMIT,
     newest first, stopping at the first known match). The roster is worked out again only when there is something new.
  2. Backfill: with the time left, older matches are fetched for teams whose season is not complete yet (pages of
     BACKFILL_PAGE, older than the oldest match scanned so far, stopping at SEASON_START). Progress is saved per team in
     season_state.json, so a backfill that does not finish in one run carries on in the next one.
Season = calendar year (SEASON_START, default Jan 1 of this year), the same as the SZN hit-rate box. Logs from before
SEASON_START are dropped. players.json is written in the compact fmt 2 (grader.encode_players) so a full season stays
small enough for the site."""
import re, asyncio, json, datetime, time, os, aiohttp
from grader import load_players, encode_players

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
TIME_LIMIT = float(os.environ.get("TIME_LIMIT_H", "4.5")) * 3600  # seconds; stop cleanly and save what we have (job limit 6 h)
SEASON_START = os.environ.get("SEASON_START") or "%d-01-01" % datetime.date.today().year  # every finished match since this day
PAGE_LIMIT = 15          # matches per page in the daily update (newest first, stops at the first stored match)
BACKFILL_PAGE = 25       # matches per page when filling in older season matches
STATE_FILE = "season_state.json"   # per-team scan progress (match ids seen, oldest match reached, season complete?)
MAX_BYTES = 22 * 1024 * 1024       # players.json must stay under the 25 MiB Workers asset limit: oldest logs are trimmed above this
ONLY_TEAMS = [x.strip() for x in os.environ.get("ONLY_TEAMS", "").split(",") if x.strip()]  # testing: scan only these team slugs
ACTIVE_DAYS = 120        # skip teams with no match in this many days
DELAY = 0.3
# Optional per-map fields saved when bo3.gg returns them (names are guesses; the Actions log prints the real keys)
EXTRA_KEYS = ["rating", "player_rating", "kast", "first_kills", "first_deaths", "clutches_won", "clutches",
              "rounds_count", "rounds", "hits", "shots"]
EVENT_TYPE = {}   # tournament id -> "lan" / "online" / None (kept in season_state.json between runs)
SAMPLE_PRINTED = False
STATS = {}        # game id -> trimmed players_stats rows (this run only: a match between two tracked teams is fetched once)
REQ = {"n": 0}    # requests made this run
STAT_KEEP = ["kills", "headshots", "death", "assists", "adr", "team_clan", "steam_profile"] + EXTRA_KEYS

async def get(s, path, params=None):
    for attempt in range(5):
        async with s.get(B + path, params=params) as r:
            if r.status == 429:
                await asyncio.sleep(3 * (attempt + 1))
                continue
            r.raise_for_status()
            REQ["n"] += 1
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

def _trim(p):
    return {k: p[k] for k in STAT_KEEP if k in p}


async def game_stats(s, gid):
    if gid not in STATS:
        STATS[gid] = [_trim(p) for p in (await get(s, f"/games/{gid}/players_stats") or [])]
    return STATS[gid]


async def matches_page(s, tid, offset, limit, before=None):
    q = {"scope": "widget-matches", "page[offset]": offset, "page[limit]": limit,
         "sort": "-start_date", "filter[matches.status][in]": "finished",
         "filter[matches.team_ids][overlap]": tid,
         "filter[matches.discipline_id][eq]": 1, "with": "teams,tournament,games"}
    if before:
        q["filter[matches.start_date][lt]"] = before
    return (await get(s, "/matches", q)).get("results") or []


async def match_rows(s, m, tid, tname, only=None):
    """Per-player per-map logs of this team in one match. only = set of canon names to keep (backfill), else everyone."""
    global SAMPLE_PRINTED
    date = m["start_date"][:10]
    et = await event_type(s, m)
    rows = []
    for g in m.get("games", []):
        if g.get("state") != "done":
            continue
        stats = await game_stats(s, g["id"])
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
            if not same or (only is not None and _canon(nick) not in only):
                continue
            rows.append({"mid": m["id"], "date": date, "name": nick, "log": mk_log(date, m, g, p, et)})
    return rows


def _merge_logs(old, new):
    """Union by (match, map), newest first, season only."""
    by = {}
    for l in list(old) + list(new):
        if (l.get("date") or "") >= SEASON_START:
            by[(l.get("mid"), l.get("n"))] = l
    return sorted(by.values(), key=lambda l: (l.get("date") or "", l.get("mid") or 0, -(l.get("n") or 0)), reverse=True)


def team_state(state, t):
    st = state["teams"].setdefault(str(t["id"]), {})
    st["name"] = t.get("name", t["slug"])
    return st


async def update_team(s, t, cutoff, out, prev, state):
    """Daily step for one team: new matches only. prev = this team's entries from the last players.json (name -> entry)."""
    tid, tname = t["id"], t.get("name", t["slug"])
    st = team_state(state, t)
    if not prev:                     # nothing stored for this team: start its season from scratch
        st.clear(); st["name"] = tname
    known = set(st.get("mids") or []) | {l.get("mid") for e in prev.values() for l in e["logs"]}
    new, offset = [], 0
    while True:
        ms = await matches_page(s, tid, offset, PAGE_LIMIT)
        if offset == 0 and (not ms or ms[0]["start_date"][:10] < cutoff):
            print("inactive:", tname)
            return "inactive"
        stop = False
        for m in ms:
            if m["id"] in known:
                stop = True
                break
            if m["start_date"][:10] < SEASON_START:
                stop = True
                st["done"] = True
                break
            new.append(m)
        if len(ms) < PAGE_LIMIT and not stop:
            st["done"] = True
        if stop or len(ms) < PAGE_LIMIT or not known:   # a team seen for the first time: one page now, the rest is backfill
            break
        offset += PAGE_LIMIT
    if not st.get("oldest"):
        if new:
            st["oldest"] = new[-1]["start_date"]
        dates = [l.get("date") for e in prev.values() for l in e["logs"] if l.get("date")]
        if dates:   # first run after the switch: carry on below the matches already stored
            o = min(dates) + "T23:59:59"
            st["oldest"] = min(st.get("oldest") or o, o)
    rows = []
    for m in new:
        rows += await match_rows(s, m, tid, tname)
        known.add(m["id"])
    st["mids"] = sorted(x for x in known if x is not None)
    st["scanned"] = datetime.date.today().isoformat()
    if not rows:
        for k, e in prev.items():
            out[(tid, k)] = dict(e, team=tname, logs=_merge_logs(e["logs"], []))
        print("no new matches:", tname, "| kept", len(prev), "players")
        return "kept"
    # Roster = newest lineup plus anyone who played 2+ of the 3 latest series (keeps regulars who sat out once),
    # plus anyone on a line today who played for this team in its last PAGE_LIMIT series.
    allrows = rows + [{"mid": l.get("mid"), "date": l.get("date") or "", "name": e["name"], "log": l} for e in prev.values() for l in e["logs"]]
    order = sorted({(r["date"], r["mid"]) for r in allrows if r["mid"] is not None}, reverse=True)
    mids = [m for _, m in order]
    recent, latest = set(mids[:3]), set(mids[:PAGE_LIMIT])
    seen = {}
    for r in allrows:
        if r["mid"] in recent:
            seen.setdefault(r["name"], set()).add(r["mid"])
    roster = {r["name"] for r in allrows if mids and r["mid"] == mids[0]} | {n for n, v in seen.items() if len(v) >= 2}
    roster |= {r["name"] for r in allrows if r["mid"] in latest and _canon(r["name"]) in WANTED}
    for name in roster:
        old = prev.get(name, {}).get("logs") or []
        newl = [r["log"] for r in rows if r["name"] == name]
        out[(tid, name)] = {"name": name, "team": tname, "logs": _merge_logs(old, newl)}
    print("done:", tname, "| new matches", len(new), "|", sorted(roster))
    return "updated"


async def backfill_team(s, t, out, state, deadline):
    """Older season matches for one team, for the players on its current roster. Resumable (season_state.json)."""
    tid, tname = t["id"], t.get("name", t["slug"])
    st = team_state(state, t)
    names = {_canon(k[1]): k for k in out if k[0] == tid}
    if st.get("done") or not names:   # nothing to fill (or no roster to fill it for yet)
        return 0
    known = set(st.get("mids") or [])
    added = pages = 0
    while time.time() < deadline:
        ms = await matches_page(s, tid, 0, BACKFILL_PAGE, before=st.get("oldest"))
        pages += 1
        for m in ms:
            if m["start_date"][:10] < SEASON_START:
                st["done"] = True
                break
            if m["id"] in known:
                continue
            for r in await match_rows(s, m, tid, tname, only=set(names)):
                e = out[names[_canon(r["name"])]]
                e["logs"] = _merge_logs(e["logs"], [r["log"]])
                added += 1
            known.add(m["id"])
        if ms:
            st["oldest"] = ms[-1]["start_date"]
        if len(ms) < BACKFILL_PAGE:
            st["done"] = True
        st["mids"] = sorted(known)
        if st.get("done"):
            break
    print("backfill:", tname, "| pages", pages, "| logs added", added, "| season complete" if st.get("done") else "| continues next run (reached %s)" % str(st.get("oldest"))[:10])
    return added


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

def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            st = json.load(f)
    except Exception:
        st = {}
    if st.get("season_start") != SEASON_START:   # new season (or first run): start over
        st = {"season_start": SEASON_START, "teams": {}, "events": st.get("events") or {}}
    st.setdefault("teams", {})
    EVENT_TYPE.update({int(k) if str(k).isdigit() else k: v for k, v in (st.get("events") or {}).items()})
    return st


def save_state(st):
    st["events"] = {str(k): v for k, v in EVENT_TYPE.items()}
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, separators=(",", ":"), sort_keys=True)
    os.replace(tmp, STATE_FILE)


def write_players(data):
    """Compact players.json; if it would pass MAX_BYTES, the oldest months are trimmed until it fits."""
    enc = json.dumps(encode_players(data), separators=(",", ":"), ensure_ascii=False)
    while len(enc.encode()) > MAX_BYTES:
        dates = sorted({l["date"][:7] for p in data["players"] for l in p["logs"] if l.get("date")})
        if len(dates) <= 2:
            break
        print("players.json too big (%d bytes): dropping logs from %s" % (len(enc.encode()), dates[0]))
        for p in data["players"]:
            p["logs"] = [l for l in p["logs"] if (l.get("date") or "")[:7] > dates[0]]
        enc = json.dumps(encode_players(data), separators=(",", ":"), ensure_ascii=False)
    with open("players.json.tmp", "w", encoding="utf-8") as f:
        f.write(enc)
    os.replace("players.json.tmp", "players.json")
    return len(enc.encode())


async def main():
    out = {}
    started = time.time()
    deadline = started + TIME_LIMIT
    cutoff = (datetime.date.today() - datetime.timedelta(days=ACTIVE_DAYS)).isoformat()
    state = load_state()
    try:
        old = load_players("players.json")
    except Exception:
        old = {"players": []}
    prev_by_tn = {}
    for e in old.get("players", []):
        prev_by_tn.setdefault(_tn(e.get("team")), {})[e["name"]] = e
    print("season from", SEASON_START, "| stored players:", len(old.get("players", [])))
    async with aiohttp.ClientSession(headers=H) as s:
        teams = await ranked_teams(s)
        ranks = {t.get("name", t["slug"]): t["rank"] for t in teams if t.get("rank")}
        games = await upcoming(s)
        print(len(teams), "ranked teams")
        extra = await unranked_teams(s, {t["id"] for t in teams}, cutoff) if not ONLY_TEAMS else []
        front_ids = {t["id"] for t in UP_TEAMS}
        queue = UP_TEAMS + [t for t in teams + extra if t["id"] not in front_ids]
        seen_ids, q2 = set(), []
        for t in queue:
            if t["id"] not in seen_ids and (not ONLY_TEAMS or t.get("slug") in ONLY_TEAMS):
                seen_ids.add(t["id"])
                q2.append(t)
        queue = q2
        print("teams with upcoming matches (scanned first):", len(UP_TEAMS), "| total queue:", len(queue))
        status = {}
        t1 = time.time()
        for i, t in enumerate(queue):
            st = state["teams"].get(str(t["id"])) or {}
            names = {_tn(t.get("name", t["slug"])), _tn(st.get("name"))} - {""}
            prev = {}
            for k in names:
                prev.update(prev_by_tn.get(k, {}))
            if time.time() > deadline:
                status[t["id"]] = "kept"   # out of time: keep what we had
                for name, e in prev.items():
                    out[(t["id"], name)] = dict(e, logs=_merge_logs(e["logs"], []))
                continue
            try:
                status[t["id"]] = await update_team(s, t, cutoff, out, prev, state)
            except Exception as ex:
                print("skip", t.get("slug"), ex)
                for name, e in prev.items():
                    out[(t["id"], name)] = dict(e, logs=_merge_logs(e["logs"], []))
        print("update phase: %.1f min, %d requests" % ((time.time() - t1) / 60, REQ["n"]))
        t2, r2, filled = time.time(), REQ["n"], 0
        for t in queue:
            if time.time() > deadline:
                break
            if status.get(t["id"]) not in ("updated", "kept"):
                continue
            try:
                filled += await backfill_team(s, t, out, state, deadline)
            except Exception as ex:
                print("backfill stopped for", t.get("slug"), ex)
        left = sum(1 for t in queue if status.get(t["id"]) in ("updated", "kept") and not (state["teams"].get(str(t["id"])) or {}).get("done"))
        print("backfill phase: %.1f min, %d requests, %d logs added | teams still to backfill: %d" % (
            (time.time() - t2) / 60, REQ["n"] - r2, filled, left))
        if ONLY_TEAMS:   # test run on a few teams: keep everyone else as stored
            done_tn = {_tn(e["team"]) for e in out.values()}
            for k, ents in prev_by_tn.items():
                if k not in done_tn:
                    for name, e in ents.items():
                        out[("old", k, name)] = dict(e, logs=_merge_logs(e["logs"], []))
        print("teams with players:", len({k[0] for k in out}), "| players:", len(out), "| requests this run:", REQ["n"])
    if len(out) < 20:
        raise SystemExit(f"Only {len(out)} players fetched, keeping the old players.json")
    today = datetime.date.today().isoformat()
    if games:
        json.dump({"updated": today, "games": games}, open("games.json", "w"),
                  separators=(",", ":"), ensure_ascii=False)
        print("wrote games.json:", len(games), "games")
    players = [e for e in out.values() if e["logs"]]
    data = {"updated": today, "season_start": SEASON_START, "ranks": ranks, "players": players}
    size = write_players(data)
    save_state(state)   # only together with players.json, so the two always match
    print("wrote players.json: %d players, %d logs, %.1f MB" % (len(players), sum(len(p["logs"]) for p in players), size / 1e6))

if __name__ == "__main__":
    asyncio.run(main())
