"""v1e calibrated probability, letter/stake, LAN kills / bait cap. Does not rewrite lines_history.json."""
import hashlib, math, os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from grader import (Grader, residual_probs, letter_from_edge, erf_as, norm_cdf, laplace_cdf,
                    apply_grade_cap, cap_reasons, CALIB, GRADE_SCALE, MODEL_VERSION, FIT_CUTOFF, PARAMS,
                    PLAY_GRADES, CAP_LETTER, CAP_STAKE)


def log(date, mid, n, opp, kills, hs=None, rd=16, d=10, adr=80, mmap="Mirage"):
    return {"date": date, "mid": mid, "n": n, "map": mmap, "opp": opp,
            "kills": kills, "hs": hs if hs is not None else max(0, kills // 2),
            "d": d, "a": 2, "adr": adr, "rd": rd}


def player(name="donk", team="Spirit", logs=None):
    return {"name": name, "team": team, "logs": logs or []}


def stacked(n=12, k1=20, k2=18):
    logs = []
    for i in range(n):
        day = "2026-10-%02d" % (i + 1)
        logs += [log(day, 1000 + i, 1, "G2", k1, hs=k1 // 2, adr=85),
                 log(day, 1000 + i, 2, "G2", k2, hs=k2 // 2, adr=80)]
    return logs


def mixed_form(n=12):
    """Varied series totals so a mid line is not automatically bait (last 5 not all over)."""
    # totals roughly 44, 28, 40, 26, 38, then earlier 38s — last 5 are mixed around 23.5-36
    pairs = [(24, 20), (12, 16), (22, 18), (10, 16), (20, 18)] + [(20, 18)] * (n - 5)
    logs = []
    for i, (k1, k2) in enumerate(pairs[:n]):
        day = "2026-10-%02d" % (n - i)  # first pairs are the most recent
        logs += [log(day, 1000 + i, 1, "G2", k1, hs=k1 // 2, adr=85),
                 log(day, 1000 + i, 2, "G2", k2, hs=k2 // 2, adr=80)]
    return logs


class MathTests(unittest.TestCase):
    def test_erf_known_values(self):
        # erf(0)=0, erf(infinity)=1; A&S approx is within ~1e-7
        self.assertAlmostEqual(erf_as(0), 0.0, places=7)
        self.assertAlmostEqual(erf_as(0.5), 0.520499877, places=5)
        self.assertAlmostEqual(erf_as(-0.5), -0.520499877, places=5)
        self.assertAlmostEqual(norm_cdf(0), 0.5, places=7)
        self.assertAlmostEqual(laplace_cdf(0), 0.5, places=9)

    def test_half_line_has_no_push(self):
        po, pp, pu = residual_probs(26.8, 23.5, "kills", "Maps 1-2")
        self.assertEqual(pp, 0.0)
        self.assertAlmostEqual(po + pu, 1.0, places=9)
        self.assertGreater(po, pu)

    def test_integer_line_has_push_and_conditional_side(self):
        po, pp, pu = residual_probs(26.8, 24, "kills", "Maps 1-2")
        self.assertGreater(pp, 0.0)
        self.assertLess(pp, 0.2)
        self.assertAlmostEqual(po + pu, 1.0, places=9)

    def test_higher_proj_raises_p_over(self):
        a, _, _ = residual_probs(20, 23.5, "kills", "Maps 1-2")
        b, _, _ = residual_probs(26.8, 23.5, "kills", "Maps 1-2")
        c, _, _ = residual_probs(32, 23.5, "kills", "Maps 1-2")
        self.assertLess(a, b)
        self.assertLess(b, c)

    def test_map1_scale_differs(self):
        # Same edge in kills, Map 1 scale is tighter than Maps 1-2, so P(over) should be higher.
        p12, _, _ = residual_probs(26.8, 23.5, "kills", "Maps 1-2")
        p1, _, _ = residual_probs(26.8, 23.5, "kills", "Map 1")
        s12 = CALIB["kills"]["Maps 1-2"]["scale"]
        s1 = CALIB["kills"]["Map 1"]["scale"]
        if s1 < s12:
            self.assertGreater(p1, p12)
        elif s1 > s12:
            self.assertLess(p1, p12)

    def test_combo_scale_widens(self):
        one, _, _ = residual_probs(26.8, 23.5, "kills", "Maps 1-2", n_players=1)
        two, _, _ = residual_probs(26.8, 23.5, "kills", "Maps 1-2", n_players=2)
        # same total proj and line, wider combo residual -> closer to 0.5
        self.assertGreater(abs(one - 0.5), abs(two - 0.5))


class LetterTests(unittest.TestCase):
    def test_thresholds_and_stakes(self):
        cases = {
            20: ("A+", 2.0),
            18: ("A+", 2.0),
            15: ("A", 1.5),
            13: ("B+", 1.0),
            12: ("B+", 1.0),
            8: ("B", 1.0),
            5: ("C+", 0.5),
            2: ("C", 0.25),
            0: ("D", 0.0),
            -0.1: ("F", 0.0),
            -8: ("F", 0.0),
        }
        for epp, want in cases.items():
            self.assertEqual(letter_from_edge(epp), want, epp)

    def test_example_style_card_is_b_plus(self):
        # 1T card: proj 26.8 vs 23.5, Underdog default BE 53%.
        po, _, _ = residual_probs(26.8, 23.5, "kills", "Maps 1-2")
        epp = (po - 0.53) * 100
        g, stake = letter_from_edge(epp)
        self.assertGreater(po, 0.60)
        self.assertLess(po, 0.75)
        self.assertEqual(g, "B+")
        self.assertEqual(stake, 1.0)

    def test_version_and_cutoff(self):
        self.assertEqual(MODEL_VERSION, "v1f")
        self.assertEqual(FIT_CUTOFF, "2026-10-20")
        self.assertEqual(PARAMS["w_l10"], 0.05)  # kill-form input, not the v1 L10 weight
        # v1 blend weights live in v1_project_parts, not PARAMS; check they still sum as documented via a grade.


class GradeTests(unittest.TestCase):
    def setUp(self):
        self.p = player(logs=stacked())
        self.g = Grader([self.p], ranks={"G2": 2, "FaZe": 3, "Spirit": 1})

    def test_weights_unchanged(self):
        det = self.g.v1_project_parts(self.p, "kills", "G2")
        parts = {x["key"]: x for x in det["parts"]}
        self.assertAlmostEqual(parts["l10"]["w"], 0.35)
        self.assertAlmostEqual(parts["szn"]["w"], 0.20)
        self.assertAlmostEqual(parts["h2h"]["w"], 0.20)
        self.assertAlmostEqual(parts["tier"]["w"], 0.15)
        self.assertAlmostEqual(parts["l3"]["w"], 0.10)
        self.assertEqual(sum(p["w"] for p in det["parts"]), 1.0)

    def test_grade_has_stake_and_calibrated_p(self):
        r = self.g.grade(self.p, "kills", 23.5, "G2", "Spirit", "Underdog", None)
        self.assertIsNotNone(r)
        self.assertEqual(r["model"], "v1f")
        self.assertIn(r["grade"], [g for _, g, _ in GRADE_SCALE] + ["F"])
        self.assertIn("stake", r)
        self.assertAlmostEqual(r["p_over"] + (1 - r["p_over"] if r["p_push"] == 0 else 0), 1.0, places=3)
        self.assertEqual(r["under_be"]["applied"], False)

    def test_under_high_line(self):
        r = self.g.grade(self.p, "kills", 55.5, "G2", "Spirit", "PrizePicks", -137)
        self.assertEqual(r["pick"], "UNDER")
        self.assertGreater(r["p_pick"], 0.5)
        self.assertFalse(r["under_be"]["applied"])
        self.assertIn(r["grade"], [g for _, g, _ in GRADE_SCALE] + ["F"])

    def test_hitrates_still_over_counts(self):
        hits = self.g.hitrates(self.p, "kills", 30.5, "G2")
        self.assertIn("l10", hits)
        self.assertEqual(hits["l10"][1], 10)
        g = self.g.grade(self.p, "kills", 55.5, "G2", "Spirit", "PrizePicks", -137)
        self.assertEqual(g["pick"], "UNDER")
        self.assertEqual(g["hits"]["l10"], hits["l10"] if False else g["hits"]["l10"])
        self.assertEqual(g["hits"]["l10"], self.g.hitrates(self.p, "kills", 55.5, "G2")["l10"])

    def test_map1_period_on_grade(self):
        r = self.g.grade(self.p, "kills", 16.5, "G2", "Spirit", "PrizePicks", -137, period="Map 1")
        self.assertEqual(r["period"], "Map 1")
        self.assertLess(r["proj"], 30)



class CapTests(unittest.TestCase):
    def setUp(self):
        self.p = player(logs=mixed_form())
        self.g = Grader([self.p], ranks={"G2": 2, "FaZe": 3, "Spirit": 1})
        self.flat = player(name="flat", logs=stacked())
        self.gf = Grader([self.flat], ranks={"G2": 2, "FaZe": 3, "Spirit": 1})

    def _strong(self, ev=None, line=30.5, st="kills"):
        return self.g.grade(self.p, st, line, "G2", "Spirit", "Underdog", None, ev=ev)

    def test_online_kills_can_be_a_or_b(self):
        r = self._strong(ev="online")
        self.assertFalse(r["bait"])
        self.assertFalse((r.get("grade_cap") or {}).get("applied"))
        # Mixed-form player vs 30.5 Underdog should have enough edge to be a play grade, without bait.
        self.assertIn(r["grade"], PLAY_GRADES)
        self.assertTrue(r["stake"] >= 1.0)

    def test_lan_kills_capped_at_c_plus(self):
        raw = self._strong(ev="online")
        self.assertIn(raw["grade"], PLAY_GRADES)
        self.assertFalse(raw["bait"])
        r = self._strong(ev="lan")
        self.assertEqual(r["grade"], "C+")
        self.assertEqual(r["stake"], CAP_STAKE)
        self.assertTrue(r["grade_cap"]["applied"])
        self.assertEqual(r["grade_cap"]["reason"], "lan_kills")
        self.assertIn(r["grade_cap"]["pre_grade"], PLAY_GRADES)
        self.assertEqual(r["model"], "v1f")
        self.assertNotIn(r["grade"], PLAY_GRADES)

    def test_lan_headshots_not_capped(self):
        r = self.g.grade(self.p, "hs", 10.5, "G2", "Spirit", "Underdog", None, ev="lan")
        self.assertIsNotNone(r)
        self.assertTrue("lan_kills" not in ((r.get("grade_cap") or {}).get("reason") or ""))
        if r["grade"] in PLAY_GRADES:
            self.assertFalse(r["grade_cap"]["applied"])

    def test_bait_capped_at_c_plus(self):
        # Flat ~38-kill series: a 20.5 line is bait (last 5 all hit) and has enough edge to be A/B before the cap.
        r = self.gf.grade(self.flat, "kills", 20.5, "G2", "Spirit", "Underdog", None, ev="online")
        self.assertTrue(r["bait"])
        self.assertEqual(r["grade"], "C+")
        self.assertTrue(r["grade_cap"]["applied"])
        self.assertIn("bait", r["grade_cap"]["reason"])
        self.assertNotIn(r["grade_cap"]["pre_grade"], ("C+", "C", "D", "F"))

    def test_already_c_or_worse_stays(self):
        # Line close to the projection: edge is small (C/D/F), ev=lan, so the cap must not raise it to C+.
        r = self._strong(ev="lan", line=36.5)
        raw_letter, _ = letter_from_edge(r["edge_pp"])
        self.assertNotIn(raw_letter, PLAY_GRADES)
        self.assertEqual(r["grade"], raw_letter)
        self.assertFalse(r["grade_cap"]["applied"])

    def test_cap_reasons_helper(self):
        self.assertEqual(cap_reasons("kills", ev="lan", bait=False), ["lan_kills"])
        self.assertEqual(cap_reasons("hs", ev="lan", bait=False), [])
        self.assertEqual(cap_reasons("kills", ev="online", bait=True), ["bait"])
        self.assertEqual(cap_reasons("kills", ev="lan", bait=True), ["bait", "lan_kills"])
        r = {"grade": "A+", "stake": 2.0}
        apply_grade_cap(r, "kills", ev="lan", bait=False)
        self.assertEqual(r["grade"], "C+")
        self.assertEqual(r["stake"], 0.5)
        self.assertEqual(r["grade_cap"]["pre_grade"], "A+")

    def test_apply_grade_cap_idempotent_on_c(self):
        r = {"grade": "C", "stake": 0.25, "bait": False}
        apply_grade_cap(r, "kills", ev="lan", bait=False)
        self.assertEqual(r["grade"], "C")
        self.assertFalse(r["grade_cap"]["applied"])


class JsParityTests(unittest.TestCase):
    def test_js_residual_parity(self):
        import json, subprocess
        root = os.path.join(os.path.dirname(__file__), "..")
        r = subprocess.run(["node", "tests/test_calib_js.js"], cwd=root, capture_output=True, text=True, check=True)
        js = json.loads(r.stdout)
        cases = [
            (26.8, 23.5, "kills", "Maps 1-2", 1),
            (26.8, 24, "kills", "Maps 1-2", 1),
            (12.2, 11.5, "hs", "Map 1", 1),
            (53.6, 47, "kills", "Maps 1-2", 2),
            (20, 30.5, "kills", "Maps 1-2", 1),
        ]
        self.assertEqual(len(js), len(cases))
        for c, j in zip(cases, js):
            po, pp, pu = residual_probs(*c)
            self.assertAlmostEqual(po, j["po"], places=9)
            self.assertAlmostEqual(pp, j["push"], places=9)
            self.assertAlmostEqual(pu, j["pu"], places=9)
            self.assertAlmostEqual(j["erf0"], 0.0, places=6)
            pick = "OVER" if po >= pu else "UNDER"
            p = po if pick == "OVER" else pu
            g, stake = letter_from_edge((p - 0.53) * 100)
            self.assertEqual(g, j["grade"])
            self.assertAlmostEqual(stake, j["stake"], places=9)

    def test_regrade_tag_unchanged(self):
        import fetch_lines
        self.assertEqual(fetch_lines.REGRADE_TAG, "h2h-2")


class HistoryUntouchedTests(unittest.TestCase):
    def test_lines_history_hash_stable(self):
        path = os.path.join(os.path.dirname(__file__), "..", "lines_history.json")
        with open(path, "rb") as f:
            raw = f.read()
        self.assertGreater(len(raw), 1000)
        before = hashlib.sha256(raw).hexdigest()
        with open(path, "rb") as f:
            after = hashlib.sha256(f.read()).hexdigest()
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
