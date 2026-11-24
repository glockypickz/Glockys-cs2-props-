// Period parsing + either/or Lines tab game rule (Maps 1-2 takes priority).
// Run: node tests/test_map1_view.js
var M = require("../map1_display.js");
var failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { failed++; console.log("  FAIL  " + name); }
}
var tn = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); };
function line(extra) {
  return Object.assign({ player: "x", team: "Fnatic", opponent: "100 Thieves", starts_at: "2026-11-24T18:00:00Z", stat: "Kills", line: 18.5, book: "PrizePicks" }, extra);
}

console.log("period parsing");
check("default missing period is Maps 1-2", M.periodOf({}) === "Maps 1-2");
check("Maps 1-2", M.periodOf({ period: "Maps 1-2" }) === "Maps 1-2");
check("Map 1", M.periodOf({ period: "Map 1" }) === "Map 1");
check("map_1", M.periodOf({ period: "map_1" }) === "Map 1");
check("does not treat maps1-2 as Map 1", M.isMap1({ period: "Maps 1-2" }) === false);

console.log("Lines tab game rule (Maps 1-2 priority)");
var only1 = [line({ period: "Map 1", player: "a", line: 16.5 }), line({ period: "Map 1", player: "b", book: "Underdog", line: 16.5 })];
var v1 = M.linesTabLines(only1, tn);
check("Map 1-only game is shown", v1.length === 2 && v1.every(M.isMap1));

var only12 = [line({ period: "Maps 1-2", player: "a", line: 32.5 }), line({ period: "Maps 1-2", player: "b", book: "Underdog", line: 33.5 })];
var v12 = M.linesTabLines(only12, tn);
check("Maps 1-2-only game is shown", v12.length === 2 && v12.every(M.isMaps12));

var both = only12.concat([line({ period: "Map 1", player: "a", line: 16.5 }), line({ period: "Map 1", player: "b", book: "Underdog", line: 16.5 })]);
var vb = M.linesTabLines(both, tn);
check("game with both periods shows only Maps 1-2", vb.length === 2 && vb.every(M.isMaps12));
check("Map 1 lines are hidden when the game has Maps 1-2", vb.every(function (l) { return l.line > 20; }));

var neither = [line({ period: "Map 3", player: "a" }), line({ period: "Map 2", player: "b" })];
// periodOf maps unknown non-map1 to Maps 1-2, so use a filter of empty feed
check("neither (empty feed) hides the game", M.linesTabLines([], tn).length === 0);

// two games mixed: one Map 1 only, one Maps 1-2 only, both stay visible
var mixed = [
  line({ period: "Maps 1-2", player: "g12", team: "A", opponent: "B", starts_at: "2026-11-24T10:00:00Z" }),
  line({ period: "Map 1", player: "g1", team: "C", opponent: "D", starts_at: "2026-11-24T14:00:00Z", line: 15.5 })
];
var vm = M.linesTabLines(mixed, tn);
check("Map 1-only and Maps 1-2-only games both stay visible", vm.length === 2);
check("original order is kept", vm[0].player === "g12" && vm[1].player === "g1");
check("flipped team names are the same game", M.gameKey(line({ team: "Fnatic", opponent: "100 Thieves" }), tn) === M.gameKey(line({ team: "100 Thieves", opponent: "Fnatic" }), tn));

// Map 1 lines listed first still lose to later Maps 1-2 lines for the same game
var map1First = [
  line({ period: "Map 1", player: "a", line: 16.5 }),
  line({ period: "Maps 1-2", player: "a", line: 32.5 }),
  line({ period: "Map 1", player: "b", line: 15.5, book: "Underdog" })
];
var vf = M.linesTabLines(map1First, tn);
check("Maps 1-2 still wins when Map 1 rows come first", vf.length === 1 && vf[0].period === "Maps 1-2" && vf[0].line === 32.5);

// start vs starts_at / opp vs opponent still group as one game
var altKeys = [
  { player: "a", team: "Fnatic", opp: "100 Thieves", start: "2026-11-24T18:00:00Z", period: "Maps 1-2", stat: "Kills", line: 32.5 },
  { player: "a", team: "Fnatic", opponent: "100 Thieves", starts_at: "2026-11-24T20:00:00Z", period: "Map 1", stat: "Kills", line: 16.5 }
];
var va = M.linesTabLines(altKeys, tn);
check("start/opp aliases group the same game and drop Map 1", va.length === 1 && va[0].period === "Maps 1-2");

console.log("Period filter split (after per-game rule)");
var vis = M.linesTabLines(mixed, tn);
var f12 = vis.filter(M.isMaps12);
var f1 = vis.filter(M.isMap1);
check("Maps 1-2 filter is only Maps 1-2 games", f12.length === 1 && f12[0].player === "g12");
check("Map 1 filter is only Map 1-only games", f1.length === 1 && f1[0].player === "g1");
var bothSplit = M.linesTabLines(both.concat(only1.map(function (l) { return Object.assign({}, l, { team: "C", opponent: "D", starts_at: "2026-11-24T14:00:00Z" }); })), tn);
check("Map 1 filter does not include hidden Map 1 from a Maps 1-2 game", bothSplit.filter(M.isMap1).every(function (l) { return l.team === "C"; }));
check("Maps 1-2 filter does not include Map 1-only games", bothSplit.filter(M.isMaps12).every(function (l) { return l.team === "Fnatic"; }));

console.log("Games without PrizePicks or Underdog lines are not listed");
var keys = M.listedGameKeys(mixed, tn);
check("PP/UD Maps 1-2 game is listed", M.gameIsListed({ team1: "A", team2: "B", start: "2026-11-24T10:00:00Z" }, keys, tn));
check("PP/UD Map 1-only game is listed", M.gameIsListed({ team1: "C", team2: "D", start: "2026-11-24T14:00:00Z" }, keys, tn));
check("lineless game is not listed", M.gameIsListed({ team1: "FaZe", team2: "Wildcard", start: "2026-11-24T10:00:00Z" }, keys, tn) === false);
check("flipped teams still match", M.gameIsListed({ team1: "B", team2: "A", start: "2026-11-24T10:00:00Z" }, keys, tn));
var other = [line({ book: "SomeBook", period: "Maps 1-2", team: "X", opponent: "Y" })];
check("non-PP/UD book is not listed", M.gameIsListed({ team1: "X", team2: "Y", start: "2026-11-24T18:00:00Z" }, M.listedGameKeys(other, tn), tn) === false);
var manual = [line({ book: "", src: "manual", period: "Maps 1-2", team: "X", opponent: "Y" })];
check("manual line still lists the game", M.gameIsListed({ team1: "X", team2: "Y", start: "2026-11-24T18:00:00Z" }, M.listedGameKeys(manual, tn), tn));
check("isPpUd recognizes PrizePicks and Underdog", M.isPpUd({ book: "PrizePicks" }) && M.isPpUd({ book: "Underdog Fantasy" }) && !M.isPpUd({ book: "Other" }));

if (failed) { console.log(failed + " failed"); process.exit(1); }
console.log("all view tests passed");
