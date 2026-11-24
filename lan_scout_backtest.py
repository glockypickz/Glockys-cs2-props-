"""Shadow S with vs without LAN data (scout_model lan_data) on LAN matches. Read-only.
  Events: Maps 1-2 series and Map 1 maps from 2026-09-20 (VAL to 10-19, HOLDOUT 10-20+) whose own event type is LAN.
  Real lines: lines_history.json locked single props with a result; LAN by scout_model.infer_ev (3-day rule)."""
import json, sys, bisect, random, collections
import numpy as np
from grader import load_players, merge_cito, load_strength, Grader, is_map1
import scout_model as SM

VAL0, HOLD0 = "2026-09-20", "2026-10-20"


def main():
    d = load_players("players.json")
    pl, _ = merge_cito(d.get("players", []))
    gr = Grader(pl, d.get("ranks") or {}, strength=load_strength())
    SG = SM.ScoutGrader(gr, pl)
    S = SG.S

    def mu(p, st, team, opp, D, per, ev, on, bo=3):
        P = SG.P(per, st); P["lan_data"] = on
        f = SM.features(S, p, team, opp, D, per, ev, P, bo)
        return SM.project(f, st, P)[0] if f else None
    E = []
    for p in pl:
        for per in ("Maps 1-2", "Map 1"):
            cs = gr.series(p, per)
            asc = sorted(c["date"] for c in cs)
            for c in cs:
                D = c["date"]
                if D < VAL0 or S.ev_of(p, mid=c["mid"]) != "lan" or bisect.bisect_left(asc, D) < 8:
                    continue
                for st in ("kills", "hs"):
                    if c.get(st) is None:
                        continue
                    a = mu(p, st, p.get("team"), c["opp"], D, per, "lan", 0, S.bo_of(c["mid"]))
                    b = mu(p, st, p.get("team"), c["opp"], D, per, "lan", 1, S.bo_of(c["mid"]))
                    if a and b:
                        E.append(("holdout" if D >= HOLD0 else "val", per, st, str(c["mid"]), a, b, c[st]))
    out = {"events": {}}
    for key in sorted(set(x[:3] for x in E)):
        R = [x for x in E if x[:3] == key]
        a = np.array([x[4] for x in R]); b = np.array([x[5] for x in R]); y = np.array([x[6] for x in R])
        dd = collections.defaultdict(list)
        for x, v in zip(R, np.abs(b - y) - np.abs(a - y)):
            dd[x[3]].append(v)
        ks = list(dd); rnd = random.Random(3); bs = []
        for _ in range(1000):
            s = n = 0
            for _ in ks:
                v = dd[ks[rnd.randrange(len(ks))]]; s += sum(v); n += len(v)
            bs.append(s / n)
        bs.sort()
        out["events"]["|".join(key)] = {"n": len(R), "S_mae": float(np.mean(np.abs(a - y))), "S_bias": float(np.mean(a - y)),
                                         "S_lan_mae": float(np.mean(np.abs(b - y))), "S_lan_bias": float(np.mean(b - y)), "d_ci": (bs[25], bs[975])}
    H = json.load(open("lines_history.json"))["entries"]
    L = []
    for e in H:
        lk, rs = e.get("lock"), e.get("result")
        if not lk or not rs or rs.get("outcome") not in ("hit", "miss", "push") or "+" in e["player"] or rs.get("act") is None:
            continue
        p = gr.find(e["player"], e.get("team"))
        if not p:
            continue
        st = "hs" if "head" in e["stat"].lower() else "kills"
        D = str(e["start"])[:10]; per = "Map 1" if is_map1(e) else "Maps 1-2"
        ev = SM.infer_ev(S, e.get("team"), e.get("opponent") or "", D)
        if ev != "lan":
            continue
        a = mu(p, st, e.get("team"), e.get("opponent") or "", D, per, ev, 0); b = mu(p, st, e.get("team"), e.get("opponent") or "", D, per, ev, 1)
        if not a or not b:
            continue
        line = float(lk["line"]); act = float(rs["act"])
        row = {"st": st, "line": line, "act": act}
        for nm, m in (("S", a), ("S_lan", b)):
            g = gr._v1_result(m, line, st, e.get("book"), e.get("odds"))
            row[nm] = (m, g["grade"], g["pick"])
        L.append(row)
    out["lines"] = {}
    for st in ("kills", "hs"):
        R = [r for r in L if r["st"] == st]
        res = {"n": len(R)}
        for nm in ("S", "S_lan"):
            hits = [((r["act"] > r["line"]) if r[nm][2] == "OVER" else (r["act"] < r["line"])) for r in R if r["act"] != r["line"]]
            res[nm] = {"mae": float(np.mean([abs(r[nm][0] - r["act"]) for r in R])), "bias": float(np.mean([r[nm][0] - r["act"] for r in R])),
                       "hit": [int(sum(hits)), len(hits)]}
        out["lines"][st] = res
    path = sys.argv[1] if len(sys.argv) > 1 else "/workspace/scout-factors/lan/lan_scout_results.json"
    json.dump(out, open(path, "w"), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
