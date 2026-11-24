// The grader card's "Kills / Map L10" box: average kills per map over the last 10 series. Display only.
// (Name kept from the first version of this fix, which averaged Map 1 kills over the whole season.)
var fs = require("fs"), path = require("path"), vm = require("vm");
var failed = 0;
function check(name, ok) { console.log((ok ? "  ok  " : "  FAIL  ") + name); if (!ok) failed++; }

function load(extra) {
  var win = {};
  var ctx = { window: win, document: { addEventListener: function () {}, dispatchEvent: function () {} }, Event: function () {},
    fetch: function () { return Promise.reject(new Error("no network")); }, setTimeout: function () {}, console: console };
  Object.keys(extra || {}).forEach(function (k) { win[k] = extra[k]; });
  ctx.GPMap1 = win.GPMap1;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "cards.js"), "utf8"), ctx);
  return win.GPCards;
}
function box(html, label) {
  var m = html.match(new RegExp("<b>([^<]*)</b><i>" + label.replace(/[\/]/g, "\\/") + "</i>"));
  return m ? m[1] : null;
}
var base = { player: "Lake", team: "M80", opp: "Heroic", stat: "hs", line: 6.5, proj: 7.8, grade: "B", pick: "OVER", pPick: 0.65, edgePP: 11.8, book: "Underdog", hits: { l10: [8, 10] } };
function g(over) { var o = {}; Object.keys(base).forEach(function (k) { o[k] = base[k]; }); Object.keys(over).forEach(function (k) { o[k] = over[k]; }); return o; }
function rows(vals) { return vals.map(function (v) { return { kills: v, hs: 5, deaths: 12 }; }); }

var GPMap1 = require("../map1_display.js");
var C = load({ GPMap1: GPMap1 });
var L = "Kills / Map L10";

console.log("Map 1 prop: every series is one Map 1 (newest first)");
var m1 = rows([20, 18, 16, 14, 12, 10, 18, 16, 14, 12, 40, 40]); // newest 10 average 15.0; all 12 would be 20.8
var h = C.html(g({ period: "Map 1", cs: m1 }));
check("shows the last 10 Map 1 average (15.0), not the whole season", box(h, L) === "15.0");
check("older series are not counted", box(h, L) !== "20.8");
check("a series with no kills is left out of the average", box(C.html(g({ period: "Map 1", cs: rows([20, null, 10]) })), L) === "15.0");

console.log("Maps 1-2 prop: a series is two maps, so the box is total / 2");
var m12 = rows([34, 30, 32, 32, 30, 34, 32, 32, 30, 34, 90]); // newest 10 total average 32 -> 16.0 per map
var h2 = C.html(g({ period: "Maps 1-2", stat: "kills", cs: m12 }));
check("per map = (last 10 series total avg 32) / 2 = 16.0", box(h2, L) === "16.0");
check("the 11th series is not counted", box(h2, L) !== "21.3");
check("matches the Kills 1-2 L10 box divided by 2", Math.abs(parseFloat(box(h2, "Kills 1-2 L10")) / 2 - parseFloat(box(h2, L))) < 0.06);

console.log("Edge cases");
check("no series gives a dash", box(C.html(g({ period: "Map 1", cs: [] })), L) === "–");
check("no kills data gives a dash", box(C.html(g({ period: "Maps 1-2", cs: rows([null, null]) })), L) === "–");
check("fewer than 10 series uses what there is", box(C.html(g({ period: "Maps 1-2", stat: "kills", cs: rows([30, 34]) })), L) === "16.0");
var C2 = load({});
check("works without the Map 1 helper loaded", box(C2.html(g({ period: "Map 1", cs: m1 })), L) === "15.0");

console.log("Other boxes are not changed by the fix");
check("HS% unchanged: all headshots / all kills = 60/230", box(h, "HS%") === Math.round(60 / 230 * 100) + "%");
check("K/D unchanged", box(h, "K/D") === (m1.reduce(function (a, c) { return a + c.kills; }, 0) / (12 * 12)).toFixed(2));
check("Kills 1-2 L10 box still there", box(h2, "Kills 1-2 L10") === "32.0");
check("the old Kills Map 1 label is gone", h.indexOf("<i>Kills Map 1</i>") < 0);

console.log("Image export uses the same stat");
var src = fs.readFileSync(path.join(__dirname, "..", "cards.js"), "utf8");
check("canvas card has the KILLS / MAP L10 cell", src.indexOf("[q.kpm,'KILLS / MAP L10']") > -1 && src.indexOf("KILLS MAP 1") < 0);

console.log("display only: the card code never touches the grade");
check("pstats is only read for display (back of card and image)", (src.match(/pstats\(/g) || []).length === 3);
var code = src.split("\n").filter(function (l) { return !/^\s*\/\//.test(l); }).join("\n");
check("cards.js does not call grade/project/lock", !/\b(GPModel\.project|gradeFor|lockPick|\.lock\()/.test(code));

if (failed) { console.log("FAILED " + failed); process.exit(1); } else console.log("all ok");
