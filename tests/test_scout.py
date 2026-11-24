"""Shadow S (scout_model.py): no look-ahead, owner rules, Map 1 scope, and shadow_s never touching the live lock."""
import copy, datetime, json, os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.chdir(os.path.join(os.path.dirname(__file__), ".."))
from grader import Grader
import scout_model as SM
import shadow

MAPS = ["Mirage", "Inferno", "Nuke", "Ancient", "Dust2", "Anubis", "Train"]


def logs_for(team_i, opp, day0=1, n_series=14, kill=18, ev="online"):
    out = []
    for i in range(n_series):
        d = "2026-10-%02d" % (day0 + i)
        mid = 1000 * team_i + i
        for n in (1, 2):
            out.append({"date": d, "mid": mid, "n": n, "map": MAPS[(i + n) % 7], "opp": opp if i % 3 else "Other",
                        "kills": kill + (i % 4) - n, "hs": 8 + (i % 3), "d": 15, "a": 3, "adr": 80, "rd": 22, "rw": 13 if i % 2 else 9,
                        "ev": ev})
    return out


def world():
    pl = []
    for j in range(5):
        pl.append({"name": "a%d" % j, "team": "Alpha", "logs": logs_for(1, "Beta", kill=17 + j)})
        pl.append({"name": "b%d" % j, "team": "Beta", "logs": logs_for(2, "Alpha", kill=15 + j)})
    return pl


class ScoutTests(unittest.TestCase):
    def setUp(self):
        self.pl = world()
        self.gr = Grader(self.pl, {"Alpha": 10, "Beta": 20})
        self.S = SM.ScoutData(self.pl, self.gr)

    def test_no_lookahead(self):
        p = self.pl[0]
        f1 = SM.features(self.S, p, "Alpha", "Beta", "2026-10-10", "Maps 1-2", "online")
        pl2 = copy.deepcopy(self.pl)
        for l in pl2[0]["logs"]:
            if l["date"] >= "2026-10-10":
                l["kills"] = 60   # changing the match day or later must not move the projection
        gr2 = Grader(pl2, {"Alpha": 10, "Beta": 20})
        f2 = SM.features(SM.ScoutData(pl2, gr2), pl2[0], "Alpha", "Beta", "2026-10-10", "Maps 1-2", "online")
        self.assertAlmostEqual(f1["kpr"], f2["kpr"], places=9)
        self.assertAlmostEqual(f1["x_opp"], f2["x_opp"], places=9)

    def test_lan_data(self):
        # first 7 series LAN at 30 kills, rest online: LAN data pulls the form toward the LAN maps, off = unchanged
        pl = copy.deepcopy(self.pl)
        for l in pl[0]["logs"]:
            if l["date"] < "2026-10-08":
                l["ev"], l["kills"] = "lan", 30
        gr = Grader(pl, {"Alpha": 10, "Beta": 20})
        S = SM.ScoutData(pl, gr)
        on = SM.features(S, pl[0], "Alpha", "Beta", "2026-10-14", "Maps 1-2", "lan")
        off = SM.features(S, pl[0], "Alpha", "Beta", "2026-10-14", "Maps 1-2", "lan", P={"lan_data": 0})
        onl = SM.features(S, pl[0], "Alpha", "Beta", "2026-10-14", "Maps 1-2", "online")
        self.assertTrue(on["lan_data"]); self.assertFalse(off["lan_data"]); self.assertEqual(on["n_lan_maps"], 14)
        self.assertGreater(on["kpr"], off["kpr"])
        self.assertAlmostEqual(off["kpr"], onl["kpr"], places=12)
        # no look-ahead: LAN maps on or after the match day do not count
        pl2 = copy.deepcopy(pl)
        for l in pl2[0]["logs"]:
            if l["date"] >= "2026-10-14":
                l["ev"], l["kills"] = "lan", 60
        gr2 = Grader(pl2, {"Alpha": 10, "Beta": 20})
        on2 = SM.features(SM.ScoutData(pl2, gr2), pl2[0], "Alpha", "Beta", "2026-10-14", "Maps 1-2", "lan")
        self.assertAlmostEqual(on["kpr"], on2["kpr"], places=12)

    def test_owner_rules(self):
        cfg = SM.load_params()
        self.assertIsNotNone(cfg, "scout_params.json missing")
        self.assertGreater(cfg["hyper"]["w_szn"], 0)          # season window always counts
        self.assertGreater(cfg["hyper"]["w_h2h"], 0)
        # one prior meeting is enough for head-to-head
        p = {"name": "x", "team": "Alpha", "logs": [dict(l, opp="Other") for l in logs_for(3, "Other")]}
        p["logs"][0]["opp"] = "Beta"
        gr = Grader([p], {})
        f = SM.features(SM.ScoutData([p], gr), p, "Alpha", "Beta", "2026-10-30", "Maps 1-2")
        self.assertEqual(f["n_h2h_maps"], 1)
        self.assertIsNotNone(f["kpr_h2h"])

    def test_blowout_state_and_no_lookahead(self):
        self.assertEqual(SM.blow_state({"rd": 18, "rw": 13}, 8), "bw")    # 13-5
        self.assertEqual(SM.blow_state({"rd": 19, "rw": 6}, 8), "cl")     # 6-13
        self.assertEqual(SM.blow_state({"rd": 18, "rw": 5}, 8), "bl")     # 5-13
        p = self.pl[0]
        f1 = SM.features(self.S, p, "Alpha", "Beta", "2026-10-10", "Maps 1-2")
        pl2 = copy.deepcopy(self.pl)
        for l in pl2[0]["logs"]:
            if l["date"] >= "2026-10-10":
                l["rw"], l["kills"] = 13, 50
        gr2 = Grader(pl2, {"Alpha": 10, "Beta": 20})
        f2 = SM.features(SM.ScoutData(pl2, gr2), pl2[0], "Alpha", "Beta", "2026-10-10", "Maps 1-2")
        self.assertAlmostEqual(f1["x_blow"], f2["x_blow"], places=9)
        self.assertEqual(f1["blow"], f2["blow"])

    def test_map1_scope(self):
        p = self.pl[0]
        f12 = SM.features(self.S, p, "Alpha", "Beta", "2026-10-12", "Maps 1-2")
        f1 = SM.features(self.S, p, "Alpha", "Beta", "2026-10-12", "Map 1")
        self.assertEqual(f12["nmaps"], 2)
        self.assertEqual(f1["nmaps"], 1)
        m12, _ = SM.project(f12, "kills")
        m1, _ = SM.project(f1, "kills")
        self.assertAlmostEqual(m12, 2 * m1, places=6)

    def test_shadow_s_never_touches_lock(self):
        e = {"book": "PrizePicks", "player": "a0", "team": "Alpha", "opponent": "Beta", "stat": "Kills",
             "start": "2026-10-20T18:00:00Z", "line": 30.5,
             "lock": {"line": 30.5, "proj": 31.0, "grade": "C", "pick": "OVER", "model": "v1be"}}
        before = copy.deepcopy(e["lock"])
        now = datetime.datetime(2026, 10, 20, 12, tzinfo=datetime.timezone.utc)
        t0 = datetime.datetime(2026, 10, 20, 18, tzinfo=datetime.timezone.utc)
        shadow.apply(self.gr, e, now, t0)
        self.assertEqual(e["lock"], before)
        s = e.get("shadow_s")
        self.assertIsNotNone(s)
        if not s.get("skipped"):
            self.assertIn(s["grade"], ("A+", "B", "C", "D", "F"))
            self.assertTrue(s["steps"])
        first = copy.deepcopy(s)
        e["line"] = 40.5
        shadow.apply(self.gr, e, now, t0)              # second run: saved once, not overwritten
        self.assertEqual(e["shadow_s"], first)
        e2 = {k: v for k, v in e.items() if k != "shadow_s"}
        shadow.apply(self.gr, e2, t0 + datetime.timedelta(minutes=1), t0)   # started: nothing written
        self.assertNotIn("shadow_s", e2)


if __name__ == "__main__":
    unittest.main()
