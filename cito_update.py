"""Daily Cito step (run by the "Update CS2 data" workflow right after update_data.py). The ONLY script that calls Cito.

Budget per run (cito_client caps it at CITO_DAILY_MAX = 14 calls, spaced 6.5 s apart):
  2  dated rankings: VRS + world, ?before=<today> (newest list strictly before today)
  1  upcoming matches (team ids for the teams on today's board)
  0-4 settle backup: matches that bo3.gg never logged (recent-matches window + that match's per-map player stats)
  rest  team map stats (last 30 days, current map pool) for teams with lines, soonest match first, each team at most
        every 3 days (cached replies are reused)
  ~13/day x 30 = ~390/month on the free plan's 500.
Writes
  team_strength.json            derived, dated numbers the grader / site use (served publicly, no raw Cito replies)
  cito_ids.json                 team key -> Cito team id (add {"<team key>": {"id": "cs2-team-123", "manual": true}} to fix one)
  cito_cache/_results_index.json per-map player kills / HS of matches fetched for settling (read by settle.py, no network)
Without CITO_API_KEY: no calls; the files are rebuilt from whatever is already saved (nothing changes if nothing is)."""
import json, os, sys, datetime
import cito_client
from cito_client import Cito
from grader import tn, teq, norm, canon

STRENGTH_FILE = os.environ.get("CITO_STRENGTH_FILE", "team_strength.json")
IDS_FILE = os.environ.get("CITO_IDS_FILE", "cito_ids.json")
SETTLE_MAX = int(os.environ.get("CITO_SETTLE_MAX", "4"))
SEARCH_MAX = int(os.environ.get("CITO_SEARCH_MAX", "1"))
HISTORY_DAYS = int(os.environ.get("CITO_HISTORY_DAYS", "30"))
KEEP_MAP_SNAPS = 12
KEEP_RANK_SNAPS = 60


def _load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _dump(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
    os.replace(tmp, path)


def data(body):
    if isinstance(body, dict):
        return body.get("data")
    return None


# ---------------------------------------------------------------- id matching (free: harvested from saved replies)
def harvest_ids(c, ids):
    def add(tid, name):
        k = tn(name)
        if tid and k and not (ids.get(k) or {}).get("manual"):
            ids[k] = {"id": tid, "name": name}
    for r in c.saved("/cs2/rankings/"):
        for row in data(r.get("body")) or []:
            add(row.get("teamId"), row.get("teamName"))
    for r in c.saved("/cs2/matches/upcoming") + c.saved("/cs2/matches/recent"):
        for m in data(r.get("body")) or []:
            add(m.get("team1Id"), m.get("team1Name"))
            add(m.get("team2Id"), m.get("team2Name"))
    for r in c.saved("/cs2/teams"):
        if r.get("path") == "/cs2/teams":
            q = (r.get("params") or {}).get("q")
            for row in data(r.get("body")) or []:
                if teq(row.get("name"), q):
                    add(row.get("id"), row.get("name"))
    return ids


# ---------------------------------------------------------------- team_strength.json from saved replies (+ old file)
def build_strength(c, old):
    rank = {"vrs": {}, "world": {}}
    for kind in rank:
        for sn in ((old or {}).get("rankings") or {}).get(kind) or []:
            rank[kind][sn["date"]] = sn["points"]
    for r in c.saved("/cs2/rankings/"):
        kind = r["path"].rsplit("/", 1)[-1]
        if kind not in rank or r.get("status") != 200:
            continue
        rows = data(r.get("body")) or []
        meta = (r.get("body") or {}).get("meta") or {}
        date = str(meta.get("rankingDate") or (rows[0].get("rankingDate") if rows else "") or "")[:10]
        pts = {}
        for row in rows:
            k = tn(row.get("teamName"))
            if k and isinstance(row.get("points"), (int, float)) and row["points"] > 0 and k not in pts:
                pts[k] = row["points"]
        if date and pts:
            rank[kind][date] = pts
    maps = {}
    for k, lst in ((old or {}).get("maps") or {}).items():
        for sn in lst:
            maps.setdefault(k, {})[sn["asof"]] = sn["maps"]
    for r in c.saved("/cs2/teams/"):
        if not r["path"].endswith("/map-stats") or r.get("status") != 200:
            continue
        d = data(r.get("body")) or {}
        k = tn(d.get("teamName"))
        mp = {}
        for row in d.get("maps") or []:
            if row.get("inPool") is False or not row.get("played"):
                continue
            n = row["played"]
            rf = row.get("roundsFor")
            ra = row.get("roundsAgainst")
            if rf is None or ra is None:   # fall back to the averages
                rf, ra = (row.get("avgRoundsFor") or 0) * n, (row.get("avgRoundsAgainst") or 0) * n
            mp[str(row.get("mapNameCanonical") or row.get("mapName"))] = [n, round(float(rf) + float(ra), 2), float(row.get("pickPercent") or 0)]
        if k and mp:
            asof = str(r["fetched"])[:10]   # the stats cover matches up to the fetch day; the grader uses them from the next day
            maps.setdefault(k, {})[asof] = mp
    odds = match_odds(c)
    out = {"source": "cito", "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
           "note": "Derived numbers only. rankings: dated lists (team key -> points). maps: per team, dated snapshots "
                   "{map: [maps played, total rounds on those maps, pick %]}. The grader only uses entries dated before the match day. "
                   "odds: match winner prices from the saved upcoming-matches reply (display only, not used by the grader).",
           "rankings": {kind: [{"date": d, "points": rank[kind][d]} for d in sorted(rank[kind])[-KEEP_RANK_SNAPS:]] for kind in rank},
           "maps": {k: [{"asof": a, "maps": v[a]} for a in sorted(v)[-KEEP_MAP_SNAPS:]] for k, v in sorted(maps.items())}}
    if odds:
        out["odds"] = odds
    return out


def match_odds(c):
    """Match-winner odds of upcoming matches from the newest saved /cs2/matches/upcoming reply (no extra call).
    One row per match that has an h2h price: team keys and names, start, implied win chance and decimal odds for each
    team, Map 1 / Map 2 prices when given, provider and capture time. Display only (Games tab)."""
    recs = [r for r in c.saved("/cs2/matches/upcoming") if r.get("status") == 200]
    if not recs:
        return []
    rec = max(recs, key=lambda r: str(r.get("fetched") or ""))
    out = []
    for m in data(rec.get("body")) or []:
        by = {}
        for o in m.get("odds") or []:
            if o.get("market") in ("h2h", "map_h2h_1", "map_h2h_2") and o.get("market") not in by:
                by[o["market"]] = o
        h = by.get("h2h")
        if not h or not isinstance(h.get("team1ImpliedProb"), (int, float)) or not isinstance(h.get("team2ImpliedProb"), (int, float)):
            continue
        row = {"t1": tn(m.get("team1Name")), "t2": tn(m.get("team2Name")), "n1": m.get("team1Name"), "n2": m.get("team2Name"),
               "start": m.get("startsAt"), "p": [round(h["team1ImpliedProb"], 4), round(h["team2ImpliedProb"], 4)],
               "dec": [h.get("team1Odds"), h.get("team2Odds")], "src": h.get("provider"),
               "at": h.get("capturedAt") or rec.get("fetched")}
        for k, mk in (("map1", "map_h2h_1"), ("map2", "map_h2h_2")):
            o = by.get(mk)
            if o and isinstance(o.get("team1ImpliedProb"), (int, float)) and isinstance(o.get("team2ImpliedProb"), (int, float)):
                row[k] = [round(o["team1ImpliedProb"], 4), round(o["team2ImpliedProb"], 4)]
        if row["t1"] and row["t2"]:
            out.append(row)
    return out


# ---------------------------------------------------------------- settle backup
def results_index(c):
    """Per-map player stats of every saved finished match (Cito /matches/{id}/maps), with team names and date."""
    info = {}
    for r in c.saved("/cs2/matches/recent"):
        for m in data(r.get("body")) or []:
            info[m.get("id")] = m
    out = []
    for r in c.saved("/cs2/matches/"):
        if not r["path"].endswith("/maps") or r.get("status") != 200:
            continue
        mid = r["path"].split("/")[3]
        rows = data(r.get("body")) or []
        m = info.get(mid) or {}
        maps = []
        for g in rows:
            ps = [[p.get("playerName") or (p.get("player") or {}).get("nickname"), p.get("teamName"), p.get("kills"), p.get("headshots")]
                  for p in g.get("playerStats") or []]
            maps.append({"n": g.get("mapNumber"), "status": g.get("status"), "forfeit": bool(g.get("isForfeit") or g.get("resultType") == "forfeit"),
                         "players": ps})
        t1, t2 = m.get("team1Name"), m.get("team2Name")
        if not (t1 and t2):
            ts = sorted({p[1] for g in maps for p in g["players"] if p[1]})
            t1, t2 = (ts + [None, None])[:2]
        out.append({"id": mid, "date": str(m.get("startsAt") or "")[:10], "t1": t1, "t2": t2, "maps": maps})
    out.sort(key=lambda x: (x["date"], x["id"]))
    return {"source": "cito", "matches": out}


def settle_candidates(now):
    """Locked lines that bo3.gg has not settled: started 24h+ ago and inside the free plan's history window."""
    try:
        from grader import Grader
        from settle import find_result
        from grader import load_players
        pj = load_players("players.json")
        gr = Grader(pj.get("players", []), pj.get("ranks") or {})
        hist = _load("lines_history.json", {}).get("entries", [])
    except Exception as e:
        print("settle backup skipped:", e)
        return []
    out = {}
    for e in hist:
        r = e.get("result") or {}
        if not e.get("lock") or r.get("outcome") in ("hit", "miss", "push"):
            continue
        try:
            t0 = datetime.datetime.fromisoformat(e["start"].replace("Z", "+00:00"))
        except Exception:
            continue
        age = (now - t0).total_seconds() / 3600
        if age < 24 or age > 24 * (HISTORY_DAYS - 2):
            continue
        found, why = find_result(gr, e)
        if found:
            continue
        out.setdefault((tn(e.get("team")), tn(e.get("opponent")), e["start"][:10]), e)
    return sorted(out.items(), key=lambda kv: kv[0][2], reverse=True)


def settle_backup(c, now, idx):
    have = {(tn(m["t1"]), tn(m["t2"]), m["date"]) for m in idx["matches"]}
    spent0 = c.calls
    for (a, b, day), e in settle_candidates(now):
        if c.calls - spent0 >= SETTLE_MAX or not c.can_call():
            break
        d = datetime.date.fromisoformat(day)
        if any({x[0], x[1]} == {a, b} and abs((datetime.date.fromisoformat(x[2]) - d).days) <= 1 for x in have if x[2]):
            continue
        lst = data(c.recent((d - datetime.timedelta(days=1)).isoformat(), (d + datetime.timedelta(days=1)).isoformat())) or []
        for m in lst:
            if {tn(m.get("team1Name")), tn(m.get("team2Name"))} == {a, b} and m.get("id"):
                c.match_maps(m["id"])
                break


# ---------------------------------------------------------------- map stats for the teams on today's board
def board_teams():
    try:
        lines = _load("lines.json", {}).get("lines", [])
    except Exception:
        lines = []
    first = {}
    for l in lines:
        for t in (l.get("team"), l.get("opponent")):
            k = tn(t)
            if k:
                s = l.get("starts_at") or "9999"
                if k not in first or s < first[k][0]:
                    first[k] = (s, t)
    return [(k, v[1]) for k, v in sorted(first.items(), key=lambda kv: kv[1][0])]


def main():
    cito_client.load_dotenv()
    c = Cito()
    now = datetime.datetime.now(datetime.timezone.utc)
    today = now.date().isoformat()
    if c.offline:
        print("CITO_API_KEY not set: no Cito calls; rebuilding files from saved replies only")
    else:
        print("Cito: up to %d calls today (%d already used), %.1f s apart" % (c.calls_left_today(), c.usage.get("calls", 0), c.spacing))
    ids = _load(IDS_FILE, {})
    old = _load(STRENGTH_FILE, None)
    try:
        if not c.offline:
            c.rankings("vrs", before=today)
            c.rankings("world", before=today)
            c.upcoming()
            harvest_ids(c, ids)
            settle_backup(c, now, results_index(c))
            searches = 0
            for k, name in board_teams():
                if not c.can_call():
                    break
                if k not in ids:
                    if searches >= SEARCH_MAX:
                        continue
                    searches += 1
                    c.teams_search(name)
                    harvest_ids(c, ids)
                    if k not in ids:
                        print("cito: no team id for", name)
                        continue
                c.team_map_stats(ids[k]["id"])
            print("pruned old saved replies:", c.prune())
    except Exception as e:  # never break the daily job
        print("cito step stopped early:", type(e).__name__, e)
    harvest_ids(c, ids)
    st = build_strength(c, old)
    has = any(st["rankings"].values()) or st["maps"]
    if has:
        _dump(STRENGTH_FILE, st)
        print("wrote %s: rankings %s, teams with map stats %d" % (STRENGTH_FILE, {k: len(v) for k, v in st["rankings"].items()}, len(st["maps"])))
    if ids:
        _dump(IDS_FILE, ids)
    idx = results_index(c)
    if idx["matches"]:
        _dump(os.path.join(c.cache_dir, "_results_index.json"), idx)
    print("Cito calls this run: %d | today: %s | month remaining (header): %s%s" % (
        c.calls, c.usage.get("calls"), c.usage.get("monthly_remaining"), (" | stopped: " + c.stopped) if c.stopped else ""))


if __name__ == "__main__":
    main()
