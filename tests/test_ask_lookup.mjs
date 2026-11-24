// Ask Glocky lookup tests: numbers come from our data / v1e grader, not from a model.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
globalThis.GPModel = require(join(root, "model.js"));
const L = await import("../ask_lookup.js");
const { fallbackPhrase, systemPrompt, scrubProviders } = await import("../ask_ai.js");

const playersRaw = JSON.parse(readFileSync(join(root, "players.json"), "utf8"));
const strength = JSON.parse(readFileSync(join(root, "team_strength.json"), "utf8"));
const games = JSON.parse(readFileSync(join(root, "games.json"), "utf8"));
const lines = JSON.parse(readFileSync(join(root, "lines.json"), "utf8"));
const store = L.makeStore({ players: playersRaw, strength, games, lines });

function eligeLanHsFromFile() {
  const p = (playersRaw.players || []).find((x) => x.name === "EliGE");
  assert.ok(p, "EliGE is in players.json");
  const S = playersRaw.s, cols = playersRaw.cols;
  const evI = cols.indexOf("ev"), kI = cols.indexOf("kills"), hsI = cols.indexOf("hs");
  let kills = 0, hs = 0, maps = 0;
  for (const r of p.rows) {
    const ev = r[evI] != null ? S[r[evI]] : null;
    if (ev !== "lan") continue;
    if (r[hsI] == null || r[kI] == null) continue;
    kills += r[kI];
    hs += r[hsI];
    maps++;
  }
  return { maps, kills, hs, hsp: +(100 * hs / kills).toFixed(2) };
}

test("EliGE LAN headshot % matches players.json", () => {
  const expected = eligeLanHsFromFile();
  const p = L.findPlayer(store, "EliGE", "Liquid") || L.findPlayer(store, "EliGE", "");
  assert.ok(p, "finds EliGE");
  assert.equal(p.team, "Liquid");
  const intent = { ev: "lan", player: p };
  const logs = L._test.filterLogs(p, intent, store.seasonStart);
  const got = L._test.hsPct(logs);
  assert.equal(got.maps, expected.maps);
  assert.equal(got.kills, expected.kills);
  assert.equal(got.hs, expected.hs);
  assert.equal(got.hsp, expected.hsp);
  const ans = L.answerQuestion("what's EliGE's headshot percentage on LAN", store);
  assert.equal(ans.missing, false);
  assert.equal(ans.facts.hs.hsp, expected.hsp);
  assert.equal(ans.facts.hs.kills, expected.kills);
  assert.match(ans.factText, new RegExp(String(expected.hsp)));
  assert.equal(ans.intent.player, "EliGE");
  assert.equal(ans.intent.ev, "lan");
});

test("parses EliGE HS% on LAN and a kills over/under question", () => {
  const a = L.parseQuestion("what's EliGE's headshot percentage on LAN", store);
  assert.equal(a.player && a.player.name, "EliGE");
  assert.equal(a.stat, "hsp");
  assert.equal(a.ev, "lan");
  assert.equal(a.intent, "player_stat");

  const b = L.parseQuestion("EliGE over 35.5 kills maps 1-2?", store);
  assert.equal(b.player && b.player.name, "EliGE");
  assert.equal(b.stat, "kills");
  assert.equal(b.line, 35.5);
  assert.equal(b.period, "Maps 1-2");
  assert.equal(b.intent, "grade");

  const c = L.parseQuestion("EliGE over 18.5 headshots map 1 vs FaZe", store);
  assert.equal(c.period, "Map 1");
  assert.equal(c.stat, "hs");
  assert.equal(c.line, 18.5);
  assert.equal(c.intent, "grade");
});

test("over/under grade matches GPModel.grade (v1e) for EliGE 35.5 kills Maps 1-2", () => {
  const p = L.findPlayer(store, "EliGE", "");
  const direct = globalThis.GPModel.grade(store.ctx, p, "kills", 35.5, "", { team: p.team, period: "Maps 1-2" });
  assert.ok(direct);
  const ans = L.answerQuestion("EliGE over 35.5 kills maps 1-2?", store);
  assert.equal(ans.missing, false);
  assert.ok(ans.grade);
  assert.equal(ans.grade.player, "EliGE");
  assert.equal(ans.grade.stat, "kills");
  assert.equal(ans.grade.line, 35.5);
  assert.equal(ans.grade.period, "Maps 1-2");
  assert.equal(ans.grade.pick, direct.pick);
  assert.equal(ans.grade.grade, direct.grade);
  assert.equal(ans.grade.proj, +direct.proj.toFixed(1));
  assert.equal(ans.grade.bait, !!direct.bait);
  assert.equal(ans.grade.model, "v1e");
  assert.match(ans.factText, /v1e/);
  assert.match(ans.factText, new RegExp("Letter grade: " + direct.grade));
  assert.match(ans.factText, new RegExp("Pick: " + direct.pick));
});

test("bait flag matches GPModel.isBait", () => {
  const p = L.findPlayer(store, "EliGE", "");
  const line = 20.5;
  const bait = globalThis.GPModel.isBait(store.ctx, p, "kills", line, "9999", "Maps 1-2");
  const g = L.gradeIntent({ player: p, stat: "kills", line, period: "Maps 1-2" }, store);
  assert.equal(g.bait, !!bait);
});

test("Map 1 period is graded on Map 1, not Maps 1-2", () => {
  const p = L.findPlayer(store, "EliGE", "");
  const m1 = globalThis.GPModel.grade(store.ctx, p, "kills", 18.5, "", { team: p.team, period: "Map 1" });
  const m12 = globalThis.GPModel.grade(store.ctx, p, "kills", 18.5, "", { team: p.team, period: "Maps 1-2" });
  assert.ok(m1 && m12);
  const ans = L.answerQuestion("EliGE over 18.5 kills map 1", store);
  assert.equal(ans.grade.period, "Map 1");
  assert.equal(ans.grade.proj, +m1.proj.toFixed(1));
  assert.notEqual(ans.grade.proj, +m12.proj.toFixed(1));
});

test("uses the board line when the prop is on the board; otherwise the line the user gave", () => {
  const p = L.findPlayer(store, "EliGE", "");
  const boardStore = L.makeStore({
    players: playersRaw,
    strength,
    games,
    lines: { lines: [{
      player: "EliGE", team: "Liquid", opponent: "FaZe", stat: "Kills",
      period: "Maps 1-2", line: 32.5, odds: -137, starts_at: "2026-11-25T18:00:00Z", book: "PrizePicks"
    }] }
  });
  const onBoard = L.answerQuestion("EliGE over or under on kills maps 1-2?", boardStore);
  assert.equal(onBoard.grade.line, 32.5);
  assert.equal(onBoard.grade.source, "board");
  assert.equal(onBoard.grade.book, "PrizePicks");
  assert.equal(onBoard.grade.opp, "FaZe");
  const asked = L.answerQuestion("EliGE over 35.5 kills maps 1-2?", boardStore);
  assert.equal(asked.grade.line, 35.5);
  assert.equal(asked.grade.source, "asked");
  const none = L.answerQuestion("EliGE over 35.5 kills maps 1-2?", store);
  // live board may or may not have EliGE; if it doesn't, source is asked
  if (!store.lines.some((l) => /elige/i.test(l.player || "") && /kill/i.test(l.stat || ""))) {
    assert.equal(none.grade.source, "asked");
    assert.equal(none.grade.line, 35.5);
  }
  assert.equal(p.name, "EliGE");
});

test("LAN ev is passed into the grader when the match is a LAN game", () => {
  const p = L.findPlayer(store, "EliGE", "");
  const lanGames = { games: [{ team1: "Liquid", team2: "FaZe", start: "2026-11-25T18:00:00Z", ev: "lan", status: "upcoming" }] };
  const s = L.makeStore({ players: playersRaw, strength, games: lanGames, lines: { lines: [] } });
  const withLan = globalThis.GPModel.grade(s.ctx, p, "kills", 35.5, "FaZe", { team: p.team, period: "Maps 1-2", ev: "lan", start: "2026-11-25T18:00:00Z" });
  const g = L.gradeIntent({ player: p, stat: "kills", line: 35.5, period: "Maps 1-2", opp: "FaZe", start: "2026-11-25T18:00:00Z" }, s);
  assert.equal(g.proj, +withLan.proj.toFixed(1));
  assert.equal(g.grade, withLan.grade);
  assert.equal(g.pick, withLan.pick);
  if (withLan.v1 && withLan.v1.lan && withLan.v1.lan.used) assert.ok(g.lan);
});

test("Liquid VRS / world rank matches team_strength.json", () => {
  const vrs = L.teamRank(store, "Liquid", "vrs");
  const world = L.teamRank(store, "Liquid", "world");
  assert.ok(vrs && world);
  const lastV = strength.rankings.vrs[strength.rankings.vrs.length - 1];
  const items = Object.entries(lastV.points).sort((a, b) => b[1] - a[1]);
  const i = items.findIndex(([t]) => globalThis.GPModel.tn(t) === globalThis.GPModel.tn("Liquid"));
  assert.ok(i >= 0);
  assert.equal(vrs.rank, i + 1);
  assert.equal(vrs.points, items[i][1]);
  const ans = L.answerQuestion("what is Liquid's VRS rank", store);
  assert.equal(ans.missing, false);
  assert.match(ans.factText, /VRS rank/);
  assert.match(ans.factText, new RegExp("#" + vrs.rank));
});

test("missing questions say we don't have that in our data", () => {
  const ans = L.answerQuestion("what's FakePlayer123's headshot percentage on LAN", store);
  assert.equal(ans.missing, true);
  assert.match(ans.factText, /don't have that in our data|no matching|no player/i);
});

test("lookup never reads or mentions the Track Record / lines_history", () => {
  const ans = L.answerQuestion("EliGE over 35.5 kills maps 1-2?", store);
  const blob = JSON.stringify(ans);
  assert.equal(blob.includes("lines_history"), false);
  assert.doesNotMatch(ans.factText, /track record/i);
  assert.doesNotMatch(ans.factText, /locked pick/i);
});

const PROVIDER = /\b(cito|bo3(?:\.gg)?|kash\s*rock|hltv(?:\.org)?|gemini|google(?:\s+ai)?)\b/i;

test("replies, fact text, source labels, and Ask Glocky UI never name data providers", () => {
  const questions = [
    "what's EliGE's headshot percentage on LAN",
    "EliGE over 35.5 kills maps 1-2?",
    "what is Liquid's VRS rank",
    "what are Liquid's map pick tendencies",
    "what's Liquid's win chance",
    "how does the grader work"
  ];
  for (const q of questions) {
    const ans = L.answerQuestion(q, store);
    assert.doesNotMatch(ans.factText, PROVIDER, "factText: " + q);
    assert.doesNotMatch(fallbackPhrase(ans), PROVIDER, "fallback: " + q);
  }
  const app = readFileSync(join(root, "app.js"), "utf8");
  const welcome = app.match(/addMsg\('a',"((?:\\.|[^"\\])*)"/);
  assert.ok(welcome, "welcome message in app.js");
  const welcomeText = welcome[1].replace(/\\'/g, "'");
  assert.doesNotMatch(welcomeText, PROVIDER);
  assert.match(welcomeText, /Glocky's data|our data/);
  const prompt = systemPrompt();
  assert.doesNotMatch(prompt, PROVIDER);
  assert.match(prompt, /our data or Glocky's data/);
  assert.doesNotMatch(scrubProviders("Cito win chance 60% vs FaZe according to bo3.gg and KashRock. Gemini and Google AI Studio agree."), PROVIDER);
  assert.match(scrubProviders("Cito win chance 60%"), /our data|win chance/);
});

test("makeStore keeps compact fmt-2 rows instead of decoding every player", () => {
  const s = L.makeStore({ players: playersRaw, strength, games, lines });
  assert.ok(s._compact && s._compact.fmt === 2);
  assert.equal(s._ctx, undefined);
  const decoded = s.players.filter((p) => p.logs);
  assert.equal(decoded.length, 0);
  assert.ok(s.players.some((p) => p.name === "FL1T x LUKOIL"));
});

test("fl1ts / FL1T x LUKOIL resolves, and LAN kills-per-map uses our data", () => {
  const s = L.makeStore({ players: playersRaw, strength, games, lines });
  const p = L.findPlayer(s, "fl1ts", "") || L.findPlayer(s, "FL1T", "");
  assert.ok(p, "FL1T is in players.json");
  assert.equal(p.name, "FL1T x LUKOIL");
  const q = "What's fl1ts avg kills per map on LAN";
  const intent = L.parseQuestion(q, s);
  assert.ok(intent.player, "question finds FL1T");
  assert.equal(intent.player.name, "FL1T x LUKOIL");
  assert.equal(intent.stat, "kpm");
  assert.equal(intent.ev, "lan");
  const ans = L.answerQuestion(q, s, intent);
  assert.equal(ans.missing, false);
  assert.equal(ans.facts.player, "FL1T x LUKOIL");
  assert.ok(ans.facts.kills && ans.facts.kills.avg != null);
  assert.match(ans.factText, /Average kills per map: /);
  assert.match(ans.factText, /FL1T x LUKOIL/);
  // a simple stat question must not decode the whole roster or build Elo
  const decoded = s.players.filter((p) => p.logs);
  assert.equal(decoded.length, 0);
  assert.equal(s._ctx, undefined);
});

test("Ask Glocky answers a map prediction for a scheduled matchup", () => {
  const slate = games.games || [];
  const g = slate.find((x) => x.team1 && x.team2);
  assert.ok(g, "games.json has a match");
  const q = "what maps will " + g.team1 + " vs " + g.team2 + " play";
  const intent = L.parseQuestion(q, store);
  assert.equal(intent.intent, "map_pred");
  assert.ok(intent.team);
  assert.ok(intent.opp);
  const ans = L.answerQuestion(q, store, intent);
  assert.equal(ans.missing, false);
  assert.equal(ans.facts.kind, "map_pred");
  assert.doesNotMatch(ans.factText, /cito/i);
  if (ans.facts.confirmed && ans.facts.confirmed.length) {
    assert.match(ans.factText, /confirmed/i);
  } else {
    assert.match(ans.factText, /Glocky's map prediction/);
    assert.match(ans.factText, /Map 1:/);
    assert.match(ans.factText, /prediction from Glocky's veto math/);
    assert.ok(ans.facts.pred && (ans.facts.pred.pred[1] || ans.facts.pred.pred["1"]));
  }
  const fb = fallbackPhrase(ans);
  assert.doesNotMatch(fb, /cito/i);
});
