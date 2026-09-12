---
name: Coherent MTM versions
description: Rules for linking finalized actuals to the one current displayed MTM mark.
---

A pool’s displayed MTM must resolve through one validated current version that links an immutable successful non-review snapshot to the exact canonical finalized-game state. Promotion is candidate-first, atomic, serialized per pool, and must fail closed on incomplete team coverage, weak conditionals, mismatched games, or failed pool reconciliation.

Owner resolution uses signed ownership economics, including original cost basis and approved trade cash.

At most one post-anchor finalized game may use a stored one-game conditional. Two or more post-anchor finals must retain the prior valid MTM and publish a `pending_recalculation` version; one-game marginal swings must never be added or sequentially chained.

Finalized-actual refreshes compare canonical event identity, teams, week, and scores against the source snapshot after the event transaction commits. Corrections and incomplete/withdrawn evidence publish `pending_recalculation`; only one genuinely new, fully supported final may be provisional. Provider event rows are durable semantic identities and are updated or tombstoned, never deleted and recreated.

Displayed Results, normalized HTTP valuation, and MCP current team/owner valuation resolve dollars and associated metadata from the promoted coherent version only. Pipeline snapshots, histories, and projections are evidence unless explicitly tied to that version’s source snapshot; unavailable current versions fail closed.

The commissioner Recalculate action is an ordered full refresh: fetch and commit standings plus canonical events, reconcile actuals, then run MTM, validate and promote the successful snapshot, and refresh the display. If actuals refresh fails, MTM must not run.

**Why:** Stored conditionals are one-game marginals from the original simulation population, not a joint distribution. Combining them can produce unsupported economics, while separately advancing actuals and MTM creates internally inconsistent reports. Stable event IDs are also required to preserve immutable snapshot provenance and version linkage across provider corrections. Mixing promoted dollars with independently selected snapshot metadata or projections would recreate the same inconsistency at the read boundary.

**How to apply:** Route future actuals-refresh promotion and every Results/MCP valuation consumer through the shared current-version promotion and resolver boundary. Keep the commissioner button on the complete ordered refresh path. Do not duplicate team values in version rows or mutate referenced snapshot evidence.