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
            if params.get("market") == "CS2_KILLS_MAPS_1_2" and params["book"] == "prizepicks":
                return group_payload("2026-11-24T06:00:00Z")  # started 2.5h ago
            return empty_payload()
        fl.main(lines_path=self.lines, history=False, fetch_fn=fake, now=NOW)
        data = json.load(open(self.lines, encoding="utf-8"))
        self.assertEqual(data["lines"], [])
        self.assertEqual(data["status"], "no_lines_up")
        self.history_untouched()

    def test_upcoming_kept_started_dropped(self):
        def fake(path, params):
            if params.get("market") == "CS2_KILLS_MAPS_1_2" and params["book"] == "prizepicks":
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


# --- KashRock's market filter says "no_props_listed" for the Maps 1-2 markets while the props are on the board ---
STATS = ["CS2_KILLS_MAP_1", "CS2_HEADSHOTS_MAP_1", "CS2_AWP_KILLS_MAP_1",
         "CS2_KILLS_MAPS_1_2", "CS2_HEADSHOTS_MAPS_1_2", "CS2_AWP_KILLS_MAPS_1_2", "CS2_FIRST_BLOOD_MAPS_1_2"]
FUTURE = "2026-11-25T08:00:00Z"


def board_group(stat, n):
    offers = [{"direction": d, "line": 20.5 + n, "odds": -137, "book_name": "PrizePicks", "is_alt_line": False,
               "stat_type": stat, "deeplink": "", "links": {}} for d in ("over", "under")]
    return {"player_name": f"{stat[4:10]}-{n}", "team": "Spirit", "opponent": "FaZe", "start_time": FUTURE,
            "stat_type": stat, "dfs": offers}


def make_fetch(filter_works_for_maps12, per_stat=30, empty_books=("underdog",)):
    """PrizePicks has per_stat groups of every stat. Market filter works for Map 1 and, if asked, for Maps 1-2."""
    calls = []

    def fetch(path, params):
        calls.append(dict(params))
        if params["book"] in empty_books:
            return {"available": False, "reason": "no_props_listed", "groups": []}
        groups = [board_group(st, i) for st in STATS for i in range(per_stat)]
        m = params.get("market")
        if m:
            if "MAPS_1_2" in m and not filter_works_for_maps12:
                return {"available": False, "reason": "no_props_listed", "groups": []}
            groups = [g for g in groups if g["stat_type"] == m]
        off, lim = params.get("offset", 0), params.get("limit", 100)
        page = groups[off:off + lim]
        return {"available": True, "groups": page, "has_more": off + lim < len(groups),
                "fetched_at": "2026-11-25T04:15:12+00:00"}
    fetch.calls = calls
    return fetch


class MapsOneTwoFallbackTests(unittest.TestCase):
    def count(self, lines):
        c = {}
        for l in lines:
            k = (l["book"], l["stat"], l["period"])
            c[k] = c.get(k, 0) + 1
        return c

    def test_maps_1_2_come_through_when_the_market_filter_says_no_props(self):
        f = make_fetch(filter_works_for_maps12=False)
        lines, fetched = fl.collect_lines(f)
        c = self.count(lines)
        self.assertEqual(c[("PrizePicks", "Kills", "Maps 1-2")], 30)
        self.assertEqual(c[("PrizePicks", "Headshots", "Maps 1-2")], 30)
        self.assertEqual(c[("PrizePicks", "Kills", "Map 1")], 30)
        self.assertEqual(c[("PrizePicks", "Headshots", "Map 1")], 30)
        self.assertEqual(len(lines), 120)  # AWP kills and first blood are not ours to grade
        self.assertEqual(fetched, "2026-11-25T04:15:12+00:00")
        keys = {(l["player"], l["stat"], l["period"], l["line"]) for l in lines}
        self.assertEqual(len(keys), len(lines))  # no duplicates

    def test_the_unfiltered_board_is_read_once_per_book_not_once_per_market(self):
        f = make_fetch(filter_works_for_maps12=False)
        fl.collect_lines(f)
        unfiltered = [c for c in f.calls if "market" not in c]
        self.assertEqual(sorted({c["book"] for c in unfiltered}), ["prizepicks", "underdog"])
        pp_pages = [c for c in unfiltered if c["book"] == "prizepicks"]
        self.assertEqual([c["offset"] for c in pp_pages], [0, 100, 200])  # 210 groups, paged
        self.assertEqual(len([c for c in unfiltered if c["book"] == "underdog"]), 1)

    def test_no_unfiltered_call_when_the_market_filter_works(self):
        f = make_fetch(filter_works_for_maps12=True)
        lines, _ = fl.collect_lines(f)
        pp = [c for c in f.calls if c["book"] == "prizepicks"]
        self.assertTrue(all("market" in c for c in pp), "filtered calls only")
        self.assertEqual(self.count(lines)[("PrizePicks", "Kills", "Maps 1-2")], 30)

    def test_a_book_with_nothing_listed_gives_no_lines_and_no_crash(self):
        f = make_fetch(filter_works_for_maps12=False)
        lines, _ = fl.collect_lines(f)
        self.assertEqual([l for l in lines if l["book"] != "PrizePicks"], [])

    def test_main_writes_maps_1_2_to_lines_json(self):
        td = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, td)
        path = os.path.join(td, "lines.json")
        key = fl.KEY
        fl.KEY = "test-key"
        self.addCleanup(setattr, fl, "KEY", key)
        fl.main(lines_path=path, history=False, fetch_fn=make_fetch(filter_works_for_maps12=False), now=NOW)
        data = json.load(open(path, encoding="utf-8"))
        self.assertFalse(data["empty"])
        self.assertEqual(self.count(data["lines"])[("PrizePicks", "Kills", "Maps 1-2")], 30)
        self.assertEqual(self.count(data["lines"])[("PrizePicks", "Headshots", "Maps 1-2")], 30)


if __name__ == "__main__":
    unittest.main()
