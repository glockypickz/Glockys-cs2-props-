"""Match-winner odds from Cito (Pro: one call a run is cheap). Writes cito_odds.json, rows in the same shape as
team_strength.json "odds": n1, n2, start, p (implied win chance of each side), dec, src, at, map1, map2.
fetch_lines.match_odds_for reads it first, so every lock gets fresh odds. Display / log only. Never stops the lines job."""
import json, datetime
import cito_api

OUT = "cito_odds.json"


def _row(m, fetched):
    by = {}
    for o in m.get("odds") or []:
        if o.get("market") in ("h2h", "map_h2h_1", "map_h2h_2") and o.get("market") not in by:
            by[o["market"]] = o
    h = by.get("h2h")
    if not h or not isinstance(h.get("team1ImpliedProb"), (int, float)) or not isinstance(h.get("team2ImpliedProb"), (int, float)):
        return None
    if not (m.get("team1Name") and m.get("team2Name")):
        return None
    row = {"n1": m["team1Name"], "n2": m["team2Name"], "start": m.get("startsAt"),
           "p": [round(h["team1ImpliedProb"], 4), round(h["team2ImpliedProb"], 4)], "dec": [h.get("team1Odds"), h.get("team2Odds")],
           "src": "cito/" + str(h.get("provider")), "at": h.get("capturedAt") or fetched}
    for k, mk in (("map1", "map_h2h_1"), ("map2", "map_h2h_2")):
        o = by.get(mk)
        if o and isinstance(o.get("team1ImpliedProb"), (int, float)) and isinstance(o.get("team2ImpliedProb"), (int, float)):
            row[k] = [round(o["team1ImpliedProb"], 4), round(o["team2ImpliedProb"], 4)]
    return row


def refresh(now=None):
    """Upcoming + today's matches from Cito -> cito_odds.json. Returns the number of matches with odds."""
    if not cito_api.have_key():
        print("cito odds: no CITO_API_KEY, skipped")
        return 0
    now = now or datetime.datetime.now(datetime.timezone.utc)
    fetched = now.isoformat(timespec="seconds")
    seen = {}
    for path, params in (("/cs2/matches/upcoming", {"limit": 100}), ("/cs2/matches/today", {})):
        try:
            for m in cito_api.rows(cito_api.get(path, params)):
                if m.get("id") and m["id"] not in seen:
                    seen[m["id"]] = m
        except Exception as e:
            print("cito odds: %s failed: %s" % (path, e))
    rows = [r for r in (_row(m, fetched) for m in seen.values() if str(m.get("status", "")).lower() != "finished") if r]
    if not seen:
        return 0          # nothing came back: keep the old file
    json.dump({"updated": fetched, "rows": rows}, open(OUT, "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
    print("cito odds: %d matches listed, %d with match-winner odds" % (len(seen), len(rows)))
    return len(rows)
