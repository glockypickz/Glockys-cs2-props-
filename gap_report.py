"""Gap report: which players on today's lines have no usable stats on the site, and why.

Reads lines.json + players.json from the repo (no network, no key). Prints a short report to the
Actions log and writes gap_report.json. Uses the same name rule as the site (letters and numbers only,
lower case), plus a looser pass to find near-misses.
"""
import json, re, difflib
from collections import defaultdict

STOP = {"team", "esports", "esport", "gaming", "club"}


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def tnorm(s):
    words = [w for w in re.split(r"[^a-z0-9]+", str(s or "").lower()) if w and w not in STOP]
    return "".join(words)


def team_like(a, b):
    a, b = tnorm(a), tnorm(b)
    if not a or not b:
        return False
    return a == b or (len(a) >= 4 and len(b) >= 4 and (a in b or b in a))


def series_count(p):
    """Series where both Map 1 and Map 2 were logged (what the grader needs)."""
    seen = defaultdict(set)
    for l in p.get("logs", []):
        if l.get("n") in (1, 2) and l.get("mid") is not None:
            seen[l["mid"]].add(l["n"])
    return sum(1 for v in seen.values() if v >= {1, 2})


def main():
    lines = json.load(open("lines.json", encoding="utf-8")).get("lines", [])
    players = json.load(open("players.json", encoding="utf-8")).get("players", [])
    by_name = defaultdict(list)
    for p in players:
        by_name[norm(p["name"])].append(p)
    teams = sorted({p["team"] for p in players if p.get("team")})

    # one row per player on the lines (a player has many lines: kills, HS, two books)
    rows = {}
    for l in lines:
        k = norm(l["player"])
        r = rows.setdefault(k, {"player": l["player"], "team": l.get("team", ""), "opponent": l.get("opponent", ""), "lines": 0})
        r["lines"] += 1
    ok, nodata, near, teamhas, teammissing = [], [], [], [], []
    for k, r in sorted(rows.items(), key=lambda kv: (kv[1]["team"].lower(), kv[1]["player"].lower())):
        hit = by_name.get(k)
        if hit:
            best = max(series_count(p) for p in hit)
            (ok if best >= 1 else nodata).append({**r, "series": best, "data_team": hit[0].get("team")})
            continue
        cands = difflib.get_close_matches(k, list(by_name.keys()), n=3, cutoff=0.8)
        if cands:
            c = by_name[cands[0]][0]
            near.append({**r, "data_name": c["name"], "data_team": c.get("team"), "series": series_count(c)})
            continue
        match = [t for t in teams if team_like(t, r["team"])]
        if match:
            teamhas.append({**r, "data_team": match[0]})
        else:
            teammissing.append(r)

    n_lines = lambda xs: sum(x["lines"] for x in xs)
    print("=== GAP REPORT ===")
    print(f"lines: {len(lines)} | players on lines: {len(rows)} | players in data: {len(players)}")
    print(f"OK (usable stats): {len(ok)} players / {n_lines(ok)} lines")
    print(f"IN DATA but no Map 1+2 series: {len(nodata)} players / {n_lines(nodata)} lines")
    print(f"NAME NEAR-MISS (spelling): {len(near)} players / {n_lines(near)} lines")
    print(f"TEAM IN DATA, PLAYER MISSING: {len(teamhas)} players / {n_lines(teamhas)} lines")
    print(f"TEAM NOT IN DATA: {len(teammissing)} players / {n_lines(teammissing)} lines")

    def group(title, xs, extra=lambda x: ""):
        if not xs:
            return
        print(f"\n--- {title} ---")
        g = defaultdict(list)
        for x in xs:
            g[x["team"]].append(x["player"] + extra(x))
        for t, ps in g.items():
            print(f"{t}: " + ", ".join(ps))

    group("TEAM NOT IN DATA (needs a new fetch)", teammissing)
    group("TEAM IN DATA, PLAYER MISSING (roster out of date)", teamhas, lambda x: f" [data team: {x['data_team']}]")
    group("NAME NEAR-MISS (line name -> data name)", near, lambda x: f" -> {x['data_name']} ({x['data_team']}, {x['series']} series)")
    group("IN DATA, NO MAP 1+2 SERIES", nodata, lambda x: f" [{x['data_team']}]")

    json.dump({"summary": {"lines": len(lines), "players_on_lines": len(rows), "ok": len(ok), "no_series": len(nodata),
                           "near_miss": len(near), "team_has_player_missing": len(teamhas), "team_missing": len(teammissing)},
               "team_missing": teammissing, "team_has_player_missing": teamhas, "near_miss": near, "no_series": nodata},
              open("gap_report.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print("\nwrote gap_report.json")


if __name__ == "__main__":
    main()

