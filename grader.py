"""Python copy of the site's grader (app.js: find, combos, grade), used to lock in each pick when a line is first seen.
Keep this in step with app.js. Only uses players.json (stats + ranks). No network."""
import re, math

ALIASES = {"4Z": "EP.-4Z"}


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def canon(s):
    k = norm(s)
    for a, b in (("0", "o"), ("1", "i"), ("3", "e"), ("4", "a"), ("5", "s"), ("7", "t")):
        k = k.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", k)


def teq(a, b):
    a = re.sub(r"^team", "", norm(a))
    b = re.sub(r"^team", "", norm(b))
    return bool(a) and a == b


def mean(a):
    return sum(a) / len(a) if a else None


class Grader:
    def __init__(self, players, ranks=None):
        self.players = players
        self.ranks = ranks or {}
        self.exact, self.canon = {}, {}
        for p in players:
            self.exact.setdefault(norm(p["name"]), []).append(p)
            self.canon.setdefault(canon(p["name"]), []).append(p)
        self._combos = {}
        self._memo = {}

    # ---- name matching (same rules as app.js find)
    def find(self, name, team=None):
        mk = (norm(name), norm(team or ""))
        if mk in self._memo:
            return self._memo[mk]
        nl = lambda p: len(p.get("logs") or [])
        best = lambda a: sorted(a, key=nl, reverse=True)[0]
        k, r = norm(name), None
        ex = self.exact.get(k)
        if ex:
            r = next((p for p in ex if team and teq(p.get("team"), team)), None) or best(ex)
        if not r and name in ALIASES:
            a = self.exact.get(norm(ALIASES[name]))
            if a:
                r = best(a)
        if not r and len(k) >= 3:
            cs = self.canon.get(canon(name))
            if cs:
                same = [p for p in cs if team and teq(p.get("team"), team)]
                pool = same or cs
                if len(pool) == 1 or len(same) == 1:
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

    # ---- one row per series where both Map 1 and Map 2 were logged, newest first
    def combos(self, p, logs=None):
        by = {}
        for l in (p.get("logs") if logs is None else logs) or []:
            if l.get("n") in (1, 2) and l.get("mid") is not None:
                g = by.setdefault(l["mid"], {"mid": l["mid"], "date": l.get("date"), "opp": l.get("opp"), "m": {}, "kills": 0, "hs": 0,
                                             "hsOk": True, "adr": []})
                g["m"][l["n"]] = l.get("map")
                g["kills"] += float(l.get("kills") or 0)
                if l.get("hs") is None:
                    g["hsOk"] = False
                else:
                    g["hs"] += float(l.get("hs") or 0)
                if l.get("adr") is not None:
                    g["adr"].append(float(l["adr"]))
        out = []
        for g in by.values():
            if 1 in g["m"] and 2 in g["m"]:
                out.append({"mid": str(g["mid"]), "date": g["date"] or "", "opp": g["opp"], "kills": g["kills"],
                            "hs": g["hs"] if g["hsOk"] else None,
                            "adr": (sum(g["adr"]) / len(g["adr"])) if g["adr"] else None})
        out.sort(key=lambda c: (c["date"], c["mid"]), reverse=True)
        return out

    def rank_of(self, name):
        k = norm(name)
        for t, r in self.ranks.items():
            if norm(t) == k:
                return r
        return None

    @staticmethod
    def tier(r):
        return "t5" if r <= 5 else "t15" if r <= 15 else "t30" if r <= 30 else "t31"

    def grade(self, p, st, line, opp):
        cs = self.combos(p)
        nums = lambda rows: [c[st] for c in rows if c.get(st) is not None]
        v = nums(cs)
        if not v or line is None or (isinstance(line, float) and math.isnan(line)):
            return None
        opp_rank = self.rank_of(opp) if opp else None
        on = norm(opp)
        comp = [(0.35, mean(nums(cs[:10]))), (0.20, mean(v))]
        h = [c for c in cs if norm(c["opp"]) == on] if opp else []
        comp.append((0.20, mean(nums(h))))
        same = []
        if opp_rank:
            for c in cs:
                r = self.rank_of(c["opp"])
                if r and self.tier(r) == self.tier(opp_rank):
                    same.append(c)
        comp.append((0.15, mean(nums(same))))
        comp.append((0.10, mean(nums(cs[:3]))))
        use = [(w, x) for w, x in comp if x is not None]
        tw = sum(w for w, _ in use)
        proj = sum(x * w / tw for w, x in use)
        adr5 = mean([c["adr"] for c in cs[:5] if c["adr"] is not None])
        adrc = mean([c["adr"] for c in cs if c["adr"] is not None])
        if adr5 is not None and adrc:
            proj *= max(0.95, min(1.05, 1 + 0.5 * (adr5 / adrc - 1)))
        edge = proj - line
        pct = edge / line
        g = "A+" if pct >= .15 else "B" if pct >= .05 else "C" if pct >= -.02 else "D" if pct >= -.10 else "F"
        return {"proj": round(proj, 1), "edge": round(edge, 1), "grade": g, "pick": "OVER" if edge >= 0 else "UNDER"}

    def grade_combo(self, name, team, st, line, opp):
        """Combo prop "A + B + C": sum of each player's own projection vs the combined line (same as app.js)."""
        names = [n.strip() for n in str(name).split("+") if n.strip()]
        if len(names) < 2:
            return None
        proj = 0.0
        for n in names:
            p = self.find(n, team)
            if not p:
                return None
            g = self.grade(p, st, 1.0, opp)
            if not g:
                return None
            proj += g["proj"]
        proj = round(proj, 1)
        edge = proj - line
        pct = edge / line
        gr = "A+" if pct >= .15 else "B" if pct >= .05 else "C" if pct >= -.02 else "D" if pct >= -.10 else "F"
        return {"proj": proj, "edge": round(edge, 1), "grade": gr, "pick": "OVER" if edge >= 0 else "UNDER"}
