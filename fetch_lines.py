"""Fetch CS2 Maps 1-2 kills/headshots lines (PrizePicks + Underdog) from the KashRock API -> lines.json.

KashRock returns props as `groups` (one per player + market). Each group has a `dfs` list of
offers (book, line, odds, over/under, alt-line flag). We keep the main OVER offer per book.

Needs the KASHROCK_API_KEY secret. Never prints or stores the key.
If anything fails, the old lines.json is left untouched.
"""
import json, os, sys, time, datetime, urllib.request, urllib.error, urllib.parse

BASE = os.environ.get("KASHROCK_BASE_URL", "https://kashrock.up.railway.app").rstrip("/")
KEY = os.environ.get("KASHROCK_API_KEY", "")
BOOKS = ["prizepicks", "underdog"]
MARKETS = {"CS2_KILLS_MAPS_1_2": "Kills", "CS2_HEADSHOTS_MAPS_1_2": "Headshots"}
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
KEEP_DAYS = 90


def parse_time(t):
    try:
        return datetime.datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except Exception:
        return None


def update_history(lines, now_iso):
    """Remember every line we saw, per book/player/stat/match. The line keeps updating until the match starts,
    so the saved number is the closing line. first_line is the first number we ever saw."""
    try:
        old = json.load(open(HISTORY_FILE, encoding="utf-8")).get("entries", [])
    except Exception:
        old = []
    now = parse_time(now_iso)
    by = {(e["book"], e["player"], e["stat"], e["start"]): e for e in old}
    for l in lines:
        start = l.get("starts_at") or ""
        if not start:
            continue
        k = (l["book"], l["player"], l["stat"], start)
        t0 = parse_time(start)
        e = by.get(k)
        if e is None:
            by[k] = {"book": l["book"], "player": l["player"], "team": l.get("team", ""),
                     "opponent": l.get("opponent", ""), "stat": l["stat"], "start": start,
                     "line": l["line"], "first_line": l["line"], "first_seen": now_iso, "last_seen": now_iso}
        elif t0 is None or now is None or now < t0:
            e["line"] = l["line"]
            e["last_seen"] = now_iso
    cutoff = (now - datetime.timedelta(days=KEEP_DAYS)) if now else None
    keep = []
    for e in by.values():
        t0 = parse_time(e["start"])
        if cutoff and t0 and t0 < cutoff:
            continue
        keep.append(e)
    keep.sort(key=lambda e: e["start"])
    json.dump({"updated": now_iso, "entries": keep}, open(HISTORY_FILE, "w", encoding="utf-8"),
              separators=(",", ":"), ensure_ascii=False)
    print("lines_history.json:", len(keep), "entries")


def main():
    if not KEY:
        sys.exit("KASHROCK_API_KEY is not set, keeping the old lines.json")
    seen, lines, fetched = set(), [], None
    for book in BOOKS:
        for market, stat in MARKETS.items():
            offset, kept = 0, 0
            for _ in range(MAX_PAGES):
                d = fetch("/v7/cs2/props", {"board": "dfs", "book": book, "market": market,
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
                        "period": "Maps 1-2",
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
    if not lines:
        sys.exit("No CS2 lines returned (board may be empty). Keeping the old lines.json")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    out = {"observed_at": fetched or now, "fetched_by_job_at": now, "source": "kashrock", "lines": lines}
    json.dump(out, open("lines.json", "w"), separators=(",", ":"), ensure_ascii=False)
    print("wrote lines.json:", len(lines), "lines")
    try:
        update_history(lines, now)
    except Exception as e:
        print("history update failed (lines.json is fine):", e)


if __name__ == "__main__":
    main()
