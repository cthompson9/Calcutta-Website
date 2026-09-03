---
name: Cross-Calcutta snapshot coverage
description: Rules for reporting incomplete calculated-return snapshots in cross-Calcutta comparisons.
---

For a Calcutta governed by payout rules, snapshot availability is basis-specific: a realized request requires a realized snapshot and an MTM request requires an MTM snapshot. A cell containing several positions is complete only when every position has coverage for the selected basis and period. Explicit requests require an exact period match; the default latest view uses the pool's shared latest sequence rather than each team's independent latest snapshot.

**Why:** Borrowing availability from the other basis, or aggregating partial returns without a clear coverage warning, makes a return look complete when the chosen calculation cannot support it.

**How to apply:** Preserve signed positions, cost, and exposure, but expose snapshot coverage on comparison cells and aggregates. Clients must label missing or partial coverage instead of presenting the associated return as final.

Normalized metric observations are the authority for calculated values and period availability. Realized observations retain plural game/audit metrics; MTM observations use the eight scoring metric names. Every commissioner write path must update the normalized ledger atomically; the wide period-snapshot rows are compatibility projections only.

**Why:** Letting REST, MCP, or availability continue to trust the wide compatibility table can advertise or return values that the calculation engine correctly rejects as incomplete.

**How to apply:** Normalize each basis before calculation, require the full metric set for every selected Calcutta entry at the same period, and omit an incomplete basis instead of zero-filling it. Preserve legacy financial rows only as the visible fallback.