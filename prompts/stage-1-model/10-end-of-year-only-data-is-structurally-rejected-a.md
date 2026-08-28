# End-of-year-only data is structurally rejected, and where you file it changes the payout

_Audit finding P1-4._

Paste the block below to Replit as one task. Verify before moving on.

```
Loading Calcuttas I-XI with end-of-year values only is currently structurally rejected.

1. routes/periods.ts:513-519 requires a Week 18 realized baseline before any playoff-period
   snapshot, so an end-of-year-only pool needs a fabricated Week 18 duplicate plus the real
   final row - 704 admin writes for 11 pools. Add a first-class "final result" concept: a
   completed historical Calcutta should accept ONE snapshot per team representing the
   season's final cumulative state, without a synthetic Week 18 twin. Note that filing an
   end-of-year result at sequence 18 vs 22 changes which values receive the playoff
   multiplier, so this must be explicit rather than left to the loader.

2. Fix lib/db/src/backfillPeriodSnapshots.ts. It crashes on real Calcutta names because
   line 175 handles only `on conflict (name)` while the actual collision is the
   calcuttas_canonical_season_sport_idx created by migration 0017 - use
   onConflictDoNothing() with no target. Critically, main() runs removeSparsePlayoffSnapshots
   and removeSparsePlayoffMetrics (lines 46-157) - two unbounded DELETEs against
   team_period_snapshots and snapshot_metrics - BEFORE that crash, outside any transaction
   and with no dry-run. Wrap the whole script in one transaction, add a --dry-run flag that
   reports counts without deleting, and print what was deleted.

3. docs/database-maintenance.md documents `pnpm --filter @workspace/db run
   backload-production-2026` as the selective-backload procedure and
   .agents/memory/seed-approach.md documents lib/db/src/seed2025.ts. Neither script exists
   anywhere in the repo. Either implement them or remove those sections so the docs stop
   describing tooling that isn't there.
```
