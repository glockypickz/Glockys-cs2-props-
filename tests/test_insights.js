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
check("title uses pick and line", ins.headline.title === "Why Glocky chooses Under 24.5");
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
check("Map 1 headline still uses the pick", m1.headline.title === "Why Glocky chooses Under 16.5");
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

console.log("projected maps (scout-style, display only)");
function rowsFor(team, map, n, dates) {
  return dates.map(function (d) { return { team: team, map: map, n: n, date: d }; });
}
// 60 days before 2026-11-22 is 2026-09-23. Enough of each map to pass the 3% pool cutoff.
var days = [];
for (var i = 0; i < 30; i++) days.push("2026-10-" + String((i % 28) + 1).padStart(2, "0"));
var teamRows = [];
days.forEach(function (d, i) {
  // Fnatic plays Dust2 often, then Mirage, then Nuke, plus a little Inferno
  teamRows.push({ team: "Fnatic", map: "Dust2", n: 1, date: d });
  teamRows.push({ team: "Fnatic", map: "Dust2", n: 2, date: d });
  if (i % 2 === 0) { teamRows.push({ team: "Fnatic", map: "Mirage", n: 1, date: d }); teamRows.push({ team: "Fnatic", map: "Mirage", n: 2, date: d }); }
  if (i % 3 === 0) { teamRows.push({ team: "Fnatic", map: "Nuke", n: 1, date: d }); teamRows.push({ team: "Fnatic", map: "Nuke", n: 2, date: d }); }
  if (i % 5 === 0) { teamRows.push({ team: "Fnatic", map: "Inferno", n: 1, date: d }); teamRows.push({ team: "Fnatic", map: "Inferno", n: 2, date: d }); }
  // Vitality: Mirage-heavy
  teamRows.push({ team: "Vitality", map: "Mirage", n: 1, date: d });
  teamRows.push({ team: "Vitality", map: "Mirage", n: 2, date: d });
  if (i % 2 === 0) { teamRows.push({ team: "Vitality", map: "Dust2", n: 1, date: d }); teamRows.push({ team: "Vitality", map: "Dust2", n: 2, date: d }); }
  if (i % 3 === 0) { teamRows.push({ team: "Vitality", map: "Inferno", n: 1, date: d }); }
});
var top3 = I.projectedTop(teamRows, "Fnatic", "Vitality", "2026-11-22", 3, function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); });
check("returns 3 maps for a Bo3", top3.length === 3);
check("probabilities are rescaled", Math.abs(top3.reduce(function (s, x) { return s + x.p; }, 0) - 1) < 1e-9);
check("Dust2 and Mirage are in the top 3", top3.some(function (x) { return x.map === "Dust2"; }) && top3.some(function (x) { return x.map === "Mirage"; }));
var top5 = I.projectedTop(teamRows, "Fnatic", "Vitality", "2026-11-22", 5, function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); });
check("returns up to 5 maps for a Bo5", top5.length >= 3 && top5.length <= 5);
check("Map 3+ rows are not counted in team shares (only Maps 1-2)", (function () {
  var extra = teamRows.concat(days.map(function (d) { return { team: "Fnatic", map: "Overpass", n: 3, date: d }; }));
  var a = I.projectedTop(teamRows, "Fnatic", "Vitality", "2026-11-22", 5, function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); });
  var b = I.projectedTop(extra, "Fnatic", "Vitality", "2026-11-22", 5, function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); });
  // Overpass can enter the 60-day pool (all maps) but shares stay 0 aside from smoothing, so it should not outrank Dust2/Mirage
  return !b.slice(0, 2).some(function (x) { return x.map === "Overpass"; }) && a[0].map === b[0].map;
})());

// Player logs: Dust2 high (over a 24.5 Maps 1-2 line after *2), Nuke low (under)
var plogs = [];
for (var pi = 0; pi < 6; pi++) {
  plogs.push({ n: 1, map: "Dust2", kills: 18 + pi, date: "2026-10-0" + (pi + 1) }); // 18..23
  plogs.push({ n: 2, map: "Dust2", kills: 16 + pi, date: "2026-10-0" + (pi + 1) }); // 16..21  mean 19.5 * 2 = 39.0
  plogs.push({ n: 1, map: "Mirage", kills: 12, date: "2026-10-1" + (pi + 1 > 9 ? (pi + 1) : "0" + (pi + 1 > 9 ? "" : "")) });
}
// fix mirage dates simply
plogs = plogs.filter(function (l) { return l.map !== "Mirage"; });
for (var pj = 0; pj < 6; pj++) {
  plogs.push({ n: 1, map: "Mirage", kills: 12, date: "2026-10-" + String(10 + pj).padStart(2, "0") });
  plogs.push({ n: 2, map: "Mirage", kills: 11, date: "2026-10-" + String(10 + pj).padStart(2, "0") }); // mean 11.5 * 2 = 23.0 vs 24.5 under
}
for (var pk = 0; pk < 6; pk++) {
  plogs.push({ n: 1, map: "Nuke", kills: 8, date: "2026-10-" + String(10 + pk).padStart(2, "0") });
  plogs.push({ n: 2, map: "Nuke", kills: 7, date: "2026-10-" + String(10 + pk).padStart(2, "0") }); // mean 7.5 * 2 = 15.0 under
}
// two Ancient maps only — must be skipped (<3 samples) even if projected
plogs.push({ n: 1, map: "Inferno", kills: 30, date: "2026-10-15" });
plogs.push({ n: 2, map: "Inferno", kills: 30, date: "2026-10-15" });

var tnF = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); };
var pg = I.build(grade({ line: 24.5, pick: "UNDER", proj: 20.1, edge: -4.4 }), {
  teamRows: teamRows, logs: plogs, start: "2026-11-22", tn: tnF,
  games: [{ team1: "Fnatic", team2: "Vitality", bo: 3, start: "2026-11-22T18:00:00Z" }]
});
var poolItem = pg.support.concat(pg.risk).filter(function (x) { return x.key === "proj-pool"; })[0];
check("map-pool summary exists", !!poolItem);
check("pool summary is not used in the grade", !!poolItem && poolItem.used === false);
var dust = pg.support.concat(pg.risk, pg.also).filter(function (x) { return x.key === "proj-map-Dust2"; })[0];
var mir = pg.support.concat(pg.risk, pg.also).filter(function (x) { return x.key === "proj-map-Mirage"; })[0];
check("Dust2 average is 39.0 on a Maps 1-2 scale (19.5 * 2)", !!dust && /39\.0/.test(dust.text) && /Dust2 \(\d+%\)/.test(dust.text));
check("Dust2 is a weak map for an Under (goes in What could go wrong)", !!dust && pg.risk.indexOf(dust) > -1 && /above the line/.test(dust.text) && dust.used === false);
check("Mirage 23.0 is a supportive Under map", !!mir && /23\.0/.test(mir.text) && pg.support.indexOf(mir) > -1 && /below the line/.test(mir.text));
check("skips Inferno with only 2 maps", pg.support.concat(pg.risk, pg.also).every(function (x) { return x.key !== "proj-map-Inferno"; }));
check("hit rate and sample size are on the bullet", !!dust && /went Over in |went Under in /.test(dust.text) && /\(12 maps\)/.test(dust.text));
check("does not also emit the Cito fallback when our projection has samples", pg.also.every(function (x) { return x.key !== "maps"; }));

// Map 1: scale is 1, only n=1 logs (mean Dust2 18..23 = 20.5, not 39)
var m1p = I.build(grade({
  period: "Map 1", line: 16.5, proj: 11.2, edge: -5.3, pick: "UNDER",
  cs: series([{ kills: 14, ev: "online", maps: "Mirage" }, { kills: 16, ev: "lan", maps: "Dust2" }, { kills: 11, ev: "online", maps: "Nuke" }, { kills: 10, ev: "online", maps: "Inferno" }, { kills: 9, ev: "lan", maps: "Ancient" }, { kills: 8, ev: "online", maps: "Mirage" }, { kills: 15, ev: "online", maps: "Dust2" }, { kills: 7, ev: "lan", maps: "Nuke" }, { kills: 6, ev: "online", maps: "Inferno" }, { kills: 12, ev: "online", maps: "Ancient" }]),
  v1: { parts: [
    { key: "l10", v: 10.8, n: 10 }, { key: "szn", v: 10.8, n: 10 },
    { key: "h2h", v: null, n: 0 }, { key: "tier", v: null, n: 0 }, { key: "l3", v: 13.7, n: 3 }
  ], adr_used: false, adr_mult: 1 }
}), { teamRows: teamRows, logs: plogs, start: "2026-11-22", tn: tnF, games: [{ team1: "Fnatic", team2: "Vitality", bo: 3, start: "2026-11-22T18:00:00Z" }] });
var d1 = m1p.support.concat(m1p.risk, m1p.also).filter(function (x) { return x.key === "proj-map-Dust2"; })[0];
check("Map 1 uses n=1 only and does not double the average", !!d1 && /20\.5/.test(d1.text) && d1.text.indexOf("39.0") < 0 && /Map 1 maps/.test(d1.text));

check("Cito fallback still works when teamRows are missing", (function () {
  var x = I.build(grade(), { strength: { maps: {
    fnatic: [{ asof: "2026-11-17", maps: { Dust2: [7, 141, 43.8], Mirage: [2, 37, 12.5] } }],
    vitality: [{ asof: "2026-11-17", maps: { Dust2: [3, 60, 20], Mirage: [8, 160, 50] } }]
  } }, logs: plogs, tn: tnF });
  return x.also.some(function (it) { return it.key === "maps" && /map-pool pick rates/.test(it.text); });
})());

if (failed) {
  console.log("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nall tests passed");
