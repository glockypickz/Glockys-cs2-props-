"""Gap report: which players on today's lines have no usable stats on the site, and why.

Uses the SAME matching rules as the site (grader.py), so what it lists as missing is what the site shows as "no stats".
Combo lines ("A + B + C") are split into their players. Reads lines.json + players.json (no network, no key).
Prints a short report to the Actions log and writes gap_report.json.
"""
import json
from collections import defaultdict
from grader import Grader, teq


def main():
    lines = json.load(open("lines.json", encoding="utf-8")).get("lines", [])
    pj = json.load(open("players.json", encoding="utf-8"))
    players = pj.get("players", [])
    gr = Grader(players, pj.get("ranks") or {})
    teams = sorted({p["team"] for p in players if p.get("team")})

    rows = {}   # one row per player name on the lines (combos split)
    combos = 0
    for l in lines:
        parts = [x.strip() for x in str(l["player"]).split("+") if x.strip()]
        if len(parts) > 1:
            combos += 1
        for n in parts:
            r = rows.setdefault((n.lower(), l.get("team", "")), {"player": n, "team": l.get("team", ""),
                                                                  "opponent": l.get("opponent", ""), "lines": 0})
            r["lines"] += 1

    ok, noseries, missing, noteam = [], [], [], []
    for k, r in sorted(rows.items(), key=lambda kv: (kv[1]["team"].lower(), kv[1]["player"].lower())):
        p = gr.find(r["player"], r["team"])
        if p:
            n = len(gr.combos(p))
            (ok if n else noseries).append({**r, "series": n, "data_name": p["name"], "data_team": p.get("team")})
            continue
        tm = [t for t in teams if teq(t, r["team"])]
        if tm:
            roster = sorted({p2["name"] for p2 in players if p2.get("team") in tm})
            missing.append({**r, "data_team": tm[0], "data_roster": roster})
        else:
            noteam.append(r)

    nl = lambda xs: sum(x["lines"] for x in xs)
    print("=== GAP REPORT (same matching as the site) ===")
    print(f"lines: {len(lines)} ({combos} combo lines) | player names on lines: {len(rows)} | players in data: {len(players)}")
    print(f"OK (usable stats): {len(ok)} names / {nl(ok)} line slots")
    print(f"IN DATA but no Map 1+2 series: {len(noseries)}")
    print(f"TEAM IN DATA, PLAYER NOT FOUND: {len(missing)}")
    print(f"TEAM NOT IN DATA: {len(noteam)}")

    if noseries:
        print("\n--- IN DATA, NO MAP 1+2 SERIES (joined recently or only played single maps) ---")
        for x in noseries:
            print(f"{x['player']} ({x['team']}) -> {x['data_name']} [{x['data_team']}]")
    if missing:
        print("\n--- PLAYER NOT FOUND (the data team's roster is shown; a different nickname there may be the same person) ---")
        for x in missing:
            print(f"{x['player']} ({x['team']} vs {x['opponent']}) | data team {x['data_team']} roster: {', '.join(x['data_roster'])}")
    if noteam:
        print("\n--- TEAM NOT IN DATA ---")
        for x in noteam:
            print(f"{x['player']} ({x['team']})")

    json.dump({"summary": {"lines": len(lines), "names": len(rows), "ok": len(ok), "no_series": len(noseries),
                           "not_found": len(missing), "team_missing": len(noteam)},
               "no_series": noseries, "not_found": missing, "team_missing": noteam},
              open("gap_report.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print("\nwrote gap_report.json")


if __name__ == "__main__":
    main()
