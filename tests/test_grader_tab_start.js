// The Grader tab must grade a line exactly like the Lines tab does, and a grade with no cutoff must still use the per-map term.
// Run: node --test tests/test_grader_tab_start.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const GM = require(path.join(root, "model.js"));
const rd = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
const src = (f) => fs.readFileSync(path.join(root, f), "utf8");

const raw = { p: rd("players.json"), s: rd("team_strength.json"), g: rd("games.json"), l: rd("lines.json") };
const dec = GM.decodePlayers(raw.p);
const ctx = GM.build(dec.players, null, raw.s, dec.ranks || {});
const today = new Date().toISOString().slice(0, 10);

function pick() {
  const l = (raw.l.lines || []).find((x) => x.book === "PrizePicks" && x.period === "Map 1" && /head/i.test(x.stat) && x.opponent);
  if (!l) return null;
  const p = dec.players.find((x) => GM.tn(x.team) === GM.tn(l.team) && GM.norm(x.name) === GM.norm(l.player));
  return p ? { l, p } : null;
}

test("a grade with no cutoff uses the per-map term (it used to switch it off)", () => {
  const x = pick();
  if (!x) return;
  const m = GM.grade(ctx, x.p, "hs", +x.l.line, x.l.opponent, { team: x.p.team, period: "Map 1" });
  assert.ok(m && m.v1 && m.v1.map, "map block present");
  assert.equal(m.v1.map.used, true, "per-map term is on");
  assert.ok(m.v1.map.avg != null && m.v1.map.n > 0, "per-map average found");
});

test("no cutoff, an empty cutoff and the '9999' sentinel are the same grade, with the per-map term on", () => {
  const x = pick();
  if (!x) return;
  const base = { team: x.p.team, period: "Map 1" };
  const ref = GM.grade(ctx, x.p, "hs", +x.l.line, x.l.opponent, base);
  assert.equal(ref.v1.map.used, true);
  for (const b of ["", "9999"]) {
    const m = GM.grade(ctx, x.p, "hs", +x.l.line, x.l.opponent, Object.assign({ before: b }, base));
    assert.equal(m.v1.map.used, true, "per-map term on for before=" + JSON.stringify(b));
    assert.equal(m.grade, ref.grade);
    assert.equal(m.pick, ref.pick);
    assert.equal(+m.proj.toFixed(3), +ref.proj.toFixed(3));
  }
});

test("a real cutoff date is passed through unchanged (locks and the track record still use their own day)", () => {
  const x = pick();
  if (!x) return;
  const d = "2026-11-10";
  const a = GM.grade(ctx, x.p, "hs", +x.l.line, x.l.opponent, { team: x.p.team, period: "Map 1", before: d });
  const b = GM.grade(ctx, x.p, "hs", +x.l.line, x.l.opponent, { team: x.p.team, period: "Map 1", before: d + "T12:00:00Z" });
  assert.equal(+a.proj.toFixed(3), +b.proj.toFixed(3));
});

test("Grader tab calls pass the match start, and a manual edit drops a stale start", () => {
  const app = src("app.js");
  assert.match(app, /gradeFor\(sel\.player,sel\.team\|\|'',sel\.stat,line,sel\.opp,\{[^}]*start:sel\.start\}\)/, "grader tab render");
  assert.match(app, /function curGrade\(\)\{[^\n]*start:sel\.start\}\)/, "curGrade");
  assert.match(app, /sel=\{player:l2\.player[^\n]*start:l2\.start\|\|''/, "board line pick still stores its start");
  assert.match(app, /if\(np!==sel\.player\|\|\$\('go'\)\.value!==sel\.opp\)sel\.start=''/, "manual grade clears a stale start");
  assert.match(app, /a==='pg'\)\{sel\.start='';/, "player page pick clears start");
  assert.match(app, /var pp2=find\(sel\.pl\);sel\.start='';/, "pgrade clears start");
});
