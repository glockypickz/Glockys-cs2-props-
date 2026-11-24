"""Settles saved lines (lines_history.json) against real results in players.json.

Maps 1-2 props (the default, including history entries with no period) use Map 1+2 totals.
Map 1 props (period="Map 1") settle against Map 1 stats only; Map 2 is not required.

Genuine Bo1 matches: Map 1 props settle against the one map played and are marked
result.bo1. Maps 1-2 props stay void (the books post two-map lines and void them when
map 2 is never played). Forfeits (a required map was forfeited, or no map was really
played) stay void and are not flagged as Bo1.

Result saved on the entry as e["result"]:
  act        real Maps 1-2 total (combo props: the players added up), or Map 1 total
  close_vs   "over" / "under" / "push" against the closing line (e["line"])
  outcome    for locked picks: "hit" / "miss" / "push" against the locked line and pick; "void" if never played
  bo1        True when a genuine Bo1 was settled as hit/miss/push
  void       reason, when the line can not be settled (Bo1 Maps 1-2, forfeit, only one map, not played, no stats)
Matching is the same as the site: same team, same opponent (team aliases applied), within +/-1 day.
Backup: when players.json (bo3.gg) has no result, saved Cito per-map stats (cito_cache/_results_index.json, written by
the daily cito_update.py) are tried before voiding. This reads a file only; settling never calls the Cito API.
Such results carry "src": "cito".
Scheduled format (best-of) is read from the Cito index / cito_cache/_formats.json / games.json, also files only."""
import datetime, json, os
from grader import teq, norm, canon, period_of, is_map1

CITO_INDEX = os.environ.get("CITO_RESULTS_INDEX", os.path.join("cito_cache", "_results_index.json"))
FORMATS_FILE = os.environ.get("CITO_FORMATS", os.path.join("cito_cache", "_formats.json"))
GAMES_FILE = os.environ.get("GAMES_FILE", "games.json")
_CITO = None
_FORMATS = None

VOID_AFTER_H = 72
WAIT_H = 1
VOID_MAPS12_BO1 = "Maps 1-2 not played (Bo1)"
VOID_FORFEIT = "map forfeited"
VOID_ONE_MAP = "only one map played (Bo1 or forfeit)"


def _cito_matches():
    global _CITO
    if _CITO is None:
        try:
            with open(CITO_INDEX, encoding="utf-8") as f:
                _CITO = json.load(f).get("matches") or []
        except Exception:
            _CITO = []
    return _CITO


def reset_lookups():
    """Tests: drop cached Cito / format rows so the next read picks up injected data."""
    global _CITO, _FORMATS
    _CITO = None
    _FORMATS = None


def set_formats(rows):
    """Tests: install format rows in memory (each is {date, t1, t2, bo, forfeit?, src?})."""
    global _FORMATS
    _FORMATS = list(rows or [])


def bo_num(bo):
    try:
        n = int("".join(ch for ch in str(bo) if ch.isdigit()))
        return n if n in (1, 3, 5) else None
    except Exception:
        return None


def _fmt_row(date, t1, t2, bo, forfeit=None, src="", mid="", maps=None):
    return {"date": date or "", "t1": t1, "t2": t2, "bo": bo_num(bo),
            "forfeit": bool(forfeit), "src": src or "", "id": mid or "",
            "maps": maps}


def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _forfeit_from_maps(maps, period=None):
    """True when a map required for this period is marked forfeit."""
    if not maps:
        return False
    by = {g.get("n"): g for g in maps if g.get("n") is not None}
    need = (1,) if is_map1(period) else (1, 2)
    return any(by.get(n, {}).get("forfeit") for n in need)


def _formats():
    global _FORMATS
    if _FORMATS is not None:
        return _FORMATS
    rows = []
    for m in _cito_matches():
        rows.append(_fmt_row(m.get("date"), m.get("t1"), m.get("t2"), m.get("bo") or m.get("bestOf"),
                             _forfeit_from_maps(m.get("maps") or []), "cito-index", m.get("id"),
                             m.get("maps")))
    for m in _load_json(FORMATS_FILE, {}).get("matches") or []:
        rows.append(_fmt_row(m.get("date"), m.get("t1"), m.get("t2"), m.get("bo") or m.get("bestOf"),
                             m.get("forfeit"), m.get("src") or "formats", m.get("id"), m.get("maps")))
    games = _load_json(GAMES_FILE, {})
    for g in games.get("games") or []:
        start = str(g.get("start") or "")
        rows.append(_fmt_row(start[:10], g.get("team1"), g.get("team2"), g.get("bo"),
                             False, "games", g.get("id")))
    _FORMATS = rows
    return _FORMATS


def _same_match(row, e):
    try:
        d0 = datetime.date.fromisoformat(str(e.get("start") or "")[:10])
        d1 = datetime.date.fromisoformat(str(row.get("date") or "")[:10])
    except Exception:
        return False
    if abs((d1 - d0).days) > 1:
        return False
    t1, t2, team, opp = row.get("t1"), row.get("t2"), e.get("team"), e.get("opponent")
    return ((teq(t1, team) and teq(t2, opp)) or (teq(t2, team) and teq(t1, opp)))


def format_of(e):
    """Scheduled format for this line, or {} if unknown. Never raises."""
    hits = [r for r in _formats() if _same_match(r, e)]
    if not hits:
        return {}
    # Prefer a known bo, then a row that knows about a forfeit, then Cito over games.
    rank = {"cito-index": 0, "cito": 1, "formats": 2, "games": 3}

    def key(r):
        bo = r.get("bo")
        return (0 if bo else 1, 0 if r.get("forfeit") else 1, rank.get(r.get("src"), 9))

    hits.sort(key=key)
    # If any matching row says bo=1 and none of the preferred rows say a different bo, use 1.
    bos = [r.get("bo") for r in hits if r.get("bo")]
    picked = hits[0]
    out = {"bo": picked.get("bo"), "forfeit": any(r.get("forfeit") for r in hits
                                                  if (not r.get("bo") or r.get("bo") == picked.get("bo"))),
           "src": picked.get("src"), "id": picked.get("id")}
    if 1 in bos and 3 not in bos and 5 not in bos:
        out["bo"] = 1
    elif picked.get("bo"):
        out["bo"] = picked.get("bo")
    elif bos:
        out["bo"] = bos[0]
    # Forfeit on this period's required maps, when the row has map-level data.
    period = e
    for r in hits:
        if _forfeit_from_maps(r.get("maps") or [], period):
            out["forfeit"] = True
            break
    return {k: v for k, v in out.items() if v or k == "bo"}


def is_genuine_bo1(e):
    fmt = format_of(e)
    return bool(fmt.get("bo") == 1 and not fmt.get("forfeit"))


def cito_result(e):
    """(stat, actual, mid, date) from saved Cito data, or None.
    Maps 1-2: both Map 1 and Map 2 must be played (no forfeit).
    Map 1: only Map 1 must be completed (no forfeit). Players matched by name on the line's team only."""
    st = "hs" if "head" in e["stat"].lower() else "kills" if "kill" in e["stat"].lower() else None
    if not st or not e.get("team") or not e.get("opponent"):
        return None
    need = (1,) if is_map1(e) else (1, 2)
    day = datetime.date.fromisoformat(e["start"][:10])
    for m in _cito_matches():
        try:
            dd = abs((datetime.date.fromisoformat(m["date"]) - day).days)
        except Exception:
            continue
        if dd > 1 or not ((teq(m.get("t1"), e["team"]) and teq(m.get("t2"), e["opponent"])) or
                          (teq(m.get("t2"), e["team"]) and teq(m.get("t1"), e["opponent"]))):
            continue
        maps = {g.get("n"): g for g in m.get("maps") or []}
        if any(n not in maps or maps[n].get("status") != "completed" or maps[n].get("forfeit") for n in need):
            return None
        tot = 0.0
        for name in [x.strip() for x in str(e["player"]).split("+") if x.strip()]:
            got = None
            for n in need:
                rows = [p for p in maps[n].get("players") or [] if teq(p[1], e["team"]) and
                        (norm(p[0]) == norm(name) or canon(p[0]) == canon(name))]
                v = rows[0][2 if st == "kills" else 3] if len(rows) == 1 else None
                if v is None:
                    return None
                got = (got or 0.0) + float(v)
            tot += got
        return st, tot, "cito:" + str(m.get("id")), m.get("date")
    return None


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
        per = period_of(e)
        for c in gr.series(p, per):
            if not c["date"] or not teq(c["opp"], e.get("opponent")):
                continue
            dd = abs((datetime.date.fromisoformat(c["date"]) - day).days)
            if dd <= 1 and (best is None or dd < best[1]):
                best = (c, dd)
        if not best or best[0][st] is None:
            one_map = any(teq(l.get("opp"), e.get("opponent")) and l.get("n") == 1 and l.get("date") and
                          abs((datetime.date.fromisoformat(l["date"]) - day).days) <= 1 for l in p.get("logs") or [])
            if is_map1(e):
                return None, "no Map 1 stats for this match"
            return None, (VOID_ONE_MAP if one_map else "no stats for this match")
        tot += best[0][st]
        mid, date = best[0]["mid"], best[0]["date"]
    return (st, tot, mid, date), None


def _revisitable_void(r):
    if not r or r.get("outcome") != "void":
        return False
    why = str(r.get("void") or "")
    return why.startswith("only one map played") or why in (VOID_MAPS12_BO1, VOID_FORFEIT, VOID_ONE_MAP) or "Bo1" in why


def _void_reason(e, why, fmt):
    if fmt.get("forfeit"):
        return VOID_FORFEIT
    if not is_map1(e) and fmt.get("bo") == 1:
        return VOID_MAPS12_BO1
    return why or VOID_ONE_MAP


def _apply_void(e, why, now, fmt=None):
    fmt = fmt if fmt is not None else format_of(e)
    reason = _void_reason(e, why, fmt)
    res = {"void": reason, "outcome": "void" if e.get("lock") else None,
           "settled_at": now.isoformat(timespec="seconds")}
    e["result"] = res
    return True


def _apply_settled(e, found, src, now, fmt=None):
    st, act, mid, date = found
    close = float(e["line"])
    res = {"act": act, "mid": mid, "date": date,
           "close_vs": "push" if act == close else "over" if act > close else "under",
           "settled_at": now.isoformat(timespec="seconds")}
    if src:
        res["src"] = src
    lk = e.get("lock")
    if lk:
        ll = float(lk["line"])
        res["outcome"] = "push" if act == ll else ("hit" if (act > ll) == (lk.get("pick") == "OVER") else "miss")
    fmt = fmt if fmt is not None else format_of(e)
    if fmt.get("bo") == 1 and not fmt.get("forfeit") and res.get("outcome") in ("hit", "miss", "push"):
        res["bo1"] = True
    e["result"] = res
    return True


def _result_fields(r):
    """Comparable settlement fields (locks are never included)."""
    if not r:
        return None
    keys = ("act", "mid", "date", "close_vs", "outcome", "void", "src", "bo1")
    return tuple(r.get(k) for k in keys)


def _commit_result(e, previous, changed_fields):
    """Keep the previous result (including settled_at) when only the timestamp would change."""
    if changed_fields:
        return True
    if previous:
        e["result"] = previous
    elif "result" in e and not previous:
        # shouldn't happen for revisits
        pass
    return False


def annotate_bo1(e):
    """Set or clear result.bo1 on an already-settled hit/miss/push. Returns True if result changed.
    Never touches e['lock'] or the outcome / act."""
    r = e.get("result") or {}
    if r.get("outcome") not in ("hit", "miss", "push") or r.get("act") is None:
        return False
    fmt = format_of(e)
    if fmt.get("bo") == 1 and not fmt.get("forfeit"):
        if r.get("bo1"):
            return False
        r["bo1"] = True
        e["result"] = r
        return True
    # Only clear the flag when the match is confirmed not to be a Bo1.
    if r.get("bo1") and (fmt.get("forfeit") or (fmt.get("bo") and fmt.get("bo") != 1)):
        r.pop("bo1", None)
        e["result"] = r
        return True
    return False


def settle_entry(gr, e, now, revisit_void=True):
    """Adds/updates e["result"]. Returns True if the entry changed.
    Locked grades, letters, picks and projections are never written here.
    Already-voided one-map / Bo1 / forfeit rows can be revisited so a genuine Bo1
    Map 1 prop can be scored, or the void reason can be made specific. Other voids
    and settled hit/miss/push rows are left alone except for the bo1 flag."""
    r = e.get("result") or {}
    outcome = r.get("outcome")
    if (outcome in ("hit", "miss", "push") or (r.get("act") is not None and not e.get("lock"))):
        return annotate_bo1(e)
    revisiting = bool(revisit_void and _revisitable_void(r))
    # Unlocked voids have outcome None but still carry a void reason; do not rewrite them.
    if (outcome == "void" or r.get("void")) and not revisiting:
        return False
    t0 = _pt(e.get("start"))
    if gr is None or t0 is None or now is None or now < t0 + datetime.timedelta(hours=WAIT_H):
        return False
    before = _result_fields(r) if revisiting else None
    fmt = format_of(e)
    # Maps 1-2 on a confirmed Bo1 never settle: the period was not played.
    if not is_map1(e) and fmt.get("bo") == 1 and not fmt.get("forfeit"):
        _apply_void(e, VOID_MAPS12_BO1, now, fmt)
        return _commit_result(e, r, _result_fields(e.get("result")) != before)
    # A forfeited required map stays void, even if some stats exist.
    if fmt.get("forfeit"):
        _apply_void(e, VOID_FORFEIT, now, fmt)
        return _commit_result(e, r, _result_fields(e.get("result")) != before)
    found, why = find_result(gr, e)
    src = None
    if not found:
        found = cito_result(e)
        src = "cito" if found else None
    if not found:
        # Confirmed Bo1 Map 1 still needs stats; wait, then void as no Map 1 stats.
        if why in (VOID_ONE_MAP,) or (why and "only one map" in why):
            if fmt.get("bo") == 1:
                _apply_void(e, VOID_MAPS12_BO1, now, fmt)
                return _commit_result(e, r, _result_fields(e.get("result")) != before)
            if now >= t0 + datetime.timedelta(hours=VOID_AFTER_H):
                _apply_void(e, why, now, fmt)
                return _commit_result(e, r, _result_fields(e.get("result")) != before)
            return False
        if now >= t0 + datetime.timedelta(hours=VOID_AFTER_H):
            e["result"] = {"void": why, "outcome": "void" if e.get("lock") else None,
                           "settled_at": now.isoformat(timespec="seconds")}
            return _commit_result(e, r, _result_fields(e.get("result")) != before)
        return False
    _apply_settled(e, found, src, now, fmt)
    return _commit_result(e, r, _result_fields(e.get("result")) != before)


def settle_all(gr, entries, now):
    n = sum(1 for e in entries if settle_entry(gr, e, now))
    c, b = {}, {"hit": 0, "miss": 0, "push": 0}
    for e in entries:
        o = (e.get("result") or {}).get("outcome")
        if o:
            c[o] = c.get(o, 0) + 1
        if o in b and (e.get("result") or {}).get("bo1"):
            b[o] += 1
    print("settled this run:", n, "| locked outcomes so far:", c, "| bo1:", b)
    return n


def record_counts(entries):
    """Locked-outcome totals for the overall record and the Bo1 subset (pushes kept separate)."""
    overall = {"hit": 0, "miss": 0, "push": 0, "void": 0}
    bo1 = {"hit": 0, "miss": 0, "push": 0}
    for e in entries or []:
        if not e.get("lock"):
            continue
        r = e.get("result") or {}
        o = r.get("outcome")
        if o in overall:
            overall[o] += 1
        if r.get("bo1") and o in bo1:
            bo1[o] += 1
    def pack(d):
        decided = d.get("hit", 0) + d.get("miss", 0)
        rate = round(100.0 * d["hit"] / decided, 1) if decided else None
        return dict(d, decided=decided, hit_rate=rate)
    return {"overall": pack(overall), "bo1": pack(bo1)}
