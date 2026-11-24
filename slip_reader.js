// Slip reader: turn extracted slip picks into matched, graded legs using OUR grader
// (ask_lookup.gradeIntent / GPModel). Gemini is only allowed to extract text from the image.
import { findPlayer, findTeam, findBoardLine, gradeIntent } from "./ask_lookup.js";

const PLAY_GRADES = new Set(["A+", "A", "B", "F"]);

export function periodOf(text) {
  const raw = String(text || "").toLowerCase();
  const s = raw.replace(/[\s_\-]/g, "");
  if (!s) return null;
  if (s.includes("maps12") || s.includes("maps1and2") || s.includes("map1and2") || s.includes("mapsonetwo") || /maps\s*1\s*[&\-to]+\s*2/.test(raw)) return "Maps 1-2";
  if (s === "map1" || (s.includes("map1") && !s.includes("maps12")) || s === "m1") return "Map 1";
  return null;
}

export function parseStat(text) {
  const s = String(text || "").toLowerCase().trim();
  if (!s) return null;
  if (/\b(headshots?|hs|heads?)\b/.test(s) || s === "hs" || s === "headshot" || s === "headshots") return "hs";
  if (/\b(kills?|k)\b/.test(s) || s === "kills" || s === "kill" || s === "k") return "kills";
  return null;
}

export function parseSide(text) {
  const s = String(text || "").toLowerCase().trim();
  if (!s) return null;
  if (/^(u|under|below|less)$/.test(s) || /\bunder\b/.test(s)) return "under";
  if (/^(o|over|above|more)$/.test(s) || /\bover\b/.test(s)) return "over";
  return null;
}

export function parseBook(text) {
  const s = String(text || "").toLowerCase().replace(/\s+/g, "");
  if (!s) return "";
  if (s.includes("underdog") || s === "ud") return "Underdog";
  if (s.includes("prizepicks") || s === "pp") return "PrizePicks";
  return String(text || "").trim();
}

function cleanNum(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function levenshtein(a, b) {
  const s = String(a || ""), t = String(b || "");
  const m = s.length, n = t.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = i - 1, cur = i;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      dp[j] = cur;
      prev = tmp;
    }
  }
  return dp[n];
}

export function fuzzyFindPlayer(store, name, team) {
  const exact = findPlayer(store, name, team || "");
  if (exact) return { player: exact, match: "exact", score: 1 };
  const GM = globalThis.GPModel;
  const k = GM.norm(name);
  if (!k || k.length < 3) return { player: null, match: "none", score: 0 };
  let best = null, bestScore = 0, bestDist = 99;
  const seen = new Set();
  for (const arr of store.index.exact.values()) {
    for (const p of arr) {
      const id = GM.norm(p.name) + "|" + GM.tn(p.team);
      if (seen.has(id)) continue;
      seen.add(id);
      if (team && p.team && !GM.teq(p.team, team) && !GM.tn(p.team).includes(GM.tn(team)) && !GM.tn(team).includes(GM.tn(p.team))) continue;
      const nk = GM.norm(p.name);
      if (!nk) continue;
      const dist = levenshtein(k, nk);
      const score = 1 - dist / Math.max(k.length, nk.length);
      const contain = nk.includes(k) || k.includes(nk);
      const ok = (k.length >= 4 && dist <= 2 && score >= 0.7) || score >= 0.8 || (contain && Math.min(k.length, nk.length) >= 4 && score >= 0.6);
      if (!ok) continue;
      if (score > bestScore || (score === bestScore && dist < bestDist) || (score === bestScore && dist === bestDist && (p.logs || []).length > ((best && best.logs) || []).length)) {
        best = p;
        bestScore = score;
        bestDist = dist;
      }
    }
  }
  if (!best) return { player: null, match: "none", score: 0 };
  return { player: best, match: "fuzzy", score: +bestScore.toFixed(3) };
}

export function normalizePick(raw, defaults) {
  defaults = defaults || {};
  const player = raw && raw.player != null ? String(raw.player).trim() : "";
  const team = raw && raw.team != null ? String(raw.team).trim() : "";
  const opponent = raw && (raw.opponent || raw.opp) != null ? String(raw.opponent || raw.opp).trim() : "";
  const stat = parseStat(raw && raw.stat) || null;
  const period = periodOf(raw && (raw.period || raw.maps || raw.map)) || defaults.period || "Maps 1-2";
  const side = parseSide(raw && (raw.side || raw.pick || raw.direction || raw.over_under));
  const line = cleanNum(raw && raw.line);
  const book = parseBook((raw && raw.book) || defaults.book || "");
  const skip = !player ? "missing player" : (!stat ? "not a CS2 kills or headshots prop" : (line == null ? "missing line" : null));
  return {
    player, team, opponent, stat, period, side, line, book,
    error: skip
  };
}

export function parseExtracted(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const readable = src.readable !== false && src.unreadable !== true;
  const cs2 = src.cs2 !== false && src.is_cs2 !== false;
  const book = parseBook(src.book || src.sportsbook || "");
  const entry = cleanNum(src.entry || src.entry_amount || src.wager);
  const payout = cleanNum(src.payout || src.to_win || src.payout_amount);
  const note = src.note ? String(src.note).trim() : "";
  const rows = Array.isArray(src.picks) ? src.picks : (Array.isArray(src.legs) ? src.legs : []);
  const picks = rows.map((r) => normalizePick(r, { book, period: "Maps 1-2" }));
  return { readable, cs2, book, entry, payout, note, picks };
}

export function matchPick(store, pick) {
  const out = Object.assign({}, pick);
  if (pick.error && pick.error !== "missing line") {
    out.matched = null;
    return out;
  }
  const hit = fuzzyFindPlayer(store, pick.player, pick.team || "");
  if (!hit.player) {
    out.matched = null;
    out.error = "couldn't match this player in our data";
    return out;
  }
  out.matched = { name: hit.player.name, team: hit.player.team, match: hit.match, score: hit.score };
  out.player = hit.player.name;
  out.team = hit.player.team;
  let opp = pick.opponent || "";
  if (opp) {
    const t = findTeam(store, opp);
    if (t) opp = t;
  }
  const board = findBoardLine(store, hit.player, pick.stat === "hs" ? "hs" : "kills", pick.period || "Maps 1-2", opp || null);
  out.board = null;
  if (board) {
    out.board = {
      book: board.book || "",
      line: board.line != null ? +board.line : null,
      opponent: board.opponent || "",
      period: board.period || pick.period,
      odds: board.odds,
      starts_at: board.starts_at || ""
    };
    if (!opp && board.opponent) opp = board.opponent;
    if (!out.book && board.book) out.book = board.book;
    if (out.line == null && board.line != null) {
      out.line = +board.line;
      if (out.error === "missing line") out.error = null;
    }
    if (out.line != null && board.line != null && +out.line !== +board.line) {
      out.boardNote = "board line is " + board.line;
    }
  }
  out.opponent = opp;
  if (!out.error && out.line == null) out.error = "missing line";
  return out;
}

export function isPlayGrade(g) {
  return !!(g && !g.missing && PLAY_GRADES.has(g.grade) && !(g.reasons && g.reasons.length));
}

export function verdictFor(side, g) {
  if (!g || g.missing || !g.pick) return "unknown";
  if (!side) return "unknown";
  const theirs = side === "under" ? "UNDER" : "OVER";
  return g.pick === theirs ? "agree" : "disagree";
}

export function likeLeg(side, g) {
  return verdictFor(side, g) === "agree" && isPlayGrade(g);
}

function edgeForTheirSide(side, g) {
  if (!g || g.missing || g.edgePP == null || isNaN(g.edgePP)) return null;
  const theirs = side === "under" ? "UNDER" : "OVER";
  // edgePP is for OUR pick. If they took the other side, flip it.
  return g.pick === theirs ? g.edgePP : -g.edgePP;
}

export function gradePick(store, pick) {
  const matched = matchPick(store, pick);
  if (matched.error) {
    return {
      pick: matched,
      grade: null,
      verdict: "unknown",
      like: false,
      flags: [],
      error: matched.error
    };
  }
  const g = gradeIntent({
    player: findPlayer(store, matched.player, matched.team) || (matched.matched && findPlayer(store, matched.matched.name, matched.matched.team)),
    stat: matched.stat,
    line: matched.line,
    period: matched.period || "Maps 1-2",
    opp: matched.opponent || "",
    start: matched.board && matched.board.starts_at
  }, store);
  if (!g || g.missing) {
    return {
      pick: matched,
      grade: null,
      verdict: "unknown",
      like: false,
      flags: [],
      error: "couldn't grade this pick with our data"
    };
  }
  const flags = [];
  if (g.bait) flags.push("bait");
  if (g.reasons && g.reasons.length) flags.push("flag");
  const verdict = verdictFor(matched.side, g);
  return {
    pick: matched,
    grade: g,
    verdict,
    like: likeLeg(matched.side, g),
    flags,
    error: null
  };
}

export function gradePicks(store, picks) {
  return (picks || []).map((p) => gradePick(store, normalizePick(p, {})));
}

export function summarizeSlip(results, meta) {
  meta = meta || {};
  const total = results.length;
  const graded = results.filter((r) => r.grade && !r.error);
  const agreed = graded.filter((r) => r.verdict === "agree");
  const disagreed = graded.filter((r) => r.verdict === "disagree");
  const liked = graded.filter((r) => r.like);
  const skipped = results.filter((r) => r.error);
  let weakest = null, weakScore = Infinity;
  for (const r of results) {
    if (r.error) {
      const s = -1000;
      if (s < weakScore) { weakScore = s; weakest = r; }
      continue;
    }
    if (!r.grade) continue;
    const e = edgeForTheirSide(r.pick.side, r.grade);
    const s = e == null ? (r.verdict === "disagree" ? -50 : 0) : e;
    if (s < weakScore) { weakScore = s; weakest = r; }
  }
  const flags = [];
  for (const r of results) {
    const name = (r.pick && (r.pick.player || (r.pick.matched && r.pick.matched.name))) || "a pick";
    if (r.flags && r.flags.indexOf("bait") >= 0) flags.push("bait on " + name);
    if (r.flags && r.flags.indexOf("flag") >= 0) flags.push("filter flag on " + name);
  }
  const weakestText = !weakest ? null : (
    weakest.error
      ? (weakest.pick && weakest.pick.player ? weakest.pick.player : "A pick") + " (" + weakest.error + ")"
      : (weakest.pick.player || "A pick") + " " + (weakest.pick.side ? weakest.pick.side + " " : "") + (weakest.pick.line != null ? weakest.pick.line : "") +
        (weakest.verdict === "disagree" && weakest.grade ? " — Glocky has " + weakest.grade.pick + " at a " + weakest.grade.grade : (weakest.grade ? " — " + weakest.grade.grade : ""))
  );
  return {
    total,
    graded: graded.length,
    agreed: agreed.length,
    disagreed: disagreed.length,
    liked: liked.length,
    skipped: skipped.length,
    weakest: weakestText,
    flags,
    book: meta.book || "",
    entry: meta.entry != null ? meta.entry : null,
    payout: meta.payout != null ? meta.payout : null
  };
}

export function parseGeminiJson(text) {
  let raw = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch (e) { return null; }
}

export const _test = { cleanNum, edgeForTheirSide, PLAY_GRADES };
