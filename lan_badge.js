/** LAN / ONLINE badge for the Games tab (and Lines rows).
 *  Uses the ev already stored on games.json (PR 32: tournament event_type,
 *  then season_state.json by tournament id, then the match-detail fetch).
 *  If a game has no ev but other games with the same tournament_id all agree
 *  on lan or online, that value is used. Unknown stays unknown: no 3-day
 *  recent-maps fallback, no name guessing. Show nothing when unknown.
 */
(function (root) {
  function evOf(g) {
    var e = g && g.ev;
    return e === "lan" || e === "online" ? e : null;
  }

  function evByTournament(games) {
    var map = {};
    (games || []).forEach(function (g) {
      if (g == null || g.tournament_id == null || g.tournament_id === "") return;
      var e = evOf(g);
      if (!e) return;
      var k = String(g.tournament_id);
      if (!Object.prototype.hasOwnProperty.call(map, k)) map[k] = e;
      else if (map[k] && map[k] !== e) map[k] = null;
    });
    return map;
  }

  function setting(g, games) {
    var e = evOf(g);
    if (e) return e;
    if (!g || g.tournament_id == null || g.tournament_id === "") return null;
    if (!games || !games.length) return null;
    var v = evByTournament(games)[String(g.tournament_id)];
    return v === "lan" || v === "online" ? v : null;
  }

  function label(ev) {
    return ev === "lan" ? "LAN" : ev === "online" ? "ONLINE" : "";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function badge(g, games) {
    var ev = setting(g, games);
    if (!ev) return "";
    var title = ev === "lan" ? "This match is on LAN" : "This match is online";
    return ' <span class="pill ev ' + ev + '" title="' + esc(title) + '">' + label(ev) + "</span>";
  }

  function normTeam(s, tnFn) {
    if (tnFn) return tnFn(s);
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function dayOf(iso, dayFn) {
    if (dayFn) return dayFn(iso);
    return String(iso || "").slice(0, 10);
  }

  function gameKey(row, tnFn, dayFn) {
    var a = normTeam(row && (row.team || row.team1) || "", tnFn);
    var b = normTeam(row && (row.opponent || row.opp || row.team2) || "", tnFn);
    var day = dayOf(row && (row.start || row.starts_at) || "", dayFn);
    return [a, b].sort().join("|") + "|" + day;
  }

  function findGame(line, games, opts) {
    opts = opts || {};
    if (!line || !games || !games.length) return null;
    var k = gameKey(line, opts.tn, opts.day);
    var i, g;
    for (i = 0; i < games.length; i++) {
      g = games[i];
      if (gameKey({ team: g.team1, opponent: g.team2, start: g.start }, opts.tn, opts.day) === k) return g;
    }
    return null;
  }

  function badgeForLine(line, games, opts) {
    return badge(findGame(line, games, opts), games);
  }

  var api = {
    evOf: evOf,
    evByTournament: evByTournament,
    setting: setting,
    label: label,
    badge: badge,
    gameKey: gameKey,
    findGame: findGame,
    badgeForLine: badgeForLine
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GPLan = api;
})(typeof window !== "undefined" ? window : this);
