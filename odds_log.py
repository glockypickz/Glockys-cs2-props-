"""Keeps a permanent record of match-winner odds so we can test them against real results later.
Reads the "odds" list that cito_update.py already writes into team_strength.json (no extra Cito calls).
Writes odds_history.json: one row per match (start day + the two team keys) with the FIRST odds we saw
and the LATEST odds we saw. Rows are never deleted or overwritten, only the "last" part is refreshed.
Display only: nothing in the grader reads this file."""
import json, os, datetime

HIST_FILE = os.environ.get("ODDS_HISTORY_FILE", "odds_history.json")


def _load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _dump(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
    os.replace(tmp, path)


def _snap(row, flip=False):
    p = list(row.get("p") or [None, None])
    dec = list(row.get("dec") or [None, None])
    s = {"p": p[::-1] if flip else p, "dec": dec[::-1] if flip else dec,
         "src": row.get("src"), "at": row.get("at")}
    for k in ("map1", "map2"):
        if row.get(k):
            s[k] = list(row[k])[::-1] if flip else list(row[k])
    return s


def update(strength, path=HIST_FILE):
    """strength = the dict that cito_update.py writes to team_strength.json. Returns (new, refreshed) counts."""
    rows = (strength or {}).get("odds") or []
    hist = _load(path, {"matches": {}})
    ms = hist.setdefault("matches", {})
    new = refreshed = 0
    for r in rows:
        t1, t2, start = r.get("t1"), r.get("t2"), str(r.get("start") or "")
        if not (t1 and t2 and start):
            continue
        key = start[:10] + "|" + "|".join(sorted([t1, t2]))
        cur = ms.get(key)
        if cur is None:
            ms[key] = {"t1": t1, "t2": t2, "n1": r.get("n1"), "n2": r.get("n2"), "start": start,
                       "first": _snap(r), "last": _snap(r), "seen": 1}
            new += 1
        else:
            flip = cur["t1"] != t1          # same match listed with the teams the other way round
            cur["start"] = start
            cur["last"] = _snap(r, flip)
            cur["seen"] = cur.get("seen", 1) + 1
            refreshed += 1
    hist["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    hist["note"] = ("p = implied win chance [team1, team2]; dec = decimal odds. first = first prices we saved for the match, "
                    "last = most recent prices. Never used by the grader.")
    if rows or ms:
        _dump(path, hist)
    return new, refreshed


if __name__ == "__main__":
    st = _load(os.environ.get("CITO_STRENGTH_FILE", "team_strength.json"), {})
    print("odds_history.json: %d new, %d refreshed" % update(st))
