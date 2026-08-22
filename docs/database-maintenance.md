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

## Import operations

- Auction imports require a complete 32-team source and are serialized per
  season.
- Every completed import records its source fingerprint and request metadata.
  Repeating the same source is intentionally a no-op.
- A changed import is blocked after approved trades exist; use correcting
  trades instead of replacing historical primary ownership.

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