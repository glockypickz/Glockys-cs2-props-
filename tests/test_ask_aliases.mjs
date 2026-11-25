// Ask Glocky finds players by the same aliases as the site: "koala" on PrizePicks is "koaLx" in the stats.
// Synthetic players only (the real players.json changes daily). Also keeps the three alias tables equal.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
globalThis.GPModel = require(join(root, "model.js"));
const L = await import("../ask_lookup.js");

const logs = Array.from({ length: 8 }, (_, d) => ({ date: "2026-11-" + String(d + 1).padStart(2, "0"), mid: 100 + d, n: 1, map: "Mirage", opp: "9z", kills: 14, hs: 7, d: 12, a: 2, adr: 75, rd: 24 }));
const mk = (name, team) => ({ name, team, logs: logs.slice() });
const store = L.makeStore({
  players: { players: [mk("★ ㉑ koaLx", "DENDELE"), mk("doc", "DENDELE"), mk("koala", "Other Team"), mk("agl", "Some Team"), mk("EP.-4Z", "Four Team"), mk("★ ⑳ Gafolo *Certto Telecom", "DENDELE"), mk("NLG* s1n", "M80")], ranks: {} },
  strength: null, games: [], lines: [],
});

test("koala finds koaLx on Dendele, with the PrizePicks team name too", () => {
  assert.equal(L.findPlayer(store, "koala", "DENDELE CS").name, "★ ㉑ koaLx");
  assert.equal(L.findPlayer(store, "koala", "DENDELE").name, "★ ㉑ koaLx");
  assert.equal(L.findPlayer(store, "Koala", "DENDELE CS").name, "★ ㉑ koaLx");
});

test("an exact name on the asked team still wins over the alias", () => {
  assert.equal(L.findPlayer(store, "koala", "Other Team").team, "Other Team");
});

test("the alias never crosses teams", () => {
  assert.equal(L.findPlayer(store, "koala", "Some Team"), null);
});

test("a sponsor tag after \" *\" does not hide the player (gafolo), a prefix tag is left alone (NLG* s1n)", () => {
  assert.equal(L.findPlayer(store, "gafolo", "DENDELE CS").name, "★ ⑳ Gafolo *Certto Telecom");
  const q = L.parseQuestion("gafolo over 24 kills maps 1-2", store);
  assert.equal(q.player && q.player.name, "★ ⑳ Gafolo *Certto Telecom");
  assert.equal(store.index.exact.has("nlg"), false);   // a naive split on "*" would have indexed the sponsor "NLG"
  assert.equal(store.index.exact.has("nlgs1n"), true);
});

test("older site aliases work in Ask Glocky too (4Z, Ag1l)", () => {
  assert.equal(L.findPlayer(store, "4Z", "Four Team").name, "EP.-4Z");
  assert.equal(L.findPlayer(store, "Ag1l", "Some Team").name, "agl");
});

test("site, grader.py and Ask Glocky carry the same player alias table", () => {
  const app = readFileSync(join(root, "app.js"), "utf8").match(/var ALIASES=(\{[^}]*\});/);
  assert.ok(app, "ALIASES found in app.js");
  const site = JSON.parse(app[1]);
  const py = JSON.parse(execFileSync("python3", ["-c", "import json,sys; sys.path.insert(0, %s); import grader; print(json.dumps(grader.ALIASES))".replace("%s", JSON.stringify(root))], { encoding: "utf8" }));
  assert.deepEqual(L.ALIASES, site);
  assert.deepEqual(py, site);
});
