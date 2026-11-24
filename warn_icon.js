/** Display-only bait / blowout warning for customers.
 *  Does not change the projection, letter, pick, filters, or any locked grade.
 *
 *  Bait: the grade's existing bait flag (last 5 series / Map 1 maps all met or
 *  beat the line). Same flag the Insights tab uses for "Why Glocky thinks it's bait".
 *
 *  Blowout: predicted per-map blowout chance from the Scout shadow context
 *  (PR 30 / scout_model.blow_probs). A blowout is a map won or lost 13-5 or
 *  worse (8+ rounds). Chance = P(blowout win) + P(blowout loss), from the
 *  Elo win chance and the fitted sigmoid coefficients in scout_params.json
 *  (hyper.bw_c / hyper.bl_c).
 *
 *  The predicted chance is always shown as visible text when it can be
 *  computed, e.g. "Blowout risk 34% per map · FaZe favored" (the side more
 *  likely to win big). A 48-52% Elo split is labeled "even match".
 *
 *  Threshold: the pulsing ⚠️ and the BLOWOUT tag (like the BAIT tag) are shown when that
 *  predicted chance is >= 30% per map (BLOWOUT_RISK_THRESHOLD = 0.30). Even matches sit around 24% and
 *  are not flagged; about a 70/30 Elo favorite crosses 30%.
 *
 *  When a saved shadow_s.blowout object is passed in, those p_win / p_loss
 *  values are used. Otherwise the same blow_probs formula is applied to the
 *  Elo win chance so customers see the warning without admin history.
 */
(function (root) {
  var BLOWOUT_RISK_THRESHOLD = 0.30;
  // Elo win-chance dead zone: 48-52% is treated as an even match.
  var EVEN_BAND = 0.02;
  // Fitted hyper from scout_params.json (Scout / PR 30). Keep in sync if refit.
  var BW_C = [-1.9089, 4.3319, -0.859];
  var BL_C = [-2.049, -4.3101, -1.0044];

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function periodUnit(period) {
    return period === "Map 1" ? "Map 1 maps" : "Maps 1-2 series";
  }

  function sig(c, d) {
    var z = c[0] + c[1] * d + c[2] * d * d;
    return 1 / (1 + Math.exp(-z));
  }

  function blowProbs(pw) {
    var d = (pw == null || isNaN(pw) ? 0.5 : +pw) - 0.5;
    var bw = sig(BW_C, d), bl = sig(BL_C, d);
    if (bw + bl > 0.95) {
      var f = 0.95 / (bw + bl);
      bw *= f;
      bl *= f;
    }
    return { p_win: bw, p_loss: bl, p: bw + bl };
  }

  function riskFromShadow(bo) {
    if (!bo || bo.p_win == null || bo.p_loss == null) return null;
    var p = +bo.p_win + +bo.p_loss;
    return isNaN(p) ? null : p;
  }

  function isBlowout(risk) {
    return risk != null && !isNaN(risk) && risk >= BLOWOUT_RISK_THRESHOLD;
  }

  // Side most likely to win big. `team` is the reference side for winp / p_win.
  function favoredName(team, opp, pw, p_win, p_loss) {
    if (pw != null && !isNaN(+pw)) {
      if (Math.round(Math.abs(+pw - 0.5) * 100) <= Math.round(EVEN_BAND * 100)) return null;
      return +pw > 0.5 ? (team || null) : (opp || null);
    }
    if (p_win != null && p_loss != null && !isNaN(+p_win) && !isNaN(+p_loss)) {
      if (+p_win - +p_loss >= EVEN_BAND) return team || null;
      if (+p_loss - +p_win >= EVEN_BAND) return opp || null;
    }
    return null;
  }

  function chanceLabel(risk, favored) {
    if (risk == null || isNaN(risk)) return "";
    var s = "Blowout risk " + Math.round(100 * risk) + "% per map";
    if (favored) s += " · " + favored + " favored";
    else s += " · even match";
    return s;
  }

  function predict(opts) {
    opts = opts || {};
    var source = null, p_win = null, p_loss = null, risk = null;
    var pw = opts.winp != null && !isNaN(+opts.winp) ? +opts.winp : null;
    var shadow = opts.shadow || null;
    var fromShadow = riskFromShadow(shadow);
    if (fromShadow != null) {
      risk = fromShadow;
      p_win = +shadow.p_win;
      p_loss = +shadow.p_loss;
      source = "shadow";
    } else if (pw != null) {
      var bp = blowProbs(pw);
      risk = bp.p;
      p_win = bp.p_win;
      p_loss = bp.p_loss;
      source = "elo";
    }
    var favored = favoredName(opts.team, opts.opp, pw, p_win, p_loss);
    var flagged = isBlowout(risk);
    return {
      risk: risk, p_win: p_win, p_loss: p_loss, winp: pw, source: source,
      favored: favored, flagged: flagged, text: chanceLabel(risk, favored)
    };
  }

  function flags(g, opts) {
    opts = opts || {};
    var bait = !!(g && g.bait);
    var p = predict({
      shadow: opts.shadow || (g && g.blowout) || null,
      winp: opts.winp,
      team: opts.team || (g && g.team) || null,
      opp: opts.opp || (g && g.opp) || null
    });
    var title = tooltip({
      bait: bait, blowout: p.flagged, risk: p.risk,
      period: (g && g.period) || opts.period, text: p.text
    });
    return {
      bait: bait, blowout: p.flagged, risk: p.risk, p_win: p.p_win, p_loss: p.p_loss,
      source: p.source, favored: p.favored, text: p.text, title: title,
      show: bait || p.flagged
    };
  }

  function tooltip(f) {
    if (!f.bait && !f.blowout) return "";
    var bits = [];
    if (f.bait && f.blowout) bits.push("Flagged as bait and as blowout risk.");
    else if (f.bait) bits.push("Flagged as bait.");
    else bits.push("Flagged as blowout risk.");
    if (f.bait) {
      bits.push("Bait: he met or beat this line in each of the last 5 " + periodUnit(f.period) + ".");
    }
    if (f.blowout) {
      bits.push("Blowout: predicted blowout chance " + Math.round(100 * f.risk) + "% per map (a 13-5 or wider score). This warning icon shows when that chance is 30% or more.");
    }
    return bits.join(" ");
  }

  function icon(g, opts) {
    var f = flags(g, opts);
    if (!f.show) return "";
    var t = esc(f.title);
    return ' <span class="warn-icon" title="' + t + '" role="img" aria-label="' + t + '">⚠️</span>';
  }

  // Text tag like BAIT, shown when blowout risk is at or above the threshold. Display only.
  function badge(g, opts) {
    var f = flags(g, opts);
    if (!f.blowout) return "";
    var t = esc(f.text + ". A blowout is a map won 13-5 or wider. This tag shows at " + Math.round(100 * BLOWOUT_RISK_THRESHOLD) + "% or more per map. It never changes the grade or pick.");
    return ' <span class="pill blow" title="' + t + '">BLOWOUT</span>';
  }

  // Yes/no tag for the Games tab: BLOWOUT EXPECTED at the threshold, NO BLOWOUT EXPECTED below it. Display only.
  function verdict(p) {
    if (!p || p.risk == null || isNaN(p.risk)) return "";
    var yes = !!p.flagged;
    var t = esc(p.text + ". A blowout is a map won 13-5 or wider. This reads BLOWOUT EXPECTED at " + Math.round(100 * BLOWOUT_RISK_THRESHOLD) + "% or more per map. It never changes a grade or pick.");
    return '<span class="pill blow-verdict ' + (yes ? "blow" : "calm") + '" title="' + t + '">' + (yes ? "BLOWOUT EXPECTED" : "NO BLOWOUT EXPECTED") + "</span> ";
  }

  function lineHtml(p, withIcon, withVerdict) {
    if (!p || !p.text) return "";
    var cls = "blow-line" + (p.flagged ? " hot" : "");
    var ic = "";
    if (withIcon && p.flagged) {
      var t = esc(p.text);
      ic = ' <span class="warn-icon" title="' + t + '" role="img" aria-label="' + t + '">⚠️</span>';
    }
    return '<div class="' + cls + '">' + (withVerdict ? verdict(p) : "") + esc(p.text) + ic + '</div>';
  }

  function gameLine(p) { return lineHtml(p, true, true); }
  function propLine(p) { return lineHtml(p, false); }

  var api = {
    BLOWOUT_RISK_THRESHOLD: BLOWOUT_RISK_THRESHOLD,
    EVEN_BAND: EVEN_BAND,
    BW_C: BW_C,
    BL_C: BL_C,
    blowProbs: blowProbs,
    riskFromShadow: riskFromShadow,
    isBlowout: isBlowout,
    favoredName: favoredName,
    chanceLabel: chanceLabel,
    predict: predict,
    flags: flags,
    tooltip: tooltip,
    icon: icon,
    badge: badge,
    verdict: verdict,
    gameLine: gameLine,
    propLine: propLine
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GPWarn = api;
})(typeof window !== "undefined" ? window : this);
