# Glockys-cs2-props-
prop grader for cs2 props , research done for you. Backed by real data &amp; analytics 

## Active grader
New locks and live grades use the v1 projection (35% last 10 series, 20% all logged series, 20% head-to-head, 15% vs the same rank tier from `players.json`, 10% last 3 series, then a small ADR adjustment) and the v1 letter cutoffs on `(proj - line) / line`: A+ ≥ +15%, B ≥ +5%, C ≥ −2%, D ≥ −10%, otherwise F. The pick is Over if the projection is at or above the line, otherwise Under. When that pick is Under and the letter is D or F, a v2 negative-binomial P(under) with a 0.7 line blend is compared to the book's break-even (stored odds, or the book default): F if the Under is at least +3 percentage points over break-even, otherwise D. The pick does not change. There is no hit-rate letter override and no plain A. Already-locked props keep the letter stored on the lock.

### LAN data (owner request, Nov 24)
When the match is LAN, every v1 input (last 10, season, head-to-head, same rank tier, last 3, ADR nudge) is computed from the player's LAN games only (Map 1 props: LAN Map 1s). Weights are unchanged.
- **Is the match LAN?** 1) `games.json` `ev` (bo3.gg tournament event type; `update_games.py` fills it from the list payload, `season_state.json` events, or the match detail; no extra API calls); 2) otherwise the newest logged map of either team in the 3 days before the match (same event, several match days); 3) otherwise not LAN. Locks record `ev` / `ev_src`.
- **Thin LAN samples:** last 10 / last 3 use the n LAN series for n of the 10 / 3 slots and the overall value for the rest, `(n·LAN + (N−n)·overall)/N`. Season, head-to-head and same tier are `(n·LAN + 5·overall)/(n+5)`. A part with no LAN series uses overall. ADR nudge uses LAN rows when 3+ of the last 5 LAN series have ADR, else overall.
- The Breakdown labels each part "· LAN data" with "n LAN of N" series; grade cards show a "LAN data" tag. `lan_data: 0` in PARAMS turns it off.
- Backtest (`python lan_backtest.py`): it does not improve accuracy. See the PR for the numbers.

### Per-map factor (owner request, Nov 24)
After the v1 mix and ADR nudge, the projection shrinks toward the player's average on the map(s) being played: all games on that map (not LAN-only), only logs dated strictly before the match day, `proj = (n · map_avg + 5 · proj) / (n + 5)`.
- **Known maps:** if a completed veto or listed map name is already in (`team_strength.json` `match_maps`; TBA and junk unattributed placeholders ignored), use those. Map 1 uses the first map; Maps 1-2 sums the first two (if only one is known, the second slot is the expected per-map average).
- **Otherwise:** Glocky's simulated veto supplies the expected maps. LAN matches use both teams' LAN-only pick and ban history, online matches use online-only history (same LAN / online badge as the Games card). A side with fewer than 8 Maps 1-2 logs in that setting falls back to all of their matches, and the card notes it. Map 1 uses the Map 1 slot weights; Maps 1-2 is E[avg(Map 1)] + E[avg(Map 2)].
- Grade cards show a "Per-map average" factor. The Games card shows **Glocky's map prediction** (Map 1 / Map 2 / decider with probabilities), clearly labeled as a prediction, or **Confirmed map(s)** when a real veto is in, without naming a data provider. Ask Glocky answers "what maps will X vs Y play" from the same math. `map_data: 0` turns the shrink off. Letters stay the v1e edge scale; LAN kills and bait caps are unchanged.

## Cito API (optional team-strength data)
- `cito_client.py`: Cito client. It saves every reply to `cito_cache/`, spaces calls 6.5 s apart, and allows at most 14 calls a day, keeping 40 of the monthly allowance in reserve. It retries a 429 after the time given in `Retry-After`.
- `cito_update.py` is the only script that calls Cito. It runs once a day in the "Update CS2 data" workflow, the only step that gets the `CITO_API_KEY` secret. It writes `team_strength.json` (dated VRS and world ranking points plus team map stats), `cito_ids.json`, and `cito_cache/_results_index.json` (backup results for settling).
- The active v1 projection and letters do not use Cito rank or map-pool weights (the upcoming-matches reply has no per-match map pick probabilities). Confirmed map names from a completed veto or listed maps in that same reply are stored on `team_strength.json` as `match_maps` and used by the per-map factor when present. `team_strength.json` is still loaded for display fields, and only entries dated before the match day are used. Set `w_rank` / `w_maps` to 0 to turn those display features off.
- Turning it on: create a Cito key, then add it as the repository secret `CITO_API_KEY`. For local runs, put `CITO_API_KEY=...` in `.env`, which is gitignored and never served.
- Tests: `python tests/make_mock_cito.py && python tests/test_cito.py` (mock data, no network).

## Hit rates
Each graded prop shows L5 / L10 / L15 / L20 / H2H / SZN (display only): how many earlier Maps 1-2 series went over the current line. `w_hr` blends a smoothed hit rate into P(over). The backtest chose 0, so that path does not change P(over). The hit-rate letter override is off (`hr_upgrade_a` and `hr_upgrade_b` are 0). L5 / L10 / L15 / L20 / H2H / SZN boxes stay on the cards as display only. The Players tab shows Last 5 / Last 10 / Last 15 / Season for a typed line: research only, never a grade input.

### Full-season data

`update_data.py` keeps every 2026 (calendar-year) Maps 1-2 series for every tracked team and player, not just the last 15 matches. It is incremental: `season_state.json` (committed, not served) remembers the matches already stored per team, so a daily run only fetches newer matches (usually one bo3.gg page per team). Older season matches are backfilled oldest-first in the time left (`TIME_LIMIT_H`, default 4.5 h) and the backfill resumes on the next run until every team reaches `SEASON_START` (default Jan 1 of the current year; the state resets when the year changes). `players.json` is written in a compact format (`fmt: 2`, column arrays plus a string table, read with `load_players` / `GPModel.decodePlayers`) and is trimmed oldest-first if it would pass 22 MiB (Workers asset limit 25 MiB). The grader uses the full season (`n_max` 200, half-life 8 series).

Kills grades also show season K/D and kills per map over the last 5 / 10 / 15 series and the season. They are wired into the model as `w_kd`, `w_l5`, `w_l10`, `w_l15` and `w_szn` (`python backtest.py --tune-form`), and the backtest tuned them to 0. By owner decision small weights ship anyway: `w_l5` 0.1, `w_l10` 0.1, `w_kd` 0.1 (full season stays the base). HS% (hs / kills) over the last 5 / 10 / 15 series and the season is an input to the headshots projection (`w_hs5` 0.3, `w_hs10` 0.2, `w_hsszn` 0.1, tuned; `python backtest.py --tune-hs`) and, by owner decision, to the kills projection (`w_khs5` 0.1). Season K/D also enters the headshots projection (`w_hkd` -0.1).

## Beta login (Cloudflare Worker only)

Built-in accounts for beta customers. Code: `beta_auth.js` (Worker), `beta-login.html/js`, `beta-admin.html/js`, `beta.css`, `beta.js` (account bar + Log out in the app).

- **Customers** sign up at `/login` with an invite code, username, email and password, then log in. They get the whole Grader but **not** the Track Record (`lines_history.json`).
- **Admin accounts** get everything: the Grader, the full Track Record, a second sheet that counts only props locked after Nov 24, 2026, 2:09 AM CT (by `lock.at`; there is no lock version tag for that deploy), and the owner tools at `/beta-admin`. Make the first one by typing the existing admin key into the *Invite code* box on the Sign up tab (the key is only hashed and compared with `KEY_HASH`, never stored). Promote / demote others at `/beta-admin`.
- The admin key still works as before (`#admin=` link / `X-Admin-Key` header) and always gets through the gate.
- `/beta-admin`: turn the gate on/off, create / revoke invite codes, list users, turn a user off, reset a password (gives a one-time temporary password), make admin / make customer.
- Sessions: HttpOnly, Secure, SameSite=Lax cookie `gp_sess`, HMAC-SHA256 signed with `SESSION_SECRET`, 30 days. Turning a user off or resetting their password logs them out everywhere.
- Passwords: PBKDF2-SHA256, random salt per user, 100,000 iterations (the Workers maximum; set var `PBKDF2_ITERATIONS` lower only if logins hit CPU-limit errors).
- Brute force: failed logins / bad invite codes counted per IP (20 per 15 min) and per username (8 per 15 min) in KV.
- **Fail safe:** without the `BETA` KV binding or a `SESSION_SECRET` (32+ chars) login is off and the site is open exactly as before. The gate also starts **OFF** until turned on at `/beta-admin` (var `BETA_GATE=on|off` overrides the switch).
- The GitHub Pages copy has no Worker, so it is never gated.

Setup in Cloudflare (Workers & Pages → glockys-cs2-props):
1. Settings → Variables and Secrets → Add → Type **Secret**, name `SESSION_SECRET`, value: a random string of 32+ characters (e.g. `openssl rand -hex 32`). Save / deploy.
2. KV: `wrangler.jsonc` declares `"kv_namespaces": [{ "binding": "BETA" }]` without an id, so the next deploy creates and links it automatically. If a build fails on that step: Storage & Databases → KV → Create namespace `glockys-beta`, copy its ID, and add `"id": "<ID>"` to that line in `wrangler.jsonc`.
3. After the deploy: sign up at `/login` with your admin key as the invite code → you now have an admin account. Create invites at `/beta-admin`, then turn the gate **ON** there.

Tests: `node --test tests/test_beta_auth.mjs`.

## Push notifications + support chat (Cloudflare Worker only)

Code: `push.js` (Web Push: VAPID RFC 8292 + aes128gcm RFC 8291, WebCrypto only), `support_api.js` (support chat API), `sw.js` (service worker: shows notifications only, no caching), `manifest.webmanifest`, `push-ui.js` (banner + 🔔 Alerts settings), `support-ui.js` (💬 Support bubble, bottom-left), `notify_push.py` (lines job → notify).

- Logged-in users tap **Turn on notifications** (or 🔔 Alerts) and pick *New lines* / *New grades*. iPhone: Safari → Share → **Add to Home Screen**, open GP Grader from the Home Screen (iOS 16.4+), then turn notifications on there.
- Subscriptions are saved in KV under the user; removed when the push service answers 404/410 and when the user is turned off.
- The hourly **Update CS2 lines** job snapshots `lines.json` / `lines_history.json`, and after committing runs `notify_push.py`, which counts new upcoming props and new locked grades and calls `POST /auth/admin/notify` with the `GP_ADMIN_KEY` secret. Nothing new → nothing sent. The Worker allows one `lines` and one `grades` notification per 30 minutes.
- `/beta-admin` → **Notifications**: *Set up notifications* (makes the VAPID key pair inside the Worker and keeps it in KV; the private key never leaves Cloudflare), *Send test notification* (to your own admin devices), and a manual send form. → **Support inbox**: threads with unread counts, open a thread and reply.
- Support chat: plain text, max 1000 characters, 12 messages per 10 minutes per user. New customer messages push to admin accounts that have notifications on; owner replies push to the customer.
- Fail safe: with no VAPID keys the notification UI is hidden and nothing changes. Env secrets `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` override the KV keys if set.

After merging: press *Set up notifications* at `/beta-admin` (or `POST /auth/admin/push/setup` with the admin key), and add the repo secret `GP_ADMIN_KEY` = the admin key (Settings → Secrets and variables → Actions).

Tests: `node --test tests/test_push.mjs` (includes the RFC 8291 test vector).


## Community Wins tab (Cloudflare Worker only)

The **Wins** tab is a community board where signed-in users post screenshots of their own hit slips. It is **not** the grader Track Record: customers never see our locked grades, losses, hit rate, or units. The existing admin-only Track Record on the Dashboard is unchanged and still comes only from `lines_history.json`.

- Anyone signed in can open the tab, browse posts (newest first, with optional admin pins at the top), and submit a win: a PNG, JPG, or WebP screenshot (up to 5 MB) plus an optional caption, picks, and payout. The post shows their username and the date (Central Time).
- Each user can post 5 wins per calendar day (America/Chicago). The Worker checks the file's magic bytes (not just the name), and strips EXIF / text metadata from the image before it is stored.
- Admins can pin, hide, or delete a post from the same tab. Hidden posts and their images are left out of the public feed (and return 404 for non-admins).
- GitHub Pages has no Worker, so the tab shows a short "use the live site" note there.

### One-time setup (needed before Wins will accept posts)

The Worker bindings are already in `wrangler.jsonc` (`WINS` KV and `WINS_R2`). You still need to create the R2 bucket once, and the first deploy will create the KV namespace if it is not there yet.

1. Create the R2 bucket (once), from this repo or the dashboard:
   - `npx wrangler r2 bucket create glockyz-wins`
   - Or: Cloudflare dashboard → R2 → Create bucket → name it exactly `glockyz-wins`.
2. Deploy as usual (`npx wrangler deploy`, or push to `main` if that auto-deploys). Wrangler 4.45+ should create and link the `WINS` KV namespace automatically, the same way as `BETA`. If that step fails: Storage & Databases → KV → Create namespace `glockys-wins`, copy its ID, and add `"id": "<ID>"` next to the `WINS` binding in `wrangler.jsonc`.
3. After deploy, sign in on the live site and open the **Wins** tab. If the bucket or KV binding is missing, the tab says "The Wins board isn't set up yet."

No new secrets are required for this tab. Never put API keys or the admin key in the board, the wrangler file, or a chat.

Tests: `node --test tests/test_wins.mjs`.

## Ask Glocky (Cloudflare Worker only)

The **Ask Glocky** button opens a chat. Answers use only our existing data (`players.json`, `team_strength.json`, the live `lines.json` board, and `games.json`). The Worker looks up the numbers first (including the same v1f grader math the site uses for over/under questions) and then phrases a "Glocky says" reply. It does not read `lines_history.json` or the Track Record. Replies and the chat UI never name data providers; they say "our data" or "Glocky's data".

When someone asks over or under on a line (for example "EliGE over 35.5 kills maps 1-2?"), Glocky runs our grader (Map 1 vs Maps 1-2, LAN rule, head-to-head, bait flag) and the chat shows the current Grader trading card under the reply. If that line is on the board, the board line, book, and opponent are used; otherwise the line in the question is graded.

### Set up the free Gemini key

Ask Glocky stays dark until a Gemini API key is stored as a **Worker secret** named `GEMINI_API_KEY`. Never commit the key, put it in the repo, or type it into the site.

1. Create a free key in [Google AI Studio](https://aistudio.google.com/apikey) (Gemini API, free tier).
2. Add it as a secret on the `glockys-cs2-props` Worker, either:
   - From this repo: `npx wrangler secret put GEMINI_API_KEY` (it will prompt; paste the key, then deploy), or
   - In the Cloudflare dashboard: Workers & Pages → `glockys-cs2-props` → Settings → Variables and Secrets → Add a **Secret** named `GEMINI_API_KEY`.
3. Deploy once after the secret is in place (a push to `main` auto-deploys). Until the secret is set, signed-in users see "Ask Glocky isn't set up yet."

The default model is `gemini-3.8-flash`. Retired names such as `gemini-2.5-flash` are mapped to that default. To use another Flash model, set a plain Worker variable `GEMINI_MODEL` (not a secret). If a model returns 404 NOT_FOUND, or stays busy (503/429/500/504) after two short retries, the Worker tries `gemini-3.8-flash`, then `gemini-3.5-flash-lite`, then `gemini-3.6-flash`. Google's free-tier limits and terms apply (free prompts may be used to improve their models). The Worker also caps each signed-in user at 20 questions per UTC day.

Tests: `node --test tests/test_ask_lookup.mjs tests/test_ask_ai.mjs`.


## Slip reader

Signed-in users (when the beta gate is on) can upload a PrizePicks or Underdog CS2 slip screenshot from the **Upload slip** section on the Grader tab, or from the Slip button in Ask Glocky. Glocky only reads the picks off the image. After you fix any misreads, each leg is graded with the same math as the site (Map 1 vs Maps 1-2, LAN rule, head-to-head, bait flag, blowout warning). Images are not stored.

The slip reader uses **Workers AI** first (`@cf/meta/llama-4-scout-17b-16e-instruct`, a current vision-capable model on the free Neuron allocation). The `AI` binding is declared in `wrangler.jsonc` and is created on deploy. If Workers AI errors, returns empty text, or returns text that is not JSON, the existing Gemini chain is used as fallback (same `GEMINI_API_KEY` as Ask Glocky). Ask Glocky itself stays on Gemini. The vision payload (base64 data URL) is dropped before `players.json` is parsed so the two are not held together in the Worker's 128 MB isolate; the image is never converted to a `number[]`. If data still fails to load, admins see the real reason in `detail`. Official Cloudflare docs do not require a one-time Meta `"agree"` request for Llama 4 Scout (that step is only documented for Llama 3.2 11B Vision).

Limits: PNG, JPG, or WebP, up to 5 MB; 10 slips per signed-in user per UTC day, plus a short cooldown. The reader needs the Workers AI binding, or the Gemini secret as fallback. Until one of those is in place, it says it isn't set up yet.

Tests: `node --test tests/test_slip_reader.mjs tests/test_slip_ai.mjs`.


## Shadow S: Scout-style factor projection (admin only, test)

`scout_model.py` grades every upcoming prop a third way and saves it once, before the match starts, as `e["shadow_s"]` in `lines_history.json` (via `shadow.py`). It never changes the live projection, pick, letter or any locked grade.

- **Form:** kills per round over every logged map this season, recency weighted (half-life 30 maps), blended with the raw season rate (weight 0.2, never 0) and with head-to-head kills per round vs this opponent (from a single prior meeting, shrunk toward his own rate, weight 0.15).
- **Rounds:** expected rounds per map from both teams' recent rounds per map and the Elo closeness pw(1-pw), times 2 maps (Maps 1-2) or 1 map (Map 1).
- **Opponent:** deaths per player-round the opponent gives up vs the average of the teams he faced (coefficient fitted).
- **Headshots:** the kills projection times his headshots per kill (recent, shrunk to season).
- Letters use the live v1 cutoffs and the Under break-even rule.
- The Shadow tab shows its record next to the live grader. The Grader card shows a "What moved the projection" table and the likely maps (veto estimate, context only) when the prop is on the board.

Likely maps: each team's share of every active-pool map among its Maps 1-2 over the last 180 days (smoothed), averaged for the two teams; the top 3 are kept and renormalized (best-of-5: top 5, format from games.json). On Oct 20+ Bo3 matches 64% of the maps actually played were in our top 3 (a random top 3 of 7 gets 43%).

Tested and dropped (no holdout gain): LAN/online KPR, per-map KPR and per-map rounds weighted by the top-3 maps (or by the whole pool; even with the real maps known it added nothing), and Elo as a kills-per-round factor. Blowouts (a map won or lost 13-5 or wider): the predicted blowout chance (logistic on the Elo win chance) times his own kills per round in past blowout wins / losses / close maps (shrunk to the league ratio) cut validation MAE by only 0.000-0.004, under the 0.005 bar, at thresholds 7 / 8 / 9 and with lighter shrinkage; the player-specific part alone added nothing. It is shown on cards as context only.

Backtest: `python scout_backtest.py build` (features, cached in /tmp), `report` (staged factor selection), `factors` (per-factor table), `final` (holdout + real locked lines), `fit` (writes `scout_params.json`; Apr 1 - Oct 19 fit window). Tests: `python tests/test_scout.py`.

### Shadow S: LAN data (owner request, Nov 24)
When `infer_ev` says the match is LAN (the newest logged map of either team in the 3 days before it was LAN), Shadow S builds its form (recent and season kills per round), head-to-head, opponent (deaths given up on LAN maps, vs the LAN opponents he faced) and headshots-per-kill inputs from the player's LAN maps only. Each LAN piece is shrunk to the same piece from all maps by 150 rounds (`lan_k_rd`), so a few LAN maps lean on overall. Like every Shadow S input it uses maps from both scopes; Map 1 changes only the number of maps. `lan_data: 0` turns it off. Backtest (`python lan_scout_backtest.py`): on LAN matches it did not lower MAE (holdout Maps 1-2 kills 6.240 → 6.250, HS 3.799 → 3.827). It is shown with a "LAN data" label.
