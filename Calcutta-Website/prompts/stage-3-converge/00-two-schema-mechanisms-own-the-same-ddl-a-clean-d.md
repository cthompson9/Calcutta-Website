# Two schema mechanisms own the same DDL: a clean database can't be built, and a routine push drops the ownership-integrity index

_Audit finding P2-1._

Paste the block below to Replit as one task. Verify before moving on.

```
lib/db/src/schema/* (used by drizzle-kit push) and lib/db/src/migrations/* (replayed at API
startup by lib/db/src/migrate.ts) both own the same DDL. Fix in this order.

1. URGENT: declare positions_primary_entry_bidder_idx in lib/db/src/schema/positions.ts as
   uniqueIndex("positions_primary_entry_bidder_idx").on(entryId, bidderId).where(
   sql`source = 'primary'`). It currently exists ONLY in migration 0013's raw SQL, so
   `drizzle-kit push` drops it - verified, push emitted DROP INDEX with no prompt - and
   because 0013 is already recorded as applied the startup runner never restores it. That
   index is the guarantee that a bidder holds one primary auction position per entry.
   Then audit every other migration-only object the same way (the two positions triggers
   and consortium_memberships_no_overlap survive only because drizzle-kit ignores triggers
   and exclusion constraints).

2. Make push converge so the Publish diff can be trusted. Two statements are re-emitted on
   every run: the mcp_oauth_authorization_codes client_id FK (drizzle's generated name
   exceeds Postgres's 63-char identifier limit so the names never match - give it an
   explicit short name) and `ALTER TABLE trades ALTER COLUMN entry_id SET DEFAULT null`
   (drop the .default(sql`null`) in schema/trades.ts). Then add a CI check that the push
   diff is empty.

3. Collapse the migration chain into a baseline so a clean database can be built. Today the
   documented flow (push, then start) crashes three times in a row: 0013 does
   `lock table team_bidders` but schema/teamBidders.ts declares it as pgView(...).existing()
   so push never creates it; 0014 creates mtm_entry_date_idx and mtm_entry_key_idx without
   `if not exists`; 0019 re-adds snapshot_metrics_calcutta_id_calcuttas_id_fk. Snapshot the
   current schema as a baseline, and change migrate.ts so that: an empty
   app_schema_migrations against a non-empty DB stamps all 15 versions as applied; an empty
   table against an empty DB runs the baseline. After that, only add forward migrations for
   DDL the Drizzle schema does NOT also express (triggers, functions, partial and exclusion
   constraints), and add a checksum column so an edited migration is detected.

4. Retire team_bidders entirely - the view and its pgView declaration. Nothing reads it.

5. Reconcile the docs: docs/database-maintenance.md says never run startup migrations while
   .agents/memory/schema-push-safety.md says to use the guarded startup migration runner.
   The code does the latter. Make the docs agree.
```
