# Glockys-cs2-props-
prop grader for cs2 props , research done for you. Backed by real data &amp; analytics 

## Active grader
New locks and live grades use the v1 projection (35% last 10 series, 20% all logged series, 20% head-to-head, 15% vs the same rank tier from `players.json`, 10% last 3 series, then a small ADR adjustment) and the v1 letter cutoffs on `(proj - line) / line`: A+ ≥ +15%, B ≥ +5%, C ≥ −2%, D ≥ −10%, otherwise F. The pick is Over if the projection is at or above the line, otherwise Under. When that pick is Under and the letter is D or F, a v2 negative-binomial P(under) with a 0.7 line blend is compared to the book's break-even (stored odds, or the book default): F if the Under is at least +3 percentage points over break-even, otherwise D. The pick does not change. There is no hit-rate letter override and no plain A. Already-locked props keep the letter stored on the lock.

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
- **Admin accounts** get everything: the Grader, the full Track Record and the owner tools at `/beta-admin`. Make the first one by typing the existing admin key into the *Invite code* box on the Sign up tab (the key is only hashed and compared with `KEY_HASH`, never stored). Promote / demote others at `/beta-admin`.
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
