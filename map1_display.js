/** Period labels for Maps 1-2 vs Map 1 props.
 *  Used by the Lines and Grader tabs (app.js). Keep this file free of DOM and of app state.
 *  A missing period (all historical lines) is Maps 1-2. "maps1-2" is never treated as Map 1.
 *
 *  Visible/graded feed lines (owner): either/or per game, Maps 1-2 takes priority.
 *    If a game has any Maps 1-2 lines -> only those Maps 1-2 lines (Map 1 is hidden)
 *    If a game has no Maps 1-2 lines and has Map 1 lines -> those Map 1 lines (1-map grades)
 *    Neither -> the game is not shown
 *  Applies to the Lines tab, slip auto-grading, and graded lines lists.
 *  The Lines tab board does not use that rule. It keeps every line and, when both kinds are up for the selected
 *  day and book, shows an All / Maps 1-2 / Map 1 filter (periodChoice / periodFilter below). The default view is Maps 1-2.
 *  Games with no PrizePicks or Underdog (or manual) lines are not listed on Lines or Games.
 *  The Grader tab manual period selector is separate and can still grade Map 1.
 */
(function (root) {
  function periodOf(l) {
    var raw = (l && typeof l === "object") ? l.period : l;
    var compact = String(raw == null || raw === "" ? "Maps 1-2" : raw)
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/\s+/g, "");
    if (compact.indexOf("1-2") > -1 || compact.indexOf("maps12") > -1) return "Maps 1-2";
    if (compact === "map1" || (compact.indexOf("map1") === 0 && compact.indexOf("maps") !== 0)) return "Map 1";
    return "Maps 1-2";
  }
  function isMap1(l) { return periodOf(l) === "Map 1"; }
  function isMaps12(l) { return periodOf(l) === "Maps 1-2"; }
  function isAcceptedPeriod(l) { return isMap1(l) || isMaps12(l); }
  function isPpUd(l) {
    if (l && l.src === "manual") return true;
    var b = String((l && l.book) || "").toLowerCase();
    return b.indexOf("prize") > -1 || b.indexOf("underdog") > -1;
  }
  function gameKey(l, tnFn, dayFn) {
    tnFn = tnFn || function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); };
    var a = tnFn(l.team || l.team1 || "");
    var b = tnFn(l.opponent || l.opp || l.team2 || "");
    var raw = l.start || l.starts_at || "";
    var day = dayFn ? dayFn(raw) : String(raw).slice(0, 10);
    return [a, b].sort().join("|") + "|" + day;
  }
  /** Keep Maps 1-2 lines when a game has any; otherwise keep Map 1. Original order is kept. */
  function linesTabLines(lines, tnFn, dayFn) {
    var flag = {};
    (lines || []).forEach(function (l) {
      if (!isAcceptedPeriod(l)) return;
      var k = gameKey(l, tnFn, dayFn);
      var g = flag[k] || (flag[k] = { has12: false });
      if (isMaps12(l)) g.has12 = true;
    });
    return (lines || []).filter(function (l) {
      if (!isAcceptedPeriod(l)) return false;
      var g = flag[gameKey(l, tnFn, dayFn)];
      if (!g) return false;
      return g.has12 ? isMaps12(l) : isMap1(l);
    });
  }
  /** Keys of games that have at least one PrizePicks, Underdog, or manual line after the period rule. */
  function listedGameKeys(lines, tnFn, dayFn) {
    var keys = {};
    linesTabLines(lines, tnFn, dayFn).forEach(function (l) {
      if (!isPpUd(l)) return;
      keys[gameKey(l, tnFn, dayFn)] = true;
    });
    return keys;
  }
  function gameIsListed(g, keys, tnFn, dayFn) {
    if (!g || !keys) return false;
    return !!keys[gameKey({ team: g.team1, opponent: g.team2, start: g.start || g.starts_at }, tnFn, dayFn)];
  }
  /** mode: "all" | "12" (Maps 1-2) | "m1" (Map 1). Anything else counts as "all". */
  function periodMatches(l, mode) {
    if (mode === "12") return isMaps12(l);
    if (mode === "m1") return isMap1(l);
    return true;
  }
  function periodFilter(rows, mode) {
    return (rows || []).filter(function (l) { return periodMatches(l, mode); });
  }
  /** Lines tab filter state for the rows of the selected day and book (every line, no either/or rule applied).
   *  show: both kinds are up, so the filter is shown. mode: what to show now. n: row counts per button.
   *  `chosen` is the saved click ("all", "12", "m1" or nothing). Nothing chosen means Maps 1-2, as before.
   *  With only one kind up there is nothing to filter, so mode is "all". */
  function periodChoice(rows, chosen) {
    var n = { "12": 0, m1: 0, all: 0 };
    (rows || []).forEach(function (l) {
      if (isMaps12(l)) n["12"]++;
      else if (isMap1(l)) n.m1++;
      else return;
      n.all++;
    });
    var show = n["12"] > 0 && n.m1 > 0;
    var mode = chosen === "all" || chosen === "m1" || chosen === "12" ? chosen : "12";
    return { show: show, mode: show ? mode : "all", n: n };
  }
  var api = {
    periodOf: periodOf, isMap1: isMap1, isMaps12: isMaps12, isAcceptedPeriod: isAcceptedPeriod,
    isPpUd: isPpUd, gameKey: gameKey, linesTabLines: linesTabLines,
    listedGameKeys: listedGameKeys, gameIsListed: gameIsListed,
    periodMatches: periodMatches, periodFilter: periodFilter, periodChoice: periodChoice
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GPMap1 = api;
})(typeof window !== "undefined" ? window : this);
