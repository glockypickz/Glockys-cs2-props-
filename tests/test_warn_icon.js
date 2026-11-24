// Display-only bait / blowout warning icon and always-visible chance text.
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
check("p_win at 50/50 is ~0.129", Math.abs(even.p_win - 0.129104) < 1e-5);
check("p_loss at 50/50 is ~0.114", Math.abs(even.p_loss - 0.114153) < 1e-5);
check("p_win at 80/20 is ~0.335", Math.abs(W.blowProbs(0.8).p_win - 0.334781) < 1e-5);

console.log("always-visible chance text and favored side");
var p80 = W.predict({ winp: 0.8, team: "FaZe", opp: "G2" });
check("80% favorite text names FaZe and 37%", p80.text === "Blowout risk 37% per map · FaZe favored" && p80.flagged && p80.favored === "FaZe");
var p20 = W.predict({ winp: 0.2, team: "G2", opp: "FaZe" });
check("20% side names the opponent as favored", p20.favored === "FaZe" && /FaZe favored/.test(p20.text) && p20.flagged);
var p50 = W.predict({ winp: 0.5, team: "FaZe", opp: "G2" });
check("50/50 is even match and not flagged", p50.text === "Blowout risk 24% per map · even match" && !p50.flagged && !p50.favored);
var p51 = W.predict({ winp: 0.51, team: "FaZe", opp: "G2" });
check("51% stays in the even band", !p51.favored && /even match/.test(p51.text));
var p48 = W.predict({ winp: 0.48, team: "FaZe", opp: "G2" });
check("48% is still even", !p48.favored && /even match/.test(p48.text));
var p47 = W.predict({ winp: 0.47, team: "FaZe", opp: "G2" });
check("47% names the opponent", p47.favored === "G2");
check("no text when chance cannot be computed", W.predict({}).text === "" && W.gameLine(W.predict({})) === "" && W.propLine(W.predict({})) === "");

var gameHot = W.gameLine(p80);
check("game line shows the chance text", gameHot.indexOf("Blowout risk 37% per map · FaZe favored") > -1);
check("game line includes the warning icon at >=30%", gameHot.indexOf("warn-icon") > -1 && gameHot.indexOf("⚠️") > -1);
check("game line is marked hot at >=30%", /class="blow-line hot"/.test(gameHot));
var gameEven = W.gameLine(p50);
check("even game line has no warning icon", gameEven.indexOf("⚠️") < 0 && gameEven.indexOf("even match") > -1);
check("even game line is not hot", /class="blow-line"/.test(gameEven) && gameEven.indexOf("hot") < 0);
var propHot = W.propLine(p80);
check("prop line shows the chance and no extra icon (icon stays on the pill)", propHot.indexOf("Blowout risk 37%") > -1 && propHot.indexOf("⚠️") < 0);
check("shadow chance is preferred and still gets visible text", W.predict({ shadow: { p_win: 0.40, p_loss: 0.05 }, winp: 0.5, team: "FaZe", opp: "G2" }).text.indexOf("Blowout risk 45% per map") === 0);

console.log("Games tab verdict (BLOWOUT EXPECTED or NO BLOWOUT EXPECTED)");
check("game line says BLOWOUT EXPECTED at >=30%", /class="pill blow-verdict blow"[^>]*>BLOWOUT EXPECTED</.test(gameHot));
check("game line says NO BLOWOUT EXPECTED below 30%", /class="pill blow-verdict calm"[^>]*>NO BLOWOUT EXPECTED</.test(gameEven) && gameEven.indexOf(">BLOWOUT EXPECTED<") < 0);
check("verdict sits right before the risk text", gameHot.indexOf(">BLOWOUT EXPECTED</span> Blowout risk 37% per map") > -1);
check("exactly at the threshold counts as expected", W.gameLine(W.predict({ shadow: { p_win: 0.20, p_loss: 0.10 }, team: "A", opp: "B" })).indexOf(">BLOWOUT EXPECTED<") > -1);
check("just under the threshold is not expected", W.gameLine(W.predict({ shadow: { p_win: 0.20, p_loss: 0.09 }, team: "A", opp: "B" })).indexOf(">NO BLOWOUT EXPECTED<") > -1);
check("no verdict when the chance cannot be computed", W.verdict(W.predict({})) === "" && W.verdict(null) === "");
check("prop line has no verdict (props use the BLOWOUT tag)", W.propLine(p80).indexOf("blow-verdict") < 0);
check("verdict tooltip explains the rule and escapes", /title="[^"<>]*13-5 or wider[^"<>]*never changes a grade or pick/.test(gameHot));
check("verdict does not change the flags or icon rules", W.flags({}, { winp: 0.5 }).show === false && W.flags({}, { winp: 0.8, team: "A", opp: "B" }).blowout === true);
var cssV = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8").replace(/\s+/g, "");
check("verdict styles exist", /\.pill\.blow-verdict\{/.test(cssV) && /\.pill\.calm\{/.test(cssV));
var appSrcV = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
check("every game card line goes through blowGameLine", (appSrcV.match(/blowGameLine\(/g) || []).length >= 4);

console.log("flags and tooltip (icon still only at bait or >=30%)");
check("no icon when neither flag applies", W.icon({ bait: false }, { winp: 0.5 }) === "");
check("no blowout flag without risk or bait", W.flags({ bait: false }).show === false);
var baitOnly = W.flags({ bait: true, period: "Maps 1-2" }, { winp: 0.5 });
check("bait-only is shown", baitOnly.show && baitOnly.bait && !baitOnly.blowout);
var baitHtml = W.icon({ bait: true, period: "Maps 1-2" }, { winp: 0.5 });
check("bait icon is the warning symbol", baitHtml.indexOf("⚠️") > -1 && baitHtml.indexOf("warn-icon") > -1);
check("bait tooltip names the bait flag and last 5 Maps 1-2 series", /Flagged as bait/.test(baitOnly.title) && /last 5 Maps 1-2 series/.test(baitOnly.title) && !/blowout risk/.test(baitOnly.title));
var map1Bait = W.flags({ bait: true, period: "Map 1" }, { winp: 0.5 });
check("Map 1 bait tooltip uses Map 1 maps", /last 5 Map 1 maps/.test(map1Bait.title));
var boOnly = W.flags({ bait: false, period: "Maps 1-2" }, { winp: 0.8, team: "FaZe", opp: "G2" });
check("blowout-only is shown from Elo win chance", boOnly.show && boOnly.blowout && !boOnly.bait && boOnly.source === "elo");
check("blowout tooltip names the flag, percent, 13-5, and 30% threshold", /Flagged as blowout risk/.test(boOnly.title) && /37%/.test(boOnly.title) && /13-5/.test(boOnly.title) && /30% or more/.test(boOnly.title) && !/Flagged as bait/.test(boOnly.title));
var shadow = { p_win: 0.40, p_loss: 0.05 };
var fromShadow = W.flags({ bait: false, team: "FaZe" }, { shadow: shadow, winp: 0.5 });
check("saved scout shadow blowout is preferred over Elo", fromShadow.source === "shadow" && fromShadow.blowout && Math.abs(fromShadow.risk - 0.45) < 1e-9);
var lowShadow = W.flags({ bait: false }, { shadow: { p_win: 0.10, p_loss: 0.10 }, winp: 0.9 });
check("shadow risk under 30% is not flagged even if Elo would flag", !lowShadow.blowout && !lowShadow.show);
var both = W.flags({ bait: true, period: "Maps 1-2" }, { shadow: { p_win: 0.30, p_loss: 0.10 } });
check("both flags are listed in the tooltip", both.bait && both.blowout && /bait and as blowout risk/.test(both.title) && /last 5 Maps 1-2 series/.test(both.title) && /40%/.test(both.title));
check("icon title and aria-label are escaped", W.icon({ bait: true }, { winp: 0.5 }).indexOf('title="') > -1 && W.icon({ bait: true }, { winp: 0.5 }).indexOf("aria-label=") > -1);
var viaGrade = W.flags({ bait: false, blowout: { p_win: 0.22, p_loss: 0.14 } });
check("blowout object on the grade is used when no opts.shadow is passed", viaGrade.source === "shadow" && viaGrade.blowout);

console.log("BLOWOUT tag (like the BAIT tag)");
var tag80 = W.badge({ bait: false, team: "FaZe", opp: "G2" }, { winp: 0.8, team: "FaZe", opp: "G2" });
check("a 80% favorite gets a BLOWOUT pill", /<span class="pill blow"[^>]*>BLOWOUT<\/span>/.test(tag80));
check("the tooltip has the chance, the favored side and the 13-5 meaning", /Blowout risk 37% per map/.test(tag80) && /FaZe favored/.test(tag80) && /13-5 or wider/.test(tag80));
check("the tooltip says it never changes the grade or pick", /never changes the grade or pick/.test(tag80));
check("an even match gets no tag", W.badge({ bait: false }, { winp: 0.5, team: "FaZe", opp: "G2" }) === "");
check("a 60% favorite gets no tag (under 30%)", W.badge({ bait: false }, { winp: 0.6, team: "FaZe", opp: "G2" }) === "");
check("a 70% favorite gets the tag (30% is the line)", W.badge({ bait: false }, { winp: 0.7, team: "FaZe", opp: "G2" }).indexOf("BLOWOUT") > -1);
check("a 25% underdog's match gets the tag too", W.badge({ bait: false }, { winp: 0.25, team: "G2", opp: "FaZe" }).indexOf("BLOWOUT") > -1);
check("no chance available means no tag", W.badge({ bait: false }, {}) === "" && W.badge(null, {}) === "");
check("bait alone does not make a BLOWOUT tag", W.badge({ bait: true, period: "Maps 1-2" }, { winp: 0.5 }) === "");
check("a saved scout shadow is used for the tag", W.badge({ bait: false }, { shadow: { p_win: 0.40, p_loss: 0.05 }, winp: 0.5, team: "FaZe" }).indexOf("BLOWOUT") > -1);
check("shadow under 30% gives no tag even if Elo would", W.badge({ bait: false }, { shadow: { p_win: 0.10, p_loss: 0.10 }, winp: 0.9 }) === "");
check("team names in the tooltip are escaped", W.badge({ bait: false }, { winp: 0.8, team: "<b>x</b>", opp: "G2" }).indexOf("<b>x</b>") < 0);
check("the warning icon still shows for bait and blowout as before", W.icon({ bait: true }, { winp: 0.5 }).indexOf("⚠️") > -1 && W.icon({ bait: false }, { winp: 0.8, team: "FaZe", opp: "G2" }).indexOf("⚠️") > -1);
var appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
check("every grade pill carries the BLOWOUT tag after BAIT", /function gradePill\(g\)\{return [^}]*baitBadge\(g\)\+blowBadge\(g\)\+warnIcon\(g\)\}/.test(appSrc));
check("the Grader result header shows it too", /baitBadge\(g\)\+blowBadge\(g\)\+warnIcon\(g\)\+'<div><span class="pill '/.test(appSrc));
check("blowBadge uses the same options as the icon", /function blowBadge\(g,extra\)\{return \(typeof GPWarn!=='undefined'&&g\)\?GPWarn\.badge\(g,warnOpts\(g,extra\)\):''\}/.test(appSrc));
var cssB = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8").replace(/\s+/g, "");
check("the BLOWOUT pill has its own style, next to BAIT", /\.pill\.blow\{background:#ff7a3d;color:#000;margin-left:4px/.test(cssB));

console.log("display only: CSS pulse, reduced motion, visible chance line");
var css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
var css1 = css.replace(/\s+/g, "");
check("warn-icon class has a pulse animation", /\.warn-icon\{[^}]*animation:warnPulse/.test(css1));
check("warnPulse keyframes exist", /@keyframes warnPulse/.test(css));
check("prefers-reduced-motion disables the warn-icon animation", /prefers-reduced-motion:[^}]*\.warn-icon\{[^}]*animation:\s*none/.test(css1));
check("blow-line style exists", /\.blow-line\{/.test(css1));
check("blow-line.hot uses the warning color", /\.blow-line\.hot\{/.test(css1));

console.log("wiring: chance text on games and props, icon still on the four surfaces");
var app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
check("gradePill includes the warning icon", /function gradePill\(g\)\{[^}]*warnIcon\(g\)/.test(app.replace(/\n/g, "")));
check("gradeCard includes the warning icon and the chance line", /function gradeCard\(g\)\{[\s\S]*?warnIcon\(g\)[\s\S]*?blowPropLine\(g\)/.test(app));
check("viewSlip includes the warning icon and the chance line", /function viewSlip\(\)\{[\s\S]*?warnIcon\([\s\S]*?blowPropLine\(/.test(app));
check("gpItem uses gradePill and blowPropLine", /function gpItem\(a\)\{[\s\S]*?blowPropLine\([\s\S]*?gradePill\(g\)/.test(app));
check("viewLines uses gradePill and blowPropLine", /function viewLines\(\)\{[\s\S]*?blowPropLine\([\s\S]*?gradePill\(g\)/.test(app));
check("upcoming game cards show the match chance", /function gameCard\(g,full\)\{[\s\S]*?blowGameLine\(g\)/.test(app));
check("live game cards show the match chance", /function liveCard\(g\)\{[\s\S]*?blowGameLine\(g\)/.test(app));
check("started game cards show the match chance", /function startedCard\(m\)\{[\s\S]*?blowGameLine\(/.test(app));
check("Games prop panel header shows the match chance", /function openGP\(id\)\{[\s\S]*?blowGameLine\(g\)/.test(app));
check("live grade() still only sets bait as a flag, not a letter change", /r\.bait=isBait/.test(fs.readFileSync(path.join(__dirname, "..", "model.js"), "utf8")));

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("all ok");
