"""Checks that model.js (the site) and grader.py (locks + backtest) give the same grades. Needs node.
   python parity_check.py   -> prints mismatches, exits 1 if any."""
import json, re, subprocess, sys, random
from grader import Grader, PARAMS, TEAM_ALIASES

JS = r"""
const M=require('./model.js');const fs=require('fs');
const d=JSON.parse(fs.readFileSync('players.json','utf8'));const cases=JSON.parse(fs.readFileSync(0,'utf8'));
const ctx=M.build(d.players,cases.length&&cases[0].params||null);
const out=cases.map(c=>{const p=d.players[c.i];const g=M.grade(ctx,p,c.st,c.line,c.opp,{team:c.team,book:c.book,odds:c.odds,before:c.before});
 return g?{proj:g.proj,p_over:g.pOver,grade:g.grade,pick:g.pick,edge_pp:g.edgePP,reasons:g.reasons}:null});
process.stdout.write(JSON.stringify({params:M.PARAMS,ctxp:ctx.P,aliases:M.TEAM_ALIASES,out:out}));
"""


def main():
    d = json.load(open("players.json", encoding="utf-8"))
    bad = 0
    for extra in (None, {"w_line": 0.0}, {"w_line": 0.5}):
        bad += run(d, extra)
    sys.exit(1 if bad else 0)


def run(d, extra):
    G = Grader(d["players"], d.get("ranks") or {}, params=extra)
    idx = {id(p): i for i, p in enumerate(d["players"])}
    cases = []
    try:
        hist = json.load(open("lines_history.json", encoding="utf-8"))["entries"]
    except Exception:
        hist = []
    for e in hist:
        if "+" in e["player"]:
            continue
        p = G.find(e["player"], e.get("team"))
        if p:
            st = "hs" if "head" in e["stat"].lower() else "kills"
            cases.append({"i": idx[id(p)], "st": st, "line": float(e["line"]), "opp": e.get("opponent") or "", "team": e.get("team") or "",
                          "book": e["book"], "odds": e.get("odds"), "before": e["start"][:10]})
    rnd = random.Random(3)
    for _ in range(400):
        i = rnd.randrange(len(d["players"]))
        p = d["players"][i]
        st = rnd.choice(["kills", "hs"])
        opp = rnd.choice([l.get("opp") for l in p["logs"]] or [""])
        cases.append({"i": i, "st": st, "line": rnd.choice([12.5, 15.5, 27.5, 30.0, 32.5]), "opp": opp, "team": p.get("team"),
                      "book": rnd.choice(["PrizePicks", "Underdog", ""]), "odds": rnd.choice([None, -112, -137, 105]), "before": "9999"})
    if extra:
        cases[0]["params"] = extra
    r = subprocess.run(["node", "-e", JS], input=json.dumps(cases), capture_output=True, text=True, check=True)
    js = json.loads(r.stdout)
    bad = 0
    if js["params"] != PARAMS:
        print("PARAMS differ:", js["params"], PARAMS); bad += 1
    if js["aliases"] != TEAM_ALIASES:
        print("TEAM_ALIASES differ"); bad += 1
    for c, j in zip(cases, js["out"]):
        p = d["players"][c["i"]]
        g = G.grade(p, c["st"], c["line"], c["opp"], c["team"], c["book"], c["odds"], c["before"])
        if (g is None) != (j is None):
            bad += 1; print("one side None", c, g, j); continue
        if g is None:
            continue
        if abs(g["mu_model"] - j["proj"]) > 0.01 or abs(g["p_over"] - j["p_over"]) > 1e-3 or g["grade"] != j["grade"] or g["pick"] != j["pick"] or g["reasons"] != j["reasons"]:
            bad += 1
            if bad < 10:
                print("MISMATCH", c, {k: g[k] for k in ("mu_model", "p_over", "grade", "pick", "reasons")}, j)
    print("parity (param overrides %s): %d cases, %d mismatches, grades %s" % (extra, len(cases), bad,
          dict(__import__("collections").Counter(j["grade"] for j in js["out"] if j))))
    return bad


if __name__ == "__main__":
    main()
