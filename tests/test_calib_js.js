// Node: residualProbs / letterFromEdge / erf must match grader.py (run from repo root).
var M = require("../model.js");
var assert = require("assert");
var cases = [
  [26.8, 23.5, "kills", "Maps 1-2", 1],
  [26.8, 24, "kills", "Maps 1-2", 1],
  [12.2, 11.5, "hs", "Map 1", 1],
  [53.6, 47, "kills", "Maps 1-2", 2],
  [20, 30.5, "kills", "Maps 1-2", 1]
];
var out = cases.map(function (c) {
  var r = M.residualProbs(c[0], c[1], c[2], c[3], c[4]);
  var pick = r[0] >= r[2] ? "OVER" : "UNDER";
  var p = pick === "OVER" ? r[0] : r[2];
  var be = M.breakEven("Underdog", null);
  var ls = M.letterFromEdge((p - be) * 100);
  return {po: r[0], push: r[1], pu: r[2], grade: ls.grade, stake: ls.stake, erf0: M.erfAs(0), erfHalf: M.erfAs(0.5)};
});
var capA = M.applyGradeCap({grade:'A+',stake:2,bait:false}, 'kills', 'lan', false, null);
if (capA.grade !== 'C+' || capA.stake !== 0.5 || !capA.gradeCap.applied || capA.gradeCap.reason !== 'lan_kills') {
  console.error('FAIL lan kills cap', capA); process.exit(1);
}
var capB = M.applyGradeCap({grade:'B',stake:1,bait:true}, 'hs', 'online', true, null);
if (capB.grade !== 'C+' || capB.gradeCap.reason !== 'bait') { console.error('FAIL bait cap', capB); process.exit(1); }
var capC = M.applyGradeCap({grade:'A',stake:1.5,bait:false}, 'hs', 'lan', false, null);
if (capC.grade !== 'A' || capC.gradeCap.applied) { console.error('FAIL lan hs should not cap', capC); process.exit(1); }
var capD = M.applyGradeCap({grade:'C',stake:0.25,bait:false}, 'kills', 'lan', false, null);
if (capD.grade !== 'C' || capD.gradeCap.applied) { console.error('FAIL C should stay C', capD); process.exit(1); }
if (M.VERSION !== 'v1e') { console.error('FAIL VERSION', M.VERSION); process.exit(1); }

process.stdout.write(JSON.stringify(out));
