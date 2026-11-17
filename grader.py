"""Grader v2: probability-based grades for CS2 Maps 1-2 kills / headshots props.

Python copy of model.js (the site uses model.js). Keep the two in step: parity_check.py compares them.
Only uses players.json (per-map logs + ranks). No network.

How a prop is graded
  1. Per-round rate: the player's kills (or HS) per round over his recent Map 1+2 series, with exponentially
     decaying weights (one window, no overlapping "recent/career/form" parts), shrunk toward his team's pooled
     per-player rate with PARAMS m rounds of prior weight. The team rate is itself shrunk to a global rate.
  2. Strength: map Elo is built from every map result in players.json (rounds won vs rounds played).
     Win chance p vs this opponent changes the per-round rate (1 + beta * (p - player's usual p)) and the
     expected rounds per map (close matches go longer: rounds = a + b * p * (1 - p)).
  3. H2H is only used with 3+ earlier meetings, and only as a small blend.
  4. Projection mu = rate * adj * expected rounds (2 maps), optionally blended with the line (w).
  5. P(over) from a negative binomial with mean mu and a per-stat dispersion fitted by backtest.py.
  6. Grade by edge in percentage points over the book's break-even: A >= +6pp, B >= +3pp, else PASS.
     Break-even comes from the line's odds when stored, else the book default.
  7. Filters (PASS with a reason): fewer than 8 earlier series, player not on the line's team,
     player missed 2+ of his team's last 3 series (stand-in / roster change).
"""
import re, math, bisect

# ---- model parameters. Tuned by backtest.py on the early slice only. MUST match PARAMS in model.js.
PARAMS = {"m": 100, "half_life": 8, "n_max": 20, "m_team": 1500, "elo_k": 16, "beta": 0.25,
          "rd_a": 17.34, "rd_b": 16.18, "h2h_min": 3, "h2h_w": 0.0, "w_line": 1.0,
          "g_kills": 0.6573, "g_hs": 0.3404, "size_kills": 20.0, "size_hs": 16.0,
          "min_series": 8, "grade_a": 6.0, "grade_b": 3.0}
# w_line = weight on the book line in the mean used for P(over). backtest.py fit it on the earliest locked lines
# (Nov 13-14 2026, 16 matches): the line alone scored best (w=1.0), i.e. the model has not shown it adds
# information beyond the line yet, so v2 grades nearly everything PASS. Re-run `python backtest.py --tune`
# as locked v2 picks pile up and lower w_line (here AND in model.js) only if the holdout supports it.
BOOK_BE = {"prizepicks": 0.577, "underdog": 0.53}   # break-even per pick when no odds are stored
DEFAULT_BE = 0.577                                  # unknown book / manual line: assume PrizePicks
MODEL_VERSION = "v2"

ALIASES = {"4Z": "EP.-4Z", "Ag1l": "agl"}
# Book / bo3.gg team-name variants (keys and values are tn() keys). Same table in model.js.
TEAM_ALIASES = {"betm33": "33", "wraithpcific": "pcific", "lowcortisolbr": "lowcortisol", "lifesagame": "lag"}


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def canon(s):
    k = norm(s)
    for a, b in (("0", "o"), ("1", "i"), ("3", "e"), ("4", "a"), ("5", "s"), ("7", "t")):
        k = k.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", k)


_SKIP = {"team", "esports", "esport", "gaming", "club"}


def tn(s):
    k = "".join(w for w in re.split(r"[^a-z0-9]+", str(s or "").lower()) if w and w not in _SKIP)
    return TEAM_ALIASES.get(k, k)


def teq(a, b):
    a, b = tn(a), tn(b)
    return bool(a) and a == b


def mean(a):
    return sum(a) / len(a) if a else None


def american_be(odds):
    """Break-even win rate for American odds (-137 -> 0.578). None if not usable."""
    try:
        o = float(odds)
    except (TypeError, ValueError):
        return None
    if o <= -100:
        return -o / (-o + 100.0)
    if o >= 100:
        return 100.0 / (o + 100.0)
    return None


def break_even(book=None, odds=None):
    be = american_be(odds)
    if be is not None:
        return be
    return BOOK_BE.get(norm(book), DEFAULT_BE)


def winp(ra, rb):
    return 1.0 / (1.0 + 10.0 ** ((rb - ra) / 400.0))


def nb_probs(mu, size, line):
    """(P(X > line), P(X == line), P(X < line)) for a negative binomial with mean mu and size (dispersion)."""
    if mu <= 0:
        return 0.0, (1.0 if line == 0 else 0.0), (1.0 if line > 0 else 0.0)
    q = size / (size + mu)
    pk = q ** size  # P(X=0)
    fl = int(math.floor(line))
    below = 0.0
    eq = 0.0
    for k in range(0, fl + 1):
        if k == line:
            eq = pk
        elif k < line:
            below += pk
        pk = pk * (k + size) / (k + 1.0) * (1.0 - q)
    over = max(0.0, 1.0 - below - eq)
    return over, eq, below


def p_over_np(mu, size, line):
    """P(over) with pushes taken out (an integer line that lands exactly is a push)."""
    o, e, u = nb_probs(mu, size, line)
    return o / max(1e-12, 1 - e)


def line_mean(line, size):
    """Mean the book is implicitly pricing: the NB mean that makes the line a 50/50 (lines are medians, not means)."""
    lo, hi = 0.0, 2.0 * line + 10.0
    for _ in range(50):
        mid = (lo + hi) / 2.0
        if p_over_np(mid, size, line) < 0.5:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def blend_mean(mu, line, size, w):
    return mu if w <= 0 else w * line_mean(line, size) + (1 - w) * mu


class Grader:
    def __init__(self, players, ranks=None, params=None):
        self.players = players
        self.ranks = ranks or {}
        self.P = dict(PARAMS, **(params or {}))
        self.exact, self.canon = {}, {}
        for p in players:
            self.exact.setdefault(norm(p["name"]), []).append(p)
            self.canon.setdefault(canon(p["name"]), []).append(p)
        self._memo = {}
        self._series = {}
        self._build()

    # ---- name matching. With a team, only players on that team (aliases applied) can match.
    def find(self, name, team=None):
        mk = (norm(name), norm(team or ""))
        if mk in self._memo:
            return self._memo[mk]
        nl = lambda p: len(p.get("logs") or [])
        best = lambda a: sorted(a, key=nl, reverse=True)[0] if a else None
        on_team = (lambda a: [p for p in a if teq(p.get("team"), team)]) if team else (lambda a: a)
        k, r = norm(name), None
        ex = self.exact.get(k)
        if ex:
            r = best(on_team(ex))
        if not r and name in ALIASES:
            r = best(on_team(self.exact.get(norm(ALIASES[name])) or []))
        if not r and len(k) >= 3:
            pool = on_team(self.canon.get(canon(name)) or [])
            if len(pool) == 1:
                r = pool[0]
        if not r and team:
            c = canon(name)
            cand = []
            for p in self.players:
                if not teq(p.get("team"), team) or nl(p) < 6:
                    continue
                d = canon(p["name"])
                sh, lo = (d, c) if len(d) < len(c) else (c, d)
                if len(sh) >= 4 and sh in lo:
                    cand.append(p)
            if len(cand) == 1:
                r = cand[0]
        self._memo[mk] = r
        return r

    # ---- one row per series where both Map 1 and Map 2 were logged, newest first (same as app.js combos)
    def combos(self, p, logs=None):
        by = {}
        for l in (p.get("logs") if logs is None else logs) or []:
            if l.get("n") in (1, 2) and l.get("mid") is not None:
                g = by.setdefault(l["mid"], {"mid": l["mid"], "date": l.get("date"), "opp": l.get("opp"), "m": {}, "kills": 0, "hs": 0,
                                             "hsOk": True, "rd": 0, "rdOk": True, "adr": []})
                g["m"][l["n"]] = l.get("map")
                g["kills"] += float(l.get("kills") or 0)
                if l.get("hs") is None:
                    g["hsOk"] = False
                else:
                    g["hs"] += float(l.get("hs") or 0)
                if l.get("rd") is None or l["rd"] < 13:
                    g["rdOk"] = False
                else:
                    g["rd"] += float(l["rd"])
                if l.get("adr") is not None:
                    g["adr"].append(float(l["adr"]))
        out = []
        for g in by.values():
            if 1 in g["m"] and 2 in g["m"]:
                out.append({"mid": str(g["mid"]), "date": g["date"] or "", "opp": g["opp"], "kills": g["kills"],
                            "hs": g["hs"] if g["hsOk"] else None, "rd": g["rd"] if g["rdOk"] else None,
                            "adr": (sum(g["adr"]) / len(g["adr"])) if g["adr"] else None})
        out.sort(key=lambda c: (c["date"], c["mid"]), reverse=True)
        return out

    def series(self, p):
        k = id(p)
        if k not in self._series:
            self._series[k] = self.combos(p)
        return self._series[k]

    # ---- Elo per map from every logged map result, plus team pooled rates (both as dated histories)
    def _build(self):
        maps, seen = [], set()
        team_rows = {}
        self.team_mids = {}
        for p in self.players:
            t = tn(p.get("team"))
            for l in p.get("logs") or []:
                rd, rw = l.get("rd"), l.get("rw")
                key = str(l.get("mid")) + "|" + str(l.get("n"))
                if isinstance(rd, (int, float)) and isinstance(rw, (int, float)) and rd >= 13 and rw * 2 != rd and key not in seen:
                    seen.add(key)
                    maps.append((l.get("date") or "", float(l.get("mid") or 0), int(l.get("n") or 0), t, tn(l.get("opp")), 1.0 if rw * 2 > rd else 0.0))
            for c in self.series(p):
                self.team_mids.setdefault(t, []).append((c["date"], c["mid"]))
                if c["rd"]:
                    team_rows.setdefault(t, []).append((c["date"], c["kills"], c["hs"] if c["hs"] is not None else 0.0, c["rd"]))
        for t in self.team_mids:
            self.team_mids[t].sort(reverse=True)
        maps.sort(key=lambda m: (m[0], m[1], m[2]))
        K = self.P["elo_k"]
        R, self.elo_hist = {}, {}
        for d, _, _, a, b, s in maps:
            ra, rb = R.get(a, 1500.0), R.get(b, 1500.0)
            e = winp(ra, rb)
            R[a] = ra + K * (s - e)
            R[b] = rb - K * (s - e)
            self.elo_hist.setdefault(a, ([], []))
            self.elo_hist.setdefault(b, ([], []))
            for t, v in ((a, R[a]), (b, R[b])):
                self.elo_hist[t][0].append(d)
                self.elo_hist[t][1].append(v)
        self.maps = maps
        self.team_cum = {}
        for t, rows in team_rows.items():
            rows.sort()
            ds, ck, ch, cr = [], [0.0], [0.0], [0.0]
            for d, k, h, r in rows:
                ds.append(d)
                ck.append(ck[-1] + k)
                ch.append(ch[-1] + h)
                cr.append(cr[-1] + r)
            self.team_cum[t] = (ds, ck, ch, cr)

    def elo(self, team, before="9999"):
        h = self.elo_hist.get(tn(team))
        if not h:
            return 1500.0
        i = bisect.bisect_left(h[0], before)
        return h[1][i - 1] if i > 0 else 1500.0

    def team_prior(self, team, st, before="9999"):
        P = self.P
        g = P["g_kills"] if st == "kills" else P["g_hs"]
        c = self.team_cum.get(tn(team))
        if not c:
            return g
        i = bisect.bisect_left(c[0], before)
        num = (c[1] if st == "kills" else c[2])[i]
        return (num + P["m_team"] * g) / (c[3][i] + P["m_team"])

    def team_last_mids(self, team, before="9999", n=3):
        """The team's last n series (Map 1+2 logged) before the date, newest first."""
        rows = self.team_mids.get(tn(team)) or []
        out = []
        for d, m in rows:
            if d < before and m not in out:
                out.append(m)
                if len(out) >= n:
                    break
        return out

    # ---- projection for one player (no line): mean of Maps 1-2 stat and the details behind it
    def project(self, p, st, opp, team=None, before="9999"):
        P = self.P
        team = team or p.get("team")
        cs = [c for c in self.series(p) if c["date"] < before]
        rows = [c for c in cs if c["rd"] and c.get(st) is not None][:P["n_max"]]
        if not rows:
            return None
        prior = self.team_prior(team, st, before)
        sk = sr = sw = sp = 0.0
        for i, c in enumerate(rows):
            w = 0.5 ** (i / P["half_life"])
            sk += w * c[st]
            sr += w * c["rd"]
            sw += w
            sp += w * winp(self.elo(team, c["date"]), self.elo(c["opp"], c["date"]))
        rate = (sk + P["m"] * prior) / (sr + P["m"])
        h2h = [c for c in rows if opp and teq(c["opp"], opp)]
        if len(h2h) >= P["h2h_min"] and P["h2h_w"] > 0:
            hr = (sum(c[st] for c in h2h) + P["m"] * rate) / (sum(c["rd"] for c in h2h) + P["m"])
            rate = (1 - P["h2h_w"]) * rate + P["h2h_w"] * hr
        pbar = sp / sw
        et, eo = self.elo(team, before), (self.elo(opp, before) if opp else None)
        pw = winp(et, eo) if eo is not None else pbar
        adj = 1 + P["beta"] * (pw - pbar)
        rounds = 2 * (P["rd_a"] + P["rd_b"] * pw * (1 - pw))
        mu = rate * adj * rounds
        return {"mu": mu, "rate": rate, "prior": prior, "adj": adj, "pwin": pw, "pbar": pbar, "rounds": rounds,
                "n": len(cs), "n_rate": len(rows), "h2h": len(h2h), "cs": cs}

    def filters(self, p, team, n, before="9999"):
        P = self.P
        out = []
        if team and not teq(p.get("team"), team):
            out.append("player is not on " + str(team) + " in the data")
        if n < P["min_series"]:
            out.append("only %d earlier Map 1+2 series (need %d)" % (n, P["min_series"]))
        last = self.team_last_mids(p.get("team"), before)
        mine = {c["mid"] for c in self.series(p) if c["date"] < before}
        if len(last) >= 3 and sum(1 for m in last if m in mine) < 2:
            out.append("missed 2+ of the team's last 3 series (stand-in or roster change)")
        return out

    def finish(self, mu, line, st, book=None, odds=None, reasons=None, size=None):
        P = self.P
        size = size or (P["size_kills"] if st == "kills" else P["size_hs"])
        mu_f = blend_mean(mu, line, size, P["w_line"])
        over, eq, under = nb_probs(mu_f, size, line)
        nopush = max(1e-12, 1 - eq)
        po, pu = over / nopush, under / nopush
        be = break_even(book, odds)
        pick = "OVER" if po >= pu else "UNDER"
        pp = max(po, pu)
        epp = (pp - be) * 100
        reasons = list(reasons or [])
        g = "A" if epp >= P["grade_a"] else "B" if epp >= P["grade_b"] else "PASS"
        if reasons:
            g = "PASS"
        # proj / edge show the model's own number; the probabilities use the line-blended mean
        return {"proj": round(mu, 1), "mu_model": round(mu, 2), "mu_blend": round(mu_f, 2), "edge": round(mu - line, 1), "grade": g, "pick": pick,
                "p_over": round(po, 4), "p_push": round(eq, 4), "p_pick": round(pp, 4), "be": round(be, 4),
                "edge_pp": round(epp, 2), "reasons": reasons, "model": MODEL_VERSION}

    def grade(self, p, st, line, opp, team=None, book=None, odds=None, before="9999"):
        if line is None or (isinstance(line, float) and math.isnan(line)):
            return None
        pr = self.project(p, st, opp, team or p.get("team"), before)
        if not pr:
            return None
        r = self.finish(pr["mu"], float(line), st, book, odds, self.filters(p, team, pr["n"], before))
        r.update({"n": pr["n"], "rounds": round(pr["rounds"], 1), "pwin": round(pr["pwin"], 3), "rate": round(pr["rate"], 4)})
        return r

    def grade_combo(self, name, team, st, line, opp, book=None, odds=None, before="9999"):
        """Combo prop "A + B + C": sum of each player's projection; teammates move together, so the
        variance is taken as fully linked (size of one player's distribution, applied to the sum)."""
        names = [n.strip() for n in str(name).split("+") if n.strip()]
        if len(names) < 2:
            return None
        mu, reasons, nmin = 0.0, [], 999
        for n in names:
            p = self.find(n, team)
            if not p:
                return None
            pr = self.project(p, st, opp, team or p.get("team"), before)
            if not pr:
                return None
            mu += pr["mu"]
            nmin = min(nmin, pr["n"])
            reasons += [n + ": " + x for x in self.filters(p, team, pr["n"], before)]
        r = self.finish(mu, float(line), st, book, odds, reasons)
        r["n"] = nmin
        return r
