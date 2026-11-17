# Glockys-cs2-props-
prop grader for cs2 props , research done for you. Backed by real data &amp; analytics 

## Cito API (optional team-strength data)
- `cito_client.py`: Cito client. It saves every reply to `cito_cache/`, spaces calls 6.5 s apart, and allows at most 14 calls a day, keeping 40 of the monthly allowance in reserve. It retries a 429 after the time given in `Retry-After`.
- `cito_update.py` is the only script that calls Cito. It runs once a day in the "Update CS2 data" workflow, the only step that gets the `CITO_API_KEY` secret. It writes `team_strength.json` (dated VRS and world ranking points plus team map stats), `cito_ids.json`, and `cito_cache/_results_index.json` (backup results for settling).
- The grader (`grader.py` / `model.js`) only uses entries dated before the match day. The weights are `w_rank` and `w_maps` in PARAMS; set them to 0 to turn the features off. With no `team_strength.json`, grades are the same as before.
- Turning it on: create a Cito key, then add it as the repository secret `CITO_API_KEY`. For local runs, put `CITO_API_KEY=...` in `.env`, which is gitignored and never served.
- Tests: `python tests/make_mock_cito.py && python tests/test_cito.py` (mock data, no network).

## Hit rates
Each graded prop shows L5 / L10 / L20 / H2H / SZN: how many earlier Maps 1-2 series went over the current line. `w_hr` blends a smoothed hit rate into P(over). The backtest chose 0, so the boxes are shown but not used in the grade.
