// The grader card's "Kills Map 1" box: average Map 1 kills, display only.
// Map 1 props have one Map 1 per series (no kills1 field), so the box used to show a dash for them.
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
  var m = html.match(new RegExp("<b>([^<]*)</b><i>" + label + "</i>"));
  return m ? m[1] : null;
}
var base = { player: "Lake", team: "M80", opp: "Heroic", stat: "hs", line: 6.5, proj: 7.8, grade: "B", pick: "OVER", pPick: 0.65, edgePP: 11.8, book: "Underdog", hits: { l10: [8, 10] } };
function g(over) { var o = {}; Object.keys(base).forEach(function (k) { o[k] = base[k]; }); Object.keys(over).forEach(function (k) { o[k] = over[k]; }); return o; }

var GPMap1 = require("../map1_display.js");
var C = load({ GPMap1: GPMap1 });

console.log("Map 1 prop: every series is one Map 1");
var m1rows = [{ kills: 20, hs: 8, deaths: 12 }, { kills: 15, hs: 6, deaths: 15 }, { kills: 10, hs: 5, deaths: 14 }, { kills: null, hs: 4, deaths: 10 }];
var h = C.html(g({ period: "Map 1", cs: m1rows }));
check("Kills Map 1 shows the average of the Map 1 kills (20+15+10)/3", box(h, "Kills Map 1") === "15.0");
check("a series with no kills is left out", box(h, "Kills Map 1") !== "11.3");
check("Map 1 prop on a Headshots card still shows it", /<i>Kills Map 1<\/i>/.test(h));

console.log("Maps 1-2 prop: unchanged (kills1 field)");
var m12rows = [{ kills: 33, kills1: 18, hs: 14, deaths: 25 }, { kills: 30, kills1: 12, hs: 11, deaths: 24 }];
var h2 = C.html(g({ period: "Maps 1-2", stat: "kills", cs: m12rows }));
check("Maps 1-2 uses kills1: (18+12)/2", box(h2, "Kills Map 1") === "15.0");
var h3 = C.html(g({ period: "Maps 1-2", stat: "kills", cs: [{ kills: 33, hs: 14, deaths: 25 }] }));
check("Maps 1-2 with no kills1 data still shows a dash (never the 2-map total)", box(h3, "Kills Map 1") === "–");

console.log("Other boxes are not changed by the fix");
check("HS% unchanged: only series with kills count, 19/45", box(h, "HS%") === Math.round(19 / 45 * 100) + "%");
check("K/D unchanged", box(h, "K/D") === (45 / 41).toFixed(2));
check("Maps 1-2 K/D unchanged", box(h2, "K/D") === (63 / 49).toFixed(2));

console.log("Fallback without GPMap1 loaded");
var C2 = load({});
check("period 'Map 1' still works", box(C2.html(g({ period: "Map 1", cs: m1rows })), "Kills Map 1") === "15.0");
check("no series gives a dash", box(C2.html(g({ period: "Map 1", cs: [] })), "Kills Map 1") === "–");

console.log("display only: the card code never touches the grade");
var src = fs.readFileSync(path.join(__dirname, "..", "cards.js"), "utf8");
check("pstats is only read for display (back of card and image)", (src.match(/pstats\(/g) || []).length === 3);
var code = src.split("\n").filter(function (l) { return !/^\s*\/\//.test(l); }).join("\n");
check("cards.js does not call grade/project/lock", !/\b(GPModel\.project|gradeFor|lockPick|\.lock\()/.test(code));

if (failed) { console.log("FAILED " + failed); process.exit(1); } else console.log("all ok");
