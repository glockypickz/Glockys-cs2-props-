"""Fast refresh of the schedule + live status from bo3.gg -> games.json (runs every ~10 minutes).

A match is "live" only when bo3.gg's own status says it is current AND it started within the last 12 hours
(bo3.gg sometimes leaves old matches flagged current). Finished matches are simply not in the file.
Keeps the old games.json if bo3.gg fails or returns nothing at all.
"""
import asyncio, json, datetime, aiohttp

B = "https://api.bo3.gg/api/v1"
H = {"accept": "application/json", "origin": "https://bo3.gg", "referer": "https://bo3.gg/",
     "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"}
LIVE_MAX_AGE_H = 12
printed_keys = False


async def get(s, path, params):
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


def streams(m):
    """Any https link in a field whose name mentions stream/twitch/youtube/broadcast."""
    out = []

    def walk(o, key=""):
        if isinstance(o, dict):
            for k, v in o.items():
                walk(v, k)
        elif isinstance(o, list):
            for v in o:
                walk(v, key)
        elif isinstance(o, str) and o.startswith("https://") and any(
                w in key.lower() for w in ("stream", "twitch", "youtube", "broadcast", "watch")):
            if o not in out:
                out.append(o)
    walk(m)
    return out[:3]


async def main():
    global printed_keys
    now = datetime.datetime.now(datetime.timezone.utc)
    games, seen = [], set()
    async with aiohttp.ClientSession(headers=H) as s:
        for status, label in (("current", "live"), ("upcoming", "upcoming")):
            try:
                d = await get(s, "/matches", {
                    "scope": "widget-matches", "page[offset]": 0, "page[limit]": 100,
                    "sort": "start_date", "filter[matches.status][in]": status,
                    "filter[matches.discipline_id][eq]": 1, "with": "teams,tournament,games"})
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
                if label == "live" and age_h > LIVE_MAX_AGE_H:
                    continue  # stale "current" flag
                seen.add(m["id"])
                games.append({"id": m["id"], "start": start, "team1": t1["name"], "team2": t2["name"],
                              "tournament": (m.get("tournament") or {}).get("name", ""), "bo": m.get("bo_type"),
                              "status": label, "s1": score(m, 1), "s2": score(m, 2), "streams": streams(m)})
    games.sort(key=lambda g: g["start"])
    if not games:
        return print("no games returned, keeping the old games.json")
    out = {"updated": now.isoformat(timespec="seconds"), "games": games}
    json.dump(out, open("games.json", "w"), separators=(",", ":"), ensure_ascii=False)
    print("wrote games.json:", len(games), "games,", sum(g["status"] == "live" for g in games), "live")


if __name__ == "__main__":
    asyncio.run(main())
