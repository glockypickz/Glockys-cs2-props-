"""Map 1 ingestion tags, grading, and settling. Does not rewrite lines_history.json."""
import copy, datetime, json, os, sys, tempfile, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from grader import Grader, period_of, is_map1, hist_key, PERIOD_12, PERIOD_MAP1
import settle


def log(date, mid, n, opp, kills, hs=None, rd=16, d=10, adr=80, mmap="Mirage"):
    return {"date": date, "mid": mid, "n": n, "map": mmap, "opp": opp,
            "kills": kills, "hs": hs if hs is not None else max(0, kills // 2),
            "d": d, "a": 2, "adr": adr, "rd": rd}


def player(name="donk", team="Spirit", logs=None):
    return {"name": name, "team": team, "logs": logs or []}


class PeriodTests(unittest.TestCase):
    def test_defaults_and_map1(self):
        self.assertEqual(period_of({}), PERIOD_12)
        self.assertEqual(period_of({"period": "Maps 1-2"}), PERIOD_12)
        self.assertEqual(period_of({"period": "Map 1"}), PERIOD_MAP1)
        self.assertEqual(period_of("map_1"), PERIOD_MAP1)
        self.assertFalse(is_map1({"period": "Maps 1-2"}))
        self.assertTrue(is_map1({"period": "Map 1"}))

    def test_hist_key_separates_periods(self):
        a = {"book": "PrizePicks", "player": "donk", "stat": "Kills", "start": "2026-11-24T18:00:00Z"}
        b = dict(a, period="Map 1")
        self.assertNotEqual(hist_key(a), hist_key(b))
        self.assertEqual(hist_key(a)[-1], PERIOD_12)


class GradeMap1Tests(unittest.TestCase):
    def setUp(self):
        logs = []
        for i, (k1, k2) in enumerate([
            (20, 18), (15, 14), (22, 19), (11, 16), (18, 17),
            (16, 15), (19, 12), (14, 20), (17, 13), (21, 18),
            (13, 14), (18, 16),
        ]):
            day = "2026-10-%02d" % (i + 1)
            logs += [log(day, 1000 + i, 1, "G2", k1, hs=k1 // 2, adr=85 + i),
                     log(day, 1000 + i, 2, "G2", k2, hs=k2 // 2, adr=80)]
        # one extra Map 1 vs FaZe (h2h from a single meeting, no Map 2)
        logs.append(log("2026-10-20", 2000, 1, "FaZe", 25, hs=12, adr=99))
        self.p = player(logs=logs)
        self.g = Grader([self.p], ranks={"G2": 2, "FaZe": 3, "Vitality": 1})

    def test_map1_series_is_per_map_and_allows_solo_map1(self):
        s12 = self.g.series(self.p)
        s1 = self.g.series(self.p, "Map 1")
        self.assertEqual(len(s12), 12)
        self.assertEqual(len(s1), 13)  # 12 paired + the FaZe Map 1-only
        self.assertEqual(s1[0]["kills"], 25)
        self.assertEqual(s1[0]["opp"], "FaZe")
        # Map 1 row is not the 1+2 total
        paired = [c for c in s1 if c["mid"] == "1000"][0]
        self.assertEqual(paired["kills"], 20)
        self.assertEqual([c for c in s12 if str(c["mid"]) == "1000"][0]["kills"], 38)

    def test_season_weight_stays_nonzero_and_h2h_from_one_meeting(self):
        det = self.g.v1_project_parts(self.p, "kills", "FaZe", period="Map 1")
        self.assertIsNotNone(det)
        parts = {x["key"]: x for x in det["parts"]}
        self.assertEqual(parts["szn"]["w"], 0.20)
        self.assertIsNotNone(parts["szn"]["v"])
        self.assertEqual(parts["h2h"]["n"], 1)
        self.assertEqual(parts["h2h"]["v"], 25)
        self.assertGreater(parts["szn"]["n"], 1)

    def test_map1_projection_differs_from_maps12(self):
        m1 = self.g.grade(self.p, "kills", 16.5, "FaZe", "Spirit", "PrizePicks", -137, period="Map 1")
        m12 = self.g.grade(self.p, "kills", 32.5, "FaZe", "Spirit", "PrizePicks", -137, period="Maps 1-2")
        self.assertIsNotNone(m1)
        self.assertIsNotNone(m12)
        self.assertEqual(m1["period"], "Map 1")
        self.assertLess(m1["proj"], m12["proj"])
        self.assertIn(m1["grade"], ["A+", "A", "B+", "B", "C+", "C", "D", "F"])
        self.assertIn(m1["pick"], ("OVER", "UNDER"))

    def test_high_line_is_under_from_calibrated_edge(self):
        # very high line so the pick is Under; letter comes from P(under) vs break-even, not the old D/F rule
        g = self.g.grade(self.p, "kills", 40.5, "FaZe", "Spirit", "PrizePicks", -137, period="Map 1")
        self.assertEqual(g["pick"], "UNDER")
        self.assertIn(g["grade"], ["A+", "A", "B+", "B", "C+", "C", "D", "F"])
        self.assertGreater(g["p_pick"], 0.5)
        self.assertFalse(g.get("under_be", {}).get("applied"))
        self.assertIn("stake", g)
        self.assertEqual(g["model"], "v1e")


class SettleMap1Tests(unittest.TestCase):
    def setUp(self):
        logs = [
            log("2026-11-20", 9, 1, "G2", 19, hs=9),
            # no Map 2: Maps 1-2 should not settle; Map 1 should
        ]
        self.p = player(logs=logs)
        self.gr = Grader([self.p], ranks={})
        self.now = datetime.datetime(2026, 11, 21, 12, tzinfo=datetime.timezone.utc)

    def test_map1_settles_without_map2(self):
        e = {"book": "PrizePicks", "player": "donk", "team": "Spirit", "opponent": "G2",
             "stat": "Kills", "period": "Map 1", "start": "2026-11-20T18:00:00Z",
             "line": 16.5, "lock": {"line": 16.5, "pick": "OVER", "grade": "B"}}
        changed = settle.settle_entry(self.gr, e, self.now)
        self.assertTrue(changed)
        self.assertEqual(e["result"]["act"], 19)
        self.assertEqual(e["result"]["outcome"], "hit")

    def test_maps12_still_requires_both_maps(self):
        e = {"book": "PrizePicks", "player": "donk", "team": "Spirit", "opponent": "G2",
             "stat": "Kills", "start": "2026-11-20T18:00:00Z",
             "line": 32.5, "lock": {"line": 32.5, "pick": "OVER", "grade": "C"}}
        changed = settle.settle_entry(self.gr, e, self.now)
        self.assertFalse(changed)
        self.assertNotIn("result", e)

    def test_does_not_alter_existing_lock(self):
        lock = {"line": 16.5, "pick": "OVER", "grade": "B", "proj": 18.0, "at": "2026-11-19T12:00:00+00:00"}
        e = {"book": "PrizePicks", "player": "donk", "team": "Spirit", "opponent": "G2",
             "stat": "Kills", "period": "Map 1", "start": "2026-11-20T18:00:00Z",
             "line": 16.5, "lock": copy.deepcopy(lock)}
        settle.settle_entry(self.gr, e, self.now)
        self.assertEqual(e["lock"], lock)


class FetchMarketsTests(unittest.TestCase):
    def test_markets_include_map1(self):
        # import the mapping without running main
        import importlib.util
        path = os.path.join(os.path.dirname(__file__), "..", "fetch_lines.py")
        src = open(path, encoding="utf-8").read().split("def fetch")[0]
        ns = {}
        exec(src, ns)
        m = ns["MARKETS"]
        self.assertEqual(m["CS2_KILLS_MAP_1"], ("Kills", "Map 1"))
        self.assertEqual(m["CS2_HEADSHOTS_MAP_1"], ("Headshots", "Map 1"))
        self.assertEqual(m["CS2_KILLS_MAPS_1_2"], ("Kills", "Maps 1-2"))


if __name__ == "__main__":
    unittest.main()
