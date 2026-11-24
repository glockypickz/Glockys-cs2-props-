/** Community Wins tab: clients post their own slip screenshots.
 *  This is not the grader Track Record and never reads lines_history.json.
 *  The feed comes from GET /wins/feed (Worker). Images are /wins/img/<id>.
 */
(function (root) {
  "use strict";
  var state = { posts: [], me: { user: null, admin: false }, remaining: 0, dailyLimit: 5, setup: true, error: "", loaded: false, adminView: false, testBanner: false };
  var fileHold = null, previewUrl = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function fmt(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(d).replace(",", " •").replace(/,/, "") + " CT";
  }
  function toast(m) {
    if (typeof root.toast === "function") return root.toast(m);
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = m; t.classList.remove("hide");
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.add("hide"); }, 2600);
  }

  function cardHtml(p, admin) {
    var h = '<article class="win-card' + (p.featured ? " featured" : "") + (p.hidden ? " hidden" : "") + '" data-id="' + esc(p.id) + '">';
    if (p.featured) h += '<div class="win-pin">Pinned</div>';
    if (p.hidden) h += '<div class="win-hidden-tag">Hidden</div>';
    h += '<div class="win-shot"><img src="' + esc(p.image) + '" alt="Slip posted by ' + esc(p.user) + '" loading="lazy"></div>';
    h += '<div class="win-body"><div class="win-top"><span class="pill win-pill">WIN</span>';
    if (p.payout) h += '<span class="win-payout">' + esc(p.payout) + '</span>';
    h += '</div>';
    h += '<div class="win-meta"><b>' + esc(p.user) + '</b> · ' + esc(fmt(p.at)) + '</div>';
    if (p.caption) h += '<p class="win-cap">' + esc(p.caption) + '</p>';
    if (p.picks) h += '<div class="win-picks">' + esc(p.picks) + '</div>';
    if (admin) {
      h += '<div class="win-admin btns">';
      h += '<button type="button" class="g" data-wins="feature" data-id="' + esc(p.id) + '" data-on="' + (p.featured ? "0" : "1") + '">' + (p.featured ? "Unpin" : "Pin") + '</button>';
      h += '<button type="button" class="g" data-wins="hide" data-id="' + esc(p.id) + '" data-on="' + (p.hidden ? "0" : "1") + '">' + (p.hidden ? "Unhide" : "Hide") + '</button>';
      h += '<button type="button" class="g" data-wins="delete" data-id="' + esc(p.id) + '">Delete</button>';
      h += '</div>';
    }
    h += '</div></article>';
    return h;
  }

  function formHtml() {
    if (!state.setup) return '<div class="card"><h2>Wins</h2><div class="warn">The Wins board isn\'t set up yet.</div></div>';
    if (!state.me.user) return '<div class="card"><h2>Submit a win</h2><div class="muted">Sign in to post a slip screenshot. This board is for your wins, not the grader track record.</div></div>';
    var left = state.remaining;
    var h = '<div class="card" id="win-form-card"><h2>Submit a win</h2>';
    h += '<div class="muted">Post a screenshot of your own hit slip. PNG, JPG, or WebP, up to 5 MB. You can add a caption, the picks, and a payout if you want.</div>';
    h += '<form id="win-form" class="win-form" action="javascript:void(0)">';
    h += '<label>Slip screenshot</label><input id="win-photo" type="file" accept="image/png,image/jpeg,image/webp,image/jpg" required>';
    h += '<div id="win-preview" class="win-preview' + (previewUrl ? "" : " hide") + '">' + (previewUrl ? '<img src="' + esc(previewUrl) + '" alt="Preview">' : "") + '</div>';
    h += '<label>Caption <span class="muted">(optional)</span></label><textarea id="win-caption" maxlength="280" rows="2" placeholder="How it hit, the book, anything you want to share"></textarea>';
    h += '<label>Picks <span class="muted">(optional)</span></label><input id="win-picks" maxlength="400" placeholder="e.g. donk Over 25.5 kills · m0NESY Under 18.5 HS">';
    h += '<label>Payout <span class="muted">(optional)</span></label><input id="win-payout" maxlength="40" placeholder="e.g. $80 or 12x">';
    h += '<div class="btns"><button type="submit" class="b" id="win-go" data-wins="submit"' + (left <= 0 ? " disabled" : "") + '>Post win</button></div>';
    h += '<div class="muted" id="win-left">' + (left <= 0 ? "You can post 5 wins per day. Try again tomorrow." : left + " of " + state.dailyLimit + " posts left today.") + '</div>';
    h += '</form></div>';
    return h;
  }

  function feedHtml() {
    var posts = state.posts || [];
    var h = '<div class="card" id="win-feed-card"><h2>Community wins</h2>';
    h += '<div class="muted" style="margin-bottom:8px">Slips posted by signed-in users. This is not the grader track record.</div>';
    if (state.me.admin) {
      h += '<div class="btns" style="margin-bottom:8px"><button type="button" class="' + (state.adminView ? "b" : "g") + '" data-wins="adminview" data-on="' + (state.adminView ? "0" : "1") + '">' + (state.adminView ? "Showing hidden posts" : "Show hidden posts") + '</button></div>';
    }
    if (state.error) h += '<div class="warn">' + esc(state.error) + '</div>';
    if (!state.loaded) h += '<div class="muted">Loading wins…</div>';
    else if (!posts.length && !state.error) h += '<div class="muted">No community wins yet. Be the first to post a slip.</div>';
    else h += '<div class="win-feed">' + posts.map(function (p) { return cardHtml(p, !!state.me.admin); }).join("") + '</div>';
    h += '</div>';
    return h;
  }

  function bannerHtml() {
    if (!state.testBanner) return "";
    return '<div class="win-test-banner" role="status">TEST DATA — not live community posts</div>';
  }

  function html() {
    return '<div id="wins-root">' + bannerHtml() + formHtml() + feedHtml() + '</div>';
  }

  function setPreview(file) {
    if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch (e) {} previewUrl = null; }
    fileHold = file || null;
    if (file) previewUrl = URL.createObjectURL(file);
    var box = document.getElementById("win-preview");
    if (!box) return;
    if (previewUrl) { box.classList.remove("hide"); box.innerHTML = '<img src="' + previewUrl + '" alt="Preview">'; }
    else { box.classList.add("hide"); box.innerHTML = ""; }
  }

  function afterRender() {
    var inp = document.getElementById("win-photo");
    if (inp && !inp._bound) {
      inp._bound = true;
      inp.addEventListener("change", function () { setPreview(inp.files && inp.files[0]); });
    }
    var form = document.getElementById("win-form");
    if (form && !form._bound) {
      form._bound = true;
      form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
    }
    if (fileHold && inp) {
      // Can't restore the FileList; keep the preview visible so the user sees they already picked a file.
      if (previewUrl) {
        var box = document.getElementById("win-preview");
        if (box) { box.classList.remove("hide"); box.innerHTML = '<img src="' + previewUrl + '" alt="Preview">'; }
      }
    }
  }

  function load(cb) {
    var q = state.adminView ? "?admin=1" : "";
    fetch("/wins/feed" + q, { cache: "no-store", credentials: "include" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
    }).then(function (x) {
      state.loaded = true;
      if (x.status === 401) { state.error = "Sign in to see community wins."; state.posts = []; state.setup = true; }
      else if (x.d && x.d.setup === false) { state.setup = false; state.posts = []; state.error = x.d.error || "The Wins board isn't set up yet."; }
      else if (!x.ok) { state.error = (x.d && x.d.error) || "Could not load wins."; state.posts = []; }
      else {
        state.setup = true; state.error = "";
        state.posts = x.d.posts || [];
        state.me = x.d.me || state.me;
        state.dailyLimit = x.d.dailyLimit || 5;
        state.remaining = x.d.remaining == null ? state.remaining : x.d.remaining;
      }
      if (cb) cb();
    }).catch(function () {
      state.loaded = true;
      state.setup = false;
      state.posts = [];
      state.error = "The Wins board lives on the live site. Sign in there to post and see community wins.";
      if (cb) cb();
    });
  }

  function refresh() {
    load(function () {
      var root = document.getElementById("wins-root");
      if (!root) return;
      root.innerHTML = bannerHtml() + formHtml() + feedHtml();
      afterRender();
    });
  }

  function submit() {
    if (!state.me.user) { toast("Sign in to post a win"); return; }
    var inp = document.getElementById("win-photo");
    var file = fileHold || (inp && inp.files && inp.files[0]);
    if (!file) { toast("Add a slip screenshot first"); return; }
    if (file.size > 5 * 1024 * 1024) { toast("That photo is too large. Screenshots can be up to 5 MB."); return; }
    var fd = new FormData();
    fd.append("photo", file, file.name || "slip.png");
    var cap = document.getElementById("win-caption");
    var picks = document.getElementById("win-picks");
    var pay = document.getElementById("win-payout");
    if (cap && cap.value) fd.append("caption", cap.value);
    if (picks && picks.value) fd.append("picks", picks.value);
    if (pay && pay.value) fd.append("payout", pay.value);
    var btn = document.getElementById("win-go");
    if (btn) btn.disabled = true;
    toast("Posting…");
    fetch("/wins/submit", { method: "POST", body: fd, credentials: "include" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
    }).then(function (x) {
      if (x.status === 401) { toast("Sign in to post a win"); return; }
      if (x.status === 429) { toast((x.d && x.d.error) || "You can post 5 wins per day."); return; }
      if (!x.ok) { toast((x.d && x.d.error) || "Could not post that win"); return; }
      fileHold = null; if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch (e) {} previewUrl = null; }
      toast("Win posted");
      refresh();
    }).catch(function () { toast("Could not post that win"); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  function adminAct(kind, id, on) {
    var path = kind === "delete" ? "/wins/admin/delete" : kind === "feature" ? "/wins/admin/feature" : "/wins/admin/hide";
    var body = { id: id };
    if (kind === "feature") body.featured = on !== "0";
    if (kind === "hide") body.hidden = on !== "0";
    if (kind === "delete" && !confirm("Delete this win? This cannot be undone.")) return;
    fetch(path, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok) { toast((x.d && x.d.error) || "Could not update that post"); return; }
        toast(kind === "delete" ? "Deleted" : kind === "feature" ? (body.featured ? "Pinned" : "Unpinned") : (body.hidden ? "Hidden" : "Unhidden"));
        refresh();
      }).catch(function () { toast("Could not update that post"); });
  }

  function onClick(e) {
    var b = e.target.closest("[data-wins]");
    if (!b) return;
    var a = b.getAttribute("data-wins");
    if (a === "submit") { e.preventDefault(); submit(); }
    else if (a === "adminview") { state.adminView = b.getAttribute("data-on") === "1"; refresh(); }
    else if (a === "feature" || a === "hide" || a === "delete") adminAct(a, b.getAttribute("data-id"), b.getAttribute("data-on"));
  }

  if (typeof document !== "undefined") document.addEventListener("click", onClick);

  // For screenshots / local preview only. Not used on the live feed.
  function previewInto(el, opts) {
    opts = opts || {};
    state.posts = opts.posts || [];
    state.me = opts.me || { user: "demo", admin: !!opts.admin };
    state.setup = opts.setup !== false;
    state.remaining = opts.remaining == null ? 4 : opts.remaining;
    state.dailyLimit = opts.dailyLimit || 5;
    state.error = opts.error || "";
    state.testBanner = opts.testBanner !== false;
    state.loaded = true;
    if (typeof el === "string") el = document.getElementById(el) || document.querySelector(el);
    if (el) el.innerHTML = html();
    afterRender();
    return html();
  }

  var api = { html: html, afterRender: afterRender, load: load, refresh: refresh, previewInto: previewInto, state: state };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GPWins = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
