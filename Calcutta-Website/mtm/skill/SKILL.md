---
name: nfl-mtm-valuation
description: >
  Mark-to-market valuation engine for NFL Calcutta pools: prices every auction
  lot from live Kalshi futures (win-total ladders, stage-of-elimination,
  game markets) plus a market-calibrated ratings sim for point differential.
  ALWAYS use this skill when the user mentions mark-to-market, MTM, marking the
  Calcutta, lot valuations, expected payout per team, "what's my book worth",
  re-pulling Kalshi, refreshing team values, the Tuesday valuation run, setting
  up the next season's valuation, win-total ladders, elimination markets,
  playoff probability normalization, or re-simming the season. Also use it when
  wiring the mtm job in refresh.yml, debugging a snapshot, or adapting the
  engine to a new season or a new rubric era (fixed-inventory or rank-based).
---

# NFL Calcutta Mark-to-Market Valuation

Prices every lot in an NFL Calcutta from market data. Season-agnostic by
design: methodology lives here, season specifics live in a config file, live
state lives in the pool's database. To stand up a new season you touch ONLY
the config and the state contract — never the scripts' logic.

## The identity

For a `fixed_inventory` rubric (Calcutta VIII, XII pattern):

```
E[points] = banked + per_win·E[wins] + per_tie·E[ties]
          + per_diff·E[adjusted diff] + Σ bonus_s·P(reach stage s)
E[payout] = pot × E[points] / denominator
```

Everything is linear in expectations because the denominator is fixed — no
simulation is needed for the *valuation*, only for the *inputs*. Two hard
rules inherited from the pool's RULES.md:

1. **Realized values come from the pool's own two-pass scoring engine.**
   Markets price only the future. Never re-derive a played game from a market.
2. **The 2× marquee multiplier applies to point differential ONLY** — window
   is "kickoff outside Sunday 1:00–7:00pm ET" (the code's test, not the rubric
   prose). E[adjusted diff] = E[raw diff] + E[marquee add-on], both zero-sum
   league-wide, so the denominator stays honest.

## Pipeline (scripts/, in order)

Run `scripts/run_mtm.py --config <season config> --state <state.json> --out
snapshot.json`. It orchestrates four modules — read a module's docstring
before modifying it:

| Step | Module | Method |
|---|---|---|
| E[wins] | `wins.py` | Full ladder sum: E[W] = Σₖ P(W≥k) over the KXNFLWINS "N or more wins" rungs (mids), monotone-clamped, missing rungs interpolated between anchors P(W≥0)=1, P(W≥18)=0. Thin ladder (<4 priced rungs) falls back to single-rung-nearest-50¢. |
| P(stage) | `playoffs.py` | Stage-of-elimination outcomes (bid+1¢) → cumulative reach probs → **power-method** normalization per stage to exact league inventory (berth 14, divisional 8, conference 4, SB berth 2, champion 1), then per-team monotone clamp, two rounds. Settled teams (0/1) held fixed. |
| E[diff] | `simulate.py` | **Re-fit ratings every run** from market E[remaining wins] over the remaining schedule (point-scale ratings: E[margin] = rᵢ−rⱼ+HFA). Analytic E[remaining diff] + marquee add-on from schedule flags. No maintained power rankings — the market's repricing after each week's games IS the update. |
| Assemble | `valuation.py` | Identity above, per lot, plus league diagnostics. |

`kalshi_client.py` is the read-only public API client
(`api.elections.kalshi.com/trade-api/v2`, no auth). Persist every raw quote
before transforming — quotes are evidence, projections are derived, and
storing them makes every historical snapshot re-runnable when methods improve.

## Scheduling contract

One entrypoint, two triggers, identical code path:
- **Cron**: GitHub Actions Tuesday run. 3am ET = `0 7,8 * * 2` UTC with an
  in-code ET gate (GitHub cron is DST-blind and fires 5–15 min late).
- **Admin button**: authenticated endpoint calling the same entrypoint with
  `trigger='manual'`.

A run writes a snapshot row atomically: **failed fetch = failed snapshot; the
UI keeps serving the last good one with a staleness flag. Never a partial
mark.** Recommended tables: `mtm_snapshot`, `mtm_market_quote`,
`mtm_team_projection`, `mtm_entry_valuation`.

## New-season checklist (do these in order)

1. Copy `assets/season-config-2026.json` → new year. Update `season`.
2. **Confirm Kalshi tickers** — they change yearly (KXSB-27 vs -26). Discover
   via `GET /events?series_ticker=...` or the `/series` endpoint. Fill in the
   `CONFIRM_AT_SEASON_START` placeholders (elimination + spread series).
3. **Recompute the denominator if the era changed** (games/season, playoff
   field). 11,420 = 32·150 + 272·10 + 3,900. Assert it in a test: a completed
   season's league points must equal it exactly — this is the check that
   catches marquee-class bugs on day one.
4. Load the new schedule with marquee flags (apply the kickoff-window test to
   every game, including Saturday and international slates).
5. Verify stage targets still match NFL structure (14/8/4/2/1).
6. Week 0: ladders may be thin — check `diagnostics.wins.method` per team and
   widen `max_spread_for_mid` if too many teams fall back.
7. Dry-run offline: `run_mtm.py` against cached quotes, eyeball
   `diagnostics.coverage` (should sit near 1.0) and `playoff_residuals`
   (should be ~0 after normalization).

## Judgment calls already made (don't relitigate silently)

- **Ties**: E[remaining ties] priced at 0 (win-total contracts don't count
  ties; league averages <1 tie/season; +5pts is noise). Documented, not
  forgotten — revisit only if Kalshi lists tie-inclusive contracts.
- **Wins pricing = mid; playoff pricing = bid+1¢** (wider spreads, and the
  power normalization corrects the level anyway).
- **Elimination markets are the primary playoff source**; Division Winner /
  Super Bowl markets and the Monte Carlo are cross-checks. Log discrepancies
  per team; don't auto-blend.
- **Power method for de-vigging** (Σpᵢ^α = target): shrinks longshots more
  than favorites, which is the correct direction for longshot bias. The
  fitted α per stage is in diagnostics — α drifting far from ~1 flags a
  mispriced or illiquid stage.

## Rank-based rubric eras (NFL 2024 pattern)

Expectations are NOT sufficient when differential pays off a rank ladder.
Use `simulate.monte_carlo(...)['diff_samples']` — per-team season-diff
distributions from the same fitted ratings — then apply the ladder to each
simulated season's ranking and average. Same inputs, one extra step.

## References

- `references/integration.md` — state.json contract, DB schema DDL, the
  refresh.yml job wiring, and the repo touchpoints. Read it when wiring the
  engine into the Calcutta-Website repo or debugging the cron.
