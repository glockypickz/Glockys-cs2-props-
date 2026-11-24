// Detection mapping for the Games-tab LAN / ONLINE badge.
// Run: node tests/test_lan_badge.js
var fs = require("fs");
var path = require("path");
var L = require("../lan_badge.js");
var failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { failed++; console.log("  FAIL  " + name); }
}

var games = [
  { id: 1, team1: "HEROIC", team2: "Chinggis Warriors", start: "2026-11-24T08:45:00.000+00:00", tournament_id: 6269, ev: "lan" },
  { id: 2, team1: "Ninjas in Pyjamas", team2: "Lynn Vision", start: "2026-11-24T08:45:00.000+00:00", tournament_id: 6269, ev: "lan" },
  { id: 3, team1: "100 Thieves", team2: "Imperial", start: "2026-11-24T10:00:00.000+00:00", tournament_id: 6269, ev: "lan" },
  { id: 4, team1: "PARIVISION", team2: "FlyQuest", start: "2026-11-24T11:00:00.000+00:00", tournament_id: 6269 },
  { id: 5, team1: "MASONIC", team2: "ex-Sashi Academy", start: "2026-11-24T09:00:00.000+00:00", tournament_id: 6297, ev: "online" },
  { id: 6, team1: "Solo team", team2: "Other", start: "2026-11-24T12:00:00.000+00:00", tournament_id: 9999 },
  { id: 7, team1: "Mix A", team2: "Mix B", start: "2026-11-24T13:00:00.000+00:00" }
];

console.log("direct ev on the game");
check("lan ev is lan", L.setting(games[0], games) === "lan" && L.evOf(games[0]) === "lan");
check("online ev is online", L.setting(games[4], games) === "online");
check("empty / missing ev is unknown", L.evOf(games[3]) === null && L.evOf({}) === null && L.evOf(null) === null);
check("junk ev is unknown, not guessed", L.evOf({ ev: "LAN" }) === null && L.evOf({ ev: "offline" }) === null && L.evOf({ ev: "major" }) === null);
check("label is LAN / ONLINE / empty", L.label("lan") === "LAN" && L.label("online") === "ONLINE" && L.label(null) === "");

console.log("tournament_id fill, only when siblings agree");
check("PGL game with no ev inherits lan from the same tournament_id", L.setting(games[3], games) === "lan");
check("unknown tournament stays unknown", L.setting(games[5], games) === null);
check("no tournament_id and no ev stays unknown", L.setting(games[6], games) === null);
check("without the games list, a missing ev is not filled", L.setting(games[3]) === null && L.setting(games[3], []) === null);
var conflict = games.concat([{ id: 8, tournament_id: 6269, ev: "online", team1: "A", team2: "B", start: "2026-11-24T14:00:00Z" }]);
check("conflicting ev on the same tournament_id is unknown, not guessed", L.setting(games[3], conflict) === null);
check("a game that already has ev keeps it even if the tournament conflicts", L.setting(games[0], conflict) === "lan");

console.log("no 3-day / name guessing");
var onlyName = { team1: "HEROIC", team2: "Chinggis Warriors", start: "2026-11-24T08:45:00Z", tournament: "PGL Major Singapore 2026 Stage 1" };
check("a Major with no ev and no tournament_id is not guessed as LAN", L.setting(onlyName, games) === null);
check("badge is empty when unknown", L.badge(games[5], games) === "" && L.badge(onlyName, games) === "");

console.log("badge html");
var lanHtml = L.badge(games[0], games);
var onHtml = L.badge(games[4], games);
check("LAN badge text and class", lanHtml.indexOf(">LAN</span>") > -1 && /class="pill ev lan"/.test(lanHtml));
check("ONLINE badge text and class", onHtml.indexOf(">ONLINE</span>") > -1 && /class="pill ev online"/.test(onHtml));
check("title says LAN or online", /This match is on LAN/.test(lanHtml) && /This match is online/.test(onHtml));

console.log("line matching");
function tn(s) {
  var SKIP = { team: 1, esports: 1, esport: 1, gaming: 1, club: 1 };
  return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w && !SKIP[w]; }).join("");
}
var opts = { tn: tn };
var line = { team: "100 Thieves", opponent: "Imperial Esports", starts_at: "2026-11-24T10:00:00Z" };
var found = L.findGame(line, games, opts);
check("line matches the game after dropping Esports", found && found.id === 3);
check("line badge is LAN", /pill ev lan/.test(L.badgeForLine(line, games, opts)) && L.badgeForLine(line, games, opts).indexOf("LAN") > -1);
check("swapped sides still match", L.findGame({ team: "Imperial Esports", opponent: "100 Thieves", starts_at: "2026-11-24T10:00:00Z" }, games, opts).id === 3);
check("wrong day does not match", L.findGame({ team: "100 Thieves", opponent: "Imperial", starts_at: "2026-11-25T10:00:00Z" }, games, opts) === null);
var pglUnknown = { team: "PARIVISION", opponent: "FlyQuest", starts_at: "2026-11-24T11:00:00Z" };
check("line for a game with no ev still gets LAN from the tournament", /pill ev lan/.test(L.badgeForLine(pglUnknown, games, opts)));
check("unmatched line has no badge", L.badgeForLine({ team: "Nobody", opponent: "Else", starts_at: "2026-11-24T10:00:00Z" }, games, opts) === "");

console.log("styles and wiring");
var css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
var css1 = css.replace(/\s+/g, "");
check("LAN pill is blue", /\.pill\.lan\{[^}]*background:#3b82f6/.test(css1));
check("ONLINE pill is a distinct color", /\.pill\.online\{/.test(css) && !/\.pill\.online\{[^}]*background:#3b82f6/.test(css1));
check("ev pills stay on one line on a phone", /\.pill\.ev\{[^}]*white-space:nowrap/.test(css1));
var app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
check("Games cards call evBadge", /function evBadge\(/.test(app) && /evBadge\(g\)/.test(app));
check("gameCard, liveCard, and startedCard all show the badge", (app.match(/evBadge\(/g) || []).length >= 4);
check("Lines rows show the badge when a game matches", /evBadgeLine\(/.test(app));
var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
check("lan_badge.js is loaded before app.js", html.indexOf("lan_badge.js") > -1 && html.indexOf("lan_badge.js") < html.indexOf("app.js"));

if (failed) { console.log("\n" + failed + " failed"); process.exit(1); }
console.log("\nall passed");
