# A read endpoint takes a season-wide write lock on every request

_Audit finding P2-6._

Paste the block below to Replit as one task. Verify before moving on.

```
artifacts/api-server/src/routes/results.ts:71-81 (ensureWeekZeroReportingBaseline) opens a
write transaction and takes pg_advisory_xact_lock on the ownership season lock namespace,
and it runs on every GET /results (line 491) and GET /results/availability (line 818). Read
requests therefore serialize against each other and against every ownership write.

Fix: check whether the Week 0 baseline already exists with a plain read first, and take the
lock and open the write transaction only when it genuinely needs creating. Better still,
move baseline creation to an explicit step at Calcutta creation time so the read path never
writes at all.

Also move the pg_advisory_xact_lock in POST /api/trades (routes/trades.ts:285) to AFTER the
team and Calcutta validation, so an invalid request cannot serialize against real ownership
writes.
```
