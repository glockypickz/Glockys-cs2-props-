// Ask Glocky: parse a question and compute answers from our data only (players.json + Cito
// team_strength.json + live board lines + games). Numbers never come from the language model.
// GPModel (model.js, same v1e code the site uses) must be loaded onto globalThis.GPModel first.

const MAPS = ["ancient", "anubis", "inferno", "mirage", "nuke", "dust2", "vertigo", "overpass", "train", "cache", "italy", "office", "cobblestone"];
const MAP_RE = new RegExp("\\b(dust\\s*2|cobblestone|" + MAPS.filter((m) => m !== "dust2").join("|") + ")\\b", "i");
const STOP = new Set(["the", "a", "an", "on", "of", "for", "vs", "versus", "and", "or", "to", "in", "is", "it", "his", "her", "their", "what", "whats", "what's", "how", "does", "do", "did", "please", "tell", "me", "about", "with", "from", "this", "that", "over", "under", "line", "prop", "maps", "map", "lan", "online", "kills", "kill", "headshots", "headshot", "hs", "percentage", "percent", "avg", "average", "last", "season", "team", "player", "chance", "win", "odds", "rank", "vrs", "world", "grade", "grader", "glocky", "should", "i", "take", "pick"]);

function M() {
  const m = globalThis.GPModel;
  if (!m) throw new Error("GPModel is not loaded");
  return m;
}

function normMap(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/dust2/g, "dust2");
}

function periodOf(text) {
  const s = String(text || "").toLowerCase().replace(/[\s_\-]/g, "");
  if (s.includes("maps12") || s.includes("maps1and2") || s.includes("map1and2") || s.includes("mapsonetwo")) return "Maps 1-2";
  if (s === "map1" || (s.includes("map1") && !s.includes("maps12"))) return "Map 1";
  return null;
}

function parseLine(q) {
  const s = String(q || "");
  const near = s.match(/\b(?:over|under|o\/u|line)\s+(\d{1,3}(?:\.\d{1,2})?)\b/i);
  if (near) return parseFloat(near[1]);
  const dec = s.match(/\b(\d{1,3}\.\d{1,2})\b/);
  if (dec) return parseFloat(dec[1]);
  return null;
}

function parseWindow(q) {
  const s = String(q || "").toLowerCase();
  const m = s.match(/\blast\s*(\d{1,2})\b/);
  if (m) {
    const n = +m[1];
    if (n === 5 || n === 10 || n === 15 || n === 20) return n;
  }
  if (/\b(season|this year|szn|all logged|overall|career in our data)\b/.test(s)) return "szn";
  return null;
}

function parseEv(q) {
  const s = String(q || "").toLowerCase();
  if (/\blan\b/.test(s)) return "lan";
  if (/\bonline\b/.test(s)) return "online";
  return null;
}

function parseStat(q) {
  const s = String(q || "").toLowerCase();
  if (/\b(headshot\s*%|hs\s*%|hs%|headshot\s*percentage|headshot\s*percent|hs\s*percent|hs\s*rate)\b/.test(s)) return "hsp";
  if (/\b(headshots?|hs)\b/.test(s)) return "hs";
  if (/\b(k\/?d|kill\/death)\b/.test(s)) return "kd";
  if (/\badr\b/.test(s)) return "adr";
  if (/\b(kills?\/map|kpr|kills per map)\b/.test(s)) return "kpm";
  if (/\bkills?\b/.test(s)) return "kills";
  if (/\b(vrs|world rank|ranking|rank)\b/.test(s)) return "rank";
  if (/\b(win chance|win probability|odds|moneyline|implied)\b/.test(s)) return "odds";
  if (/\b(pick\s*%|pick rate|veto|ban tendency|map pool|map stats|map chance)/.test(s)) return "maps";
  return null;
}

function isGradeQuestion(q, line) {
  const s = String(q || "").toLowerCase();
  if (/\b(over|under|o\/u|grade this|should i (take|bet|fade)|what do you think of (the )?line)\b/.test(s)) return true;
  if (line != null && /\b(kills?|headshots?|hs|prop|line)\b/.test(s)) return true;
  return false;
}

export function findPlayer(store, name, team) {
  const GM = M();
  const k = GM.norm(name);
  if (!k) return null;
  const ix = store.index;
  let pool = ix.exact.get(k) || [];
  if (team) pool = pool.filter((p) => GM.teq(p.team, team));
  if (pool.length === 1) return pool[0];
  if (pool.length > 1) return pickBest(pool);
  if (k.length < 3) return null;
  const loose = [];
  for (const [nk, arr] of ix.exact) {
    if (nk.includes(k) || k.includes(nk)) {
      for (const p of arr) {
        if (!team || GM.teq(p.team, team)) loose.push(p);
      }
    }
  }
  const uniq = uniquePlayers(loose);
  if (uniq.length === 1) return uniq[0];
  return null;
}

function uniquePlayers(arr) {
  const seen = new Set(), out = [];
  for (const p of arr) {
    const id = M().norm(p.name) + "|" + M().tn(p.team);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  return out;
}

function pickBest(arr) {
  return arr.slice().sort((a, b) => (b.logs || []).length - (a.logs || []).length)[0] || null;
}

function findTeam(store, name) {
  const GM = M();
  const k = GM.tn(name);
  if (!k) return null;
  if (store.teams.has(k)) return store.teams.get(k);
  for (const [tk, label] of store.teams) {
    if (tk.includes(k) || k.includes(tk)) return label;
  }
  return null;
}

function playersInQuestion(store, q) {
  const GM = M();
  const raw = String(q || "");
  const qn = GM.norm(raw);
  const hits = [];
  for (const [nk, arr] of store.index.exact) {
    if (nk.length < 3) continue;
    if (qn.includes(nk)) hits.push({ nk, arr, n: nk.length });
  }
  hits.sort((a, b) => b.n - a.n);
  const picked = [];
  const used = new Set();
  for (const h of hits) {
    if (used.has(h.nk)) continue;
    // skip if this name is a subset of a longer already-picked name
    if (picked.some((p) => p.nk.includes(h.nk) && p.nk !== h.nk)) continue;
    const p = pickBest(h.arr);
    if (p) {
      picked.push({ nk: h.nk, player: p });
      used.add(h.nk);
    }
    if (picked.length >= 3) break;
  }
  return picked.map((x) => x.player);
}

function teamsInQuestion(store, q) {
  const GM = M();
  const qn = GM.norm(q);
  const hits = [];
  for (const [tk, label] of store.teams) {
    if (tk.length < 3) continue;
    if (qn.includes(tk)) hits.push({ tk, label, n: tk.length });
  }
  hits.sort((a, b) => b.n - a.n);
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    if (seen.has(h.label)) continue;
    if (out.some((t) => GM.tn(t).includes(h.tk))) continue;
    out.push(h.label);
    seen.add(h.label);
    if (out.length >= 2) break;
  }
  return out;
}

function parseMap(q) {
  const m = String(q || "").match(MAP_RE);
  if (!m) return null;
  let name = m[1].trim();
  if (/^dust\s*2$/i.test(name)) name = "Dust2";
  return name.replace(/^\w/, (c) => c.toUpperCase()).replace(/dust2/i, "Dust2");
}

export function parseQuestion(q, store) {
  const text = String(q || "").trim();
  const line = parseLine(text);
  const period = periodOf(text) || (isGradeQuestion(text, line) ? "Maps 1-2" : null);
  const ev = parseEv(text);
  const window = parseWindow(text);
  const map = parseMap(text);
  let stat = parseStat(text);
  const players = playersInQuestion(store, text);
  const teams = teamsInQuestion(store, text);
  const player = players[0] || null;
  // opponent: a team that isn't the player's team, or the second team mentioned
  let opp = null;
  if (player) {
    opp = teams.find((t) => !M().teq(t, player.team)) || null;
  } else if (teams.length >= 2) {
    opp = teams[1];
  }
  const team = player ? player.team : (teams[0] || null);
  const grade = isGradeQuestion(text, line) && (player || /[+]/.test(text));
  if (grade && !stat) stat = "kills";
  if (stat === "hs" && grade) stat = "hs";
  let intent = "unknown";
  if (grade && player) intent = "grade";
  else if (stat === "rank" || (/\b(vrs|world rank)\b/i.test(text) && team)) intent = "rank";
  else if (stat === "odds" || (/\b(win chance|odds|map chance)/i.test(text) && team)) intent = "odds";
  else if (stat === "maps" && team) intent = "maps";
  else if (player && (stat || ev || map || window)) intent = "player_stat";
  else if (player) intent = "player_stat";
  else if (team) intent = "team";
  else if (/\b(how do you grade|grader|projection|letter grade|what does a\+|what is a grade)\b/i.test(text)) intent = "method";
  return {
    text, intent, player, players, team, teams, opp, stat, line, period, ev, map, window
  };
}

// Merge a model-parsed JSON object, but only keep values that resolve against our data.
// Numbers already parsed deterministically (line) win if both exist and differ? Deterministic line wins
// if present; otherwise accept a numeric Gemini line.
export function mergeParsedIntent(det, raw, store) {
  if (!raw || typeof raw !== "object") return det;
  const out = Object.assign({}, det);
  if (raw.player && !out.player) {
    const p = findPlayer(store, raw.player, raw.team || "");
    if (p) {
      out.player = p;
      out.team = p.team;
      if (out.intent === "unknown") out.intent = out.line != null ? "grade" : "player_stat";
    }
  }
  if (raw.team && !out.team) {
    const t = findTeam(store, raw.team);
    if (t) out.team = t;
  }
  if (raw.opponent && !out.opp) {
    const t = findTeam(store, raw.opponent);
    if (t) out.opp = t;
  }
  if (raw.stat && !out.stat) {
    const st = parseStat(String(raw.stat));
    if (st) out.stat = st;
  }
  if (out.line == null && raw.line != null && isFinite(+raw.line)) out.line = +raw.line;
  if (!out.period && raw.period) {
    const per = periodOf(String(raw.period)) || (String(raw.period).toLowerCase().includes("map 1") && !String(raw.period).toLowerCase().includes("1-2") ? "Map 1" : null);
    if (per) out.period = per;
  }
  if (!out.ev && (raw.ev === "lan" || raw.ev === "online")) out.ev = raw.ev;
  if (!out.map && raw.map) {
    const mp = parseMap(String(raw.map)) || (MAPS.includes(normMap(raw.map)) ? raw.map : null);
    if (mp) out.map = mp;
  }
  if (!out.window && raw.window) {
    const w = parseWindow("last " + raw.window) || (raw.window === "szn" || raw.window === "season" ? "szn" : null);
    if (w) out.window = w;
  }
  if (out.player && out.line != null && out.intent !== "grade" && isGradeQuestion(out.text + " over " + out.line + " kills", out.line)) {
    out.intent = "grade";
    if (!out.stat) out.stat = "kills";
    if (!out.period) out.period = "Maps 1-2";
  }
  if (raw.intent === "grade" && out.player) {
    out.intent = "grade";
    if (!out.stat) out.stat = "kills";
    if (!out.period) out.period = "Maps 1-2";
  }
  return out;
}

function sortLogs(logs) {
  return logs.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.mid !== b.mid) return String(a.mid) < String(b.mid) ? 1 : -1;
    return (b.n || 0) - (a.n || 0);
  });
}

function filterLogs(p, intent, seasonStart) {
  let logs = sortLogs(p.logs || []);
  if (intent.ev === "lan" || intent.ev === "online") logs = logs.filter((l) => l.ev === intent.ev);
  if (intent.map) logs = logs.filter((l) => normMap(l.map) === normMap(intent.map));
  if (intent.period === "Map 1") logs = logs.filter((l) => l.n === 1);
  if (intent.window === "szn" && seasonStart) logs = logs.filter((l) => (l.date || "") >= seasonStart);
  else if (typeof intent.window === "number") logs = logs.slice(0, intent.window);
  return logs;
}

function sum(rows, key) {
  let s = 0;
  for (const r of rows) s += Number(r[key]) || 0;
  return s;
}

function hsPct(logs) {
  const rows = logs.filter((l) => l.hs != null && l.kills != null);
  const kills = sum(rows, "kills");
  const hs = sum(rows, "hs");
  return { maps: rows.length, kills, hs, hsp: kills ? +(100 * hs / kills).toFixed(2) : null };
}

function kdOf(logs) {
  const rows = logs.filter((l) => l.kills != null && l.d != null);
  const k = sum(rows, "kills"), d = sum(rows, "d");
  return { maps: rows.length, kills: k, deaths: d, kd: d ? +(k / d).toFixed(2) : (k ? k : null) };
}

function adrOf(logs) {
  const rows = logs.filter((l) => l.adr != null);
  if (!rows.length) return { maps: 0, adr: null };
  return { maps: rows.length, adr: +(sum(rows, "adr") / rows.length).toFixed(1) };
}

function avgStat(logs, key) {
  const rows = logs.filter((l) => l[key] != null);
  if (!rows.length) return { maps: 0, avg: null };
  return { maps: rows.length, avg: +(sum(rows, key) / rows.length).toFixed(2) };
}

function seriesOf(store, p, period) {
  return M().series(store.ctx, p, period || "Maps 1-2");
}

function latestRanking(strength, kind) {
  const snaps = ((strength || {}).rankings || {})[kind] || [];
  if (!snaps.length) return null;
  const last = snaps[snaps.length - 1];
  const items = Object.entries(last.points || {}).sort((a, b) => b[1] - a[1]);
  return { date: last.date, items };
}

export function teamRank(store, team, kind) {
  const r = latestRanking(store.strength, kind);
  if (!r || !team) return null;
  const key = M().tn(team);
  const i = r.items.findIndex(([t]) => M().tn(t) === key);
  if (i < 0) return null;
  return { kind, team, rank: i + 1, points: r.items[i][1], of: r.items.length, date: r.date };
}

export function teamMapStats(store, team) {
  const maps = (store.strength || {}).maps || {};
  const key = Object.keys(maps).find((k) => M().teq(k, team));
  if (!key) return null;
  const arr = maps[key] || [];
  const snap = arr[arr.length - 1];
  if (!snap) return null;
  const rows = Object.entries(snap.maps || {}).map(([m, v]) => ({
    map: m, played: v[0], rounds: v[1], pickPct: v[2]
  })).sort((a, b) => (b.pickPct || 0) - (a.pickPct || 0));
  return { team, asof: snap.asof, maps: rows };
}

export function matchOdds(store, team, opp) {
  const rows = (store.strength || {}).odds || [];
  if (!team) return null;
  const hits = [];
  for (const o of rows) {
    const left = M().teq(o.n1, team) && (!opp || M().teq(o.n2, opp));
    const right = M().teq(o.n2, team) && (!opp || M().teq(o.n1, opp));
    if (left || right) hits.push({ o, flip: !!(right && !M().teq(o.n1, team)) });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => String(b.o.start || "") < String(a.o.start || "") ? -1 : 1);
  const { o, flip } = hits[0];
  const p = o.p || [];
  const dec = o.dec || [];
  const map1 = o.map1 || [];
  const map2 = o.map2 || [];
  const i = flip ? 1 : 0, j = flip ? 0 : 1;
  return {
    team: flip ? o.n2 : o.n1,
    opp: flip ? o.n1 : o.n2,
    start: o.start || null,
    src: o.src || "cito",
    win: p[i] != null ? +p[i] : null,
    lose: p[j] != null ? +p[j] : null,
    decWin: dec[i] != null ? +dec[i] : null,
    decLose: dec[j] != null ? +dec[j] : null,
    map1Win: map1[i] != null ? +map1[i] : null,
    map2Win: map2[i] != null ? +map2[i] : null,
    at: o.at || null
  };
}

function findBoardLine(store, player, stat, period, opp) {
  const GM = M();
  const st = stat === "hs" ? "hs" : "kills";
  const per = period || "Maps 1-2";
  const rows = store.lines || [];
  const matches = [];
  for (const l of rows) {
    const lst = /head/i.test(l.stat || "") || String(l.stat || "").toLowerCase() === "hs" ? "hs" : /kill/i.test(l.stat || "") ? "kills" : null;
    if (lst !== st) continue;
    const lp = findPlayer(store, l.player, l.team) || (GM.norm(l.player) === GM.norm(player.name) ? player : null);
    if (!lp || GM.norm(lp.name) !== GM.norm(player.name)) continue;
    if (l.team && player.team && !GM.teq(l.team, player.team) && !GM.teq(lp.team, player.team)) continue;
    const lper = periodOf(l.period || "Maps 1-2") || l.period || "Maps 1-2";
    if (lper !== per) continue;
    if (opp && l.opponent && !GM.teq(l.opponent, opp)) continue;
    matches.push(l);
  }
  return matches[0] || null;
}

function evFor(store, team, opp, start) {
  if (!opp) return [null, null];
  return M().matchEv(store.ctx, team, opp, start || new Date().toISOString(), store.games);
}

export function gradeIntent(intent, store) {
  const p = intent.player;
  if (!p) return { missing: true, reason: "no player" };
  let stat = intent.stat === "hs" ? "hs" : "kills";
  if (intent.stat && intent.stat !== "hs" && intent.stat !== "kills" && intent.stat !== "hsp") {
    // hs% is not a prop line
    if (intent.stat === "hsp") return { missing: true, reason: "hs% is not a prop line" };
  }
  const period = intent.period || "Maps 1-2";
  let line = intent.line, book = "", odds, opp = intent.opp || "", start = "", source = "asked";
  const board = findBoardLine(store, p, stat, period, opp || null);
  if (board) {
    const boardLine = +board.line;
    if (line == null || line === boardLine) {
      line = boardLine;
      book = board.book || "";
      odds = board.odds;
      opp = opp || board.opponent || "";
      start = board.starts_at || "";
      source = "board";
    }
  }
  if (line == null || isNaN(line)) return { missing: true, reason: "no line" };
  const evr = evFor(store, p.team, opp, start || intent.start);
  const m = M().grade(store.ctx, p, stat, line, opp, {
    team: p.team, book, odds, period, ev: evr[0]
  });
  if (!m) return { missing: true, reason: "could not grade" };
  const lan = m.v1 && m.v1.lan && m.v1.lan.used ? { n: m.v1.lan.n, adr: m.v1.lan.adrLan, ev: evr[0] } : null;
  const parts = ((m.v1 && m.v1.parts) || []).map((x) => ({
    label: x.label, w: x.w, v: x.v, n: x.n, nLan: x.nLan
  }));
  const hits = m.hits || null;
  return {
    missing: false,
    source,
    board: board && source === "board" ? { book: board.book, line: +board.line, odds: board.odds, opponent: board.opponent, period: board.period, starts_at: board.starts_at } : (board ? { book: board.book, line: +board.line, note: "board line differs from the line that was asked" } : null),
    player: p.name,
    team: p.team,
    stat,
    line,
    period: m.period || period,
    opp: opp || "",
    book: book || "",
    odds: odds != null ? odds : null,
    start: start || "",
    proj: +(+m.proj).toFixed(1),
    edge: +(+m.edge).toFixed(1),
    grade: m.grade,
    pick: m.pick,
    pOver: m.pOver,
    pPick: m.pPick,
    be: m.be,
    edgePP: m.edgePP,
    reasons: m.reasons || [],
    bait: !!m.bait,
    lan,
    hits,
    parts,
    cap: m.gradeCap || null,
    stake: m.stake,
    model: m.model || "v1e"
  };
}

function pct(x) {
  return x == null || isNaN(x) ? "n/a" : (x * 100).toFixed(1) + "%";
}

function methodFacts() {
  return {
    kind: "method",
    text:
      "Our grader (model v1e) builds a projection as 35% last 10 series, 20% all logged series, 20% head-to-head vs the opponent, 15% vs teams of a similar rank tier, and 10% last 3 series, then a small ADR adjustment capped at 5%. " +
      "The pick is the side with the higher calibrated chance (Over if the projection is at or above the line on a tie). " +
      "The letter comes from the edge versus the book's break-even (American odds when we have them, else PrizePicks 57.7% / Underdog 53%): A+ is +18 points or more, A is +15, B+ is +12, B is +8, C+ is +5, C is +2, D is at or just above break-even, F is below break-even. The same letters are used on Overs and Unders. " +
      "LAN kills props and bait-flagged props (hit the line in each of the last 5 series) are capped at C+ and never get an A or B. Other filters do not change the letter or the pick. " +
      "Map 1 lines are graded on Map 1 only; Maps 1-2 lines are graded on the two-map series. " +
      "LAN matches use the player's LAN games for every input, blended with overall numbers when the LAN sample is thin. " +
      "Head-to-head counts from even one prior meeting (pulled toward the player's normal average when there are few meetings)."
  };
}

function playerStatFacts(intent, store) {
  const p = intent.player;
  if (!p) return { missing: true, reason: "no player in our data" };
  const logs = filterLogs(p, intent, store.seasonStart);
  if (!logs.length) return { missing: true, reason: "no matching maps in our data", player: p.name, team: p.team, ev: intent.ev, map: intent.map, window: intent.window };
  const hs = hsPct(logs);
  const kd = kdOf(logs);
  const adr = adrOf(logs);
  const kills = avgStat(logs, "kills");
  const hsAvg = avgStat(logs, "hs");
  const windowLabel = intent.window === "szn" ? "this season" : (typeof intent.window === "number" ? "last " + intent.window + " maps" : "all matching maps");
  const filterBits = [intent.ev, intent.map, intent.period, windowLabel].filter(Boolean);
  const series = (intent.period || intent.stat === "kills") ? seriesOf(store, p, intent.period || "Maps 1-2") : [];
  let seriesRows = series;
  if (intent.ev) seriesRows = seriesRows.filter((c) => c.ev === intent.ev);
  if (intent.window === "szn" && store.seasonStart) seriesRows = seriesRows.filter((c) => (c.date || "") >= store.seasonStart);
  else if (typeof intent.window === "number") seriesRows = seriesRows.slice(0, intent.window);
  const seriesKills = seriesRows.filter((c) => c.kills != null);
  const seriesHs = seriesRows.filter((c) => c.hs != null);
  const facts = {
    kind: "player_stat",
    missing: false,
    player: p.name,
    team: p.team,
    ev: intent.ev,
    map: intent.map,
    period: intent.period,
    window: intent.window,
    filters: filterBits,
    maps: logs.length,
    hs,
    kd,
    adr,
    kills,
    hsAvg,
    series: {
      period: intent.period || "Maps 1-2",
      n: seriesRows.length,
      avgKills: seriesKills.length ? +(sum(seriesKills, "kills") / seriesKills.length).toFixed(2) : null,
      avgHs: seriesHs.length ? +(sum(seriesHs, "hs") / seriesHs.length).toFixed(2) : null
    },
    ranks: {
      vrs: teamRank(store, p.team, "vrs"),
      world: teamRank(store, p.team, "world")
    }
  };
  return facts;
}

function formatFacts(bundle) {
  const lines = [];
  if (!bundle || bundle.missing) {
    lines.push("DATA STATUS: missing.");
    lines.push("Reason: " + ((bundle && bundle.reason) || "I don't have that in our data") + ".");
    if (bundle && bundle.player) lines.push("Player looked up: " + bundle.player + (bundle.team ? " (" + bundle.team + ")" : "") + ".");
    return lines.join("\n");
  }
  if (bundle.kind === "method") return bundle.text;
  if (bundle.kind === "player_stat") {
    const f = bundle;
    lines.push("Player: " + f.player + " (" + f.team + ").");
    if (f.filters && f.filters.length) lines.push("Filters: " + f.filters.join(", ") + ".");
    lines.push("Sample: " + f.maps + " maps in our data matching those filters.");
    if (f.hs && f.hs.hsp != null) lines.push("Headshot percentage: " + f.hs.hsp.toFixed(2) + "% (" + f.hs.hs + " headshots on " + f.hs.kills + " kills, " + f.hs.maps + " maps with both stats).");
    else lines.push("Headshot percentage: not available for this filter (no maps with both kills and headshots).");
    if (f.kills && f.kills.avg != null) lines.push("Average kills per map: " + f.kills.avg + " (" + f.kills.maps + " maps).");
    if (f.hsAvg && f.hsAvg.avg != null) lines.push("Average headshots per map: " + f.hsAvg.avg + ".");
    if (f.kd && f.kd.kd != null) lines.push("K/D: " + f.kd.kd + " (" + f.kd.kills + " kills, " + f.kd.deaths + " deaths).");
    if (f.adr && f.adr.adr != null) lines.push("ADR: " + f.adr.adr + " (" + f.adr.maps + " maps).");
    if (f.series && f.series.n) {
      lines.push(f.series.period + " series in this filter: " + f.series.n + (f.series.avgKills != null ? ", avg kills " + f.series.avgKills : "") + (f.series.avgHs != null ? ", avg headshots " + f.series.avgHs : "") + ".");
    }
    if (f.ranks && f.ranks.vrs) lines.push("Team VRS rank (Cito, as of " + f.ranks.vrs.date + "): #" + f.ranks.vrs.rank + " (" + f.ranks.vrs.points + " points, of " + f.ranks.vrs.of + ").");
    if (f.ranks && f.ranks.world) lines.push("Team world rank (Cito, as of " + f.ranks.world.date + "): #" + f.ranks.world.rank + " (" + f.ranks.world.points + " points, of " + f.ranks.world.of + ").");
    return lines.join("\n");
  }
  if (bundle.kind === "grade") {
    const g = bundle.grade;
    lines.push("These numbers come from our v1e grader, not from the language model.");
    lines.push("Player: " + g.player + " (" + g.team + ")." + (g.opp ? " Opponent: " + g.opp + "." : ""));
    lines.push("Prop: " + (g.stat === "hs" ? "Headshots" : "Kills") + " " + g.period + ", line " + g.line + (g.book ? " (" + g.book + ")" : "") + ".");
    lines.push("Source of the line: " + (g.source === "board" ? "the live board" : "the line the user asked about") + ".");
    if (g.board && g.source !== "board") lines.push("A different line is also on the board: " + g.board.line + (g.board.book ? " on " + g.board.book : "") + ".");
    lines.push("Projection: " + g.proj + ".");
    lines.push("Pick: " + g.pick + ".");
    lines.push("Letter grade: " + g.grade + ".");
    lines.push("Edge vs line: " + (g.edge >= 0 ? "+" : "") + g.edge + " (" + (g.edgePP >= 0 ? "+" : "") + (+g.edgePP).toFixed(1) + " pp vs break-even " + pct(g.be) + ").");
    lines.push("P(over): " + pct(g.pOver) + ". P(pick): " + pct(g.pPick) + ".");
    if (g.bait) lines.push("Bait flag: yes. He met or beat this line in each of the last 5 " + (g.period === "Map 1" ? "Map 1 maps" : "Maps 1-2 series") + ". Bait props are capped at C+ and never get an A or B.");
    else lines.push("Bait flag: no.");
    if (g.cap && g.cap.applied) lines.push("Letter cap: this grade was capped at " + g.grade + " from " + g.cap.preGrade + " because of " + String(g.cap.reason || "").replace("lan_kills", "a LAN kills prop").replace("bait", "the bait flag") + ".");
    if (g.lan) lines.push("LAN data rule is on: this is graded as a LAN match, using " + g.player + "'s LAN " + (g.period === "Map 1" ? "Map 1s" : "series") + " (" + g.lan.n + " in sample), blended with overall when thin.");
    if (g.parts && g.parts.length) {
      lines.push("Projection mix: " + g.parts.filter((x) => x.v != null).map((x) => x.label + " " + Number(x.v).toFixed(1) + " × " + Number(x.w).toFixed(2)).join("; ") + ".");
    }
    if (g.hits) {
      const fmt = (k, lab) => {
        const v = g.hits[k];
        if (!v) return null;
        return lab + " " + v[0] + "/" + v[1];
      };
      const bits = ["l5", "L5", "l10", "L10", "l20", "L20", "h2h", "H2H", "szn", "SZN"].reduce((a, _, i, arr) => {
        if (i % 2) return a;
        const t = fmt(arr[i], arr[i + 1]);
        return t ? a.concat(t) : a;
      }, []);
      if (bits.length) lines.push("Hit rates vs this line (overs): " + bits.join(", ") + ".");
    }
    if (g.reasons && g.reasons.length) lines.push("Filters (do not change the letter): " + g.reasons.join("; ") + ".");
    if (bundle.context && bundle.context.odds) {
      const o = bundle.context.odds;
      lines.push("Cito match context (not used in the letter): " + o.team + " win chance " + pct(o.win) + " vs " + o.opp + (o.map1Win != null ? ", map 1 chance " + pct(o.map1Win) : "") + (o.map2Win != null ? ", map 2 chance " + pct(o.map2Win) : "") + ".");
    }
    if (bundle.context && bundle.context.maps) {
      const top = bundle.context.maps.maps.slice(0, 5).map((r) => r.map + " pick " + r.pickPct + "% (" + r.played + " played)").join("; ");
      if (top) lines.push("Cito pick tendencies for " + bundle.context.maps.team + " (as of " + bundle.context.maps.asof + "): " + top + ".");
    }
    return lines.join("\n");
  }
  if (bundle.kind === "team" || bundle.kind === "rank" || bundle.kind === "odds" || bundle.kind === "maps") {
    if (bundle.team) lines.push("Team: " + bundle.team + ".");
    if (bundle.vrs) lines.push("VRS rank (Cito, as of " + bundle.vrs.date + "): #" + bundle.vrs.rank + " with " + bundle.vrs.points + " points (of " + bundle.vrs.of + " teams in this snapshot).");
    if (bundle.world) lines.push("World rank (Cito, as of " + bundle.world.date + "): #" + bundle.world.rank + " with " + bundle.world.points + " points (of " + bundle.world.of + ").");
    if (bundle.odds) {
      const o = bundle.odds;
      lines.push("Cito odds vs " + o.opp + " (start " + (o.start || "n/a") + "): win chance " + pct(o.win) + ", decimal " + (o.decWin != null ? o.decWin : "n/a") + ", map 1 " + pct(o.map1Win) + ", map 2 " + pct(o.map2Win) + ".");
    }
    if (bundle.maps && bundle.maps.maps) {
      lines.push("Cito team map stats / pick tendencies as of " + bundle.maps.asof + ": " + bundle.maps.maps.map((r) => r.map + " " + r.played + " maps, pick " + r.pickPct + "%, " + r.rounds + " rounds").join("; ") + ".");
    }
    if (bundle.games && bundle.games.length) {
      lines.push("Upcoming or live games in our slate: " + bundle.games.map((g) => g.team1 + " vs " + g.team2 + " (" + (g.ev || "setting unknown") + ", " + (g.status || "") + ", " + (g.start || "") + ")").join("; ") + ".");
    }
    if (lines.length <= 1) {
      lines.push("DATA STATUS: missing.");
      lines.push("Reason: I don't have that in our data.");
    }
    return lines.join("\n");
  }
  return "DATA STATUS: missing.\nReason: I don't have that in our data.";
}

function teamBundle(intent, store) {
  const team = intent.team || (intent.player && intent.player.team);
  if (!team) return { missing: true, reason: "no team in our data" };
  const games = (store.games || []).filter((g) => M().teq(g.team1, team) || M().teq(g.team2, team)).slice(0, 4);
  const bundle = {
    kind: intent.intent === "rank" ? "rank" : intent.intent === "odds" ? "odds" : intent.intent === "maps" ? "maps" : "team",
    missing: false,
    team,
    vrs: teamRank(store, team, "vrs"),
    world: teamRank(store, team, "world"),
    maps: teamMapStats(store, team),
    odds: matchOdds(store, team, intent.opp),
    games
  };
  if (!bundle.vrs && !bundle.world && !bundle.maps && !bundle.odds && !bundle.games.length) {
    bundle.missing = true;
    bundle.reason = "I don't have that in our data";
  }
  return bundle;
}

export function answerQuestion(question, store, parsed) {
  const intent = parsed || parseQuestion(question, store);
  let bundle;
  if (intent.intent === "method") bundle = Object.assign({ missing: false }, methodFacts());
  else if (intent.intent === "grade") {
    const g = gradeIntent(intent, store);
    if (g.missing) bundle = { missing: true, reason: g.reason, player: intent.player && intent.player.name, team: intent.player && intent.player.team };
    else {
      const ctx = {};
      if (g.opp || intent.opp) ctx.odds = matchOdds(store, g.team, g.opp || intent.opp);
      ctx.maps = teamMapStats(store, g.team);
      bundle = { kind: "grade", missing: false, grade: g, context: ctx };
    }
  } else if (intent.intent === "player_stat") bundle = playerStatFacts(intent, store);
  else if (intent.intent === "rank" || intent.intent === "odds" || intent.intent === "maps" || intent.intent === "team") bundle = teamBundle(intent, store);
  else if (intent.player) bundle = playerStatFacts(intent, store);
  else if (intent.team) bundle = teamBundle(intent, store);
  else bundle = { missing: true, reason: "I don't have that in our data" };

  const grade = bundle && bundle.kind === "grade" && bundle.grade && !bundle.grade.missing ? bundle.grade : null;
  return {
    intent: {
      intent: intent.intent,
      player: intent.player ? intent.player.name : null,
      team: intent.team || (intent.player && intent.player.team) || null,
      opp: intent.opp || null,
      stat: intent.stat,
      line: intent.line,
      period: intent.period,
      ev: intent.ev,
      map: intent.map,
      window: intent.window
    },
    missing: !!(bundle && bundle.missing),
    facts: bundle,
    factText: formatFacts(bundle),
    grade: grade ? {
      player: grade.player,
      team: grade.team,
      stat: grade.stat,
      line: grade.line,
      period: grade.period,
      opp: grade.opp,
      book: grade.book,
      odds: grade.odds,
      start: grade.start,
      pick: grade.pick,
      grade: grade.grade,
      proj: grade.proj,
      edge: grade.edge,
      pOver: grade.pOver,
      pPick: grade.pPick,
      bait: grade.bait,
      lan: !!grade.lan,
      cap: grade.cap || null,
      source: grade.source,
      model: grade.model
    } : null
  };
}

export function makeStore(raw) {
  const GM = M();
  const decoded = GM.decodePlayers(raw.players) || raw.players || {};
  const players = decoded.players || [];
  const ranks = decoded.ranks || {};
  const strength = raw.strength || null;
  const games = (raw.games && raw.games.games) ? raw.games.games : (raw.games || []);
  const lines = (raw.lines && raw.lines.lines) ? raw.lines.lines : (raw.lines || []);
  const ctx = GM.build(players, null, strength, ranks);
  const exact = new Map();
  const teams = new Map();
  for (const p of players) {
    const k = GM.norm(p.name);
    if (!exact.has(k)) exact.set(k, []);
    exact.get(k).push(p);
    if (p.team) {
      const tk = GM.tn(p.team);
      if (tk && !teams.has(tk)) teams.set(tk, p.team);
    }
  }
  // also index Cito team names
  const pts = ((((strength || {}).rankings || {}).vrs || []).slice(-1)[0] || {}).points || {};
  for (const t of Object.keys(pts)) {
    const tk = GM.tn(t);
    if (tk && !teams.has(tk)) teams.set(tk, t);
  }
  for (const g of games) {
    for (const t of [g.team1, g.team2]) {
      const tk = GM.tn(t);
      if (tk && !teams.has(tk)) teams.set(tk, t);
    }
  }
  return {
    players, ranks, strength, ctx, games, lines,
    seasonStart: decoded.season_start || "2026-01-01",
    updated: decoded.updated || null,
    index: { exact },
    teams
  };
}

export const _test = { parseLine, parseWindow, parseEv, parseStat, periodOf, hsPct, filterLogs, findBoardLine, formatFacts, methodFacts, MAPS };
