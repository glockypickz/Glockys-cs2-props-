# Glockys-cs2-props-
prop grader for cs2 props , research done for you. Backed by real data &amp; analytics 

## Cito API (optional team-strength data)
- `cito_client.py`: Cito client. It saves every reply to `cito_cache/`, spaces calls 6.5 s apart, and allows at most 14 calls a day, keeping 40 of the monthly allowance in reserve. It retries a 429 after the time given in `Retry-After`.
- `cito_update.py` is the only script that calls Cito. It runs once a day in the "Update CS2 data" workflow, the only step that gets the `CITO_API_KEY` secret. It writes `team_strength.json` (dated VRS and world ranking points plus team map stats), `cito_ids.json`, and `cito_cache/_results_index.json` (backup results for settling).
- The grader (`grader.py` / `model.js`) only uses entries dated before the match day. The weights are `w_rank` and `w_maps` in PARAMS; set them to 0 to turn the features off. With no `team_strength.json`, grades are the same as before.
- Turning it on: create a Cito key, then add it as the repository secret `CITO_API_KEY`. For local runs, put `CITO_API_KEY=...` in `.env`, which is gitignored and never served.
- Tests: `python tests/make_mock_cito.py && python tests/test_cito.py` (mock data, no network).

## Hit rates
Each graded prop shows SZN / H2H / L20: how many earlier Maps 1-2 series went over the current line. `w_hr` blends a smoothed hit rate into P(over). The backtest chose 0, so the boxes are shown but not used in the grade. The Players tab shows Last 5 / Last 10 / Last 15 / Season for a typed line: research only, never a grade input.

### Full-season data

`update_data.py` keeps every 2026 (calendar-year) Maps 1-2 series for every tracked team and player, not just the last 15 matches. It is incremental: `season_state.json` (committed, not served) remembers the matches already stored per team, so a daily run only fetches newer matches (usually one bo3.gg page per team). Older season matches are backfilled oldest-first in the time left (`TIME_LIMIT_H`, default 4.5 h) and the backfill resumes on the next run until every team reaches `SEASON_START` (default Jan 1 of the current year; the state resets when the year changes). `players.json` is written in a compact format (`fmt: 2`, column arrays plus a string table, read with `load_players` / `GPModel.decodePlayers`) and is trimmed oldest-first if it would pass 22 MiB (Workers asset limit 25 MiB). The grader uses the full season (`n_max` 200, half-life 8 series).

Kills grades also show season K/D and kills per map over the last 5 / 10 / 15 series and the season. They are wired into the model as `w_kd`, `w_l5`, `w_l10`, `w_l15` and `w_szn` (`python backtest.py --tune-form`), but every non-zero weight made the backtest worse, so all are 0 (display only).
