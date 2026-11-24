/** Display-only warning icon for bait and blowout-risk props.
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
 *  Threshold: the icon is shown when that predicted chance is >= 30% per map
 *  (BLOWOUT_RISK_THRESHOLD = 0.30). Even matches sit around 24% and are not
 *  flagged; about a 70/30 Elo favorite crosses 30%.
 *
 *  When a saved shadow_s.blowout object is passed in, those p_win / p_loss
 *  values are used. Otherwise the same blow_probs formula is applied to the
 *  Elo win chance so the warning still works without admin history.
 */
(function (root) {
  var BLOWOUT_RISK_THRESHOLD = 0.30;
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

  function flags(g, opts) {
    opts = opts || {};
    var bait = !!(g && g.bait);
    var source = null, p_win = null, p_loss = null, risk = null;
    var shadow = opts.shadow || (g && g.blowout) || null;
    var fromShadow = riskFromShadow(shadow);
    if (fromShadow != null) {
      risk = fromShadow;
      p_win = +shadow.p_win;
      p_loss = +shadow.p_loss;
      source = "shadow";
    } else if (opts.winp != null && !isNaN(+opts.winp)) {
      var bp = blowProbs(+opts.winp);
      risk = bp.p;
      p_win = bp.p_win;
      p_loss = bp.p_loss;
      source = "elo";
    }
    var blowout = isBlowout(risk);
    var title = tooltip({ bait: bait, blowout: blowout, risk: risk, period: (g && g.period) || opts.period });
    return { bait: bait, blowout: blowout, risk: risk, p_win: p_win, p_loss: p_loss, source: source, title: title, show: bait || blowout };
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
      var pct = Math.round(100 * f.risk);
      bits.push("Blowout: predicted blowout chance " + pct + "% per map (a 13-5 or wider score). This warning shows when that chance is 30% or more.");
    }
    return bits.join(" ");
  }

  function icon(g, opts) {
    var f = flags(g, opts);
    if (!f.show) return "";
    var t = esc(f.title);
    return ' <span class="warn-icon" title="' + t + '" role="img" aria-label="' + t + '">⚠️</span>';
  }

  var api = {
    BLOWOUT_RISK_THRESHOLD: BLOWOUT_RISK_THRESHOLD,
    BW_C: BW_C,
    BL_C: BL_C,
    blowProbs: blowProbs,
    riskFromShadow: riskFromShadow,
    isBlowout: isBlowout,
    flags: flags,
    tooltip: tooltip,
    icon: icon
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GPWarn = api;
})(typeof window !== "undefined" ? window : this);
