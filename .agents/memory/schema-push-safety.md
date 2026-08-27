---
name: Schema push safety
description: Protect populated ownership, trade, position, and historical MTM data from destructive schema synchronization.
---

Never accept an auto-generated schema push when it proposes `TRUNCATE ... CASCADE`, dropping the ownership relation, or removing historical MTM rows to satisfy a new non-null column. Treat that as a failed schema-diff workflow, not as a migration plan.

**Why:** On populated tables, a push cannot safely invent backfill values. Its repair path can erase the ownership ledger, trade history, short positions, and opening market marks while leaving an apparently healthy empty application.

**How to apply:** Cancel the push. Use the project's guarded startup migration runner: add new foreign-key columns nullable, backfill from the canonical Calcutta entry mapping, verify zero nulls and exact row preservation, then enforce `NOT NULL`. Keep `team_bidders` as its read-only compatibility view and keep `calcutta_rules` as a separate scoring-configuration table.