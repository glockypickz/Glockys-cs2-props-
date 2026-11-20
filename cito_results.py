"""Finished matches from Cito -> players.json, so props settle even when bo3.gg is blocked. Runs next to update_results.py (the bo3.gg job).

For finished Cito matches from the last LOOKBACK_DAYS days where a team is in players.json and bo3.gg has not already given us that
match (same teams within a day), the Maps 1-2 player stats are added as logs for the players already in players.json. Cito logs get a
NEGATIVE numeric mid (-<cito match number>), so they can never collide with a bo3.gg id; update_data.py drops a Cito log as soon as
bo3.gg has the same map (same date +/-1 day, map number, kills and headshots).
Source of the list: /cs2/matches/recent. If that returns nothing, the log prints what came back, and up to MAX_TEAM_LOOKUPS teams that
still have unsettled started props are read from /cs2/teams/{slug}/results (40 credits each). Never fails the job."""
import json, os, re, sys, time, datetime
import cito_api
import cito_players as CP

LOOKBACK_DAYS = 3
MAX_MATCHES = 40          # matches read per run (about 9 credits each)
MAX_TEAM_LOOKUPS = 6
MAX_SECONDS = 600
DONE = ("completed", "finished", "done", "ended", "final")


def _jload(p, d):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return d


def held_keys(players):
    from grader import tn
    H = set()
    for e in players:
        t = tn(re.sub(r"\.gg\b", "", str(e.get("team") or ""), flags=re.I))
        for l in e.get("logs") or []:
            if l.get("date") and l.get("opp"):
                H.add((l["date"][:10], t, tn(re.sub(r"\.gg\b", "", str(l["opp"]), flags=re.I))))
    return H


def is_held(H, date, a, b):
    d0 = datetime.date.fromisoformat(date)
    for off in (0, -1, 1):
        d = (d0 + datetime.timedelta(days=off)).isoformat()
        if (d, a, b) in H or (d, b, a) in H:
            return True
    return False


def unsettled_teams(now):
    """Teams of started props with no result yet (from lines_history.json), most props first."""
    c = {}
    for e in (_jload("lines_history.json", {}) or {}).get("entries") or []:
        try:
            st = datetime.datetime.fromisoformat(str(e.get("start")).replace("Z", "+00:00"))
        except Exception:
            continue
        if st < now and not e.get("result") and (now - st).days < 5:
            for t in (e.get("team"), e.get("opponent")):
                if t:
                    c[t] = c.get(t, 0) + 1
    return [t for t, _ in sorted(c.items(), key=lambda x: -x[1])]


def run(now=None):
    if not cito_api.have_key():
        print("cito results: no CITO_API_KEY, skipped")
        return 0
    from grader import load_players, save_players, tn
    now = now or datetime.datetime.now(datetime.timezone.utc)
    cutoff = (now.date() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    data = load_players("players.json")
    players = data["players"]
    by_team = {}
    for e in players:
        by_team.setdefault(CP._key(e.get("team")), []).append(e)
    H = held_keys(players)
    t0 = time.time()

    cands, seen = [], set()

    def take(rows, src):
        n = 0
        for r in rows:
            mid, dt = r.get("id"), str(r.get("startsAt") or "")[:10]
            if not mid or mid in seen or dt < cutoff or str(r.get("status")).lower() not in DONE:
                continue
            seen.add(mid)
            cands.append((mid, dt, r.get("team1Name"), r.get("team2Name")))
            n += 1
        return n

    try:
        body = cito_api.get("/cs2/matches/recent", {"limit": 100})
        rows = cito_api.rows(body, "matches", "results", "items")
        n = take(rows, "recent")
        print("cito results: /matches/recent gave %d rows, %d finished in the last %d days" % (len(rows), n, LOOKBACK_DAYS))
        if not rows:
            dd = body.get("data") if isinstance(body, dict) else None
            print("  empty answer; data is %s%s | meta %s" % (type(dd).__name__, (" keys " + str(list(dd)[:8])) if isinstance(dd, dict) else "",
                  json.dumps(body.get("meta"))[:200] if isinstance(body, dict) else ""))
        elif not n:
            print("  statuses seen:", sorted({str(r.get("status")) for r in rows})[:8], "| newest:", max(str(r.get("startsAt")) for r in rows)[:16])
    except Exception as ex:
        print("cito results: recent failed:", ex)

    # matches the recent list did not show: read the teams that still have unsettled props
    need = []
    covered = {(tn(re.sub(r"\.gg\b", "", str(a), flags=re.I)), tn(re.sub(r"\.gg\b", "", str(b), flags=re.I))) for _, _, a, b in cands}
    for t in unsettled_teams(now):
        k = tn(re.sub(r"\.gg\b", "", t, flags=re.I))
        if not any(k in pair for pair in covered) and k in {tn(x) for x in by_team} | set(by_team):
            need.append(t)
    store = {}
    for t in need[:MAX_TEAM_LOOKUPS]:
        slug = CP.find_slug(t, store)
        if not slug:
            continue
        try:
            rows = cito_api.rows(cito_api.get("/cs2/teams/%s/results" % slug, {"limit": 20}))
        except Exception as ex:
            print("  %s: results failed: %s" % (t, ex))
            continue
        print("  team fallback %s: %d rows, %d new finished" % (t, len(rows), take(rows, "team")))

    added = new_matches = 0
    for mid, dt, a, b in cands:
        if new_matches >= MAX_MATCHES or time.time() - t0 > MAX_SECONDS:
            print("  limit reached, the rest waits for the next run")
            break
        ka, kb = CP._key(a), CP._key(b)
        if ka not in by_team and kb not in by_team:
            continue
        if is_held(H, dt, tn(re.sub(r"\.gg\b", "", str(a), flags=re.I)), tn(re.sub(r"\.gg\b", "", str(b), flags=re.I))):
            continue
        try:
            rows = CP.cito_logs(mid, dt)
        except Exception as ex:
            print("  match %s failed: %s" % (mid, ex))
            continue
        new_matches += 1
        got = 0
        for r in rows:
            pool = by_team.get(CP._key(r["team"])) or []
            ent = next((e for e in pool if CP._same_player(e["name"], r["name"])), None)
            if not ent:
                continue
            lg = dict(r["log"], mid=-int(re.sub(r"\D", "", str(r["log"]["mid"])) or 0))
            if any(l.get("mid") == lg["mid"] and l.get("n") == lg["n"] for l in ent["logs"]):
                continue
            ent["logs"].insert(0, lg)
            got += 1
        added += got
        print("  %s vs %s (%s): %d logs added, %d players not in players.json" % (a, b, dt, got, sum(1 for r in rows if not any(CP._same_player(e["name"], r["name"]) for e in by_team.get(CP._key(r["team"])) or []))))
    print("cito results: %d matches read, %d player logs added, %s credits left" % (new_matches, added, cito_api.STATS.get("left")))
    if added:
        for e in players:
            e["logs"] = sorted(e["logs"], key=lambda l: l.get("date") or "", reverse=True)
        data["results_updated"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        save_players(data, "players.json")
        print("players.json updated")
    return added


if __name__ == "__main__":
    try:
        run()
    except Exception as ex:
        print("cito results skipped:", ex)
