// Grader card (display only): the stats block, the "Kills / Map L10" box and the team logo.
//  - "Kills 1-2 L10" is the average TOTAL Maps 1-2 kills over the last 10 Maps 1-2 series, on every card (Map 1 props too).
//  - "Kills / Map L10" is the average kills per map over the last 10 series of the prop's own period.
//  - The team logo is the real one or nothing: no made-up monogram.
var fs = require("fs"), path = require("path"), vm = require("vm");
var failed = 0;
function check(name, ok) { console.log((ok ? "  ok  " : "  FAIL  ") + name); if (!ok) failed++; }

function load(extra, logos) {
  var win = {};
  var ctx = { window: win, document: { addEventListener: function () {}, dispatchEvent: function () {}, querySelectorAll: function () { return []; } }, Event: function () {},
    fetch: function (u) { return /team_logos/.test(u) && logos ? Promise.resolve({ ok: true, json: function () { return Promise.resolve({ logos: logos }); } }) : Promise.reject(new Error("no network")); },
    setTimeout: function () {}, console: console };
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
function rows(vals, hs) { return vals.map(function (v) { return { kills: v, hs: hs == null ? 5 : hs, deaths: 12 }; }); }

var GPMap1 = require("../map1_display.js");
var C = load({ GPMap1: GPMap1 });
var L = "Kills / Map L10", K12 = "Kills 1-2 L10";

console.log("Maps 1-2 card: a series is two maps");
var m12 = rows([34, 30, 32, 32, 30, 34, 32, 32, 30, 34, 90]); // newest 10 total average 32; 11th is older
var h2 = C.html(g({ period: "Maps 1-2", stat: "kills", cs: m12 }));
check("Kills 1-2 L10 is the total, averaged over the last 10 series (32.0)", box(h2, K12) === "32.0");
check("the 11th (older) series is not counted", box(h2, K12) !== "38.7");
check("Kills / Map L10 is that total / 2 (16.0)", box(h2, L) === "16.0");
check("fewer than 10 series uses what there is", box(C.html(g({ period: "Maps 1-2", stat: "kills", cs: rows([30, 34]) })), L) === "16.0");
check("no series gives dashes", box(C.html(g({ period: "Maps 1-2", cs: [] })), L) === "–" && box(C.html(g({ period: "Maps 1-2", cs: [] })), K12) === "–");
check("a series with no kills is left out", box(C.html(g({ period: "Maps 1-2", stat: "kills", cs: rows([30, null, 34]) })), K12) === "32.0");

console.log("Map 1 card: g.cs is one Map 1 per series, g.cs12 is the Maps 1-2 series");
var m1 = rows([20, 18, 16, 14, 12, 10, 18, 16, 14, 12, 40, 40]); // newest 10 Map 1 average 15.0
var c12 = rows([34, 30, 32, 32, 30, 34, 32, 32, 30, 34, 90], 8);
var h = C.html(g({ period: "Map 1", cs: m1, cs12: c12 }));
check("Kills / Map L10 is the last 10 Map 1 kills (15.0), not the whole season", box(h, L) === "15.0");
check("Kills 1-2 L10 is the Maps 1-2 TOTAL (32.0), not the Map 1 number", box(h, K12) === "32.0");
check("the two boxes are different numbers", box(h, L) !== box(h, K12));
check("HS 1-2 L10 uses the Maps 1-2 series too (8.0)", box(h, "HS 1-2 L10") === "8.0");
check("HS / Map is total HS / 2 per series (4.0), not halved twice", box(h, "HS / Map") === "4.0");
check("HS% and K/D come from the Maps 1-2 series", box(h, "HS%") === Math.round(88 / 410 * 100) + "%" && box(h, "K/D") === (410 / (11 * 12)).toFixed(2));
check("series count in the label is the Maps 1-2 count (11)", /Season · Maps 1-2 · 11 series/.test(h));
var hno = C.html(g({ period: "Map 1", cs: m1 }));
check("Map 1 card with no Maps 1-2 data shows dashes, never Map 1 numbers under a 1-2 label", box(hno, K12) === "–" && box(hno, "HS%") === "–");
check("...and still shows the per-map box from its own series", box(hno, L) === "15.0");
check("a series with no kills is left out of the Map 1 average", box(C.html(g({ period: "Map 1", cs: rows([20, null, 10]), cs12: c12 })), L) === "15.0");
check("works without the Map 1 helper loaded", box(load({}).html(g({ period: "Map 1", cs: m1, cs12: c12 })), K12) === "32.0");

console.log("Header says which period the prop is");
check("Map 1 prop header says Map 1 (and LAN data)", /<div class="tc-stat">Headshots · Map 1 · LAN data<\/div>/.test(C.html(g({ period: "Map 1", lan: true, cs: m1, cs12: c12 }))));
check("Maps 1-2 prop header says Maps 1-2", /<div class="tc-stat">Kills · Maps 1-2<\/div>/.test(h2.replace("Headshots", "Kills")) || /<div class="tc-stat">Headshots · Maps 1-2<\/div>/.test(h2));
check("a prop with no period is treated as Maps 1-2", /<div class="tc-stat">Headshots · Maps 1-2<\/div>/.test(C.html(g({ cs: m12 }))));

console.log("Team logo: the real one or nothing");
check("no logo known: the logo badge is hidden and has no letters in it", /<div class="tc-logo none" data-team="M80"><\/div>/.test(h));
check("no monogram text anywhere in the logo badge", !/tc-logo[^>]*>[^<]*<span/.test(h));
var CL = load({ GPMap1: GPMap1 }, { M80: "https://files.bo3.gg/uploads/team/1/image/m80.webp" });
Promise.resolve().then(function () { return new Promise(function (r) { setImmediate(r); }); }).then(function () {
  var hl = CL.html(g({ period: "Maps 1-2", stat: "kills", cs: m12 }));
  check("real logo known: shown as an image", /<div class="tc-logo" data-team="M80"><img src="https:\/\/files\.bo3\.gg\/uploads\/team\/1\/image\/m80\.webp"/.test(hl));
  check("a logo that fails to load hides the badge (no fallback letters)", /onerror="this\.parentNode\.classList\.add\('none'\);this\.remove\(\)"/.test(hl));

  var src = fs.readFileSync(path.join(__dirname, "..", "cards.js"), "utf8");
  var css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8").replace(/\s+/g, "");
  check("no monogram helper left in cards.js", !/function mono\(/.test(src) && !/mono\(/.test(src));
  check("image export draws the logo ring only when there is a logo", (src.match(/if\(logo\)\{var lx=/g) || []).length === 2 && !/else\{x\.fillStyle=t\.accent;var tm/.test(src));
  check("CSS hides a logo badge with no logo", /\.tc-logo\.none\{display:none\}/.test(css) && !/\.tc-logo\.mono/.test(css));

  check("image export header uses the same period label", /fillText\(\(sname\(g\.stat\)\+' · '\+\(isM1\(g\)\?'Map 1':'Maps 1-2'\)\)\.toUpperCase\(\)/.test(src));
  console.log("Image export uses the same stats");
  check("canvas card has the KILLS / MAP L10 and KILLS 1-2 L10 cells", src.indexOf("[q.kpm,'KILLS / MAP L10']") > -1 && src.indexOf("[q.kl10,'KILLS 1-2 L10']") > -1);

  console.log("display only: nothing here feeds the grade");
  check("pstats is only read for display (back of card and image)", (src.match(/pstats\(/g) || []).length === 3);
  var code = src.split("\n").filter(function (l) { return !/^\s*\/\//.test(l); }).join("\n");
  check("cards.js does not call grade/project/lock", !/\b(GPModel\.project|gradeFor|lockPick|\.lock\()/.test(code));
  var app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  check("grade() adds cs12 only as an extra field, after cs", /cs:cs,cs12:\(\(typeof GPMap1!=='undefined'&&GPMap1\.isMap1\(\{period:o\.period\}\)\)\|\|o\.period==='Map 1'\)\?combos\(p\):cs,adj:adj/.test(app));
  check("cs12 is read nowhere in the grade code", (app.match(/cs12/g) || []).length === 1 && (fs.readFileSync(path.join(__dirname, "..", "model.js"), "utf8").match(/cs12/g) || []).length === 0);

  if (failed) { console.log("FAILED " + failed); process.exit(1); } else console.log("all ok");
});
