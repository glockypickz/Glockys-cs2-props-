"""Fetch CS2 Maps 1-2 and Map 1 kills/headshots lines (PrizePicks + Underdog) from the KashRock API -> lines.json.

KashRock returns props as `groups` (one per player + market). Each group has a `dfs` list of
offers (book, line, odds, over/under, alt-line flag). We keep the main OVER offer per book.

Needs the KASHROCK_API_KEY secret. Never prints or stores the key.

When KashRock returns successfully but the board is empty (zero props across
every market, or every returned prop is for a match that has already started),
lines.json is replaced with an empty board: fetched_at / fetched_by_job_at,
status "no_lines_up", and lines: []. Exit 0. lines_history.json, locked
grades, and settlement are not touched.

When a fetch fails (missing key, HTTP error, or any exception), the previous
lines.json is kept and marked stale (stale, stale_at, stale_reason). Exit 1.
"""
import json, os, sys, time, datetime, urllib.request, urllib.error, urllib.parse

BASE = os.environ.get("KASHROCK_BASE_URL", "https://kashrock.up.railway.app").rstrip("/")
KEY = os.environ.get("KASHROCK_API_KEY", "")
BOOKS = ["prizepicks", "underdog"]
MARKETS = {
    "CS2_KILLS_MAPS_1_2": ("Kills", "Maps 1-2"),
    "CS2_HEADSHOTS_MAPS_1_2": ("Headshots", "Maps 1-2"),
    "CS2_KILLS_MAP_1": ("Kills", "Map 1"),
    "CS2_HEADSHOTS_MAP_1": ("Headshots", "Map 1"),
}
PAGE = 100          # groups per request
MAX_PAGES = 20


def fetch(path, params):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"X-API-Key": KEY, "Accept": "application/json",
                                               "User-Agent": "glockys-prop-grader"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300].replace(KEY, "***")
            if e.code == 429 and attempt < 3:
                time.sleep(10 * (attempt + 1))
                continue
            raise RuntimeError(f"HTTP {e.code} on {path}: {body}")
    raise RuntimeError("rate limited: " + path)


def pick_offer(group, market):
    """Best main over-offer in a group for this market, or None."""
    best = None
    for o in group.get("dfs") or []:
        if str(o.get("direction", "over")).lower() == "under":
            continue
        if o.get("is_alt_line"):
            continue
        st = o.get("stat_type") or group.get("stat_type")
        if st and st != market:
            continue
        try:
            float(o["line"])
        except (KeyError, TypeError, ValueError):
            continue
        if best is None:
            best = o
    return best


HISTORY_FILE = "lines_history.json"
KEEP_DAYS = 365        # picks with a locked grade are the track record: kept a full year
KEEP_OTHER_DAYS = 30   # lines that never got a lock are dropped sooner to keep the file small


def parse_time(t):
    try:
        return datetime.datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except Exception:
        return None


def load_grader():
    """Grader built from players.json, so each pick can be locked in. Returns None if it can't be built."""
    try:
        from grader import Grader, load_strength, load_players, merge_cito
        global STATS_STAMP
        d = load_players("players.json")
        STATS_STAMP = str(d.get("updated") or "")
        pl, nc = merge_cito(d.get("players", []))   # players bo3.gg lacks, filled in from Cito (players_cito.json)
        if nc:
            print("cito fallback players in the grader:", nc)
        return Grader(pl, d.get("ranks") or {}, strength=load_strength())  # team_strength.json: file read, no Cito call
    except Exception as e:
        print("grader not available, picks are not locked this run:", e)
        return None


_MO = None


def _tk(s):
    k = "".join(ch for ch in str(s or "").lower() if ch.isalnum())
    for w in ("team", "esports", "gaming", "club"):
        k = k.replace(w, "")
    return k


def _same(a, b):
    try:   # team-name aliases from the grader (e.g. "BET-M 33" and "33" are the same team)
        from grader import tn
        if tn(a) and tn(a) == tn(b):
            return True
    except Exception:
        pass
    a, b = _tk(a), _tk(b)
    return bool(a and b and (a == b or (len(a) >= 4 and len(b) >= 4 and (a in b or b in a))))


def match_odds_for(e):
    """Match-winner odds for this line's match from team_strength.json (written by cito_update.py; a file read, no API call),
    oriented to the pick's own team: p = [this team wins, opponent wins]. None if the match has no odds saved.
    Recorded with the lock so we can later test whether lopsided matches run short. Display only: the grader never reads it."""
    global _MO
    if _MO is None:
        try:
            _MO = json.load(open("team_strength.json", encoding="utf-8")).get("odds") or []
        except Exception:
            _MO = []
        try:   # Cito odds refreshed by cito_odds.py every run: read first so locks get the newest price
            _MO = (json.load(open("cito_odds.json", encoding="utf-8")).get("rows") or []) + list(_MO)
        except Exception:
            pass
    for r in _MO:
        if not (r.get("p") and r.get("dec") is not None):
            continue
        for flip, (a, b) in ((False, (r.get("n1"), r.get("n2"))), (True, (r.get("n2"), r.get("n1")))):
            if _same(a, e.get("team")) and _same(b, e.get("opponent")):
                p, dec = list(r["p"]), list(r["dec"])
                if flip:
                    p, dec = p[::-1], dec[::-1]
                mo = {"p": p, "dec": dec, "src": r.get("src"), "at": r.get("at")}
                for k in ("map1", "map2"):
                    if r.get(k):
                        mo[k] = list(r[k])[::-1] if flip else list(r[k])
                return mo
    return None


def _lock_model_of(e):
    return (e.get("lock") or {}).get("model")


def needs_regrade(e):
    """Unstarted, unsettled locks whose stored grade is on an older model or an older REGRADE_TAG.
    Started and settled locks are never regraded. REGRADE_TAG itself is not bumped for a model change."""
    if e.get("result") or not e.get("lock"):
        return False
    lock = e["lock"]
    if lock.get("rg") != REGRADE_TAG:
        return True
    try:
        from grader import MODEL_VERSION
        return lock.get("model") != MODEL_VERSION
    except Exception:
        return False


def try_lock(gr, e, now, t0):
    """Save the app's grade, projection, pick and probability for this line, once, before the match starts."""
    if t0 and now and now >= t0:
        return
    if e.get("lock"):
        if gr is not None and needs_regrade(e):
            _lock(gr, e, now, regrade=True)   # unstarted only (started already returned above); the new grade replaces the old one
            if not needs_regrade(e):
                return
        # already locked: add the match odds if they were missing at lock time (still before the match, grade untouched)
        if "mo" not in e["lock"]:
            mo = match_odds_for(e)
            if mo:
                e["lock"]["mo"] = mo
        return
    if gr is None:
        return
    _lock(gr, e, now)


REGRADE_TAG = "h2h-2"   # bump to regrade every not-yet-started prop once more (the grader changed); started props are never touched


def _lock(gr, e, now, regrade=False):
    try:
        st = "hs" if "head" in e["stat"].lower() else "kills" if "kill" in e["stat"].lower() else None
        if not st:
            return
        # LAN data (grader.py lan_data): match type from games.json "ev", else the 3-day rule. New locks only; REGRADE_TAG is
        # NOT bumped, so props that are already locked keep their grade.
        ev, ev_src = gr.match_ev(e.get("team"), e.get("opponent") or "", e.get("start"))
        before = str(e.get("start") or "")[:10] or "9999"
        maps = gr.confirmed_maps(e.get("team"), e.get("opponent") or "", e.get("start"))
        if "+" in e["player"]:
            g = gr.grade_combo(e["player"], e.get("team"), st, float(e["line"]), e.get("opponent") or "", e.get("book"), e.get("odds"), before=before, period=e.get("period"), ev=ev, maps=maps)
        else:
            p = gr.find(e["player"], e.get("team"))
            if not p:
                return
            g = gr.grade(p, st, float(e["line"]), e.get("opponent") or "", e.get("team"), e.get("book"), e.get("odds"), before=before, period=e.get("period"), ev=ev, maps=maps)
        if g:
            o = e["lock"] if regrade else None
            e["lock"] = {"line": float(e["line"]), "proj": g["proj"], "grade": g["grade"], "pick": g["pick"],
                         "p_over": g["p_over"], "p_pick": g["p_pick"], "be": g["be"], "edge_pp": g["edge_pp"],
                         "reasons": g["reasons"], "flag": g.get("flag", ""), "model": g["model"], "odds": e.get("odds"),
                         "hits": g.get("hits"),   # [over, series] vs this line: l5 / l10 / l20 / szn / h2h (single props only)
                         "stake": g.get("stake"),
                         "at": now.isoformat(timespec="seconds"), "stats_updated": STATS_STAMP}
            cap = g.get("grade_cap") or {}
            if cap.get("applied"):
                e["lock"]["cap"] = cap.get("reason")
                e["lock"]["pre_grade"] = cap.get("pre_grade")
            if ev:
                e["lock"]["ev"] = ev   # match type the grade used: "lan" = LAN data inputs (when lan_data is on)
                e["lock"]["ev_src"] = ev_src
            if maps:
                e["lock"]["maps"] = maps
            mb = (g.get("v1") or {}).get("map") if isinstance(g.get("v1"), dict) else None
            if mb and mb.get("used"):
                e["lock"]["map_src"] = mb.get("src")
            if regrade:
                e["lock"]["rg"] = REGRADE_TAG   # marks "regraded once"; the old grade is not kept
            mo = match_odds_for(e) or (o.get("mo") if regrade else None)
            if mo:
                e["lock"]["mo"] = mo
    except Exception as ex:
        print("lock failed for", e.get("player"), ex)


STATS_STAMP = ""


MOVE_HOURS = 12   # a start-time change within this window is the same match, not a new one


def _key_txt(s):
    return "".join(ch for ch in str(s or "").lower() if ch.isalnum())


def moved_entry(by, l, t0):
    """The existing history entry for this book / player / stat / team / opponent whose match start moved or is the same
    time written differently (start differs by at most MOVE_HOURS and that entry is not settled yet), or None. Keeps one entry per match when a book reschedules."""
    if t0 is None:
        return None
    best = None
    for e in by.values():
        if (e["book"], e["player"], e["stat"]) != (l["book"], l["player"], l["stat"]) or e.get("result"):
            continue
        try:
            from grader import period_of
            if period_of(e) != period_of(l):
                continue
        except Exception:
            pass
        if _key_txt(e.get("team")) != _key_txt(l.get("team")) or _key_txt(e.get("opponent")) != _key_txt(l.get("opponent")):
            continue
        t1 = parse_time(e.get("start"))
        if t1 is None:   # compared as times, so "...00.000Z" and "...00Z" are the same start
            continue
        d = abs((t1 - t0).total_seconds())
        if d <= MOVE_HOURS * 3600 and (best is None or d < best[0]):
            best = (d, e)
    return best[1] if best else None


def update_history(lines, now_iso):
    """Remember every line we saw, per book/player/stat/match (PrizePicks and Underdog are separate entries).
    line / odds keep updating until the match starts, so they are the closing line and odds; first_line /
    first_odds are the first we saw. Finished lines are then settled (hit / miss / push / void, see settle.py)."""
    try:
        old = json.load(open(HISTORY_FILE, encoding="utf-8")).get("entries", [])
    except Exception:
        old = []
    now = parse_time(now_iso)
    gr = load_grader()
    try:   # fresh Cito match-winner odds (Pro), before the locks so they get saved with them
        import cito_odds
        global _MO
        cito_odds.refresh(now)
        _MO = None
    except Exception as ex:
        print("cito odds skipped:", ex)
    try:
        from grader import hist_key, period_of
    except Exception:
        hist_key = lambda e, start=None: (e["book"], e["player"], e["stat"], start if start is not None else e.get("start") or "", "Maps 1-2")
        period_of = lambda e, default="Maps 1-2": (e.get("period") if isinstance(e, dict) else e) or default
    by = {hist_key(e): e for e in old}
    for l in lines:
        start = l.get("starts_at") or ""
        if not start:
            continue
        k = hist_key(l, start)
        t0 = parse_time(start)
        e = by.get(k)
        if e is None:
            e = moved_entry(by, l, t0)
            if e is not None:   # same match, new start time: move the existing entry (its lock / grade are never touched)
                by.pop(hist_key(e), None)
                e["start"] = start
                by[k] = e
        if e is None:
            by[k] = {"book": l["book"], "player": l["player"], "team": l.get("team", ""),
                     "opponent": l.get("opponent", ""), "stat": l["stat"], "period": period_of(l), "start": start,
                     "line": l["line"], "first_line": l["line"], "odds": l.get("odds"), "first_odds": l.get("odds"),
                     "first_seen": now_iso, "last_seen": now_iso}
        elif t0 is None or now is None or now < t0:
            e["line"] = l["line"]
            e["odds"] = l.get("odds")
            e.setdefault("first_odds", None)
            e["last_seen"] = now_iso
        try_lock(gr, by[k], now, t0)
        try:
            import shadow
            shadow.apply(gr, by[k], now, t0)   # admin-only second grade, upcoming props only
        except Exception as ex:
            print("shadow skipped:", ex)
    print("locked picks:", sum(1 for e in by.values() if e.get("lock")), "of", len(by))
    try:
        from settle import settle_all
        settle_all(gr, list(by.values()), now)
    except Exception as ex:
        print("settling failed (history is still saved):", ex)
    cutoff = (now - datetime.timedelta(days=KEEP_DAYS)) if now else None
    cut2 = (now - datetime.timedelta(days=KEEP_OTHER_DAYS)) if now else None
    keep = []
    for e in by.values():
        t0 = parse_time(e["start"])
        if cutoff and t0 and t0 < cutoff:
            continue
        if cut2 and t0 and t0 < cut2 and not e.get("lock"):
            continue
        keep.append(e)
    keep.sort(key=lambda e: e["start"])
    json.dump({"updated": now_iso, "entries": keep}, open(HISTORY_FILE, "w", encoding="utf-8"),
              separators=(",", ":"), ensure_ascii=False)
    print("lines_history.json:", len(keep), "entries")
    try:
        write_pregame(keep, now)
    except Exception as ex:
        print("pregame.json not written:", ex)


PREGAME_FILE = "pregame.json"
PREGAME_DAYS = 2


def write_pregame(entries, now):
    """Public, small: for props whose match has started (last PREGAME_DAYS days), the pre-game line (the last line seen
    before the start), the opening line, and the locked letter + pick. lines_history.json itself stays admin-only."""
    if now is None:
        return
    lo = now - datetime.timedelta(days=PREGAME_DAYS)
    out = []
    for e in entries:
        t0 = parse_time(e.get("start"))
        if t0 is None or not (lo <= t0 <= now):
            continue
        lk = e.get("lock") or {}
        row = {"book": e["book"], "player": e["player"], "team": e.get("team", ""), "opponent": e.get("opponent", ""),
               "stat": e["stat"], "start": e["start"], "line": e["line"], "first_line": e.get("first_line"),
               "odds": e.get("odds"),
               "lock": ({"grade": lk["grade"], "pick": lk.get("pick"), "model": lk.get("model")} if lk.get("grade") else None)}
        if e.get("period"):
            row["period"] = e["period"]
        out.append(row)
    json.dump({"updated": now.isoformat(timespec="seconds"), "entries": out}, open(PREGAME_FILE, "w", encoding="utf-8"),
              separators=(",", ":"), ensure_ascii=False)
    print(PREGAME_FILE + ":", len(out), "started props")


LINES_FILE = "lines.json"


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def iso_utc(dt):
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc).isoformat(timespec="seconds")


def is_upcoming(line, now=None):
    """True if this prop's match has not started yet. Lines with no start stay (the UI has a safety net)."""
    t0 = parse_time((line or {}).get("starts_at") or "")
    if t0 is None:
        return True
    now = now or utcnow()
    if t0.tzinfo is None:
        t0 = t0.replace(tzinfo=datetime.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    return now < t0


def upcoming_lines(lines, now=None):
    now = now or utcnow()
    return [l for l in (lines or []) if is_upcoming(l, now)]


def write_board(lines, fetched=None, now=None, path=LINES_FILE, empty=None):
    """Replace lines.json with the current board. empty=True writes the 'no lines up' marker."""
    now_iso = iso_utc(now or utcnow())
    rows = list(lines or [])
    empty = bool(not rows) if empty is None else bool(empty)
    out = {
        "observed_at": fetched or now_iso,
        "fetched_by_job_at": now_iso,
        "fetched_at": now_iso,
        "source": "kashrock",
        "empty": empty,
        "status": "no_lines_up" if empty else "ok",
        "stale": False,
        "lines": [] if empty else rows,
    }
    if empty:
        out["message"] = "no lines up"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    return out


def mark_stale(reason, path=LINES_FILE, now=None):
    """Keep the existing board and flag it stale after a failed pull. Creates a stub if the file is missing."""
    now_iso = iso_utc(now or utcnow())
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {"source": "kashrock", "lines": []}
    except Exception:
        data = {"source": "kashrock", "lines": []}
    data["stale"] = True
    data["stale_at"] = now_iso
    data["stale_reason"] = str(reason)[:500]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    return data


def collect_lines(fetch_fn=None):
    """Pull every market. Raises on HTTP / network failure. Returns (lines, fetched_at)."""
    fetch_fn = fetch_fn or fetch
    seen, lines, fetched = set(), [], None
    for book in BOOKS:
        for market, (stat, period) in MARKETS.items():
            offset, kept = 0, 0
            for _ in range(MAX_PAGES):
                d = fetch_fn("/v7/cs2/props", {"board": "dfs", "book": book, "market": market,
                                              "limit": PAGE, "offset": offset})
                if not d.get("available", True):
                    print(f"{book} {market}: not available ({d.get('reason')})")
                    break
                fetched = d.get("fetched_at") or fetched
                groups = d.get("groups") or []
                for g in groups:
                    o = pick_offer(g, market)
                    name = g.get("player_name") or (o or {}).get("player_name")
                    if not o or not name:
                        continue
                    line = float(o["line"])
                    k = (book, name, market, line)
                    if k in seen:
                        continue
                    seen.add(k)
                    kept += 1
                    links = o.get("links") or {}
                    lines.append({
                        "player": name,
                        "team": g.get("team") or o.get("team") or "",
                        "opponent": g.get("opponent") or o.get("opponent") or "",
                        "stat": stat,
                        "period": period,
                        "line": line,
                        "odds": o.get("odds"),
                        "starts_at": g.get("start_time") or g.get("event_time") or o.get("event_time") or "",
                        "book": o.get("book_name") or book,
                        "deeplink": o.get("deeplink") or links.get("bet") or "",
                        "image": links.get("player_image") or "",
                    })
                print(f"{book} {market} offset {offset}: {len(groups)} groups, kept {kept} so far")
                if not d.get("has_more") or not groups:
                    break
                offset += len(groups)
    return lines, fetched


def main(lines_path=LINES_FILE, history=True, fetch_fn=None, now=None):
    if not KEY:
        mark_stale("KASHROCK_API_KEY is not set", path=lines_path, now=now)
        sys.exit("KASHROCK_API_KEY is not set, keeping the old lines.json")
    try:
        lines, fetched = collect_lines(fetch_fn)
    except Exception as e:
        mark_stale(e, path=lines_path, now=now)
        sys.exit("fetch failed, keeping the old lines.json (marked stale): " + str(e))
    now = now or utcnow()
    kept = upcoming_lines(lines, now)
    dropped = len(lines) - len(kept)
    if dropped:
        print("dropped", dropped, "props whose match already started or finished")
    if not kept:
        write_board([], fetched=fetched, now=now, path=lines_path, empty=True)
        print("No CS2 lines up right now. Wrote empty lines.json")
        return  # exit 0; do not touch lines_history.json
    write_board(kept, fetched=fetched, now=now, path=lines_path, empty=False)
    print("wrote lines.json:", len(kept), "lines")
    if not history:
        return
    try:
        update_history(kept, iso_utc(now))
    except Exception as e:
        print("history update failed (lines.json is fine):", e)


if __name__ == "__main__":
    main()
