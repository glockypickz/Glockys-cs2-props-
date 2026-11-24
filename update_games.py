"""Fast refresh of the schedule + live status from bo3.gg -> games.json (runs every ~10 minutes).

A match is "live" only when bo3.gg's own status says it is current AND it started within the last 12 hours
(bo3.gg sometimes leaves old matches flagged current). Finished matches are simply not in the file.
Keeps the old games.json if bo3.gg fails or returns nothing at all.

Stream links come from bo3.gg's match detail (`/matches/{slug}` -> `streams`): official raw_url / embed_url,
platform, language, and channel name. URLs are never invented from a channel name alone. The compact
matches list only has stream names, so each listed match with a slug is followed up for the real links.
"""
import asyncio, json, datetime, re, aiohttp

B = "https://api.bo3.gg/api/v1"
H = {"accept": "application/json", "origin": "https://bo3.gg", "referer": "https://bo3.gg/",
     "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"}
LIVE_MAX_AGE_H = 12  # fallback when the series length is unknown
STREAM_CONCURRENCY = 5
STREAM_MAX = 10
# bo3.gg platform ids observed on match detail: 1 = Twitch, 3 = Kick. Prefer URL host when present.
PLAT_ID = {1: "twitch", 2: "youtube", 3: "kick"}


def bo_num(bo):
    try:
        return int("".join(ch for ch in str(bo) if ch.isdigit()))
    except Exception:
        return None


def is_finished_or_stale(bo, s1, s2, age_h):
    """True when a match flagged 'current' is really over: a team already has the wins needed
    (Bo3 needs 2, Bo5 needs 3), or it started longer ago than that series can last.
    Bo1 scores may be rounds, so Bo1 is only judged by age."""
    n = bo_num(bo)
    if n and n >= 3 and s1 is not None and s2 is not None and max(s1, s2) >= n // 2 + 1:
        return True
    limit = {1: 3, 3: 8, 5: 12}.get(n, LIVE_MAX_AGE_H)
    return age_h > limit
printed_keys = False


async def get(s, path, params=None):
    for attempt in range(4):
        async with s.get(B + path, params=params) as r:
            if r.status == 429:
                await asyncio.sleep(3 * (attempt + 1))
                continue
            r.raise_for_status()
            return await r.json()
    raise Exception("rate limited: " + path)


def iso(s):
    if s and not s.endswith("Z") and "+" not in s[10:]:
        s += "Z"
    return s


def score(m, side):
    """Series score for team 1 or 2. Field names are not documented, so try the likely ones."""
    for k in (f"team{side}_score", f"team{side}_result", f"team{side}_wins", f"score{side}"):
        v = m.get(k)
        if isinstance(v, (int, float)):
            return int(v)
    return None


def _https(u):
    return u if isinstance(u, str) and u.startswith("https://") else None


def platform_of(url, plat):
    if isinstance(plat, str) and plat.strip() and not plat.isdigit():
        p = plat.strip().lower()
        if p in ("twitch", "youtube", "kick"):
            return p
    host = ""
    if url:
        m = re.match(r"https://(?:www\.)?([^/]+)", url, re.I)
        host = (m.group(1) if m else "").lower()
    if "twitch.tv" in host:
        return "twitch"
    if "youtube.com" in host or host == "youtu.be":
        return "youtube"
    if "kick.com" in host:
        return "kick"
    if isinstance(plat, int) and plat in PLAT_ID:
        return PLAT_ID[plat]
    try:
        n = int(plat)
        if n in PLAT_ID:
            return PLAT_ID[n]
    except (TypeError, ValueError):
        pass
    return None


def parse_streams(raw):
    """Keep only real https links from bo3.gg's streams list. Skip blocked rows. Do not invent URLs."""
    out, seen = [], set()
    for st in raw or []:
        if not isinstance(st, dict) or st.get("blocked"):
            continue
        url = _https(st.get("raw_url")) or _https(st.get("embed_url"))
        if not url:
            continue
        plat = platform_of(url, st.get("platform")) or platform_of(_https(st.get("embed_url")), st.get("platform"))
        name = st.get("name") or None
        lang = st.get("language") or None
        if isinstance(name, str):
            name = name.strip() or None
        if isinstance(lang, str):
            lang = lang.strip() or None
        key = (plat or "", (name or "").lower() or url.lower())
        if key in seen:
            continue
        seen.add(key)
        item = {"url": url, "platform": plat, "name": name, "language": lang, "official": bool(st.get("official"))}
        if isinstance(st.get("viewers_number"), (int, float)):
            item["viewers"] = int(st["viewers_number"])
        out.append(item)
    out.sort(key=lambda s: (not s.get("official"), -(s.get("viewers") or -1), (s.get("name") or "").lower()))
    return out[:STREAM_MAX]


def _ev(x):
    x = str(x or "").lower()
    return "lan" if x == "lan" else "online" if x == "online" else None


def known_event_types():
    """tournament id -> "lan"/"online" from season_state.json (filled by update_data.py from bo3.gg match detail). File read only."""
    try:
        return {str(k): _ev(v) for k, v in (json.load(open("season_state.json", encoding="utf-8")).get("events") or {}).items() if _ev(v)}
    except Exception:
        return {}


async def fill_streams(session, jobs):
    """jobs: list of (game dict, slug). Fetches match detail and sets game['streams']."""
    sem = asyncio.Semaphore(STREAM_CONCURRENCY)

    async def one(g, slug):
        async with sem:
            try:
                det = await get(session, "/matches/" + slug)
            except Exception as e:
                print("stream detail failed:", slug, e)
                return
            if isinstance(det, dict):
                g["streams"] = parse_streams(det.get("streams") or [])
                et = _ev((det.get("tournament") or {}).get("event_type"))
                if et and not g.get("ev"):
                    g["ev"] = et

    await asyncio.gather(*(one(g, slug) for g, slug in jobs))


async def main():
    global printed_keys
    now = datetime.datetime.now(datetime.timezone.utc)
    games, seen, details = [], set(), []
    evmap = known_event_types()
    async with aiohttp.ClientSession(headers=H) as s:
        for status, label in (("current", "live"), ("upcoming", "upcoming")):
            try:
                d = await get(s, "/matches", {
                    "scope": "widget-matches", "page[offset]": 0, "page[limit]": 100,
                    "sort": "start_date", "filter[matches.status][in]": status,
                    "filter[matches.discipline_id][eq]": 1, "with": "teams,tournament,games,streams"})
            except Exception as e:
                print(f"{label} fetch failed:", e)
                return print("keeping the old games.json")
            res = d.get("results", [])
            print(f"{label}: {len(res)} matches from bo3.gg")
            if res and label == "live" and not printed_keys:
                print("match keys:", sorted(res[0].keys()))
                printed_keys = True
            for m in res:
                t1, t2 = m.get("team1") or {}, m.get("team2") or {}
                if not t1.get("name") or not t2.get("name") or not m.get("start_date") or m["id"] in seen:
                    continue
                start = iso(m["start_date"])
                try:
                    age_h = (now - datetime.datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds() / 3600
                except Exception:
                    continue
                if label == "live" and is_finished_or_stale(m.get("bo_type"), score(m, 1), score(m, 2), age_h):
                    continue  # finished or stale "current" flag
                seen.add(m["id"])
                g = {"id": m["id"], "start": start, "team1": t1["name"], "team2": t2["name"],
                     "tournament": (m.get("tournament") or {}).get("name", ""), "bo": m.get("bo_type"),
                     "status": label, "s1": score(m, 1), "s2": score(m, 2), "streams": []}
                # LAN / online for the grader's LAN data: list payload event_type if present, else season_state.json by
                # tournament id, else the match detail (stream fetch) fills it; missing = grader falls back to the 3-day rule.
                tour = m.get("tournament") or {}
                if tour.get("id") is not None:
                    g["tournament_id"] = tour["id"]
                ev = _ev(tour.get("event_type")) or evmap.get(str(tour.get("id")))
                if ev:
                    g["ev"] = ev
                games.append(g)
                slug = m.get("slug")
                # List payload only has stream names; live matches and any row with stream names get a detail fetch.
                if slug and (label == "live" or m.get("streams")):
                    details.append((g, slug))
        if details:
            await fill_streams(s, details)
    games.sort(key=lambda g: g["start"])
    if not games:
        return print("no games returned, keeping the old games.json")
    out = {"updated": now.isoformat(timespec="seconds"), "games": games}
    json.dump(out, open("games.json", "w"), separators=(",", ":"), ensure_ascii=False)
    nstream = sum(1 for g in games if g["streams"])
    print("wrote games.json:", len(games), "games,", sum(g["status"] == "live" for g in games), "live,",
          nstream, "with streams")


if __name__ == "__main__":
    asyncio.run(main())
