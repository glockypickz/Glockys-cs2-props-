"""Walk-forward backtest for the grader (v2) vs the legacy grader. No network, read-only.

  python backtest.py            report with the PARAMS in grader.py
  python backtest.py --tune     also tune the parameters on the EARLY slice only and report on the later holdout
  python backtest.py --tune-hs     tune the HS% weights (w_hs5..w_hsszn for headshots, w_khs5..w_khsszn for kills)
  python backtest.py --tune-form   tune the kill-form weights (w_l5 / w_l10 / w_l15 / w_szn / w_kd) the same way
  python backtest.py --strength tests/fixtures/team_strength_mock.json   use a Cito team_strength file (default:
                                team_strength.json if present); --no-cito ignores it. Cito features only ever use
                                snapshots dated BEFORE each predicted match (rankings / map stats), never same-day data.
                                This script never calls the Cito API: it only reads saved files.

Part 1 (players.json, no lines needed): every Map 1+2 series is predicted with only logs dated before that
series (Elo, team rates, player rates all as of the day before). Scores: negative-binomial log-likelihood of
the real total, MAE of the projection, and calibration of P(over) on a synthetic line (player's last-10 mean
rounded to .5, clearly NOT a real book line).
Part 2 (lines_history.json, real lines): every locked pick that can be matched to a result is re-graded
walk-forward with v2 and compared with the legacy grade that was locked at the time. Scores: Brier and log
loss vs the line-implied 0.5 (no-vig, pick'em lines are priced symmetric), hit rate by grade with
match-clustered bootstrap intervals. The line blend w is tuned on the earlier days and reported on later days.
Never prints made-up numbers: every figure is computed from the files in the repo.
"""
import json, math, random, sys, datetime, statistics as S
import grader as GV
from grader import Grader as _Grader, PARAMS, teq, norm, nb_probs, break_even, load_strength
import grader_legacy as GL
from settle import find_result

STRENGTH = None              # team_strength data (set in main from --strength / --no-cito)


def Grader(players, ranks=None, params=None):
    return _Grader(players, ranks, params=params, strength=STRENGTH)


SPLIT = "2026-10-20"        # players.json: tune on series before this date, report on series from it
LINE_SPLIT = "2026-11-15"   # lines_history: tune w on matches before this UTC date, report on matches from it
W_GRID = (0.0, 0.25, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0)
SIZES = [8, 12, 16, 20, 25, 30, 40, 50, 60, 80, 100, 130, 170, 220, 300, 500]


def nb_logpmf(x, mu, r):
    x = int(round(x))
    return (math.lgamma(x + r) - math.lgamma(r) - math.lgamma(x + 1) + r * math.log(r / (r + mu)) + x * math.log(mu / (r + mu)))


def wilson(k, n, z=1.96):
    if not n:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def cluster_ci(rows, key="mid", val="hit", B=2000, seed=7):
    """95% interval for the mean of val, resampling whole matches (picks in one match move together)."""
    g = {}
    for r in rows:
        g.setdefault(r[key], []).append(1.0 if r[val] else 0.0)
    ks = list(g)
    if len(ks) < 2:
        return (float("nan"), float("nan"))
    rnd = random.Random(seed)
    out = []
    for _ in range(B):
        s = [ks[rnd.randrange(len(ks))] for _ in ks]
        n = sum(len(g[k]) for k in s)
        out.append(sum(sum(g[k]) for k in s) / n)
    out.sort()
    return out[int(0.025 * B)], out[int(0.975 * B)]


def pct(x):
    return "–" if x is None or x != x else "%.1f%%" % (100 * x)


# ---------------------------------------------------------------- part 1: players.json walk-forward
def events(G, min_prior=3):
    ev = []
    for p in G.players:
        cs = G.series(p)
        for i, c in enumerate(cs):
            if not c["rd"] or c["hs"] is None:
                continue
            prior = [x for x in cs[i + 1:] if x["date"] < c["date"]]
            if len(prior) < min_prior:
                continue
            ev.append((p, c, len(prior)))
    return ev


def predict_all(G, ev, st):
    out = []
    for p, c, n in ev:
        pr = G.project(p, st, c["opp"], p.get("team"), c["date"])
        if pr:
            out.append((pr["mu"], c[st], c, n, p))
    return out


def best_size(preds):
    best = None
    for r in SIZES:
        ll = sum(nb_logpmf(a, max(mu, 0.1), r) for mu, a, *_ in preds) / len(preds)
        if best is None or ll > best[1]:
            best = (r, ll)
    return best


def fit_globals_and_rounds(players, params, before):
    G = Grader(players, params=params)
    k = h = rd = 0.0
    for p in players:
        for c in G.series(p):
            if c["date"] < before and c["rd"] and c["hs"] is not None:
                k += c["kills"]; h += c["hs"]; rd += c["rd"]
    xs, ys = [], []
    for d, _, _, a, b, s in G.maps:
        if d >= before:
            continue
        pw = GV.winp(G.elo(a, d), G.elo(b, d))
        xs.append(pw * (1 - pw))
    # rounds per map: use the map logs (one per map) with their rd
    seen = set()
    rows = []
    for p in players:
        t = p.get("team")
        for l in p.get("logs") or []:
            key = (l.get("mid"), l.get("n"))
            if key in seen or (l.get("date") or "") >= before or not isinstance(l.get("rd"), (int, float)) or l["rd"] < 13:
                continue
            seen.add(key)
            pw = GV.winp(G.elo(t, l["date"]), G.elo(l.get("opp"), l["date"]))
            rows.append((pw * (1 - pw), float(l["rd"])))
    mx = S.mean(x for x, _ in rows); my = S.mean(y for _, y in rows)
    b = sum((x - mx) * (y - my) for x, y in rows) / sum((x - mx) ** 2 for x, _ in rows)
    a = my - b * mx
    return {"g_kills": round(k / rd, 4), "g_hs": round(h / rd, 4), "rd_a": round(a, 2), "rd_b": round(b, 2)}, len(rows)


def score(players, params, slice_fn, min_prior=3):
    G = Grader(players, params=params)
    ev = [e for e in events(G, min_prior) if slice_fn(e[1]["date"])]
    res = {}
    for st in ("kills", "hs"):
        pr = predict_all(G, ev, st)
        size, ll = best_size(pr)
        mae = S.mean(abs(mu - a) for mu, a, *_ in pr)
        res[st] = {"n": len(pr), "size": size, "ll": ll, "mae": mae}
    return res


def tune(players):
    P = dict(PARAMS)
    early = lambda d: d < SPLIT
    g, nmaps = fit_globals_and_rounds(players, P, SPLIT)
    P.update(g)
    print("fitted on the early slice (%d maps): %s" % (nmaps, g))
    grid = {"elo_k": [16, 24, 32], "m": [50, 75, 100, 150, 200, 250, 300], "half_life": [3, 5, 8, 12, 20, 1000],
            "beta": [0.0, 0.25, 0.5, 0.75, 1.0], "h2h_w": [0.0, 0.1, 0.2]}
    if STRENGTH:
        grid.update({"w_rank": [0.0, 0.25, 0.5, 0.75, 1.0], "rank_s": [0.5, 1.0, 2.0], "w_maps": [0.0, 0.25, 0.5, 0.75, 1.0], "k_maps": [2.0, 6.0, 15.0]})
    obj = lambda r: r["kills"]["ll"] + r["hs"]["ll"]
    best = obj(score(players, P, early))
    for _round in range(2):
        for k, vals in grid.items():
            for v in vals:
                if v == P[k]:
                    continue
                Q = dict(P, **{k: v})
                if k == "elo_k":
                    Q.update(fit_globals_and_rounds(players, Q, SPLIT)[0])
                s = obj(score(players, Q, early))
                if s > best + 1e-6:
                    best, P = s, Q
            print("  after %s: %s = %s  (early log-lik %.4f)" % (k, k, P[k], best))
    r = score(players, P, early)
    P["size_kills"], P["size_hs"] = float(r["kills"]["size"]), float(r["hs"]["size"])
    return P


FORM_GRID = {"w_l5": [0.0, 0.05, 0.1, 0.2, 0.3], "w_l10": [0.0, 0.05, 0.1, 0.2, 0.3], "w_l15": [0.0, 0.05, 0.1, 0.2, 0.3],
             "w_szn": [0.0, 0.1, 0.2, 0.3, 0.5, 0.75], "w_kd": [0.0, 0.25, 0.5, 1.0]}
FORM_KEYS = tuple(FORM_GRID)


def tune_form(players, P):
    """Kill-form weights (w_l5 / w_l10 / w_l15 / w_szn / w_kd): coordinate search on the EARLY slice (kills NB log-lik),
    then reported on the holdout. Every prediction only uses series dated before the predicted one."""
    early, late = (lambda d: d < SPLIT), (lambda d: d >= SPLIT)
    Q = dict(P, **{k: 0.0 for k in FORM_KEYS})
    kl = lambda R: score(players, R, early)["kills"]["ll"]
    best = kl(Q)
    print("  form weights all 0: early kills log-lik %.4f" % best)
    for _round in range(2):
        for k, vals in FORM_GRID.items():
            for v in vals:
                if v == Q[k]:
                    continue
                R = dict(Q, **{k: v})
                s = kl(R)
                if s > best + 1e-5:
                    best, Q = s, R
            print("    after %s: %s = %s  (early kills log-lik %.4f)" % (k, k, Q[k], best))
    Z = dict(P, **{k: 0.0 for k in FORM_KEYS})
    for name, fn in (("early <" + SPLIT, early), ("HOLDOUT >=" + SPLIT, late)):
        a, b = score(players, Z, fn)["kills"], score(players, Q, fn)["kills"]
        print("  %-22s kills n=%d  MAE %.3f -> %.3f | log-lik %.4f -> %.4f (form 0 -> tuned)" % (name, a["n"], a["mae"], b["mae"], a["ll"], b["ll"]))
    return {k: Q[k] for k in FORM_KEYS}


HS_GRID = {"hs": ("hs", {"w_hs5": [0.0, 0.1, 0.2, 0.3, 0.5], "w_hs10": [0.0, 0.1, 0.2, 0.3, 0.5],
                          "w_hs15": [0.0, 0.1, 0.2, 0.3, 0.5], "w_hsszn": [0.0, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0]}),
           "kills": ("kills", {"w_khs5": [-0.5, -0.25, 0.0, 0.25, 0.5], "w_khs10": [-0.5, -0.25, 0.0, 0.25, 0.5],
                               "w_khs15": [-0.5, -0.25, 0.0, 0.25, 0.5], "w_khsszn": [-1.0, -0.5, -0.25, 0.0, 0.25, 0.5, 1.0]})}
HS_KEYS = tuple(k for _st, g in HS_GRID.values() for k in g)


def tune_hs(players, P):
    """HS% weights: headshots-projection weights (w_hs*) on the early-slice headshots NB log-lik, kills-projection
    weights (w_khs*) on the early-slice kills NB log-lik; coordinate search, then reported on the holdout."""
    early, late = (lambda d: d < SPLIT), (lambda d: d >= SPLIT)
    Q = dict(P, **{k: 0.0 for k in HS_KEYS})
    for label, (st, grid) in HS_GRID.items():
        obj = lambda R: score(players, R, early)[st]["ll"]
        best = obj(Q)
        print("  %s: HS%% weights all 0: early %s log-lik %.4f" % (label, st, best))
        for _round in range(2):
            for k, vals in grid.items():
                for v in vals:
                    if v == Q[k]:
                        continue
                    R = dict(Q, **{k: v})
                    s = obj(R)
                    if s > best + 1e-5:
                        best, Q = s, R
                print("    after %s: %s = %s  (early %s log-lik %.4f)" % (k, k, Q[k], st, best))
    Z = dict(P, **{k: 0.0 for k in HS_KEYS})
    for name, fn in (("early <" + SPLIT, early), ("HOLDOUT >=" + SPLIT, late)):
        a, b = score(players, Z, fn), score(players, Q, fn)
        for st in ("hs", "kills"):
            print("  %-22s %-5s n=%d  MAE %.3f -> %.3f | log-lik %.4f -> %.4f (HS%% 0 -> tuned)" % (
                name, st, a[st]["n"], a[st]["mae"], b[st]["mae"], a[st]["ll"], b[st]["ll"]))
    return {k: Q[k] for k in HS_KEYS}


def legacy_mae(players, slice_fn, min_prior=3):
    G = Grader(players)
    L = GL.Grader(players, {})
    out = {"kills": [], "hs": []}
    for p, c, n in events(G, min_prior):
        if not slice_fn(c["date"]):
            continue
        past = {"name": p["name"], "team": p.get("team"), "logs": [l for l in p["logs"] if (l.get("date") or "") < c["date"]]}
        for st in ("kills", "hs"):
            g = L.grade(past, st, 1.0, c["opp"])
            if g:
                out[st].append(abs(g["proj"] - c[st]))
    return {k: (S.mean(v) if v else None, len(v)) for k, v in out.items()}


def synthetic_calibration(players, params, slice_fn, min_prior=8):
    G = Grader(players, params=params)
    bins = {}
    rows = []
    for p, c, n in events(G, min_prior):
        if not slice_fn(c["date"]):
            continue
        st = "kills"
        prior = [x[st] for x in G.series(p) if x["date"] < c["date"]][:10]
        line = math.floor(S.mean(prior)) + 0.5
        pr = G.project(p, st, c["opp"], p.get("team"), c["date"])
        if not pr:
            continue
        o, e, u = nb_probs(pr["mu"], params["size_kills"], line)
        y = 1.0 if c[st] > line else 0.0
        rows.append((o, y))
        b = min(9, int(o * 10))
        bins.setdefault(b, []).append((o, y))
    brier = S.mean((o - y) ** 2 for o, y in rows)
    base = S.mean((0.5 - y) ** 2 for o, y in rows)
    return rows, bins, brier, base


# ---------------------------------------------------------------- part 2: real lines (lines_history.json)
def settle(G, e):
    """(stat, actual, mid, date) for a history entry, or None. Same matching as settle.py / the site."""
    found, why = find_result(G, e)
    return found


def line_rows(players, params):
    G = Grader(players, params=params)
    hist = json.load(open("lines_history.json", encoding="utf-8"))["entries"]
    rows, seen = [], set()
    for e in hist:
        lk = e.get("lock")
        if not lk or not lk.get("grade"):
            continue
        s = settle(G, e)
        if not s:
            continue
        st, act, mid, date = s
        line = float(lk["line"])
        key = (norm(e["player"]), st, e["start"][:10])
        dup = key in seen
        seen.add(key)
        if "+" in e["player"]:
            g = G.grade_combo(e["player"], e.get("team"), st, line, e.get("opponent"), e["book"], e.get("odds"), date)
            if g is None:
                continue
            mu = g["mu_model"]
        else:
            p = G.find(e["player"], e.get("team"))
            pr = G.project(p, st, e.get("opponent"), e.get("team") or p.get("team"), date)
            if not pr:
                continue
            hits = G.hitrates(p, st, line, e.get("opponent"), date)   # series before the match only
            g = G.finish(pr["mu"], line, st, e["book"], e.get("odds"), G.filters(p, e.get("team"), pr["n"], date), hr=hits["p"])
            mu = pr["mu"]
        rows.append({"start": e["start"], "book": e["book"], "stat": st, "line": line, "act": act, "mid": mid, "dup": dup,
                     "push": act == line, "over": act > line, "mu": mu, "v2": g,
                     "hr": None if "+" in e["player"] else hits["p"],
                     "old_grade": lk["grade"], "old_pick": lk["pick"],
                     "old_hit": (act > line) if lk["pick"] == "OVER" else (act < line)})
    return rows


HR_GRID = (0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5)


def p_over_with_w(r, w, P, whr=0.0):
    size = P["size_kills"] if r["stat"] == "kills" else P["size_hs"]
    p = GV.p_over_np(GV.blend_mean(r["mu"], r["line"], size, w), size, r["line"])
    if whr > 0 and r.get("hr") is not None:
        p = (1 - whr) * p + whr * r["hr"]
    return p


def line_scores(rows, w, P, whr=0.0):
    rs = [r for r in rows if not r["push"]]
    br = S.mean((p_over_with_w(r, w, P, whr) - r["over"]) ** 2 for r in rs)
    ll = -S.mean(math.log(max(1e-9, p if r["over"] else 1 - p)) for r in rs for p in [p_over_with_w(r, w, P, whr)])
    return br, ll, len(rs)


def letter_summary(out, key="ng", hit="nhit"):
    return "  ".join("%s %d/%d %s" % (g, sum(x[hit] for x in out if x[key] == g), sum(1 for x in out if x[key] == g),
                                       pct(S.mean(x[hit] for x in out if x[key] == g)) if any(x[key] == g for x in out) else "–")
                     for g in ("A", "B", "C", "D", "F"))


def grade_table(rows, w, P, label, whr=None, quiet=False):
    whr = P.get("w_hr", 0.0) if whr is None else whr
    G = Grader([], params=dict(P, w_line=w, w_hr=whr))
    out = []
    for r in rows:
        if r["push"]:
            continue
        g = G.finish(r["mu"], r["line"], r["stat"], r["book"], None, r["v2"]["reasons"], hr=r.get("hr"))
        g["flagged"] = bool(g["reasons"])
        hit = r["over"] if g["pick"] == "OVER" else (not r["over"])
        out.append(dict(r, ng=g["grade"], npick=g["pick"], nhit=hit, epp=g["edge_pp"]))
    if quiet:
        return out
    print("\n  v2 grades on %s (w=%.2f, w_hr=%.2f):" % (label, w, whr))
    print("  %-6s %5s %9s %8s %16s %16s" % ("grade", "n", "record", "hit", "Wilson 95%", "match-clustered"))
    for gname in ("A", "B", "C", "D", "F"):
        a = [x for x in out if x["ng"] == gname]
        k = sum(x["nhit"] for x in a)
        lo, hi = wilson(k, len(a))
        clo, chi = cluster_ci([dict(x, hit=x["nhit"]) for x in a])
        print("  %-6s %5d %4d-%-4d %8s %7s-%-7s %7s-%-7s" % (gname, len(a), k, len(a) - k, pct(k / len(a) if a else None), pct(lo), pct(hi), pct(clo), pct(chi)))
    print("  legacy grades, same picks:")
    for gname in ("A+", "B", "C", "D", "F"):
        a = [x for x in out if x["old_grade"] == gname]
        k = sum(x["old_hit"] for x in a)
        clo, chi = cluster_ci([dict(x, hit=x["old_hit"]) for x in a])
        print("  %-6s %5d %4d-%-4d %8s  clustered %s-%s" % (gname, len(a), k, len(a) - k, pct(k / len(a) if a else None), pct(clo), pct(chi)))
    return out


def main():
    global STRENGTH
    if "--no-cito" in sys.argv:
        STRENGTH, src = None, "off (--no-cito)"
    else:
        path = sys.argv[sys.argv.index("--strength") + 1] if "--strength" in sys.argv else "team_strength.json"
        STRENGTH = load_strength(path)
        src = ("%s (%s)" % (path, STRENGTH.get("source", "?"))) if STRENGTH else "none (no %s)" % path
    print("Cito team_strength:", src, "| w_rank %s w_maps %s" % (PARAMS["w_rank"], PARAMS["w_maps"]))
    data = GV.load_players("players.json")
    players = data["players"]
    P = dict(PARAMS)
    if "--tune" in sys.argv:
        print("== tuning on players.json series before", SPLIT)
        P = tune(players)
        print("TUNED PARAMS:", json.dumps({k: P[k] for k in sorted(P)}))
    early, late = (lambda d: d < SPLIT), (lambda d: d >= SPLIT)

    form = None
    if "--tune-form" in sys.argv:
        print("\n== tuning the kill-form weights (last 5 / 10 / 15 / season kill rate, season K/D)")
        form = tune_form(players, P)
        print("TUNED FORM WEIGHTS:", json.dumps(form))
    hsw = None
    if "--tune-hs" in sys.argv:
        print("\n== tuning the HS% weights (last 5 / 10 / 15 / season HS%, headshots and kills projections)")
        hsw = tune_hs(players, P)
        print("TUNED HS% WEIGHTS:", json.dumps(hsw))
        print("\n== Locked lines, HS%% weights 0 vs tuned (shipped w_line=%.2f):" % P["w_line"])
        for lab, FP in (("HS% 0", dict(P, **{k: 0.0 for k in HS_KEYS})), ("HS% tuned", dict(P, **hsw))):
            rows = [r for r in line_rows(players, FP) if not r["dup"]]
            for st in ("hs", "kills"):
                ks = [r for r in rows if r["stat"] == st]
                br, ll, n = line_scores(ks, P["w_line"], FP)
                print("  %-9s %-5s lines n=%d  Brier %.4f  log loss %.4f | hit %% by letter: %s" % (
                    lab, st, n, br, ll, letter_summary(grade_table(ks, P["w_line"], FP, lab, quiet=True))))
    print("\n== Part 1: players.json walk-forward (every Map 1+2 series, predicted with earlier data only)")
    for name, fn in (("early (tuning) slice <" + SPLIT, early), ("HOLDOUT >=" + SPLIT, late)):
        r = score(players, P, fn)
        lg = legacy_mae(players, fn)
        for st in ("kills", "hs"):
            print("  %-34s %-5s n=%5d  v2 MAE %.2f | legacy MAE %.2f (n=%d) | v2 NB log-lik/series %.3f (best size %s)" % (
                name, st, r[st]["n"], r[st]["mae"], lg[st][0], lg[st][1], r[st]["ll"], r[st]["size"]))
    rows, bins, brier, base = synthetic_calibration(players, P, late)
    print("\n  Calibration on HOLDOUT, kills, SYNTHETIC line = floor(last-10 mean)+0.5 (not a book line), 8+ prior series:")
    print("  n=%d  Brier v2 %.4f vs 0.5-baseline %.4f" % (len(rows), brier, base))
    for b in sorted(bins):
        a = bins[b]
        print("    P(over) %.1f-%.1f: n=%5d  predicted %s  actual %s" % (b / 10, (b + 1) / 10, len(a), pct(S.mean(o for o, _ in a)), pct(S.mean(y for _, y in a))))

    if form is not None and any(form.values()):
        print("\n== Locked lines, kill-form weights 0 vs tuned (shipped w_line=%.2f):" % P["w_line"])
        for lab, FP in (("form 0", dict(P, **{k: 0.0 for k in FORM_KEYS})), ("form tuned", dict(P, **form))):
            rows = [r for r in line_rows(players, FP) if not r["dup"]]
            ks = [r for r in rows if r["stat"] == "kills"]
            br, ll, n = line_scores(ks, P["w_line"], FP)
            print("  %-10s kills lines n=%d  Brier %.4f  log loss %.4f | hit %% by letter: %s" % (
                lab, n, br, ll, letter_summary(grade_table(ks, P["w_line"], FP, lab, quiet=True))))
    print("\n== Part 2: real locked lines from lines_history.json (re-graded walk-forward with v2)")
    lr = line_rows(players, P)
    main_rows = [r for r in lr if not r["dup"]]
    print("  settled locked lines: %d (%d after keeping one per player/stat/day like the site), pushes %d, matches %d" % (
        len(lr), len(main_rows), sum(r["push"] for r in main_rows), len({r["mid"] for r in main_rows})))
    tr = [r for r in main_rows if r["start"][:10] < LINE_SPLIT]
    ho = [r for r in main_rows if r["start"][:10] >= LINE_SPLIT]
    best_w = None
    print("  line blend w (mu = w*line_mean + (1-w)*model; line_mean = NB mean that makes the line 50/50), tuned on matches before %s (n=%d):" % (LINE_SPLIT, len(tr)))
    for w in W_GRID:
        br, ll, n = line_scores(tr, w, P)
        print("    w=%.2f  Brier %.4f  log loss %.4f" % (w, br, ll))
        if best_w is None or ll < best_w[1]:
            best_w = (w, ll)
    w = best_w[0]
    base_tr = S.mean((0.5 - r["over"]) ** 2 for r in tr if not r["push"])
    print("    line-implied 0.5 baseline on that slice: Brier %.4f  log loss %.4f -> chosen w=%.2f" % (base_tr, math.log(2), w))
    print("\n  hit-rate weight w_hr (P = (1-w_hr)*P_model + w_hr*hit rate vs this line, earlier series only), tuned on matches before %s with w=%.2f:" % (LINE_SPLIT, w))
    best_h = None
    for h in HR_GRID:
        br, ll, n = line_scores(tr, w, P, h)
        print("    w_hr=%.2f  Brier %.4f  log loss %.4f" % (h, br, ll))
        if best_h is None or ll < best_h[1] - 1e-9:
            best_h = (h, ll)
    whr = best_h[0]
    print("    -> chosen w_hr=%.2f (0 means the hit rate did not help on the earlier lines)" % whr)
    for label, rs in (("HOLDOUT from " + LINE_SPLIT, ho), ("all settled lines", main_rows)):
        print("    %s: " % label + " | ".join("w_hr=%.2f log loss %.4f Brier %.4f" % (hh, line_scores(rs, w, P, hh)[1], line_scores(rs, w, P, hh)[0])
                                                  for hh in sorted({0.0, whr, 0.2})))
        for hh in sorted({0.0, whr, 0.2}):
            print("      hit %% by letter, w=%.2f w_hr=%.2f: %s" % (w, hh, letter_summary(grade_table(rs, w, P, label, whr=hh, quiet=True))))
        for hh in sorted({0.0, whr, 0.2}):
            print("      hit %% by letter, MODEL ONLY w=0 w_hr=%.2f: %s" % (hh, letter_summary(grade_table(rs, 0.0, P, label, whr=hh, quiet=True))))
    for label, rs in (("HOLDOUT matches from " + LINE_SPLIT, ho), ("all settled lines", main_rows)):
        br, ll, n = line_scores(rs, w, P)
        br0, ll0, _ = line_scores(rs, 0.0, P)
        b5 = S.mean((0.5 - r["over"]) ** 2 for r in rs if not r["push"])
        print("\n  %s: n=%d (no pushes), matches %d" % (label, n, len({r['mid'] for r in rs})))
        print("    Brier: v2(w=%.2f) %.4f | v2(w=0) %.4f | line-implied 0.5 %.4f" % (w, br, br0, b5))
        print("    log loss: v2(w=%.2f) %.4f | v2(w=0) %.4f | line-implied 0.5 %.4f" % (w, ll, ll0, math.log(2)))
        grade_table(rs, w, P, label)
        if w > 0:
            grade_table(rs, 0.0, P, label + " -- MODEL ONLY, no line blend (for information; NOT what ships)")
    return P, w


if __name__ == "__main__":
    main()
