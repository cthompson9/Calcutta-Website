---
name: Liquidity-aware MTM evidence
description: Durable rules for interpreting market evidence and certifying publishable MTM candidates.
---

Active market quotes are weighted evidence bounds, not hard facts or automatic point probabilities; many individually plausible contracts can be jointly incompatible with league inventory. Settlements remain exact hard facts. Verified recent trades receive more influence than bare Last, which is low-weight context and never treated as a timestamped execution.

**Why:** Sparse books can create false certainty when bid-plus-one-cent values are normalized or fitted as exact probabilities. Treating every wide book as hard also makes the joint fit routinely infeasible when the provider omits trade metadata. Recording quality metadata without applying it to fitting and publication does not prevent either failure.

**How to apply:** Keep settlements hard and fit active books as audited confidence-weighted intervals. Cap misses for strong active books. Never force a visibly incomplete mutually exclusive outcome family to sum to one; source partition complements from a direct liquid market when available (for NFL, no-playoffs is the complement of playoff qualification). Keep canonical promotion fail-closed through final-weight calibration, effective sample size, maximum weight, support, precision, and conservation checks.