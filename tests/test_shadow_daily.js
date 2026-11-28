// Admin Shadow tab: GPModel.shadowDaily gives the Scout (shadow_s) hit rate per Central day next to the live lock.
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('../model.js');
const CT = (iso) => new Date(new Date(iso).getTime() - 6 * 3600e3).toISOString().slice(0, 10);   // Central standard time, enough for the fixtures
const NOW = new Date('2026-11-26T12:00:00Z').getTime();
function e(start, o) {
  return {
    start, stat: o.stat || 'Kills', period: o.period || 'Map 1',
    lock: o.lock === undefined ? { grade: 'C', pick: 'OVER', line: 13.5 } : o.lock,
    shadow_s: o.s === undefined ? { pick: 'OVER', line: 13.5, grade: 'C' } : o.s,
    result: o.r === undefined ? { act: 16, outcome: 'hit' } : o.r,
  };
}
const H = [
  e('2026-11-24T10:00:00Z', {}),                                                          // Scout OVER 13.5, act 16: win; live OVER win
  e('2026-11-24T10:00:00Z', { s: { pick: 'UNDER', line: 13.5, grade: 'F' }, stat: 'Headshots' }),   // Scout UNDER loses; live OVER wins; Scout not a play
  e('2026-11-25T08:00:00Z', { r: { act: 10, outcome: 'miss' } }),                          // Scout OVER loses; live OVER loses
  e('2026-11-25T08:00:00Z', { s: { pick: 'UNDER', line: 13.5, grade: 'B' }, r: { act: 10, outcome: 'miss' }, lock: null }),  // Scout UNDER wins; no live grade
  e('2026-11-25T08:00:00Z', { r: { act: 13.5, outcome: 'push' } }),                        // push: left out
  e('2026-11-25T08:00:00Z', { r: { act: 12, outcome: 'void' } }),                          // void: left out
  e('2026-11-25T08:00:00Z', { r: null }),                                                  // not settled yet: left out
  e('2026-11-25T08:00:00Z', { s: { skipped: true } }),                                     // skipped by Scout: left out
  e('2026-11-27T08:00:00Z', {}),                                                          // upcoming: left out
  { start: '2026-11-25T08:00:00Z', stat: 'Kills', result: { act: 16 } },                  // no shadow_s at all: left out
];
const D = M.shadowDaily(H, 'shadow_s', CT, NOW);

test('days come newest first, grouped by the Central date', () => {
  assert.deepEqual(D.days.map((d) => d.day), ['2026-11-25', '2026-11-24']);
});
test('Nov 24: Scout 1-1, live on the same props 2-0, one Scout play', () => {
  const d = D.days[1];
  assert.deepEqual([d.n, d.w, d.ln, d.lw, d.pn, d.pw], [2, 1, 2, 2, 1, 1]);
  assert.deepEqual([d.kn, d.kw, d.hn, d.hw, d.on, d.ow, d.un, d.uw], [1, 1, 1, 0, 1, 1, 1, 0]);
});
test('Nov 25: pushes, voids, unsettled, skipped, upcoming and missing shadow are left out', () => {
  const d = D.days[0];
  assert.deepEqual([d.n, d.w], [2, 1]);
  assert.deepEqual([d.ln, d.lw], [1, 0]);          // only the prop with a live grade counts for live
  assert.deepEqual([d.pn, d.pw], [2, 1]);          // C and B are plays
});
test('the total row adds the days up', () => {
  assert.deepEqual([D.total.n, D.total.w, D.total.ln, D.total.lw, D.total.pn, D.total.pw], [4, 2, 3, 2, 3, 2]);
});
test('works with no history', () => {
  const z = M.shadowDaily(null, 'shadow_s', CT, NOW);
  assert.deepEqual([z.days.length, z.total.n], [0, 0]);
});
test('the helper is wired into the Shadow tab', () => {
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /GPModel\.shadowDaily\(HIST,'shadow_s',cday,NOW\(\),\{maps12Only:true\}\)/);
  assert.match(app, /Shadow S \(Scout\) · hit rate by day/);
});

// Map 1 props can be left out of the Scout record (admin Shadow tab asks for this).
const MIX = [
  e('2026-11-24T10:00:00Z', { period: 'Maps 1-2' }),                                       // counted: win
  Object.assign(e('2026-11-24T10:00:00Z', { r: { act: 10, outcome: 'miss' } }), { period: null }),   // old entry with no period = Maps 1-2: counted, loss
  e('2026-11-24T10:00:00Z', { period: 'Map 1' }),                                          // Map 1: left out
  e('2026-11-24T10:00:00Z', { period: 'Map 1', stat: 'Headshots' }),                       // Map 1: left out
];
test('maps12Only drops Map 1 props but keeps Maps 1-2 and entries with no period', () => {
  const all = M.shadowDaily(MIX, 'shadow_s', CT, NOW);
  const m12 = M.shadowDaily(MIX, 'shadow_s', CT, NOW, { maps12Only: true });
  assert.equal(all.total.n, 4);
  assert.equal(m12.total.n, 2);
  assert.equal(m12.total.w, 1);
  assert.equal(m12.total.hn, 0);               // the Map 1 headshot prop is gone
  assert.equal(m12.days.length, 1);
});
test('without the option nothing changes (other callers keep Map 1)', () => {
  assert.equal(M.shadowDaily(MIX, 'shadow_s', CT, NOW, {}).total.n, 4);
});
test('the Scout record block in the Shadow tab skips Map 1 props', () => {
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /var sAll=\[\],sUp=0;[^\n]*if\(x\.skipped\)|var x=e\.shadow_s;if\(!x\|\|x\.skipped\)return;if\(GPModel\.isMap1Period\(e\.period\)\)return;/);
});
