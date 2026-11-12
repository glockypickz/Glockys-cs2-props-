"""Test 2: print what is inside KashRock's `groups` list for CS2 props.

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


def walk(obj, path, found):
    """Collect every string value whose key mentions market/stat/prop/period."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (dict, list)):
                walk(v, path + "." + k, found)
            elif isinstance(v, str) and any(w in k.lower() for w in ("market", "stat", "prop", "period", "map")):
                found[k].append(v)
    elif isinstance(obj, list):
        for v in obj[:50]:
            walk(v, path + "[]", found)


def show(title, params, samples=2):
    print("\n=== " + title + " " + json.dumps(params))
    code, d = fetch("/v7/cs2/props", params)
    print("HTTP", code)
    if not isinstance(d, dict):
        print(clean(str(d)))
        return
    for k in ("view", "slim", "total", "total_groups", "returned", "has_more", "stale_books", "data_sources"):
        print(f"{k}:", clean(json.dumps(d.get(k))[:300]))
    groups = d.get("groups") or []
    print("groups type:", type(groups).__name__, "len:", len(groups))
    items = list(groups.values()) if isinstance(groups, dict) else groups
    if not items:
        return
    first = items[0]
    if isinstance(first, dict):
        print("keys in a group:", list(first.keys()))
        for k, v in first.items():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                print(f"  group['{k}'] is a list of {len(v)}; keys inside:", list(v[0].keys()))
    found = {}
    from collections import defaultdict
    found = defaultdict(list)
    walk(items, "", found)
    for k, vals in found.items():
        print(f"distinct values for '{k}':", dict(Counter(vals).most_common(12)))
    for g in items[:samples]:
        print("--- sample group:")
        print(clean(json.dumps(g)[:2500]))


def main():
    if not KEY:
        sys.exit("KASHROCK_API_KEY is not set")
    show("prizepicks Maps 1-2 kills", {"board": "dfs", "book": "prizepicks", "market": "CS2_KILLS_MAPS_1_2", "limit": 5})
    show("prizepicks Maps 1-2 headshots", {"board": "dfs", "book": "prizepicks", "market": "CS2_HEADSHOTS_MAPS_1_2", "limit": 3}, samples=1)
    show("underdog Maps 1-2 kills", {"board": "dfs", "book": "underdog", "market": "CS2_KILLS_MAPS_1_2", "limit": 3}, samples=1)
    show("prizepicks everything (market names)", {"board": "dfs", "book": "prizepicks", "limit": 100}, samples=0)
    show("prizepicks, slim off", {"board": "dfs", "book": "prizepicks", "market": "CS2_KILLS_MAPS_1_2", "limit": 2, "slim": "false"}, samples=1)


if __name__ == "__main__":
    main()
