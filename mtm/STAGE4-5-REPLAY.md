# MTM Stages 3–5: implementation and replay results

2026-09-15. Decision: **do not activate the candidate or publish a recalculated mark.** The staged implementation and offline experiment are complete; the original publication problem is not solved.

## What is implemented

- Stage 1–2 source was retrieved from Replit and reviewed: capture-time freshness, canonical evidence eligibility, retained run information and final achieved-metric audits. The final working source passes 41 focused API tests and API typecheck in Replit.
- Stage 3 schedule-feasible fitter is implemented and remains offline. Its seven test functions pass locally and in Replit. Review corrected its compatibility comparison to use remaining-win probability per scheduled game, matching the existing 0.03 gate. Raw win adjustments remain visible. Malformed confidence fails closed.
- Stage 4 immutable-input comparison ran locally against the verified saved snapshot-21 export, using three predetermined seeds and 40,000 paths per solver/batch.
- Stage 5 Gaussian-mixture path proposal is implemented, tested and replayed on three separate validation seeds. It keeps a 50% ordinary base component, selects eight target teams using the Stage 4 pilot, and uses the full mixture likelihood correction. It does not force winners, duplicate heavy paths, clip weights or lower gates. Ordinary Recalculate does not select it.
- Review also removed an audit fallback from missing achieved win measurements to target projections. Null/malformed probabilities now fail, and a metric-provided playoff tolerance cannot exceed the configured tolerance. Two added API tests cover these cases.
- A portable offline command, `mtm/engine/replay_frozen_review.py`, writes source/configuration provenance, fit results, batch metrics and compact private arrays. No production access is needed.

Changes are source updates in the Replit workspace. There was no publication, production recalculation, provider refresh, official-pointer change or v3 activation. No additional Replit Agent request was used for these reviews, source transfers or validation; the authenticated workspace and local tools were sufficient.

## Replay results

Every successful batch used 40,000 paths. Win errors below are final weighted remaining-win probability errors, measured in percentage points. Playoff residuals were independently calculated from weighted outcomes.

| Solver / seed | ESS (minimum 2,000) | Maximum weight (limit 1%) | Worst final win error (limit 3 pp) |
|---|---:|---:|---:|
| Legacy / 20260829 | 327.8 | 1.65% | 7.87 pp |
| Stage 3 / 20260829 | 346.3 | 1.57% | 7.81 pp |
| Legacy / 20260830 | 218.7 | 4.65% | 7.27 pp |
| Stage 3 / 20260830 | 219.0 | 4.63% | 7.28 pp |
| Legacy / 20260831 | 299.2 | 2.50% | 6.97 pp |
| Stage 3 / 20260831 | 298.0 | 2.50% | 6.98 pp |
| Stage 5 / 20260901 | 381.2 | 1.95% | 6.92 pp |
| Stage 5 / 20260902 | 320.1 | 2.71% | 7.66 pp |
| Stage 5 / 20260903 | 475.8 | 2.11% | 6.85 pp |

All nine rows fail ESS, maximum weight and final win calibration. The maximum playoff residual is approximately 0.02999 in every row, inside the 0.03 gate. Passing playoff calibration alone is therefore insufficient.

The ordinary sampler without the old reflected support paths failed all three Stage 5 comparison batches for zero support: Miami Super Bowl berth on 20260901; Cleveland Super Bowl win on 20260902 and 20260903. The mixture supplied positive support and completed calibration in each batch, but did not achieve overall publication quality. Sampling stopped after the three predeclared validation batches; no larger budget or favorable seed was selected.

## Why the solver alone cannot fix this

The saved raw remaining-win targets sum to **260.951** against **257** available wins. Exact fitting is impossible. The candidate reaches the equal-weight least-squares floor: maximum adjustment approximately **0.123468752 wins**, versus legacy's approximately **0.1307 wins**. Its per-game probability adjustment is at most **0.7717 percentage points**, within the existing prefit tolerance.

The damaging drift happens afterward, when paths are reweighted to playoff targets. In the first candidate replay, San Francisco's final remaining-win probability shifts about **7.81 percentage points below** the market target. Miami had no ordinary Super Bowl-berth paths and only two conference-round paths in the 39,200-path ordinary pilot, while its saved normalized targets require roughly 3.05% and 5.33%, respectively. The eight selected proposal teams were Miami, Tennessee, Arizona, Cleveland, NY Jets, Las Vegas, Atlanta and Washington.

The saved Miami elimination inputs were 0.01 for each of its five playoff elimination outcomes; league normalization turns these into stronger cumulative reach requirements. This supports inspecting the bid-plus-cent and normalization assumptions, alongside accepted market intervals. It does not by itself prove that the market evidence is wrong or that no joint distribution could satisfy the gates.

The snapshot includes **15 realized wins/completed games** and 257 remaining fixtures. Week 1 was therefore present in this failed input. The fitter infers strength from the market win ladder after subtracting realized wins; it does not directly estimate a new strength rating from game scores. A rejected run leaves the last successful mark on screen, which can also make the displayed team values look unchanged.

## Validation and limits

- Authenticated replay archive: 114,348 bytes; SHA-256 `030b445b5f062ac95e04ce72c7ab7c3ec910132551ddd6e7f08fed78080101f4`. All 12 section hashes matched the manifest, including all 736 quote records. The archive and expanded private inputs remain outside Git.
- Original seed, full effective configuration, configuration hash, applied home advantage/variance and rating-fit settings were not persisted. This is a **reconstructed replay**, not an exact recreation of the failed process. Configured HFA 1.6, margin SD 13.5, legacy learning rate 0.5 and 200 iterations were used explicitly. Python hash seed 0 fixes the simulator's set-iteration order. Equal evidence weights were explicitly used for Stage 3 because the saved state has no Stage 1 confidence trace.
- Stage 4 compares the saved pre-Stage-1 engine input as-is. It does not refetch quotes or retroactively rebuild that input through the new evidence policy. A fresh accepted-evidence shadow run remains separate work.
- Owner entries and actual pool size were excluded from the export. Replays use a synthetic 100-unit pool. Every simulated path conserved this pool within approximately `2.84e-14`; the team-level figures are not an owner payout bridge.
- Across three batches, the largest team payout range was 0.539 units per 100 for legacy, 0.532 for Stage 3 and 0.500 for Stage 5. Maximum team fixed-weight standard-error diagnostics were about 0.275–0.376 per 100 for Stage 5. These are limited simulation diagnostics: they exclude input/model uncertainty and do not fully account for refitting calibration weights. Three batches do not establish publication-grade precision.
- Legacy/Stage 3 simulation batches took approximately 19–25 seconds locally. The packaged Stage 5 mixture batches took approximately 19–20 seconds; observed process peak memory was at most 236.5 MiB across its validation run. Fit and result-file serialization are additional overhead. This is local Windows performance, not a Replit production capacity claim.
- Passed: seven candidate test functions; five proposal tests including known normal moments, a joint event, exact multi-step mixture density, deterministic brackets and payout conservation; canonical smoke suite; existing joint-fit suite; nine evidence tests locally; all 41 focused API tests and typecheck in Replit; diff checks and Python compilation. The packaged Stage 5 command reproduced all three original experiment outputs exactly for ESS, max weight and final win/playoff residuals.

## Portable replay commands

From the Replit repository root, using the existing private extracted export:

```sh
PYTHONHASHSEED=0 python3 mtm/engine/replay_frozen_review.py --bundle .local/exports/stage4/replay --output .local/exports/stage4/codex-replay --stage 4
```

After Stage 4 produces its pilot result in that same output directory:

```sh
PYTHONHASHSEED=0 python3 mtm/engine/replay_frozen_review.py --bundle .local/exports/stage4/replay --output .local/exports/stage4/codex-replay --stage 5
```

These are reproducibility commands, not a request to repeat the already-completed experiments. Keep inputs/results ignored and private. The command fails if `PYTHONHASHSEED` is not 0; ordinary zero-support failures are saved as failed batch results. It preserves configured 40,000-path batches and reports the fixed validation design before sampling.

## What remains

Do not keep pressing Recalculate on the same evidence expecting more iterations or a new seed to solve this. The next bounded research step is to test **joint win and playoff calibration against accepted evidence intervals**, then determine whether the market-to-strength/playoff model needs a justified change. Require simultaneous final win/playoff fit, ESS, maximum-weight, support and precision gates. Retain the old official mark until a candidate passes.

Before any future activation: obtain a fresh accepted-evidence shadow input, validate the new model across independent batches, complete an owner/pool payout bridge in the proper private environment, and review the deployment/activation decision separately. No claim is made that the current live deployment includes these unpublished source updates.
