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

## Cito API (optional team-strength data)
- `cito_client.py`: Cito client. It saves every reply to `cito_cache/`, spaces calls 6.5 s apart, and allows at most 14 calls a day, keeping 40 of the monthly allowance in reserve. It retries a 429 after the time given in `Retry-After`.
- `cito_update.py` is the only script that calls Cito. It runs once a day in the "Update CS2 data" workflow, the only step that gets the `CITO_API_KEY` secret. It writes `team_strength.json` (dated VRS and world ranking points plus team map stats), `cito_ids.json`, and `cito_cache/_results_index.json` (backup results for settling).
- The active v1 projection and letters do not use Cito rank or map-pool weights. `team_strength.json` is still loaded for display fields, and only entries dated before the match day are used. Set `w_rank` / `w_maps` to 0 to turn those display features off.
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
