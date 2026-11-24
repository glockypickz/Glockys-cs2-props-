"""Fit the v1t residual distribution and report calibration. Read-only: does not write locks or data files.

  python calib_fit.py          fit on series before FIT_CUTOFF, report on holdout series + locked lines Nov 13-22
  python calib_fit.py --write  also write calib.json (constants in grader.py / model.js are updated separately)

Walk-forward v1 projections only use series dated strictly before each predicted match. The distribution
(Normal vs Laplace, bias, scale) is chosen on the early slice; holdout and locked-line numbers are not used
to pick the fit. Locked grades in lines_history.json are never changed.
"""
import json, math, argparse, statistics as S
from collections import defaultdict
from grader import (Grader, load_players, residual_probs, letter_from_edge, break_even,
                    FIT_CUTOFF, MODEL_VERSION, period_of, is_map1, CALIB, letter as _unused)
from settle import find_result

LOCK_LO, LOCK_HI = "2026-11-13", "2026-11-22"
MIN_PRIOR = 5
BUCKETS = [(0.50, 0.55), (0.55, 0.60), (0.60, 0.65), (0.65, 0.70), (0.70, 0.75), (0.75, 0.85), (0.85, 1.01)]


def ev_of(c):
    ev = c.get("ev")
    return ev if ev in ("lan", "online") else None


def residuals(G, period, min_prior=MIN_PRIOR):
    rows = []
    for p in G.players:
        cs = G.series(p, period)
        for i, c in enumerate(cs):
            if c.get("kills") is None:
                continue
            prior = [x for x in cs[i + 1:] if x["date"] < c["date"]]
            if len(prior) < min_prior:
                continue
            ev = ev_of(c)
            for st in ("kills", "hs"):
                if c.get(st) is None:
                    continue
                proj = G.v1_project(p, st, c.get("opp"), c["date"], period=period, ev=ev)
                if proj is None:
                    continue
                rows.append({"st": st, "period": period_of(period), "date": c["date"],
                             "proj": proj, "act": c[st], "res": c[st] - proj, "opp": c.get("opp"),
                             "team": p.get("team"), "ev": ev, "n": len(prior), "p": p, "mid": c.get("mid")})
    return rows


def fit_one(res):
    if len(res) < 20:
        return None
    # Normal: mean + sample stdev; Laplace: median + mean absolute deviation
    mu = S.mean(res)
    sd = S.stdev(res) if len(res) > 1 else 1.0
    med = S.median(res)
    b = S.mean(abs(x - med) for x in res) or 1e-6
    return {"norm": {"dist": "norm", "bias": round(mu, 3), "scale": round(sd, 3), "n": len(res)},
            "laplace": {"dist": "laplace", "bias": round(med, 3), "scale": round(b, 3), "n": len(res)}}


def brier(rows, key="p", hit="hit"):
    if not rows:
        return None
    return sum((r[key] - (1.0 if r[hit] else 0.0)) ** 2 for r in rows) / len(rows)


def ece(rows, key="p", hit="hit", bins=10):
    """Expected calibration error, equal-width bins on predicted probability."""
    if not rows:
        return None
    buckets = [[] for _ in range(bins)]
    for r in rows:
        i = min(bins - 1, max(0, int(r[key] * bins)))
        buckets[i].append(r)
    tot = 0.0
    n = 0
    for b in buckets:
        if not b:
            continue
        p = sum(x[key] for x in b) / len(b)
        h = sum(1 for x in b if x[hit]) / len(b)
        tot += abs(p - h) * len(b)
        n += len(b)
    return tot / n if n else None


def reliability(rows, key="p", hit="hit"):
    out = []
    for lo, hi in BUCKETS:
        b = [r for r in rows if lo <= r[key] < hi]
        if not b:
            out.append((lo, hi, 0, None, None))
            continue
        pred = sum(r[key] for r in b) / len(b)
        act = sum(1 for r in b if r[hit]) / len(b)
        out.append((lo, hi, len(b), pred, act))
    return out


def fmt_rel(rows, title):
    lines = [title, "  bucket             n   pred    actual   gap"]
    for lo, hi, n, pred, act in reliability(rows):
        if n == 0:
            lines.append("  %4.0f-%4.0f%%         0      –       –      –" % (lo * 100, min(hi, 1) * 100))
        else:
            lines.append("  %4.0f-%4.0f%%     %5d  %5.1f%%  %5.1f%%  %+5.1f" % (
                lo * 100, min(hi, 1) * 100, n, pred * 100, act * 100, (act - pred) * 100))
    br, ec = brier(rows), ece(rows)
    lines.append("  n=%d  Brier=%s  ECE=%s" % (
        len(rows),
        "–" if br is None else "%.4f" % br,
        "–" if ec is None else "%.4f" % ec))
    return "\n".join(lines)


def choose(early_rows, st, period):
    """Pick Normal vs Laplace on the early slice only, using Brier of P(over) vs a synthetic L10-like line.

    For each early residual we pretend the line is proj (so P(over) should be ~0.5 if unbiased) AND
    also score a line at proj-2 and proj+2 so the curvature is tested. Uses the actual integer outcome.
    """
    sub = [r for r in early_rows if r["st"] == st and r["period"] == period]
    fits = fit_one([r["res"] for r in sub])
    if not fits:
        return None
    best, best_s = None, None
    for name, c in fits.items():
        ss = 0.0
        n = 0
        for r in sub:
            for dline in (0.0, -2.0, 2.0):
                line = math.floor(r["proj"] + dline) + 0.5
                po, ppush, pu = residual_probs(r["proj"], line, st, period, 1, c)
                if r["act"] == line:
                    continue
                hit = r["act"] > line
                ss += (po - (1.0 if hit else 0.0)) ** 2
                n += 1
        s = ss / n if n else 9
        if best is None or s < best_s:
            best, best_s = c, s
    best = dict(best)
    best["brier_early"] = round(best_s, 5)
    return best


def attach_probs(rows, calib_map, book="PrizePicks", odds=-137, line_mode="l10"):
    """Build side-probability rows. line_mode 'l10' uses a synthetic .5 line at the projection
    rounded toward a typical book (proj itself rounded to .5) — clearly NOT a real book line."""
    out = []
    for r in rows:
        c = calib_map.get((r["st"], r["period"]))
        if not c:
            continue
        if line_mode == "l10":
            line = math.floor(r["proj"] * 2) / 2.0 + (0.0 if (r["proj"] * 2) % 1 == 0 else 0.0)
            # nearest .5
            line = round(r["proj"] * 2) / 2.0
            if abs(line - int(line)) < 1e-9:
                line += 0.5 if r["proj"] >= line else -0.5
        else:
            line = r["line"]
        po, ppush, pu = residual_probs(r["proj"], line, r["st"], r["period"], 1, c)
        if abs(r["act"] - line) < 1e-9:
            continue
        pick = "OVER" if po >= pu else "UNDER"
        p = po if pick == "OVER" else pu
        hit = (r["act"] > line) if pick == "OVER" else (r["act"] < line)
        be = break_even(r.get("book") or book, r.get("odds") if r.get("odds") is not None else odds)
        epp = (p - be) * 100
        letter, stake = letter_from_edge(epp)
        out.append(dict(r, line=line, p=p, p_over=po, pick=pick, hit=hit, be=be, epp=epp,
                        letter=letter, stake=stake))
    return out


def locked_evals(G, calib_map):
    try:
        hist = json.load(open("lines_history.json", encoding="utf-8"))["entries"]
    except Exception:
        return []
    rows = []
    for e in hist:
        if "+" in (e.get("player") or ""):
            continue
        start = str(e.get("start") or "")
        day = start[:10]
        if not (LOCK_LO <= day <= LOCK_HI):
            continue
        rs = e.get("result") or {}
        act = rs.get("act")
        if act is None or rs.get("outcome") in ("void", "push"):
            continue
        st = "hs" if "head" in str(e.get("stat") or "").lower() else "kills" if "kill" in str(e.get("stat") or "").lower() else None
        if not st:
            continue
        p = G.find(e["player"], e.get("team"))
        if not p:
            continue
        period = period_of(e)
        ev, _ = G.match_ev(e.get("team"), e.get("opponent") or "", e.get("start"))
        proj = G.v1_project(p, st, e.get("opponent") or "", day, period=period, ev=ev)
        if proj is None:
            continue
        line = float(e.get("line") if e.get("lock") is None else (e["lock"].get("line") or e.get("line")))
        if act == line:
            continue
        rows.append({"st": st, "period": period, "date": day, "proj": proj, "act": act,
                     "line": line, "book": e.get("book") or "", "odds": e.get("odds"),
                     "player": e.get("player"), "start": start,
                     "lock_grade": (e.get("lock") or {}).get("grade"),
                     "lock_pick": (e.get("lock") or {}).get("pick")})
    return attach_probs(rows, calib_map, line_mode="real")


def letter_table(rows):
    order = ["A+", "A", "B+", "B", "C+", "C", "D", "F"]
    lines = ["  letter   n    hit     edge"]
    by = defaultdict(list)
    for r in rows:
        by[r["letter"]].append(r)
    for g in order:
        b = by.get(g) or []
        if not b:
            continue
        h = sum(1 for x in b if x["hit"])
        e = S.mean(x["epp"] for x in b)
        lines.append("  %-5s  %4d  %5.1f%%  %+6.1f" % (g, len(b), 100 * h / len(b), e))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()
    data = load_players("players.json")
    G = Grader(data["players"], data.get("ranks") or {})
    print("Building walk-forward residuals (v1 projection, LAN ev from the series when logged)...")
    all_rows = residuals(G, "Maps 1-2") + residuals(G, "Map 1")
    early = [r for r in all_rows if r["date"] < FIT_CUTOFF]
    hold = [r for r in all_rows if r["date"] >= FIT_CUTOFF]
    print("  residuals: %d early (<%s), %d holdout, %d total" % (len(early), FIT_CUTOFF, len(hold), len(all_rows)))

    calib_map = {}
    print("\n== Fit on early slice (<%s), Normal vs Laplace by Brier ==" % FIT_CUTOFF)
    for st in ("kills", "hs"):
        for per in ("Maps 1-2", "Map 1"):
            sub = [r["res"] for r in early if r["st"] == st and r["period"] == per]
            fits = fit_one(sub)
            chosen = choose(early, st, per)
            calib_map[(st, per)] = chosen
            mae = S.mean(abs(x) for x in sub) if sub else None
            print("  %s %s  n=%d  MAE=%s  mean=%s  std=%s  med=%s  laplace_b=%s  -> %s" % (
                st, per, len(sub),
                "–" if mae is None else "%.3f" % mae,
                "–" if not fits else "%.3f" % fits["norm"]["bias"],
                "–" if not fits else "%.3f" % fits["norm"]["scale"],
                "–" if not fits else "%.3f" % fits["laplace"]["bias"],
                "–" if not fits else "%.3f" % fits["laplace"]["scale"],
                chosen))

    # Holdout: synthetic .5 line at rounded projection
    hold_p = attach_probs(hold, calib_map)
    print("\n== Holdout series (>= %s), synthetic .5 line near the projection ==" % FIT_CUTOFF)
    print(fmt_rel(hold_p, "All holdout"))
    for st in ("kills", "hs"):
        for per in ("Maps 1-2", "Map 1"):
            sub = [r for r in hold_p if r["st"] == st and r["period"] == per]
            if sub:
                print(fmt_rel(sub, "%s %s" % (st, per)))
    print("\nHit rate by new letter (holdout, synthetic lines, PrizePicks default BE):")
    print(letter_table(hold_p))

    print("\n== Real locked lines %s to %s (walk-forward v1t, stored letters untouched) ==" % (LOCK_LO, LOCK_HI))
    locks = locked_evals(G, calib_map)
    print("  settled non-push locks: %d" % len(locks))
    if locks:
        print(fmt_rel(locks, "All locked lines"))
        for st in ("kills", "hs"):
            for per in ("Maps 1-2", "Map 1"):
                sub = [r for r in locks if r["st"] == st and r["period"] == per]
                if sub:
                    print(fmt_rel(sub, "%s %s" % (st, per)))
        print("\nHit rate by new letter (real locked lines; new letter is not written back):")
        print(letter_table(locks))
        # vs old stored letter, just for context
        by_old = defaultdict(list)
        for r in locks:
            if r.get("lock_grade"):
                hit_old = (r["act"] > r["line"]) if r.get("lock_pick") == "OVER" else (r["act"] < r["line"]) if r.get("lock_pick") == "UNDER" else None
                if hit_old is not None:
                    by_old[r["lock_grade"]].append(hit_old)
        if by_old:
            print("\nStored (old) letter record on the same locks (unchanged):")
            for g in ("A+", "A", "B", "C", "D", "F"):
                b = by_old.get(g) or []
                if b:
                    print("  %s  %d  %.1f%%" % (g, len(b), 100 * sum(b) / len(b)))

    out = {"fit_cutoff": FIT_CUTOFF, "model": MODEL_VERSION, "lock_window": [LOCK_LO, LOCK_HI],
           "calib": {st: {per: calib_map.get((st, per)) for per in ("Maps 1-2", "Map 1")} for st in ("kills", "hs")}}
    if args.write:
        with open("calib.json", "w") as f:
            json.dump(out, f, indent=2)
        print("\nwrote calib.json")
    else:
        print("\ncalib map (not written; pass --write to save calib.json):")
        print(json.dumps(out["calib"], indent=2))
    return out


if __name__ == "__main__":
    main()
