"""Grader v2: probability-based grades for CS2 Maps 1-2 kills / headshots props.

Python copy of model.js (the site uses model.js). Keep the two in step: parity_check.py compares them.
Uses players.json (per-map logs + ranks) and, when present, team_strength.json (Cito-derived, see cito_update.py). No network.

How a prop is graded (active grader for new locks)
  1. v1 projection, same as grader_legacy.py: 35% last 10 Maps 1-2 series, 20% all logged series,
     20% head-to-head vs the opponent (from the first meeting), 15% vs teams of the same rank tier
     (ordinal ranks from players.json at grade time), 10% last 3 series. Missing pieces are dropped
     and the rest are renormalized. Then a small ADR form adjustment (capped at 5%).
     Only series dated strictly before `before` (the match day when provided) are used.
  2. Letter from the projection edge pct = (proj - line) / line, live v1 cutoffs (no shadow shift):
       A+ = pct >= +0.15, B >= +0.05, C >= -0.02, D >= -0.10, else F.
       Pick = OVER if proj >= line, else UNDER. No plain A, no E, no hit-rate letter override.
  3. v2 Under break-even rule (does not change the pick): when the v1 pick is Under and the v1 letter
     is D or F, compute a negative-binomial P(under) from the 1-decimal projection blended 0.7 toward
     the line (the shipped w_line), vs break-even from stored odds or the book default.
     F if P(under) - BE >= +3pp (grade_f); else D.
  4. Filters and the bait flag are display-only; they do not change the letter or pick.
  Already-locked props keep the letter stored on the lock; this path is for new grades only.
"""
import re, math, bisect

# ---- model parameters. Tuned by backtest.py on the early slice only. MUST match PARAMS in model.js.
HS_WIN = ("5", "10", "20", "szn")   # headshots-projection HS% windows
KHS_WIN = ("5", "10", "15", "szn")  # kills-projection HS% factor windows (no L20)
PARAMS = {"m": 100, "half_life": 8, "n_max": 200, "m_team": 1500, "elo_k": 16, "beta": 0.25,
          "rd_a": 17.34, "rd_b": 16.18, "h2h_min": 1, "h2h_w": 0.1, "w_line": 0.7,
          "g_kills": 0.6573, "g_hs": 0.3404, "size_kills": 20.0, "size_hs": 16.0,
          "min_series": 8, "grade_a": 4.0, "grade_b": 0.0, "grade_f": 3.0,
          "w_rank": 0.25, "rank_s": 1.0, "w_maps": 0.25, "k_maps": 6.0, "w_hr": 0.0, "k_hr": 5.0, "w_hr_l5": 0.25, "w_hr_l10": 0.25, "w_hr_l20": 0.25, "w_hr_szn": 0.25,
          "hr_upgrade_a": 0.0, "hr_upgrade_b": 0.0, "hr_szn_min": 8,
          "w_l5": 0.1, "w_l10": 0.05, "w_l20": 0.05, "w_szn": 0.05, "w_kd": 0.1, "k_kd": 40.0,
          "w_hs5": 0.3, "w_hs10": 0.2, "w_hs20": 0.15, "w_hsszn": 0.1,
          "w_khs5": 0.1, "w_khs10": 0.05, "w_khs15": 0.025, "w_khsszn": 0.0, "k_hsp": 30.0, "w_hkd": -0.1}
# Kill-model form inputs (kills props only; series before the match only; tuned by backtest.py --tune-form):
#   w_l5 / w_l10 / w_l20 / w_szn: the per-round kill rate moves toward the player's raw rate over his last 5 / 10 / 20
#           series / this season: rate += w * (window rate - rate). 0 = not used.
#   w_hkd: the same season K/D factor on the headshots projection (hs rate x kd ** w_hkd).
#   w_kd: kill rate x kd ** w_kd, kd = season (kills + k_kd) / (deaths + k_kd) (shrunk toward 1). 0 = not used.
#   Backtest (Nov 2026): every non-zero weight made kills MAE, NB log-lik and locked-line log loss slightly worse (tuned
#   value 0). By owner decision w_l5 0.1, w_l10 0.1 and w_kd 0.1 ship anyway (small, active; full season stays the base).
# HS% form inputs (HS% = hs / kills, Maps 1-2 series before the match only; tuned by backtest.py --tune-hs):
#   shrunk HS%: season = (HS + k_hsp * team HS%) / (K + k_hsp); last 5 / 10 / 15 / 20 = (HS + k_hsp * season HS%) / (K + k_hsp)
#   w_hs5 / w_hs10 / w_hs20 / w_hsszn (headshots): hs rate += w * (player kill rate x shrunk HS% - hs rate)
#   w_khs5 / w_khs10 / w_khs15 / w_khsszn (kills): kill rate x (shrunk HS% / reference) ** w, reference = season HS%
#           for the last-N windows and team HS% for the season window. 0 = not used.
#   Backtest (Nov 2026, early-slice tuning, holdout from 2026-10-20): headshots MAE 3.997 -> 3.974, NB log-lik -3.0211 ->
#   -3.0151, so w_hs5 0.3 / w_hs10 0.2 / w_hsszn 0.1 ship. The kills weights were tuned to ~0 (holdout slightly worse);
#   by owner decision w_khs5 0.1 ships (the closest-to-neutral non-zero value). w_hkd -0.1 (best non-zero; +0.1 was worse).
#   Nov 17 2026 (owner): projections use only last 5 / 10 / 20 + season; L15 is display-only (kpm / HS% / hit-rate cards).
#   w_hs20 0.15 added (headshots: holdout MAE 3.908 -> 3.907, early 3.905 -> 3.903, locked hs lines Brier .2516 -> .2515).
#   Kills: w_l10 0.1 split into w_l10 0.05 + w_l20 0.05 (holdout MAE 6.277 -> 6.275, locked kills lines Brier .2552 -> .2551).
#   Kills HS% factor uses L5 / L10 / L15 + season (KHS_WIN, owner: no L20): w_khs5 0.1, w_khs10 0.05, w_khs15 0.025 (least
#   harmful ladder tried: kills holdout MAE 6.2745 -> 6.2750, locked kills lines Brier unchanged .2551).
#   h2h_min 1 (owner, Nov 17: any prior Maps 1-2 meeting counts). The h2h rate is shrunk toward the player rate with m=100
#   rounds, then weighted h2h_w 0.1: ~3% raw h2h share after 1 series (~42 rounds), ~4.6% after 2, ~5.6% after 3.
#   w_szn 0.05 (owner, Nov 17: season must count for kills; raw season per-round rate, applied after L5/L10/L20).
#   Backtest vs 0: kills holdout MAE 6.2717 -> 6.2705, real lines Brier .25241 -> .25239, picks 283 -> 284 hits of 630.
#   h2h_w 0.1 (owner: use head-to-head; h2h_min 3 series, Maps 1-2, rate vs this opponent shrunk toward the player rate
#   with m): locked lines Brier .25340 -> .25339, kills holdout MAE +0.0003; 0.05-0.2 and h2h_min 2/3/5 all within noise.
# n_max 200: the rate uses every series this season (players.json holds the full calendar-year season), decayed with
#   half_life 8; it was 20 when players.json held only the last 15 matches per team.
# Hit rates vs the current line (L5 / L10 / L20 / season / H2H, series-level Maps 1-2, earlier series only).
#   w_hr: weight of a decayed, shrunk hit rate blended into P(over): P = (1 - w_hr) * P_model + w_hr * hr, where
#         hr = (sum w_i * over_i + k_hr * 0.5) / (sum w_i + k_hr) over the last n_max series (pushes left out,
#         w_i = 0.5 ** (i / half_life)). 0 = shown on the site but not used in the grade. Chosen by backtest.py
#         (walk-forward on the earlier locked lines, checked on the later ones).
# Hit-rate letter override (separate from w_hr; w_hr stays 0). w_hr_l5 / w_hr_l10 / w_hr_l20 / w_hr_szn: weights
#   of the L5 / L10 / L20 / season over-rate vs the current line, averaged (a window with 0 series is skipped).
#   Default 0.25 each. L20 is computed for this even though prop cards display L15. hr_upgrade_a / hr_upgrade_b:
#   The letter override is OFF (hr_upgrade_a / hr_upgrade_b are 0). Thresholds 0 = off.
#   hr_szn_min: season needs this many series or the override does not fire (low-sample flag).
# Cito features (only active when team_strength.json is present; with no file the grader is exactly as before):
#   w_rank: weight of the ranking win chance (dated VRS + world points, latest list strictly before the match day)
#           blended into the Elo win chance. rank_s: exponent in p = pa^s / (pa^s + pb^s).
#   w_maps: weight of the map-pool expected rounds (team map stats, snapshot dated strictly before the match day)
#           blended into the Elo-based expected rounds. k_maps: maps of prior weight (shrinks small samples to the Elo value).
#   Set w_rank / w_maps to 0 to switch either feature off. 0.25 is a cautious starting weight, NOT tuned on real data
#   (no Cito key yet). The mock backtest (synthetic data built from players.json, so it cannot add information) only
#   tests the plumbing. Re-tune with python backtest.py --tune once team_strength.json has 3-4 weeks of real snapshots.
# w_line = weight on the book line in the mean used for P(over). backtest.py fit it on the earliest locked lines
# (Nov 13-14 2026, 16 matches): the line alone scored best (w=1.0), i.e. the model has not shown it adds
# information beyond the line yet, so v2 grades nearly everything C or D (slight leans, below break-even). Re-run `python backtest.py --tune`
# as locked v2 picks pile up and lower w_line (here AND in model.js) only if the holdout supports it.
BOOK_BE = {"prizepicks": 0.577, "underdog": 0.53}   # break-even per pick when no odds are stored
DEFAULT_BE = 0.577                                  # unknown book / manual line: assume PrizePicks
MODEL_VERSION = "v1be"

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


def letter(pick, epp, P=PARAMS):
    """A+ / B / C = Over (strongest to weakest), D / F = Under (F = take the Under)."""
    if pick == "OVER":
        return "A+" if epp >= P["grade_a"] else "B" if epp >= P["grade_b"] else "C"
    return "F" if epp >= P.get("grade_f", P["grade_b"]) else "D"


# Shipped line blend used only for the Under D/F break-even rule (kept at 0.7 even if PARAMS["w_line"] is overridden).
V1_UNDER_W_LINE = 0.7


def round1(x):
    """One decimal, half away from zero (same as JS Math.round(x*10)/10).
    A tiny epsilon absorbs binary-float noise around a *.x5 boundary (e.g. 27.75 stored as 27.749999999999996)."""
    return math.floor(x * 10 + 0.5 + 1e-8) / 10.0 if x >= 0 else math.ceil(x * 10 - 0.5 - 1e-8) / 10.0


def v1_shade(proj, line):
    """Live v1 cutoffs from grader_legacy.py (GRADER_MODE != "shadow"): letter and pick from (proj-line)/line."""
    if line is None or (isinstance(line, float) and math.isnan(line)) or float(line) == 0:
        return None, None
    edge = proj - float(line)
    pct = edge / float(line)
    g = "A+" if pct >= .15 else "B" if pct >= .05 else "C" if pct >= -.02 else "D" if pct >= -.10 else "F"
    pick = "OVER" if edge >= 0 else "UNDER"
    return g, pick


def under_be_letter(grade, pick, proj, line, st, book, odds, P=None):
    """When pick is Under and letter is D or F: F if NB P(under)-BE >= +3pp, else D. Pick is unchanged.
    Mean is the 1-decimal projection blended with V1_UNDER_W_LINE (0.7). Same rule as the lock-time backtest."""
    P = P or PARAMS
    if pick != "UNDER" or grade not in ("D", "F"):
        return grade, pick, None, None, None
    size = P["size_kills"] if st == "kills" else P["size_hs"]
    mu = round1(float(proj))
    mu_f = blend_mean(mu, float(line), size, V1_UNDER_W_LINE)
    over, eq, under = nb_probs(mu_f, size, float(line))
    pu = under / max(1e-12, 1 - eq)
    be = break_even(book, odds)
    epp_u = (pu - be) * 100
    g = "F" if epp_u >= float(P.get("grade_f") or 3.0) else "D"
    return g, pick, epp_u, be, pu


HR_BLEND_WINS = (("l5", 5, "w_hr_l5"), ("l10", 10, "w_hr_l10"), ("l20", 20, "w_hr_l20"), ("szn", None, "w_hr_szn"))


def hitrate_upgrade(hits, P=PARAMS):
    """Equal-weight (by default) blend of L5 / L10 / L20 / season over-rates. Returns
    (blend or None, upgrade letter or None, extra reason strings). Upgrade is off when
    both thresholds are 0 (so a checkout compared to an older grader stays identical)."""
    reasons = []
    if not hits or not (float(P.get("hr_upgrade_a") or 0) > 0 or float(P.get("hr_upgrade_b") or 0) > 0):
        return None, None, reasons
    szn_n = int((hits.get("szn") or [0, 0])[1] or 0)
    szn_min = int(P.get("hr_szn_min") or 8)
    if szn_n < szn_min:
        reasons.append("only %d season series vs this line (need %d for the hit-rate grade)" % (szn_n, szn_min))
        return None, None, reasons
    num = den = 0.0
    thin = []
    for key, need, wk in HR_BLEND_WINS:
        w = float(P.get(wk) or 0)
        if w <= 0:
            continue
        v = hits.get(key) or [0, 0]
        n = int(v[1] or 0)
        if n <= 0:
            continue
        num += w * (float(v[0]) / n)
        den += w
        if need and n < need:
            thin.append("%s %d" % (key.upper(), n))
    if den <= 0:
        return None, None, reasons
    blend = num / den
    if thin:
        reasons.append("thin hit-rate windows (" + ", ".join(thin) + ")")
    up = None
    if blend >= float(P["hr_upgrade_a"]):
        up = "A+"
    elif blend >= float(P["hr_upgrade_b"]):
        up = "B"
    return blend, up, reasons


# ---- players.json storage. fmt 2 (compact) keeps a whole season small enough for the site (Workers assets <= 25 MiB):
# each log is one array in LOG_COLS order; text columns are indexes into a shared string table "s"; "x" (extra per-map
# stats) is an array in XCOLS order. decode_players turns it back into the usual {"players":[{"name","team","logs":[{...}]}]}.
# The same decoder is decodePlayers in model.js (the site). Old files without "fmt" are read as they are.
LOG_COLS = ["date", "mid", "n", "map", "opp", "kills", "hs", "d", "a", "adr", "rd", "rw", "ev", "x"]
STR_COLS = ("date", "map", "opp", "ev")


def _rnd(v, k):
    return round(v, k) if isinstance(v, float) else v


def encode_players(data):
    """Plain players data -> fmt 2. adr is rounded to 2 decimals and extra stats to 3 (display only, not graded)."""
    strings, sidx = [], {}

    def si(v):
        if v is None:
            return None
        v = str(v)
        if v not in sidx:
            sidx[v] = len(strings)
            strings.append(v)
        return sidx[v]
    xcols = sorted({k for p in data.get("players", []) for l in p.get("logs") or [] for k in (l.get("x") or {})})
    out = {k: v for k, v in data.items() if k != "players"}
    out.update({"fmt": 2, "cols": LOG_COLS, "xcols": xcols, "players": []})
    for p in data.get("players", []):
        rows = []
        for l in p.get("logs") or []:
            r = []
            for c in LOG_COLS:
                v = l.get(c)
                if c in STR_COLS:
                    v = si(v)
                elif c == "adr":
                    v = _rnd(v, 2)
                elif c == "x":
                    v = [_rnd(v.get(k), 3) for k in xcols] if isinstance(v, dict) and v else None
                r.append(v)
            while r and r[-1] is None:
                r.pop()
            rows.append(r)
        q = {k: v for k, v in p.items() if k != "logs"}
        q["rows"] = rows
        out["players"].append(q)
    out["s"] = strings
    return out


def decode_players(data):
    """fmt 2 -> plain players data (logs as dicts; missing / null fields are left out). Plain data is returned as is."""
    if not isinstance(data, dict) or data.get("fmt") != 2:
        return data
    S, cols, xcols = data.get("s") or [], data.get("cols") or LOG_COLS, data.get("xcols") or []
    out = {k: v for k, v in data.items() if k not in ("fmt", "cols", "xcols", "s", "players")}
    out["players"] = []
    for p in data.get("players", []):
        logs = []
        for r in p.get("rows") or []:
            l = {}
            for i, v in enumerate(r):
                if v is None:
                    continue
                c = cols[i]
                if c in STR_COLS:
                    v = S[v]
                elif c == "x":
                    v = {k: x for k, x in zip(xcols, v) if x is not None}
                    if not v:
                        continue
                l[c] = v
            logs.append(l)
        q = {k: v for k, v in p.items() if k != "rows"}
        q["logs"] = logs
        out["players"].append(q)
    return out


def load_players(path="players.json"):
    """players.json (either format) as plain data: {"players": [{"name", "team", "logs": [...]}], "ranks": {...}, ...}."""
    import json
    with open(path, encoding="utf-8") as f:
        return decode_players(json.load(f))


def save_players(data, path="players.json"):
    import json
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(encode_players(data), f, separators=(",", ":"), ensure_ascii=False)
    import os
    os.replace(tmp, path)


def load_strength(path="team_strength.json"):
    """team_strength.json written by cito_update.py (derived numbers only). None if missing or unreadable."""
    try:
        import json
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else None
    except Exception:
        return None


def prep_strength(d):
    """Dated lists sorted by date, team keys passed through tn() (aliases applied). Same as prepStrength in model.js."""
    out = {"rank": {}, "maps": {}}
    if not d:
        return out
    for kind in ("vrs", "world"):
        snaps = []
        for sn in (d.get("rankings") or {}).get(kind) or []:
            pts = {}
            for k, v in (sn.get("points") or {}).items():
                if isinstance(v, (int, float)) and v > 0 and tn(k):
                    pts.setdefault(tn(k), float(v))
            if sn.get("date") and pts:
                snaps.append((str(sn["date"])[:10], pts))
        snaps.sort(key=lambda x: x[0])
        out["rank"][kind] = ([x[0] for x in snaps], [x[1] for x in snaps])
    for k, lst in (d.get("maps") or {}).items():
        t = tn(k)
        if not t:
            continue
        snaps = []
        for sn in lst or []:
            mp = {}
            for m, v in (sn.get("maps") or {}).items():
                if isinstance(v, list) and len(v) >= 3 and (v[0] or 0) > 0:
                    mp[str(m)] = (float(v[0]), float(v[1] or 0), float(v[2] or 0))
            if sn.get("asof") and mp:
                snaps.append((str(sn["asof"])[:10], mp))
        if snaps:
            prev = out["maps"].get(t, ([], []))
            snaps = sorted(list(zip(prev[0], prev[1])) + snaps, key=lambda x: x[0])
            out["maps"][t] = ([x[0] for x in snaps], [x[1] for x in snaps])
    return out


def _latest(h, before):
    """Value of the newest dated entry strictly before the day `before` (no same-day data: no leakage)."""
    if not h or not h[0]:
        return None
    i = bisect.bisect_left(h[0], str(before)[:10])
    return h[1][i - 1] if i > 0 else None


class Grader:
    def __init__(self, players, ranks=None, params=None, strength=None):
        self.players = players
        self.ranks = ranks or {}
        self.P = dict(PARAMS, **(params or {}))
        self.S = prep_strength(strength)
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
                                             "hsOk": True, "rd": 0, "rdOk": True, "adr": [], "d": 0, "dOk": True})
                g["m"][l["n"]] = l.get("map")
                g["kills"] += float(l.get("kills") or 0)
                if l.get("hs") is None:
                    g["hsOk"] = False
                else:
                    g["hs"] += float(l.get("hs") or 0)
                if l.get("d") is None:
                    g["dOk"] = False
                else:
                    g["d"] += float(l.get("d") or 0)
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
                            "deaths": g["d"] if g["dOk"] else None,
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

    # ---- Cito features (team_strength.json). All return None when there is no data, and then nothing changes.
    def p_rank(self, team, opp, before="9999"):
        """Win chance from ranking points: mean over VRS and world lists (newest list strictly before the day)."""
        a, b, s, ps = tn(team), tn(opp), self.P["rank_s"], []
        for kind in ("vrs", "world"):
            sn = _latest(self.S["rank"].get(kind), before)
            if sn and a in sn and b in sn:
                x, y = sn[a] ** s, sn[b] ** s
                ps.append(x / (x + y))
        return sum(ps) / len(ps) if ps else None

    def pwin(self, team, opp, before="9999"):
        p = winp(self.elo(team, before), self.elo(opp, before))
        w = self.P["w_rank"]
        if w > 0:
            pr = self.p_rank(team, opp, before)
            if pr is not None:
                p = (1 - w) * p + w * pr
        return p

    def map_rounds(self, team, opp, before, base):
        """Expected rounds per map from the two teams' map stats: each team's likely pick (pick % per map, else maps
        played) times the rounds both teams average on that map, shrunk to `base` (the Elo-based value) with k_maps."""
        sa = _latest(self.S["maps"].get(tn(team)), before)
        sb = _latest(self.S["maps"].get(tn(opp)), before) if opp else None
        if not sa and not sb:
            return None
        k = self.P["k_maps"]

        def rdm(m):
            n = r = 0.0
            for sn in (sa, sb):
                if sn and m in sn:
                    n += sn[m][0]
                    r += sn[m][1]
            return (r + k * base) / (n + k)

        def pick_e(sn):
            names = sorted(sn)
            w = [sn[m][2] for m in names]
            if sum(w) <= 0:
                w = [sn[m][0] for m in names]
            tw = sum(w)
            if tw <= 0:
                return None
            return sum(wi * rdm(m) for wi, m in zip(w, names)) / tw

        es = [e for e in (pick_e(sa) if sa else None, pick_e(sb) if sb else None) if e is not None]
        return sum(es) / len(es) if es else None

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
            sp += w * self.pwin(team, c["opp"], c["date"])
        rate = (sk + P["m"] * prior) / (sr + P["m"])
        h2h = [c for c in rows if opp and teq(c["opp"], opp)]
        h2h_rd = sum(c["rd"] for c in h2h)
        h2h_rate = sum(c[st] for c in h2h) / h2h_rd if h2h_rd > 0 else None   # raw per-round rate vs this opponent (display)
        if len(h2h) >= P["h2h_min"] and P["h2h_w"] > 0:
            hr = (sum(c[st] for c in h2h) + P["m"] * rate) / (sum(c["rd"] for c in h2h) + P["m"])
            rate = (1 - P["h2h_w"]) * rate + P["h2h_w"] * hr
        form = self.form(cs, rows, before)
        if st == "kills":
            for k in ("l5", "l10", "l20", "szn"):
                if P["w_" + k] > 0 and form["rate"][k] is not None:
                    rate += P["w_" + k] * (form["rate"][k] - rate)
            if P["w_kd"] > 0 and form["kd_s"] is not None:
                rate *= form["kd_s"] ** P["w_kd"]
        hsf = self.hs_form(cs, team, before)
        if st == "kills":
            for k in KHS_WIN:
                w = P["w_khs" + k]
                if w != 0:
                    rate *= (hsf["s"][k] / (hsf["s"]["szn"] if k != "szn" else hsf["team"])) ** w
        elif any(P["w_hs" + k] != 0 for k in HS_WIN):
            krows = [c for c in cs if c["rd"] and c.get("kills") is not None][:P["n_max"]]
            kp = self.team_prior(team, "kills", before)
            a = b = 0.0
            for i, c in enumerate(krows):
                w = 0.5 ** (i / P["half_life"])
                a += w * c["kills"]
                b += w * c["rd"]
            krate = (a + P["m"] * kp) / (b + P["m"])
            for k in HS_WIN:
                if P["w_hs" + k] != 0:
                    rate += P["w_hs" + k] * (krate * hsf["s"][k] - rate)
        if st == "hs" and P["w_hkd"] != 0 and form["kd_s"] is not None:
            rate *= form["kd_s"] ** P["w_hkd"]
        pbar = sp / sw
        pw = self.pwin(team, opp, before) if opp else pbar
        adj = 1 + P["beta"] * (pw - pbar)
        base = P["rd_a"] + P["rd_b"] * pw * (1 - pw)
        em = self.map_rounds(team, opp, before, base) if P["w_maps"] > 0 else None
        per_map = base + P["w_maps"] * (em - base) if em is not None else base
        rounds = 2 * per_map
        mu = rate * adj * rounds
        return {"mu": mu, "rate": rate, "prior": prior, "adj": adj, "pwin": pw, "pbar": pbar, "rounds": rounds,
                "rounds_elo": 2 * base, "rounds_maps": (2 * em if em is not None else None),
                "p_rank": (self.p_rank(team, opp, before) if opp else None),
                "n": len(cs), "n_rate": len(rows), "h2h": len(h2h), "h2h_rate": h2h_rate, "cs": cs, "form": form, "hsf": hsf}

    def hs_form(self, cs, team, before="9999"):
        """HS% (hs / kills) over the last 5 / 10 / 15 / 20 series with headshot data and the season (calendar year), only
        series before the match: raw (for display) and shrunk (season toward the team HS%, last-N toward the season)."""
        P = self.P
        yr = str(before)[:4] if before != "9999" else (cs[0]["date"][:4] if cs else "")
        hc = [c for c in cs if c.get("hs") is not None and c["kills"] > 0]
        tk = self.team_prior(team, "kills", before)
        team_hsp = self.team_prior(team, "hs", before) / tk if tk > 0 else 0.5
        win = {"5": hc[:5], "10": hc[:10], "15": hc[:15], "20": hc[:20], "szn": [c for c in hc if c["date"][:4] == yr]}
        out = {"raw": {}, "s": {}, "n": {}, "team": team_hsp}
        for k, w in win.items():
            H, K = sum(c["hs"] for c in w), sum(c["kills"] for c in w)
            out["n"][k] = len(w)
            out["raw"][k] = H / K if K > 0 else None
        Hs, Ks = sum(c["hs"] for c in win["szn"]), sum(c["kills"] for c in win["szn"])
        out["s"]["szn"] = (Hs + P["k_hsp"] * team_hsp) / (Ks + P["k_hsp"])
        for k in ("5", "10", "15", "20"):
            H, K = sum(c["hs"] for c in win[k]), sum(c["kills"] for c in win[k])
            out["s"][k] = (H + P["k_hsp"] * out["s"]["szn"]) / (K + P["k_hsp"])
        return out

    def form(self, cs, rows, before="9999"):
        """Kill form, series before the match only: kills per map (kpm) and per-round rate over the last 5 / 10 / 15 / 20
        series and this season (calendar year), and season K/D (raw, and shrunk with k_kd for the model)."""
        yr = str(before)[:4] if before != "9999" else (cs[0]["date"][:4] if cs else "")
        win = {"l5": rows[:5], "l10": rows[:10], "l15": rows[:15], "l20": rows[:20], "szn": [c for c in rows if c["date"][:4] == yr]}
        out = {"rate": {}, "kpm": {}, "n": {}}
        for k, w in win.items():
            out["n"][k] = len(w)
            out["rate"][k] = sum(c["kills"] for c in w) / sum(c["rd"] for c in w) if w else None
            out["kpm"][k] = sum(c["kills"] for c in w) / (2.0 * len(w)) if w else None
        sz = [c for c in cs if c["date"][:4] == yr and c.get("deaths") is not None]
        K, D = sum(c["kills"] for c in sz), sum(c["deaths"] for c in sz)
        out["kd"] = K / D if D > 0 else None
        out["kd_s"] = (K + self.P["k_kd"]) / (D + self.P["k_kd"]) if sz else None
        return out

    def hitrates(self, p, st, line, opp=None, before="9999"):
        """Series that went OVER this exact line (equal = not over), Maps 1-2, only series dated before `before`.
        l5 / l10 / l15 / l20 = last 5 / 10 / 15 / 20 (l5-l15: Players-tab research only, not graded); szn = this calendar year (the match's year, else the newest series' year);
        h2h = vs this opponent. Each is [over, series]. p = decayed, shrunk hit rate used when w_hr > 0."""
        P = self.P
        cs = [c for c in self.series(p) if c["date"] < before and c.get(st) is not None]
        yr = str(before)[:4] if before != "9999" else (cs[0]["date"][:4] if cs else "")
        hx = lambda rows: [sum(1 for c in rows if c[st] > line), len(rows)]
        out = {"l5": hx(cs[:5]), "l10": hx(cs[:10]), "l15": hx(cs[:15]), "l20": hx(cs[:20]),
               "szn": hx([c for c in cs if c["date"][:4] == yr]),
               "h2h": hx([c for c in cs if opp and teq(c["opp"], opp)])}
        sw = sh = 0.0
        for i, c in enumerate(cs[:P["n_max"]]):
            if c[st] == line:
                continue
            w = 0.5 ** (i / P["half_life"])
            sw += w
            sh += w * (1.0 if c[st] > line else 0.0)
        out["p"] = (sh + P["k_hr"] * 0.5) / (sw + P["k_hr"])
        return out

    def bait(self, p, st, line, before="9999"):
        """True if the last 5 Maps 1-2 series before `before` all met or beat this line (actual >= line). Needs 5 series."""
        cs = [c for c in self.series(p) if c["date"] < before and c.get(st) is not None][:5]
        return len(cs) == 5 and all(c[st] >= line for c in cs)

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

    def finish(self, mu, line, st, book=None, odds=None, reasons=None, size=None, hr=None, hits=None):
        P = self.P
        size = size or (P["size_kills"] if st == "kills" else P["size_hs"])
        mu_f = blend_mean(mu, line, size, P["w_line"])
        over, eq, under = nb_probs(mu_f, size, line)
        nopush = max(1e-12, 1 - eq)
        po, pu = over / nopush, under / nopush
        if hr is not None and P["w_hr"] > 0:  # hit-rate signal (pushes already left out of both)
            po = (1 - P["w_hr"]) * po + P["w_hr"] * hr
            pu = 1 - po
        be = break_even(book, odds)
        if abs(po - pu) < 1e-6:  # blended chance is a coin flip (w_line = 1): the model's own mean sets the lean side
            pick = "OVER" if mu >= line_mean(line, size) else "UNDER"
        else:
            pick = "OVER" if po > pu else "UNDER"
        pp = max(po, pu)
        epp = (pp - be) * 100
        reasons = list(reasons or [])
        g = letter(pick, epp, P)
        model_pick, model_grade = pick, g
        blend, up, extra = hitrate_upgrade(hits, P)
        reasons += extra
        if up == "A+" or (up == "B" and g != "A+"):
            if model_pick == "UNDER":
                reasons.append("model leans Under; hit-rate grade is Over")
            pick, g = "OVER", up
        # proj / edge show the model's own number; the probabilities use the line-blended mean
        return {"proj": round(mu, 1), "mu_model": round(mu, 2), "mu_blend": round(mu_f, 2), "edge": round(mu - line, 1), "grade": g, "pick": pick,
                "p_over": round(po, 4), "p_push": round(eq, 4), "p_pick": round(pp, 4), "be": round(be, 4),
                "edge_pp": round(epp, 2), "reasons": reasons, "flag": "; ".join(reasons), "model": MODEL_VERSION,
                "hr_blend": None if blend is None else round(blend, 4), "hr_upgrade": up,
                "model_grade": model_grade, "model_pick": model_pick}

    def rank_of(self, name):
        """Ordinal rank from players.json, keyed the same way as grader_legacy (norm of the team name)."""
        k = norm(name)
        for t, r in (self.ranks or {}).items():
            if norm(t) == k:
                return r
        return None

    @staticmethod
    def tier(r):
        return "t5" if r <= 5 else "t15" if r <= 15 else "t30" if r <= 30 else "t31"

    def v1_project(self, p, st, opp, before="9999"):
        """v1 projection (grader_legacy.Grader.grade), using only series dated strictly before `before`."""
        cs = [c for c in self.series(p) if c["date"] < before]
        nums = lambda rows: [c[st] for c in rows if c.get(st) is not None]
        v = nums(cs)
        if not v:
            return None
        opp_rank = self.rank_of(opp) if opp else None
        on = norm(opp)
        comp = [(0.35, mean(nums(cs[:10]))), (0.20, mean(v))]
        h = [c for c in cs if norm(c["opp"]) == on] if opp else []
        comp.append((0.20, mean(nums(h))))
        same = []
        if opp_rank is not None:
            for c in cs:
                rnk = self.rank_of(c["opp"])
                if rnk is not None and self.tier(rnk) == self.tier(opp_rank):
                    same.append(c)
        comp.append((0.15, mean(nums(same))))
        comp.append((0.10, mean(nums(cs[:3]))))
        use = [(w, x) for w, x in comp if x is not None]
        tw = sum(w for w, _ in use)
        if not tw:
            return None
        proj = sum(x * w for w, x in use) / tw
        adr5 = mean([c["adr"] for c in cs[:5] if c.get("adr") is not None])
        adrc = mean([c["adr"] for c in cs if c.get("adr") is not None])
        if adr5 is not None and adrc:
            proj *= max(0.95, min(1.05, 1 + 0.5 * (adr5 / adrc - 1)))
        return proj

    def _v1_result(self, mu, line, st, book, odds, reasons=None):
        """Shade the v1 projection, apply the Under break-even D/F rule, attach NB display fields."""
        g, pick = v1_shade(mu, line)
        if g is None:
            return None
        proj = round1(mu)
        g, pick, epp_u, be_u, pu_u = under_be_letter(g, pick, proj, line, st, book, odds, self.P)
        size = self.P["size_kills"] if st == "kills" else self.P["size_hs"]
        mu_f = blend_mean(proj, float(line), size, self.P["w_line"])
        over, eq, under = nb_probs(mu_f, size, float(line))
        nopush = max(1e-12, 1 - eq)
        po, pu = over / nopush, under / nopush
        be = break_even(book, odds)
        if epp_u is not None:
            epp, p_pick = epp_u, (pu_u if pu_u is not None else pu)
            be = be_u if be_u is not None else be
        else:
            p_pick = max(po, pu)
            epp = (p_pick - be) * 100
        reasons = list(reasons or [])
        return {"proj": proj, "mu_model": proj, "mu_blend": round(mu_f, 2), "edge": round(proj - float(line), 1),
                "grade": g, "pick": pick,
                "p_over": round(po, 4), "p_push": round(eq, 4), "p_pick": round(p_pick, 4), "be": round(be, 4),
                "edge_pp": round(epp, 2), "reasons": reasons, "flag": "; ".join(reasons), "model": MODEL_VERSION,
                "hr_blend": None, "hr_upgrade": None, "model_grade": g, "model_pick": pick}

    def grade(self, p, st, line, opp, team=None, book=None, odds=None, before="9999"):
        if line is None or (isinstance(line, float) and math.isnan(line)):
            return None
        mu = self.v1_project(p, st, opp, before)
        if mu is None:
            return None
        reasons = self.filters(p, team, len([c for c in self.series(p) if c["date"] < before]), before)
        r = self._v1_result(mu, float(line), st, book, odds, reasons)
        if not r:
            return None
        hits = self.hitrates(p, st, float(line), opp, before)
        r["hits"] = {k: hits[k] for k in ("l5", "l10", "l15", "l20", "szn", "h2h")}
        r["p_hr"] = round(hits["p"], 4)
        pr = self.project(p, st, opp, team or p.get("team"), before)
        empty_kpm = {k: None for k in ("l5", "l10", "l15", "l20", "szn")}
        empty_hsp = {k: None for k in ("l5", "l10", "l15", "l20", "szn")}
        if pr:
            r["h2h_n"], r["h2h_rate"] = pr["h2h"], (None if pr["h2h_rate"] is None else round(pr["h2h_rate"], 4))
            r.update({"n": pr["n"], "rounds": round(pr["rounds"], 1), "pwin": round(pr["pwin"], 3), "rate": round(pr["rate"], 4),
                      "p_rank": None if pr["p_rank"] is None else round(pr["p_rank"], 3),
                      "rounds_maps": None if pr["rounds_maps"] is None else round(pr["rounds_maps"], 1),
                      "kd": None if pr["form"]["kd"] is None else round(pr["form"]["kd"], 3),
                      "kpm": {k: (None if v is None else round(v, 2)) for k, v in pr["form"]["kpm"].items()},
                      "hsp": {("szn" if k == "szn" else "l" + k): (None if v is None else round(v, 4)) for k, v in pr["hsf"]["raw"].items()}})
        else:
            n = len([c for c in self.series(p) if c["date"] < before])
            r.update({"h2h_n": 0, "h2h_rate": None, "n": n, "rounds": None, "pwin": None, "rate": None,
                      "p_rank": None, "rounds_maps": None, "kd": None, "kpm": empty_kpm, "hsp": empty_hsp})
        r["bait"] = self.bait(p, st, float(line), before)
        return r

    def grade_combo(self, name, team, st, line, opp, book=None, odds=None, before="9999"):
        """Combo prop: sum of each player's v1 projection vs the combined line, then the same letters / Under rule."""
        names = [n.strip() for n in str(name).split("+") if n.strip()]
        if len(names) < 2:
            return None
        mu, reasons, nmin = 0.0, [], 999
        for n in names:
            p = self.find(n, team)
            if not p:
                return None
            pj = self.v1_project(p, st, opp, before)
            if pj is None:
                return None
            mu += pj
            nser = len([c for c in self.series(p) if c["date"] < before])
            nmin = min(nmin, nser)
            reasons += [n + ": " + x for x in self.filters(p, team, nser, before)]
        r = self._v1_result(mu, float(line), st, book, odds, reasons)
        if not r:
            return None
        r["n"] = nmin
        r["bait"] = False
        return r
