"""A Cito backup player that is the same person as a players.json player (EmiliaQAQ / "Emilia-3-") must not become
a second, older record. The older copy won the exact-name match, so graded picks used a month-old record and the
result of the match could never be found. Synthetic data only."""
import datetime, json, os, sys, tempfile, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from grader import Grader, merge_cito, ALIASES
import settle


def log(date, mid, n, opp, kills, hs):
    return {"date": date, "mid": mid, "n": n, "map": "Mirage", "opp": opp, "kills": kills, "hs": hs,
            "d": 12, "a": 2, "adr": 75, "rd": 24}


OLD = [log("2026-10-%02d" % (d + 1), 50 + d, 1, "X", 15, 7) for d in range(8)]
BO3 = [log("2026-11-%02d" % (d + 1), 100 + d, 1, "Y", 14, 7) for d in range(8)] + [log("2026-11-25", 200, 1, "Wildcard", 12, 7)]


def cito_file(rows):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump({"players": rows}, f)
    f.close()
    return f.name


class CitoTwin(unittest.TestCase):
    def setUp(self):
        settle.reset_lookups()
        self.bo3 = [{"name": "Emilia-3-", "team": "Lynn Vision", "logs": BO3}]
        self.path = cito_file([
            {"name": "EmiliaQAQ", "team": "Lynn Vision Gaming", "logs": OLD},   # same person, older record
            {"name": "Matz", "team": "KUUSAMO.gg", "logs": OLD},               # a real Cito-only player
        ])

    def tearDown(self):
        os.unlink(self.path)
        settle.reset_lookups()

    def test_alias_is_in_the_table(self):
        self.assertEqual(ALIASES["EmiliaQAQ"], "Emilia-3-")

    def test_twin_is_not_added_but_cito_only_players_still_are(self):
        merged, n = merge_cito(self.bo3, self.path)
        self.assertEqual(sorted(p["name"] for p in merged), ["Emilia-3-", "Matz"])
        self.assertEqual(n, 1)

    def test_board_name_finds_the_current_record(self):
        merged, _ = merge_cito(self.bo3, self.path)
        p = Grader(merged, ranks={}).find("EmiliaQAQ", "Lynn Vision Gaming")
        self.assertEqual((p["name"], len(p["logs"]), p.get("src")), ("Emilia-3-", 9, None))

    def test_without_the_alias_rule_the_old_copy_would_win(self):
        # the unfixed behaviour, spelled out: a Cito twin with an unrelated name stays as its own record
        p = Grader(merge_cito(self.bo3, cito_file([{"name": "SomeoneElse", "team": "Lynn Vision Gaming", "logs": OLD}]))[0], ranks={}).find("SomeoneElse", "Lynn Vision Gaming")
        self.assertEqual(p.get("src"), "cito")

    def test_todays_map1_pick_settles(self):
        merged, _ = merge_cito(self.bo3, self.path)
        gr = Grader(merged, ranks={})
        settle.set_formats([{"date": "2026-11-25", "t1": "Lynn Vision", "t2": "Wildcard", "bo": 3, "src": "test"}])
        e = {"book": "PrizePicks", "player": "EmiliaQAQ", "team": "Lynn Vision Gaming", "opponent": "Wildcard Gaming",
             "stat": "Kills", "period": "Map 1", "start": "2026-11-25T07:00:00Z", "line": 13.5,
             "lock": {"line": 13.5, "pick": "OVER", "grade": "C+", "proj": 14.0, "at": "2026-11-25T05:00:00+00:00"}}
        now = datetime.datetime(2026, 11, 25, 14, tzinfo=datetime.timezone.utc)
        settle.settle_entry(gr, e, now)
        self.assertEqual((e["result"]["outcome"], e["result"]["act"]), ("miss", 12))


if __name__ == "__main__":
    unittest.main()
