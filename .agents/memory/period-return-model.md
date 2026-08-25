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