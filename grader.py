"""Grader v2: probability-based grades for CS2 Maps 1-2 kills / headshots props.

Python copy of model.js (the site uses model.js). Keep the two in step: parity_check.py compares them.
Uses players.json (per-map logs + ranks) and, when present, team_strength.json (Cito-derived, see cito_update.py). No network.

How a prop is graded (active grader for new locks, model v1f)
  1. v1 projection, unchanged weights: 35% last 10, 20% all logged series (season, always a
     non-zero weight), 20% head-to-head (from the first meeting), 15% same rank tier, 10% last 3,
     then a small ADR form adjustment (capped at 5%), then a shrink toward the player's per-map
     average (k=5; known maps if the veto is in, else scout veto full-pool expected maps). Map 1
     props use a 1-map projection. LAN matches use the merged LAN-data rule. Only series dated
     strictly before `before` are used.
  2. Side probability from a calibrated residual distribution, fit per stat and period (kills /
     headshots, Maps 1-2 / Map 1) on walk-forward series dated before 2026-10-20 (no look-ahead).
     actual ~ Normal or Laplace (chosen on that early slice) with mean = proj + bias, scale as fit.
     Integer lines use a continuity correction: P(push) = F(line+0.5) - F(line-0.5); P(over) and
     P(under) are then conditioned on no push. .5 lines have P(push) = 0.
  3. Pick is the side with the higher no-push probability (proj vs line on a tie).
     Edge pts = (P(side) - book break-even) * 100. Break-even is the implied probability from
     stored American odds when present, else PrizePicks 57.7% / Underdog 53%, else 57.7%.
  4. Letter and stake units from that edge (same scale on Over and Under):
       A+ >= +18 pts (2U), A >= +15 (1.5U), B+ >= +12 (1U), B >= +8 (1U),
       C+ >= +5 (0.5U), C >= +2 (0.25U), D >= 0 (0U), F below break-even (0U).
  5. Cap: LAN kills props and bait-flagged props are capped at C+ (never A/B). Auto slips use
     A+ / A / B+ / B, so those capped props are excluded. Filters do not themselves change the
     letter or pick (the bait flag does, only through this cap).
  Already-locked props keep the letter stored on the lock (REGRADE_TAG is not bumped). This path
  is for new grades only. Track Record keeps the old stored letters.
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
          "w_khs5": 0.1, "w_khs10": 0.05, "w_khs15": 0.025, "w_khsszn": 0.0, "k_hsp": 30.0, "w_hkd": -0.1,
          "lan_data": 1, "lan_k": 5.0, "lan_adr_min": 3, "map_data": 1, "map_k": 5.0}
# LAN data (owner, Nov 24): when the match is LAN, every v1 input (L10, season, h2h, same tier, L3, ADR nudge) is computed from
#   the player's LAN series only (Map 1 scope: LAN Map 1s), same weights. Thin samples are blended with the overall value:
#   L10 / L3: the n LAN series fill n of the 10 / 3 slots, overall fills the rest: (n * LAN + (N - n) * overall) / N.
#   season / h2h / same tier: (n * LAN + lan_k * overall) / (n + lan_k), lan_k = 5 series. A part with no LAN series = overall.
#   ADR nudge: LAN rows when the last-5 LAN window has >= lan_adr_min ADR values, else overall. lan_data 0 = off.
# Per-map factor (owner, Nov 24): after the v1 mix + ADR nudge, shrink toward the player's average on the map(s)
#   being played, all games on that map (not LAN-only), only logs dated strictly before the match day, k = map_k (5):
#   proj = (n * map_avg + map_k * proj) / (n + map_k). If the maps are already known (completed veto / listed map
#   names, TBA ignored), use those. Otherwise the expected map average uses scout veto full-pool weights (both teams'
#   recent map shares). Map 1 uses one map average; Maps 1-2 is the sum of two (known maps) or 2 x the expected
#   per-map average (veto). map_data 0 = off. Letters stay the v1e edge scale; LAN kills and bait caps unchanged.
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
MODEL_VERSION = "v1f"

# Calibrated residual of (actual - v1 projection). Fit on walk-forward series dated before
# FIT_CUTOFF (2026-10-20) only; see calib_fit.py. Keys are (stat, period). "scale" is the Normal
# stddev or the Laplace scale b. Combo props use bias * n and scale * sqrt(n).
FIT_CUTOFF = "2026-10-20"
CALIB = {
    "kills": {
        "Maps 1-2": {"dist": "norm", "bias": 0.003, "scale": 8.248},
        "Map 1":    {"dist": "norm", "bias": 0.032, "scale": 5.694},
    },
    "hs": {
        "Maps 1-2": {"dist": "norm", "bias": 0.056, "scale": 5.158},
        "Map 1":    {"dist": "norm", "bias": 0.041, "scale": 3.56},
    },
}
# (min edge pts, letter, stake units). First match wins. F is anything below 0 (below break-even).
GRADE_SCALE = (
    (18, "A+", 2.0),
    (15, "A",  1.5),
    (12, "B+", 1.0),
    (8,  "B",  1.0),
    (5,  "C+", 0.5),
    (2,  "C",  0.25),
    (0,  "D",  0.0),
)
PLAY_GRADES = ("A+", "A", "B+", "B")
CAP_LETTER = "C+"
CAP_STAKE = 0.5

H2H_EXTRA_LIVE = True   # live v1 blend also sees the older meetings in h2h.json (owner, Nov 19). Set False to go back to players.json logs only.

ALIASES = {"4Z": "EP.-4Z", "Ag1l": "agl"}
# Book / bo3.gg team-name variants (keys and values are tn() keys). Same table in model.js.
TEAM_ALIASES = {"betm33": "33", "wraithpcific": "pcific", "lowcortisolbr": "lowcortisol", "lifesagame": "lag"}

PERIOD_12 = "Maps 1-2"
PERIOD_MAP1 = "Map 1"


def period_of(val, default=PERIOD_12):
    """Canonical period label. A missing period (all historical lines) is Maps 1-2.
    'maps1-2' is never treated as Map 1."""
    if isinstance(val, dict):
        val = val.get("period")
    raw = default if val is None or val == "" else val
    compact = "".join(str(raw).lower().replace("_", " ").split())
    if "1-2" in compact or "maps12" in compact:
        return PERIOD_12
    if compact == "map1" or (compact.startswith("map1") and not compact.startswith("maps")):
        return PERIOD_MAP1
    return default


def is_map1(val):
    return period_of(val) == PERIOD_MAP1


# Abramowitz & Stegun 7.1.26, same coefficients in model.js (parity).
_ERF_P = 0.3275911
_ERF_A = (0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429)


def erf_as(x):
    sign = 1.0 if x >= 0 else -1.0
    ax = abs(float(x))
    t = 1.0 / (1.0 + _ERF_P * ax)
    a = t * (_ERF_A[0] + t * (_ERF_A[1] + t * (_ERF_A[2] + t * (_ERF_A[3] + t * _ERF_A[4]))))
    return sign * (1.0 - a * math.exp(-ax * ax))


def norm_cdf(z):
    return 0.5 * (1.0 + erf_as(z / math.sqrt(2.0)))


def laplace_cdf(z):
    """CDF of a Laplace(0, 1) at z (z = (x-mean)/scale)."""
    return 0.5 * math.exp(z) if z < 0 else 1.0 - 0.5 * math.exp(-z)


def calib_of(st, period=None):
    per = period_of(period)
    block = CALIB.get(st) or CALIB["kills"]
    return dict(block.get(per) or block["Maps 1-2"])


def residual_probs(proj, line, st, period=None, n_players=1, calib=None):
    """P(over), P(push), P(under) from the calibrated residual, then over/under conditioned on no push.

    Integer lines use a continuity correction so P(push) = P(line-0.5 < X < line+0.5).
    .5 (or other non-integer) lines have P(push) = 0. n_players scales a combo sum.
    """
    c = calib if calib is not None else calib_of(st, period)
    n = max(int(n_players or 1), 1)
    mean = float(proj) + float(c.get("bias") or 0.0) * n
    scale = float(c.get("scale") or 0.0) * math.sqrt(n)
    dist = c.get("dist") or "norm"

    def F(x):
        if scale <= 1e-12:
            return 0.0 if x < mean else 1.0 if x > mean else 0.5
        z = (float(x) - mean) / scale
        return norm_cdf(z) if dist != "laplace" else laplace_cdf(z)

    line = float(line)
    if abs(line - round(line)) < 1e-9:
        lo, hi = line - 0.5, line + 0.5
        p_push = max(0.0, F(hi) - F(lo))
        p_over = max(0.0, 1.0 - F(hi))
        p_under = max(0.0, F(lo))
    else:
        p_push = 0.0
        p_over = max(0.0, 1.0 - F(line))
        p_under = max(0.0, F(line))
    tot = p_over + p_push + p_under
    if tot > 0:
        p_over, p_push, p_under = p_over / tot, p_push / tot, p_under / tot
    nopush = max(1e-12, 1.0 - p_push)
    return p_over / nopush, p_push, p_under / nopush


def letter_from_edge(epp):
    """Letter and stake units from edge pts = (P(side) - break-even) * 100."""
    try:
        e = float(epp)
    except (TypeError, ValueError):
        return "F", 0.0
    for lo, letter, stake in GRADE_SCALE:
        if e >= lo:
            return letter, stake
    return "F", 0.0


def is_lan_match(ev=None, det=None):
    if ev is not None and ev != "":
        return str(ev).lower() == "lan"
    if det and isinstance(det, dict):
        return bool((det.get("lan") or {}).get("used"))
    return False


def cap_reasons(st, ev=None, bait=False, det=None):
    """Why a prop may be capped at C+: LAN kills and/or a bait flag."""
    out = []
    if bait:
        out.append("bait")
    if st == "kills" and is_lan_match(ev, det):
        out.append("lan_kills")
    return out


def apply_grade_cap(r, st, ev=None, bait=None, det=None):
    """LAN kills and bait-flagged props cannot be A/B. Cap those letters at C+. Mutates r."""
    if not r:
        return r
    if bait is None:
        bait = bool(r.get("bait"))
    if det is None:
        det = r.get("v1")
    reasons = cap_reasons(st, ev, bait, det)
    pre = r.get("grade")
    applied = bool(reasons) and pre in PLAY_GRADES
    if applied:
        r["grade"] = CAP_LETTER
        r["stake"] = CAP_STAKE
        r["model_grade"] = CAP_LETTER
    r["grade_cap"] = {"applied": applied, "reason": "+".join(reasons) if reasons else None,
                      "pre_grade": pre if applied else None}
    return r


def hist_key(e, start=None):
    """History identity: book / player / stat / start / period. Period defaults to Maps 1-2."""
    return (e["book"], e["player"], e["stat"], start if start is not None else e.get("start") or e.get("starts_at") or "",
            period_of(e))


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def canon(s):
    k = norm(s)
    for a, b in (("0", "o"), ("1", "i"), ("3", "e"), ("4", "a"), ("5", "s"), ("7", "t")):
        k = k.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", k)


_SKIP = {"team", "esports", "esport", "gaming", "club", "clan"}


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


def merge_cito(players, path="players_cito.json"):
    """players + the Cito fallback players (players_cito.json) that players.json has no entry for (same name and team).
    Only for the grader's own copy: players.json itself is never changed. Returns (players, count_added)."""
    import json
    try:
        with open(path, encoding="utf-8") as f:
            extra = json.load(f).get("players") or []
    except Exception:
        return players, 0
    have = {}
    for p in players:
        have.setdefault(canon(p["name"]), []).append(p.get("team"))
    out, n = list(players), 0
    for e in extra:
        if not e.get("logs") or any(teq(t, e.get("team")) for t in have.get(canon(e["name"]), [])):
            continue
        out.append({"name": e["name"], "team": e.get("team"), "logs": e["logs"], "src": "cito"})
        n += 1
    return out, n


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
    out = {"rank": {}, "maps": {}, "match_maps": []}
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
    rows = []
    for r in d.get("match_maps") or []:
        maps = [norm_map(x) for x in (r.get("maps") or []) if norm_map(x)]
        if maps and r.get("t1") and r.get("t2"):
            rows.append({"t1": tn(r["t1"]), "t2": tn(r["t2"]), "n1": r.get("n1"), "n2": r.get("n2"),
                         "start": r.get("start"), "maps": maps, "src": r.get("src") or "veto", "at": r.get("at")})
    out["match_maps"] = rows
    return out


def _latest(h, before):
    """Value of the newest dated entry strictly before the day `before` (no same-day data: no leakage)."""
    if not h or not h[0]:
        return None
    i = bisect.bisect_left(h[0], str(before)[:10])
    return h[1][i - 1] if i > 0 else None



def norm_map(name):
    """Canonical map name (Nuke, Mirage, ...). Empty / TBA / TBD placeholders become None."""
    s = str(name or "").strip()
    if s.lower().startswith("de_"):
        s = s[3:]
    s = s.strip()
    if not s or s.lower() in ("tba", "tbd", "tbc", "unknown", "pending", "?", "-"):
        return None
    return s[0].upper() + s[1:] if len(s) > 1 else s.upper()


def _map_log_rows(p):
    """Deduped per-map logs (skip a Cito mid < 0 when a bo3.gg row exists for the same date, n, opponent)."""
    logs = p.get("logs") or []
    pos = {(l.get("date"), l.get("n"), tn(l.get("opp"))) for l in logs if (l.get("mid") or 0) > 0}
    out = []
    for l in logs:
        mid = l.get("mid")
        if mid is not None and mid < 0 and (l.get("date"), l.get("n"), tn(l.get("opp"))) in pos:
            continue
        out.append(l)
    return out


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
        self._xh_rows = {}
        self._load_h2h()
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

    # ---- one row per series (Maps 1-2, both maps logged) or one row per Map 1 (period="Map 1"), newest first
    def combos(self, p, logs=None, period=None):
        if is_map1(period):
            by = {}
            for l in (p.get("logs") if logs is None else logs) or []:
                if l.get("n") != 1 or l.get("mid") is None:
                    continue
                mid = l["mid"]
                if mid in by:
                    continue
                by[mid] = {"mid": str(mid), "date": l.get("date") or "", "opp": l.get("opp"),
                           "maps": l.get("map") or "Map 1", "ev": l.get("ev"),
                           "kills": None if l.get("kills") is None else float(l.get("kills") or 0),
                           "hs": None if l.get("hs") is None else float(l.get("hs") or 0),
                           "rd": None if l.get("rd") is None or l["rd"] < 13 else float(l["rd"]),
                           "deaths": None if l.get("d") is None else float(l["d"]),
                           "adr": None if l.get("adr") is None else float(l["adr"])}
            out = list(by.values())
            out.sort(key=lambda c: (c["date"], str(c["mid"])), reverse=True)
            return out
        by = {}
        for l in (p.get("logs") if logs is None else logs) or []:
            if l.get("n") in (1, 2) and l.get("mid") is not None:
                g = by.setdefault(l["mid"], {"mid": l["mid"], "date": l.get("date"), "opp": l.get("opp"), "m": {}, "kills": 0, "hs": 0,
                                             "hsOk": True, "rd": 0, "rdOk": True, "adr": [], "d": 0, "dOk": True})
                g["m"][l["n"]] = l.get("map")
                if l["n"] == 1:
                    g["ev"] = l.get("ev")
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
                out.append({"mid": str(g["mid"]), "date": g["date"] or "", "opp": g["opp"], "ev": g.get("ev"), "kills": g["kills"],
                            "hs": g["hs"] if g["hsOk"] else None, "rd": g["rd"] if g["rdOk"] else None,
                            "deaths": g["d"] if g["dOk"] else None,
                            "adr": (sum(g["adr"]) / len(g["adr"])) if g["adr"] else None})
        out.sort(key=lambda c: (c["date"], c["mid"]), reverse=True)
        return out

    # ---- extra head-to-head maps (h2h.json, written by h2h_fetch.py): old meetings between two teams that fall outside
    # the last-15-matches window in players.json. Used ONLY for head-to-head (never for last 5/10, season or tier), and a
    # meeting already in the player's own logs is never counted twice.
    def _load_h2h(self, path="h2h.json"):
        self._xh = {}
        try:
            import json as _j
            d = _j.load(open(path, encoding="utf-8"))
        except Exception:
            return
        for r in d.get("logs") or []:
            if r.get("name") and r.get("log"):
                self._xh.setdefault(canon(r["name"]), []).append((r.get("team"), r["log"]))

    def xh_rows(self, p, before="9999", period=None):
        """Series rows (same shape as combos) from h2h.json for this player. A map already in his own logs, or saved twice
        (Cito and bo3.gg give the same meeting different ids), is counted once: same opponent, map number and date +/- 1 day."""
        per = period_of(period)
        k = (id(p), per)
        if k not in self._xh_rows:
            import datetime as _dt

            def day(d):
                try:
                    return _dt.date.fromisoformat(str(d)[:10]).toordinal()
                except Exception:
                    return None
            own_mid = {str(l.get("mid")) for l in (p.get("logs") or [])}
            seen = [(day(l.get("date")), l.get("n"), l.get("opp")) for l in (p.get("logs") or []) if l.get("date")]

            def dup(l):
                d = day(l.get("date"))
                return d is not None and any(d2 is not None and abs(d - d2) <= 1 and n2 == l.get("n") and teq(o2, l.get("opp"))
                                             for d2, n2, o2 in seen)
            logs = []
            for t, l in self._xh.get(canon(p["name"]), []):
                if (t and not teq(t, p.get("team"))) or str(l.get("mid")) in own_mid or dup(l):
                    continue
                logs.append(l)
                seen.append((day(l.get("date")), l.get("n"), l.get("opp")))
            self._xh_rows[k] = self.combos(p, logs, period=per) if logs else []
        return [c for c in self._xh_rows[k] if c["date"] < before]

    def h2h_series(self, p, opp, before="9999", exact=False, extra=True, period=None):
        """Head-to-head series vs `opp`, newest first: the player's own logs plus h2h.json meetings.
        One prior meeting is enough. period="Map 1" uses Map 1 stats only."""
        if not opp:
            return []
        same = (lambda c: norm(c["opp"]) == norm(opp)) if exact else (lambda c: teq(c["opp"], opp))
        rows = [c for c in self.series(p, period) if c["date"] < before and same(c)]
        if extra:
            rows += [c for c in self.xh_rows(p, before, period) if same(c)]
        rows.sort(key=lambda c: (c["date"], str(c["mid"])), reverse=True)
        return rows

    def series(self, p, period=None):
        per = period_of(period)
        k = (id(p), per)
        if k not in self._series:
            self._series[k] = self.combos(p, period=per)
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
        h2h += [c for c in self.xh_rows(p, before) if opp and teq(c["opp"], opp) and c.get("rd") and c.get(st) is not None]
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

    def hitrates(self, p, st, line, opp=None, before="9999", period=None):
        """Series that went OVER this exact line (equal = not over), only series dated before `before`.
        l5 / l10 / l15 / l20 = last 5 / 10 / 15 / 20 (l5-l15: Players-tab research only, not graded); szn = this calendar year (the match's year, else the newest series' year);
        h2h = vs this opponent. Each is [over, series]. p = decayed, shrunk hit rate used when w_hr > 0."""
        P = self.P
        cs = [c for c in self.series(p, period) if c["date"] < before and c.get(st) is not None]
        yr = str(before)[:4] if before != "9999" else (cs[0]["date"][:4] if cs else "")
        hx = lambda rows: [sum(1 for c in rows if c[st] > line), len(rows)]
        out = {"l5": hx(cs[:5]), "l10": hx(cs[:10]), "l15": hx(cs[:15]), "l20": hx(cs[:20]),
               "szn": hx([c for c in cs if c["date"][:4] == yr]),
               "h2h": hx([c for c in self.h2h_series(p, opp, before, period=period) if c.get(st) is not None])}
        sw = sh = 0.0
        for i, c in enumerate(cs[:P["n_max"]]):
            if c[st] == line:
                continue
            w = 0.5 ** (i / P["half_life"])
            sw += w
            sh += w * (1.0 if c[st] > line else 0.0)
        out["p"] = (sh + P["k_hr"] * 0.5) / (sw + P["k_hr"])
        return out

    def bait(self, p, st, line, before="9999", period=None):
        """True if the last 5 series (or Map 1 maps) before `before` all met or beat this line (actual >= line). Needs 5."""
        cs = [c for c in self.series(p, period) if c["date"] < before and c.get(st) is not None][:5]
        return len(cs) == 5 and all(c[st] >= line for c in cs)

    def filters(self, p, team, n, before="9999", period=None):
        P = self.P
        out = []
        if team and not teq(p.get("team"), team):
            out.append("player is not on " + str(team) + " in the data")
        if n < P["min_series"]:
            unit = "earlier Map 1 maps" if is_map1(period) else "earlier Map 1+2 series"
            out.append("only %d %s (need %d)" % (n, unit, P["min_series"]))
        last = self.team_last_mids(p.get("team"), before)
        mine = {c["mid"] for c in self.series(p, period) if c["date"] < before}
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

    def _v1_pieces(self, cs, h, st, opp, period, lan=False):
        """Part values / counts and ADR inputs from series rows cs and head-to-head rows h (newest first)."""
        if lan:
            cs = [c for c in cs if c.get("ev") == "lan"]
            h = [c for c in h if c.get("ev") == "lan"]
        nums = lambda rows: [c[st] for c in rows if c.get(st) is not None]
        opp_rank = self.rank_of(opp) if opp else None
        same = []
        if opp_rank is not None:
            for c in cs:
                rnk = self.rank_of(c["opp"])
                if rnk is not None and self.tier(rnk) == self.tier(opp_rank):
                    same.append(c)
        out = {}
        for k, rows in (("l10", cs[:10]), ("szn", cs), ("h2h", h), ("tier", same), ("l3", cs[:3])):
            v = nums(rows)
            out[k] = (mean(v), len(v))
        out["adr5"] = mean([c["adr"] for c in cs[:5] if c.get("adr") is not None])
        out["adrc"] = mean([c["adr"] for c in cs if c.get("adr") is not None])
        out["adr_n5"] = sum(1 for c in cs[:5] if c.get("adr") is not None)
        out["adr_n"] = sum(1 for c in cs if c.get("adr") is not None)
        out["n"] = len(cs)
        return out

    def v1_project_parts(self, p, st, opp, before="9999", period=None, ev=None, maps=None):
        """v1 projection pieces (same math as v1_project) for the breakdown display.
        period="Map 1" uses Map 1 history only. The season window always keeps its 0.20 weight
        when any Map 1 (or series) data exists; head-to-head is used from a single prior meeting.
        ev="lan" (and PARAMS lan_data): every part uses the player's LAN series, blended with overall when thin (see PARAMS)."""
        cs = [c for c in self.series(p, period) if c["date"] < before]
        if not [c for c in cs if c.get(st) is not None]:
            return None
        h = self.h2h_series(p, opp, before, exact=True, extra=H2H_EXTRA_LIVE, period=period) if opp else []
        A = self._v1_pieces(cs, h, st, opp, period)
        lan_on = ev == "lan" and bool(self.P.get("lan_data"))
        L = self._v1_pieces(cs, h, st, opp, period, lan=True) if lan_on else None
        K = float(self.P.get("lan_k") or 5.0)

        def blend(key, N=None):
            va, na = A[key]
            if not lan_on:
                return va, na, None
            vl, nl = L[key]
            if vl is None or va is None:
                return va, na, 0
            if N:
                n = min(nl, N)
                return (n * vl + (N - n) * va) / N, na, nl
            return (nl * vl + K * va) / (nl + K), na, nl
        unit = "Map 1 maps" if is_map1(period) else "series"
        tag = " · LAN data" if lan_on else ""
        spec = [("l10", "Last 10 " + unit, 0.35, 10), ("szn", "Season (all " + unit + ")", 0.20, None),
                ("h2h", "Head-to-head" + ((" vs " + opp) if opp else ""), 0.20, None),
                ("tier", "Same rank tier" + ((" as " + opp) if opp else ""), 0.15, None), ("l3", "Last 3 " + unit, 0.10, 3)]
        parts = []
        for key, label, w, N in spec:
            v, n, nl = blend(key, N)
            x = {"key": key, "label": label + tag, "w": w, "v": v, "n": n}
            if lan_on:
                x["n_lan"] = nl
            parts.append(x)
        use = [x for x in parts if x["v"] is not None]
        tw = sum(x["w"] for x in use)
        if not tw:
            return None
        pre = sum(x["v"] * x["w"] for x in use) / tw
        proj = pre
        R = A
        adr_lan = False
        if lan_on and L["adr_n5"] >= int(self.P.get("lan_adr_min") or 3) and L["adrc"]:
            R, adr_lan = L, True
        adr5, adrc, adr_n5, adr_n = R["adr5"], R["adrc"], R["adr_n5"], R["adr_n"]
        adr_used = adr5 is not None and bool(adrc)
        adr_mult = 1.0
        if adr_used:
            adr_mult = max(0.95, min(1.05, 1 + 0.5 * (adr5 / adrc - 1)))
            proj *= adr_mult
        mb = self.map_blend(p, st, opp, before, period, maps) if self.P.get("map_data") else None
        if mb and mb.get("avg") is not None and mb.get("n"):
            k = float(self.P.get("map_k") or 5.0)
            mb = dict(mb)
            mb["pre"] = proj
            proj = (mb["n"] * mb["avg"] + k * proj) / (mb["n"] + k)
            mb["proj"] = proj
            mb["k"] = k
            mb["used"] = True
        elif mb:
            mb = dict(mb)
            mb["used"] = False
            mb["pre"] = proj
            mb["proj"] = proj
        return {"proj": proj, "pre": pre, "parts": parts, "adr5": adr5, "adrc": adrc,
                "adr_mult": adr_mult, "adr_used": adr_used, "adr_n5": adr_n5, "adr_n": adr_n, "weight_sum": tw,
                "lan": {"used": lan_on, "n": (L["n"] if lan_on else None), "adr_lan": adr_lan, "ev": ev},
                "map": mb}

    def match_ev(self, team, opp, start=None, games=None, days=3):
        """("lan" / "online" / None, source) for a match. 1) games.json "ev" (bo3.gg tournament event type, written by
        update_games.py from season_state.json) for this team pair within a day of `start`; 2) else the newest logged map of
        either team in the `days` days before the match day (teams play several days of one event); 3) else None."""
        import datetime as _dt
        day = str(start or "")[:10] or _dt.datetime.now(_dt.timezone.utc).date().isoformat()
        if games is None:
            if not hasattr(self, "_games"):
                try:
                    import json as _j
                    self._games = _j.load(open("games.json", encoding="utf-8")).get("games") or []
                except Exception:
                    self._games = []
            games = self._games
        try:
            d0 = _dt.date.fromisoformat(day)
        except Exception:
            return None, None
        for g in games or []:
            if g.get("ev") not in ("lan", "online"):
                continue
            if not ((teq(g.get("team1"), team) and teq(g.get("team2"), opp)) or (teq(g.get("team2"), team) and teq(g.get("team1"), opp))):
                continue
            try:
                if abs((_dt.date.fromisoformat(str(g.get("start"))[:10]) - d0).days) <= 1:
                    return g["ev"], "games"
            except Exception:
                continue
        lo = (d0 - _dt.timedelta(days=days)).isoformat()
        best = None
        if not hasattr(self, "_team_ev"):
            te = {}
            for p in self.players:
                t = tn(p.get("team"))
                for l in p.get("logs") or []:
                    if l.get("ev") in ("lan", "online") and l.get("date"):
                        te.setdefault(t, []).append((l["date"], l["ev"]))
            self._team_ev = {t: sorted(set(v)) for t, v in te.items()}
        for t in (tn(team), tn(opp)):
            rows = self._team_ev.get(t) or []
            i = bisect.bisect_left(rows, (day,))
            if i > 0 and rows[i - 1][0] >= lo:
                r = rows[i - 1]
                # same date can carry both labels only with bad data; prefer lan when the newest day says lan
                same = [x for x in rows[:i] if x[0] == r[0]]
                ev = "lan" if any(x[1] == "lan" for x in same) else r[1]
                if best is None or r[0] > best[0]:
                    best = (r[0], ev)
        return (best[1], "recent maps") if best else (None, None)


    def _scout(self):
        if getattr(self, "_scout_data", None) is None:
            from scout_model import ScoutData
            self._scout_data = ScoutData(self.players, self)
        return self._scout_data

    def confirmed_maps(self, team, opp, start, days=1):
        """Known maps for this team pair (completed veto or listed map names). TBA rows are omitted."""
        import datetime as _dt
        day = str(start or "")[:10]
        if not day or not team or not opp:
            return []
        try:
            d0 = _dt.date.fromisoformat(day)
        except Exception:
            return []
        best, best_dt = [], None
        for r in (self.S or {}).get("match_maps") or []:
            if not ((teq(r.get("t1"), team) and teq(r.get("t2"), opp)) or (teq(r.get("t2"), team) and teq(r.get("t1"), opp))):
                continue
            try:
                d = _dt.date.fromisoformat(str(r.get("start") or "")[:10])
            except Exception:
                continue
            dt = abs((d - d0).days)
            if dt > days:
                continue
            maps = [norm_map(x) for x in (r.get("maps") or []) if norm_map(x)]
            if maps and (best_dt is None or dt < best_dt):
                best, best_dt = maps, dt
        return best

    def player_map_avg(self, p, st, map_name, before="9999"):
        """Mean of `st` on this map, every game dated strictly before `before` (LAN and online together)."""
        want = norm_map(map_name)
        if not want or not st:
            return None, 0
        vals = []
        for l in _map_log_rows(p):
            if str(l.get("date") or "") >= (before or "9999"):
                continue
            if norm_map(l.get("map")) != want:
                continue
            if l.get(st) is None:
                continue
            vals.append(float(l[st]))
        if not vals:
            return None, 0
        return sum(vals) / len(vals), len(vals)

    def veto_weights(self, team, opp, before):
        """Scout veto full-pool weights (sum to 1), or {} if none. Logs before `before` only."""
        try:
            from scout_model import DEF
            return self._scout().veto(tn(team), tn(opp) if opp else None, str(before or "9999")[:10] or "9999", DEF) or {}
        except Exception:
            return {}

    def expected_map_avg(self, p, st, weights, before="9999"):
        """Weighted average of the player's per-map averages. n is the mean sample across maps that had data."""
        num = den = nsum = 0.0
        used = 0
        for m, w in (weights or {}).items():
            if w is None or w <= 0:
                continue
            a, n = self.player_map_avg(p, st, m, before)
            if a is None:
                continue
            num += w * a
            den += w
            nsum += n
            used += 1
        if den <= 0 or used <= 0:
            return None, 0, 0
        return num / den, int(round(nsum / used)), used

    def map_blend(self, p, st, opp, before="9999", period=None, maps=None):
        """Target average the v1 projection shrinks toward, plus the source (known maps or veto weights)."""
        team = p.get("team")
        known = [norm_map(x) for x in (maps or []) if norm_map(x)]
        if not known:
            known = self.confirmed_maps(team, opp, before)
        map1 = is_map1(period)
        if known:
            if map1:
                a, n = self.player_map_avg(p, st, known[0], before)
                return {"avg": a, "n": n, "src": "known", "maps": known[:1], "weights": {known[0]: 1.0}}
            # Maps 1-2: sum of the first two known maps; if only one is known, add the veto expected per-map average.
            pieces, ns = [], []
            for m in known[:2]:
                a, n = self.player_map_avg(p, st, m, before)
                if a is None:
                    continue
                pieces.append(a)
                ns.append(n)
            if len(pieces) == 1:
                ev, en, _ = self.expected_map_avg(p, st, self.veto_weights(team, opp, before), before)
                if ev is not None:
                    pieces.append(ev)
                    ns.append(en or ns[0])
            if len(pieces) >= 2:
                return {"avg": pieces[0] + pieces[1], "n": min(ns[0], ns[1]), "src": "known",
                        "maps": known[:2], "weights": None}
            if len(pieces) == 1:
                return {"avg": pieces[0] * 2, "n": ns[0], "src": "known", "maps": known[:1], "weights": None}
            return {"avg": None, "n": 0, "src": "known", "maps": known, "weights": None}
        w = self.veto_weights(team, opp, before)
        per, n, used = self.expected_map_avg(p, st, w, before)
        if per is None:
            return {"avg": None, "n": 0, "src": "veto", "maps": [], "weights": w}
        avg = per if map1 else 2 * per
        return {"avg": avg, "n": n, "src": "veto", "maps": [], "weights": w, "n_maps": used}

    def v1_project(self, p, st, opp, before="9999", period=None, ev=None, maps=None):
        """v1 projection (grader_legacy.Grader.grade), using only series dated strictly before `before`."""
        d = self.v1_project_parts(p, st, opp, before, period=period, ev=ev, maps=maps)
        return None if d is None else d["proj"]

    def _v1_result(self, mu, line, st, book, odds, reasons=None, period=None, n_players=1):
        """v1 projection + calibrated P(side), edge vs book break-even, letter and stake. New locks only."""
        if line is None or (isinstance(line, float) and math.isnan(line)) or float(line) == 0:
            return None
        proj = round1(mu)
        po, p_push, pu = residual_probs(proj, float(line), st, period, n_players)
        if abs(po - pu) < 1e-6:
            pick = "OVER" if proj >= float(line) else "UNDER"
        else:
            pick = "OVER" if po > pu else "UNDER"
        p_pick = po if pick == "OVER" else pu
        be = break_even(book, odds)
        epp = (p_pick - be) * 100
        g, stake = letter_from_edge(epp)
        size = self.P["size_kills"] if st == "kills" else self.P["size_hs"]
        mu_f = blend_mean(proj, float(line), size, self.P["w_line"])
        reasons = list(reasons or [])
        return {"proj": proj, "mu_model": proj, "mu_blend": round(mu_f, 2), "edge": round(proj - float(line), 1),
                "grade": g, "pick": pick, "stake": stake,
                "p_over": round(po, 4), "p_push": round(p_push, 4), "p_pick": round(p_pick, 4), "be": round(be, 4),
                "edge_pp": round(epp, 2), "reasons": reasons, "flag": "; ".join(reasons), "model": MODEL_VERSION,
                "hr_blend": None, "hr_upgrade": None, "model_grade": g, "model_pick": pick,
                "under_be": {"applied": False, "pu": None, "be": None, "epp": None, "pre_grade": None},
                "grade_cap": {"applied": False, "reason": None, "pre_grade": None}}

    def grade(self, p, st, line, opp, team=None, book=None, odds=None, before="9999", period=None, ev=None, maps=None):
        if line is None or (isinstance(line, float) and math.isnan(line)):
            return None
        if maps is None:
            maps = self.confirmed_maps(team or p.get("team"), opp, before)
        det = self.v1_project_parts(p, st, opp, before, period=period, ev=ev, maps=maps)
        if det is None:
            return None
        n = len([c for c in self.series(p, period) if c["date"] < before])
        reasons = self.filters(p, team, n, before, period=period)
        r = self._v1_result(det["proj"], float(line), st, book, odds, reasons, period=period)
        if not r:
            return None
        r["v1"] = det
        r["period"] = period_of(period)
        hits = self.hitrates(p, st, float(line), opp, before, period=period)
        r["hits"] = {k: hits[k] for k in ("l5", "l10", "l15", "l20", "szn", "h2h")}
        r["p_hr"] = round(hits["p"], 4)
        empty_kpm = {k: None for k in ("l5", "l10", "l15", "l20", "szn")}
        empty_hsp = {k: None for k in ("l5", "l10", "l15", "l20", "szn")}
        cs = [c for c in self.series(p, period) if c["date"] < before]
        rows = [c for c in cs if c.get("rd") and c.get(st) is not None][: self.P["n_max"]]
        r.update({"h2h_n": 0, "h2h_rate": None, "n": n, "rounds": None, "pwin": None, "rate": None,
                  "p_rank": None, "rounds_maps": None})
        if rows:
            form = self.form(cs, rows, before)
            hsf = self.hs_form(cs, team or p.get("team"), before)
            r.update({"kd": None if form["kd"] is None else round(form["kd"], 3),
                      "kpm": {k: (None if v is None else round(v, 2)) for k, v in form["kpm"].items()},
                      "hsp": {("szn" if k == "szn" else "l" + k): (None if v is None else round(v, 4)) for k, v in hsf["raw"].items()}})
        else:
            r.update({"kd": None, "kpm": empty_kpm, "hsp": empty_hsp})
        r["bait"] = self.bait(p, st, float(line), before, period=period)
        apply_grade_cap(r, st, ev=ev, bait=r["bait"], det=det)
        return r

    def grade_combo(self, name, team, st, line, opp, book=None, odds=None, before="9999", period=None, ev=None, maps=None):
        """Combo prop: sum of each player's v1 projection vs the combined line, then the same calibrated letter and stake (combo residual scale * sqrt(n)). LAN kills combos are still capped at C+."""
        names = [n.strip() for n in str(name).split("+") if n.strip()]
        if len(names) < 2:
            return None
        mu, reasons, nmin = 0.0, [], 999
        for n in names:
            p = self.find(n, team)
            if not p:
                return None
            if maps is None:
                maps = self.confirmed_maps(team, opp, before)
            pj = self.v1_project(p, st, opp, before, period=period, ev=ev, maps=maps)
            if pj is None:
                return None
            mu += pj
            nser = len([c for c in self.series(p, period) if c["date"] < before])
            nmin = min(nmin, nser)
            reasons += [n + ": " + x for x in self.filters(p, team, nser, before, period=period)]
        r = self._v1_result(mu, float(line), st, book, odds, reasons, period=period, n_players=len(names))
        if not r:
            return None
        r["n"] = nmin
        r["period"] = period_of(period)
        r["bait"] = False
        apply_grade_cap(r, st, ev=ev, bait=False, det=None)
        return r
