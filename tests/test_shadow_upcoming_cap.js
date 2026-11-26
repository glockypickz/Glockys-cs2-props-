// Shadow tab: the Upcoming list must reach the whole slate. At 150 it stopped after the early matches
// (EliGE's 5:00 AM Liquid match was cut off, so it looked ungraded). Source check; the page itself was render-checked.
const test = require('node:test'), assert = require('node:assert/strict');
const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
test('the upcoming shadow list shows at least 400 props (a full slate is about 300)', () => {
  const m = app.match(/Upcoming shadow picks · '\+up\.length\+'<\/h2>'\+\(up\.length\?up\.slice\(0,(\d+)\)/);
  assert.ok(m, 'upcoming list slice not found');
  assert.ok(+m[1] >= 400, 'cap is ' + m[1]);
});
test('the "showing the first N" note uses the same number as the cap', () => {
  const cap = app.match(/up\.slice\(0,(\d+)\)\.map\(function\(it\)\{return card\(it,false\)\}\)/)[1];
  assert.match(app, new RegExp('up\\.length>' + cap + "\\?'<div class=\"muted\">Showing the first " + cap + '\\.'));
});
