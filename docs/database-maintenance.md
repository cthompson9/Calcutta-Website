# Database maintenance and recovery

## Safe schema changes

1. Make schema changes in `lib/db/src/schema`.
2. Run the development checks and apply the development schema with:
   ```sh
   pnpm run typecheck
   pnpm --filter @workspace/db run push
   ```
3. Verify the relevant API and UI flows against the development database.
4. Publish the app to apply the reviewed development-to-production schema diff.

Do not run ad-hoc production DDL, database push commands against production, or
startup-time migrations. The Publish flow is the supported production schema
change path and will surface destructive or rename operations for confirmation.

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

1. Record the intended recovery timestamp and affected scenario.
2. Restore a copy using the managed recovery workflow.
3. Verify the restored season, auction ownership, approved-trade audit history,
   results, and MTM snapshots.
4. Record recovery duration and any verification gaps, then update this
   checklist.

Never test recovery by overwriting the live production database.