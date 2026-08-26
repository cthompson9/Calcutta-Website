---
name: Legacy trade entry derivation
description: Safe transition rule for assigning entry IDs to legacy NFL trade writes.
---

Until trade writes become entry-first, derive a missing `entry_id` only from exactly one canonical **NFL** Calcutta for the trade's season. Non-NFL or noncanonical Calcuttas must not participate in that fallback. Direct entry-based writes may still target any matching Calcutta entry.

**Why:** Historical seasons can contain multiple sport-specific Calcuttas, and some legacy non-NFL records are marked canonical. A season/team-only lookup can attach a trade to the wrong pool or make an otherwise valid migration look ambiguous.

**How to apply:** Keep the migration backfill, trigger fallback, and regression coverage aligned on the same canonical-NFL cardinality rule. Fail explicitly for zero or multiple canonical NFL matches; Phase 2 should remove this fallback by requiring `entry_id` from application write paths.