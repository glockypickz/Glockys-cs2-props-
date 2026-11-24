"""Deterministic CS2 veto / map-slot prediction (Glocky's map prediction).

Simulates a standard veto from each team's recent pick rates over the active
map pool. LAN matches use LAN-only pick history; online matches use
online-only history. A side with fewer than MIN_SETTING_N Maps 1-2 logs in
that setting falls back to all-matches history, and that is noted.

Standard formats (pool size n, usually 7):
  Bo1: alternating bans, leftover is Map 1.
  Bo3: ban, ban, pick (Map 1), pick (Map 2), remaining bans, leftover is the decider.
  Bo5: two opening bans, four picks, leftover is Map 5.

Both first-ban sides are averaged (the coin flip is unknown). Pick weight is
the team's smoothed share of Maps 1-2 in the last veto_days (same k as the
scout veto). Ban weight is the opponent's pick weight over the team's own
(deny their comfort, slightly prefer banning maps you play less).

Confirmed veto / listed maps override the simulation (probability 1 in order).
Only team maps dated strictly before the match day are used. No network.
"""
from scout_model import DEF, _day_ord, _ord_to_iso
from grader import tn

MIN_SETTING_N = 8  # Maps 1-2 logs in the setting before falling back to all matches
EPS = 1e-6


def setting_of(ev):
    return ev if ev in ("lan", "online") else None


def veto_steps(n, bo):
    """Sequence of ('ban', side) / ('pick', side, slot) / ('left', slot). side is 0/1 relative to the first banner."""
    n = int(n or 0)
    if n <= 0:
        return []
    bo = 5 if (bo or 3) >= 5 else (1 if bo == 1 else 3)
    if bo == 1:
        return [("ban", i % 2) for i in range(max(0, n - 1))] + [("left", 1)]
    n_picks = 4 if bo == 5 else 2
    decider = 5 if bo == 5 else 3
    if n < n_picks + 1:
        n_picks = max(0, n - 1)
    n_bans = max(0, n - n_picks - 1)
    open_bans = min(2, n_bans)
    close_bans = n_bans - open_bans
    steps = [("ban", i % 2) for i in range(open_bans)]
    for s in range(n_picks):
        steps.append(("pick", (open_bans + s) % 2, s + 1))
    for i in range(close_bans):
        steps.append(("ban", (open_bans + n_picks + i) % 2))
    steps.append(("left", decider))
    return steps


def _norm(weights, remaining):
    s = 0.0
    for m in remaining:
        s += max(0.0, weights.get(m, 0.0))
    if s <= 0:
        u = 1.0 / len(remaining)
        return {m: u for m in remaining}
    return {m: max(0.0, weights.get(m, 0.0)) / s for m in remaining}


def ban_weights(pick_own, pick_opp, pool):
    """Deny the opponent's comfort; slightly prefer banning maps you play less."""
    out = {}
    for m in pool:
        out[m] = pick_opp.get(m, 0.0) / (pick_own.get(m, 0.0) + EPS)
    return out


def soft_veto(pool, pick_a, pick_b, bo):
    """slot -> {map: p}, each slot sums to 1. Averages both first-ban sides."""
    pool = tuple(sorted(pool))
    if not pool:
        return {}
    steps0 = veto_steps(len(pool), bo)
    if not steps0:
        return {}
    pick = (pick_a, pick_b)
    ban = (ban_weights(pick_a, pick_b, pool), ban_weights(pick_b, pick_a, pool))
    slots_needed = sorted({s[2] if s[0] == "pick" else s[1] for s in steps0 if s[0] in ("pick", "left")})

    def empty():
        return {s: {m: 0.0 for m in pool} for s in slots_needed}

    def run(starter):
        memo = {}

        def rec(rem, si):
            key = (rem, si)
            if key in memo:
                return memo[key]
            out = empty()
            if not rem or si >= len(steps0):
                memo[key] = out
                return out
            step = steps0[si]
            kind = step[0]
            if kind == "left":
                slot = step[1]
                if len(rem) == 1 and slot in out:
                    out[slot][rem[0]] = 1.0
                elif rem and slot in out:
                    u = 1.0 / len(rem)
                    for m in rem:
                        out[slot][m] = u
                memo[key] = out
                return out
            side = (step[1] + starter) % 2
            wsrc = pick[side] if kind == "pick" else ban[side]
            w = _norm(wsrc, rem)
            slot = step[2] if kind == "pick" else None
            for i, m in enumerate(rem):
                p = w[m]
                if p <= 0:
                    continue
                child_rem = rem[:i] + rem[i + 1:]
                child = rec(child_rem, si + 1)
                if slot is not None and slot in out:
                    out[slot][m] += p
                for sl, dist in child.items():
                    acc = out[sl]
                    for mm, pv in dist.items():
                        if pv:
                            acc[mm] += p * pv
            memo[key] = out
            return out

        return rec(pool, 0)

    a, b = run(0), run(1)
    out = empty()
    for sl in out:
        for m in pool:
            out[sl][m] = 0.5 * (a[sl][m] + b[sl][m])
    return out


def pick_shares(S, team, D, ev=None, P=None):
    """Smoothed Maps 1-2 shares over the active pool, optionally restricted to lan/online.

    Returns (weights, n, fallback, source_ev). fallback is True when the setting
    was requested but the team had fewer than MIN_SETTING_N Maps 1-2 logs, so
    all-matches shares were used instead.
    """
    P = P or DEF
    ev = setting_of(ev)
    team = tn(team) if team else team
    pool = S.pool(D)
    if not pool or not team:
        return {}, 0, False, ev, 0
    lo = _ord_to_iso(_day_ord(D) - P["veto_days"]) if _day_ord(D) else "0000-01-01"
    k = P["k_veto"]

    def count(want_ev):
        c, n = {}, 0
        for g in S.team_prior_maps(team, D):
            if g["date"] < lo or g.get("map") not in pool:
                continue
            nslot = g.get("n")
            if nslot not in (1, 2):
                continue
            if want_ev and g.get("ev") != want_ev:
                continue
            c[g["map"]] = c.get(g["map"], 0) + 1
            n += 1
        return c, n

    def weights(c, n):
        if not n:
            return {m: 1.0 / len(pool) for m in pool}, 0
        return {m: (c.get(m, 0) + k / len(pool)) / (n + k) for m in pool}, n

    if ev:
        c, n_set = count(ev)
        if n_set >= MIN_SETTING_N:
            w, _ = weights(c, n_set)
            return w, n_set, False, ev, n_set
        c_all, n_all = count(None)
        w, _ = weights(c_all, n_all)
        return w, n_all, True, ev, n_set
    c, n = count(None)
    w, _ = weights(c, n)
    return w, n, False, None, n


def _argmax(dist, banned=None):
    banned = banned or set()
    items = [(p, m) for m, p in (dist or {}).items() if m not in banned]
    if not items:
        items = [(p, m) for m, p in (dist or {}).items()]
    if not items:
        return None
    # highest p, then alphabetical for ties
    items.sort(key=lambda x: (-x[0], x[1]))
    return items[0][1]


def _ranked(dist):
    rows = sorted((dist or {}).items(), key=lambda x: (-x[1], x[0]))
    return [{"map": m, "p": p, "pct": int(round(100 * p))} for m, p in rows if p > 0]


def predict_match(S, team, opp, D, bo=3, ev=None, confirmed=None, P=None):
    """Glocky's map prediction for one match. confirmed maps (if any) override the sim."""
    P = P or DEF
    ev = setting_of(ev)
    bo = 5 if (bo or 3) >= 5 else (1 if bo == 1 else 3)
    known = [m for m in (confirmed or []) if m]
    out = {"bo": bo, "ev": ev, "fallback": [], "confirmed": bool(known),
           "slots": {}, "pred": {}, "slot_w": {}, "played": {}, "w12": {}, "src": "pred"}
    if known:
        out["src"] = "confirmed"
        nslots = 1 if bo == 1 else (5 if bo == 5 else 3)
        for i, m in enumerate(known[:nslots], 1):
            out["slot_w"][i] = {m: 1.0}
            out["slots"][i] = [{"map": m, "p": 1.0, "pct": 100}]
            out["pred"][i] = m
            out["played"][m] = out["played"].get(m, 0.0) + 1.0
        if bo != 1:
            keys = [1, 2]
            tw = sum(out["played"].get(out["pred"][s], 0) for s in keys if s in out["pred"]) or 1.0
            for s in keys:
                m = out["pred"].get(s)
                if m:
                    out["w12"][m] = out["w12"].get(m, 0.0) + 1.0 / tw
        else:
            out["w12"] = dict(out["slot_w"].get(1) or {})
        return out

    pool = S.pool(D)
    sa, na, fa, ev_a, nsa = pick_shares(S, team, D, ev, P)
    sb, nb, fb, ev_b, nsb = pick_shares(S, opp, D, ev, P) if opp else ({}, 0, False, ev, 0)
    if ev:
        if fa or not nsa:
            out["fallback"].append({"team": team, "used": "all", "n": na, "n_setting": nsa, "wanted": ev})
        if opp and (fb or not nsb):
            out["fallback"].append({"team": opp, "used": "all", "n": nb, "n_setting": nsb, "wanted": ev})
    if not pool or (not sa and not sb):
        return out
    if not sa:
        sa = {m: 1.0 / len(pool) for m in pool}
    if not sb:
        sb = {m: 1.0 / len(pool) for m in pool}
    slot_w = soft_veto(pool, sa, sb, bo)
    out["slot_w"] = slot_w
    used = set()
    for sl in sorted(slot_w):
        out["slots"][sl] = _ranked(slot_w[sl])
        choice = _argmax(slot_w[sl], used)
        if choice:
            out["pred"][sl] = choice
            used.add(choice)
    played = {}
    for sl, dist in slot_w.items():
        for m, p in dist.items():
            played[m] = played.get(m, 0.0) + p
    out["played"] = played
    if bo == 1:
        out["w12"] = dict(slot_w.get(1) or {})
    else:
        a, b = slot_w.get(1) or {}, slot_w.get(2) or {}
        keys = set(a) | set(b)
        out["w12"] = {m: 0.5 * (a.get(m, 0.0) + b.get(m, 0.0)) for m in keys}
    return out


def fallback_note(pred, t1_label=None, t2_label=None):
    """Plain-language note when a side had to use all-matches history."""
    ev = (pred or {}).get("ev")
    setting = "LAN" if ev == "lan" else "online" if ev == "online" else None
    if not pred or not setting:
        if not ev:
            return "Match setting is unknown, so this uses all of both teams' matches."
        return ""
    bits = []
    for row in pred.get("fallback") or []:
        name = row.get("team") or "This team"
        bits.append("%s has too few %s vetos in our data, so that side uses all of their matches." % (name, setting))
    if not bits:
        return "Based on both teams' %s pick and ban history." % setting
    return " ".join(bits)


def slot_label(slot, bo=3):
    if slot == 1:
        return "Map 1"
    if slot == 2:
        return "Map 2"
    if slot == 3:
        return "Map 3 (decider)" if (bo or 3) <= 3 else "Map 3"
    if slot == 5:
        return "Map 5 (decider)"
    return "Map %d" % slot
