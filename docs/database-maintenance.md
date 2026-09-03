# Database maintenance and recovery

## Safe schema changes

This project deliberately has two schema mechanisms with separate ownership:

- `lib/db/src/schema` owns every Drizzle-expressible table, column, default,
  primary/foreign/check constraint, and ordinary or unique index. A
  `drizzle-kit push` must converge to an empty diff after guarded migrations
  have run.
- `lib/db/src/migrations` owns ordered data backfills and DDL that
  drizzle-kit cannot represent or safely introspect: extensions, PostgreSQL
  exclusion constraints, trigger functions and triggers, migration-defined
  compatibility/reporting views, and forward constraint renames.

The API calls `runDatabaseMigrations()` at startup before serving requests.
Those migrations are versioned in `app_schema_migrations`, transactionally
guarded, and safe to retry; they are the supported owner for the
migration-only categories above.

1. Declare every Drizzle-expressible schema change in `lib/db/src/schema`.
   Add a guarded forward migration only when existing data or object names
   must be backfilled, validated, or renamed before the schema diff.
2. Run the development checks, restart the API so guarded migrations apply,
   and then verify schema convergence:
   ```sh
   pnpm run typecheck
   pnpm --filter @workspace/db run push
   ```
   Stop without accepting the push if it proposes dropping or truncating any
   populated relation or integrity object. Run it a second time and require
   another empty diff.
3. Verify the relevant API and UI flows against the development database.
4. Publish the app to apply the reviewed development-to-production schema diff.

Do not run ad-hoc production DDL, database push commands against production, or
unversioned startup DDL. The Publish flow is the supported production schema
change path and will surface destructive or rename operations for confirmation.

The `Schema convergence` workflow loads `reference/schema-baseline.sql` into an
isolated PostgreSQL 16 service and asserts that the committed Drizzle schema
produces no DDL from `drizzle-kit push`; it also fails when the baseline is more
than 90 days old. Any intentional schema change must include a regenerated,
reviewed baseline in the same pull request, and the workflow never connects to
production or requires a repository secret.

## Phase 1 release gate

The Phase 1 ownership/MTM release remains development-only until the normal
production Publish flow has a recoverable backup and its schema preview has
been reviewed. Do not use `drizzle-kit push`, overwrite production data, or run
interactive production DDL for this release.

Before publishing, development must have applied
`0024_phase1_release_safety_v1`. That migration verifies non-empty
`team_bidders` coverage against primary positions, trade and MTM entry
round-trips, protected row-count preservation, and the complete canonical NFL
rule seed for 2025 and 2026. A failed gate is a release blocker; it must not be
bypassed. The populated `team_period_snapshots` table remains preserved, and
the legacy stored-return columns remain in place for a later, separately gated
migration after calculated returns have served real traffic.

## Legacy consortium membership bridge (completed)

The production move from the legacy `bidders.consortium_id` relation to dated
`consortium_memberships` used this bridge release:

1. Publish the additive schema with both the legacy column and the new
   membership table present. Do not accept a Publish diff that removes the
   populated legacy column.
2. Run the ADMIN_API_KEY-protected
   `migrate_legacy_consortium_memberships` MCP tool. It copies every named
   legacy assignment into an open-ended membership, validates the result in
   one transaction, and is safe to retry.
3. Confirm the migrated bidder and consortium-name counts in production.
4. Only in a later release, remove the legacy column and the temporary
   compatibility fallback after production validation is complete.

During the bridge, a legacy name is used only for a bidder with no dated
membership history. Once any membership exists, including a dated clear,
the dated record is authoritative.

Never use the Publish UI's overwrite-data option for this transition: it
replaces production data rather than copying the needed assignments.

Production validation completed with 15 bidder assignments, 11 consortiums,
and `1900-01-01` as the earliest membership date. The temporary fallback and
one-shot migration operation are removed in the cleanup release.

## Import operations

- Auction imports require a complete 32-team source and are serialized per
  season.
- Every completed import records its source fingerprint and request metadata.
  Repeating the same source is intentionally a no-op.
- A changed import is blocked after approved trades exist; use correcting
  trades instead of replacing historical primary ownership.

## Selective production backloads

When production data is needed for development or staging validation, keep the
production database read-only and copy only the approved season slice. Take a
recoverable target backup or checkpoint first, preserve every other development
season, and map shared teams, bidders, and consortiums by their stable names
rather than database IDs.

- Record the source fingerprint, imported row counts, and caller in
  `import_runs` so the backload can be audited and retried safely.
- Import auction ownership, trades, results, MTM history, and ownership audits
  in a single target transaction; do not overwrite other seasons.
- Rebuild derived Calcutta entries and signed positions locally from the
  imported auction and approved-trade ledger, then verify every auctioned team
  has a signed ownership total of exactly 100%.
- Production may be on an older schema. Do not fabricate absent data such as
  period snapshots or payout rules; record those source gaps and use the
  supported local derivation only for data that can be reproduced from the
  imported records.
- Treat imported bidder and consortium data as production participant data and
  restrict staging access accordingly.

Run the 2026 backload with a protected snapshot file that is not committed to
the repository:

```sh
pnpm --filter @workspace/db run backload-production-2026 -- /secure/path/production-2026.json
```

The command is idempotent for an identical source fingerprint. A changed source
is refused once the target season has approved trades.

### Verified 2026 development backload

On 2026-08-22, the authorized 2026 production snapshot was loaded into the
writable development database with source SHA-256:

`e658dd202735cdefeb5973a12d76e4c37c99f24b834698be562e8e9ae7cc91e7`

The transaction recorded an `import_runs` provenance row and validated the
following source-aligned counts:

| Record type | Count |
| --- | ---: |
| Teams and auctions | 32 |
| Primary ownership rows | 48 |
| Referenced bidders | 13 |
| Trades | 45 |
| Team results | 32 |
| MTM snapshots | 32 |
| Ownership audit records | 82 |

The source did not contain Calcuttas, Calcutta entries, normalized positions,
dated consortium memberships, payout rules, or period snapshots. The
development backload created the canonical 2026 Calcutta and 32 entries, then
rebuilt 120 normalized positions from the 48 primary ownership rows and 36
approved trades. All 32 teams reconciled to 100% signed ownership. The 2025
development season remained at 32 auctioned teams, 7 owners, and no trades.

## Routine health checks

- Review API errors for database pool timeouts or idle-client errors.
- Keep write operations transactional and season-locked when they affect
  primary ownership, approved trades, auction prices, results, or MTM history.
- Before introducing a new database constraint, run a read-only data audit for
  rows that would violate it.
- Re-run the API and database regression suites after schema or write-path
  changes.

## Recovery drill

Replit-managed production databases provide point-in-time recovery. At least
once per quarter, perform a documented, non-destructive restore drill using a
staging or disposable target:

### Restore procedure

Use a disposable database, never the live production database. The nightly
backup workflow publishes:

- `snapshots/snapshot-YYYY-MM-DD.json` — deterministic logical snapshot
- `schema/schema-YYYY-MM-DD.sql` — schema-only reference dump
- GitHub release `backup-YYYY-MM-DD` — compressed full SQL dump

The full dump is generated with `--clean --if-exists` so it can restore over an
empty database whose `public` schema already exists. The workflow injects
`reference/restore-prelude.sql` immediately after the dump recreates `public`.
The prelude covers every extension in the production inventory:

- `plpgsql` 1.0
- `btree_gist` 1.7, required by
  `consortium_memberships_no_overlap` from migration `0012`

Download the release artifact and restore it with `ON_ERROR_STOP` enabled:

```sh
export BACKUP_REPOSITORY='cthompson9/Calcutta-Backups'
export BACKUP_DATE='YYYY-MM-DD'             # exact drill artifact date
export TARGET_DATABASE_URL='postgresql://...' # disposable target only
mkdir -p "/tmp/calcutta-restore-$BACKUP_DATE"
gh release download "backup-$BACKUP_DATE" \
  --repo "$BACKUP_REPOSITORY" \
  --pattern "dump-$BACKUP_DATE.sql.gz" \
  --dir "/tmp/calcutta-restore-$BACKUP_DATE"

gzip --decompress --stdout \
  "/tmp/calcutta-restore-$BACKUP_DATE/dump-$BACKUP_DATE.sql.gz" |
  psql -X -v ON_ERROR_STOP=1 --dbname="$TARGET_DATABASE_URL"
```

The full dump deliberately contains no grants or default-privilege statements;
those belong to the target environment and are excluded with `--no-privileges`.
After the data restore, recreate the target's backup role and access grants as a
database administrator using the existing reference script:

```sh
export TARGET_DATABASE_NAME='disposable_calcutta'
psql -X -v ON_ERROR_STOP=1 \
  -v DBNAME="$TARGET_DATABASE_NAME" \
  --dbname="$TARGET_DATABASE_URL" \
  -f reference/backup-role.sql
```

`reference/backup-role.sql` prompts for the new `calcutta_backup` password,
grants table and sequence access, and installs the matching default privileges
for `neondb_owner`. Do not copy production role passwords into the restore
target.

`psql -v ON_ERROR_STOP=1` is mandatory. Without it, `psql` logs a restore
error, continues, and exits zero, producing a silently partial restore in
which later constraints are skipped.

### Post-restore verification

Record the intended recovery timestamp, affected scenario, exact release tag,
restore duration, and the commands used. Verify both data and database
integrity; row counts alone are insufficient:

```sh
psql -X -v ON_ERROR_STOP=1 --dbname="$TARGET_DATABASE_URL" <<'SQL'
SELECT 'rows' AS check_group, 'calcutta_entries' AS object_name, count(*) AS count
FROM public.calcutta_entries
UNION ALL
SELECT 'rows', 'trades', count(*) FROM public.trades
UNION ALL
SELECT 'rows', 'mtm_snapshots', count(*) FROM public.mtm_snapshots
UNION ALL
SELECT 'constraints', 'public', count(*)
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE n.nspname = 'public'
UNION ALL
SELECT 'indexes', 'public', count(*)
FROM pg_index i
JOIN pg_class r ON r.oid = i.indrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE n.nspname = 'public';
SQL
```

Compare the constraint and index counts against the corresponding DDL in the
committed schema-only dump. For a stronger check, run the schema-only dump on
a second disposable database using the same prelude, query the same
`pg_constraint` and `pg_index` counts there, and require the restored target
to match before declaring the drill successful. Also verify the restored
season, auction ownership, approved-trade audit history, results, and MTM
snapshots against the logical snapshot.

### Restore drill record — 2026-09-02

The supplied drill report did not identify the release tag used, so the exact
tag remains **not recorded** and must be filled from the drill run before this
record is treated as complete.

Findings and resolutions:

1. **Sequence permissions.** `calcutta_backup` could not read
   `bidders_id_seq`, causing `pg_dump` to fail. Production was corrected with
   `GRANT SELECT ON ALL SEQUENCES`, and `reference/backup-role.sql` now also
   grants matching default privileges for `neondb_owner`.
2. **Existing `public` schema.** A fresh restore failed because PostgreSQL 15+
   emitted `CREATE SCHEMA public`. The full dump now uses
   `--clean --if-exists`; the schema-only dump deliberately does not.
3. **Missing `btree_gist` extension — severe.** The restore reached
   `consortium_memberships_no_overlap`, failed because the GiST operator class
   was unavailable, and silently skipped later constraints when `psql` did not
   use `ON_ERROR_STOP`. The full dump now contains the self-sufficient restore
   prelude, including both production extensions, before table constraints.
4. **Row counts masked integrity loss.** The drill restored more than 15,000
   rows but only 3 of 44 natural keys. The documented verification now checks
   `pg_constraint` and `pg_index` counts in addition to representative data
   counts and logical-snapshot reconciliation.
5. **Target-role privileges were not portable.** The dump attempted to execute
   `ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner` and failed on the final
   statement. The full dump now uses `--no-privileges`; restore targets must
   recreate `calcutta_backup` and its grants with `reference/backup-role.sql`.

Never test recovery by overwriting the live production database.