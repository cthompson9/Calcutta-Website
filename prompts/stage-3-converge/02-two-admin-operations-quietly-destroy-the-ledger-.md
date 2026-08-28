# Two admin operations quietly destroy the ledger: a team delete and an event sync

_Audit finding P2-3._

Paste the block below to Replit as one task. Verify before moving on.

```
Two admin paths in artifacts/api-server destroy ledger data with no guard.

1. DELETE /api/teams/:id (routes/teams.ts:646-649) is a bare `delete from teams where id`
   with no check for existing positions, mtm_snapshots or snapshot_metrics rows and no audit
   record. Verified: one call removed 2 positions, 53 snapshot_metrics, 4
   team_period_snapshots and 1 team_results row. The only real protection is
   trades.entry_id ON DELETE RESTRICT, and Calcuttas I-XI will be loaded with no trades, so
   that protection is absent for every historical pool. Fix: refuse with 409 when any
   positions, mtm_snapshots or snapshot_metrics row exists for the team's entries; require
   an explicit confirmation flag in the body; write an ownership_adjustments audit row; and
   consider ON DELETE RESTRICT on positions.entry_id.

2. The delete in lib/nflEventSync.ts:245-257 filters on calcutta, entry, period and basis
   but NOT on source, and lines 220-230 select every NFL Calcutta in the season with no
   is_canonical filter. So one ESPN sync erases manually entered Week 18 realized metrics
   across all pools in that year, and routes/periods.ts:520-527 then refuses to let them be
   re-entered because the game ledger is authoritative. Losing a Week 18 realized baseline
   makes loadCalculatedTeamReturnsForCalcutta skip the basis entirely, so ALL returns for
   that pool disappear. Fix: add `source = 'nfl_games'` to the delete predicate, and scope
   the Calcutta selection to the canonical NFL pool.

Add regression tests for both.
```
