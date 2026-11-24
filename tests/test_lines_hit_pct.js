// Display of the model's P(side) on Lines tab rows.
// Run: node tests/test_lines_hit_pct.js
var fs = require("fs");
var path = require("path");
var failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { failed++; console.log("  FAIL  " + name); }
}

var app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
var css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
var css1 = css.replace(/\s+/g, "");

function grab(name) {
  var m = app.match(new RegExp("function " + name + "\\([^)]*\\)\\{[^}]*\\}"));
  return m && m[0];
}

var src = grab("pickChance");
check("pickChance helper exists", !!src);
check("pickChance uses g.pPick and pc1", /g\.pPick/.test(src) && /pc1\(g\.pPick\)/.test(src));
check("pickChance shows the pick side", /esc\(g\.pick\)/.test(src));
check("pickChance is empty when there is no probability", /if\(!g\|\|g\.pPick==null\|\|isNaN\(g\.pPick\)\)return ''/.test(src));

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function pc1(x){return x==null||isNaN(x)?'–':(x*100).toFixed(1)+'%'}
var pickChance;
eval("pickChance = " + src.replace(/^function pickChance/, "function"));

var over = pickChance({ pick: "OVER", pPick: 0.623 });
var under = pickChance({ pick: "UNDER", pPick: 0.64 });
check("OVER 62.3% uses the same one-decimal format as the Grader", /OVER 62\.3%/.test(over) && over.indexOf("pick-pct") > -1);
check("UNDER 64.0% uses the red class", /UNDER 64\.0%/.test(under) && /pick-pct u/.test(under));
check("missing pPick is blank", pickChance(null) === "" && pickChance({ pick: "OVER" }) === "" && pickChance({ pick: "OVER", pPick: NaN }) === "");
check("tooltip says this is the same number the letter uses", /same number the letter uses/.test(over));

console.log("wiring on Lines and the game props panel");
check("viewLines shows pickChance next to the grade pill", /function viewLines\(\)\{[\s\S]*?gradePill\(g\)\+pickChance\(g\)/.test(app));
check("gpItem shows pickChance next to the grade pill", /function gpItem\(a\)\{[\s\S]*?gradePill\(g\)\+pickChance\(g\)/.test(app));
check("Lines rows keep blowPropLine and gradePill", /function viewLines\(\)\{[\s\S]*?blowPropLine\([\s\S]*?gradePill\(g\)/.test(app));

console.log("mobile layout");
check("pick-pct is a compact block under the pill", /\.pick-pct\{/.test(css1) && /white-space:nowrap/.test(css.match(/\.pick-pct\{[^}]+\}/)[0].replace(/\s+/g, "")));
check("UNDER chance uses the red color", /\.pick-pct\.u\{[^}]*color:var\(--red\)/.test(css1));
check("phone styles keep the percent readable", /@media\(max-width:500px\)\{[^@]*\.pick-pct\{[^}]*font-size:11px/.test(css1) && /@media\(max-width:500px\)\{[^@]*\.item\{[^}]*align-items:flex-start/.test(css1));
check("item-side is used instead of an inline right-align", /item-side/.test(app) && /\.item-side\{/.test(css1));

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("all ok");
