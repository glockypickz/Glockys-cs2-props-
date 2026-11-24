// Ask Glocky must load the real players.json under the Workers 128 MB isolate cap.
// Run: node --max-old-space-size=128 tests/test_ask_store_budget.mjs
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

const players = JSON.parse(readFileSync(join(root, "players.json"), "utf8"));
const strength = JSON.parse(readFileSync(join(root, "team_strength.json"), "utf8"));
const games = JSON.parse(readFileSync(join(root, "games.json"), "utf8"));
const lines = JSON.parse(readFileSync(join(root, "lines.json"), "utf8"));

test("compact store + a LAN kpm question + one grade fit in a 128 MB heap", () => {
  const store = L.makeStore({ players, strength, games, lines });
  assert.ok(store._compact);
  assert.equal(store._ctx, undefined);
  const ans = L.answerQuestion("What's fl1ts avg kills per map on LAN", store);
  assert.equal(ans.missing, false, ans.factText);
  assert.ok(ans.facts && ans.facts.kills && ans.facts.kills.avg != null);
  const g = L.answerQuestion("EliGE over 35.5 kills maps 1-2?", store);
  assert.equal(g.missing, false, g.factText);
  assert.ok(g.grade && g.grade.grade);
  const heap = process.memoryUsage().heapUsed / 1048576;
  assert.ok(heap < 128, "heapUsed MB after ask+grade: " + heap.toFixed(1));
});
