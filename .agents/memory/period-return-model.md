---
name: Period return model
description: How Calcutta returns are calculated from cumulative NFL snapshots and configurable rules.
---

Returns are calculated from **cumulative** team snapshots, not directly uploaded as a single gross-return amount. For each metric, only the change from the prior snapshot is paid, so the same regular-season result cannot be awarded again in a later period. A rule's configurable playoff multiplier applies to the change recorded in a playoff period.

MTM snapshots may contain fractional projected metrics. They must retain those values in reporting rather than using legacy win/loss normalization, which only applies to actual realized records.

Historical legacy result rows cannot be accurately assigned to a single final playoff period. Backfill creates Calcutta identities and entries only; it leaves legacy financial values as the fallback. A playoff snapshot requires an existing Week 18 baseline for the same basis.

**Why:** A Calcutta needs a reproducible audit trail that separates results achieved in each NFL period from the financial rules used to value them, while avoiding double counting.

**How to apply:** Keep realized and MTM snapshots separate; accept negative MTM deltas when values change. Use legacy result values only as a reporting fallback until the Calcutta has payout rules configured. Preserve historical results and ownership independently of snapshot recalculation.

Week 0 is the narrow exception: a complete zero-stat baseline is valued with the established default rubric when no custom payout rules exist, because its fixed 150-point allocation does not depend on configurable metric rates. Later periods must still require a complete custom rubric.

**Why:** A new pool must be able to show its opening normalized value before a commissioner has entered optional custom rates, without weakening the configuration safeguard for live performance periods.

**How to apply:** Limit the default-rubric fallback to exact Week 0 snapshot requests with no saved rule rows; do not create, replace, or infer payout-rule records as part of baseline initialization.

Week 0 baseline creation is automatic on Results reporting reads, including period availability. It must never be gated by a commissioner key or a visible manual initialization action.

**Why:** Opening returns are a normal report state, not a privileged operational step; the baseline writer is additive and idempotent under the season lock.

**How to apply:** Ensure both team and owner result routes, plus availability, invoke the server-side baseline check before loading snapshots. Keep any retained manual endpoint backward-compatible but unnecessary for normal use.

Point-based NFL returns always use the fixed **11,420-point final-season denominator**. Interim calculated gross values deliberately sum to less than the pool; only the completed season’s full scorecard exhausts it.

**Why:** Renormalizing to points earned so far incorrectly treats an opening baseline or partial season as if the full pool had already been won.

**How to apply:** Calculate point-backed gross as `pool × team points ÷ 11,420`, for both calculated return bases. Keep separate market-valuation snapshots governed by their own market model.

The 11,420 denominator is specific to the NFL points machine: it is the knowable complete future point inventory, including banked points, game win/tie units, playoff bonuses, and zero-sum point differential. Other sports must supply their own final denominator rather than reuse this NFL constant.

**Why:** A cross-sport Calcutta abstraction can preserve the fixed-denominator principle without assuming NFL scoring totals.

**How to apply:** Keep the denominator owned by each sport’s scoring model and pass that sport-specific value into shared return allocation code.

Displayed realized points to breakeven is a signed result, not a remaining-point countdown: divide realized net value by the fixed final-denominator dollars-per-point rate (`pool ÷ 11,420`) and round to a whole point. Positive values are profitable surplus; negative values are the deficit.

**Why:** Clamping at zero conceals profitable positions and misstates the direction of a team’s realized return.

**How to apply:** Only show the value when the realized snapshot ledger has complete coverage and a positive pool rate; owner-specific rows must use each owner’s own signed realized net value.