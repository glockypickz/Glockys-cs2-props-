"""Checks that model.js (the site) and grader.py (locks + backtest) give the same grades. Needs node.
   python parity_check.py   -> prints mismatches, exits 1 if any.
   Runs without team_strength data (exactly the pre-Cito grader) and with the MOCK Cito file
   tests/fixtures/team_strength_mock.json (ranking win chance + map-stat rounds switched on)."""
import json, re, subprocess, sys, random, os
from grader import Grader, PARAMS, TEAM_ALIASES, load_strength, load_players

MOCK = os.path.join("tests", "fixtures", "team_strength_mock.json")

JS = r"""
const M=require('./model.js');const fs=require('fs');
const d=M.decodePlayers(JSON.parse(fs.readFileSync('players.json','utf8')));const cases=JSON.parse(fs.readFileSync(0,'utf8'));
const S=process.env.STRENGTH?JSON.parse(fs.readFileSync(process.env.STRENGTH,'utf8')):null;
const ctx=M.build(d.players,cases.length&&cases[0].params||null,S);
const out=cases.map(c=>{const p=d.players[c.i];const g=M.grade(ctx,p,c.st,c.line,c.opp,{team:c.team,book:c.book,odds:c.odds,before:c.before});
 return g?{proj:g.proj,p_over:g.pOver,grade:g.grade,pick:g.pick,edge_pp:g.edgePP,reasons:g.reasons,flag:g.flag,hits:g.hits,p_hr:g.pHr,kd:g.kd,kpm:g.kpm,hsp:g.hsp}:null});
process.stdout.write(JSON.stringify({params:M.PARAMS,ctxp:ctx.P,aliases:M.TEAM_ALIASES,out:out}));
"""


def main():
    d = load_players("players.json")
    bad = 0
    for extra in (None, {"w_line": 0.0}, {"w_line": 0.5}):
        bad += run(d, extra)
    if os.path.exists(MOCK):
        for extra in (None, {"w_line": 0.0}, {"w_line": 0.0, "w_rank": 1.0, "w_maps": 1.0, "rank_s": 2.0}):
            bad += run(d, extra, MOCK)
    else:
        print("no", MOCK, "(run python tests/make_mock_cito.py): Cito-feature parity not checked")
    for extra in ({"w_hr": 0.3}, {"w_hr": 0.3, "w_line": 0.0},   # hit-rate signal switched on
                  {"w_line": 0.0, "w_l5": 0.2, "w_l10": 0.2, "w_l20": 0.1, "w_szn": 0.3, "w_kd": 0.5},  # kill form inputs on
                  {"n_max": 20, "w_line": 0.0},
                  {"w_line": 0.0, "w_hs5": 0.2, "w_hs10": 0.1, "w_hs20": 0.1, "w_hsszn": 0.3,   # HS% inputs on
                   "w_khs5": 0.2, "w_khs10": -0.2, "w_khs20": 0.1, "w_khsszn": 0.5, "w_hkd": 0.3, "w_kd": 0.2}):  # the old 20-series window
        bad += run(d, extra)
    sys.exit(1 if bad else 0)


def run(d, extra, strength=None):
    G = Grader(d["players"], d.get("ranks") or {}, params=extra, strength=load_strength(strength) if strength else None)
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
    env = dict(os.environ, STRENGTH=strength or "")
    r = subprocess.run(["node", "-e", JS], input=json.dumps(cases), capture_output=True, text=True, check=True, env=env)
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
        if abs(g["mu_model"] - j["proj"]) > 0.01 or abs(g["p_over"] - j["p_over"]) > 1e-3 or g["grade"] != j["grade"] or g["pick"] != j["pick"] or g["reasons"] != j["reasons"] or g["flag"] != j["flag"] \
                or g["hits"] != j["hits"] or abs(g["p_hr"] - j["p_hr"]) > 1e-4 \
                or (g["kd"] is None) != (j["kd"] is None) or (g["kd"] is not None and abs(g["kd"] - j["kd"]) > 1e-3) \
                or any((g["kpm"][k] is None) != (j["kpm"][k] is None) or (g["kpm"][k] is not None and abs(g["kpm"][k] - j["kpm"][k]) > 0.01) for k in g["kpm"]) \
                or any((g["hsp"][k] is None) != (j["hsp"][k] is None) or (g["hsp"][k] is not None and abs(g["hsp"][k] - j["hsp"][k]) > 1e-4) for k in g["hsp"]):
            bad += 1
            if bad < 10:
                print("MISMATCH", c, {k: g[k] for k in ("mu_model", "p_over", "grade", "pick", "reasons", "hits", "p_hr")}, j)
    print("parity (strength %s, param overrides %s): %d cases, %d mismatches, grades %s" % (strength or "none", extra, len(cases), bad,
          dict(__import__("collections").Counter(j["grade"] for j in js["out"] if j))))
    return bad


if __name__ == "__main__":
    main()
