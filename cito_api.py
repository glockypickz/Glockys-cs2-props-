"""Tiny Cito client for the head-to-head and odds jobs (the daily cito_update.py keeps its own cito_client.py).
Key from the CITO_API_KEY env var, never printed. get() returns the parsed JSON ({success, data, meta}) or raises."""
import os, json, time, urllib.request, urllib.error, urllib.parse

BASE = "https://api.citoapi.com/api/v1"
PAUSE = 0.7          # seconds between calls (about 85 a minute)
_last = [0.0]
STATS = {"calls": 0, "left": None}


def have_key():
    return bool(os.environ.get("CITO_API_KEY"))


def get(path, params=None, tries=3):
    key = os.environ.get("CITO_API_KEY", "")
    if not key:
        raise RuntimeError("CITO_API_KEY is not set")
    q = urllib.parse.urlencode(params or {})
    req = urllib.request.Request(BASE + path + ("?" + q if q else ""),
                                 headers={"x-api-key": key, "Accept": "application/json", "User-Agent": "glockys-prop-grader"})
    for attempt in range(tries):
        wait = PAUSE - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        STATS["calls"] += 1
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                STATS["left"] = r.headers.get("X-Cito-Credits-Remaining") or STATS["left"]
                return json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:200].replace(key, "***")
            if e.code == 429 and "ARCHIVE" not in body and attempt < tries - 1:
                time.sleep(min(int(e.headers.get("Retry-After") or 15), 60))
                continue
            raise RuntimeError("HTTP %s on %s: %s" % (e.code, path, body))
    raise RuntimeError("rate limited on " + path)


def rows(body, *keys):
    d = body.get("data") if isinstance(body, dict) else None
    if isinstance(d, list):
        return d
    if isinstance(d, dict):
        for k in keys or ("matches", "meetings", "results", "items"):
            if isinstance(d.get(k), list):
                return d[k]
    return []
