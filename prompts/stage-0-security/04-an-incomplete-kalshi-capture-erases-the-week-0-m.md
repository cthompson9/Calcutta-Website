# An incomplete Kalshi capture erases the Week 0 marks, then the app refills them with a flat fabricated value and latches there

_Audit finding P0-4._

Paste the block below to Replit as one task. Verify before moving on.

```
Three linked bugs in the Week 0 mark-to-market path in artifacts/api-server:

1. lib/jobMtmRefresh.ts:378 calls replaceMtmMetricRows unconditionally, but
   buildMtmMetricRows correctly returns [] when any team's Kalshi capture is incomplete.
   replaceMtmMetricRows (lib/mtmMetrics.ts:263) deletes before inserting, so an incomplete
   capture ERASES the previously good marks. Fix: skip replaceMtmMetricRows entirely when
   metricRows.length === 0, and log a warning naming the teams that were incomplete.

2. initializeNflWeekZeroSnapshots (lib/calcuttaReturns.ts:872-1000), which runs on every
   GET /results, then re-inserts an all-zero Week 0 MTM baseline that passes
   hasCompleteMtmMetricCoverage and publishes an identical 150-point mark for all 32 teams.
   Fix: only write the zero MTM baseline when no mtm_snapshots row exists for that entry.
   Additionally tag it source='week_zero' and treat that source as NON-authoritative in the
   MTM coverage check, so a real Kalshi capture is still attempted.

3. The refresh job's already-marked short-circuit at lib/jobMtmRefresh.ts:337-341 then
   sees 32 rows plus "complete" coverage and never repairs it. Fix: require at least one
   row whose source is kalshi (not week_zero) before treating the period as marked.

Separately, buildMtmMetricRows (lib/mtmMetrics.ts:188) blocks publication only on
marketStatus === "incomplete", so a "stale" mark (wide spread, thin top-of-book, quotes
older than MAX_QUOTE_AGE_MS) publishes silently. Propagate a marketStatus and
marketStatusReasons summary from snapshot_metrics.source_data through CalculatedPeriodReturn
into every MTM-bearing response (/results, /results/by-owner, /v2/owner/portfolio, the
consortium leaderboard) so the client can label an untrustworthy mark.

Add a test that an incomplete capture leaves the prior good marks intact.
```
