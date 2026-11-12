"""One-time test: ask KashRock for CS2 props WITHOUT a market filter and print what comes back.

Writes nothing. Never prints the API key.
"""
import json, os, sys, urllib.request, urllib.error, urllib.parse
from collections import Counter

BASE = os.environ.get("KASHROCK_BASE_URL", "https://kashrock.up.railway.app").rstrip("/")
KEY = os.environ.get("KASHROCK_API_KEY", "")


def clean(text):
    return text.replace(KEY, "***") if KEY else text


def fetch(path, params):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"X-API-Key": KEY, "Accept": "application/json",
                                               "User-Agent": "glockys-prop-grader"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:500]
    except Exception as e:
        return 0, str(e)


def show(title, params):
    print("\n=== " + title + " " + json.dumps(params))
    code, d = fetch("/v7/cs2/props", params)
    print("HTTP", code)
    if not isinstance(d, dict):
        print(clean(str(d)))
        return
    print("top-level keys:", list(d.keys()))
    for k in ("available", "reason", "fetched_at", "count", "total"):
        if k in d:
            print(f"{k}:", d[k])
    rows = d.get("props") or []
    print("rows:", len(rows))
    if rows:
        print("fields in a row:", list(rows[0].keys()))
        for field in ("market", "market_key", "stat", "stat_type", "prop_type", "book_name", "direction"):
            if field in rows[0]:
                print(f"distinct {field}:", dict(Counter(str(r.get(field)) for r in rows)))
        print("sample rows:")
        for r in rows[:3]:
            print(clean(json.dumps(r)[:600]))


def main():
    if not KEY:
        sys.exit("KASHROCK_API_KEY is not set")
    code, meta = fetch("/v7/meta", {})
    print("meta HTTP", code)
    print(clean(json.dumps(meta)[:3500]))

    show("prizepicks, no market", {"board": "dfs", "book": "prizepicks", "limit": 100})
    show("underdog, no market", {"board": "dfs", "book": "underdog", "limit": 100})
    show("no book, no market", {"board": "dfs", "limit": 100})
    show("nothing but limit", {"limit": 100})
    show("prizepicks, kills market", {"board": "dfs", "book": "prizepicks", "market": "CS2_KILLS_MAPS_1_2", "limit": 20})
    show("prizepicks, plain kills", {"board": "dfs", "book": "prizepicks", "market": "CS2_KILLS", "limit": 20})

    for path in ("/v7/markets", "/v7/cs2/markets", "/v7/sports", "/v7/cs2"):
        c, d = fetch(path, {})
        print(f"\n=== {path} -> HTTP {c}")
        print(clean(json.dumps(d)[:1500]))


if __name__ == "__main__":
    main()
