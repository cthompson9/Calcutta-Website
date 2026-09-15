---
name: Nonnegative path payouts
description: Why signed scoring must become nonnegative before each Monte Carlo path is normalized to the auction pool.
---

Floor negative team scoring at zero before normalizing each simulation path into gross payouts. Do not normalize signed points first and clamp negative expected payouts after aggregation.

**Why:** A signed path can sum exactly to the pool while containing negative team payouts. Clamping those negatives only at publication makes the remaining positive payouts exceed the pool, producing a misleading conservation failure even when the signed totals print identically.

**How to apply:** Any simulation or replay that converts path-level scoring into payout economics must enforce nonnegative payable points first, then normalize the remaining positive points to the full pool. Final cent allocation remains a validation and rounding step, not a repair step.