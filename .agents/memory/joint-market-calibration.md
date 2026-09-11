---
name: Joint market calibration
description: Boundary between schedule-feasible win fitting and playoff-market path calibration.
---

Regular-season win ladders must first be projected through the fixed game schedule, because independent team ladders can imply a league win total that exceeds the no-tie schedule inventory. Validate the analytic rating fit against the raw ladders within the published per-game tolerance.

Playoff-market calibration then reweights complete joint paths. Its weighted regular-season frequencies are posterior shifts caused by playoff evidence, not a second target that can always equal the raw win ladders.

**Why:** The 2026 ladders implied roughly 274 wins against a 272-win no-tie path inventory. Jointly forcing raw or exact team win totals with every playoff marginal produced infeasible constraints or oscillating calibration.

**How to apply:** Keep settled 0/1 playoff constraints, stage residuals, ESS, and conditional-quality gates strict. Recover sparse positive playoff targets with deterministic, valid support columns; do not lower tolerances, center away path economics, or force an impossible raw win-total sum.