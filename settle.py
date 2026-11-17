"""Settles saved lines (lines_history.json) against real Map 1+2 results in players.json.

Result saved on the entry as e["result"]:
  act        real Maps 1-2 total (combo props: the players added up)
  close_vs   "over" / "under" / "push" against the closing line (e["line"])
  outcome    for locked picks: "hit" / "miss" / "push" against the locked line and pick; "void" if never played
  void       reason, when the line can not be settled 72h after the start (Bo1 / only one map, not played, no stats)
Matching is the same as the site: same team, same opponent (team aliases applied), within +/-1 day."""
import datetime
from grader import teq

VOID_AFTER_H = 72
WAIT_H = 5


def _pt(t):
    try:
        return datetime.datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except Exception:
        return None


def find_result(gr, e):
    """(stat, actual, mid, date) or (None, reason) if not found."""
    st = "hs" if "head" in e["stat"].lower() else "kills" if "kill" in e["stat"].lower() else None
    if not st:
        return None, "unknown stat"
    day = datetime.date.fromisoformat(e["start"][:10])
    tot, mid, date = 0.0, None, None
    for n in [x.strip() for x in str(e["player"]).split("+") if x.strip()]:
        p = gr.find(n, e.get("team"))
        if not p:
            return None, "player not in data"
        best = None
        for c in gr.series(p):
            if not c["date"] or not teq(c["opp"], e.get("opponent")):
                continue
            dd = abs((datetime.date.fromisoformat(c["date"]) - day).days)
            if dd <= 1 and (best is None or dd < best[1]):
                best = (c, dd)
        if not best or best[0][st] is None:
            one_map = any(teq(l.get("opp"), e.get("opponent")) and l.get("n") == 1 and l.get("date") and
                          abs((datetime.date.fromisoformat(l["date"]) - day).days) <= 1 for l in p.get("logs") or [])
            return None, ("only one map played (Bo1 or forfeit)" if one_map else "no stats for this match")
        tot += best[0][st]
        mid, date = best[0]["mid"], best[0]["date"]
    return (st, tot, mid, date), None


def settle_entry(gr, e, now):
    """Adds/updates e["result"]. Returns True if the entry changed."""
    r = e.get("result") or {}
    if r.get("outcome") in ("hit", "miss", "push", "void") or (r.get("act") is not None and not e.get("lock")):
        return False
    t0 = _pt(e.get("start"))
    if gr is None or t0 is None or now is None or now < t0 + datetime.timedelta(hours=WAIT_H):
        return False
    found, why = find_result(gr, e)
    if not found:
        if now >= t0 + datetime.timedelta(hours=VOID_AFTER_H):
            e["result"] = {"void": why, "outcome": "void" if e.get("lock") else None, "settled_at": now.isoformat(timespec="seconds")}
            return True
        return False
    st, act, mid, date = found
    close = float(e["line"])
    res = {"act": act, "mid": mid, "date": date,
           "close_vs": "push" if act == close else "over" if act > close else "under",
           "settled_at": now.isoformat(timespec="seconds")}
    lk = e.get("lock")
    if lk:
        ll = float(lk["line"])
        res["outcome"] = "push" if act == ll else ("hit" if (act > ll) == (lk.get("pick") == "OVER") else "miss")
    e["result"] = res
    return True


def settle_all(gr, entries, now):
    n = sum(1 for e in entries if settle_entry(gr, e, now))
    c = {}
    for e in entries:
        o = (e.get("result") or {}).get("outcome")
        if o:
            c[o] = c.get(o, 0) + 1
    print("settled this run:", n, "| locked outcomes so far:", c)
    return n
