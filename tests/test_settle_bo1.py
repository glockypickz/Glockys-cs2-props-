"""Bo1 settlement: Map 1 cashes, Maps 1-2 stays void, forfeits stay void, locks are untouched."""
import copy, datetime, os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from grader import Grader
import settle
import fetch_lines as fl


def log(date, mid, n, opp, kills, hs=None, rd=16, d=10, adr=80, mmap="Mirage"):
    return {"date": date, "mid": mid, "n": n, "map": mmap, "opp": opp,
            "kills": kills, "hs": hs if hs is not None else max(0, kills // 2),
            "d": d, "a": 2, "adr": adr, "rd": rd}


def player(name="donk", team="Spirit", logs=None):
    return {"name": name, "team": team, "logs": logs or []}


def entry(**kw):
    e = {"book": "PrizePicks", "player": "donk", "team": "Spirit", "opponent": "G2",
         "stat": "Kills", "period": "Map 1", "start": "2026-11-20T18:00:00Z",
         "line": 16.5, "lock": {"line": 16.5, "pick": "OVER", "grade": "B", "proj": 18.0,
                                "at": "2026-11-19T12:00:00+00:00"}}
    e.update(kw)
    if "lock" in kw and kw["lock"] is not None:
        base = {"line": 16.5, "pick": "OVER", "grade": "B", "proj": 18.0,
                "at": "2026-11-19T12:00:00+00:00"}
        base.update(kw["lock"])
        e["lock"] = base
    return e


class Bo1SettleTests(unittest.TestCase):
    def setUp(self):
        settle.reset_lookups()
        logs = [log("2026-11-20", 9, 1, "G2", 19, hs=9)]
        self.p = player(logs=logs)
        self.gr = Grader([self.p], ranks={})
        self.now = datetime.datetime(2026, 11, 21, 12, tzinfo=datetime.timezone.utc)
        self.fmt_bo1 = [{"date": "2026-11-20", "t1": "Spirit", "t2": "G2", "bo": 1, "src": "test"}]
        self.fmt_forfeit = [{"date": "2026-11-20", "t1": "Spirit", "t2": "G2", "bo": 3,
                             "forfeit": True, "src": "test",
                             "maps": [{"n": 1, "status": "completed", "forfeit": False},
                                      {"n": 2, "status": "completed", "forfeit": True}]}]

    def tearDown(self):
        settle.reset_lookups()

    def test_regrade_tag_unchanged(self):
        self.assertEqual(fl.REGRADE_TAG, "h2h-2")

    def test_map1_bo1_settles_and_flags(self):
        settle.set_formats(self.fmt_bo1)
        e = entry()
        lock = copy.deepcopy(e["lock"])
        self.assertTrue(settle.settle_entry(self.gr, e, self.now))
        self.assertEqual(e["result"]["act"], 19)
        self.assertEqual(e["result"]["outcome"], "hit")
        self.assertTrue(e["result"].get("bo1"))
        self.assertEqual(e["lock"], lock)

    def test_maps12_bo1_stays_void(self):
        settle.set_formats(self.fmt_bo1)
        e = entry(period="Maps 1-2", line=32.5, lock={"line": 32.5, "pick": "OVER", "grade": "C", "proj": 30.0})
        lock = copy.deepcopy(e["lock"])
        self.assertTrue(settle.settle_entry(self.gr, e, self.now))
        self.assertEqual(e["result"]["outcome"], "void")
        self.assertEqual(e["result"]["void"], settle.VOID_MAPS12_BO1)
        self.assertNotIn("bo1", e["result"])
        self.assertNotIn("act", e["result"])
        self.assertEqual(e["lock"], lock)

    def test_maps12_without_format_still_waits(self):
        settle.set_formats([])
        e = entry(period="Maps 1-2", line=32.5, lock={"line": 32.5, "pick": "OVER", "grade": "C"})
        self.assertFalse(settle.settle_entry(self.gr, e, self.now))
        self.assertNotIn("result", e)

    def test_maps12_without_format_voids_after_72h(self):
        settle.set_formats([])
        e = entry(period="Maps 1-2", line=32.5, lock={"line": 32.5, "pick": "UNDER", "grade": "C"})
        later = datetime.datetime(2026, 11, 24, 12, tzinfo=datetime.timezone.utc)
        self.assertTrue(settle.settle_entry(self.gr, e, later))
        self.assertEqual(e["result"]["outcome"], "void")
        self.assertEqual(e["result"]["void"], settle.VOID_ONE_MAP)
        self.assertNotIn("bo1", e["result"])

    def test_forfeit_stays_void(self):
        settle.set_formats(self.fmt_forfeit)
        e = entry(period="Maps 1-2", line=32.5, lock={"line": 32.5, "pick": "OVER", "grade": "C"})
        self.assertTrue(settle.settle_entry(self.gr, e, self.now))
        self.assertEqual(e["result"]["outcome"], "void")
        self.assertEqual(e["result"]["void"], settle.VOID_FORFEIT)
        self.assertNotIn("bo1", e["result"])
        # Map 1 on a match where map 2 (not required) was forfeited: map 1 itself was played
        settle.set_formats([{"date": "2026-11-20", "t1": "Spirit", "t2": "G2", "bo": 3, "src": "test",
                             "maps": [{"n": 1, "status": "completed", "forfeit": False},
                                      {"n": 2, "status": "completed", "forfeit": True}]}])
        e1 = entry()
        self.assertTrue(settle.settle_entry(self.gr, e1, self.now))
        self.assertEqual(e1["result"]["outcome"], "hit")
        self.assertFalse(e1["result"].get("bo1"))

    def test_map1_forfeit_voids(self):
        settle.set_formats([{"date": "2026-11-20", "t1": "Spirit", "t2": "G2", "bo": 3, "src": "test",
                             "maps": [{"n": 1, "status": "completed", "forfeit": True},
                                      {"n": 2, "status": "map_not_played", "forfeit": False}]}])
        e = entry()
        self.assertTrue(settle.settle_entry(self.gr, e, self.now))
        self.assertEqual(e["result"]["outcome"], "void")
        self.assertEqual(e["result"]["void"], settle.VOID_FORFEIT)
        self.assertNotIn("bo1", e["result"])

    def test_revisit_maps12_void_updates_reason_keeps_lock(self):
        settle.set_formats(self.fmt_bo1)
        lock = {"line": 32.5, "pick": "UNDER", "grade": "C+", "proj": 29.4,
                "at": "2026-11-19T12:00:00+00:00"}
        e = entry(period="Maps 1-2", line=32.5, lock=copy.deepcopy(lock),
                  result={"void": settle.VOID_ONE_MAP, "outcome": "void",
                          "settled_at": "2026-11-24T16:00:00+00:00"})
        self.assertTrue(settle.settle_entry(self.gr, e, self.now))
        self.assertEqual(e["result"]["outcome"], "void")
        self.assertEqual(e["result"]["void"], settle.VOID_MAPS12_BO1)
        self.assertEqual(e["lock"], lock)

    def test_revisit_forfeit_void_keeps_void(self):
        settle.set_formats(self.fmt_forfeit)
        lock = {"line": 32.5, "pick": "OVER", "grade": "B", "proj": 31.0,
                "at": "2026-11-19T12:00:00+00:00"}
        e = entry(period="Maps 1-2", line=32.5, lock=copy.deepcopy(lock),
                  result={"void": settle.VOID_ONE_MAP, "outcome": "void",
                          "settled_at": "2026-11-24T16:00:00+00:00"})
        self.assertTrue(settle.settle_entry(self.gr, e, self.now))
        self.assertEqual(e["result"]["outcome"], "void")
        self.assertEqual(e["result"]["void"], settle.VOID_FORFEIT)
        self.assertEqual(e["lock"], lock)

    def test_revisit_map1_void_on_bo1_cashes(self):
        settle.set_formats(self.fmt_bo1)
        lock = {"line": 16.5, "pick": "OVER", "grade": "B", "proj": 18.0,
                "at": "2026-11-19T12:00:00+00:00"}
        e = entry(lock=copy.deepcopy(lock),
                  result={"void": settle.VOID_ONE_MAP, "outcome": "void",
                          "settled_at": "2026-11-24T16:00:00+00:00"})
        self.assertTrue(settle.settle_entry(self.gr, e, self.now))
        self.assertEqual(e["result"]["outcome"], "hit")
        self.assertEqual(e["result"]["act"], 19)
        self.assertTrue(e["result"].get("bo1"))
        self.assertNotIn("void", e["result"])
        self.assertEqual(e["lock"], lock)

    def test_annotate_existing_settled_map1(self):
        settle.set_formats(self.fmt_bo1)
        lock = {"line": 16.5, "pick": "UNDER", "grade": "D", "proj": 14.0,
                "at": "2026-11-19T12:00:00+00:00"}
        e = entry(lock=copy.deepcopy(lock),
                  result={"act": 19.0, "mid": "9", "date": "2026-11-20",
                          "close_vs": "over", "outcome": "miss",
                          "settled_at": "2026-11-24T14:00:00+00:00"})
        self.assertTrue(settle.settle_entry(self.gr, e, self.now))
        self.assertEqual(e["result"]["outcome"], "miss")
        self.assertEqual(e["result"]["act"], 19.0)
        self.assertTrue(e["result"].get("bo1"))
        self.assertEqual(e["lock"], lock)
        # second pass is a no-op
        self.assertFalse(settle.settle_entry(self.gr, e, self.now))

    def test_annotate_does_not_clear_bo1_when_format_unknown(self):
        settle.set_formats([])
        e = entry(result={"act": 19.0, "mid": "9", "date": "2026-11-20",
                          "close_vs": "over", "outcome": "miss", "bo1": True,
                          "settled_at": "2026-11-24T14:00:00+00:00"})
        self.assertFalse(settle.settle_entry(self.gr, e, self.now))
        self.assertTrue(e["result"].get("bo1"))
        self.assertEqual(e["result"]["outcome"], "miss")

    def test_does_not_revisit_unrelated_void(self):
        settle.set_formats(self.fmt_bo1)
        e = entry(result={"void": "player not in data", "outcome": "void",
                          "settled_at": "2026-11-24T16:00:00+00:00"})
        self.assertFalse(settle.settle_entry(self.gr, e, self.now))
        self.assertEqual(e["result"]["void"], "player not in data")

    def test_does_not_rewrite_unlocked_void(self):
        settle.set_formats(self.fmt_forfeit)
        e = entry(lock=None, result={"void": "player not in data", "outcome": None,
                                     "settled_at": "2026-11-24T16:00:00+00:00"})
        e.pop("lock", None)
        before = dict(e["result"])
        self.assertFalse(settle.settle_entry(self.gr, e, self.now))
        self.assertEqual(e["result"], before)

    def test_record_counts(self):
        rows = [
            entry(player="a", result={"outcome": "hit", "act": 20, "bo1": True}, lock={"pick": "OVER"}),
            entry(player="b", result={"outcome": "miss", "act": 10, "bo1": True}, lock={"pick": "OVER"}),
            entry(player="c", result={"outcome": "push", "act": 16.5, "bo1": True}, lock={"pick": "OVER"}),
            entry(player="d", result={"outcome": "hit", "act": 40}, lock={"pick": "OVER"}),
            entry(player="e", result={"outcome": "void", "void": settle.VOID_FORFEIT}, lock={"pick": "OVER"}),
            {"player": "unlocked", "result": {"outcome": "hit", "act": 1}},
        ]
        c = settle.record_counts(rows)
        self.assertEqual(c["overall"]["hit"], 2)
        self.assertEqual(c["overall"]["miss"], 1)
        self.assertEqual(c["overall"]["push"], 1)
        self.assertEqual(c["overall"]["void"], 1)
        self.assertEqual(c["bo1"]["hit"], 1)
        self.assertEqual(c["bo1"]["miss"], 1)
        self.assertEqual(c["bo1"]["push"], 1)
        self.assertEqual(c["bo1"]["hit_rate"], 50.0)


if __name__ == "__main__":
    unittest.main()
