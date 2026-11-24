// Display-only bait / blowout warning icon.
// Run: node tests/test_warn_icon.js
var fs = require("fs");
var path = require("path");
var W = require("../warn_icon.js");
var failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { failed++; console.log("  FAIL  " + name); }
}

console.log("threshold and blow_probs (PR 30 / scout_params.json hyper)");
check("threshold is 30% per map", W.BLOWOUT_RISK_THRESHOLD === 0.30);
var even = W.blowProbs(0.5);
check("even match is under the threshold (~24%)", even.p > 0.24 && even.p < 0.25 && !W.isBlowout(even.p));
var fav70 = W.blowProbs(0.7);
check("70% Elo favorite crosses 30%", fav70.p >= 0.30 && fav70.p < 0.31 && W.isBlowout(fav70.p));
var fav60 = W.blowProbs(0.6);
check("60% favorite stays under 30%", fav60.p < 0.30 && !W.isBlowout(fav60.p));
var dog25 = W.blowProbs(0.25);
check("25% underdog also crosses 30%", dog25.p >= 0.30 && W.isBlowout(dog25.p));
// Spot-check against scout_model.blow_probs with the fitted coefficients
check("p_win at 50/50 is ~0.129", Math.abs(even.p_win - 0.129104) < 1e-5);
check("p_loss at 50/50 is ~0.114", Math.abs(even.p_loss - 0.114153) < 1e-5);
check("p_win at 80/20 is ~0.335", Math.abs(W.blowProbs(0.8).p_win - 0.334781) < 1e-5);

console.log("flags and tooltip");
check("no icon when neither flag applies", W.icon({ bait: false }, { winp: 0.5 }) === "");
check("no blowout flag without risk or bait", W.flags({ bait: false }).show === false);

var baitOnly = W.flags({ bait: true, period: "Maps 1-2" }, { winp: 0.5 });
check("bait-only is shown", baitOnly.show && baitOnly.bait && !baitOnly.blowout);
var baitHtml = W.icon({ bait: true, period: "Maps 1-2" }, { winp: 0.5 });
check("bait icon is the warning symbol", baitHtml.indexOf("⚠️") > -1 && baitHtml.indexOf("warn-icon") > -1);
check("bait tooltip names the bait flag and last 5 Maps 1-2 series", /Flagged as bait/.test(baitOnly.title) && /last 5 Maps 1-2 series/.test(baitOnly.title) && !/blowout risk/.test(baitOnly.title));

var map1Bait = W.flags({ bait: true, period: "Map 1" }, { winp: 0.5 });
check("Map 1 bait tooltip uses Map 1 maps", /last 5 Map 1 maps/.test(map1Bait.title));

var boOnly = W.flags({ bait: false, period: "Maps 1-2" }, { winp: 0.8 });
check("blowout-only is shown from Elo win chance", boOnly.show && boOnly.blowout && !boOnly.bait && boOnly.source === "elo");
check("blowout tooltip names the flag, percent, 13-5, and 30% threshold", /Flagged as blowout risk/.test(boOnly.title) && /37%/.test(boOnly.title) && /13-5/.test(boOnly.title) && /30% or more/.test(boOnly.title) && !/Flagged as bait/.test(boOnly.title));

var shadow = { p_win: 0.40, p_loss: 0.05 };
var fromShadow = W.flags({ bait: false }, { shadow: shadow, winp: 0.5 });
check("saved scout shadow blowout is preferred over Elo", fromShadow.source === "shadow" && fromShadow.blowout && Math.abs(fromShadow.risk - 0.45) < 1e-9);

var lowShadow = W.flags({ bait: false }, { shadow: { p_win: 0.10, p_loss: 0.10 }, winp: 0.9 });
check("shadow risk under 30% is not flagged even if Elo would flag", !lowShadow.blowout && !lowShadow.show);

var both = W.flags({ bait: true, period: "Maps 1-2" }, { shadow: { p_win: 0.30, p_loss: 0.10 } });
check("both flags are listed in the tooltip", both.bait && both.blowout && /bait and as blowout risk/.test(both.title) && /last 5 Maps 1-2 series/.test(both.title) && /40%/.test(both.title));
check("icon title and aria-label are escaped", W.icon({ bait: true }, { winp: 0.5 }).indexOf('title="') > -1 && W.icon({ bait: true }, { winp: 0.5 }).indexOf("aria-label=") > -1);

var viaGrade = W.flags({ bait: false, blowout: { p_win: 0.22, p_loss: 0.14 } });
check("blowout object on the grade is used when no opts.shadow is passed", viaGrade.source === "shadow" && viaGrade.blowout);

console.log("display only: CSS pulse and reduced motion");
var css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
check("warn-icon class has a pulse animation", /\.warn-icon\{[^}]*animation:warnPulse/.test(css.replace(/\s+/g, "")));
check("warnPulse keyframes exist", /@keyframes warnPulse/.test(css));
check("prefers-reduced-motion disables the warn-icon animation", /prefers-reduced-motion:[^}]*\.warn-icon\{[^}]*animation:\s*none/.test(css.replace(/\s+/g, "")));

console.log("wiring: icon is shown on the four surfaces, grades are untouched");
var app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
check("gradePill includes the warning icon", /function gradePill\(g\)\{[^}]*warnIcon\(g\)/.test(app.replace(/\n/g, "")));
check("gradeCard includes the warning icon", /function gradeCard\(g\)\{[\s\S]*?warnIcon\(g\)/.test(app));
check("viewSlip includes the warning icon", /function viewSlip\(\)\{[\s\S]*?warnIcon\(/.test(app));
check("gpItem uses gradePill (Games prop panel)", /function gpItem\(a\)\{[\s\S]*?gradePill\(g\)/.test(app));
check("viewLines uses gradePill", /function viewLines\(\)\{[\s\S]*?gradePill\(g\)/.test(app));
check("live grade() still only sets bait as a flag, not a letter change", /r\.bait=isBait/.test(fs.readFileSync(path.join(__dirname, "..", "model.js"), "utf8")));

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("all ok");
