---
name: Liquidity-aware MTM evidence
description: Durable rules for interpreting market evidence and certifying publishable MTM candidates.
---

Active market quotes are evidence bounds, not automatically reliable point probabilities. One-sided books retain only their supported bound, wide or incomplete books are weak or excluded, and settled outcomes are exact hard facts. Correlated observations share capped influence.

**Why:** Sparse books can create false certainty when bid-plus-one-cent values are normalized or fitted as exact probabilities. Recording quality metadata without applying it to fitting and publication does not prevent that failure.

**How to apply:** Keep canonical promotion fail-closed. Require a deterministic expected-request capture manifest and an authoritative publication audit based on final weights, including calibration, effective sample size, maximum weight, support, precision, and conservation checks. Review-only joint fits must remain noncanonical until replay and shadow validation are approved.