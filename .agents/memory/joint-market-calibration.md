---
name: Joint market calibration
description: Boundary between schedule-feasible win fitting and playoff-market path calibration.
---

Regular-season win ladders must first be projected through the fixed game schedule, because independent team ladders can imply a league win total that exceeds the no-tie schedule inventory. Validate the analytic rating fit against the raw ladders within the published per-game tolerance.

Playoff-market calibration then reweights complete joint paths. Its weighted regular-season frequencies are posterior shifts caused by playoff evidence, not a second target that can always equal the raw win ladders.

Publication audits must keep prefit rating expectations distinct from final
weighted probabilities. Final playoff achieved values come from weighted
calibration metrics, never legacy projection fields. Win publication requires
both the weighted-average and worst-team absolute residual to pass the same
tolerance; status, gate result, and error must derive from that one decision.

**Why:** The 2026 ladders implied roughly 274 wins against a 272-win no-tie path inventory. Jointly forcing raw or exact team win totals with every playoff marginal produced infeasible constraints or oscillating calibration.

**How to apply:** Keep settled 0/1 playoff constraints, stage residuals, ESS, and conditional-quality gates strict. Persist requested run identity before computation and retain available final candidate diagnostics on failure without publishing candidate rows. Recover sparse positive playoff targets with deterministic, valid support columns; do not lower tolerances, center away path economics, or force an impossible raw win-total sum.

An offline schedule-feasible rating candidate must preserve raw market targets
as evidence and report fitted expectations as explicit adjustments. Numerical
convergence does not imply market compatibility: schedule components conserve
one win per game independently, and relative rating levels between disconnected
components remain unidentified.

**Why:** Accepted team targets can demand more aggregate wins than the remaining
schedule permits, so an exact-target solver can plateau even when its numerical
work is sound.

**How to apply:** Keep this candidate separately identifiable and review-only
until a later replay stage explicitly integrates it. Use accepted evidence
confidence only when complete; otherwise label equal weighting rather than
inventing confidence.