/** Separate admin-only track sheet for the new grader changes.
 *  Shown on the Dashboard under the existing Track Record. Customers never receive
 *  lines_history.json, so they never see this sheet or the full Track Record.
 *
 *  Inclusion rule: a prop counts only when it has a locked grade AND lock.at is
 *  on or after UPDATE_LIVE_AT (Nov 24, 2026, 2:09 AM America/Chicago = 08:09 UTC,
 *  the deploy of PRs 28-32). There is no dedicated lock version/tag for this
 *  deploy (lock.model is still "v1be"; lock.ev is "lan" only when that lock used
 *  LAN-data inputs). Old locked grades in lines_history.json are never rewritten.
 *
 *  Settlement uses the stored e.result (act / outcome) against the locked line
 *  and pick. Pushes and voids are left out of the hit rate, same as the Track
 *  Record. The Scout shadow record is Shadow S (e.shadow_s) on the same
 *  post-update locks, scored against the same actuals.
 *
 *  Keep this file free of app state and of the DOM (html() only returns a string).
 */
(function (root) {
  // Nov 24, 2026, 2:09 AM CT (CST, UTC-6)
  var UPDATE_LIVE_AT = "2026-11-24T08:09:00+00:00";
  var EMPTY = "No picks settled since the update yet";
  var WAIT_MS = 3600000;
  var LETTERS = ["A+", "B", "C", "D", "F"];

  function parseIso(s) {
    if (s == null || s === "") return NaN;
    var t = String(s).trim().replace(" ", "T");
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) t += "+00:00";
    return Date.parse(t);
  }
  function isPostUpdateLock(e) {
    var lk = e && e.lock;
    if (!lk || !lk.grade || lk.at == null || lk.at === "") return false;
    var t = parseIso(lk.at), cut = parseIso(UPDATE_LIVE_AT);
    return !isNaN(t) && !isNaN(cut) && t >= cut;
  }
  function isLan(e) {
    return !!(e && e.lock && String(e.lock.ev).toLowerCase() === "lan");
  }
  function periodOf(e) {
    if (typeof GPMap1 !== "undefined" && GPMap1.periodOf) return GPMap1.periodOf(e);
    var raw = (e && typeof e === "object") ? e.period : e;
    var compact = String(raw == null || raw === "" ? "Maps 1-2" : raw).toLowerCase().replace(/_/g, " ").replace(/\s+/g, "");
    if (compact.indexOf("1-2") > -1 || compact.indexOf("maps12") > -1) return "Maps 1-2";
    if (compact === "map1" || (compact.indexOf("map1") === 0 && compact.indexOf("maps") !== 0)) return "Map 1";
    return "Maps 1-2";
  }
  function normStat(s) {
    s = String(s || "").toLowerCase();
    if (s.indexOf("head") > -1) return "hs";
    if (s.indexOf("kill") > -1) return "kills";
    return "";
  }
  function normName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  function dayOf(start) {
    var t = parseIso(start);
    if (isNaN(t)) return String(start || "").slice(0, 10);
    return new Date(t).toISOString().slice(0, 10);
  }
  function entryKey(e) {
    return normName(e.player) + "|" + normStat(e.stat) + "|" + dayOf(e.start) + "|" + periodOf(e);
  }
  function mean(a) {
    return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null;
  }
  function letterOf(g) {
    return String(g || "").replace(/\s*\(old\)\s*/i, "").trim();
  }

  function lockFirstPost(entries) {
    return (entries || []).map(function (e, i) { return [e, i]; }).sort(function (a, b) {
      var la = isPostUpdateLock(a[0]) ? 0 : 1, lb = isPostUpdateLock(b[0]) ? 0 : 1;
      return la - lb || a[1] - b[1];
    }).map(function (x) { return x[0]; });
  }

  function fromEntries(entries, nowMs) {
    nowMs = nowMs == null ? Date.now() : nowMs;
    var live = [], shadow = [], pending = 0, pushes = 0, voids = 0, waiting = 0, seen = {};
    lockFirstPost(entries).forEach(function (e) {
      if (!isPostUpdateLock(e)) return;
      var st = normStat(e.stat);
      if (!st || !e.start) return;
      var startMs = parseIso(e.start);
      if (isNaN(startMs)) return;
      var k = entryKey(e);
      if (seen[k]) return;
      if (startMs > nowMs - WAIT_MS) { pending++; return; }
      var rs = e.result || null;
      if (rs && rs.outcome === "void") { voids++; seen[k] = 1; return; }
      var lk = e.lock, line = +lk.line, act = rs && rs.act != null ? +rs.act : NaN;
      if (rs && (rs.outcome === "push" || act === line)) { pushes++; seen[k] = 1; return; }
      if (!rs || isNaN(act)) { waiting++; return; }
      if (act === line) { pushes++; seen[k] = 1; return; }
      var pick = lk.pick, proj = lk.proj == null ? null : +lk.proj;
      var hit = pick === "OVER" ? act > line : act < line;
      seen[k] = 1;
      var row = {
        player: e.player, team: e.team, opp: e.opponent, stat: st, period: periodOf(e),
        line: line, act: act, pick: pick, grade: letterOf(lk.grade), proj: isNaN(proj) ? null : proj,
        hit: hit, lat: lk.at || "", start: e.start, lan: isLan(e)
      };
      live.push(row);
      var s = e.shadow_s;
      if (s && !s.skipped && s.pick && s.line != null) {
        var sl = +s.line, sp = s.proj == null ? null : +s.proj;
        if (!isNaN(sl) && act !== sl) {
          shadow.push({
            player: e.player, stat: st, period: row.period, line: sl, act: act, pick: s.pick,
            grade: letterOf(s.grade), proj: isNaN(sp) ? null : sp,
            hit: s.pick === "OVER" ? act > sl : act < sl, lan: row.lan, start: e.start
          });
        }
      }
    });
    live.sort(function (a, b) { return a.start < b.start ? 1 : a.start > b.start ? -1 : 0; });
    shadow.sort(function (a, b) { return a.start < b.start ? 1 : a.start > b.start ? -1 : 0; });
    return { live: live, shadow: shadow, pending: pending, pushes: pushes, voids: voids, waiting: waiting };
  }

  function summary(rows) {
    rows = rows || [];
    var n = rows.length, w = rows.filter(function (r) { return r.hit; }).length, l = n - w;
    var diffs = rows.filter(function (r) { return r.proj != null && r.act != null; }).map(function (r) { return r.proj - r.act; });
    var avgMiss = diffs.length ? mean(diffs.map(Math.abs)) : null;
    var bias = diffs.length ? mean(diffs) : null;
    return {
      n: n, w: w, l: l,
      record: n ? (w + "-" + l) : "–",
      hitPct: n ? Math.round(w / n * 100) : null,
      hitLabel: n ? (w + "-" + l + " (" + Math.round(w / n * 100) + "%)") : "–",
      avgMiss: avgMiss,
      bias: bias
    };
  }

  function splits(rows) {
    rows = rows || [];
    var byLetter = {};
    rows.forEach(function (r) {
      var g = r.grade || "–";
      (byLetter[g] = byLetter[g] || []).push(r);
    });
    return {
      maps12: rows.filter(function (r) { return r.period !== "Map 1"; }),
      map1: rows.filter(function (r) { return r.period === "Map 1"; }),
      kills: rows.filter(function (r) { return r.stat === "kills"; }),
      hs: rows.filter(function (r) { return r.stat === "hs"; }),
      lan: rows.filter(function (r) { return r.lan; }),
      notLan: rows.filter(function (r) { return !r.lan; }),
      byLetter: byLetter
    };
  }

  function fv(x) { return x == null || isNaN(x) ? "–" : x.toFixed(1); }
  function biasTxt(x) { return x == null || isNaN(x) ? "–" : ((x >= 0 ? "+" : "") + x.toFixed(1)); }
  function defaultEsc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  function statCells(s) {
    return "<div class=\"stats\"><div class=\"st\"><b>" + (s.n ? s.record : "–") + "</b><span>Record" + (s.hitPct == null ? "" : " (" + s.hitPct + "%)") + "</span></div>" +
      "<div class=\"st\"><b>" + fv(s.avgMiss) + "</b><span>Avg miss</span></div>" +
      "<div class=\"st\"><b>" + biasTxt(s.bias) + "</b><span>Projection bias</span></div></div>";
  }

  function rowLine(label, rows) {
    var s = summary(rows);
    return "<tr><td>" + label + "</td><td>" + (s.n || "0") + "</td><td>" + s.hitLabel + "</td><td>" + fv(s.avgMiss) + "</td><td>" + biasTxt(s.bias) + "</td></tr>";
  }

  function splitTable(title, lines, esc) {
    esc = esc || defaultEsc;
    return "<h2 style=\"margin-top:12px\">" + esc(title) + "</h2><div class=\"scroll\"><table><tr><th>Group</th><th>Picks</th><th>Record</th><th>Avg miss</th><th>Bias</th></tr>" +
      lines.join("") + "</table></div>";
  }

  function letterTable(rows, esc) {
    esc = esc || defaultEsc;
    var sp = splits(rows), seen = {}, order = LETTERS.slice();
    rows.forEach(function (r) { var g = r.grade || "–"; if (order.indexOf(g) < 0 && !seen[g]) { order.push(g); seen[g] = 1; } });
    var lines = order.filter(function (G) { return (sp.byLetter[G] || []).length; }).map(function (G) {
      return rowLine(esc(G), sp.byLetter[G]);
    });
    if (!lines.length) return "";
    return splitTable("By letter", lines, esc);
  }

  function html(data, esc) {
    esc = esc || defaultEsc;
    var live = (data && data.live) || [];
    var shadow = (data && data.shadow) || [];
    var h = "<div class=\"card\" style=\"margin-top:12px\"><h2>Track record since the update</h2>";
    h += "<div class=\"muted\" style=\"margin-bottom:8px\">Only props locked after Nov 24, 2026, 2:09 AM CT, when the new grader changes went live. A pick is included by its lock timestamp (lock.at). There is no separate version tag on locks. The Track Record above is unchanged and still counts every settled pick.</div>";
    if (!live.length) {
      return h + "<div class=\"muted\">" + esc(EMPTY) + "</div></div>";
    }
    var sp = splits(live);
    h += statCells(summary(live));
    h += splitTable("Maps 1-2 vs Map 1", [rowLine("Maps 1-2", sp.maps12), rowLine("Map 1", sp.map1)], esc);
    h += splitTable("Kills vs Headshots", [rowLine("Kills", sp.kills), rowLine("Headshots", sp.hs)], esc);
    h += splitTable("LAN data vs not", [rowLine("LAN data", sp.lan), rowLine("Not LAN data", sp.notLan)], esc);
    h += letterTable(live, esc);
    h += "<h2 style=\"margin-top:16px\">Scout shadow · same period</h2>";
    h += "<div class=\"muted\" style=\"margin-bottom:6px\">Shadow S projections saved on the same post-update locks, scored against the same results. The live grade is unchanged.</div>";
    if (!shadow.length) {
      h += "<div class=\"muted\">No Scout shadow picks settled over this period yet.</div>";
    } else {
      var ss = splits(shadow);
      h += statCells(summary(shadow));
      h += splitTable("Scout shadow splits", [
        rowLine("Maps 1-2", ss.maps12), rowLine("Map 1", ss.map1),
        rowLine("Kills", ss.kills), rowLine("Headshots", ss.hs)
      ], esc);
      h += letterTable(shadow, esc);
    }
    var note = [];
    if (data.pending) note.push(data.pending + " pending");
    if (data.waiting) note.push(data.waiting + " waiting for results");
    if (data.pushes) note.push(data.pushes + " push" + (data.pushes === 1 ? "" : "es"));
    if (data.voids) note.push(data.voids + " void" + (data.voids === 1 ? "" : "s"));
    if (note.length) h += "<div class=\"muted\" style=\"margin-top:8px\">" + esc(note.join(", ")) + " left out of the hit rate.</div>";
    return h + "</div>";
  }

  var api = {
    UPDATE_LIVE_AT: UPDATE_LIVE_AT, EMPTY: EMPTY,
    parseIso: parseIso, isPostUpdateLock: isPostUpdateLock, isLan: isLan,
    periodOf: periodOf, normStat: normStat, fromEntries: fromEntries,
    summary: summary, splits: splits, html: html
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GPTrackSheet = api;
})(typeof window !== "undefined" ? window : this);
