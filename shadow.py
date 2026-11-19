"""Shadow grader (admin only). Grades each prop a second way and saves it on the line's history entry as e["shadow"].

It never changes the live grade, the live lock or anything customers see. The live grader (grader.py) is untouched.

Rule (Maps 1-2, same stat as the prop: kills for kills props, headshots for headshot props):
  base      = average of the stat over the player's last 10 series
  adjusters = head-to-head vs this opponent, this season, and series vs teams in the same rank tier as the opponent.
              Each is pulled in with weight cap * n / (n + k), so one old game barely moves it and many games count more.
  proj      = weighted mean of the averages (base weight 1).  Pick = OVER if proj >= line, else UNDER.
  letter    = the same cut-offs as the live v1 letters on (proj - line) / line: A+ >= +15%, B >= +5%, C >= -2%, D >= -10%, else F.
Every input is also saved as a count (over, series) next to its average, so the admin tab can show "last 10: 7/10".

Saved once, before the match starts, and never changed after. Needs at least 5 earlier series, else the entry gets
{"skipped": "..."} so the tab can say "not enough history". Combo props use the sum of each player's last-10 average only.
"""
import datetime

MODEL = "shadow-l10-v1"
ADJ = {"h2h": (0.25, 3.0), "tier": (0.25, 5.0), "szn": (0.25, 10.0)}   # (max weight, n at half of it)
MIN_L10 = 5


def _parse(t):
    try:
        return datetime.datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except Exception:
        return None


def _mean(a):
    return sum(a) / len(a) if a else None


def _piece(rows, st, line):
    v = [c[st] for c in rows if c.get(st) is not None]
    return {"n": len(v), "mean": None if not v else round(_mean(v), 2), "over": sum(1 for x in v if x > line)}


def _letter(proj, line):
    pct = (proj - line) / line
    g = "A+" if pct >= .15 else "B" if pct >= .05 else "C" if pct >= -.02 else "D" if pct >= -.10 else "F"
    return g, ("OVER" if proj >= line else "UNDER"), pct


def shadow_single(gr, p, st, line, opp, year, before="9999"):
    from grader import teq
    cs = [c for c in gr.series(p) if c["date"] < before and c.get(st) is not None]
    l10 = cs[:10]
    if len(l10) < MIN_L10:
        return {"skipped": "only %d earlier series (need %d)" % (len(l10), MIN_L10)}
    pieces = {"l10": _piece(l10, st, line)}
    pieces["h2h"] = _piece([c for c in cs if opp and teq(c["opp"], opp)], st, line)
    pieces["szn"] = _piece([c for c in cs if c["date"][:4] == year], st, line)
    tier = None
    orank = gr.rank_of(opp) if opp else None
    if orank is not None:
        tier = gr.tier(orank)
        same = [c for c in cs if gr.rank_of(c["opp"]) is not None and gr.tier(gr.rank_of(c["opp"])) == tier]
        pieces["tier"] = _piece(same, st, line)
        pieces["tier"]["tier"] = tier
    else:
        pieces["tier"] = {"n": 0, "mean": None, "over": 0, "tier": None}
    num, den, ws = pieces["l10"]["mean"], 1.0, {"l10": 1.0}
    for k, (cap, kk) in ADJ.items():
        n, m = pieces[k]["n"], pieces[k]["mean"]
        w = 0.0 if not n or m is None else cap * n / (n + kk)
        ws[k] = round(w, 3)
        num += w * (m or 0)
        den += w
    proj = num / den
    g, pick, pct = _letter(proj, line)
    return {"model": MODEL, "line": line, "proj": round(proj, 1), "edge": round(proj - line, 1), "edge_pct": round(pct, 4),
            "grade": g, "pick": pick, "pieces": pieces, "weights": ws}


def shadow_combo(gr, name, team, st, line, before="9999"):
    mu = 0.0
    for n in [x.strip() for x in str(name).split("+") if x.strip()]:
        p = gr.find(n, team)
        if not p:
            return {"skipped": "player not in data: " + n}
        l10 = [c[st] for c in gr.series(p) if c["date"] < before and c.get(st) is not None][:10]
        if len(l10) < MIN_L10:
            return {"skipped": "%s: only %d earlier series (need %d)" % (n, len(l10), MIN_L10)}
        mu += _mean(l10)
    g, pick, pct = _letter(mu, line)
    return {"model": MODEL, "line": line, "proj": round(mu, 1), "edge": round(mu - line, 1), "edge_pct": round(pct, 4),
            "grade": g, "pick": pick, "pieces": {}, "weights": {"l10": 1.0}, "combo": True}


def apply(gr, e, now, t0):
    """Add e["shadow"] to one history entry: only before the match starts, once, never overwritten. Safe to call every run."""
    if gr is None or e.get("shadow") or (t0 and now and now >= t0):
        return
    try:
        stl = str(e.get("stat", "")).lower()
        st = "hs" if "head" in stl else "kills" if "kill" in stl else None
        if not st:
            return
        line = float((e.get("lock") or {}).get("line", e["line"]))
        year = (now.isoformat()[:4] if now else str(e.get("start", ""))[:4])
        if "+" in e["player"]:
            s = shadow_combo(gr, e["player"], e.get("team"), st, line)
        else:
            p = gr.find(e["player"], e.get("team"))
            if not p:
                s = {"skipped": "player not found in data"}
            else:
                s = shadow_single(gr, p, st, line, e.get("opponent") or "", year)
        s["at"] = now.isoformat(timespec="seconds") if now else None
        e["shadow"] = s
    except Exception as ex:
        print("shadow failed for", e.get("player"), ex)
