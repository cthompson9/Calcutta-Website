# A deterministic logical snapshot exporter, and the read-only role that runs it

There is currently no export path in the repository. This task creates the primary recovery
artifact. Nothing else in this stage may ship until it does.

Paste the block below to Replit as one task. Verify before moving on.

```
Create a logical snapshot exporter at lib/db/src/scripts/exportSnapshot.ts, wired to a new
"export-snapshot" script in lib/db/package.json. Follow the invocation pattern already used by
the "load-historical-calcuttas" script in that file.

PURPOSE. This produces a deterministic, human-readable JSON snapshot of every row in the
database, committed nightly to a git repository. A separate pg_dump covers exact-fidelity
restore. This file covers inspection and partial recovery, so the readability of a git diff
between two consecutive snapshots is a hard requirement, not a nicety. A diff must let a reader
identify exactly which rows disappeared between two nights.

REQUIREMENTS.

1. Derive the table list at runtime from the exports of lib/db/src/schema/index.ts. Do not
   hardcode a table list anywhere in this file. After assembling the export, query
   information_schema.tables for every BASE TABLE in the public schema and compare. Exit with a
   non-zero status and a message naming the offenders if any table exists in the database but is
   absent from the export. Exclude views: team_bidders is a pgView and must not be exported.
   This guard is the main point of the requirement — a table added in six months must not be
   silently missing from backups.

2. Omit surrogate primary keys and updated_at columns from the output entirely.

3. Resolve every foreign key to the referenced row's natural key rather than its integer id:
   - team_id           -> team name
   - bidder_id         -> bidder name
   - season_id         -> season year
   - calcutta_id       -> calcutta name
   - entry_id          -> the tuple (calcutta name, team name)
   - period_id         -> the tuple (sport, sequence)
   - consortium_id     -> consortium name
   - event_id          -> the tuple (season year, week, away team name, home team name)
   Read .agents/memory/trade-recovery-authority.md before implementing this. Database ids are
   not identities across migrations, so an id-based export produces a diff in which every row
   appears changed after any renumbering, which destroys the artifact's only real purpose.
   If a foreign key cannot be resolved to a natural key, fail loudly rather than emitting the id.

4. Deterministic serialization:
   - object keys sorted alphabetically at every level
   - rows within a table sorted ascending by their full natural-key tuple
   - each row object serialized onto exactly one line, so one changed row is one changed line
   - no trailing whitespace, file ends with a single newline

5. Emit a top-level "meta" object containing: generatedAt as an ISO 8601 string, a per-table row
   count map, a per-table serialized byte size map, and a sha256 hex digest of the serialized
   "data" object computed with "meta" excluded.

6. Print the per-table row counts and byte sizes to stdout in a readable table on completion.

7. Read the connection string from BACKUP_DATABASE_URL when set, falling back to DATABASE_URL.

8. Write to a path given as the first positional argument, defaulting to ./snapshot.json.

SECOND DELIVERABLE. Create reference/backup-role.sql containing DDL for a read-only role named
calcutta_backup: CREATE ROLE with LOGIN, GRANT CONNECT on the database, GRANT USAGE on schema
public, GRANT SELECT on all tables in schema public, and ALTER DEFAULT PRIVILEGES so tables
created later are covered automatically. Leave a comment at the top noting the password must be
supplied at run time and never committed. Do not execute this file.

ACCEPTANCE.
- `pnpm --filter @workspace/db run export-snapshot` against the development database exits 0 and
  prints the count table.
- Run it twice with no intervening data change into two different paths. The two files must be
  byte-identical. `diff` them to prove it.
- The row counts for the 2026 season must match the figures recorded in
  docs/database-maintenance.md under "Verified 2026 development backload": 32 teams and
  auctions, 48 primary ownership rows, 13 referenced bidders, 45 trades, 32 team results, 32 MTM
  snapshots, 82 ownership audit records. Report any table where your count disagrees; do not
  adjust the exporter to force a match.
- Create a scratch table in the development database, re-run, and confirm the run exits non-zero
  naming that table. Then drop the scratch table.
```

## Verify before moving on

Byte-identical repeat runs are the acceptance test that matters most. If two consecutive runs
differ, the nightly diff will be noise and every downstream task in this stage loses its value.

Once this lands, run `reference/backup-role.sql` against production yourself with a generated
password, then add the resulting connection string to repository secrets as
`BACKUP_DATABASE_URL`.
