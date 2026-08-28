# The wide snapshot table is the recompute authority, the MTM writer doesn't update it, and your test database has already drifted

_Audit finding P2-2._

Paste the block below to Replit as one task. Verify before moving on.

```
team_period_snapshots (documented as a compatibility projection) and snapshot_metrics (the
normalized authority) can drift, and the projection is currently in charge.

1. rebuildNflRealizedSnapshots (artifacts/api-server/src/routes/periods.ts:83-95) determines
   which periods to recompute by querying team_period_snapshots. A period present in
   snapshot_metrics but missing from the wide table is therefore never refreshed again -
   verified with an A/B on the same entry. Rewrite that query to derive recompute scope from
   snapshot_metrics instead.

2. replaceMtmMetricRows (lib/mtmMetrics.ts:112-144), called from routes/mtm.ts:582-601 and
   lib/jobMtmRefresh.ts:378, writes only snapshot_metrics. Every other write path
   (nflEventSync.ts:307-336, periods.ts:136-155, periods.ts:580-596, mcpServer.ts:1408-1419)
   updates both tables. Make the MTM paths update both in the same transaction, per
   .agents/memory/week-zero-market-valuation.md.

3. Then plan to delete team_period_snapshots entirely - after step 1 it has no readers.
   That removes this whole class of drift rather than adding a reconciler.

4. Meanwhile, add a diagnostic endpoint that reports rows present in one ledger and absent
   from the other. The current dev database already has 960 snapshot_metrics rows at Week 18
   and the Super Bowl with zero corresponding wide rows, so those periods will never
   recompute. Run it against production before doing anything else.
```
