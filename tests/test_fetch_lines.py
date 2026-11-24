"""Empty KashRock board clears lines.json; errors keep the old file and mark it stale.
Does not rewrite lines_history.json on empty or failed pulls.
"""
import json, os, sys, tempfile, unittest, datetime, shutil

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import fetch_lines as fl


NOW = datetime.datetime(2026, 11, 24, 8, 30, tzinfo=datetime.timezone.utc)


def sample_line(starts_at="2026-11-24T18:00:00Z", player="Umar"):
    return {
        "player": player, "team": "Spirit", "opponent": "FaZe", "stat": "Kills",
        "period": "Maps 1-2", "line": 30.5, "odds": -137, "starts_at": starts_at,
        "book": "PrizePicks", "deeplink": "", "image": "",
    }


def old_board():
    return {
        "observed_at": "2026-11-21T20:39:43+00:00",
        "fetched_by_job_at": "2026-11-21T20:39:46+00:00",
        "source": "kashrock",
        "lines": [sample_line("2026-11-22T03:00:00Z")],
    }


def hist():
    return {"updated": "2026-11-21T20:39:46+00:00", "entries": [
        {"book": "PrizePicks", "player": "Umar", "team": "Spirit", "stat": "Kills",
         "start": "2026-11-22T03:00:00Z", "line": 30.5,
         "lock": {"grade": "A+", "pick": "OVER", "line": 30.5, "at": "2026-11-21T20:00:00+00:00"}}
    ]}


def empty_payload(fetched="2026-11-24T08:18:00+00:00"):
    return {"available": True, "groups": [], "has_more": False, "fetched_at": fetched}


def group_payload(starts, fetched="2026-11-24T08:18:00+00:00"):
    return {
        "available": True, "has_more": False, "fetched_at": fetched,
        "groups": [{
            "player_name": "donk", "team": "Spirit", "opponent": "FaZe",
            "start_time": starts, "stat_type": "CS2_KILLS_MAPS_1_2",
            "dfs": [{"direction": "over", "line": 32.5, "odds": -137,
                     "book_name": "PrizePicks", "is_alt_line": False,
                     "stat_type": "CS2_KILLS_MAPS_1_2", "deeplink": "", "links": {}}],
        }],
    }


class FetchLinesTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.td)
        self.lines = os.path.join(self.td, "lines.json")
        self.history = os.path.join(self.td, "lines_history.json")
        json.dump(old_board(), open(self.lines, "w"))
        json.dump(hist(), open(self.history, "w"))
        self.hist_before = open(self.history, encoding="utf-8").read()
        self._key = fl.KEY
        fl.KEY = "test-key"

    def tearDown(self):
        fl.KEY = self._key

    def history_untouched(self):
        self.assertEqual(open(self.history, encoding="utf-8").read(), self.hist_before)

    def test_empty_board_writes_marker_exits_0_leaves_history(self):
        def fake(path, params):
            return empty_payload()
        rc = None
        try:
            fl.main(lines_path=self.lines, history=True, fetch_fn=fake, now=NOW)
        except SystemExit as e:
            rc = e.code
        self.assertTrue(rc in (None, 0))
        data = json.load(open(self.lines, encoding="utf-8"))
        self.assertEqual(data["lines"], [])
        self.assertTrue(data["empty"])
        self.assertEqual(data["status"], "no_lines_up")
        self.assertEqual(data["message"], "no lines up")
        self.assertFalse(data["stale"])
        self.assertEqual(data["fetched_at"], "2026-11-24T08:30:00+00:00")
        self.assertEqual(data["fetched_by_job_at"], "2026-11-24T08:30:00+00:00")
        self.assertEqual(data["observed_at"], "2026-11-24T08:18:00+00:00")
        self.assertEqual(data["source"], "kashrock")
        self.history_untouched()

    def test_unavailable_markets_are_an_empty_board(self):
        def fake(path, params):
            return {"available": False, "reason": "no props listed", "groups": []}
        fl.main(lines_path=self.lines, history=False, fetch_fn=fake, now=NOW)
        data = json.load(open(self.lines, encoding="utf-8"))
        self.assertEqual(data["status"], "no_lines_up")
        self.assertEqual(data["lines"], [])
        self.history_untouched()

    def test_started_props_are_dropped(self):
        calls = {"n": 0}
        def fake(path, params):
            calls["n"] += 1
            # first market returns a started match + we only need one hit
            if params["market"] == "CS2_KILLS_MAPS_1_2" and params["book"] == "prizepicks":
                return group_payload("2026-11-24T06:00:00Z")  # started 2.5h ago
            return empty_payload()
        fl.main(lines_path=self.lines, history=False, fetch_fn=fake, now=NOW)
        data = json.load(open(self.lines, encoding="utf-8"))
        self.assertEqual(data["lines"], [])
        self.assertEqual(data["status"], "no_lines_up")
        self.history_untouched()

    def test_upcoming_kept_started_dropped(self):
        def fake(path, params):
            if params["market"] == "CS2_KILLS_MAPS_1_2" and params["book"] == "prizepicks":
                d = group_payload("2026-11-24T18:00:00Z")
                # also include a started prop in the same group list
                started = group_payload("2026-11-24T06:00:00Z")["groups"][0]
                started["player_name"] = "chopper"
                d["groups"].append(started)
                return d
            return empty_payload()
        fl.main(lines_path=self.lines, history=False, fetch_fn=fake, now=NOW)
        data = json.load(open(self.lines, encoding="utf-8"))
        self.assertEqual(data["status"], "ok")
        self.assertFalse(data["empty"])
        self.assertEqual([x["player"] for x in data["lines"]], ["donk"])
        self.assertEqual(data["lines"][0]["starts_at"], "2026-11-24T18:00:00Z")
        self.history_untouched()  # history=False

    def test_http_error_keeps_old_and_marks_stale(self):
        def fake(path, params):
            raise RuntimeError("HTTP 500 on /v7/cs2/props: boom")
        with self.assertRaises(SystemExit) as cm:
            fl.main(lines_path=self.lines, history=True, fetch_fn=fake, now=NOW)
        self.assertNotEqual(cm.exception.code, 0)
        data = json.load(open(self.lines, encoding="utf-8"))
        self.assertTrue(data["stale"])
        self.assertEqual(data["stale_at"], "2026-11-24T08:30:00+00:00")
        self.assertIn("HTTP 500", data["stale_reason"])
        self.assertEqual(len(data["lines"]), 1)
        self.assertEqual(data["lines"][0]["player"], "Umar")
        self.assertEqual(data["observed_at"], "2026-11-21T20:39:43+00:00")
        self.history_untouched()

    def test_error_after_partial_success_does_not_write_partial_board(self):
        def fake(path, params):
            if params["book"] == "underdog":
                raise RuntimeError("HTTP 429 on /v7/cs2/props: rate limited")
            return group_payload("2026-11-24T18:00:00Z")
        with self.assertRaises(SystemExit):
            fl.main(lines_path=self.lines, history=False, fetch_fn=fake, now=NOW)
        data = json.load(open(self.lines, encoding="utf-8"))
        self.assertTrue(data["stale"])
        self.assertEqual(data["lines"][0]["player"], "Umar")  # old board, not donk
        self.history_untouched()

    def test_missing_key_marks_stale_and_exits(self):
        fl.KEY = ""
        with self.assertRaises(SystemExit) as cm:
            fl.main(lines_path=self.lines, history=True, now=NOW)
        self.assertNotEqual(cm.exception.code, 0)
        data = json.load(open(self.lines, encoding="utf-8"))
        self.assertTrue(data["stale"])
        self.assertIn("KASHROCK_API_KEY", data["stale_reason"])
        self.assertEqual(data["lines"][0]["player"], "Umar")
        self.history_untouched()

    def test_is_upcoming(self):
        self.assertTrue(fl.is_upcoming(sample_line("2026-11-24T08:30:01Z"), NOW))
        self.assertFalse(fl.is_upcoming(sample_line("2026-11-24T08:30:00Z"), NOW))
        self.assertFalse(fl.is_upcoming(sample_line("2026-11-24T06:00:00Z"), NOW))
        self.assertTrue(fl.is_upcoming({"starts_at": ""}, NOW))


if __name__ == "__main__":
    unittest.main()
