/** Live board freshness for lines.json.
 *  Used by the Lines, Games, dashboard, and slip views (app.js). Keep this file free of DOM and of app state.
 *
 *  After a successful empty KashRock pull, lines.json has status "no_lines_up" and lines: [].
 *  As a safety net, any prop whose match started more than BOARD_GRACE_MS ago is hidden even if it is still in the file.
 *  Locked grades and lines_history.json are not affected: those live in other files.
 */
(function (root) {
  var BOARD_GRACE_MS = 3 * 60 * 60 * 1000;

  function parseTime(iso) {
    if (iso == null || iso === "") return NaN;
    var t = Date.parse(iso);
    return t;
  }

  function isCurrentBoardLine(l, now) {
    now = now != null ? now : Date.now();
    var raw = l && (l.starts_at || l.start);
    var t = parseTime(raw);
    if (!isFinite(t)) return true;
    return now < t + BOARD_GRACE_MS;
  }

  function visibleFeedLines(lines, now) {
    return (lines || []).filter(function (l) { return isCurrentBoardLine(l, now); });
  }

  function lastCheckedIso(feed) {
    if (!feed || typeof feed !== "object") return "";
    return feed.fetched_by_job_at || feed.fetched_at || feed.observed_at || feed.stale_at || "";
  }

  function hasFeed(feed) {
    if (!feed || typeof feed !== "object") return false;
    return !!(lastCheckedIso(feed) || feed.empty || feed.status || feed.source === "kashrock" || ((feed.lines || []).length));
  }

  function isEmptyBoard(feed, lines, now) {
    if (!hasFeed(feed)) return false;
    var rows = lines != null ? lines : (feed.lines || []);
    return visibleFeedLines(rows, now).length === 0;
  }

  function checkedAgo(iso, now) {
    now = now != null ? now : Date.now();
    var t = parseTime(iso);
    if (!isFinite(t)) return "just now";
    var sec = Math.max(0, Math.round((now - t) / 1000));
    if (sec < 45) return "just now";
    var min = Math.round(sec / 60);
    if (min < 60) return min + " min ago";
    var hr = Math.round(min / 60);
    if (hr < 48) return hr + " hr ago";
    var days = Math.round(hr / 24);
    return days + " day" + (days === 1 ? "" : "s") + " ago";
  }

  function emptyMessage(feed, now) {
    return "No lines are up right now — last checked " + checkedAgo(lastCheckedIso(feed), now);
  }

  var api = {
    BOARD_GRACE_MS: BOARD_GRACE_MS,
    parseTime: parseTime,
    isCurrentBoardLine: isCurrentBoardLine,
    visibleFeedLines: visibleFeedLines,
    lastCheckedIso: lastCheckedIso,
    hasFeed: hasFeed,
    isEmptyBoard: isEmptyBoard,
    checkedAgo: checkedAgo,
    emptyMessage: emptyMessage
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GPBoard = api;
})(typeof window !== "undefined" ? window : this);
