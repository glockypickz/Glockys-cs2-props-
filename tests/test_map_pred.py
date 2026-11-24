"""Glocky map prediction: setting-split veto, confirmed override, JS parity. No files written."""
import json, os, sys, unittest, subprocess

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)
os.chdir(ROOT)

from grader import Grader
from map_pred import (MIN_SETTING_N, predict_match, pick_shares, soft_veto, veto_steps,
                      fallback_note, slot_label)
from scout_model import DEF

MAPS = ["Mirage", "Inferno", "Nuke", "Ancient", "Dust2", "Anubis", "Cache"]


def log(date, mid, n, opp, m, ev="online", team="Alpha"):
    return {"date": date, "mid": mid, "n": n, "map": m, "opp": opp, "kills": 12,
            "hs": 6, "d": 10, "a": 2, "adr": 80, "rd": 21, "ev": ev, "rw": 13}


def add_series(logs, mid, day, opp, m1, m2, ev="online"):
    logs += [log(day, mid, 1, opp, m1, ev), log(day, mid, 2, opp, m2, ev)]


def team_player(name, team, prefer, ev="online", start_mid=1, n_series=12, start_day=1):
    logs, mid = [], start_mid
    for i in range(n_series):
        d = "2026-10-%02d" % (start_day + i)
        m1 = prefer[i % len(prefer)]
        m2 = prefer[(i + 1) % len(prefer)]
        add_series(logs, mid, d, "Opp", m1, m2, ev)
        mid += 1
    return {"name": name, "team": team, "logs": logs}, mid


def world():
    """Alpha loves Mirage/Inferno online and Nuke on LAN. Beta loves Dust2/Ancient online, Cache on LAN."""
    a_on, mid = team_player("a1", "Alpha", ["Mirage", "Inferno", "Nuke"], "online", 1, 12, 1)
    a_lan, mid = team_player("a2", "AlphaLan", ["Nuke", "Nuke", "Ancient"], "lan", mid, 10, 14)
    # put LAN logs on Alpha himself so one player/team has both
    for i in range(10):
        d = "2026-10-%02d" % (14 + i)
        add_series(a_on["logs"], mid, d, "Beta", "Nuke", "Ancient", "lan")
        mid += 1
    b, mid = team_player("b1", "Beta", ["Dust2", "Ancient", "Cache"], "online", mid, 12, 1)
    for i in range(10):
        d = "2026-10-%02d" % (14 + i)
        add_series(b["logs"], mid, d, "Alpha", "Cache", "Cache", "lan")
        mid += 1
    # filler so the 7-map pool is active
    c, _ = team_player("c1", "Gamma", MAPS, "online", mid, 14, 1)
    return a_on, b, c


class VetoShape(unittest.TestCase):
    def test_bo3_seven_maps_standard_order(self):
        s = veto_steps(7, 3)
        kinds = [x[0] for x in s]
        self.assertEqual(kinds, ["ban", "ban", "pick", "pick", "ban", "ban", "left"])
        self.assertEqual(s[2][2], 1)
        self.assertEqual(s[3][2], 2)
        self.assertEqual(s[-1][1], 3)

    def test_bo1_only_slot_one(self):
        s = veto_steps(7, 1)
        self.assertEqual(s[-1], ("left", 1))
        self.assertEqual(sum(1 for x in s if x[0] == "ban"), 6)

    def test_bo3_three_maps_is_pick_pick_left(self):
        s = veto_steps(3, 3)
        self.assertEqual([x[0] for x in s], ["pick", "pick", "left"])


class Prediction(unittest.TestCase):
    def setUp(self):
        self.a, self.b, self.c = world()
        self.g = Grader([self.a, self.b, self.c], {"Alpha": 8, "Beta": 9, "Gamma": 10})
        self.S = self.g._scout()

    def test_slots_sum_to_one_and_are_deterministic(self):
        p1 = predict_match(self.S, "Alpha", "Beta", "2026-11-01", bo=3, ev="online")
        p2 = predict_match(self.S, "Alpha", "Beta", "2026-11-01", bo=3, ev="online")
        self.assertEqual(p1["pred"], p2["pred"])
        self.assertGreaterEqual(len(p1["slots"]), 3)
        for sl, dist in p1["slot_w"].items():
            self.assertAlmostEqual(sum(dist.values()), 1.0, places=6, msg="slot %s" % sl)
        self.assertIn(1, p1["pred"])
        self.assertIn(p1["pred"][1], MAPS)

    def test_lan_differs_from_online_when_both_have_history(self):
        onl = predict_match(self.S, "Alpha", "Beta", "2026-11-01", bo=3, ev="online")
        lan = predict_match(self.S, "Alpha", "Beta", "2026-11-01", bo=3, ev="lan")
        self.assertFalse(onl["fallback"])
        self.assertFalse(lan["fallback"])
        self.assertNotEqual(onl["pred"], lan["pred"])
        # LAN history is Nuke / Cache heavy
        self.assertIn(lan["pred"][1], ("Nuke", "Ancient", "Cache"))
        note = fallback_note(onl)
        self.assertIn("online", note)
        self.assertNotIn("too few", note)

    def test_thin_setting_falls_back(self):
        # Gamma has no LAN maps
        pred = predict_match(self.S, "Alpha", "Gamma", "2026-11-01", bo=3, ev="lan")
        sides = {r["team"]: r for r in pred["fallback"]}
        self.assertIn("Gamma", sides)
        self.assertEqual(sides["Gamma"]["used"], "all")
        self.assertLess(sides["Gamma"]["n_setting"], MIN_SETTING_N)
        self.assertIn("too few LAN", fallback_note(pred))

    def test_confirmed_overrides(self):
        pred = predict_match(self.S, "Alpha", "Beta", "2026-11-01", bo=3, ev="online",
                             confirmed=["Train", "Overpass"])
        self.assertTrue(pred["confirmed"])
        self.assertEqual(pred["src"], "confirmed")
        self.assertEqual(pred["pred"][1], "Train")
        self.assertEqual(pred["pred"][2], "Overpass")
        self.assertEqual(pred["slots"][1][0]["pct"], 100)

    def test_no_lookahead(self):
        p1 = predict_match(self.S, "Alpha", "Beta", "2026-11-01", bo=3, ev="online")
        extra = dict(self.a)
        extra["logs"] = self.a["logs"] + [
            log("2026-11-05", 9999, 1, "Beta", "Train", "online"),
            log("2026-11-05", 9999, 2, "Beta", "Train", "online"),
        ]
        g2 = Grader([extra, self.b, self.c], {"Alpha": 8, "Beta": 9, "Gamma": 10})
        p2 = predict_match(g2._scout(), "Alpha", "Beta", "2026-11-01", bo=3, ev="online")
        self.assertEqual(p1["pred"], p2["pred"])
        for sl in p1["slot_w"]:
            for m, v in p1["slot_w"][sl].items():
                self.assertAlmostEqual(v, p2["slot_w"][sl][m], places=6)

    def test_map_blend_uses_slot_weights_and_setting(self):
        d_on = self.g.v1_project_parts(self.a, "kills", "Beta", "2026-11-01", period="Map 1", ev="online")
        d_lan = self.g.v1_project_parts(self.a, "kills", "Beta", "2026-11-01", period="Map 1", ev="lan")
        d_full = self.g.v1_project_parts(self.a, "kills", "Beta", "2026-11-01", period="Map 1", ev="online", veto_mode="full_pool")
        self.assertEqual(d_on["map"]["src"], "veto")
        self.assertNotEqual(d_on["map"]["weights"], d_lan["map"]["weights"])
        self.assertNotEqual(d_on["map"]["weights"], d_full["map"]["weights"])
        # known maps still win
        d_k = self.g.v1_project_parts(self.a, "kills", "Beta", "2026-11-01", period="Map 1", ev="lan", maps=["Mirage"])
        self.assertEqual(d_k["map"]["src"], "known")
        self.assertEqual(d_k["map"]["maps"], ["Mirage"])

    def test_slot_label(self):
        self.assertEqual(slot_label(3, 3), "Map 3 (decider)")
        self.assertEqual(slot_label(1, 1), "Map 1")


class JsParity(unittest.TestCase):
    def test_predict_and_blend_match_js(self):
        a, b, c = world()
        g = Grader([a, b, c], {"Alpha": 8, "Beta": 9, "Gamma": 10})
        py = predict_match(g._scout(), "Alpha", "Beta", "2026-11-01", bo=3, ev="online")
        py_b = g.v1_project_parts(a, "kills", "Beta", "2026-11-01", period="Map 1", ev="online")
        script = r"""
const M=require('./model.js');
const a=%s, b=%s, c=%s;
const ctx=M.build([a,b,c], null, null, %s);
const pred=M.predictMaps(ctx,'Alpha','Beta','2026-11-01',3,'online',[]);
const d=M.v1ProjectParts(ctx,a,'kills','Beta','2026-11-01','Map 1','online',null,3);
process.stdout.write(JSON.stringify({pred:pred.pred, slotW:pred.slotW, fallback:pred.fallback, proj:d.proj, w:d.map.weights, src:d.map.src}));
""" % (json.dumps(a), json.dumps(b), json.dumps(c), json.dumps({"Alpha": 8, "Beta": 9, "Gamma": 10}))
        js = json.loads(subprocess.check_output(["node", "-e", script], cwd=ROOT, text=True))
        self.assertEqual(js["src"], "veto")
        self.assertEqual({int(k): v for k, v in js["pred"].items()}, py["pred"])
        self.assertAlmostEqual(js["proj"], py_b["proj"], places=6)
        for sl, dist in py["slot_w"].items():
            for m, v in dist.items():
                self.assertAlmostEqual(v, js["slotW"][str(sl)][m], places=6)


if __name__ == "__main__":
    unittest.main()
