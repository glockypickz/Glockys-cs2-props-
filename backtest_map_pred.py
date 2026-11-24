"""Backtest Glocky's map prediction and the v1f per-map shrink with setting-split veto weights.

1) On past matches since 2026-11-13 with known maps, how often predicted Map 1
   matches actual, and how often the actual maps sit in the predicted set,
   vs the current full-pool 'most-picked map' baseline.
2) Walk-forward hit rate and MAE on settled, locked props since that date,
   comparing setting-split slot weights vs the current full-pool scout weights.

Uses only logs dated strictly before the match day. Writes no files. Does not
touch lines_history.json or regrade anything.
"""
import json
from collections import defaultdict, Counter
from grader import Grader, load_players, load_strength, merge_cito, is_map1, tn, teq
from map_pred import predict_match, MIN_SETTING_N
from scout_model import DEF

SINCE = "2026-11-13"


def load_grader():
    d = load_players("players.json")
    pl, _ = merge_cito(d.get("players", []))
    return Grader(pl, d.get("ranks") or {}, strength=load_strength()), pl


def actual_matches(players, since=SINCE):
    """mid+date -> {maps by n, ev, teams, date}."""
    # (mid, date) -> n -> map, ev, team, opp
    slots = {}
    for p in players:
        team = p.get("team")
        for l in p.get("logs") or []:
            day = str(l.get("date") or "")
            if day < since or l.get("mid") is None or not l.get("map") or not l.get("n"):
                continue
            key = (l["mid"], day)
            rec = slots.setdefault(key, {"date": day, "mid": l["mid"], "maps": {}, "evs": Counter(), "teams": set()})
            rec["maps"][int(l["n"])] = l["map"]
            if l.get("ev") in ("lan", "online"):
                rec["evs"][l["ev"]] += 1
            if team:
                rec["teams"].add(tn(team))
            if l.get("opp"):
                rec["teams"].add(tn(l["opp"]))
    out = []
    for rec in slots.values():
        order = [rec["maps"][n] for n in sorted(rec["maps"])]
        if not order:
            continue
        ev = rec["evs"].most_common(1)[0][0] if rec["evs"] else None
        mx = max(rec["maps"])
        bo = 1 if mx == 1 and len(order) == 1 else (5 if mx >= 4 else 3)
        teams = [t for t in rec["teams"] if t]
        if len(teams) < 2:
            continue
        # first two distinct team names
        t1, t2 = teams[0], teams[1]
        out.append({"date": rec["date"], "mid": rec["mid"], "maps": order, "ev": ev, "bo": bo, "t1": t1, "t2": t2})
    return out


def pred_set(pred):
    return [pred["pred"][s] for s in sorted(pred.get("pred") or {}) if pred["pred"].get(s)]


def baseline_set(weights, k):
    rows = sorted((weights or {}).items(), key=lambda x: (-x[1], x[0]))
    return [m for m, _ in rows[:k]]


def coverage(actual, predicted):
    if not actual:
        return None
    s = set(predicted)
    return sum(1 for m in actual if m in s) / len(actual)


def run_map_backtest(gr, players):
    S = gr._scout()
    matches = actual_matches(players)
    cache = {}
    rows = []
    for m in matches:
        key = (m["t1"], m["t2"], m["date"], m["bo"], m["ev"])
        if key not in cache:
            cache[key] = {
                "pred": predict_match(S, m["t1"], m["t2"], m["date"], bo=m["bo"], ev=m["ev"]),
                "full": S.veto(m["t1"], m["t2"], m["date"], DEF) or {},
            }
        pred = cache[key]["pred"]
        full = cache[key]["full"]
        k = 1 if m["bo"] == 1 else (5 if m["bo"] >= 5 else 3)
        pset = pred_set(pred)
        bset = baseline_set(full, k)
        act = m["maps"]
        p1 = pred["pred"].get(1)
        b1 = bset[0] if bset else None
        rows.append({
            "ev": m["ev"], "bo": m["bo"],
            "map1_hit": p1 == act[0] if p1 else False,
            "base_map1_hit": b1 == act[0] if b1 else False,
            "map1_in_set": act[0] in pset,
            "base_map1_in_set": act[0] in bset,
            "cov": coverage(act[:k], pset),
            "base_cov": coverage(act[:k], bset),
            "fallback": bool(pred.get("fallback")),
        })
    return rows, len(matches)


def pct(n, d):
    return 100.0 * n / d if d else 0.0


def summarize_maps(rows, label):
    n = len(rows)
    if not n:
        print("  %s: no rows" % label)
        return
    def rate(key):
        return pct(sum(1 for r in rows if r[key]), n)
    cov = sum(r["cov"] or 0 for r in rows) / n
    bcov = sum(r["base_cov"] or 0 for r in rows) / n
    print("  %s  n=%d  Map 1 hit  %.1f%%  vs baseline %.1f%%  |  actual Map 1 in predicted set %.1f%%  vs baseline %.1f%%  |  actual-maps coverage %.1f%%  vs baseline %.1f%%  |  fallback %d"
          % (label, n, rate("map1_hit"), rate("base_map1_hit"), rate("map1_in_set"), rate("base_map1_in_set"),
             100 * cov, 100 * bcov, sum(1 for r in rows if r["fallback"])))


def settled_props(since=SINCE):
    hist = json.load(open("lines_history.json", encoding="utf-8")).get("entries") or []
    out = []
    for e in hist:
        if str(e.get("start") or "")[:10] < since:
            continue
        if not e.get("lock"):
            continue
        res = e.get("result") or {}
        if res.get("void") or res.get("outcome") == "void":
            continue
        if res.get("act") is None:
            continue
        if "+" in str(e.get("player") or ""):
            continue
        out.append(e)
    return out


def match_ev_of(e, players):
    ev = (e.get("lock") or {}).get("ev") or e.get("ev")
    if ev in ("lan", "online"):
        return ev
    mid, day = (e.get("result") or {}).get("mid"), (e.get("result") or {}).get("date") or str(e.get("start") or "")[:10]
    evs = Counter()
    for p in players:
        if not teq(p.get("team"), e.get("team")):
            continue
        for l in p.get("logs") or []:
            if mid and str(l.get("mid")) != str(mid):
                continue
            if str(l.get("date") or "") != str(day):
                if mid:
                    pass
                else:
                    continue
            if l.get("ev") in ("lan", "online"):
                evs[l["ev"]] += 1
        if evs:
            break
    return evs.most_common(1)[0][0] if evs else None


def match_bo_of(e, players):
    mid = (e.get("result") or {}).get("mid")
    if mid is None:
        return 3 if not is_map1(e) else 3
    mx = 0
    for p in players:
        for l in p.get("logs") or []:
            if str(l.get("mid")) == str(mid) and isinstance(l.get("n"), int):
                if l["n"] > mx:
                    mx = l["n"]
        if mx:
            break
    if mx <= 1:
        return 1
    if mx >= 4:
        return 5
    return 3


def run_grade_backtest(gr, players):
    props = settled_props()
    rows = {"full_pool": [], "pred": []}
    skipped = 0
    ev_cache, bo_cache = {}, {}
    for e in props:
        stl = str(e.get("stat") or "").lower()
        st = "hs" if "head" in stl else "kills" if "kill" in stl else None
        if not st:
            skipped += 1
            continue
        p = gr.find(e["player"], e.get("team"))
        if not p:
            skipped += 1
            continue
        day = str(e.get("start") or "")[:10]
        key = (e.get("team"), e.get("opponent"), day, (e.get("result") or {}).get("mid"))
        if key not in ev_cache:
            ev_cache[key] = match_ev_of(e, players)
            bo_cache[key] = match_bo_of(e, players)
        ev, bo = ev_cache[key], bo_cache[key]
        line = float((e.get("lock") or {}).get("line", e["line"]))
        act = float(e["result"]["act"])
        period = e.get("period")
        for mode in ("full_pool", "pred"):
            d = gr.v1_project_parts(p, st, e.get("opponent") or "", day, period=period, ev=ev, bo=bo, veto_mode=mode)
            if not d or d.get("proj") is None:
                if mode == "full_pool":
                    skipped += 1
                break
            proj = d["proj"]
            if act == line:
                hit = None
            else:
                pick = "OVER" if proj >= line else "UNDER"
                hit = (act > line) if pick == "OVER" else (act < line)
            rows[mode].append((proj, act, abs(proj - act), hit, ev, st, "Map 1" if is_map1(period) else "Maps 1-2"))
        else:
            continue
    return rows, skipped, len(props)


def summarize_grades(rows, label):
    r = rows
    n = len(r)
    if not n:
        print("  %s: no rows" % label)
        return None
    mae = sum(x[2] for x in r) / n
    hits = [x for x in r if x[3] is not None]
    hr = (sum(1 for x in hits if x[3]) / len(hits)) if hits else None
    print("  %s  n=%d  MAE=%.3f  hit rate=%.1f%% (n=%d)"
          % (label, n, mae, 100 * hr if hr is not None else float("nan"), len(hits)))
    return {"n": n, "mae": mae, "hit_rate": hr, "hit_n": len(hits)}


def main():
    print("Loading data...")
    gr, players = load_grader()
    print("Map prediction backtest (matches since %s, no leakage)" % SINCE)
    print("Baseline = top map / top-k maps from the current full-pool scout veto weights.")
    print("Predicted set = one map per simulated slot (Map 1, Map 2, decider).")
    rows, n_match = run_map_backtest(gr, players)
    print("matches:", n_match)
    summarize_maps(rows, "all")
    summarize_maps([r for r in rows if r["ev"] == "lan"], "LAN")
    summarize_maps([r for r in rows if r["ev"] == "online"], "online")
    summarize_maps([r for r in rows if r["bo"] == 1], "Bo1")
    summarize_maps([r for r in rows if r["bo"] == 3], "Bo3")

    print()
    print("v1f per-map shrink: setting-split veto vs current full-pool weights")
    print("Settled locked props since %s (voids and combos skipped). Pushes excluded from hit rate." % SINCE)
    grades, skipped, nprop = run_grade_backtest(gr, players)
    print("candidates:", nprop, "| skipped (no player/stat/proj):", skipped)
    # Align lengths in case a mode broke mid-entry
    n = min(len(grades["full_pool"]), len(grades["pred"]))
    grades = {k: v[:n] for k, v in grades.items()}
    for mode, label in (("full_pool", "full-pool scout veto"), ("pred", "setting-split Glocky veto")):
        summarize_grades(grades[mode], label)
        for ev in ("lan", "online"):
            summarize_grades([x for x in grades[mode] if x[4] == ev], "  %s %s" % (label, ev))
        for per in ("Map 1", "Maps 1-2"):
            summarize_grades([x for x in grades[mode] if x[6] == per], "  %s %s" % (label, per))


if __name__ == "__main__":
    main()
