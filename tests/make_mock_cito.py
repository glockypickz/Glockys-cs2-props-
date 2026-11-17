"""Builds MOCK Cito data for tests and the mock backtest. Nothing here comes from Cito.

Reply shapes follow the examples in Cito's OpenAPI spec (rankings rows: teamId / teamName / rank / points /
rankingDate, meta.rankingDate; team map-stats: data.maps[] with mapName / played / wins / losses / roundsFor /
roundsAgainst / avgRoundsFor / avgRoundsAgainst / pickPercent / inPool; match maps: data[] with mapNumber / status /
playerStats[] with playerName / teamName / kills / headshots). The numbers are SYNTHETIC: computed from players.json
logs dated strictly before each snapshot day, so the mock is leak-free like the real thing would be.

  python tests/make_mock_cito.py   -> tests/fixtures/cito_cache/ (one day of saved replies, as cito_client saves them)
                                      tests/fixtures/team_strength_mock.json (weekly snapshots, built by cito_update.build_strength)
"""
import json, os, sys, shutil, datetime, math, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cito_client import Cito
import cito_update
from grader import tn

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")


def team_maps(players):
    """(date, team display name, map, rounds for, rounds against, mid) once per team-map."""
    seen, rows = set(), []
    for p in players:
        for l in p.get("logs") or []:
            rd, rw = l.get("rd"), l.get("rw")
            if not isinstance(rd, (int, float)) or not isinstance(rw, (int, float)) or rd < 13 or not l.get("date"):
                continue
            k = (tn(p.get("team")), l.get("mid"), l.get("n"))
            if k in seen:
                continue
            seen.add(k)
            rows.append((l["date"], p.get("team"), (l.get("map") or "Unknown").capitalize(), rw, rd - rw, l.get("mid")))
    return rows


def record(path, params, fetched, body):
    return {"path": path, "params": params, "status": 200, "etag": 'W/"mock"', "fetched": fetched + "T09:05:00+00:00", "body": body}


def write(cache, rec):
    with open(os.path.join(cache, Cito.cache_key(rec["path"], rec["params"]) + ".json"), "w", encoding="utf-8") as f:
        json.dump(rec, f, separators=(",", ":"))


def day_replies(rows, D, ids):
    """Mock replies a daily run on day D would have saved."""
    past = [r for r in rows if r[0] < D]
    p90 = [r for r in past if r[0] >= (datetime.date.fromisoformat(D) - datetime.timedelta(days=90)).isoformat()]
    p30 = [r for r in past if r[0] >= (datetime.date.fromisoformat(D) - datetime.timedelta(days=30)).isoformat()]
    agg = {}
    for d, t, m, rf, ra, _ in p90:
        a = agg.setdefault(t, [0, 0])
        a[0] += 1
        a[1] += 1 if rf > ra else 0
    rk = sorted(((t, (w + 5) / (n + 10) * math.log(1 + n)) for t, (n, w) in agg.items() if n >= 6), key=lambda x: -x[1])[:100]
    rdate = (datetime.date.fromisoformat(D) - datetime.timedelta(days=1)).isoformat()
    recs = []
    for kind, scale in (("vrs", 2000), ("world", 900)):
        top = rk[0][1] if rk else 1
        data = [{"id": "mock-%s-%d" % (kind, i), "teamId": ids.setdefault(t, "cs2-team-%d" % (1000 + len(ids))), "teamName": t, "rank": i + 1,
                 "points": round(scale * (s / top) ** (1.0 if kind == "vrs" else 1.3)), "change": 0, "region": None,
                 "rankingDate": rdate + "T00:00:00.000Z"} for i, (t, s) in enumerate(rk)]
        recs.append(record("/cs2/rankings/" + kind, {"before": D, "limit": 100}, D,
                           {"success": True, "data": data, "meta": {"rankingDate": rdate + "T00:00:00.000Z", "limit": 100}}))
    by = {}
    for d, t, m, rf, ra, _ in p30:
        by.setdefault(t, {}).setdefault(m, []).append((rf, ra))
    for t, mp in by.items():
        if t not in dict(rk) or sum(len(v) for v in mp.values()) < 4:
            continue
        tot = sum(len(v) for v in mp.values())
        maps = []
        for m, v in sorted(mp.items()):
            n, w = len(v), sum(1 for a, b in v if a > b)
            rf, ra = sum(a for a, _ in v), sum(b for _, b in v)
            maps.append({"mapName": m, "played": n, "wins": w, "losses": n - w, "ties": 0, "roundsFor": rf, "roundsAgainst": ra,
                         "avgRoundsFor": round(rf / n, 2), "avgRoundsAgainst": round(ra / n, 2), "pickPercent": round(100 * n / tot, 1),
                         "winPercent": round(100 * w / n, 1), "inPool": m != "Unknown", "poolStatus": "in_pool" if m != "Unknown" else "never_in_pool"})
        tid = ids.setdefault(t, "cs2-team-%d" % (1000 + len(ids)))
        recs.append(record("/cs2/teams/%s/map-stats" % tid, {"days": 30, "pool": "current"}, D,
                           {"success": True, "data": {"entityType": "cs2_team_map_stats", "teamId": tid, "teamName": t, "totalMaps": tot,
                                                      "activeDutyPool": sorted({m for m in mp if m != "Unknown"}), "poolFilter": "current", "maps": maps}}))
    return recs


def main():
    pj = json.load(open(os.path.join(HERE, "..", "players.json"), encoding="utf-8"))
    rows = team_maps(pj["players"])
    dates = sorted({r[0] for r in rows})
    start = (datetime.date.fromisoformat(dates[0]) + datetime.timedelta(days=21))
    end = datetime.date.fromisoformat(dates[-1]) + datetime.timedelta(days=1)
    ids, strength = {}, None
    D = start
    while D <= end:
        tmp = tempfile.mkdtemp()
        for rec in day_replies(rows, D.isoformat(), ids):
            write(tmp, rec)
        strength = cito_update.build_strength(Cito(key="", cache_dir=tmp), strength)
        last = tmp
        D += datetime.timedelta(days=7)
    strength["source"] = "MOCK (synthetic, tests only)"
    with open(os.path.join(FIX, "team_strength_mock.json"), "w", encoding="utf-8") as f:
        json.dump(strength, f, separators=(",", ":"), sort_keys=True)
    cache = os.path.join(FIX, "cito_cache")
    shutil.rmtree(cache, ignore_errors=True)
    shutil.copytree(last, cache)
    print("mock strength: %d VRS lists, %d world lists, %d teams with map snapshots -> tests/fixtures/team_strength_mock.json" % (
        len(strength["rankings"]["vrs"]), len(strength["rankings"]["world"]), len(strength["maps"])))


if __name__ == "__main__":
    main()
