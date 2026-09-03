# Phase 2 — Kalshi fetch + ticker confirmation

Paste to the Replit agent:

---

Wire the Kalshi quote fetch into the state exporter. The transform engine in
`mtm/engine/` is frozen; you are only feeding it.

**1. Ticker discovery (one-time, log the results).** Using
`mtm/engine/kalshi_client.py` (or an equivalent fetch in TS if you prefer to
keep fetching in Node — either side of the seam is fine, but pick one), hit
the public API `https://api.elections.kalshi.com/trade-api/v2`:

- Confirm `KXNFLWINS` events exist for the current season and map each event
  to a team. Parse the strike N from each market's "N or more wins" rung.
- Discover the **Stage of Elimination** series ticker: list open NFL-related
  series/events and identify the one whose markets are the mutually exclusive
  elimination outcomes per team. Record it in
  `mtm/season-config-2026.json` replacing `CONFIRM_AT_SEASON_START`.
- Check whether game **spread** markets exist alongside `KXNFLGAME` winners;
  record what you find in the config's `series` block either way. (They are
  optional — the engine prices future diff from fitted ratings; spreads are a
  cross-check.)
- Write a short `mtm/TICKERS.md` documenting what you found, with 2–3 example
  market tickers per series, so next season's discovery is a diff not a hunt.

**2. Fetch step.** Extend the exporter (or add `mtm/fetch-quotes.ts`) to
populate `win_ladders` (yes_bid/yes_ask/volume in probability units, per
rung) and `elimination_quotes` (bid + 1 cent, in probability units; settled
outcomes as exact 0/1) for all 32 teams. Persist every raw quote to
`mtm_market_quote` tied to a snapshot row BEFORE any transform runs.

**3. End-to-end dry run.** Run:
`python3 mtm/engine/run_mtm.py --config mtm/season-config-2026.json --state state.json --out snapshot.json`

Acceptance: quotes persisted for 32 teams across both series; snapshot
`status: ok`; `diagnostics.coverage` in 0.98–1.02; `playoff_residuals` all
< 0.05 absolute; no team on `single_rung_fallback` unless its ladder is
genuinely thin (spot-check two against kalshi.com by eye).

---
