// Insights tab: facts from the grade's own data, used/unused dots, Map 1 scope.
// Run: node tests/test_insights.js
var I = require("../insights.js");
var failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { failed++; console.log("  FAIL  " + name); }
}

function series(rows) {
  return rows.map(function (r, i) {
    return {
      mid: r.mid || (100 + i), date: r.date || ("2026-11-" + String(20 - i).padStart(2, "0")),
      opp: r.opp || "Opp", maps: r.maps || "Mirage + Inferno",
      kills: r.kills, hs: r.hs == null ? null : r.hs, ev: r.ev || null, rd: r.rd || 24
    };
  });
}

function grade(extra) {
  var cs = series([
    { kills: 28, ev: "online" }, { kills: 30, ev: "online" }, { kills: 22, ev: "lan" },
    { kills: 18, ev: "online" }, { kills: 19, ev: "online" }, { kills: 21, ev: "lan" },
    { kills: 20, ev: "online" }, { kills: 17, ev: "lan" }, { kills: 16, ev: "online" },
    { kills: 15, ev: "lan" }, { kills: 14, ev: "online" }, { kills: 33, ev: "lan" },
    { kills: 12, ev: "online" }, { kills: 11, ev: "lan" }, { kills: 10, ev: "online" },
    { kills: 9, ev: "online" }, { kills: 8, ev: "lan" }, { kills: 7, ev: "online" },
    { kills: 6, ev: "lan" }, { kills: 5, ev: "online" }
  ]);
  var l10 = cs.slice(0, 10).map(function (c) { return c.kills; });
  var l3 = cs.slice(0, 3).map(function (c) { return c.kills; });
  var all = cs.map(function (c) { return c.kills; });
  var mean = function (a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; };
  var base = {
    player: "Tester", team: "Fnatic", opp: "Vitality", stat: "kills", line: 24.5,
    period: "Maps 1-2", proj: 20.1, edge: -4.4, grade: "F", pick: "UNDER", pPick: 0.64,
    cs: cs, of: cs.length, over: 3, reasons: [], bait: false,
    v1: {
      parts: [
        { key: "l10", label: "Last 10 series", w: 0.35, v: mean(l10), n: 10 },
        { key: "szn", label: "Season (all series)", w: 0.20, v: mean(all), n: all.length },
        { key: "h2h", label: "Head-to-head vs Vitality", w: 0.20, v: null, n: 0 },
        { key: "tier", label: "Same rank tier as Vitality", w: 0.15, v: 18.0, n: 8 },
        { key: "l3", label: "Last 3 series", w: 0.10, v: mean(l3), n: 3 }
      ],
      adr_used: true, adr_mult: 0.97
    }
  };
  if (extra) Object.keys(extra).forEach(function (k) { base[k] = extra[k]; });
  return base;
}

console.log("headline");
var ins = I.build(grade());
check("builds", !!ins);
check("title uses pick and line", ins.headline.title === "Why we lean Under 24.5");
check("projection and gap are in the text", ins.headline.text.indexOf("Projection 20.1") > -1 && ins.headline.text.indexOf("4.4 below the line") > -1);
check("chance and letter are in the text", ins.headline.text.indexOf("64% chance of Under (F)") > -1);

console.log("used vs unused");
var usedKeys = {};
ins.support.concat(ins.risk, ins.also).forEach(function (x) { usedKeys[x.key] = x.used; });
check("last 10 average is used", usedKeys.l10 === true);
check("season average is used", usedKeys.szn === true);
check("same-tier average is used", usedKeys.tier === true);
check("last 3 is used", usedKeys.l3 === true);
check("hit rate is not used", usedKeys.hr === false || usedKeys.hr5 === false || ins.support.concat(ins.risk).some(function (x) { return x.key.indexOf("hr") === 0 && !x.used; }));
check("scope note is used", usedKeys.scope === true);
check("ADR is used", usedKeys.adr === true);

console.log("hit counts match the series");
// last 10 kills: 28,30,22,18,19,21,20,17,16,15 vs 24.5 -> under 8, over 2
var hr = ins.support.concat(ins.risk, ins.also).filter(function (x) { return x.key === "hr"; })[0];
check("has a last-10 hit-rate item", !!hr);
check("says 8 of last 10 under", !!hr && /Went Under in 8 of the last 10/.test(hr.text));
check("includes L5/L20/season counts", !!hr && /L5 /.test(hr.text) && /L20 /.test(hr.text) && /season /.test(hr.text));

console.log("what could go wrong / last 3");
// last 3: 28,30,22 mean 26.7, above 24.5, so a used counter
var l3r = ins.risk.filter(function (x) { return x.key === "l3"; })[0];
check("last 3 above the line is a used counter-signal", !!l3r && l3r.used);

console.log("skip missing data");
var noOpp = I.build(grade({
  opp: "",
  v1: { parts: [
    { key: "l10", w: 0.35, v: 20, n: 10 },
    { key: "szn", w: 0.20, v: 16, n: 20 },
    { key: "h2h", w: 0.20, v: null, n: 0 },
    { key: "tier", w: 0.15, v: null, n: 0 },
    { key: "l3", w: 0.10, v: 19, n: 3 }
  ], adr_used: false, adr_mult: 1 }
}));
check("skips empty head-to-head", noOpp.support.concat(noOpp.risk, noOpp.also).every(function (x) { return x.key !== "h2h"; }));
check("skips empty same-tier", noOpp.support.concat(noOpp.risk, noOpp.also).every(function (x) { return x.key !== "tier"; }));
check("skips LAN split when one ev is thin", (function () {
  var g = grade();
  g.cs = g.cs.map(function (c, i) { return Object.assign({}, c, { ev: i < 2 ? "lan" : "online" }); });
  var x = I.build(g);
  return x.support.concat(x.risk, x.also).every(function (it) { return it.key !== "lan"; });
})());
check("skips map pool when strength is missing", ins.also.every(function (x) { return x.key !== "maps"; }));
check("returns null when there is no grade", I.build(null) == null);
check("returns null when the combo is missing a player", I.build({ missing: "A" }) == null);

console.log("map pool and map averages from real-shaped data");
var strength = {
  maps: {
    fnatic: [{ asof: "2026-11-17", maps: { Dust2: [7, 141, 43.8], Mirage: [2, 37, 12.5], Nuke: [1, 14, 6.3] } }],
    vitality: [{ asof: "2026-11-17", maps: { Dust2: [3, 60, 20], Mirage: [8, 160, 50], Inferno: [2, 40, 15] } }]
  }
};
var logs = [];
for (var i = 0; i < 6; i++) logs.push({ n: 1, map: "Dust2", kills: 18 + i, mid: 1 + i, ev: "online" });
for (var j = 0; j < 6; j++) logs.push({ n: 2, map: "Dust2", kills: 16 + j, mid: 1 + j, ev: "online" });
var withMaps = I.build(grade(), { strength: strength, logs: logs, tn: function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); } });
var mapsItem = withMaps.also.filter(function (x) { return x.key === "maps"; })[0];
check("map-pool item exists", !!mapsItem);
check("map-pool is not used in the grade", !!mapsItem && mapsItem.used === false);
check("lists map percentages", !!mapsItem && /Dust2 \d+%/.test(mapsItem.text) && /Mirage \d+%/.test(mapsItem.text));
check("uses the as-of date from the snapshot", !!mapsItem && mapsItem.text.indexOf("2026-11-17") > -1);
check("adds the player's map average with sample size", !!mapsItem && /He averages /.test(mapsItem.text) && /Dust2/.test(mapsItem.text) && /\(\d+ maps\)/.test(mapsItem.text));

console.log("Map 1 scope");
var m1cs = series([
  { kills: 14, ev: "online", maps: "Mirage" }, { kills: 16, ev: "lan", maps: "Dust2" },
  { kills: 11, ev: "online", maps: "Nuke" }, { kills: 10, ev: "online", maps: "Inferno" },
  { kills: 9, ev: "lan", maps: "Ancient" }, { kills: 8, ev: "online", maps: "Mirage" },
  { kills: 15, ev: "online", maps: "Dust2" }, { kills: 7, ev: "lan", maps: "Nuke" },
  { kills: 6, ev: "online", maps: "Inferno" }, { kills: 12, ev: "online", maps: "Ancient" }
]);
var m1 = I.build(grade({
  period: "Map 1", line: 16.5, proj: 11.2, edge: -5.3, cs: m1cs, of: m1cs.length,
  v1: { parts: [
    { key: "l10", label: "Last 10 Map 1 maps", w: 0.35, v: 10.8, n: 10 },
    { key: "szn", label: "Season (all Map 1 maps)", w: 0.20, v: 10.8, n: 10 },
    { key: "h2h", v: null, n: 0 }, { key: "tier", v: null, n: 0 },
    { key: "l3", w: 0.10, v: 13.7, n: 3 }
  ], adr_used: false, adr_mult: 1 }
}));
check("Map 1 headline still uses the pick", m1.headline.title === "Why we lean Under 16.5");
check("Map 1 copy says Map 1, not Maps 1-2", m1.support.concat(m1.also).some(function (x) { return /Map 1/.test(x.text); }));
check("scope note says Map 1 only and excludes later maps", m1.also.some(function (x) { return x.key === "scope" && /Map 1 only/.test(x.text) && /Map 2 and later are not in this projection/.test(x.text); }));
check("Map 1 map-pool averages count only n=1 logs", (function () {
  var logsM = [
    { n: 1, map: "Dust2", kills: 10, mid: 1 }, { n: 1, map: "Dust2", kills: 12, mid: 2 }, { n: 1, map: "Dust2", kills: 14, mid: 3 },
    { n: 2, map: "Dust2", kills: 99, mid: 1 }
  ];
  var x = I.build(grade({ period: "Map 1", line: 16.5, proj: 11.2, edge: -5.3, cs: m1cs,
    v1: { parts: [{ key: "l10", v: 10.8, n: 10 }, { key: "szn", v: 10.8, n: 10 }, { key: "h2h", v: null, n: 0 }, { key: "tier", v: null, n: 0 }, { key: "l3", v: 13.7, n: 3 }], adr_used: false, adr_mult: 1 }
  }), { strength: strength, logs: logsM, tn: function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); } });
  var it = x.also.filter(function (z) { return z.key === "maps"; })[0];
  // mean of 10,12,14 = 12.0, must not include 99
  return it && /12\.0 headshots|12\.0 kills/.test(it.text) && it.text.indexOf("99") < 0 && /\(3 Map 1 maps\)/.test(it.text);
})());

console.log("Bo3 note and flags");
var bo = I.build(grade(), { games: [{ team1: "Fnatic", team2: "Vitality", bo: 3, start: "2026-11-24T18:00:00Z" }], start: "2026-11-24T18:00:00Z" });
check("mentions Bo3 from games.json", bo.also.some(function (x) { return x.key === "scope" && /Bo3/.test(x.text); }));
var flagged = I.build(grade({ reasons: ["only 6 earlier Map 1+2 series (need 8)"] }));
check("filter flag is a not-used risk item", flagged.risk.some(function (x) { return x.key === "flag" && !x.used && /only 6/.test(x.text); }));

console.log("html");
var html = I.html(grade());
check("renders the four section labels that have content", html.indexOf("Key insights") > -1 && html.indexOf("Other numbers that point to Under") > -1 && html.indexOf("What could go wrong") > -1 && html.indexOf("Also good to know") > -1);
check("escapes player-derived text", I.html(grade({ opp: "A<B" })).indexOf("A<B") < 0 && I.html(grade({ opp: "A<B" })).indexOf("A&lt;B") > -1);
check("legend is present", html.indexOf("Used in the grade") > -1 && html.indexOf("Not used in the grade") > -1);
check("used and hollow dots are in the markup", html.indexOf("ins-dot used") > -1 && html.indexOf("ins-dot ref") > -1);
check("empty html when there is no grade", I.html(null) === "");

console.log("no invented numbers: last-10 mean matches the series");
var l10item = ins.support.concat(ins.risk).filter(function (x) { return x.key === "l10"; })[0];
// 28+30+22+18+19+21+20+17+16+15 = 206, /10 = 20.6
check("last 10 average is 20.6", !!l10item && /20\.6/.test(l10item.text));

console.log("Why Glocky thinks it's bait");
check("no bait section when the grade is not flagged", !ins.bait.length && I.html(grade()).indexOf("Why Glocky thinks it") < 0);

// Make the last 5 all meet or beat 21.0: 28,30,22,18,19 -> 18 and 19 are under 21, so use a lower line and override cs head
var baitCs = series([
  { kills: 28, ev: "online", date: "2026-11-20" },
  { kills: 30, ev: "online", date: "2026-11-19" },
  { kills: 22, ev: "online", date: "2026-11-18" },
  { kills: 25, ev: "lan", date: "2026-11-17" },
  { kills: 24, ev: "online", date: "2026-11-16" },
  { kills: 21, ev: "lan", date: "2026-11-15" },
  { kills: 20, ev: "online", date: "2026-11-14" },
  { kills: 17, ev: "lan" }, { kills: 16, ev: "online" }, { kills: 15, ev: "lan" },
  { kills: 14, ev: "online" }, { kills: 33, ev: "lan" }, { kills: 12, ev: "online" },
  { kills: 11, ev: "lan" }, { kills: 10, ev: "online" }, { kills: 9, ev: "online" },
  { kills: 8, ev: "lan" }, { kills: 7, ev: "online" }, { kills: 26, ev: "lan" }, { kills: 5, ev: "online" }
]);
var baitGrade = grade({
  bait: true, line: 21.5, proj: 20.1, edge: -1.4, cs: baitCs,
  v1: {
    parts: [
      { key: "l10", w: 0.35, v: 21.8, n: 10 },
      { key: "szn", w: 0.20, v: 22.4, n: 20 },
      { key: "h2h", w: 0.20, v: null, n: 0 },
      { key: "tier", w: 0.15, v: 18.0, n: 8 },
      { key: "l3", w: 0.10, v: 26.7, n: 3 }
    ],
    adr_used: false, adr_mult: 1
  }
});
var b1 = I.build(baitGrade, { start: "2026-11-22T18:00:00Z", logs: baitCs });
check("bait section is built when flagged", b1.bait && b1.bait.length >= 1);
var l5b = b1.bait.filter(function (x) { return x.key === "bait-l5"; })[0];
check("last 5 all green uses the five real values", !!l5b && /all green/.test(l5b.text) && /21\.5/.test(l5b.text) && /28\.0, 30\.0, 22\.0, 25\.0, 24\.0/.test(l5b.text));
check("last 5 all green is not used in the grade", !!l5b && l5b.used === false);
var tb = b1.bait.filter(function (x) { return x.key === "bait-tier"; })[0];
check("same-tier underperform is included with both averages", !!tb && /underperforms against similarly ranked/.test(tb.text) && /18\.0/.test(tb.text) && /22\.4/.test(tb.text) && /8 Maps 1-2 series/.test(tb.text));
check("same-tier bait bullet is used in the grade (the window is)", !!tb && tb.used === true);
// ev on newest logs in the 3 days before 2026-11-22: dates 11-20,19,18 are online
var evb = b1.bait.filter(function (x) { return x.key === "bait-ev"; })[0];
check("online underperform is included when that is the setting and the average is lower", !!evb && /underperforms on online/.test(evb.text) && /this match's setting/.test(evb.text) && /online/.test(evb.text) && /LAN/.test(evb.text));
check("LAN / online bait bullet is not used in the grade", !!evb && evb.used === false);
// online avgs from baitCs: 28,30,22,24,20,16,14,12,10,9,7,5  and lan: 25,21,17,15,33,11,8,6
// wait ev bullets use evRows on cs (baitCs) for ALL series, not just last days
// online mean vs lan mean must have online < lan for the bullet to show

check("html heading is present only when bait is flagged", I.html(baitGrade, { start: "2026-11-22T18:00:00Z", logs: baitCs }).indexOf("Why Glocky thinks it's bait") > -1);
check("no leftover bait bullet in also-good-to-know", b1.also.every(function (x) { return x.key !== "bait"; }));

var noTier = I.build(grade({
  bait: true, line: 14.0,
  cs: series([{ kills: 20 }, { kills: 19 }, { kills: 18 }, { kills: 17 }, { kills: 16 }, { kills: 10 }]),
  v1: { parts: [
    { key: "l10", w: 0.35, v: 16, n: 6 },
    { key: "szn", w: 0.20, v: 16, n: 6 },
    { key: "h2h", v: null, n: 0 },
    { key: "tier", v: 18.0, n: 8 },
    { key: "l3", v: 19, n: 3 }
  ], adr_used: false, adr_mult: 1 }
}));
check("skips same-tier bait bullet when he does not underperform vs that tier", noTier.bait.every(function (x) { return x.key !== "bait-tier"; }));

var noEv = I.build(grade({
  bait: true, line: 14.0,
  cs: series([{ kills: 20 }, { kills: 19 }, { kills: 18 }, { kills: 17 }, { kills: 16 }, { kills: 10 }]),
  v1: { parts: [
    { key: "l10", v: 16, n: 6 }, { key: "szn", v: 16, n: 6 },
    { key: "h2h", v: null, n: 0 }, { key: "tier", v: null, n: 0 }, { key: "l3", v: 19, n: 3 }
  ], adr_used: false, adr_mult: 1 }
}), { start: "2026-11-22" });
check("skips LAN/online bait bullet when the match setting is unknown", noEv.bait.every(function (x) { return x.key !== "bait-ev"; }));

var thinTier = I.build(grade({
  bait: true, line: 14.0,
  cs: series([{ kills: 20 }, { kills: 19 }, { kills: 18 }, { kills: 17 }, { kills: 16 }, { kills: 10 }]),
  v1: { parts: [
    { key: "l10", v: 16, n: 6 }, { key: "szn", v: 20, n: 20 },
    { key: "h2h", v: null, n: 0 }, { key: "tier", v: 10, n: 2 }, { key: "l3", v: 19, n: 3 }
  ], adr_used: false, adr_mult: 1 }
}));
check("skips same-tier bait bullet when the sample is under 3", thinTier.bait.every(function (x) { return x.key !== "bait-tier"; }));

var tinyGap = I.build(grade({
  bait: true, line: 1.0,
  cs: series([
    { kills: 10, ev: "online" }, { kills: 10, ev: "online" }, { kills: 10, ev: "online" },
    { kills: 10, ev: "online" }, { kills: 10, ev: "online" },
    { kills: 10.2, ev: "lan" }, { kills: 10.2, ev: "lan" }, { kills: 10.2, ev: "lan" },
    { kills: 10.2, ev: "lan" }, { kills: 10.2, ev: "lan" }
  ]),
  v1: { parts: [
    { key: "l10", v: 10, n: 10 }, { key: "szn", v: 10, n: 10 },
    { key: "h2h", v: null, n: 0 }, { key: "tier", v: null, n: 0 }, { key: "l3", v: 10, n: 3 }
  ], adr_used: false, adr_mult: 1 }
}), { start: "2026-11-22" });
check("skips LAN/online bait bullet when the gap is tiny", tinyGap.bait.every(function (x) { return x.key !== "bait-ev"; }));

check("inferMatchEv returns online from the newest day in the window", I.inferMatchEv(baitCs, "2026-11-22") === "online");
check("inferMatchEv is null with no start date", I.inferMatchEv(baitCs, "") == null);

if (failed) {
  console.log("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nall tests passed");
