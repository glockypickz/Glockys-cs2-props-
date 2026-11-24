// Fail the build if any Worker module uses eval / new Function / string-timer APIs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT_RE = /(?:from|import)\s+["'](\.[^"']+)["']/g;
const EVAL_RE = /\beval\s*\(/;
const NEW_FN_RE = /\bnew\s+Function\s*\(/;
const STRING_TIMER_RE = /\bset(?:Timeout|Interval)\s*\(\s*["'`]/;

function workerModules(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    let m;
    const re = new RegExp(IMPORT_RE.source, "g");
    while ((m = re.exec(src))) {
      let n = m[1];
      if (!extname(n)) n += ".js";
      const next = n.replace(/^\.\//, "");
      queue.push(next);
    }
  }
  return [...seen];
}

test("Worker modules do not use eval, new Function, or string timers", () => {
  const files = workerModules("worker.js");
  assert.ok(files.includes("worker.js"));
  assert.ok(files.includes("ask_ai.js"));
  assert.ok(files.includes("slip_ai.js"));
  assert.ok(files.includes("model.js"), "model.js must be statically imported into the Worker");
  const hits = [];
  for (const rel of files) {
    const raw = readFileSync(join(root, rel), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    if (EVAL_RE.test(src)) hits.push(rel + ": eval(");
    if (NEW_FN_RE.test(src)) hits.push(rel + ": new Function(");
    if (STRING_TIMER_RE.test(src)) hits.push(rel + ": setTimeout/setInterval(string)");
  }
  assert.equal(hits.length, 0, "dynamic code generation in Worker modules: " + hits.join(", "));
});
