/** Period labels for Maps 1-2 vs Map 1 props.
 *  Used by the Lines and Grader tabs (app.js). Keep this file free of DOM and of app state.
 *  A missing period (all historical lines) is Maps 1-2. "maps1-2" is never treated as Map 1.
 *
 *  Lines tab (owner, final): show a game if it has Map 1 lines OR Maps 1-2 lines.
 *    Map 1 only  -> those Map 1 lines (graded on Map 1 stats)
 *    Maps 1-2 only -> those Maps 1-2 lines (graded on Maps 1-2)
 *    both -> both, labeled
 *    neither -> the game is not shown
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
  function gameKey(l, tnFn, dayFn) {
    tnFn = tnFn || function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); };
    var a = tnFn(l.team || l.team1 || "");
    var b = tnFn(l.opponent || l.opp || l.team2 || "");
    var raw = l.start || l.starts_at || "";
    var day = dayFn ? dayFn(raw) : String(raw).slice(0, 10);
    return [a, b].sort().join("|") + "|" + day;
  }
  /** Lines on the Lines tab: keep a game when it has Map 1 and/or Maps 1-2 lines. Original order is kept. */
  function linesTabLines(lines, tnFn, dayFn) {
    var flag = {};
    (lines || []).forEach(function (l) {
      if (!isAcceptedPeriod(l)) return;
      var k = gameKey(l, tnFn, dayFn);
      var g = flag[k] || (flag[k] = { has1: false, has12: false });
      if (isMap1(l)) g.has1 = true;
      if (isMaps12(l)) g.has12 = true;
    });
    return (lines || []).filter(function (l) {
      if (!isAcceptedPeriod(l)) return false;
      var g = flag[gameKey(l, tnFn, dayFn)];
      return !!(g && (g.has1 || g.has12));
    });
  }
  var api = { periodOf: periodOf, isMap1: isMap1, isMaps12: isMaps12, isAcceptedPeriod: isAcceptedPeriod, gameKey: gameKey, linesTabLines: linesTabLines };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GPMap1 = api;
})(typeof window !== "undefined" ? window : this);
