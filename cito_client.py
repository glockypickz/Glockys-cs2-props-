"""Cito API client (https://citoapi.com, CS2). Used ONLY by cito_update.py in the daily "Update CS2 data" job.

Key:     CITO_API_KEY environment variable (GitHub secret of the same name, passed only to that one job step;
         locally from a gitignored .env). Sent in the x-api-key header. Never printed, logged or saved.
Cache:   every reply is saved to disk (cito_cache/<hash>.json: path, params, status, ETag, fetched time, body).
         A fresh cached reply is returned without a call; a stale one is revalidated with If-None-Match.
Budget:  at most CITO_DAILY_MAX calls per UTC day (default 14, counted in cito_cache/_usage.json) and never below
         CITO_RESERVE calls left in the month (from the X-RateLimit-Monthly-Remaining header). Free plan: 500/month,
         200/day, 10/minute.
Spacing: CITO_SPACING seconds between calls (default 6.5 s, so under 10 per minute).
Retries: 429 RATE_LIMIT_EXCEEDED -> wait Retry-After, at most 2 retries; 5xx / network errors -> 2 retries with backoff.
         401/403/404 and 429 MONTHLY_LIMIT_REACHED stop at once (no retry). Callers treat any failure as "no Cito data".
Without a key every call is served from the cache only (offline mode), so tests and backtests never touch the network.
"""
import hashlib, json, os, time, datetime, urllib.request, urllib.parse, urllib.error

BASE = os.environ.get("CITO_BASE_URL", "https://api.citoapi.com/api/v1").rstrip("/")
CACHE_DIR = os.environ.get("CITO_CACHE_DIR", "cito_cache")
DAILY_MAX = int(os.environ.get("CITO_DAILY_MAX", "14"))
RESERVE = int(os.environ.get("CITO_RESERVE", "40"))
SPACING = float(os.environ.get("CITO_SPACING", "6.5"))
DAY = 86400


class CitoError(Exception):
    pass


class BudgetExhausted(CitoError):
    pass


def load_dotenv(path=".env"):
    """Tiny .env reader for local runs (KEY=VALUE lines). Does not override variables already set."""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass


def _utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


class Cito:
    def __init__(self, key=None, cache_dir=None, daily_max=None, reserve=None, spacing=None, base=None,
                 offline=None, sleep=time.sleep, clock=time.time, opener=None):
        self.key = os.environ.get("CITO_API_KEY", "") if key is None else key
        self.cache_dir = cache_dir or CACHE_DIR
        self.daily_max = DAILY_MAX if daily_max is None else daily_max
        self.reserve = RESERVE if reserve is None else reserve
        self.spacing = SPACING if spacing is None else spacing
        self.base = (base or BASE).rstrip("/")
        self.offline = (not self.key) if offline is None else offline
        self.sleep, self.clock = sleep, clock
        self.opener = opener or urllib.request.urlopen
        self._last = 0.0
        self.stopped = None          # reason once the client refuses further calls this run
        self.calls = 0               # network calls made this run
        os.makedirs(self.cache_dir, exist_ok=True)
        self.usage_path = os.path.join(self.cache_dir, "_usage.json")
        self.usage = self._load_usage()

    # ---------------------------------------------------------------- usage / budget
    def _load_usage(self):
        try:
            with open(self.usage_path, encoding="utf-8") as f:
                u = json.load(f)
        except Exception:
            u = {}
        today = _utcnow().date().isoformat()
        if u.get("day") != today:
            u = {"day": today, "calls": 0, "monthly_remaining": u.get("monthly_remaining"), "month": u.get("month")}
        month = today[:7]
        if u.get("month") != month:
            u["month"], u["monthly_remaining"] = month, None
        return u

    def _save_usage(self):
        with open(self.usage_path, "w", encoding="utf-8") as f:
            json.dump(self.usage, f)

    def calls_left_today(self):
        return max(0, self.daily_max - int(self.usage.get("calls") or 0))

    def can_call(self):
        if self.offline:
            return False
        if self.stopped:
            return False
        if self.calls_left_today() <= 0:
            return False
        mr = self.usage.get("monthly_remaining")
        return mr is None or mr > self.reserve

    # ---------------------------------------------------------------- cache
    @staticmethod
    def cache_key(path, params=None):
        p = sorted((str(k), str(v)) for k, v in (params or {}).items() if v is not None)
        return hashlib.sha1((path + "?" + urllib.parse.urlencode(p)).encode()).hexdigest()[:20]

    def _cpath(self, path, params):
        return os.path.join(self.cache_dir, self.cache_key(path, params) + ".json")

    def cached(self, path, params=None):
        try:
            with open(self._cpath(path, params), encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def _store(self, path, params, status, etag, body):
        rec = {"path": path, "params": {k: v for k, v in (params or {}).items() if v is not None}, "status": status,
               "etag": etag, "fetched": _utcnow().isoformat(timespec="seconds"), "body": body}
        tmp = self._cpath(path, params) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rec, f, separators=(",", ":"), ensure_ascii=False)
        os.replace(tmp, self._cpath(path, params))
        return rec

    def saved(self, prefix=""):
        """Every saved reply (records), optionally only paths starting with prefix. No network."""
        out = []
        for fn in sorted(os.listdir(self.cache_dir)):
            if not fn.endswith(".json") or fn.startswith("_"):
                continue
            try:
                with open(os.path.join(self.cache_dir, fn), encoding="utf-8") as f:
                    r = json.load(f)
            except Exception:
                continue
            if isinstance(r, dict) and str(r.get("path", "")).startswith(prefix):
                out.append(r)
        return out

    def prune(self, keep_days=45, keep_prefixes=("/cs2/matches/",)):
        """Delete saved replies older than keep_days (finished-match replies under keep_prefixes are kept)."""
        cut = _utcnow() - datetime.timedelta(days=keep_days)
        n = 0
        for r in self.saved():
            if any(str(r.get("path", "")).startswith(p) and str(r.get("path")).endswith("/maps") for p in keep_prefixes):
                continue
            try:
                t = datetime.datetime.fromisoformat(r["fetched"])
            except Exception:
                continue
            if t < cut:
                os.remove(self._cpath(r["path"], r.get("params")))
                n += 1
        return n

    # ---------------------------------------------------------------- network
    def _throttle(self):
        wait = self._last + self.spacing - self.clock()
        if self._last and wait > 0:
            self.sleep(wait)
        self._last = self.clock()

    def get(self, path, params=None, ttl=DAY, force=False):
        """Body (dict) of GET path?params. Fresh cache -> no call. Otherwise one call if the budget allows, else
        the stale cached body (or None). Raises nothing for budget / missing key; returns cached data instead."""
        params = {k: v for k, v in (params or {}).items() if v is not None}
        rec = self.cached(path, params)
        if rec and not force:
            try:
                age = (_utcnow() - datetime.datetime.fromisoformat(rec["fetched"])).total_seconds()
            except Exception:
                age = 1e18
            if rec.get("status") == 200 and (ttl is None or age < ttl):
                return rec["body"]
            if rec.get("status") in (400, 403, 404) and age < min(ttl or 7 * DAY, 7 * DAY):
                return None  # recently refused (not on plan / outside history / unknown id): do not spend a call again
        if not self.can_call():
            return rec["body"] if rec and rec.get("status") == 200 else None
        try:
            return self._fetch(path, params, rec)
        except CitoError as e:
            print("cito:", path, "->", e)
            return rec["body"] if rec and rec.get("status") == 200 else None

    def _fetch(self, path, params, rec):
        url = self.base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        hdr = {"x-api-key": self.key, "accept": "application/json", "user-agent": "glockys-cs2-props/1"}
        if rec and rec.get("etag") and rec.get("status") == 200:
            hdr["If-None-Match"] = rec["etag"]
        rate_retries = err_retries = 0
        while True:
            if not self.can_call():
                raise BudgetExhausted(self.stopped or "daily/monthly budget used")
            self._throttle()
            self.calls += 1
            self.usage["calls"] = int(self.usage.get("calls") or 0) + 1
            self._save_usage()
            status, headers, raw = self._open(url, hdr)
            mr = headers.get("x-ratelimit-monthly-remaining")
            if mr not in (None, ""):
                try:
                    self.usage["monthly_remaining"] = int(float(mr))
                    self._save_usage()
                except ValueError:
                    pass
            if status == 304 and rec:
                rec = self._store(path, params, 200, rec.get("etag"), rec["body"])
                return rec["body"]
            if status == 200:
                try:
                    body = json.loads(raw.decode("utf-8"))
                except Exception:
                    raise CitoError("reply was not JSON")
                self._store(path, params, 200, headers.get("etag"), body)
                return body
            code = ""
            try:
                code = ((json.loads(raw.decode("utf-8")) or {}).get("error") or {}).get("code", "")
            except Exception:
                pass
            if status == 429 and code == "RATE_LIMIT_EXCEEDED" or (status == 429 and not code):
                if rate_retries >= 2:
                    raise CitoError("429 rate limited after retries")
                rate_retries += 1
                try:
                    ra = float(headers.get("retry-after") or 0)
                except ValueError:
                    ra = 0
                self.sleep(max(ra, self.spacing))
                continue
            if status == 429:  # MONTHLY_LIMIT_REACHED, HISTORICAL_ARCHIVE_CAP_EXCEEDED, ...
                self.stopped = "429 " + code
                raise CitoError(self.stopped)
            if status in (401, 403):
                if code in ("MISSING_API_KEY", "INVALID_API_KEY", "API_KEY_REVOKED"):
                    self.stopped = "%d %s" % (status, code)
                self._store(path, params, status, None, None)
                raise CitoError("%d %s" % (status, code))
            if status >= 500 or status == 0:
                if err_retries >= 2:
                    raise CitoError("%s after retries" % (status or "network error"))
                err_retries += 1
                self.sleep(5 * err_retries)
                continue
            self._store(path, params, status, None, None)
            raise CitoError("%d %s" % (status, code))

    def _open(self, url, hdr):
        """(status, lower-case headers, body bytes). Network errors -> status 0."""
        req = urllib.request.Request(url, headers=hdr)
        try:
            with self.opener(req, timeout=30) as r:
                return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
        except urllib.error.HTTPError as e:
            return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, e.read() or b""
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0, {}, b""

    # ---------------------------------------------------------------- endpoints (names / params from the OpenAPI spec)
    def rankings(self, kind="vrs", before=None, limit=100):
        """kind 'vrs' -> /cs2/rankings/vrs, 'world' -> /cs2/rankings/world. before=YYYY-MM-DD: newest list strictly before."""
        return self.get("/cs2/rankings/" + kind, {"before": before, "limit": limit}, ttl=None if before else DAY)

    def upcoming(self, limit=100):
        return self.get("/cs2/matches/upcoming", {"limit": limit}, ttl=6 * 3600)

    def recent(self, date_start=None, date_end=None, limit=100):
        return self.get("/cs2/matches/recent", {"date_start": date_start, "date_end": date_end, "limit": limit},
                        ttl=None if date_end and date_end < _utcnow().date().isoformat() else 3 * 3600)

    def match_maps(self, match_id):
        """Finished match: per-map score + every player's kills / headshots. Cached forever."""
        return self.get("/cs2/matches/%s/maps" % urllib.parse.quote(str(match_id)), None, ttl=None)

    def team_map_stats(self, team_id, days=int(os.environ.get("CITO_HISTORY_DAYS", "30"))):
        return self.get("/cs2/teams/%s/map-stats" % urllib.parse.quote(str(team_id)), {"days": days, "pool": "current"},
                        ttl=3 * DAY)

    def teams_search(self, q):
        return self.get("/cs2/teams", {"q": q, "limit": 5}, ttl=30 * DAY)
