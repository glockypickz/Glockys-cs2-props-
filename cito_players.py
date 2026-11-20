"""Cito fallback for players bo3.gg has no stats for -> players_cito.json.

Players with a line on the board (lines.json) that the grader cannot find in players.json (name + team) are looked up on Cito:
the team's finished matches this season (/teams/{slug}/results), then each match's Map 1-2 player stats. Only the wanted players'
logs are kept. players_cito.json only grows; the grader reads it for players it can't find in players.json and never mixes the two.

Credits: team lookup by name 0, team results 40, each match about 5-9. Guards: a team's results are re-read at most every
RESCAN_H hours (or sooner when a new player on that team is wanted); matches not yet read wait in a per-team backlog, so
they cost no extra results call; one run stops after MAX_SECONDS and carries on next run. Never fails the job."""
import json, os, re, sys, time, datetime
import cito_api

OUT = "players_cito.json"
SEASON_START = os.environ.get("SEASON_START") or "%d-01-01" % datetime.date.today().year
RESCAN_H = 20          # hours between reads of one team's results
RETRY_DAYS = 3         # a player not found on Cito is tried again after this many days
MAX_PER_RUN = 25       # matches read per team per run
MAX_SECONDS = 240      # stop reading after this long (the lines job has a 10 minute limit)
MAX_MATCHES = 60       # newest season matches kept per team


def _jload(p, d):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return d


def wanted(lines):
    """[(player, team)] from the board. Combos 'A+B' are split; teams are paired by position when the counts match."""
    out = set()
    for l in lines:
        names = [x.strip() for x in str(l.get("player", "")).split("+") if x.strip()]
        teams = [x.strip() for x in re.split(r"\s*[/+]\s*", str(l.get("team", ""))) if x.strip()]
        for i, n in enumerate(names):
            t = teams[i] if len(teams) == len(names) else (teams[0] if len(teams) == 1 else "")
            if t:
                out.add((n, t))
    return sorted(out)


def missing(gr, pairs):
    """Wanted players the grader can't find in players.json (name + team)."""
    return [(n, t) for n, t in pairs if gr.find(n, t) is None]


def _key(s):
    from grader import tn
    k = tn(re.sub(r"\.gg\b", "", str(s or ""), flags=re.I))
    return k


def find_slug(team, cache):
    ck = _key(team)
    if ck in cache:
        return cache[ck]
    slug = None
    try:
        for r in cito_api.rows(cito_api.get("/cs2/autocomplete", {"q": re.sub(r"\.gg\b", "", team, flags=re.I).strip()})):
            if _key(r.get("name")) == ck and r.get("slug"):
                slug = r["slug"]
                cache["name:" + slug] = r.get("name")
                break
    except Exception as e:
        print("  team lookup failed for %s: %s" % (team, e))
        return None          # not cached: try again next run
    cache[ck] = slug
    return slug


def _same_player(a, b):
    from grader import canon, norm
    if norm(a) == norm(b) or canon(a) == canon(b):
        return True
    c, d = canon(a), canon(b)
    sh, lo = (c, d) if len(c) < len(d) else (d, c)
    return len(sh) >= 4 and sh in lo


def cito_logs(mid, date):
    import h2h_fetch
    return h2h_fetch.cito_logs(mid, date)


def run(now=None, lines_path="lines.json", players_path="players.json"):
    if not cito_api.have_key():
        print("cito players: no CITO_API_KEY, skipped")
        return
    from grader import Grader, load_players
    now = now or datetime.datetime.utcnow()
    today = now.date().isoformat()
    lines = (_jload(lines_path, {}) or {}).get("lines") or []
    d = load_players(players_path)
    gr = Grader(d.get("players", []), d.get("ranks") or {})
    miss = missing(gr, wanted(lines))
    store = _jload(OUT, {})
    store.setdefault("teams", {}); store.setdefault("slugs", {}); store.setdefault("tried", {}); store.setdefault("players", [])
    print("cito players: %d wanted on the board, %d not in players.json" % (len(wanted(lines)), len(miss)))
    t0 = time.time()
    by_team = {}
    for n, t in miss:
        by_team.setdefault(t, []).append(n)
    got_new = 0
    for team, names in by_team.items():
        from grader import canon
        tk = "%s" % _key(team)
        stt = store["teams"].setdefault(tk, {"name": team, "mids": [], "pending": [], "scanned": ""})
        fresh = [n for n in names if not store["tried"].get("%s|%s" % (canon(n), tk))]
        age_ok = False
        if stt["scanned"]:
            try:
                age_ok = (now - datetime.datetime.fromisoformat(stt["scanned"])).total_seconds() < RESCAN_H * 3600
            except Exception:
                pass
        retry = [n for n in names if store["tried"].get("%s|%s" % (canon(n), tk), "") and
                 (now.date() - datetime.date.fromisoformat(store["tried"]["%s|%s" % (canon(n), tk)])).days >= RETRY_DAYS]
        if not fresh and not retry and not stt["pending"] and age_ok:
            continue
        if time.time() - t0 > MAX_SECONDS:
            print("  out of time, the rest waits for the next run")
            break
        slug = find_slug(team, store["slugs"])
        if not slug:
            print("  %s: team not found on Cito (%s)" % (team, ", ".join(names)))
            for n in names:
                store["tried"]["%s|%s" % (canon(n), tk)] = today
            continue
        if fresh or retry or not age_ok:
            try:
                res = cito_api.rows(cito_api.get("/cs2/teams/%s/results" % slug, {"limit": 100}))
            except Exception as e:
                print("  %s: results failed: %s" % (team, e))
                continue
            known = set(stt["mids"]) | {m for m, _ in stt["pending"]}
            for r in res:
                dt = str(r.get("startsAt") or "")[:10]
                if str(r.get("status")).lower() not in ("completed", "finished", "done", "ended") or not r.get("id") or dt < SEASON_START:
                    continue
                if r["id"] not in known:
                    stt["pending"].append([r["id"], dt])
            stt["pending"].sort(key=lambda x: x[1], reverse=True)
            stt["pending"] = stt["pending"][:MAX_MATCHES]
            stt["scanned"] = now.isoformat(timespec="seconds")
        seen_names = set()
        tkeys = {_key(team), _key(store["slugs"].get("name:" + slug))} - {""}
        done = 0
        while stt["pending"] and done < MAX_PER_RUN and time.time() - t0 <= MAX_SECONDS:
            mid, dt = stt["pending"].pop(0)
            try:
                rows = cito_logs(mid, dt)
            except Exception as e:
                print("  %s: match %s failed: %s" % (team, mid, e))
                stt["pending"].append([mid, dt])
                break
            stt["mids"].append(mid)
            done += 1
            for r in rows:
                seen_names.add(r["name"])
                r["log"] = dict(r["log"], mid=-int(re.sub(r"\D", "", str(r["log"]["mid"])) or 0))   # numeric and negative: never collides with a bo3.gg id
                for n in names:
                    if _same_player(n, r["name"]) and _key(r["team"]) in tkeys:
                        ent = next((p for p in store["players"] if p["name"] == n and _key(p["team"]) == tk), None)
                        if not ent:
                            ent = {"name": n, "team": team, "src": "cito", "logs": []}
                            store["players"].append(ent)
                        if not any(l["mid"] == r["log"]["mid"] and l["n"] == r["log"]["n"] for l in ent["logs"]):
                            ent["logs"].append(r["log"])
                            got_new += 1
        for p in store["players"]:
            if _key(p["team"]) == tk:
                p["logs"].sort(key=lambda l: (l["date"], l["mid"], -(l["n"] or 0)), reverse=True)
        have = {p["name"] for p in store["players"] if _key(p["team"]) == tk and p["logs"]}
        for n in names:
            if n in have or not stt["pending"]:
                store["tried"]["%s|%s" % (canon(n), tk)] = today
        left = [n for n in names if n not in have]
        print("  %s (%s): read %d matches, %d left | found: %s | not on Cito yet: %s%s" % (
            team, slug, done, len(stt["pending"]), sorted(have & set(names)), left,
            (" | Cito names seen: %s" % sorted(seen_names)) if left and seen_names else ""))
    store["updated"] = now.isoformat(timespec="seconds")
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(store, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, OUT)
    print("players_cito.json: %d players, %d new map rows this run, %s credits left" % (
        len([p for p in store["players"] if p["logs"]]), got_new, cito_api.STATS.get("left")))


if __name__ == "__main__":
    try:
        run()
    except Exception as ex:
        print("cito players skipped:", ex)
