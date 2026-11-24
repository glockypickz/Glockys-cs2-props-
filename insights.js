/** Per-grade Insights tab (display only).
 *  Built from the same grade object the Grader / Lines tab already computed.
 *  Does not change the projection, letter, pick, or any locked grade.
 *
 *  Each bullet is marked used / not used from what the live v1be grader actually
 *  uses: last 10, all logged series, head-to-head (from one meeting), same rank
 *  tier, last 3, and the ADR nudge. Hit rates, LAN vs online, map-pool pick %,
 *  and per-map averages are shown when the data exists, but they are not inputs.
 *  Items with no data are omitted. Facts only.
 */
(function (root) {
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function mean(a) {
    return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null;
  }
  function r1(x) { return Math.abs(x) < 0.05 ? "0.0" : x.toFixed(1); }
  function tnDef(s) {
    return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("");
  }
  function teq(a, b, tn) {
    tn = tn || tnDef;
    a = tn(a); b = tn(b);
    return !!a && a === b;
  }
  function isMap1(period) { return period === "Map 1"; }
  function unit(period) { return isMap1(period) ? "Map 1 maps" : "Maps 1-2 series"; }
  function unit1(period) { return isMap1(period) ? "Map 1 map" : "Maps 1-2 series"; }
  function scopeName(period) { return isMap1(period) ? "Map 1" : "Maps 1-2"; }
  function statName(st) { return st === "hs" ? "headshots" : "kills"; }
  function sideOf(pick) { return pick === "UNDER" ? "Under" : "Over"; }
  function partBy(g, key) {
    var parts = (g.v1 && g.v1.parts) || [];
    for (var i = 0; i < parts.length; i++) if (parts[i].key === key) return parts[i];
    return null;
  }
  function partUsed(p) { return !!(p && p.v != null && p.n); }
  function avgN(cs, st, n) {
    var rows = (cs || []).filter(function (c) { return c[st] != null; });
    if (n != null) rows = rows.slice(0, n);
    var vals = rows.map(function (c) { return c[st]; });
    return { n: vals.length, avg: mean(vals) };
  }
  function windowHits(cs, st, line, n) {
    var rows = (cs || []).filter(function (c) { return c[st] != null; });
    if (n != null) rows = rows.slice(0, n);
    var over = 0, under = 0, push = 0;
    rows.forEach(function (c) {
      if (c[st] > line) over++;
      else if (c[st] < line) under++;
      else push++;
    });
    return { n: rows.length, over: over, under: under, push: push };
  }
  function hitPhrase(h, side) {
    if (!h || !h.n) return null;
    var n = h.n, k = side === "Under" ? h.under : h.over;
    var t = "Went " + side + " in " + k + " of the last " + n;
    if (h.push) t += " (" + h.push + " push" + (h.push === 1 ? "" : "es") + ")";
    t += " at this line";
    return t;
  }
  function hitFavors(h, side) {
    if (!h || h.n < 3) return null;
    var k = side === "Under" ? h.under : h.over;
    var opp = side === "Under" ? h.over : h.under;
    if (k > opp) return true;
    if (k < opp) return false;
    return null;
  }
  function avgFavors(avg, line, side) {
    if (avg == null || line == null) return null;
    if (avg === line) return null;
    if (side === "Under") return avg < line;
    return avg > line;
  }
  function vsLine(avg, line) {
    var d = avg - line;
    return r1(Math.abs(d)) + (d < 0 ? " below" : " above") + " the line";
  }
  function tierName(r) {
    if (r == null) return null;
    return r <= 5 ? "Top 5" : r <= 15 ? "Top 6-15" : r <= 30 ? "Top 16-30" : "Top 31+";
  }
  function rankOf(ranks, name) {
    if (!ranks || name == null) return null;
    var k = String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
    for (var t in ranks) {
      if (String(t).toLowerCase().replace(/[^a-z0-9]/g, "") === k) return ranks[t];
    }
    return null;
  }
  function evRows(cs, logs, period, st) {
    var rows = (cs || []).filter(function (c) { return c[st] != null; }).map(function (c) {
      return { ev: c.ev || null, v: c[st], mid: c.mid };
    });
    if (!logs || !logs.length) return rows;
    var by = {};
    logs.forEach(function (l) {
      if (l.mid == null || !l.ev) return;
      if (isMap1(period) && l.n !== 1) return;
      if (!isMap1(period) && l.n !== 1 && l.n !== 2) return;
      var mid = String(l.mid);
      by[mid] = by[mid] || {};
      by[mid][l.ev] = 1;
    });
    rows.forEach(function (r) {
      if (r.ev) return;
      var evs = Object.keys(by[String(r.mid)] || {});
      if (evs.length === 1) r.ev = evs[0];
    });
    return rows;
  }
  function evAvg(rows, ev) {
    var vals = rows.filter(function (r) { return r.ev === ev; }).map(function (r) { return r.v; });
    return { n: vals.length, avg: mean(vals) };
  }
  function ymd(s) { return String(s || "").slice(0, 10); }
  function shiftDay(day, n) {
    var d = new Date(day + "T12:00:00Z");
    if (isNaN(d.getTime())) return "";
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  // Match setting (lan / online): newest log from this player or either team in the 3 days
  // before the match day, when that day has a single setting. None if unknown.
  function inferMatchEv(logs, start, extraLogs) {
    var day = ymd(start);
    if (!day || day.length < 10) return null;
    var lo = shiftDay(day, -3), best = "", evs = {};
    if (!lo) return null;
    function consider(date, ev) {
      if (ev !== "lan" && ev !== "online") return;
      date = ymd(date);
      if (!date || date < lo || date >= day) return;
      if (date > best) { best = date; evs = {}; evs[ev] = 1; }
      else if (date === best) evs[ev] = 1;
    }
    (logs || []).forEach(function (l) { consider(l.date, l.ev); });
    (extraLogs || []).forEach(function (l) { consider(l.date, l.ev); });
    var keys = Object.keys(evs);
    return keys.length === 1 ? keys[0] : null;
  }
  function latestMaps(strength, team, before, tn) {
    if (!strength || !strength.maps || !team) return null;
    tn = tn || tnDef;
    var key = tn(team), snaps = null;
    Object.keys(strength.maps).forEach(function (k) {
      if (tn(k) === key) snaps = strength.maps[k];
    });
    if (!snaps || !snaps.length) return null;
    var day = String(before || "9999").slice(0, 10);
    var best = null, newest = null;
    snaps.forEach(function (sn) {
      var d = String((sn && sn.asof) || "").slice(0, 10);
      if (!d || !sn.maps) return;
      if (!newest || d > newest.d) newest = { d: d, maps: sn.maps };
      if (d < day && (!best || d > best.d)) best = { d: d, maps: sn.maps };
    });
    var pick = best || newest;
    if (!pick) return null;
    pick.late = !best && !!newest;
    return pick;
  }
  function combinedPick(sa, sb) {
    var maps = {}, i, m, list;
    [sa, sb].forEach(function (sn) {
      if (!sn || !sn.maps) return;
      Object.keys(sn.maps).forEach(function (name) {
        var v = sn.maps[name];
        if (!Array.isArray(v) || v.length < 3) return;
        var w = v[2] > 0 ? v[2] : (v[0] > 0 ? v[0] : 0);
        if (w <= 0) return;
        maps[name] = maps[name] || { w: 0, n: 0, played: 0 };
        maps[name].w += w;
        maps[name].n += 1;
        maps[name].played += v[0] || 0;
      });
    });
    list = Object.keys(maps).map(function (name) {
      return { map: name, w: maps[name].w / maps[name].n, played: maps[name].played };
    });
    var tw = list.reduce(function (a, x) { return a + x.w; }, 0);
    if (tw <= 0) return [];
    list.forEach(function (x) { x.pct = x.w / tw * 100; });
    list.sort(function (a, b) { return b.pct - a.pct || b.played - a.played; });
    return list;
  }
  function mapAvg(logs, mapName, st, period) {
    if (!logs || !logs.length || !mapName) return { n: 0, avg: null };
    var vals = [];
    logs.forEach(function (l) {
      if (l[st] == null || String(l.map || "") !== String(mapName)) return;
      if (isMap1(period) && l.n !== 1) return;
      if (!isMap1(period) && l.n !== 1 && l.n !== 2) return;
      vals.push(Number(l[st]));
    });
    return { n: vals.length, avg: mean(vals) };
  }
  function findGame(games, team, opp, start, tn) {
    if (!games || !games.length || !team || !opp) return null;
    tn = tn || tnDef;
    var want = start ? String(start).slice(0, 10) : "";
    var best = null, bestDt = Infinity, i, g, day, dt;
    for (i = 0; i < games.length; i++) {
      g = games[i];
      var ok = (teq(g.team1, team, tn) && teq(g.team2, opp, tn)) ||
               (teq(g.team1, opp, tn) && teq(g.team2, team, tn));
      if (!ok) continue;
      if (!want) return g;
      day = String(g.start || "").slice(0, 10);
      dt = day && want ? Math.abs(new Date(day) - new Date(want)) : 0;
      if (dt < bestDt) { best = g; bestDt = dt; }
    }
    return best;
  }
  function item(text, used, key) {
    return { text: text, used: !!used, key: key || "" };
  }

  function build(g, opts) {
    opts = opts || {};
    if (!g || g.missing || g.proj == null || g.line == null) return null;
    var st = g.stat, line = +g.line, pick = g.pick, side = sideOf(pick);
    var period = g.period || "Maps 1-2";
    var cs = g.cs || [];
    var logs = opts.logs || null;
    var tn = opts.tn || tnDef;
    var before = opts.before || "9999";
    var support = [], risk = [], also = [];
    var un = unit(period), un1 = unit1(period), scope = scopeName(period);
    var sn = statName(st);

    var title = "Why we lean " + side + " " + line;
    var edge = (g.edge != null ? g.edge : (g.proj - line));
    var head = "Projection " + r1(g.proj) + ", " + r1(Math.abs(edge)) + (edge < 0 ? " below" : " above") + " the line";
    if (g.pPick != null) head += ". " + Math.round(g.pPick * 100) + "% chance of " + side + (g.grade ? " (" + g.grade + ")" : "");
    else if (g.grade) head += ". Grade " + g.grade;
    head += ".";

    // v1 window averages (used when the part has a value)
    ["l10", "l3", "szn", "h2h", "tier"].forEach(function (key) {
      var p = partBy(g, key);
      var w = null;
      if (key === "l10") w = avgN(cs, st, 10);
      else if (key === "l3") w = avgN(cs, st, 3);
      else if (key === "szn") w = avgN(cs, st, null);
      if (partUsed(p)) w = { n: p.n, avg: p.v };
      if (!w || w.avg == null || !w.n) return;
      var labels = {
        l10: "Recent average on " + scope + " (last " + w.n + ")",
        l3: "Last 3 " + un + " average",
        szn: "Season average on " + scope + " (" + w.n + " " + un + ")",
        h2h: "Head-to-head vs " + (g.opp || "this opponent") + " (" + w.n + " " + (w.n === 1 ? un1 : un) + ")",
        tier: "vs teams ranked like " + (g.opp || "this opponent") + " (" + w.n + " " + un + ")"
      };
      if (key === "tier" && opts.ranks && g.opp) {
        var rk = rankOf(opts.ranks, g.opp);
        if (rk != null) labels.tier = "vs teams ranked like " + g.opp + " (" + tierName(rk) + ", #" + rk + "): " + r1(w.avg) + " " + sn + " in " + w.n + " " + un;
        else labels.tier += ": " + r1(w.avg) + " " + sn;
      } else {
        labels[key] += ": " + r1(w.avg) + " " + sn;
      }
      var txt = labels[key] + ", " + vsLine(w.avg, line);
      var fav = avgFavors(w.avg, line, side);
      if (fav === true) support.push(item(txt, true, key));
      else if (fav === false) risk.push(item(txt, true, key));
    });

    // ADR nudge (used when applied)
    var adrUsed = g.v1 && g.v1.adr_used;
    var adrMult = g.v1 && g.v1.adr_mult;
    if (adrUsed && adrMult != null && Math.abs(adrMult - 1) > 1e-6) {
      var pct = (adrMult - 1) * 100;
      var txt = "ADR nudge " + (pct >= 0 ? "+" : "") + r1(pct) + "% from last 5 vs all-series ADR (capped at 5%)";
      var adrFav = (pick === "UNDER") ? adrMult < 1 : adrMult > 1;
      if (adrFav) support.push(item(txt, true, "adr"));
      else risk.push(item(txt, true, "adr"));
    }

    // Hit rates vs the line (shown, not used: w_hr is 0)
    var h10 = windowHits(cs, st, line, 10);
    var h5 = windowHits(cs, st, line, 5);
    var h20 = windowHits(cs, st, line, 20);
    var yr = cs.length && cs[0].date ? String(cs[0].date).slice(0, 4) : "";
    var sznRows = yr ? cs.filter(function (c) { return c[st] != null && String(c.date).slice(0, 4) === yr; }) : cs.filter(function (c) { return c[st] != null; });
    var hSzn = windowHits(sznRows, st, line, null);
    if (h10.n) {
      var main = hitPhrase(h10, side);
      if (main) {
        var extra = [];
        if (h5.n) extra.push("L5 " + (side === "Under" ? h5.under : h5.over) + "/" + h5.n);
        if (h20.n) extra.push("L20 " + (side === "Under" ? h20.under : h20.over) + "/" + h20.n);
        if (hSzn && hSzn.n) extra.push("season " + (side === "Under" ? hSzn.under : hSzn.over) + "/" + hSzn.n);
        if (extra.length) main += " (" + extra.join(", ") + ")";
        var fav10 = hitFavors(h10, side);
        if (fav10 === true) support.push(item(main, false, "hr"));
        else if (fav10 === false) risk.push(item("Recent form: " + main, false, "hr"));
        else also.push(item(main, false, "hr"));
      }
    }
    // L5 as a specific "form turned" counter when it disagrees with the lean
    if (h5.n >= 5) {
      var fav5 = hitFavors(h5, side);
      if (fav5 === false) {
        var k5 = side === "Under" ? h5.under : h5.over;
        var already = risk.some(function (x) { return x.key === "hr"; });
        if (!already) {
          risk.push(item("Recent form turned: " + side + " in only " + k5 + " of the last 5 " + un, false, "hr5"));
        } else {
          // strengthen the existing hit-rate risk with the L5 wording if not already clear
          var turned = "Recent form turned: " + side + " in only " + k5 + " of the last 5 " + un;
          if (!risk.some(function (x) { return x.text.indexOf("only") > -1; })) {
            risk.push(item(turned, false, "hr5"));
          }
        }
      }
    }

    // LAN vs online (not used)
    var evs = evRows(cs, logs, period, st);
    var lan = evAvg(evs, "lan"), onl = evAvg(evs, "online");
    if (lan.n >= 5 && onl.n >= 5 && lan.avg != null && onl.avg != null) {
      var evTxt = "LAN average " + r1(lan.avg) + " " + sn + " (" + lan.n + " " + un + ") vs online " + r1(onl.avg) + " (" + onl.n + ")";
      evTxt += ". " + r1(Math.abs(lan.avg - onl.avg)) + " " + sn + " " + (lan.avg > onl.avg ? "higher" : "lower") + " on LAN";
      var gap = Math.abs(lan.avg - onl.avg);
      var interesting = gap >= (st === "hs" ? 0.5 : 1.0);
      if (interesting) {
        // if the split could cut against the lean (e.g. Under lean but LAN is above the line)
        var lanFav = avgFavors(lan.avg, line, side);
        var onFav = avgFavors(onl.avg, line, side);
        if (lanFav === false || onFav === false) risk.push(item(evTxt, false, "lan"));
        else also.push(item(evTxt, false, "lan"));
      } else {
        also.push(item(evTxt, false, "lan"));
      }
    }

    // Likely maps from Cito pick % (not used in the v1 grade)
    var sa = latestMaps(opts.strength, g.team, before, tn);
    var sb = g.opp ? latestMaps(opts.strength, g.opp, before, tn) : null;
    var likely = combinedPick(sa, sb);
    if (likely.length) {
      var top = likely.slice(0, 5);
      var asof = (sa && sa.d) || (sb && sb.d);
      var mapTxt = "Likely maps from our map-pool pick rates";
      if (asof) mapTxt += " (as of " + asof + ")";
      mapTxt += ": " + top.map(function (x) { return x.map + " " + Math.round(x.pct) + "%"; }).join(", ");
      if (logs && logs.length) {
        var bits = [];
        top.forEach(function (x) {
          var ma = mapAvg(logs, x.map, st, period);
          if (ma.n >= 3 && ma.avg != null) {
            bits.push(r1(ma.avg) + " " + sn + " on " + x.map + " (" + ma.n + " " + (isMap1(period) ? "Map 1 maps" : "maps") + ")");
          }
        });
        if (bits.length) mapTxt += ". He averages " + bits.join("; ");
      }
      also.push(item(mapTxt, false, "maps"));
    }

    // Same-tier already listed from parts. If opponent is ranked but the window was empty:
    if (g.opp && opts.ranks && !partUsed(partBy(g, "tier"))) {
      var rk2 = rankOf(opts.ranks, g.opp);
      if (rk2 != null) {
        also.push(item("No same-rank-tier sample vs teams like " + g.opp + " (" + tierName(rk2) + ", #" + rk2 + "); that window was dropped from the mix", false, "tier-miss"));
      }
    }

    // Scope / Bo note
    var nSer = cs.filter(function (c) { return c[st] != null; }).length;
    if (!nSer && g.of) nSer = g.of;
    var scopeTxt;
    if (isMap1(period)) {
      scopeTxt = "Graded on Map 1 only" + (nSer ? " (" + nSer + " earlier Map 1 map" + (nSer === 1 ? "" : "s") + ")" : "") + ". Map 2 and later are not in this projection";
    } else {
      scopeTxt = "Graded on Maps 1-2";
      var extras = [];
      if (nSer) extras.push(nSer + " earlier series");
      var game = findGame(opts.games, g.team, g.opp, opts.start, tn);
      if (game && game.bo) extras.push("this match is listed as a Bo" + game.bo);
      if (extras.length) scopeTxt += " (" + extras.join(", ") + ")";
    }
    also.push(item(scopeTxt + ".", true, "scope"));

    if (g.reasons && g.reasons.length) {
      risk.push(item("Flag (display only, does not change the letter): " + g.reasons.join("; "), false, "flag"));
    }

    // Why Glocky thinks it's bait (display only; only when the grade is flagged, and only bullets that apply)
    var bait = [];
    if (g.bait) {
      var last5 = (cs || []).filter(function (c) { return c[st] != null; }).slice(0, 5);
      var allGreen = last5.length === 5 && last5.every(function (c) { return c[st] >= line; });
      if (allGreen) {
        var vals = last5.map(function (c) { return r1(c[st]); }).join(", ");
        bait.push(item("Last 5 " + un + " were all green: he met or beat " + line + " in each one (" + vals + ").", false, "bait-l5"));
      }
      var tPart = partBy(g, "tier"), sPart = partBy(g, "szn");
      if (partUsed(tPart) && partUsed(sPart) && tPart.n >= 3 && sPart.n >= 3 && tPart.v < sPart.v) {
        var rkB = opts.ranks && g.opp ? rankOf(opts.ranks, g.opp) : null;
        var tierBit = r1(tPart.v) + " " + sn + " vs teams ranked like " + (g.opp || "this opponent");
        if (rkB != null) tierBit += " (" + tierName(rkB) + ", #" + rkB + ", " + tPart.n + " " + un + ")";
        else tierBit += " (" + tPart.n + " " + un + ")";
        bait.push(item("He underperforms against similarly ranked teams: " + tierBit + ", below his season average of " + r1(sPart.v) + " (" + sPart.n + " " + un + ").", true, "bait-tier"));
      }
      var matchEv = inferMatchEv(logs, opts.start, opts.evLogs);
      var setA = matchEv === "lan" ? lan : matchEv === "online" ? onl : null;
      var othA = matchEv === "lan" ? onl : matchEv === "online" ? lan : null;
      var setLabel = matchEv === "lan" ? "LAN" : matchEv === "online" ? "online" : "";
      var othLabel = matchEv === "lan" ? "online" : matchEv === "online" ? "LAN" : "";
      var evGap = (st === "hs" ? 0.5 : 1.0);
      if (matchEv && setA && othA && setA.n >= 5 && othA.n >= 5 && setA.avg != null && othA.avg != null && setA.avg + evGap <= othA.avg) {
        bait.push(item("He underperforms on " + setLabel + " (this match's setting, from logs in the 3 days before it): " + r1(setA.avg) + " " + sn + " on " + setLabel + " (" + setA.n + " " + un + ") vs " + r1(othA.avg) + " " + othLabel + " (" + othA.n + ").", false, "bait-ev"));
      }
    }

    return {
      side: side, line: line, period: period,
      headline: { title: title, text: head, used: true },
      support: support, risk: risk, also: also, bait: bait
    };
  }

  function renderList(items, e) {
    if (!items || !items.length) return "";
    return '<ul class="ins-list">' + items.map(function (it) {
      var cls = it.used ? "used" : "ref";
      var tip = it.used ? "Used in the grade" : "Not used in the grade";
      return '<li class="' + cls + '"><span class="ins-dot ' + cls + '" title="' + tip + '" aria-label="' + tip + '"></span><span>' + e(it.text) + "</span></li>";
    }).join("") + "</ul>";
  }

  function html(g, opts) {
    var ins = (g && g._insights) || build(g, opts);
    if (!ins) return "";
    var e = (opts && opts.esc) || esc;
    var h = '<div class="ins">';
    h += "<h2>Key insights</h2>";
    h += '<div class="ins-why"><div class="ins-why-title">' + e(ins.headline.title) + "</div><p>" + e(ins.headline.text) + "</p></div>";
    if (ins.bait && ins.bait.length) {
      h += "<h2>Why Glocky thinks it's bait</h2>" + renderList(ins.bait, e);
    }
    if (ins.support.length) {
      h += "<h2>Other numbers that point to " + e(ins.side) + "</h2>" + renderList(ins.support, e);
    }
    if (ins.risk.length) {
      h += "<h2>What could go wrong</h2>" + renderList(ins.risk, e);
    }
    if (ins.also.length) {
      h += "<h2>Also good to know</h2>" + renderList(ins.also, e);
    }
    h += '<div class="ins-leg"><span><span class="ins-dot used"></span> Used in the grade</span><span><span class="ins-dot ref"></span> Not used in the grade</span></div>';
    h += "</div>";
    return h;
  }

  var api = { build: build, html: html, inferMatchEv: inferMatchEv };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GPInsights = api;
})(typeof window !== "undefined" ? window : this);
