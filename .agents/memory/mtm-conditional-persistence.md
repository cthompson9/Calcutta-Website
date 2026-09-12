---
name: MTM conditional persistence
description: Why high-cardinality conditional payout rows require bounded database insert batches.
---

Persist full-season MTM conditional payout matrices in bounded insert batches while retaining one atomic publication transaction.

**Why:** A single Drizzle insert for the complete regular-season matrix can contain tens of thousands of rows and overflow Node's call stack while constructing the query, before PostgreSQL executes it.

**How to apply:** Any increase in games, outcomes, teams, or conditional dimensions must preserve bounded insert sizes. Do not replace the batched writes with one bulk values call.