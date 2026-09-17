---
name: Coherent MTM versions
description: Rules for linking finalized actuals to the one current displayed MTM mark.
---

A pool’s displayed MTM must resolve through one validated current version that links an immutable successful non-review snapshot to the exact canonical finalized-game state. Promotion is candidate-first, atomic, serialized per pool, and must fail closed on incomplete team coverage, weak conditionals, mismatched games, or failed pool reconciliation.

Canonical period selections and calendar projection records are official-publication artifacts, not successful-simulation evidence. Create them only inside the winning official-version promotion transaction, followed by a final lease-validity check before commit.

Owner resolution uses signed ownership economics, including original cost basis and approved trade cash.

At most one post-anchor finalized game may use a stored one-game conditional. Two or more post-anchor finals must retain the prior valid MTM and publish a `pending_recalculation` version; one-game marginal swings must never be added or sequentially chained.

Finalized-actual refreshes compare canonical event identity, teams, week, and scores against the source snapshot after the event transaction commits. Corrections and incomplete/withdrawn evidence publish `pending_recalculation`; only one genuinely new, fully supported final may be provisional. Provider event rows are durable semantic identities and are updated or tombstoned, never deleted and recreated.

Displayed Results, normalized HTTP valuation, and MCP current team/owner valuation resolve dollars and associated metadata from the promoted coherent version only. Live Tracker history starts with the complete, pool-conserving immutable Kalshi Week 0 baseline, then includes every distinct current or superseded coherent version source snapshot ordered by exact capture timestamp; it must not collapse multiple pulls into one weekly point. Pipeline snapshots and projections remain evidence unless explicitly tied to a promoted version’s source snapshot; unavailable current versions fail closed.

The commissioner Recalculate action starts a server-side job and polls its status so the full run can exceed the browser proxy’s request lifetime. The production engine has a 15-minute execution budget; killed processes must report their limit, signal, and stderr. Inside that job the order remains strict: fetch and commit standings plus canonical events, reconcile actuals, then run MTM, validate and promote the successful snapshot, and refresh the display. If actuals refresh fails, MTM must not run.

**Why:** Stored conditionals are one-game marginals from the original simulation population, not a joint distribution. Combining them can produce unsupported economics, while separately advancing actuals and MTM creates internally inconsistent reports. Stable event IDs are also required to preserve immutable snapshot provenance and version linkage across provider corrections. Mixing promoted dollars with independently selected snapshot metadata or projections would recreate the same inconsistency at the read boundary. A simulation can finish successfully but still fail freshness, linkage, lease, or publication validation; publishing canonical artifacts before those checks would falsely make it official.

**How to apply:** Route future actuals-refresh promotion and every Results/MCP valuation consumer through the shared current-version promotion and resolver boundary. Build chart history from the validated Week 0 baseline plus promoted source snapshots on a continuous time axis, using week names only as tick labels. Keep the commissioner button on the polled, complete ordered refresh path. Do not duplicate team values in version rows or mutate referenced snapshot evidence.