"""PrizePicks says "Honved", bo3.gg says "Honvéd" (accent). tn() drops the accented letter ("honvd"), so every Honved prop
was ungraded, by the live grader and by Scout. Synthetic data only."""
import os, sys, unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)
from grader import Grader, tn, teq, TEAM_ALIASES

LOGS = [{"date": "2026-11-%02d" % (d + 1), "mid": 200 + d, "n": 1, "map": "Mirage", "opp": "X", "kills": 14, "hs": 7,
         "d": 12, "a": 2, "adr": 75, "rd": 24} for d in range(8)]


class HonvedNames(unittest.TestCase):
    def test_accented_and_plain_team_name_are_one_team(self):
        self.assertEqual(tn("Honved"), tn("Honvéd"))
        self.assertTrue(teq("Honved", "Honvéd"))
        self.assertEqual(TEAM_ALIASES["honved"], "honvd")

    def test_a_honved_line_finds_the_honved_player(self):
        g = Grader([{"name": "esor", "team": "Honvéd", "logs": list(LOGS)}, {"name": "esor", "team": "Other", "logs": list(LOGS)}])
        p = g.find("esor", "Honved")
        self.assertIsNotNone(p)
        self.assertEqual(p["team"], "Honvéd")

    def test_site_and_model_carry_the_same_fix(self):
        self.assertIn('"honved": "honvd"', open(os.path.join(ROOT, "model.js"), encoding="utf-8").read())

    def test_other_teams_are_not_merged(self):
        self.assertNotEqual(tn("Honved"), tn("Bayankhongor"))


if __name__ == "__main__":
    unittest.main()
