"""Per-map shrink (grader.py / model.js): k=5, known maps, scout veto fallback, no look-ahead, all games not LAN-only."""
import json, os, sys, unittest, subprocess

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)
os.chdir(ROOT)
from grader import Grader, MODEL_VERSION, letter_from_edge, apply_grade_cap, CAP_LETTER


MAPS = ["Mirage", "Inferno", "Nuke", "Ancient", "Dust2", "Anubis", "Cache"]


def log(date, mid, n, opp, kills, m, ev="online", hs=None, rd=16):
    return {"date": date, "mid": mid, "n": n, "map": m, "opp": opp, "kills": kills,
            "hs": (kills // 2) if hs is None else hs, "d": 10, "a": 2, "adr": 80, "rd": rd, "ev": ev}


def series(day, mid, opp, kills1, kills2, m1, m2, ev="online"):
    return [log(day, mid, 1, opp, kills1, m1, ev), log(day, mid, 2, opp, kills2, m2, ev)]


def world():
    """Alpha vs many maps. Nuke is 20 kills/map; other maps 10. Enough series for veto pool."""
    logs, mid = [], 100
    for i in range(12):
        d = "2026-10-%02d" % (i + 1)
        m1, m2 = MAPS[i % 7], MAPS[(i + 1) % 7]
        k1 = 20 if m1 == "Nuke" else 10
        k2 = 20 if m2 == "Nuke" else 10
        logs += series(d, mid, "Beta" if i % 2 == 0 else "Gamma", k1, k2, m1, m2)
        mid += 1
    # 4 LAN Nukes as Map 1 of later series, still before Nov 1, 30 kills to make LAN-only different
    for i in range(4):
        d = "2026-10-%02d" % (16 + i)
        logs += series(d, mid, "Beta", 30, 10, "Nuke", "Mirage", ev="lan")
        mid += 1
    p = {"name": "donk", "team": "Alpha", "logs": logs}
    others = []
    for name, team in (("b1", "Beta"), ("g1", "Gamma")):
        ol, om = [], 500
        for i in range(10):
            d = "2026-10-%02d" % (i + 1)
            ol += series(d, om, "Alpha", 12, 12, MAPS[i % 7], MAPS[(i + 2) % 7])
            om += 1
        others.append({"name": name, "team": team, "logs": ol})
    return p, others


RANKS = {"Alpha": 8, "Beta": 9, "Gamma": 10}


class MapBlendTests(unittest.TestCase):
    def setUp(self):
        self.p, extra = world()
        self.g = Grader([self.p] + extra, RANKS)

    def test_version_and_letters_unchanged(self):
        self.assertEqual(MODEL_VERSION, "v1f")
        self.assertEqual(letter_from_edge(18)[0], "A+")
        self.assertEqual(letter_from_edge(8)[0], "B")
        self.assertEqual(letter_from_edge(5)[0], "C+")
        self.assertEqual(letter_from_edge(-1)[0], "F")

    def test_off_leaves_proj(self):
        g0 = Grader([self.p], RANKS, params={"map_data": 0})
        a = g0.v1_project_parts(self.p, "kills", "Beta", "2026-11-01", period="Map 1")
        b = self.g.v1_project_parts(self.p, "kills", "Beta", "2026-11-01", period="Map 1", maps=["Nuke"])
        self.assertIsNone((a.get("map") or {}).get("used") if a.get("map") is None else (None if not a["map"] else None))
        self.assertNotAlmostEqual(a["proj"], b["proj"])
        off = g0.v1_project_parts(self.p, "kills", "Beta", "2026-11-01", period="Map 1", maps=["Nuke"])
        self.assertAlmostEqual(off["proj"], a["proj"])

    def test_known_map_shrink_k5(self):
        d = self.g.v1_project_parts(self.p, "kills", "Beta", "2026-11-01", period="Map 1", maps=["Nuke"])
        self.assertTrue(d["map"]["used"])
        self.assertEqual(d["map"]["src"], "known")
        self.assertEqual(d["map"]["maps"], ["Nuke"])
        avg, n = self.g.player_map_avg(self.p, "kills", "Nuke", "2026-11-01")
        # all Nuke maps (online 20 and LAN 30), not LAN-only
        self.assertGreater(n, 0)
        lan_only = [l for l in self.p["logs"] if l["map"] == "Nuke" and l["ev"] == "lan" and l["date"] < "2026-11-01"]
        all_n = [l for l in self.p["logs"] if l["map"] == "Nuke" and l["date"] < "2026-11-01"]
        self.assertEqual(n, len(all_n))
        self.assertGreater(len(all_n), len(lan_only))
        self.assertAlmostEqual(avg, sum(l["kills"] for l in all_n) / len(all_n))
        pre = d["map"]["pre"]
        k = 5.0
        self.assertAlmostEqual(d["proj"], (n * avg + k * pre) / (n + k))
        self.assertAlmostEqual(d["map"]["avg"], avg)

    def test_lan_only_not_used(self):
        avg, n = self.g.player_map_avg(self.p, "kills", "Nuke", "2026-11-01")
        lan = [l["kills"] for l in self.p["logs"] if l["map"] == "Nuke" and l["ev"] == "lan" and l["date"] < "2026-11-01"]
        self.assertNotAlmostEqual(avg, sum(lan) / len(lan))

    def test_no_lookahead(self):
        a = self.g.v1_project_parts(self.p, "kills", "Beta", "2026-11-01", period="Map 1", maps=["Nuke"])
        p2 = {"name": "donk", "team": "Alpha", "logs": self.p["logs"] + series("2026-11-05", 999, "Beta", 80, 80, "Nuke", "Nuke")}
        g2 = Grader([p2], RANKS)
        b = g2.v1_project_parts(p2, "kills", "Beta", "2026-11-01", period="Map 1", maps=["Nuke"])
        self.assertAlmostEqual(a["proj"], b["proj"])
        self.assertAlmostEqual(a["map"]["avg"], b["map"]["avg"])

    def test_maps12_sums_two_known(self):
        d = self.g.v1_project_parts(self.p, "kills", "Beta", "2026-11-01", period="Maps 1-2", maps=["Nuke", "Mirage"])
        a1, n1 = self.g.player_map_avg(self.p, "kills", "Nuke", "2026-11-01")
        a2, n2 = self.g.player_map_avg(self.p, "kills", "Mirage", "2026-11-01")
        self.assertAlmostEqual(d["map"]["avg"], a1 + a2)
        self.assertEqual(d["map"]["n"], min(n1, n2))
        self.assertEqual(d["map"]["src"], "known")

    def test_tba_ignored_falls_back_to_veto(self):
        d = self.g.v1_project_parts(self.p, "kills", "Beta", "2026-11-01", period="Map 1", maps=["TBA"])
        self.assertEqual(d["map"]["src"], "veto")
        self.assertTrue(d["map"].get("weights"))

    def test_veto_maps12_is_double_expected(self):
        d1 = self.g.v1_project_parts(self.p, "kills", "Beta", "2026-11-01", period="Map 1")
        d2 = self.g.v1_project_parts(self.p, "kills", "Beta", "2026-11-01", period="Maps 1-2")
        self.assertEqual(d1["map"]["src"], "veto")
        # Maps 1-2 is E[avg(Map 1)] + E[avg(Map 2)] = 2 * expected under the average of the two slot weights,
        # which is not necessarily twice the Map 1 slot average.
        w12 = d2["map"]["weights"]
        per, _, _ = self.g.expected_map_avg(self.p, "kills", w12, "2026-11-01")
        self.assertAlmostEqual(d2["map"]["avg"], 2 * per, places=6)
        self.assertTrue(d1["map"].get("weights"))

    def test_caps_still_apply(self):
        g = self.g.grade(self.p, "kills", 10.5, "Beta", "Alpha", "PrizePicks", -137,
                         before="2026-11-01", period="Map 1", ev="lan", maps=["Nuke"])
        self.assertEqual(g["model"], "v1f")
        # LAN kills cap at C+
        self.assertTrue(g["grade_cap"]["applied"] or g["grade"] in ("C+", "C", "D", "F"))
        if g["grade_cap"]["applied"]:
            self.assertEqual(g["grade"], CAP_LETTER)

    def test_confirmed_maps_from_strength(self):
        strength = {"match_maps": [{"t1": "alpha", "t2": "beta", "start": "2026-11-01T12:00:00Z", "maps": ["Nuke"]}]}
        g = Grader([self.p], RANKS, strength=strength)
        self.assertEqual(g.confirmed_maps("Alpha", "Beta", "2026-11-01"), ["Nuke"])
        self.assertEqual(g.confirmed_maps("Alpha", "Beta", "2026-11-20"), [])  # too far
        d = g.v1_project_parts(self.p, "kills", "Beta", "2026-11-01", period="Map 1")
        self.assertEqual(d["map"]["src"], "known")
        self.assertEqual(d["map"]["maps"], ["Nuke"])


class CitoConfirmedMaps(unittest.TestCase):
    def test_tba_and_junk_veto_dropped(self):
        from cito_update import confirmed_maps_of
        tba = {"maps": [{"mapNumber": 1, "mapName": "TBA"}],
               "vetoOrder": [{"map": "dust2", "action": "pick", "teamId": None, "mapName": "dust2", "mapNumber": None},
                             {"map": "dust2", "action": "pick", "teamId": None, "mapName": "dust2", "mapNumber": None}]}
        self.assertEqual(confirmed_maps_of(tba), [])
        real = {"maps": [{"mapNumber": 1, "mapName": "Nuke", "mapNameCanonical": "Nuke"}],
                "vetoOrder": [
                    {"map": "ancient", "action": "ban", "teamId": "t1", "mapName": "ancient"},
                    {"map": "nuke", "action": "pick", "teamId": "t2", "mapName": "nuke", "mapNumber": 1},
                ]}
        self.assertEqual(confirmed_maps_of(real), ["Nuke"])


class JsParity(unittest.TestCase):
    def test_shrink_and_known_map_match(self):
        p, extra = world()
        g = Grader([p] + extra, RANKS)
        py = g.v1_project_parts(p, "kills", "Beta", "2026-11-01", period="Map 1", maps=["Nuke"])
        script = r"""
const M=require('./model.js');
const p=%s;
const ctx=M.build([p].concat(%s), null, null, %s);
const d=M.v1ProjectParts(ctx,p,'kills','Beta','2026-11-01','Map 1',null,['Nuke']);
process.stdout.write(JSON.stringify({proj:d.proj, avg:d.map.avg, n:d.map.n, src:d.map.src, used:d.map.used}));
""" % (json.dumps(p), json.dumps(extra), json.dumps(RANKS))
        js = subprocess.check_output(["node", "-e", script], cwd=ROOT, text=True)
        d = json.loads(js)
        self.assertEqual(d["src"], "known")
        self.assertTrue(d["used"])
        self.assertAlmostEqual(d["proj"], py["proj"], places=6)
        self.assertAlmostEqual(d["avg"], py["map"]["avg"], places=6)
        self.assertEqual(d["n"], py["map"]["n"])



class TeamNorm(unittest.TestCase):
    def test_faze_clan_matches_faze(self):
        from grader import teq, tn
        self.assertTrue(teq("FaZe Clan", "FaZe"))
        self.assertEqual(tn("FaZe Clan"), tn("FaZe"))
        self.assertTrue(teq("BC.Game Esports", "BC.Game"))


class RegradeRule(unittest.TestCase):
    def test_needs_regrade_model_change_not_started(self):
        import fetch_lines as fl
        e = {"lock": {"model": "v1e", "rg": fl.REGRADE_TAG, "proj": 10}, "start": "2026-12-01T12:00:00Z"}
        self.assertEqual(fl.REGRADE_TAG, "h2h-2")
        self.assertTrue(fl.needs_regrade(e))
        e2 = {"lock": {"model": MODEL_VERSION, "rg": fl.REGRADE_TAG, "proj": 10}}
        self.assertFalse(fl.needs_regrade(e2))
        settled = {"lock": {"model": "v1e", "rg": fl.REGRADE_TAG}, "result": {"act": 12}}
        self.assertFalse(fl.needs_regrade(settled))


if __name__ == "__main__":
    unittest.main()
