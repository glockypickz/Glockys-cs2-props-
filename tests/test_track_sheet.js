// Separate post-update track sheet: lock.at cutoff, splits, empty state, Scout shadow.
// Run: node tests/test_track_sheet.js
var S = require("../track_sheet.js");
var failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { failed++; console.log("  FAIL  " + name); }
}

var CUT = S.UPDATE_LIVE_AT; // 2026-11-24T08:09:00+00:00  (2:09 AM CT)
var NOW = Date.parse("2026-11-25T18:00:00+00:00");

function entry(extra) {
  var e = {
    player: "Tester", team: "Fnatic", opponent: "Vitality",
    stat: "Kills", period: "Maps 1-2",
    start: "2026-11-24T16:00:00Z",
    line: 30.5,
    lock: {
      line: 30.5, proj: 32.0, grade: "C", pick: "OVER", model: "v1be",
      at: "2026-11-24T08:10:00+00:00"
    },
    result: { act: 34, outcome: "hit" }
  };
  if (!extra) return e;
  Object.keys(extra).forEach(function (k) {
    if (k === "lock" || k === "result" || k === "shadow_s") {
      e[k] = Object.assign({}, e[k] || {}, extra[k]);
    } else e[k] = extra[k];
  });
  return e;
}

console.log("cutoff");
check("cutoff is the Nov 24 2026 2:09 AM CT deploy in UTC", CUT === "2026-11-24T08:09:00+00:00");
check("empty copy is exact", S.EMPTY === "No picks settled since the update yet");
check("lock at exact cutoff is included", S.isPostUpdateLock(entry({ lock: { at: CUT } })));
check("lock one second before cutoff is excluded", !S.isPostUpdateLock(entry({ lock: { at: "2026-11-24T08:08:59+00:00" } })));
check("CT-local 2:09 AM (no offset treated as UTC) before cutoff is excluded", !S.isPostUpdateLock(entry({ lock: { at: "2026-11-24T02:09:00" } })));
check("lock without at is excluded", !S.isPostUpdateLock(entry({ lock: { at: "" } })));
check("unlocked entry is excluded", !S.isPostUpdateLock({ player: "x", start: "2026-11-24T16:00:00Z" }));
check("lock without grade is excluded", !S.isPostUpdateLock({ lock: { at: CUT, pick: "OVER", line: 1 } }));

console.log("settlement");
var hit = S.fromEntries([entry()], NOW);
check("post-update hit is counted", hit.live.length === 1 && hit.live[0].hit === true);
check("record is 1-0", S.summary(hit.live).record === "1-0" && S.summary(hit.live).hitPct === 100);

var missE = entry({ lock: { pick: "OVER", proj: 32, grade: "C" }, result: { act: 20, outcome: "miss" } });
var miss = S.fromEntries([missE], NOW);
check("miss is counted as a loss", miss.live.length === 1 && miss.live[0].hit === false);
check("avg miss is |proj-act|", Math.abs(S.summary(miss.live).avgMiss - 12) < 1e-9);
check("bias is proj-act", Math.abs(S.summary(miss.live).bias - 12) < 1e-9);

var old = entry({ lock: { at: "2026-11-21T17:41:32+00:00" }, result: { act: 40, outcome: "hit" } });
check("pre-update lock is not in the new sheet", S.fromEntries([old, entry()], NOW).live.length === 1);
check("pre-update only -> no settled rows", S.fromEntries([old], NOW).live.length === 0);

var push = entry({ player: "Pusher", result: { act: 30.5, outcome: "push" } });
var vo = entry({ player: "Voided", result: { outcome: "void" } });
var mixed = S.fromEntries([entry(), push, vo], NOW);
check("pushes and voids are left out of the record", mixed.live.length === 1 && mixed.pushes === 1 && mixed.voids === 1);

var fresh = entry({ start: "2026-11-25T17:30:00Z" }); // 30 min before NOW
check("just-started lock is pending, not settled", S.fromEntries([fresh], NOW).pending === 1 && S.fromEntries([fresh], NOW).live.length === 0);

var wait = entry({ result: null });
delete wait.result;
check("finished with no result is waiting", S.fromEntries([wait], NOW).waiting === 1 && S.fromEntries([wait], NOW).live.length === 0);

console.log("splits");
var rows = S.fromEntries([
  entry({ player: "A", stat: "Kills", period: "Maps 1-2", lock: { ev: "online", proj: 31 }, result: { act: 34, outcome: "hit" } }),
  entry({ player: "B", stat: "Headshots", period: "Maps 1-2", lock: { ev: "lan", pick: "UNDER", grade: "D", proj: 10, line: 11.5 }, line: 11.5, result: { act: 8, outcome: "hit" } }),
  entry({ player: "C", stat: "Kills", period: "Map 1", lock: { ev: "lan", grade: "B", proj: 16, line: 15.5 }, line: 15.5, start: "2026-11-24T18:00:00Z", result: { act: 12, outcome: "miss" } })
], NOW);
var sp = S.splits(rows.live);
check("three settled picks", rows.live.length === 3);
check("Maps 1-2 vs Map 1 split", sp.maps12.length === 2 && sp.map1.length === 1);
check("Kills vs Headshots split", sp.kills.length === 2 && sp.hs.length === 1);
check("LAN data vs not", sp.lan.length === 2 && sp.notLan.length === 1);
check("by letter has C, D, B", (sp.byLetter.C || []).length === 1 && (sp.byLetter.D || []).length === 1 && (sp.byLetter.B || []).length === 1);
check("overall 2-1", S.summary(rows.live).record === "2-1" && S.summary(rows.live).hitPct === 67);

console.log("scout shadow, same period");
var withS = entry({
  shadow_s: { pick: "UNDER", grade: "D", line: 30.5, proj: 28.0 }
});
// live is OVER and hits (act 34); shadow is UNDER and misses
var sh = S.fromEntries([withS, old], NOW);
check("shadow scored only on post-update locks", sh.shadow.length === 1);
check("shadow miss on the same actual", sh.shadow[0].hit === false && sh.live[0].hit === true);
check("shadow avg miss uses shadow proj", Math.abs(S.summary(sh.shadow).avgMiss - 6) < 1e-9);

var skipS = entry({ shadow_s: { skipped: "thin" } });
check("skipped shadow is not counted", S.fromEntries([skipS], NOW).shadow.length === 0);

var pushShadow = entry({
  result: { act: 34, outcome: "hit" },
  shadow_s: { pick: "OVER", grade: "C", line: 34, proj: 33 }
});
check("shadow push (act equals shadow line) is left out", S.fromEntries([pushShadow], NOW).shadow.length === 0 && S.fromEntries([pushShadow], NOW).live.length === 1);

console.log("dedupe");
var dupA = entry({ player: "Same", book: "PrizePicks" });
var dupB = entry({ player: "Same", book: "Underdog", lock: { at: "2026-11-24T09:00:00+00:00", proj: 99 } });
// lockFirstPost prefers post-update locks by file order among them; first in file wins
var dups = S.fromEntries([dupA, dupB], NOW);
check("one row per player/stat/day/period", dups.live.length === 1);
check("first locked entry wins", dups.live[0].proj === 32);

console.log("html");
var emptyHtml = S.html(S.fromEntries([old], NOW));
check("empty state uses the exact sentence", emptyHtml.indexOf("No picks settled since the update yet") > -1);
check("empty state still has the title and explanation", emptyHtml.indexOf("Track record since the update") > -1 && emptyHtml.indexOf("lock.at") > -1);
var filled = S.html(rows);
check("filled sheet shows record and splits", filled.indexOf("2-1") > -1 && filled.indexOf("Maps 1-2 vs Map 1") > -1 && filled.indexOf("LAN data vs not") > -1 && filled.indexOf("Kills vs Headshots") > -1 && filled.indexOf("By letter") > -1);
check("filled sheet includes Scout shadow heading", filled.indexOf("Scout shadow") > -1);
check("empty does not include a 0-0 record block as the headline", emptyHtml.indexOf("Projection bias") === -1);

console.log("current Track Record is a separate card");
check("module does not export recordCard", S.recordCard == null && S.recordData == null);

if (failed) {
  console.log("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nall passed");
