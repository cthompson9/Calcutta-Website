---
name: Coherent MTM versions
description: Rules for linking finalized actuals to the one current displayed MTM mark.
---

A pool’s displayed MTM must resolve through one validated current version that links an immutable successful non-review snapshot to the exact canonical finalized-game state. Promotion is candidate-first, atomic, serialized per pool, and must fail closed on incomplete team coverage, weak conditionals, mismatched games, or failed pool reconciliation.

Owner resolution uses signed ownership economics, including original cost basis and approved trade cash.

At most one post-anchor finalized game may use a stored one-game conditional. Two or more post-anchor finals must retain the prior valid MTM and publish a `pending_recalculation` version; one-game marginal swings must never be added or sequentially chained.

**Why:** Stored conditionals are one-game marginals from the original simulation population, not a joint distribution. Combining them can produce unsupported economics, while separately advancing actuals and MTM creates internally inconsistent reports.

**How to apply:** Route future actuals-refresh promotion and every Results/MCP valuation consumer through the shared current-version promotion and resolver boundary. Do not duplicate team values in version rows or mutate referenced snapshot evidence.