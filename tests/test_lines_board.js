// Live board empty state + 3-hour safety net.
// Run: node tests/test_lines_board.js
var B = require("../lines_board.js");
var failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { failed++; console.log("  FAIL  " + name); }
}

var now = Date.parse("2026-11-24T08:30:00Z");

console.log("3-hour safety net");
check("upcoming line stays", B.isCurrentBoardLine({ starts_at: "2026-11-24T10:00:00Z" }, now) === true);
check("just started stays (within grace)", B.isCurrentBoardLine({ start: "2026-11-24T08:00:00Z" }, now) === true);
check("2h59 after start stays", B.isCurrentBoardLine({ starts_at: "2026-11-24T05:31:00Z" }, now) === true);
check("3h after start is hidden", B.isCurrentBoardLine({ starts_at: "2026-11-24T05:30:00Z" }, now) === false);
check("finished yesterday is hidden", B.isCurrentBoardLine({ starts_at: "2026-11-21T20:39:00Z" }, now) === false);
check("missing start stays", B.isCurrentBoardLine({ player: "x" }, now) === true);
check("visibleFeedLines drops only stale", B.visibleFeedLines([
  { starts_at: "2026-11-24T10:00:00Z" },
  { starts_at: "2026-11-21T20:39:00Z" }
], now).length === 1);

console.log("empty board message");
var emptyFeed = {
  observed_at: "2026-11-24T08:18:00+00:00",
  fetched_by_job_at: "2026-11-24T08:18:00+00:00",
  fetched_at: "2026-11-24T08:18:00+00:00",
  source: "kashrock",
  empty: true,
  status: "no_lines_up",
  lines: []
};
check("hasFeed for empty marker", B.hasFeed(emptyFeed) === true);
check("isEmptyBoard for empty marker", B.isEmptyBoard(emptyFeed, [], now) === true);
check("message 12 min ago", B.emptyMessage(emptyFeed, now) === "No lines are up right now — last checked 12 min ago");
check("just now under 45s", B.checkedAgo("2026-11-24T08:29:30Z", now) === "just now");
check("1 min ago", B.checkedAgo("2026-11-24T08:29:00Z", now) === "1 min ago");
check("3 hr ago", B.checkedAgo("2026-11-24T05:30:00Z", now) === "3 hr ago");
check("3 days ago", B.checkedAgo("2026-11-21T08:30:00Z", now) === "3 days ago");

var staleOld = {
  observed_at: "2026-11-21T20:39:46+00:00",
  fetched_by_job_at: "2026-11-21T20:39:46+00:00",
  source: "kashrock",
  stale: true,
  stale_at: "2026-11-24T08:18:00+00:00",
  lines: [{ player: "Umar", starts_at: "2026-11-22T03:00:00Z", stat: "Kills", line: 30.5, book: "PrizePicks" }]
};
check("stale Nov 21 lines count as empty after grace", B.isEmptyBoard(staleOld, staleOld.lines, now) === true);
check("uses last successful check, not stale_at", B.lastCheckedIso(staleOld) === "2026-11-21T20:39:46+00:00");
check("prefers fetched_by_job_at", B.lastCheckedIso(emptyFeed) === "2026-11-24T08:18:00+00:00");
check("no feed is not an empty board", B.isEmptyBoard(null, [], now) === false);
check("hasFeed false for null", B.hasFeed(null) === false);

if (failed) { console.log(failed + " failed"); process.exit(1); }
console.log("all ok");
