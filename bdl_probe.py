"""Diagnostic (changes nothing): what does the Ball Don't Lie CS2 API give us on this plan?
Tests: auth, live/today matches (status values), head-to-head (matches filtered by two teams), per-map player stats
(kills, headshots), and the rate limit. Needs the BALLDONTLIE_KEY secret. Never prints the key."""
import os, sys, json, time, datetime, urllib.request, urllib.error, urllib.parse

KEY = os.environ.get("BALLDONTLIE_KEY", "")
BASE = "https://api.balldontlie.io/cs/v1"
PACE = [1.0]          # seconds between calls, set from the plan's rate limit


def short(o, n=600):
    t = json.dumps(o, ensure_ascii=False, default=str)
    return t if len(t) <= n else t[:n] + " ...[cut]"


def call(path, params=None):
    """-> (status, json or None). Pauses between calls so a 5-per-minute plan is not tripped."""
    q = urllib.parse.urlencode(params or {}, doseq=True)
    req = urllib.request.Request(BASE + path + ("?" + q if q else ""), headers={"Authorization": KEY, "User-Agent": "glockys-prop-grader"})
    for attempt in range(3):
        time.sleep(PACE[0])
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                lim = r.headers.get("X-RateLimit-Limit")
                if lim and not getattr(call, "told", False):
                    call.told = True
                    print("rate limit header: %s per minute, %s left" % (lim, r.headers.get("X-RateLimit-Remaining")))
                    PACE[0] = 13.0 if int(lim) <= 5 else 60.0 / int(lim) + 0.2
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300].replace(KEY, "***")
            if e.code == 429 and attempt < 2:
                print("   429, waiting 65s")
                time.sleep(65)
                continue
            return e.code, {"error": body}
        except Exception as e:
            return 0, {"error": type(e).__name__ + " " + str(e)[:120]}
    return 429, None


def show(label, path, params=None, n=1):
    st, d = call(path, params)
    data = (d or {}).get("data") if isinstance(d, dict) else None
    print("\n[%s] GET %s %s -> HTTP %s" % (label, path, json.dumps(params) if params else "", st))
    if st != 200:
        print("   ", short(d, 300))
        return st, None
    print("   rows:", len(data) if isinstance(data, list) else "n/a", "| meta:", short((d or {}).get("meta"), 150))
    for row in (data or [])[:n]:
        print("   sample:", short(row, 900))
    return st, data


def main():
    if not KEY:
        sys.exit("BALLDONTLIE_KEY is empty: the secret is missing or named differently")
    print("key present, %d characters" % len(KEY))
    show("auth / free tier: teams", "/teams", {"per_page": 3})
    today = datetime.date.today()
    seen = {}
    for off in (0, 1):
        d = (today + datetime.timedelta(days=off)).isoformat()
        st, rows = show("matches on " + d, "/matches", {"dates[]": [d], "per_page": 100}, n=2)
        if st in (401, 403):
            print("   -> /matches needs a higher plan than this key has: no live games, head-to-head or match stats from here")
            break
        for m in rows or []:
            seen[m["id"]] = m
    if seen:
        sv = {}
        for m in seen.values():
            k = (m.get("status"), m.get("status_state"))
            sv[k] = sv.get(k, 0) + 1
        print("\nstatus / status_state values seen in today+tomorrow:", {"%s/%s" % k: v for k, v in sv.items()})
        pairs = [m for m in seen.values() if (m.get("team1") or {}).get("id") and (m.get("team2") or {}).get("id")]
        for m in pairs[:3]:
            a, b = m["team1"], m["team2"]
            print("\n==== H2H test: %s vs %s (ids %s / %s)" % (a.get("name"), b.get("name"), a["id"], b["id"]))
            both = {a["id"], b["id"]}
            st, rows = show("team_ids[] = A and B", "/matches", {"team_ids[]": [a["id"], b["id"]], "per_page": 100}, n=0)
            if rows is not None:
                meet = [r for r in rows if {(r.get("team1") or {}).get("id"), (r.get("team2") or {}).get("id")} == both and r["id"] != m["id"]]
                print("   of those, A vs B (not today's): %d, dates %s" % (len(meet), sorted(str(r.get("start_time"))[:10] for r in meet)[-8:]))
                print("   other teams mixed in (filter is 'either team'):", len(rows) - len(meet) - sum(1 for r in rows if r["id"] == m["id"]))
        fin = next((m for m in seen.values() if str(m.get("status_state") or m.get("status")).lower() in ("final", "finished", "completed")), None)
    else:
        fin = None
    if not fin:
        st, rows = show("recent finished match (latest 5 days)", "/matches",
                        {"dates[]": [(today - datetime.timedelta(days=k)).isoformat() for k in range(1, 4)], "per_page": 50}, n=0)
        fin = next((m for m in rows or [] if str(m.get("status_state") or m.get("status")).lower() in ("final", "finished", "completed")), None)
    if fin:
        print("\n==== STATS test on finished match %s vs %s (id %s, %s)" % ((fin.get("team1") or {}).get("name"), (fin.get("team2") or {}).get("name"), fin["id"], str(fin.get("start_time"))[:10]))
        st, maps = show("match_maps", "/match_maps", {"match_ids[]": [fin["id"]]}, n=3)
        if maps:
            mp = maps[0]
            st, rows = show("player_match_map_stats (map %s)" % mp.get("map_number"), "/player_match_map_stats", {"match_map_id": mp["id"]}, n=2)
            for r in (rows or [])[:10]:
                print("   ", (r.get("player") or {}).get("nickname"), "kills", r.get("kills"), "hs%", r.get("headshot_percentage"), "adr", r.get("adr"))
            show("match_map_stats (raw headshots live here?)", "/match_map_stats", {"match_map_id": mp["id"]}, n=0)
    else:
        print("\nno finished match found to test stats on")
    print("\ndone")


if __name__ == "__main__":
    main()
