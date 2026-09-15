# Market intervals and conditional win priority

The offline command remains `market-interval-win-priority-shadow-v1`. The canonical adapter is `market-interval-win-priority-v1`, explicitly selected by `sim.pricing_policy` in the season configuration. Unknown policies and engine/API policy mismatches fail closed. The committed configuration selects the interval adapter for the next source deployment; applying source alone does not publish the application or change the current successful mark.

The API passes an immutable copy of the effective configuration to `run_mtm.py`, saves that full configuration and its hash, and records requested/actual policy, seed and path count. Interval runs use `uv run --frozen` with the repository lockfile (SciPy 1.18.1), and `PYTHONHASHSEED=0`. Python diagnostics retain source hashes, fresh rating/proposal provenance, and prior, win-only and final ESS/maximum weights.

The canonical adapter rebuilds unconditional payouts, game conditionals, mean wins, raw differential, marquee additions and stage probabilities from the same final posterior. Pool scaling happens before aggregation. The API independently derives all six exclusive outcomes from final cumulative probabilities and checks the captured books. A soft exception must also pass independent execution-time, event-cutoff and tighter-win-evidence checks.

Provisional requests for trade/cutoff information are resolved only if the converged final hard joint fit satisfies every hard interval and the mean-win tolerance. The original reason is retained as `prefit_reason`; no exception was applied. Missing coverage, unresolved hard conflicts, solver failures and invalid soft exceptions still block publication.

Rollback: explicitly select `normalized-point-v2` (and the prior model label) in a separately deployed configuration. The API then restores the existing point-target validator. There is no automatic fallback after a failed interval calculation.

The API capture retains an additive `state.market_evidence_review` object with canonical eligibility, accepted bounds, execution records supplied by the provider, bare last price, capture time and any supplied material-event cutoff. It does not fetch extra trades or manufacture missing execution timestamps. Capture errors are recorded without bypassing existing canonical failure handling.

## Rules

- Rebuild expected wins from eligible books in the current capture. The previous state's win ladder, ratings and calibrated path weights are not used by the default fresh-generation command. Subtract realized wins once and simulate the remaining schedule.
- Keep books as intervals. Map playoff elimination outcomes to exclusive events on legal simulated brackets, including `no_playoffs = 1 - berth`. No bid-plus-cent probability floor or independent stage power normalization enters the shadow fit.
- Inspect the last qualifying execution for a wide book: width at least 10 percentage points or relative spread at least 50%. The trade must have an ID, positive size of at least one contract, price in [0,1], execution time within 15 minutes of evaluation, and occur after a known material-event cutoff before it can support a win-priority exception. Future, stale, pre-event, missing-size and ambiguous executions do not qualify. A bare last price is not an execution record. An outside-book trade is exposed as a disagreement, never clipped into the book.
- Win priority requires at least two eligible, fresh, central win-ladder rungs (midpoint 0.1â€“0.9), median spread at most 5 percentage points, and a narrower median spread than the conflicting playoff book. This is an observable tightness proxy, not a claim that traded liquidity was measured. Market names alone do not establish priority.
- Compare the playoff interval with the probability under the win-calibrated legal-path baseline. When the gap exceeds 3 percentage points, the playoff book is wide, the wins evidence qualifies, and the recent trade confirms the disagreement, make that playoff constraint soft. It incurs a squared-distance penalty of 25 in the KL fit; the original bounds and exception reason remain visible. Missing trade evidence or event cutoff blocks the exception and appears in `blockers`. Settlements and narrow playoff books stay hard.
- Fit selected constraints jointly. Preserve mean-win error â‰¤0.03, ESS â‰¥2,000, max path weight â‰¤0.01, complete elimination coverage and settlement facts. These remain separate checks. Soft quote residuals remain explicit; they are not relabeled as market agreement. `pricing_basis: wins_led` identifies a result using an exception.
- Stop early for missing support or insufficient binary-event support under the 1% path-weight cap. Solver timeouts retain an accepted iterate and never qualify as convergence. Independently recompute achieved metrics after solving.

Thresholds and the soft penalty are explicit initial shadow settings in `DEFAULTS`, not empirically validated universal liquidity cutoffs. Full win-ladder distribution fitting, owner payout precision and production activation remain separate requirements.

## Run

Use an isolated review environment with the dependencies in `mtm/requirements-market-policy-review.txt`. Export a private state and its matching `market_evidence_review` capture. No provider or database calls are made by this command:

```sh
PYTHONHASHSEED=0 OPENBLAS_NUM_THREADS=2 python3 mtm/engine/market_policy_review.py \
  --state /private/state.json --evidence /private/market-evidence.json \
  --config mtm/season-config-2026.json --output /private/shadow-result.json \
  --seed 20260915
```

Default generation refits Stage 3 ratings, then generates 40,000 legal paths using a fixed Gaussian mixture with a 50% base component and equal proposal mass for every team. It applies the full mixture likelihood correction. This broad proposal differs from the previous eight-team pilot design. The report records the seed, rating fit, proposal, and input/source hashes. It currently requires remaining regular-season games.

For a controlled fixed-inventory comparison, supply `--inventory /private/inventory.npz`. Required arrays are `teams`, `stages`, `prior` (the original corrected prior, not previously calibrated weights), `wins`, `hits`, and `gross` for a synthetic 100-unit pool. The report labels this mode as a saved-inventory diagnostic; it does not establish that the prior was freshly generated.

Run tests with `python3 -m unittest discover -s mtm/engine -p test_market_policy_review.py`. The capture adapter is covered by the API pipeline tests.

## Saved replay validation

Current snapshot-23 integration: three predeclared fresh 40,000-path batches through `run_mtm.build_snapshot` pass with ESS 5,237.11 / 6,820.80 / 4,338.01 and maximum weights 0.6530% / 0.3794% / 0.9526%. All 192 hard elimination intervals pass; mean-win errors are 1.660 / 1.840 / 1.851 percentage points. Previously provisional conflicts resolve without any soft exception. All three conserve a synthetic 100-unit pool and reconcile game conditionals. The Replit Python 3.13 / NumPy 2.5.3 / SciPy 1.18.1 runtime reproduces the first batch's ESS and maximum weight. These are saved-data integration checks, not a fresh production mark or a universal precision guarantee.

Earlier snapshot validation (before snapshot 23):

All three original 40,000-path inventories pass the new numerical checks: ESS 9,177â€“9,705, maximum weight 0.324â€“0.377%, mean-win error 2.18â€“2.27 percentage points. All remain blocked on Chicago's ineligible wild-card elimination quote. No win-priority exception was necessary in those batches; the exception branch is tested with explicit trade/conflict fixtures, not claimed as observed real-data validation. Saved execution records were unavailable and none were invented.

The complete fresh-generation command also ran locally on saved inputs with seed 20260915: ESS 6,612.4, maximum weight 0.507%, mean-win error 2.214 percentage points. It remains blocked on Chicago coverage. This single integration run validates execution, not multi-seed precision of the broad proposal.

Before activation, obtain complete fresh evidence, obtain execution records and event cutoffs only for actual unresolved wide-book conflicts, review the explicit exceptions and payout changes, and validate independent fresh batches. Nothing in this implementation authorizes publication or changes the official mark.
