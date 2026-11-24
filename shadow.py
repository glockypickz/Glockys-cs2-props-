"""Shadow grader (admin only). Grades each prop a second way and saves it on the line's history entry as e["shadow"].

It never changes the live grade, the live lock or anything customers see. The live grader (grader.py) is untouched.

Rule (Maps 1-2, same stat as the prop: kills for kills props, headshots for headshot props):
  base      = average of the stat over the player's last 10 series
  adjusters = head-to-head vs this opponent, this season, and series vs teams in the same rank tier as the opponent.
              Each is pulled in with weight cap * n / (n + k), so one old game barely moves it and many games count more.
  proj      = weighted mean of the averages (base weight 1).  Pick = OVER if proj >= line, else UNDER.
  letter    = the same cut-offs as the live v1 letters on (proj - line) / line: A+ >= +15%, B >= +5%, C >= -2%, D >= -10%, else F.
Every input is also saved as a count (over, series) next to its average, so the admin tab can show "last 10: 7/10".

Saved once, before the match starts, and the pick, letter, line and inputs are never changed after.
"book" (log only, never changes the pick) is refreshed each run until the match starts, so it ends as the closing picture:
  line opened -> now, the over odds, which side the book leans (line move first, else odds off the book's usual price)
  and the match-winner chance for this team from the saved match odds (lock["mo"]) when we have it.
Saved once, before the match starts, and never changed after. Needs at least 5 earlier series, else the entry gets
{"skipped": "..."} so the tab can say "not enough history". Combo props use the sum of each player's last-10 average only.
"""
import datetime

MODEL = "shadow-l10-v1"
ADJ = {"h2h": (0.25, 3.0), "tier": (0.25, 5.0), "szn": (0.25, 10.0)}   # (max weight, n at half of it)
# Shadow B (e["shadow_b"]): the same recipe with the adjusters allowed to pull much harder. Chosen by a replay on 4,300 past
# series (average miss, kills 6.34 vs 6.39 and headshots 4.00 vs 4.03 for A; the l10-only miss was 6.45 / 4.06). Saved next to A, never replaces it.
MODEL_B = "shadow-b-v1"
ADJ_B = {"h2h": (2.0, 3.0), "tier": (3.0, 5.0), "szn": (4.0, 10.0)}
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


def shadow_single(gr, p, st, line, opp, year, before="9999", adj=None, model=None, period=None):
    from grader import teq
    cs = [c for c in gr.series(p, period) if c["date"] < before and c.get(st) is not None]
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
    for k, (cap, kk) in (adj or ADJ).items():
        n, m = pieces[k]["n"], pieces[k]["mean"]
        w = 0.0 if not n or m is None else cap * n / (n + kk)
        ws[k] = round(w, 3)
        num += w * (m or 0)
        den += w
    proj = num / den
    g, pick, pct = _letter(proj, line)
    return {"model": model or MODEL, "line": line, "proj": round(proj, 1), "edge": round(proj - line, 1), "edge_pct": round(pct, 4),
            "grade": g, "pick": pick, "pieces": pieces, "weights": ws}


def shadow_combo(gr, name, team, st, line, before="9999", period=None):
    mu = 0.0
    for n in [x.strip() for x in str(name).split("+") if x.strip()]:
        p = gr.find(n, team)
        if not p:
            return {"skipped": "player not in data: " + n}
        l10 = [c[st] for c in gr.series(p, period) if c["date"] < before and c.get(st) is not None][:10]
        if len(l10) < MIN_L10:
            return {"skipped": "%s: only %d earlier series (need %d)" % (n, len(l10), MIN_L10)}
        mu += _mean(l10)
    g, pick, pct = _letter(mu, line)
    return {"model": MODEL, "line": line, "proj": round(mu, 1), "edge": round(mu - line, 1), "edge_pct": round(pct, 4),
            "grade": g, "pick": pick, "pieces": {}, "weights": {"l10": 1.0}, "combo": True}


BOOK_BE = {"prizepicks": 0.577, "underdog": 0.53}


def _be(odds):
    try:
        o = float(odds)
    except (TypeError, ValueError):
        return None
    return -o / (-o + 100.0) if o <= -100 else 100.0 / (o + 100.0) if o >= 100 else None


def book_info(e):
    """How the book leans on this prop (log only): line movement since first seen, and the over odds against the book's usual price."""
    line, first = e.get("line"), e.get("first_line")
    out = {"first_line": first, "line": line, "odds": e.get("odds")}
    mv = None
    try:
        mv = round(float(line) - float(first), 2)
    except (TypeError, ValueError):
        pass
    out["move"] = mv
    be = _be(e.get("odds"))
    usual = BOOK_BE.get(str(e.get("book", "")).lower().replace(" ", ""))
    out["over_implied"] = None if be is None else round(be, 4)
    odds_lean = None if be is None or usual is None else round(be - usual, 4)   # + = over priced shorter than usual
    out["odds_lean"] = odds_lean
    if mv:
        out["lean"], out["basis"] = ("OVER" if mv > 0 else "UNDER"), "line moved %+g" % mv
    elif odds_lean is not None and abs(odds_lean) >= 0.01:
        out["lean"], out["basis"] = ("OVER" if odds_lean > 0 else "UNDER"), "odds off the usual price"
    else:
        out["lean"], out["basis"] = None, None
    mo = (e.get("lock") or {}).get("mo")
    if mo and mo.get("p"):
        out["match_win"] = mo["p"][0]
        out["match_opp"] = mo["p"][1]
        out["match_src"] = mo.get("src")
    return out


def apply(gr, e, now, t0):
    """Add e["shadow"] (and e["shadow_b"]) to one history entry: only before the match starts, once, never overwritten."""
    if t0 and now and now >= t0:
        return
    _apply_a(gr, e, now, t0)
    _apply_b(gr, e, now)


def _apply_b(gr, e, now):
    """Shadow B: single-player props only (a combo is just the sum of last-10 averages, the same as A). Written once, before the start."""
    if e.get("shadow_b") or gr is None or "+" in str(e.get("player", "")):
        return
    try:
        stl = str(e.get("stat", "")).lower()
        st = "hs" if "head" in stl else "kills" if "kill" in stl else None
        if not st:
            return
        line = float((e.get("lock") or {}).get("line", e["line"]))
        year = (now.isoformat()[:4] if now else str(e.get("start", ""))[:4])
        p = gr.find(e["player"], e.get("team"))
        s = {"skipped": "player not found in data"} if not p else shadow_single(
            gr, p, st, line, e.get("opponent") or "", year, adj=ADJ_B, model=MODEL_B, period=e.get("period"))
        s["at"] = now.isoformat(timespec="seconds") if now else None
        e["shadow_b"] = s
    except Exception as ex:
        print("shadow B failed for", e.get("player"), ex)


def _apply_a(gr, e, now, t0):
    sh = e.get("shadow")
    if sh:   # already graded: pick / letter / inputs stay as they are, only the book picture is refreshed until the match starts
        if not sh.get("skipped"):
            sh["book"] = book_info(e)
        return
    if gr is None:
        return
    try:
        stl = str(e.get("stat", "")).lower()
        st = "hs" if "head" in stl else "kills" if "kill" in stl else None
        if not st:
            return
        line = float((e.get("lock") or {}).get("line", e["line"]))
        year = (now.isoformat()[:4] if now else str(e.get("start", ""))[:4])
        if "+" in e["player"]:
            s = shadow_combo(gr, e["player"], e.get("team"), st, line, period=e.get("period"))
        else:
            p = gr.find(e["player"], e.get("team"))
            if not p:
                s = {"skipped": "player not found in data"}
            else:
                s = shadow_single(gr, p, st, line, e.get("opponent") or "", year, period=e.get("period"))
        s["at"] = now.isoformat(timespec="seconds") if now else None
        if "skipped" not in s:
            s["book"] = book_info(e)
        e["shadow"] = s
    except Exception as ex:
        print("shadow failed for", e.get("player"), ex)
