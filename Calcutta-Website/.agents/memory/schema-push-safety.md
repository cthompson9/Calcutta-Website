---
name: Schema push safety
description: Protect populated ownership, trade, position, and historical MTM data from destructive schema synchronization.
---

Never accept an auto-generated schema push when it proposes `TRUNCATE ... CASCADE`, dropping the ownership relation, or removing historical MTM rows to satisfy a new non-null column. Treat that as a failed schema-diff workflow, not as a migration plan.

**Why:** On populated tables, a push cannot safely invent backfill values. Its repair path can erase the ownership ledger, trade history, short positions, and opening market marks while leaving an apparently healthy empty application.

**How to apply:** Cancel the push. Use the project's guarded startup migration runner: add new foreign-key columns nullable, backfill from the canonical Calcutta entry mapping, verify zero nulls and exact row preservation, then enforce `NOT NULL`. Keep `team_bidders` as its read-only compatibility view and keep `calcutta_rules` as a separate scoring-configuration table.

Drizzle-kit 0.31 introspection does not preserve PostgreSQL `UNIQUE NULLS NOT DISTINCT`. Keep the stronger modifier in its guarded migration and use a plain named `unique(...)` schema declaration so push recognizes the populated constraint instead of trying to replace it.

**Why:** Declaring `.nullsNotDistinct()` made push offer to truncate a populated normalized scoring ledger even though the live constraint was already correct.

**How to apply:** Before changing this workaround, verify a newer drizzle-kit pull preserves `NULLS NOT DISTINCT` and that two consecutive guarded pushes remain empty.

PostgreSQL truncates identifiers at 63 bytes, while Drizzle can continue comparing against its longer generated foreign-key name. Give potentially long foreign keys explicit short names and rename existing constraints in a guarded migration rather than allowing push to drop and recreate them.

**Why:** A clean schema dump still produced repeated FK drop/add statements solely because PostgreSQL had truncated six generated names.

**How to apply:** Treat any generated constraint name near the PostgreSQL identifier limit as unstable. Use explicit names in the schema, preserve the constraint structurally during migration, and require the isolated baseline push check to report no DDL.