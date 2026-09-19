---
name: Liquidity-aware MTM evidence
description: Durable rules for interpreting market evidence and certifying publishable MTM candidates.
---

Active market quotes are evidence bounds, not automatically reliable point probabilities. One-sided books retain only their supported bound, wide or incomplete books are weak or excluded, and settled outcomes are exact hard facts. Correlated observations share capped influence. When a fresh wide book materially conflicts with demonstrably tighter win evidence, a valid bare Last may preserve that book as low-weight soft context; it is never treated as a timestamped execution.

**Why:** Sparse books can create false certainty when bid-plus-one-cent values are normalized or fitted as exact probabilities. Treating every wide book as hard also makes the joint fit routinely infeasible when the provider omits trade metadata. Recording quality metadata without applying it to fitting and publication does not prevent either failure.

**How to apply:** Keep narrow books and settlements hard. Give verified recent trades more influence than bare Last context, and independently validate every soft decision. Keep canonical promotion fail-closed through final-weight calibration, effective sample size, maximum weight, support, precision, and conservation checks.