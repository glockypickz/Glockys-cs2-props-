"""PrizePicks says "DENDELE CS", bo3.gg says "DENDELE", and bo3.gg decorates player names ("★ ⑳ maxxkor",
"Gafolo *Certto Telecom", "koaLx" for the lines' "koala"). Every Dendele prop must find its player.
Synthetic data only (the real players.json changes daily)."""
import os, re, sys, unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)
from grader import Grader, tn, TEAM_ALIASES, ALIASES

LOGS = [{"date": "2026-11-%02d" % (d + 1), "mid": 100 + d, "n": 1, "map": "Mirage", "opp": "9z", "kills": 14, "hs": 7,
         "d": 12, "a": 2, "adr": 75, "rd": 24} for d in range(8)]
STATS_NAMES = ["rdnzao-", "★ ⑳ maxxkor", "★ ㉑ koaLx", "doc", "★ ⑳ Gafolo *Certto Telecom"]
LINES_NAMES = ["rdnzao", "maxxkor", "koala", "doc", "gafolo"]


def players():
    ps = [{"name": n, "team": "DENDELE", "logs": list(LOGS)} for n in STATS_NAMES]
    # same names on other teams must never be picked for a Dendele line
    ps += [{"name": "doc", "team": "Other Team", "logs": list(LOGS)}, {"name": "koala", "team": "Other Team", "logs": list(LOGS)}]
    return ps


class DendeleNames(unittest.TestCase):
    def test_team_name_variants_are_one_team(self):
        self.assertEqual(tn("DENDELE CS"), tn("DENDELE"))
        self.assertEqual(TEAM_ALIASES["dendelecs"], "dendele")

    def test_every_lines_name_finds_its_dendele_player(self):
        g = Grader(players())
        for line_name, stats_name in zip(LINES_NAMES, STATS_NAMES):
            p = g.find(line_name, "DENDELE CS")
            self.assertIsNotNone(p, line_name)
            self.assertEqual((p["name"], p["team"]), (stats_name, "DENDELE"), line_name)

    def test_koala_alias_stays_on_the_team(self):
        g = Grader(players())
        self.assertEqual(ALIASES["koala"], "koaLx")
        self.assertEqual(g.find("koala", "DENDELE CS")["name"], "★ ㉑ koaLx")
        self.assertEqual(g.find("koala", "Other Team")["team"], "Other Team")

    def test_site_and_model_carry_the_same_fix(self):
        js_model = open(os.path.join(ROOT, "model.js"), encoding="utf-8").read()
        js_app = open(os.path.join(ROOT, "app.js"), encoding="utf-8").read()
        self.assertIn('"dendelecs": "dendele"', js_model)
        self.assertRegex(js_app, r'var ALIASES=\{[^}]*"koala":"koaLx"')


if __name__ == "__main__":
    unittest.main()
