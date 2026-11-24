// Ask Glocky must grade a board line exactly like the site does (same letter, pick and projection).
// The Worker loads players in a compact form to stay under the 128 MB cap. If that path ever drops
// something the site's GPModel.build creates (map/veto tables, match type) or stops passing the
// date cutoff and confirmed maps, the chat answer and the card under it disagree. This test fails then.
// Run: node --test tests/test_ask_parity.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const GM = require(join(root, "model.js"));
globalThis.GPModel = GM;
const L = await import("../ask_lookup.js");

const rd = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));
const raw = { players: rd("players.json"), strength: rd("team_strength.json"), games: rd("games.json"), lines: rd("lines.json") };
const store = L.makeStore(raw);
// The site's own context and options (app.js: mctx(), grade(), knownMaps()).
const dec = GM.decodePlayers(raw.players);
const ctxSite = GM.build(dec.players, null, raw.strength, dec.ranks || {});
const GAMES = raw.games.games || raw.games;

function siteGrade(l, st) {
  const p = dec.players.find((x) => GM.tn(x.team) === GM.tn(l.team) && GM.norm(x.name) === GM.norm(l.player));
  if (!p) return null;
  const ev = GM.matchEv(ctxSite, p.team, l.opponent, l.starts_at, GAMES);
  const maps = GM.confirmedMaps(ctxSite, p.team, l.opponent, l.starts_at) || [];
  return GM.grade(ctxSite, p, st, +l.line, l.opponent, {
    team: p.team, book: l.book, odds: l.odds, before: String(l.starts_at).slice(0, 10),
    period: l.period, ev: ev[0], maps
  });
}

test("the Worker's compact context has the same map and match-type tables as the site", () => {
  const w = store.ctx;
  assert.ok(w.gmaps && w.gmaps.length > 0, "gmaps is built");
  assert.equal(w.gmaps.length, ctxSite.gmaps.length);
  assert.equal(w.gdates.length, ctxSite.gdates.length);
  assert.deepEqual(Object.keys(w.teamMaps).sort(), Object.keys(ctxSite.teamMaps).sort());
  for (const t of Object.keys(ctxSite.teamMaps).slice(0, 40)) assert.deepEqual(w.teamMaps[t], ctxSite.teamMaps[t], t);
  assert.ok(w.teamEv, "teamEv is built");
});

test("every PrizePicks kills/headshots line on the board grades the same in Ask Glocky and on the site", () => {
  const rows = (raw.lines.lines || []).filter((l) => l.book === "PrizePicks" && /kill|head/i.test(l.stat));
  const bad = [];
  let n = 0;
  for (const l of rows) {
    const st = /head/i.test(l.stat) ? "hs" : "kills";
    const q = l.player + " over " + l.line + " " + (st === "hs" ? "headshots" : "kills") + " " + (l.period === "Map 1" ? "map 1" : "maps 1-2") + "?";
    const a = L.answerQuestion(q, store);
    if (!a || !a.grade || a.grade.source !== "board") continue;
    const s = siteGrade(l, st);
    if (!s) continue;
    n++;
    const w = a.grade;
    if (w.grade !== s.grade || w.pick !== s.pick || Math.abs(+w.proj - +(+s.proj).toFixed(1)) > 0.051) {
      bad.push(q + " | Ask Glocky " + w.grade + " " + w.pick + " " + w.proj + " | site " + s.grade + " " + s.pick + " " + (+s.proj).toFixed(1));
    }
  }
  if (!n) return; // empty board: nothing to compare
  assert.equal(bad.length, 0, n + " lines checked, " + bad.length + " differ:\n" + bad.slice(0, 10).join("\n"));
});

test("a line that is not on the board (no start time) still grades without throwing", () => {
  const a = L.answerQuestion("EliGE over 35.5 kills maps 1-2?", store);
  assert.equal(a.missing, false, a.factText);
  assert.ok(a.grade && a.grade.grade && a.grade.pick);
});
