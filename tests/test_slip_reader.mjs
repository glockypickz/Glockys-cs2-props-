// Slip reader: parsing, fuzzy matching, and grading use our data / shared grader, not a model.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as L from "../ask_lookup.js";
import * as S from "../slip_reader.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
globalThis.GPModel = require(join(root, "model.js"));

const playersRaw = JSON.parse(readFileSync(join(root, "players.json"), "utf8"));
const strength = JSON.parse(readFileSync(join(root, "team_strength.json"), "utf8"));
const games = JSON.parse(readFileSync(join(root, "games.json"), "utf8"));

function storeWithLines(extraLines) {
  return L.makeStore({
    players: playersRaw,
    strength,
    games,
    lines: { lines: extraLines || [] }
  });
}

test("parses period, stat, side, and book labels", () => {
  assert.equal(S.periodOf("MAPS 1-2"), "Maps 1-2");
  assert.equal(S.periodOf("Map 1"), "Map 1");
  assert.equal(S.periodOf("maps 1 and 2"), "Maps 1-2");
  assert.equal(S.parseStat("Headshots"), "hs");
  assert.equal(S.parseStat("kills"), "kills");
  assert.equal(S.parseStat("points"), null);
  assert.equal(S.parseSide("UNDER"), "under");
  assert.equal(S.parseSide("Over"), "over");
  assert.equal(S.parseBook("prize picks"), "PrizePicks");
  assert.equal(S.parseBook("Underdog Fantasy"), "Underdog");
});

test("parseExtracted keeps only visible fields and flags non-prop legs", () => {
  const got = S.parseExtracted({
    readable: true,
    cs2: true,
    book: "PrizePicks",
    entry: 25,
    payout: 90,
    picks: [
      { player: "EliGE", stat: "kills", line: 35.5, period: "Maps 1-2", side: "over" },
      { player: "Someone", stat: "points", line: 24.5, side: "under" },
      { player: "", stat: "kills", line: 10 }
    ]
  });
  assert.equal(got.book, "PrizePicks");
  assert.equal(got.entry, 25);
  assert.equal(got.picks[0].stat, "kills");
  assert.equal(got.picks[0].side, "over");
  assert.equal(got.picks[1].error, "not a CS2 kills or headshots prop");
  assert.equal(got.picks[2].error, "missing player");
});

test("fuzzyFindPlayer matches typoed names and misses unknown ones", () => {
  const store = storeWithLines([]);
  const exact = S.fuzzyFindPlayer(store, "EliGE", "");
  assert.equal(exact.player && exact.player.name, "EliGE");
  assert.equal(exact.match, "exact");

  const typo = S.fuzzyFindPlayer(store, "EL1GE", "");
  assert.equal(typo.player && typo.player.name, "EliGE");
  assert.equal(typo.match, "fuzzy");

  const miss = S.fuzzyFindPlayer(store, "ZzNotARealPlayer", "");
  assert.equal(miss.player, null);
});

test("matchPick fills board line and opponent when the prop is on the board", () => {
  const store = storeWithLines([
    { player: "EliGE", team: "Liquid", stat: "kills", line: 35.5, period: "Maps 1-2", opponent: "FaZe", book: "PrizePicks", odds: -137 }
  ]);
  const m = S.matchPick(store, S.normalizePick({ player: "EliGE", stat: "kills", period: "Maps 1-2", side: "over" }, {}));
  assert.equal(m.player, "EliGE");
  assert.equal(m.line, 35.5);
  assert.equal(m.opponent, "FaZe");
  assert.equal(m.book, "PrizePicks");
  assert.equal(m.error, null);
});

test("gradePicks uses gradeIntent (current letters) and agrees or disagrees with the slip side", () => {
  const store = storeWithLines([
    { player: "EliGE", team: "Liquid", stat: "kills", line: 35.5, period: "Maps 1-2", opponent: "FaZe", book: "PrizePicks" }
  ]);
  const p = L.findPlayer(store, "EliGE", "");
  assert.ok(p);
  const baseline = L.gradeIntent({ player: p, stat: "kills", line: 35.5, period: "Maps 1-2", opp: "FaZe" }, store);
  assert.equal(baseline.missing, false);
  assert.equal(baseline.model, globalThis.GPModel.VERSION);

  const withUs = S.gradePicks(store, [{
    player: "EliGE", stat: "kills", line: 35.5, period: "Maps 1-2", side: baseline.pick.toLowerCase(), opponent: "FaZe", book: "PrizePicks"
  }])[0];
  assert.equal(withUs.error, null);
  assert.equal(withUs.grade.grade, baseline.grade);
  assert.equal(withUs.grade.pick, baseline.pick);
  assert.equal(withUs.grade.proj, baseline.proj);
  assert.equal(withUs.verdict, "agree");

  const against = S.gradePicks(store, [{
    player: "EliGE", stat: "kills", line: 35.5, period: "Maps 1-2",
    side: baseline.pick === "OVER" ? "under" : "over",
    opponent: "FaZe", book: "PrizePicks"
  }])[0];
  assert.equal(against.verdict, "disagree");
  assert.equal(against.like, false);
});

test("unmatched and non-CS2 picks stay skipped in the summary", () => {
  const store = storeWithLines([]);
  const results = S.gradePicks(store, [
    { player: "ZzNobody", stat: "kills", line: 20.5, side: "over", period: "Maps 1-2" },
    { player: "EliGE", stat: "points", line: 24.5, side: "over" }
  ]);
  assert.ok(results[0].error);
  assert.ok(results[1].error);
  const sum = S.summarizeSlip(results, { book: "Underdog" });
  assert.equal(sum.total, 2);
  assert.equal(sum.graded, 0);
  assert.equal(sum.skipped, 2);
  assert.ok(sum.weakest);
  assert.equal(sum.book, "Underdog");
});

test("parseGeminiJson accepts fenced JSON and rejects junk", () => {
  const ok = S.parseGeminiJson("```json\n{\"readable\":true,\"cs2\":true,\"picks\":[]}\n```");
  assert.equal(ok.readable, true);
  assert.equal(S.parseGeminiJson("not json"), null);
});
