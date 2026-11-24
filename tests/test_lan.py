"""LAN data (grader.py lan_data / model.js): LAN-match props use the player's LAN games for every v1 input,
blended with overall when thin. Synthetic data only; does not read or write lines_history.json."""
import json, os, subprocess, sys, unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)
from grader import Grader


def log(date, mid, n, opp, kills, ev, adr=80, rd=16):
    return {"date": date, "mid": mid, "n": n, "map": "Mirage", "opp": opp, "kills": kills, "hs": kills // 2,
            "d": 10, "a": 2, "adr": adr, "rd": rd, "ev": ev}


def make(n_lan=4, n_online=14):
    """Online series: 20 + 20 kills (40). LAN series: 15 + 15 (30). LAN ones are the oldest, then online, so L10 has no LAN."""
    logs, mid, day = [], 100, 1
    for i in range(n_lan):
        d = "2026-09-%02d" % (day); day += 1
        logs += [log(d, mid, 1, "G2" if i == 0 else "MOUZ", 15, "lan", adr=70), log(d, mid, 2, "G2" if i == 0 else "MOUZ", 15, "lan", adr=70)]
        mid += 1
    day = 1
    for i in range(n_online):
        d = "2026-10-%02d" % (day); day += 1
        logs += [log(d, mid, 1, "G2" if i == 0 else "NAVI", 20, "online", adr=90), log(d, mid, 2, "G2" if i == 0 else "NAVI", 20, "online", adr=90)]
        mid += 1
    return {"name": "donk", "team": "Spirit", "logs": logs}


RANKS = {"G2": 3, "MOUZ": 4, "NAVI": 5, "Vitality": 1}


class LanParts(unittest.TestCase):
    def setUp(self):
        self.p = make()
        self.g = Grader([self.p], RANKS, params={"map_data": 0})

    def part(self, d, k):
        return [x for x in d["parts"] if x["key"] == k][0]

    def test_off_is_unchanged(self):
        a = self.g.v1_project_parts(self.p, "kills", "G2", "2026-11-01")
        b = self.g.v1_project_parts(self.p, "kills", "G2", "2026-11-01", ev="online")
        g0 = Grader([self.p], RANKS, params={"lan_data": 0, "map_data": 0})
        c = g0.v1_project_parts(self.p, "kills", "G2", "2026-11-01", ev="lan")
        self.assertAlmostEqual(a["proj"], b["proj"]); self.assertAlmostEqual(a["proj"], c["proj"])
        self.assertFalse(a["lan"]["used"]); self.assertFalse(c["lan"]["used"])

    def test_blend_rule(self):
        d = self.g.v1_project_parts(self.p, "kills", "G2", "2026-11-01", ev="lan")
        self.assertTrue(d["lan"]["used"]); self.assertEqual(d["lan"]["n"], 4)
        all_szn = (4 * 30 + 14 * 40) / 18.0
        # season: (n * LAN + 5 * overall) / (n + 5) with n = 4 LAN series
        self.assertAlmostEqual(self.part(d, "szn")["v"], (4 * 30 + 5 * all_szn) / 9.0)
        # L10: 4 LAN series fill 4 of 10 slots, the overall L10 (40) the other 6
        self.assertAlmostEqual(self.part(d, "l10")["v"], (4 * 30 + 6 * 40) / 10.0)
        # L3: 3 LAN series of 3 slots = pure LAN
        self.assertAlmostEqual(self.part(d, "l3")["v"], 30.0)
        # h2h from one LAN meeting vs G2: (1 * 30 + 5 * overall h2h 35) / 6
        self.assertAlmostEqual(self.part(d, "h2h")["v"], (30 + 5 * 35.0) / 6.0)
        self.assertEqual(self.part(d, "h2h")["n_lan"], 1)
        self.assertIn("LAN data", self.part(d, "l10")["label"])
        # ADR nudge from LAN rows (3+ of the last 5 LAN series have ADR): 70 vs 70 = no nudge
        self.assertTrue(d["lan"]["adr_lan"]); self.assertAlmostEqual(d["adr_mult"], 1.0)

    def test_weights_unchanged(self):
        d = self.g.v1_project_parts(self.p, "kills", "G2", "2026-11-01", ev="lan")
        self.assertEqual([x["w"] for x in d["parts"]], [0.35, 0.20, 0.20, 0.15, 0.10])

    def test_no_lan_history_is_overall(self):
        p = make(n_lan=0)
        g = Grader([p], RANKS, params={"map_data": 0})
        a = g.v1_project_parts(p, "kills", "NAVI", "2026-11-01")
        b = g.v1_project_parts(p, "kills", "NAVI", "2026-11-01", ev="lan")
        self.assertAlmostEqual(a["proj"], b["proj"])

    def test_no_lookahead(self):
        p = make()
        p["logs"] += [log("2026-11-05", 999, 1, "NAVI", 60, "lan"), log("2026-11-05", 999, 2, "NAVI", 60, "lan")]
        g = Grader([p], RANKS, params={"map_data": 0})
        a = self.g.v1_project_parts(self.p, "kills", "G2", "2026-11-01", ev="lan")
        b = g.v1_project_parts(p, "kills", "G2", "2026-11-01", ev="lan")
        self.assertAlmostEqual(a["proj"], b["proj"])

    def test_map1_uses_lan_map1s(self):
        p = make()
        for l in p["logs"]:
            if l["n"] == 1 and l["ev"] == "lan":
                l["kills"] = 9
        g = Grader([p], RANKS, params={"map_data": 0})
        d = g.v1_project_parts(p, "kills", "G2", "2026-11-01", period="Map 1", ev="lan")
        self.assertAlmostEqual(self.part(d, "l3")["v"], 9.0)
        self.assertIn("Map 1", self.part(d, "l10")["label"])


class MatchEv(unittest.TestCase):
    def setUp(self):
        a = make(); b = make(); b["name"] = "m0NESY"; b["team"] = "G2"
        self.g = Grader([a, b], RANKS)

    def test_games_json_first(self):
        games = [{"team1": "Spirit", "team2": "G2", "start": "2026-11-20T15:00:00Z", "ev": "lan"}]
        self.assertEqual(self.g.match_ev("Spirit", "G2", "2026-11-20T18:00:00Z", games=games), ("lan", "games"))

    def test_three_day_rule(self):
        # Spirit's newest map is online on 2026-10-14
        self.assertEqual(self.g.match_ev("Spirit", "G2", "2026-10-16", games=[]), ("online", "recent maps"))
        self.assertEqual(self.g.match_ev("Spirit", "G2", "2026-10-20", games=[]), (None, None))
        self.assertEqual(self.g.match_ev("Spirit", "G2", "2026-09-05", games=[]), ("lan", "recent maps"))


class JsParity(unittest.TestCase):
    def test_js_matches_python(self):
        p = make()
        cases = [("kills", "G2", "2026-11-01", None, "lan"), ("hs", "G2", "2026-11-01", None, "lan"),
                 ("kills", "MOUZ", "2026-11-01", "Map 1", "lan"), ("kills", "G2", "2026-11-01", None, None)]
        js = r"""const M=require('./model.js');const a=JSON.parse(require('fs').readFileSync(0,'utf8'));const ctx=M.build([a.p],{map_data:0},null,a.r);
process.stdout.write(JSON.stringify({d:a.c.map(c=>{const d=M.v1ProjectParts(ctx,a.p,c[0],c[1],c[2],c[3],c[4]);return d?d.proj:null}),
 e:[M.matchEv(ctx,'Spirit','G2','2026-10-16',[]),M.matchEv(ctx,'Spirit','G2','2026-09-05',[])]}))"""
        r = subprocess.run(["node", "-e", js], input=json.dumps({"p": p, "r": RANKS, "c": cases}), capture_output=True, text=True, cwd=ROOT, check=True)
        out = json.loads(r.stdout)
        g = Grader([p], RANKS, params={"map_data": 0})
        for c, j in zip(cases, out["d"]):
            self.assertAlmostEqual(g.v1_project_parts(p, c[0], c[1], c[2], period=c[3], ev=c[4])["proj"], j, places=6)
        self.assertEqual(out["e"], [["online", "recent maps"], ["lan", "recent maps"]])


if __name__ == "__main__":
    unittest.main()
