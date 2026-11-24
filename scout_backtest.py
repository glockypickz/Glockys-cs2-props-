"""Chronological backtest of the Scout-style factor projection (scout_model.py) vs the live v1be grader. Read-only.

  python scout_backtest.py build     compute features for every event (cached in /tmp/scout_events.pkl)
  python scout_backtest.py report    fit on TRAIN, pick factors on VAL, report on HOLDOUT + real locked book lines

Splits (match day): TRAIN 2026-04-01..2026-09-19, VAL 2026-09-20..2026-10-19, HOLDOUT 2026-10-20 on.
Real book lines (lines_history.json, Nov 13-22, all after the train/val data) are only ever used for the final report.
Nothing is written to any data file; locked grades are not touched.
"""
import json, math, os, pickle, random, sys
import numpy as np
from grader import Grader, load_players, merge_cito, load_strength, is_map1, teq, tn
import scout_model as SM

TRAIN0, VAL0, HOLD0 = "2026-04-01", "2026-09-20", "2026-10-20"
CACHE = os.environ.get("SCOUT_CACHE", "/tmp/scout_events.pkl")
MIN_PRIOR = 8


def build_grader():
    d = load_players("players.json")
    pl, _ = merge_cito(d.get("players", []))
    gr = Grader(pl, d.get("ranks") or {}, strength=load_strength())
    memo = {}
    orig = gr.rank_of
    gr.rank_of = lambda name: memo[name] if name in memo else memo.setdefault(name, orig(name))
    return gr, pl


def series_ev(S, p, mid):
    return S.ev_of(p, mid=mid)


def build():
    gr, pl = build_grader()
    S = SM.ScoutData(pl, gr)
    ev_rows = []
    seen = set()
    for pi, p in enumerate(pl):
        for per in ("Maps 1-2", "Map 1"):
            cs = gr.series(p, per)
            asc = sorted(cs, key=lambda c: (c["date"], str(c["mid"])))
            dates = [c["date"] for c in asc]
            for c in asc:
                D = c["date"]
                if D < TRAIN0 or c.get("kills") is None:
                    continue
                key = (id(p), per, D, tn(c["opp"]))
                if key in seen:
                    continue
                seen.add(key)
                import bisect
                if bisect.bisect_left(dates, D) < MIN_PRIOR:
                    continue
                f = SM.features(S, p, p.get("team"), c["opp"], D, per, S.ev_of(p, mid=c["mid"]), bo=S.bo_of(c["mid"]))
                if not f:
                    continue
                row = {"player": p["name"], "team": p.get("team"), "opp": c["opp"], "date": D, "period": per, "mid": c["mid"],
                       "act": {"kills": c["kills"], "hs": c.get("hs")}, "act_rd": c.get("rd"), "bo": S.bo_of(c["mid"]), "f": {k: v for k, v in f.items() if k not in ("veto", "veto_top")},
                       "v1": {}}
                for st in ("kills", "hs"):
                    if c.get(st) is None:
                        continue
                    v = gr.v1_project(p, st, c["opp"], D, period=per)
                    row["v1"][st] = v
                ev_rows.append(row)
        if pi % 200 == 0:
            print(pi, len(ev_rows), flush=True)
    # real book lines
    H = json.load(open("lines_history.json"))["entries"]
    lines = []
    for e in H:
        lk, rs = e.get("lock"), e.get("result")
        if not lk or not rs or rs.get("outcome") not in ("hit", "miss", "push") or "+" in e["player"] or rs.get("act") is None:
            continue
        st = "hs" if "head" in e["stat"].lower() else "kills"
        p = gr.find(e["player"], e.get("team"))
        if not p:
            continue
        D = str(e["start"])[:10]
        per = "Map 1" if is_map1(e) else "Maps 1-2"
        evs = S.ev_of(p, mid=rs.get("mid")) or S.ev_of(p, D=rs.get("date"))
        f = SM.features(S, p, e.get("team"), e.get("opponent") or "", D, per, evs, bo=S.bo_of(rs.get("mid")))
        if not f:
            continue
        v1 = gr.v1_project(p, st, e.get("opponent") or "", D, period=per)
        lines.append({"player": e["player"], "team": e.get("team"), "opp": e.get("opponent"), "date": D, "start": e["start"], "st": st,
                      "book": e.get("book"), "odds": e.get("odds"), "line": float(lk["line"]), "close": e.get("line"),
                      "lock_proj": lk.get("proj"), "lock_grade": lk.get("grade"), "lock_pick": lk.get("pick"),
                      "act": float(rs["act"]), "mid": rs.get("mid"), "period": per, "v1": v1,
                      "f": {k: v for k, v in f.items() if k not in ("veto", "veto_top")}, "veto": f["veto_top"]})
    pickle.dump({"events": ev_rows, "lines": lines}, open(CACHE, "wb"))
    print("events", len(ev_rows), "lines", len(lines))


# ------------------------------------------------------------------ fitting
def fit_rounds(E):
    """rd per map = a + b * base + c * pw(1-pw), fit on TRAIN events (one row per team-match)."""
    xs, ys, seen = [], [], set()
    for r in E:
        if not (TRAIN0 <= r["date"] < VAL0):
            continue
        k = (tn(r["team"]), r["date"], r["opp"], r["period"])
        if k in seen or not r.get("act_rd"):
            continue
        seen.add(k)
        f = r["f"]
        xs.append([1.0, f["rbase"], f["pw"] * (1 - f["pw"])])
        ys.append(r["act_rd"] / f["nmaps"])
    X, y = np.array(xs), np.array(ys)
    b = np.linalg.lstsq(X, y, rcond=None)[0]
    return {"rd_a": float(b[0]), "rd_b": float(b[1]), "rd_c": float(b[2])}, len(ys)


def poisson_fit(off, X, y, ridge=1e-3, it=50):
    n, k = X.shape
    Xa = np.hstack([np.ones((n, 1)), X])
    b = np.zeros(k + 1)
    b[0] = math.log(max(1e-6, y.sum() / np.exp(off).sum()))
    for _ in range(it):
        eta = off + Xa @ b
        mu = np.exp(eta)
        g = Xa.T @ (y - mu) - ridge * np.r_[0, b[1:]] * n
        Hm = (Xa * mu[:, None]).T @ Xa + ridge * n * np.diag(np.r_[0, np.ones(k)])
        step = np.linalg.solve(Hm, g)
        b += step
        if np.abs(step).max() < 1e-9:
            break
    return b


def base_mu(r, st, P, which):
    f = r["f"]
    if which == "v1":
        return r["v1"].get(st)
    rd = P["rd_a"] + P["rd_b"] * f["rbase"] + P["rd_c"] * f["pw"] * (1 - f["pw"])
    mu = f["kpr"] * rd * f["nmaps"]
    return mu * f["hspk"] if st == "hs" else mu


def design(rows, st, P, which, facs):
    off, X, y, keep = [], [], [], []
    for r in rows:
        a = r["act"][st] if "act" in r and isinstance(r["act"], dict) else r["act"]
        b = base_mu(r, st, P, which)
        if a is None or b is None or b <= 0:
            continue
        off.append(math.log(b))
        X.append([r["f"]["x_" + k] for k in facs])
        y.append(a)
        keep.append(r)
    return np.array(off), np.array(X).reshape(len(off), len(facs)), np.array(y, float), keep


def predict(off, X, b):
    return np.exp(off + b[0] + (X @ b[1:] if X.shape[1] else 0))


def mae(p, y):
    return float(np.mean(np.abs(p - y)))


def nll(p, y):
    from math import lgamma
    return float(np.mean(p - y * np.log(p)))   # Poisson deviance-equivalent (lower is better)


def split(E, per, lo, hi):
    return [r for r in E if r["period"] == per and lo <= r["date"] < hi]


def main_report():
    D = pickle.load(open(CACHE, "rb"))
    E, L = D["events"], D["lines"]
    # actual rounds per event (for the rounds fit) from the stored actual: need rd; recompute from players not stored -> use f
    rp, nrd = fit_rounds(E)
    print("rounds fit", rp, nrd)
    P = dict(SM.DEF, **rp)
    out = {"rounds": rp}
    res = {}
    for per in ("Maps 1-2", "Map 1"):
        tr, va, ho = split(E, per, TRAIN0, VAL0), split(E, per, VAL0, HOLD0), split(E, per, HOLD0, "9999")
        for st in ("kills", "hs"):
            R = {}
            # current v1 (no fit)
            for nm, rows in (("val", va), ("hold", ho)):
                o, X, y, _ = design(rows, st, P, "v1", [])
                R[("v1 (current)", nm)] = (mae(np.exp(o), y), float(np.mean(np.exp(o) - y)), len(y))
            for which in ("rounds", "v1"):
                chosen = []
                for stage in ([],) + tuple([k] for k in SM.FACTORS):
                    facs = chosen + stage
                    o, X, y, _ = design(tr, st, P, which, facs)
                    b = poisson_fit(o, X, y)
                    res_line = {}
                    for nm, rows in (("val", va), ("hold", ho)):
                        o2, X2, y2, _ = design(rows, st, P, which, facs)
                        p2 = predict(o2, X2, b)
                        res_line[nm] = (mae(p2, y2), float(np.mean(p2 - y2)), len(y2), nll(p2, y2))
                    label = "%s base + %s" % (which, "+".join(facs) or "(intercept only)")
                    R[(label, "val")] = res_line["val"][:3]
                    R[(label, "hold")] = res_line["hold"][:3]
                    R[(label, "coef")] = [round(float(x), 4) for x in b]
                    R[(label, "nll")] = (res_line["val"][3], res_line["hold"][3])
                    if stage:
                        prev = "%s base + %s" % (which, "+".join(chosen) or "(intercept only)")
                        if R[(label, "val")][0] < R[(prev, "val")][0] - KEEP_MIN and R[(label, "hold")][0] <= R[(prev, "hold")][0]:
                            chosen = facs
                R[(which, "chosen")] = chosen
            res[(per, st)] = R
    pickle.dump(res, open("/tmp/scout_res.pkl", "wb"))
    for k, R in res.items():
        print("\n==", k)
        for kk, v in R.items():
            print("  ", kk, v)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"
    build() if cmd == "build" else main_report() if cmd == "report" else None


# ------------------------------------------------------------------ final model + real lines
# Kept factors: a factor stays only if it cuts VALIDATION MAE by >= KEEP_MIN and does not hurt HOLDOUT (see factor_table).
# Nov 2026 run: only OPPONENT passed (every scope / stat). LAN, MAPS (veto-weighted per-map KPR), map rounds and Elo did not.
KEEP_MIN = 0.005
FINAL = {("Maps 1-2", "kills"): ["opp"], ("Maps 1-2", "hs"): ["opp"],
         ("Map 1", "kills"): ["opp"], ("Map 1", "hs"): ["opp"]}


def fit_final(E, P, facs_by=None, lo=TRAIN0, hi=HOLD0):
    facs_by = facs_by or FINAL
    coefs = {}
    for (per, st), facs in facs_by.items():
        o, X, y, _ = design(split(E, per, lo, hi), st, P, "rounds", facs)
        coefs[(per, st)] = (facs, poisson_fit(o, X, y))
    return coefs


def cand_mu(r, st, P, coefs):
    facs, b = coefs[(r["period"], st)]
    base = base_mu(r, st, P, "rounds")
    x = np.array([r["f"]["x_" + k] for k in facs])
    return float(base * math.exp(b[0] + (x @ b[1:] if len(facs) else 0)))


def cluster_ci(rows, B=2000, seed=7):
    g = {}
    for k, h in rows:
        g.setdefault(k, []).append(h)
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
    return out[int(.025 * B)], out[int(.975 * B)]


def eval_lines(L, P, coefs, gr):
    rows = []
    for r in L:
        st, line, act = r["st"], r["line"], r["act"]
        mu_c = cand_mu(r, st, P, coefs)
        out = {"st": st, "line": line, "act": act, "mid": str(r["mid"]) + r["date"], "book": r["book"]}
        for nm, mu in (("cand", mu_c), ("v1", r["v1"])):
            if mu is None:
                out[nm] = None
                continue
            g = gr._v1_result(mu, line, st, r["book"], r["odds"])
            out[nm] = (mu, g["grade"], g["pick"])
        out["lock"] = (r["lock_proj"], r["lock_grade"], r["lock_pick"]) if r["lock_proj"] is not None else None
        rows.append(out)
    return rows


def summarize_lines(rows, st):
    R = [r for r in rows if r["st"] == st and r["cand"] and r["v1"] and r["lock"]]
    res = {"n": len(R), "line_mae": float(np.mean([abs(r["line"] - r["act"]) for r in R])),
           "line_bias": float(np.mean([r["line"] - r["act"] for r in R]))}
    for nm in ("lock", "v1", "cand"):
        mus = np.array([r[nm][0] for r in R])
        acts = np.array([r["act"] for r in R])
        res[nm] = {"mae": float(np.mean(np.abs(mus - acts))), "bias": float(np.mean(mus - acts))}
        hits = []
        byg = {}
        for r in R:
            mu, g, pick = r[nm]
            if r["act"] == r["line"]:
                continue
            h = (r["act"] > r["line"]) if pick == "OVER" else (r["act"] < r["line"])
            hits.append((r["mid"], 1.0 if h else 0.0))
            byg.setdefault(g, []).append((r["mid"], 1.0 if h else 0.0))
        res[nm]["hit"] = (sum(h for _, h in hits), len(hits), cluster_ci(hits))
        res[nm]["grades"] = {g: (sum(h for _, h in v), len(v), cluster_ci(v)) for g, v in sorted(byg.items())}
        res[nm]["overs"] = sum(1 for r in R if r[nm][2] == "OVER")
    return res


def main_final():
    D = pickle.load(open(CACHE, "rb"))
    E, L = D["events"], D["lines"]
    rp, _ = fit_rounds(E)
    P = dict(SM.DEF, **rp)
    coefs = fit_final(E, P)
    gr, _ = build_grader()
    for k, (f, b) in coefs.items():
        print(k, f, [round(float(x), 4) for x in b])
    # holdout events
    for (per, st) in coefs:
        ho = split(E, per, HOLD0, "9999")
        a = [(cand_mu(r, st, P, coefs), r["v1"].get(st), r["act"][st]) for r in ho if r["act"].get(st) is not None and r["v1"].get(st)]
        c, v, y = map(np.array, zip(*a))
        print("HOLDOUT %s %s n=%d  v1 MAE %.3f bias %+.3f | cand MAE %.3f bias %+.3f" % (per, st, len(y), mae(v, y), np.mean(v - y), mae(c, y), np.mean(c - y)))
    rows = eval_lines(L, P, coefs, gr)
    out = {st: summarize_lines(rows, st) for st in ("kills", "hs")}
    json.dump({"coefs": {"%s|%s" % k: [f, [float(x) for x in b]] for k, (f, b) in coefs.items()}, "rounds": rp, "lines": out},
              open("/workspace/scout-factors/final_results.json", "w"), indent=1, default=str)
    for st, r in out.items():
        print("\nREAL LINES", st, "n", r["n"], "line MAE %.3f bias %+.3f" % (r["line_mae"], r["line_bias"]))
        for nm in ("lock", "v1", "cand"):
            x = r[nm]
            h = x["hit"]
            print("  %-5s MAE %.3f bias %+.3f  hit %d/%d = %.1f%% CI %.1f-%.1f  overs %d" % (nm, x["mae"], x["bias"], h[0], h[1], 100 * h[0] / h[1], 100 * h[2][0], 100 * h[2][1], x["overs"]))
            for g, (k, n, ci) in x["grades"].items():
                print("      %-3s %d/%d = %.1f%%  CI %.1f-%.1f" % (g, k, n, 100 * k / n, 100 * ci[0], 100 * ci[1]))


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "final":
    main_final()


def factor_table():
    """Holdout effect of each factor: FORM base alone, then each factor added on its own to the base, then on top of
    base + opponent. Fit on TRAIN, MAE on VAL and HOLDOUT. Written to /workspace/scout-factors/factor_table.json."""
    D = pickle.load(open(CACHE, "rb"))
    E = D["events"]
    rp, _ = fit_rounds(E)
    P = dict(SM.DEF, **rp)
    out = {}
    for per in ("Maps 1-2", "Map 1"):
        tr, va, ho = split(E, per, TRAIN0, VAL0), split(E, per, VAL0, HOLD0), split(E, per, HOLD0, "9999")
        for st in ("kills", "hs"):
            rows = []
            def run(which, facs, name):
                if which == "v1cur":
                    r = []
                    for rr in (va, ho):
                        o, X, y, _ = design(rr, st, P, "v1", [])
                        r.append((mae(np.exp(o), y), float(np.mean(np.exp(o) - y)), len(y)))
                else:
                    o, X, y, _ = design(tr, st, P, which, facs)
                    b = poisson_fit(o, X, y)
                    r = []
                    for rr in (va, ho):
                        o2, X2, y2, _ = design(rr, st, P, which, facs)
                        p2 = predict(o2, X2, b)
                        r.append((mae(p2, y2), float(np.mean(p2 - y2)), len(y2)))
                rows.append({"model": name, "val_mae": round(r[0][0], 4), "hold_mae": round(r[1][0], 4), "hold_bias": round(r[1][1], 3), "n_hold": r[1][2]})
            run("v1cur", [], "current v1be")
            run("rounds", [], "FORM: KPR x expected rounds x maps")
            for f in SM.FACTORS:
                run("rounds", [f], "FORM + " + f)
            for f in SM.FACTORS:
                if f != "opp":
                    run("rounds", ["opp", f], "FORM + opp + " + f)
            out["%s|%s" % (per, st)] = rows
            print("\n==", per, st)
            for r in rows:
                print("  %-42s val %.3f  hold %.3f  bias %+.3f  n=%d" % (r["model"], r["val_mae"], r["hold_mae"], r["hold_bias"], r["n_hold"]))
    json.dump(out, open("/workspace/scout-factors/factor_table.json", "w"), indent=1)


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "factors":
    factor_table()


def write_params(path="scout_params.json"):
    """Fit the kept factors on TRAIN + VAL (match days before HOLD0) and save them for shadow.py (shadow_s)."""
    D = pickle.load(open(CACHE, "rb"))
    E = D["events"]
    rp, n_rd = fit_rounds(E)
    P = dict(SM.DEF, **rp)
    coefs = fit_final(E, P)
    hp = {k: v for k, v in SM.DEF.items() if not k.startswith("b") and not k.startswith("rd_")}
    out = {"model": SM.MODEL, "fit_window": [TRAIN0, HOLD0], "rounds": {k: round(v, 4) for k, v in rp.items()},
           "hyper": hp, "coefs": {}, "note": "Fitted by scout_backtest.py (fit). Kept factors only; 0 = factor off."}
    for (per, st), (facs, b) in coefs.items():
        c = {"b0": round(float(b[0]), 4)}
        for f, v in zip(facs, b[1:]):
            c["b_" + f] = round(float(v), 4)
        out["coefs"]["%s|%s" % (per, st)] = c
    json.dump(out, open(path, "w"), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "fit":
    write_params()
