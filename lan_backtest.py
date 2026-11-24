"""LAN-data backtest (read-only): v1be vs v1be + LAN data (grader.py lan_data) on LAN matches.

  python lan_backtest.py [out.json]

Events: every Maps 1-2 series and Map 1 map from 2026-09-20 on (VAL 09-20..10-19, HOLDOUT 10-20+), player has >= 8 prior.
  ev "actual" = the series' own bo3.gg event type; ev "inferred" = Grader.match_ev (3-day rule, no games.json for the past).
Real lines: lines_history.json locked props with a result (single players). LAN mode uses the inferred ev (what a lock would
  have seen; games.json had no ev field then). Letters from the v1 result rule. Nothing is written to any data file.
"""
import json, sys, bisect, collections, random
import numpy as np
from grader import Grader, load_players, merge_cito, load_strength, is_map1, tn

VAL0, HOLD0 = "2026-09-20", "2026-10-20"


def build():
    d = load_players("players.json")
    pl, _ = merge_cito(d.get("players", []))
    import os
    ov = {k: float(os.environ[k.upper()]) for k in ("lan_k", "lan_adr_min") if os.environ.get(k.upper())}   # sensitivity runs
    gr = Grader(pl, d.get("ranks") or {}, params=ov or None, strength=load_strength())
    memo = {}
    orig = gr.rank_of
    gr.rank_of = lambda name: memo[name] if name in memo else memo.setdefault(name, orig(name))
    return gr, pl


def cluster_ci(rows, B=2000, seed=7):
    by = collections.defaultdict(list)
    for k, h in rows:
        by[k].append(h)
    ks = list(by)
    if not ks:
        return (None, None)
    rnd = random.Random(seed)
    out = []
    for _ in range(B):
        s = n = 0
        for _ in ks:
            v = by[ks[rnd.randrange(len(ks))]]
            s += sum(v); n += len(v)
        out.append(s / n)
    out.sort()
    return (out[int(.025 * B)], out[int(.975 * B)])


def events(gr, pl):
    rows = []
    for p in pl:
        for per in ("Maps 1-2", "Map 1"):
            cs = gr.series(p, per)
            asc = sorted(c["date"] for c in cs)
            for c in cs:
                D = c["date"]
                if D < VAL0 or c.get("kills") is None or bisect.bisect_left(asc, D) < 8:
                    continue
                inf = gr.match_ev(p.get("team"), c["opp"], D, games=[])[0]
                r = {"date": D, "per": per, "ev": c.get("ev"), "inf": inf, "mid": str(c["mid"]), "act": {}, "v1": {}, "lan": {}}
                for st in ("kills", "hs"):
                    if c.get(st) is None:
                        continue
                    r["act"][st] = c[st]
                    r["v1"][st] = gr.v1_project(p, st, c["opp"], D, period=per)
                    if c.get("ev") == "lan" or inf == "lan":
                        r["lan"][st] = gr.v1_project(p, st, c["opp"], D, period=per, ev="lan")
                rows.append(r)
    return rows


def ev_summary(E, which):
    out = {}
    for split, lo, hi in (("val", VAL0, HOLD0), ("holdout", HOLD0, "9999")):
        for per in ("Maps 1-2", "Map 1"):
            for st in ("kills", "hs"):
                R = [r for r in E if lo <= r["date"] < hi and r["per"] == per and r[which] == "lan" and r["v1"].get(st) and r["lan"].get(st)]
                if not R:
                    continue
                y = np.array([r["act"][st] for r in R]); a = np.array([r["v1"][st] for r in R]); b = np.array([r["lan"][st] for r in R])
                # paired bootstrap on series for the MAE change
                d = collections.defaultdict(list)
                for r, x in zip(R, np.abs(b - y) - np.abs(a - y)):
                    d[r["mid"]].append(x)
                ks = list(d); rnd = random.Random(3); bs = []
                for _ in range(1000):
                    s = n = 0
                    for _ in ks:
                        v = d[ks[rnd.randrange(len(ks))]]; s += sum(v); n += len(v)
                    bs.append(s / n)
                bs.sort()
                out["%s|%s|%s" % (split, per, st)] = {"n": len(R), "v1_mae": float(np.mean(np.abs(a - y))), "v1_bias": float(np.mean(a - y)),
                                                      "lan_mae": float(np.mean(np.abs(b - y))), "lan_bias": float(np.mean(b - y)),
                                                      "d_mae_ci": (bs[25], bs[975])}
    return out


def real_lines(gr):
    H = json.load(open("lines_history.json"))["entries"]
    rows = []
    for e in H:
        lk, rs = e.get("lock"), e.get("result")
        if not lk or not rs or rs.get("outcome") not in ("hit", "miss", "push") or "+" in e["player"] or rs.get("act") is None:
            continue
        p = gr.find(e["player"], e.get("team"))
        if not p:
            continue
        st = "hs" if "head" in e["stat"].lower() else "kills"
        D = str(e["start"])[:10]
        per = "Map 1" if is_map1(e) else "Maps 1-2"
        opp = e.get("opponent") or ""
        inf = gr.match_ev(e.get("team") or p.get("team"), opp, e["start"], games=[])[0]
        act_ev = next((c.get("ev") for c in gr.series(p, per) if str(c["mid"]) == str(rs.get("mid"))), None)
        line = float(lk["line"])
        r = {"st": st, "line": line, "act": float(rs["act"]), "mid": str(rs.get("mid")) + D, "inf": inf, "ev": act_ev, "date": D}
        for nm, ev in (("v1", None), ("lan", "lan" if inf == "lan" else None)):
            mu = gr.v1_project(p, st, opp, D, period=per, ev=ev)
            if mu is None:
                r[nm] = None; continue
            g = gr._v1_result(mu, line, st, e.get("book"), e.get("odds"))
            r[nm] = (mu, g["grade"], g["pick"])
        rows.append(r)
    return rows


def line_summary(rows, st, only_lan=True):
    R = [r for r in rows if r["st"] == st and r["v1"] and r["lan"] and (r["inf"] == "lan" or not only_lan)]
    if not R:
        return None
    res = {"n": len(R), "line_mae": float(np.mean([abs(r["line"] - r["act"]) for r in R]))}
    for nm in ("v1", "lan"):
        mus = np.array([r[nm][0] for r in R]); acts = np.array([r["act"] for r in R])
        hits, byg = [], {}
        for r in R:
            mu, g, pick = r[nm]
            if r["act"] == r["line"]:
                continue
            h = 1.0 if ((r["act"] > r["line"]) if pick == "OVER" else (r["act"] < r["line"])) else 0.0
            hits.append((r["mid"], h)); byg.setdefault(g, []).append((r["mid"], h))
        res[nm] = {"mae": float(np.mean(np.abs(mus - acts))), "bias": float(np.mean(mus - acts)),
                   "hit": (sum(h for _, h in hits), len(hits), cluster_ci(hits)),
                   "grades": {g: (sum(h for _, h in v), len(v)) for g, v in sorted(byg.items())},
                   "overs": sum(1 for r in R if r[nm][2] == "OVER")}
    res["changed_letter"] = sum(1 for r in R if r["v1"][1] != r["lan"][1])
    res["changed_pick"] = sum(1 for r in R if r["v1"][2] != r["lan"][2])
    return res


def main():
    gr, pl = build()
    E = events(gr, pl)
    conf = collections.Counter((r["ev"], r["inf"]) for r in E if r["per"] == "Maps 1-2")
    L = real_lines(gr)
    lconf = collections.Counter((r["ev"], r["inf"]) for r in L)
    out = {"lan_params": {k: gr.P[k] for k in ("lan_data", "lan_k", "lan_adr_min")},
           "inference_vs_actual_events_maps12": {"%s->%s" % k: v for k, v in conf.items()},
           "inference_vs_actual_lines": {"%s->%s" % k: v for k, v in lconf.items()},
           "events_actual_ev": ev_summary(E, "ev"), "events_inferred_ev": ev_summary(E, "inf"),
           "lines_lan": {st: line_summary(L, st) for st in ("kills", "hs")},
           "lines_all": {st: line_summary(L, st, only_lan=False) for st in ("kills", "hs")}}
    path = sys.argv[1] if len(sys.argv) > 1 else "/workspace/scout-factors/lan/lan_results.json"
    json.dump(out, open(path, "w"), indent=1, default=str)
    print(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
