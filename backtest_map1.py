"""Walk-forward backtest of Map 1 projections vs actual Map 1 results in players.json.

There are no historical Map 1 book lines in lines_history.json (that file is Maps 1-2 only),
so hit rate uses a proxy line: the player's pre-match Map 1 season average, rounded to x.5.
That is labeled clearly and is not a book line.
No files are written. Locked grades are not touched.
"""
import math
from collections import defaultdict
from grader import Grader, load_players, load_strength, merge_cito, round1


def half(x):
    """Nearest x.5 (e.g. 16.2 -> 16.5, 16.8 -> 16.5, 17.0 -> 16.5)."""
    if x is None:
        return None
    return math.floor(x) + 0.5


def main():
    d = load_players("players.json")
    pl, _ = merge_cito(d.get("players", []))
    gr = Grader(pl, d.get("ranks") or {}, strength=load_strength())
    stats = ("kills", "hs")
    rows = {st: [] for st in stats}
    n_skip = 0
    for p in pl:
        cs = [c for c in gr.series(p, "Map 1") if c.get("date")]
        for c in cs:
            before = c["date"]
            for st in stats:
                if c.get(st) is None:
                    continue
                det = gr.v1_project_parts(p, st, c.get("opp"), before=before, period="Map 1")
                if not det or det.get("proj") is None:
                    n_skip += 1
                    continue
                proj = det["proj"]
                act = c[st]
                prior = [x for x in cs if x["date"] < before and x.get(st) is not None and x["date"][:4] == before[:4]]
                if not prior:
                    prior = [x for x in cs if x["date"] < before and x.get(st) is not None]
                proxy = half(sum(x[st] for x in prior) / len(prior)) if prior else None
                hit = None
                pick = None
                if proxy is not None and act != proxy:
                    pick = "OVER" if proj >= proxy else "UNDER"
                    hit = (act > proxy) if pick == "OVER" else (act < proxy)
                rows[st].append((proj, act, proj - act, proxy, hit, pick))

    print("Map 1 walk-forward backtest (projection vs actual Map 1, no leakage)")
    print("players:", len(pl), "| skipped (no prior Map 1 data):", n_skip)
    summary = {}
    for st in stats:
        r = rows[st]
        n = len(r)
        if not n:
            print(st, "no rows")
            continue
        mae = sum(abs(x[2]) for x in r) / n
        bias = sum(x[2] for x in r) / n  # proj - actual: + means we over-project
        hits = [x for x in r if x[4] is not None]
        hr = (sum(1 for x in hits if x[4]) / len(hits)) if hits else None
        print("%s: n=%d  MAE=%.3f  bias(proj-act)=%+.3f  proxy-line hit rate=%.1f%% (n=%d)"
              % (st, n, mae, bias, (100 * hr if hr is not None else float("nan")), len(hits)))
        summary[st] = {"n": n, "mae": mae, "bias": bias, "hit_rate": hr, "hit_n": len(hits)}
    print("Proxy line = pre-match Map 1 season average rounded to x.5 (not a book line).")
    print("Hit rate is for the model's OVER/UNDER vs that proxy. Pushes (actual == proxy) are left out.")
    return summary


if __name__ == "__main__":
    main()
