"""Offline tests for the Cito integration (no real key, no internet): python tests/test_cito.py
A local HTTP server plays Cito with replies shaped like the OpenAPI spec examples."""
import json, os, sys, threading, tempfile, shutil, subprocess, datetime, importlib.util, io, contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
import cito_client
from cito_client import Cito

TODAY = datetime.datetime.now(datetime.timezone.utc).date()
D1 = (TODAY - datetime.timedelta(days=2)).isoformat()
HITS = []
MODE = {"rate429": 0, "monthly": False}


def body_for(path, q):
    if path.startswith("/api/v1/cs2/rankings/"):
        kind = path.rsplit("/", 1)[-1]
        rd = (TODAY - datetime.timedelta(days=3)).isoformat() + "T00:00:00.000Z"
        return {"success": True, "data": [
            {"id": "a", "teamId": "cs2-team-4494", "teamName": "MOUZ", "rank": 1, "points": 1964 if kind == "vrs" else 912, "rankingDate": rd},
            {"id": "b", "teamId": "cs2-team-5995", "teamName": "G2", "rank": 2, "points": 1500 if kind == "vrs" else 700, "rankingDate": rd},
            {"id": "c", "teamId": "cs2-team-9565", "teamName": "Team Vitality", "rank": 3, "points": 1400 if kind == "vrs" else 650, "rankingDate": rd}],
            "meta": {"rankingDate": rd}}
    if path == "/api/v1/cs2/matches/upcoming":
        return {"success": True, "data": [{"entityType": "cs2_match", "id": "cs2-match-1", "startsAt": TODAY.isoformat() + "T15:00:00.000Z", "bestOf": 3,
                                           "status": "upcoming", "team1Id": "cs2-team-7187", "team2Id": "cs2-team-11699", "team1Name": "Nexus", "team2Name": "BAKS",
                                           "odds": []}], "meta": {"oddsIncluded": False}}
    if path == "/api/v1/cs2/matches/recent":
        return {"success": True, "data": [{"entityType": "cs2_match", "id": "cs2-match-2399854", "startsAt": D1 + "T09:30:00.000Z", "bestOf": 3,
                                           "status": "completed", "team1Id": "cs2-team-4494", "team2Id": "cs2-team-5995", "team1Name": "MOUZ", "team2Name": "G2",
                                           "team1Score": 1, "team2Score": 2}]}
    if path.endswith("/maps") and "/matches/" in path:
        def ps(n):
            return [{"playerId": "p1", "playerName": "torzsi", "teamId": "cs2-team-4494", "teamName": "MOUZ", "kills": 20 + n, "headshots": 8},
                    {"playerId": "p2", "playerName": "HeavyGod", "teamId": "cs2-team-5995", "teamName": "G2", "kills": 13, "headshots": 6}]
        return {"success": True, "data": [{"entityType": "cs2_map", "id": "m1", "mapNumber": 1, "mapName": "Nuke", "status": "completed", "team1Score": 13,
                                           "team2Score": 7, "durationRounds": 20, "playerStats": ps(1)},
                                          {"entityType": "cs2_map", "id": "m2", "mapNumber": 2, "mapName": "Anubis", "status": "completed", "team1Score": 10,
                                           "team2Score": 13, "durationRounds": 23, "playerStats": ps(2)}]}
    if path.endswith("/map-stats"):
        tid = path.split("/")[5]
        name = {"cs2-team-4494": "MOUZ", "cs2-team-5995": "G2", "cs2-team-7187": "Nexus", "cs2-team-11699": "BAKS"}.get(tid, "X")
        return {"success": True, "data": {"entityType": "cs2_team_map_stats", "teamId": tid, "teamName": name, "maps": [
            {"mapName": "Anubis", "played": 4, "wins": 3, "losses": 1, "roundsFor": 50, "roundsAgainst": 38, "avgRoundsFor": 12.5, "avgRoundsAgainst": 9.5,
             "pickPercent": 50, "inPool": True},
            {"mapName": "Nuke", "played": 2, "wins": 1, "losses": 1, "roundsFor": 24, "roundsAgainst": 25, "avgRoundsFor": 12, "avgRoundsAgainst": 12.5,
             "pickPercent": 25, "inPool": True},
            {"mapName": "Cache", "played": 1, "wins": 0, "losses": 1, "roundsFor": 5, "roundsAgainst": 13, "pickPercent": 0, "inPool": False}]}}
    if path == "/api/v1/cs2/teams":
        return {"success": True, "data": [{"entityType": "cs2_team", "id": "cs2-team-77", "name": q.get("q", [""])[0], "slug": "x"}]}
    return None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        HITS.append((u.path, self.headers.get("x-api-key"), self.headers.get("If-None-Match")))
        def send(code, obj, hdr=None):
            b = json.dumps(obj).encode()
            self.send_response(code)
            for k, v in (hdr or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b)
        if not self.headers.get("x-api-key"):
            return send(401, {"success": False, "error": {"code": "MISSING_API_KEY", "status": 401}})
        if MODE["monthly"]:
            return send(429, {"success": False, "error": {"code": "MONTHLY_LIMIT_REACHED", "status": 429}})
        if MODE["rate429"] > 0:
            MODE["rate429"] -= 1
            return send(429, {"success": False, "error": {"code": "RATE_LIMIT_EXCEEDED", "status": 429}}, {"Retry-After": "1"})
        if self.headers.get("If-None-Match") == 'W/"v1"':
            self.send_response(304); self.send_header("ETag", 'W/"v1"'); self.end_headers(); return
        b = body_for(u.path, q)
        if b is None:
            return send(404, {"success": False, "error": {"code": "NOT_FOUND", "status": 404}})
        send(200, b, {"ETag": 'W/"v1"', "X-RateLimit-Monthly-Remaining": "321", "X-RateLimit-Remaining-Minute": "9"})


def server():
    s = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s, "http://127.0.0.1:%d/api/v1" % s.server_address[1]


class FakeTime:
    def __init__(self):
        self.t, self.slept = 1000.0, []
    def clock(self):
        return self.t
    def sleep(self, s):
        self.slept.append(s); self.t += s


FAILS = []


def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok:
        FAILS.append(name)


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


def test_client(base):
    tmp = tempfile.mkdtemp()
    ft = FakeTime()
    c = Cito(key="test-key", cache_dir=tmp, daily_max=5, reserve=40, spacing=6.5, base=base, sleep=ft.sleep, clock=ft.clock)
    HITS.clear()
    b = c.rankings("vrs", before="2026-11-10")
    check("auth header x-api-key sent", HITS and HITS[0][1] == "test-key")
    check("reply parsed", b and b["data"][0]["teamName"] == "MOUZ")
    check("reply saved to disk", os.path.exists(os.path.join(tmp, Cito.cache_key("/cs2/rankings/vrs", {"before": "2026-11-10", "limit": 100}) + ".json")))
    check("monthly remaining read from header", c.usage["monthly_remaining"] == 321)
    c.rankings("vrs", before="2026-11-10")
    check("dated reply served from cache (no 2nd call)", len(HITS) == 1)
    c.rankings("world", before="2026-11-10")
    check("calls spaced >= 6.5 s", ft.slept and abs(ft.slept[-1] - 6.5) < 1e-6)
    b2 = c.get("/cs2/rankings/world", {"before": "2026-11-10", "limit": 100}, ttl=0)
    check("stale cache revalidated with If-None-Match, 304 keeps body", HITS[-1][2] == 'W/"v1"' and b2 and b2["data"])
    MODE["rate429"] = 1
    n0 = len(HITS)
    b3 = c.upcoming()
    check("429 RATE_LIMIT_EXCEEDED retried after Retry-After", b3 is not None and len(HITS) == n0 + 2 and max(ft.slept) >= 6.5)
    check("daily cap reached -> no more calls", c.calls_left_today() == 0 and c.match_maps("cs2-match-9") is None and len(HITS) == n0 + 2)
    u = json.load(open(os.path.join(tmp, "_usage.json")))
    check("daily count persisted in _usage.json", u["calls"] == 5)
    c2 = Cito(key="test-key", cache_dir=tmp, daily_max=5, base=base, sleep=ft.sleep, clock=ft.clock)
    check("daily cap survives a restart", c2.calls_left_today() == 0)
    tmp2 = tempfile.mkdtemp()
    c3 = Cito(key="test-key", cache_dir=tmp2, daily_max=14, base=base, sleep=ft.sleep, clock=ft.clock)
    MODE["monthly"] = True
    n0 = len(HITS)
    check("MONTHLY_LIMIT_REACHED -> None, client stops", c3.upcoming() is None and c3.stopped and c3.recent() is None and len(HITS) == n0 + 1)
    MODE["monthly"] = False
    c4 = Cito(key="", cache_dir=tempfile.mkdtemp(), base=base)
    n0 = len(HITS)
    check("no key -> offline, no network", c4.offline and c4.upcoming() is None and len(HITS) == n0)
    c5 = Cito(key="k", cache_dir=tempfile.mkdtemp(), base=base, reserve=40, sleep=ft.sleep, clock=ft.clock)
    c5.usage["monthly_remaining"] = 40
    n0 = len(HITS)
    check("monthly reserve respected", c5.upcoming() is None and len(HITS) == n0)
    c6 = Cito(key="k", cache_dir=tempfile.mkdtemp(), base=base, sleep=ft.sleep, clock=ft.clock)
    n0 = len(HITS)
    c6.get("/cs2/nope"); c6.get("/cs2/nope")
    check("404 remembered, not re-requested", len(HITS) == n0 + 1)
    c7 = Cito(key="k", cache_dir=tempfile.mkdtemp(), base="http://127.0.0.1:9/api/v1", sleep=ft.sleep, clock=ft.clock)
    check("network error -> None after retries", quiet(c7.upcoming) is None and c7.calls == 3)


def test_update(base):
    work = tempfile.mkdtemp()
    for f in ("grader.py", "settle.py", "cito_client.py", "cito_update.py", "players.json"):
        shutil.copy(f, work)
    start = D1 + "T09:30:00Z"
    json.dump({"lines": [{"player": "torzsi", "team": "MOUZ", "opponent": "G2", "stat": "Kills", "starts_at": TODAY.isoformat() + "T18:00:00Z"},
                         {"player": "x", "team": "Nexus", "opponent": "BAKS", "stat": "Kills", "starts_at": TODAY.isoformat() + "T15:00:00Z"},
                         {"player": "y", "team": "Brand New Team", "opponent": "G2", "stat": "Kills", "starts_at": TODAY.isoformat() + "T20:00:00Z"}]},
              open(os.path.join(work, "lines.json"), "w"))
    entry = {"book": "PrizePicks", "player": "torzsi", "team": "MOUZ", "opponent": "G2", "stat": "Kills", "start": start, "line": 40.5,
             "lock": {"line": 40.5, "pick": "OVER", "grade": "C"}}
    json.dump({"entries": [entry]}, open(os.path.join(work, "lines_history.json"), "w"))
    env = dict(os.environ, CITO_API_KEY="test-key", CITO_BASE_URL=base, CITO_SPACING="0", PYTHONDONTWRITEBYTECODE="1")
    HITS.clear()
    r = subprocess.run([sys.executable, "cito_update.py"], cwd=work, env=env, capture_output=True, text=True)
    print("   cito_update output:", " | ".join(r.stdout.strip().splitlines()[-3:]), r.stderr[-300:])
    check("cito_update exits 0", r.returncode == 0)
    check("cito_update stays within 14 calls", 0 < len(HITS) <= 14)
    check("key never printed", "test-key" not in r.stdout + r.stderr)
    st = json.load(open(os.path.join(work, "team_strength.json")))
    check("team_strength.json has dated VRS + world lists", st["rankings"]["vrs"] and st["rankings"]["world"] and st["rankings"]["vrs"][0]["date"] == (TODAY - datetime.timedelta(days=3)).isoformat())
    check("alias-aware keys (Team Vitality -> vitality)", "vitality" in st["rankings"]["vrs"][0]["points"])
    check("map stats saved, out-of-pool map dropped", "mouz" in st["maps"] and "Cache" not in st["maps"]["mouz"][-1]["maps"]
          and st["maps"]["mouz"][-1]["maps"]["Anubis"] == [4, 88.0, 50.0])
    ids = json.load(open(os.path.join(work, "cito_ids.json")))
    check("team ids harvested from replies", ids["mouz"]["id"] == "cs2-team-4494" and ids["nexus"]["id"] == "cs2-team-7187")
    check("unknown team looked up once via /cs2/teams?q=", sum(1 for h in HITS if h[0] == "/api/v1/cs2/teams") == 1)
    idx = json.load(open(os.path.join(work, "cito_cache", "_results_index.json")))
    check("settle backup fetched the missing match", idx["matches"] and idx["matches"][0]["id"] == "cs2-match-2399854")
    s = open(os.path.join(work, "team_strength.json")).read()
    check("no raw replies / key in team_strength.json", "test-key" not in s and "playerStats" not in s)
    # settle reads the index (no network)
    spec = importlib.util.spec_from_file_location("settle_w", os.path.join(work, "settle.py"))
    cwd = os.getcwd(); os.chdir(work)
    try:
        sys.path.insert(0, work)
        m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        res = m.cito_result(entry)
        check("settle backup: Maps 1-2 kills from saved Cito data", res and res[1] == 43.0 and res[0] == "kills")
        e2 = dict(entry, player="nobody")
        check("settle backup: unknown player -> None", m.cito_result(e2) is None)
        e3 = dict(entry, team="G2", opponent="MOUZ", player="HeavyGod", stat="Headshots")
        check("settle backup: either team order, headshots", m.cito_result(e3)[1] == 12.0)
        ee = json.loads(json.dumps(entry))
        now = datetime.datetime.fromisoformat(start.replace("Z", "+00:00")) + datetime.timedelta(hours=30)
        changed = quiet(m.settle_entry, m_gr(work), ee, now)
        check("settle_entry uses the backup, marks src=cito, hit vs OVER 40.5", changed and ee["result"]["src"] == "cito" and ee["result"]["outcome"] == "hit")
    finally:
        os.chdir(cwd); sys.path.remove(work)
    # second run with no key: no calls, files unchanged
    HITS.clear()
    env2 = dict(env); env2.pop("CITO_API_KEY")
    before = open(os.path.join(work, "team_strength.json")).read()
    r = subprocess.run([sys.executable, "cito_update.py"], cwd=work, env=env2, capture_output=True, text=True)
    after = json.load(open(os.path.join(work, "team_strength.json")))
    check("no key: exit 0, zero calls, data kept", r.returncode == 0 and not HITS and after["rankings"] == json.loads(before)["rankings"] and after["maps"] == json.loads(before)["maps"])


def m_gr(work):
    from grader import Grader
    return Grader([], {})


def test_grader():
    from grader import Grader, load_strength, PARAMS
    pj = json.load(open("players.json", encoding="utf-8"))
    # 1) without team_strength the grader is exactly the committed one
    old_src = subprocess.run(["git", "show", "HEAD:grader.py"], capture_output=True, text=True).stdout
    tmpd = tempfile.mkdtemp()
    open(os.path.join(tmpd, "grader_head.py"), "w").write(old_src)
    spec = importlib.util.spec_from_file_location("grader_head", os.path.join(tmpd, "grader_head.py"))
    GH = importlib.util.module_from_spec(spec); spec.loader.exec_module(GH)
    G0, GN = GH.Grader(pj["players"], pj.get("ranks")), Grader(pj["players"], pj.get("ranks"), strength=None)
    GE = Grader(pj["players"], pj.get("ranks"), strength={"rankings": {}, "maps": {}})
    diff = 0
    for p in pj["players"][:400]:
        for st in ("kills", "hs"):
            opp = (p["logs"][0].get("opp") if p.get("logs") else "") or ""
            for before in ("9999", "2026-11-01"):
                a, b, c = G0.grade(p, st, 30.5 if st == "kills" else 14.5, opp, None, "PrizePicks", None, before), \
                    GN.grade(p, st, 30.5 if st == "kills" else 14.5, opp, None, "PrizePicks", None, before), \
                    GE.grade(p, st, 30.5 if st == "kills" else 14.5, opp, None, "PrizePicks", None, before)
                for x in (b, c):
                    if (a is None) != (x is None) or (a and any(a[k] != x[k] for k in a)):
                        diff += 1
    check("no Cito data -> grades identical to HEAD grader (1600 cases x2)", diff == 0)
    # 2) leakage: a snapshot dated D is not used for a match on D, only from D+1
    S = {"rankings": {"vrs": [{"date": "2026-11-10", "points": {"mouz": 2000, "g2": 1000}}]},
         "maps": {"mouz": [{"asof": "2026-11-10", "maps": {"Anubis": [10, 230, 100]}}]}}
    G = Grader([], {}, strength=S)
    check("ranking dated D not used on D", G.p_rank("MOUZ", "G2", "2026-11-10") is None)
    check("ranking dated D used from D+1", abs(G.p_rank("MOUZ", "G2", "2026-11-11") - 2 / 3) < 1e-9)
    check("map stats dated D not used on D", G.map_rounds("MOUZ", "G2", "2026-11-10", 21.0) is None)
    check("map stats used from D+1, shrunk to base", abs(G.map_rounds("MOUZ", "G2", "2026-11-11", 21.0) - (230 + 6 * 21) / 16) < 1e-9)
    G2 = Grader([], {}, params={"w_rank": 0, "w_maps": 0}, strength=S)
    check("w_rank=0 -> Elo win chance only", G2.pwin("MOUZ", "G2", "2026-11-11") == 0.5)


if __name__ == "__main__":
    srv, base = server()
    test_client(base)
    test_update(base)
    test_grader()
    srv.shutdown()
    print("\n%d failed" % len(FAILS) if FAILS else "\nall Cito tests passed")
    sys.exit(1 if FAILS else 0)
