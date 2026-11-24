"""Scout-style factor projection (candidate / shadow). Reads players.json-derived data only. No network.

Pipeline (one prop = one player, one stat, one scope: "Maps 1-2" = 2 maps, "Map 1" = 1 map):
  FORM      kills per round (KPR): recency-weighted over every logged map this season (half-life HL maps),
            blended with the raw season KPR (w_szn, always > 0: owner rule) and with head-to-head KPR vs this
            opponent shrunk toward his own KPR (used from a single prior meeting: owner rule).
  ROUNDS    expected rounds per map: both teams' recency-weighted rounds per map (shrunk to the league average),
            fitted linearly with the Elo closeness pw * (1 - pw).  projection = KPR x rounds x maps.
  LAN       his KPR in tonight's setting (LAN / online) vs his all-settings KPR, shrunk.
  OPPONENT  deaths per player-round the opponent gives up vs the average of the opponents he faced.
  MAPS      simulated veto: each map's chance of being played (both teams' recent map shares over the active pool),
            his per-map KPR vs his all-map KPR (shrunk), and per-map rounds.
  ELO       team Elo win chance (pw - 0.5).
  Each factor enters log(mean) with a coefficient fitted jointly (Poisson GLM) on a chronological train split.
  Headshots = kills projection x his shrunk headshots-per-kill.
Only data dated strictly before the match day is used.
"""
import bisect, math
from grader import tn, teq, winp, is_map1

LEAGUE_KPR = 0.68
DEF = {"hl": 30.0, "m": 80.0, "w_szn": 0.2, "m_h2h": 60.0, "w_h2h": 0.15,
       "k_lan": 150.0, "k_map": 120.0, "k_opp": 200.0, "k_rd": 6.0, "hl_rd": 20.0,
       "veto_days": 180, "pool_days": 60, "k_veto": 1.5, "k_hs": 40.0, "hl_hs": 30.0,
       # rounds per map: rd = a + b * base + c * pw(1-pw); refit by scout_backtest.py
       "rd_a": 0.0, "rd_b": 1.0, "rd_c": 0.0,
       # log-mean coefficients (0 = factor off); refit by scout_backtest.py
       "b0": 0.0, "b_lan": 0.0, "b_opp": 0.0, "b_maps": 0.0, "b_mapr": 0.0, "b_elo": 0.0}


def _day_ord(d):
    try:
        y, m, dd = int(d[:4]), int(d[5:7]), int(d[8:10])
        import datetime
        return datetime.date(y, m, dd).toordinal()
    except Exception:
        return None


class ScoutData:
    def __init__(self, players, grader):
        self.gr = grader
        self.rows = {}        # id(p) -> list of map rows ascending
        self.dates = {}
        team_maps = {}        # team -> {(mid,n): row}
        allmaps = {}
        for p in players:
            logs = p.get("logs") or []
            pos = {(l.get("date"), l.get("n"), tn(l.get("opp"))) for l in logs if (l.get("mid") or 0) > 0}
            out = []
            for l in logs:
                mid = l.get("mid")
                if mid is None or l.get("n") is None or not l.get("date"):
                    continue
                if mid < 0 and (l.get("date"), l.get("n"), tn(l.get("opp"))) in pos:
                    continue   # Cito duplicate of a bo3.gg map
                rd = l.get("rd")
                r = {"date": l["date"], "mid": mid, "n": l["n"], "map": l.get("map"), "opp": tn(l.get("opp")),
                     "k": l.get("kills"), "hs": l.get("hs"), "d": l.get("d"),
                     "rd": float(rd) if isinstance(rd, (int, float)) and rd >= 13 else None,
                     "rw": l.get("rw"), "ev": l.get("ev")}
                out.append(r)
                t = tn(p.get("team"))
                if t and r["rd"]:
                    g = team_maps.setdefault(t, {}).setdefault((mid, r["n"]), {"date": r["date"], "map": r["map"], "rd": r["rd"],
                                                                                "opp": r["opp"], "ev": r["ev"], "dsum": 0.0, "np": 0})
                    if r["d"] is not None:
                        g["dsum"] += float(r["d"])
                        g["np"] += 1
                    allmaps[(mid, r["n"])] = (r["date"], r["map"])
            out.sort(key=lambda r: (r["date"], r["mid"], r["n"]))
            self.rows[id(p)] = out
            self.dates[id(p)] = [r["date"] for r in out]
        self._maxn = {}
        for p in players:
            for l in p.get("logs") or []:
                if l.get("mid") is not None and isinstance(l.get("n"), int):
                    k = str(l["mid"])
                    self._maxn[k] = max(self._maxn.get(k, 0), l["n"])
        self.team = {}
        for t, d in team_maps.items():
            lst = sorted(d.values(), key=lambda g: g["date"])
            self.team[t] = (lst, [g["date"] for g in lst])
        gl = sorted(allmaps.values())
        self.gmaps = gl
        self.gdates = [x[0] for x in gl]
        self._pool, self._conc, self._trd, self._share = {}, {}, {}, {}
        # league rounds per map / deaths per player-round (whole file; only used as shrink targets)
        rds = [g["rd"] for lst, _ in self.team.values() for g in lst]
        self.league_rd = sum(rds) / len(rds) if rds else 21.0
        dd = sum(g["dsum"] for lst, _ in self.team.values() for g in lst)
        pr = sum(g["rd"] * g["np"] for lst, _ in self.team.values() for g in lst)
        self.league_dpr = dd / pr if pr else LEAGUE_KPR

    def bo_of(self, mid):
        """Format of a past match from the maps it logged: a 4th or 5th map means best-of-5, else best-of-3.
        (A Bo5 won 3-0 looks like a Bo3 here; live grades read the format from games.json.)"""
        return 5 if self._maxn.get(str(mid), 0) >= 4 else 3

    def prior(self, p, D):
        i = bisect.bisect_left(self.dates[id(p)], D)
        return self.rows[id(p)][:i]

    def ev_of(self, p, mid=None, D=None):
        for r in reversed(self.rows[id(p)]):
            if (mid is not None and str(r["mid"]) == str(mid)) or (mid is None and r["date"] == D):
                if r["ev"]:
                    return r["ev"]
        return None

    # ---- team-level pieces (all strictly before D, memoized)
    def team_prior_maps(self, t, D):
        x = self.team.get(t)
        if not x:
            return []
        return x[0][:bisect.bisect_left(x[1], D)]

    def pool(self, D):
        if D not in self._pool:
            o = _day_ord(D)
            lo = bisect.bisect_left(self.gdates, _ord_to_iso(o - DEF["pool_days"]))
            hi = bisect.bisect_left(self.gdates, D)
            c = {}
            for _, m in self.gmaps[lo:hi]:
                if m:
                    c[m] = c.get(m, 0) + 1
            n = sum(c.values()) or 1
            self._pool[D] = sorted(m for m, v in c.items() if v / n >= 0.03)
        return self._pool[D]

    def shares(self, t, D, P):
        """Team's share of each pool map among its Maps 1-2 slots in the last veto_days (smoothed toward uniform)."""
        key = (t, D)
        if key not in self._share:
            pool = self.pool(D)
            lo = _ord_to_iso(_day_ord(D) - P["veto_days"])
            c, n = {}, 0
            for g in self.team_prior_maps(t, D):
                if g["date"] >= lo and g["map"] in pool:
                    c[g["map"]] = c.get(g["map"], 0) + 1
                    n += 1
            k = P["k_veto"]
            self._share[key] = ({m: (c.get(m, 0) + k / len(pool)) / (n + k) for m in pool} if pool else {}, n)
        return self._share[key]

    def veto(self, t, o, D, P):
        """Each pool map's chance of being one of the played maps (weights sum to 1)."""
        sa, na = self.shares(t, D, P)
        sb, nb = self.shares(o, D, P) if o else ({}, 0)
        pool = self.pool(D)
        if not pool:
            return {}
        u = 1.0 / len(pool)
        if na and nb:
            w = {m: sa.get(m, u) + sb.get(m, u) for m in pool}
        elif na or nb:
            w = dict(sa if na else sb)
        else:
            w = {m: u for m in pool}
        tw = sum(w.values()) or 1.0
        return {m: v / tw for m, v in w.items()}

    def team_rd(self, t, D, P):
        key = (t, D)
        if key not in self._trd:
            lst = self.team_prior_maps(t, D)[-80:]
            s = w_ = 0.0
            per = {}
            for i, g in enumerate(reversed(lst)):
                w = 0.5 ** (i / P["hl_rd"])
                s += w * g["rd"]
                w_ += w
                pm = per.setdefault(g["map"], [0.0, 0.0])
                pm[0] += g["rd"]
                pm[1] += 1
            base = (s + P["k_rd"] * self.league_rd) / (w_ + P["k_rd"])
            self._trd[key] = (base, {m: (v[0] + P["k_rd"] * base) / (v[1] + P["k_rd"]) for m, v in per.items()}, len(lst))
        return self._trd[key]

    def conc(self, t, D, P):
        """Deaths per player-round the team gives up (its own players' deaths), recency-weighted, shrunk to league."""
        key = (t, D)
        if key not in self._conc:
            lst = [g for g in self.team_prior_maps(t, D) if g["np"] >= 3][-60:]
            dd = pr = 0.0
            for i, g in enumerate(reversed(lst)):
                w = 0.5 ** (i / 30.0)
                dd += w * g["dsum"] / g["np"]
                pr += w * g["rd"]
            self._conc[key] = (dd + P["k_opp"] * self.league_dpr) / (pr + P["k_opp"]) if lst else None
        return self._conc[key]


def _ord_to_iso(o):
    import datetime
    return datetime.date.fromordinal(o).isoformat()


def features(S, p, team, opp, D, period=None, ev=None, P=None, bo=3):
    """Every candidate input for one player / match, strictly before day D. None if he has no usable maps."""
    P = dict(DEF, **(P or {}))
    t, o = tn(team or p.get("team")), tn(opp)
    pr = [r for r in S.prior(p, D) if r["rd"] and r["k"] is not None]
    if not pr:
        return None
    yr = D[:4]
    # FORM
    sk = sr = 0.0
    for i, r in enumerate(reversed(pr[-300:])):
        w = 0.5 ** (i / P["hl"])
        sk += w * r["k"]
        sr += w * r["rd"]
    kpr_dec = (sk + P["m"] * LEAGUE_KPR) / (sr + P["m"])
    szn = [r for r in pr if r["date"][:4] == yr] or pr
    K, R = sum(r["k"] for r in szn), sum(r["rd"] for r in szn)
    kpr_szn = K / R
    kpr = (1 - P["w_szn"]) * kpr_dec + P["w_szn"] * kpr_szn
    h = [r for r in pr if o and r["opp"] == o]
    kpr_h2h = None
    if h:
        kh, rh = sum(r["k"] for r in h), sum(r["rd"] for r in h)
        kpr_h2h = (kh + P["m_h2h"] * kpr) / (rh + P["m_h2h"])
        kpr = (1 - P["w_h2h"]) * kpr + P["w_h2h"] * kpr_h2h
    # LAN / online
    x_lan = 0.0
    if ev in ("lan", "online"):
        se = [r for r in szn if r["ev"] == ev]
        ke, re_ = sum(r["k"] for r in se), sum(r["rd"] for r in se)
        kpr_ev = (ke + P["k_lan"] * kpr_szn) / (re_ + P["k_lan"])
        x_lan = math.log(kpr_ev / kpr_szn)
    # OPPONENT: what the opponent gives up vs the opponents he faced
    x_opp, c_o, sos = 0.0, None, None
    c_o = S.conc(o, D, P) if o else None
    if c_o:
        cs = [S.conc(r["opp"], D, P) for r in pr[-60:]]
        cs = [c for c in cs if c]
        if cs:
            sos = sum(cs) / len(cs)
            x_opp = math.log(c_o / sos)
    # ELO
    pw = winp(S.gr.elo(t, D), S.gr.elo(o, D)) if o else 0.5
    # ROUNDS
    rt, rtm, nt = S.team_rd(t, D, P)
    ro, rom, no = S.team_rd(o, D, P) if o else (rt, rtm, 0)
    rbase = (rt + ro) / 2.0
    rd_hat = P["rd_a"] + P["rd_b"] * rbase + P["rd_c"] * pw * (1 - pw)
    # MAPS (simulated veto). Owner rule: best-of-3 -> only the 3 most likely maps (best-of-5 -> 5), renormalized.
    vw = S.veto(t, o, D, P)
    vt = veto_top(vw, bo)
    x_maps = x_mapr = x_maps_pool = x_mapr_pool = 0.0
    if vw:
        per = {}
        for r in szn:
            a = per.setdefault(r["map"], [0.0, 0.0])
            a[0] += r["k"]
            a[1] += r["rd"]
        kpm = {m: (per.get(m, [0, 0])[0] + P["k_map"] * kpr_szn) / (per.get(m, [0, 0])[1] + P["k_map"]) for m in vw}
        rdm = {m: (rtm.get(m, rt) + rom.get(m, ro)) / 2.0 for m in vw}
        x_maps_pool = math.log(sum(vw[m] * kpm[m] for m in vw) / kpr_szn)
        x_mapr_pool = math.log(sum(vw[m] * rdm[m] for m in vw) / rbase)
        x_maps = math.log(sum(vt[m] * kpm[m] for m in vt) / kpr_szn)
        x_mapr = math.log(sum(vt[m] * rdm[m] for m in vt) / rbase)
    # HEADSHOTS per kill
    hrows = [r for r in pr if r["hs"] is not None and r["k"]]
    hk = kk = 0.0
    for i, r in enumerate(reversed(hrows[-200:])):
        w = 0.5 ** (i / P["hl_hs"])
        hk += w * r["hs"]
        kk += w * r["k"]
    sh = [r for r in hrows if r["date"][:4] == yr] or hrows
    hs_szn = (sum(r["hs"] for r in sh) / max(1.0, sum(r["k"] for r in sh))) if sh else 0.5
    hspk = (hk + P["k_hs"] * hs_szn) / (kk + P["k_hs"])
    nmaps = 1 if is_map1(period) else 2
    return {"kpr": kpr, "kpr_dec": kpr_dec, "kpr_szn": kpr_szn, "kpr_h2h": kpr_h2h, "n_h2h_maps": len(h),
            "rd_hat": rd_hat, "rbase": rbase, "pw": pw, "nmaps": nmaps, "hspk": hspk,
            "x_lan": x_lan, "x_opp": x_opp, "x_maps": x_maps, "x_mapr": x_mapr, "x_elo": pw - 0.5,
            "veto": vw, "veto_top": vt, "bo": bo, "x_maps_pool": x_maps_pool, "x_mapr_pool": x_mapr_pool, "ev": ev, "n_maps_sample": len(szn), "conc_opp": c_o, "sos": sos}


FACTORS = ("lan", "opp", "maps", "mapr", "elo", "maps_pool", "mapr_pool")
MODEL = "shadow-scout-v1"
PARAMS_FILE = "scout_params.json"


def load_params(path=PARAMS_FILE):
    import json
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def infer_ev(S, team, opp, start_day, days=3):
    """Tonight's setting (lan / online) for an upcoming match: the newest logged map of either team within `days` before
    the match day, if it says lan or online (teams usually play several days of the same event). None if unknown."""
    import datetime
    lo = _ord_to_iso(_day_ord(start_day) - days)
    best = None
    for t in (tn(team), tn(opp)):
        for g in reversed(S.team_prior_maps(t, start_day)):
            if g["date"] < lo:
                break
            if g.get("ev") in ("lan", "online"):
                if best is None or g["date"] > best[0]:
                    best = (g["date"], g["ev"])
                break
    return best[1] if best else None


def veto_top(vw, bo=3):
    """Owner rule (Nov 24): best-of-3 (and Bo1) -> keep the 3 most likely maps from the veto estimate; best-of-5 -> 5.
    Their weights are renormalized to sum to 1."""
    k = 5 if (bo or 3) >= 5 else 3
    top = sorted(vw.items(), key=lambda x: (-x[1], x[0]))[:k]
    tw = sum(w for _, w in top) or 1.0
    return {m: w / tw for m, w in top}


def likely_maps(f):
    """[map, share %] of the top-3 (Bo5: top-5) veto maps; the shares sum to 100."""
    vt = f.get("veto_top") or {}
    rows = sorted(vt.items(), key=lambda x: -x[1])
    return [[m, round(100 * w)] for m, w in rows]


class ScoutGrader:
    """Shadow S: the Scout-style factor projection with the coefficients saved in scout_params.json."""
    def __init__(self, gr, players=None, params=None):
        self.gr = gr
        self.cfg = params if params is not None else load_params()
        self.S = ScoutData(players if players is not None else gr.players, gr) if self.cfg else None

    def P(self, per, st):
        c = self.cfg or {}
        P = dict(DEF, **(c.get("hyper") or {}), **(c.get("rounds") or {}))
        P.update((c.get("coefs") or {}).get("%s|%s" % (per, st)) or {})
        return P

    def best_of(self, team, opp):
        """Match format from games.json (bo field) for this pair; 3 when unknown."""
        if not hasattr(self, "_games"):
            import json
            try:
                self._games = json.load(open("games.json", encoding="utf-8")).get("games") or []
            except Exception:
                self._games = []
        for g in self._games:
            if (teq(g.get("team1"), team) and teq(g.get("team2"), opp)) or (teq(g.get("team2"), team) and teq(g.get("team1"), opp)):
                if isinstance(g.get("bo"), int):
                    return g["bo"]
        return 3

    def project(self, p, st, team, opp, day, period=None, ev=None, bo=3):
        per = "Map 1" if is_map1(period) else "Maps 1-2"
        P = self.P(per, st)
        f = features(self.S, p, team, opp, day, per, ev, P, bo)
        if not f:
            return None, None, None
        mu, steps = project(f, st, P)
        return mu, f, steps

    def grade_entry(self, e, day=None):
        """Shadow grade for one lines_history entry (single player or combo). Returns a dict, or {"skipped": reason}."""
        if not self.cfg or self.S is None:
            return {"skipped": "scout_params.json missing"}
        stl = str(e.get("stat", "")).lower()
        st = "hs" if "head" in stl else "kills" if "kill" in stl else None
        if not st:
            return {"skipped": "stat not graded"}
        line = float((e.get("lock") or {}).get("line", e["line"]))
        day = day or str(e.get("start", ""))[:10]
        team, opp = e.get("team"), e.get("opponent") or ""
        ev = infer_ev(self.S, team, opp, day)
        bo = self.best_of(team, opp)
        names = [x.strip() for x in str(e["player"]).split("+") if x.strip()]
        mu, f0, steps0 = 0.0, None, None
        for n in names:
            p = self.gr.find(n, team)
            if not p:
                return {"skipped": "player not in data: " + n}
            cs = [c for c in self.gr.series(p, e.get("period")) if c["date"] < day]
            if len(cs) < 5:
                return {"skipped": "%s: only %d earlier %s (need 5)" % (n, len(cs), "Map 1 maps" if is_map1(e) else "series")}
            m, f, steps = self.project(p, st, team, opp, day, e.get("period"), ev, bo)
            if m is None:
                return {"skipped": "no usable maps for " + n}
            mu += m
            if f0 is None:
                f0, steps0 = f, steps
        r = self.gr._v1_result(mu, line, st, e.get("book"), e.get("odds"))
        out = {"model": MODEL, "line": line, "proj": round(mu, 1), "edge": round(mu - line, 1),
               "edge_pct": round((mu - line) / line, 4) if line else None, "grade": r["grade"], "pick": r["pick"],
               "period": "Map 1" if is_map1(e) else "Maps 1-2", "ev": ev}
        if len(names) == 1:
            f = f0
            out["steps"] = [[lbl, round(v, 2)] for lbl, v in steps0]
            out["inputs"] = {"kpr": round(f["kpr"], 3), "kpr_szn": round(f["kpr_szn"], 3), "kpr_recent": round(f["kpr_dec"], 3),
                             "kpr_h2h": None if f["kpr_h2h"] is None else round(f["kpr_h2h"], 3), "h2h_maps": f["n_h2h_maps"],
                             "rounds_per_map": round(f["rd_hat"], 1), "maps": f["nmaps"],
                             "hs_per_kill": round(f["hspk"], 3) if st == "hs" else None,
                             "opp_gives_up": None if f["conc_opp"] is None else round(f["conc_opp"], 3),
                             "opps_faced": None if f["sos"] is None else round(f["sos"], 3),
                             "maps_in_sample": f["n_maps_sample"], "team_win_elo": round(f["pw"], 3)}
            out["likely_maps"] = likely_maps(f)
            out["bo"] = bo
        else:
            out["combo"] = True
        return out



def project(f, st, P=None):
    """Candidate projection from features() and coefficients; returns (mu, breakdown)."""
    P = dict(DEF, **(P or {}))
    base = f["kpr"] * f["rd_hat"] * f["nmaps"]
    if st == "hs":
        base *= f["hspk"]
    steps = [("Form: kills per round x expected rounds x maps" + (" x headshots per kill" if st == "hs" else ""), base)]
    lm = math.log(base) + P["b0"]
    mu = math.exp(lm)
    if P["b0"]:
        steps.append(("Calibration", mu - base))
    for k, label in (("lan", "LAN / online"), ("opp", "Opponent"), ("maps", "Likely maps"), ("mapr", "Map rounds"), ("elo", "Elo")):
        b = P["b_" + k]
        if b:
            lm += b * f["x_" + k]
            new = math.exp(lm)
            steps.append((label, new - mu))
            mu = new
    return mu, steps
