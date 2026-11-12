"""Fetch CS2 Maps 1-2 kills/headshots lines (PrizePicks + Underdog) from the KashRock API -> lines.json.

Needs the KASHROCK_API_KEY secret. Never prints or stores the key.
If anything fails, the old lines.json is left untouched.
"""
import json, os, sys, time, datetime, urllib.request, urllib.error, urllib.parse

BASE = os.environ.get("KASHROCK_BASE_URL", "https://kashrock.up.railway.app").rstrip("/")
KEY = os.environ.get("KASHROCK_API_KEY", "")
BOOKS = ["prizepicks", "underdog"]
MARKETS = {"CS2_KILLS_MAPS_1_2": "Kills", "CS2_HEADSHOTS_MAPS_1_2": "Headshots"}
PAGE = 100
MAX_PAGES = 10


def fetch(path, params):
    url = BASE + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"X-API-Key": KEY, "Accept": "application/json",
                                               "User-Agent": "glockys-prop-grader"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            if e.code == 429 and attempt < 3:
                time.sleep(10 * (attempt + 1))
                continue
            raise RuntimeError(f"HTTP {e.code} on {path}: {body}")
    raise RuntimeError("rate limited: " + path)


def main():
    if not KEY:
        sys.exit("KASHROCK_API_KEY is not set, keeping the old lines.json")
    try:
        meta = fetch("/v7/meta", {})
        print("meta ok, plan:", (meta.get("plan") if isinstance(meta, dict) else None))
    except Exception as e:
        print("meta check failed (continuing):", e)
    seen, lines, fetched = set(), [], None
    for book in BOOKS:
        for market, stat in MARKETS.items():
            offset = 0
            for _ in range(MAX_PAGES):
                d = fetch("/v7/cs2/props", {"board": "dfs", "book": book, "market": market,
                                            "limit": PAGE, "offset": offset})
                if not d.get("available", True):
                    print(f"{book} {market}: not available ({d.get('reason')})")
                    break
                fetched = d.get("fetched_at") or fetched
                rows = d.get("props", [])
                for p in rows:
                    if str(p.get("direction", "over")).lower() == "under":
                        continue  # one line per prop; the over row carries the number
                    try:
                        line = float(p["line"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    k = (book, p.get("player_name"), market, line)
                    if k in seen or not p.get("player_name"):
                        continue
                    seen.add(k)
                    lines.append({"player": p["player_name"], "team": p.get("team", ""), "stat": stat,
                                  "period": "Maps 1-2", "line": line, "opponent": p.get("opponent", ""),
                                  "starts_at": p.get("event_time", ""), "book": p.get("book_name") or book,
                                  "deeplink": p.get("deeplink", "")})
                print(f"{book} {market} offset {offset}: {len(rows)} rows")
                if len(rows) < PAGE:
                    break
                offset += PAGE
    if not lines:
        sys.exit("No CS2 lines returned (board may be empty). Keeping the old lines.json")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    out = {"observed_at": fetched or now, "fetched_by_job_at": now, "source": "kashrock", "lines": lines}
    json.dump(out, open("lines.json", "w"), separators=(",", ":"), ensure_ascii=False)
    print("wrote lines.json:", len(lines), "lines")


if __name__ == "__main__":
    main()
