# Eliminated teams break the rule that every entry must be marked at the same period

_Audit finding F-8._

Paste the block below to Replit as one task. Verify before moving on.

```
loadCalculatedTeamReturnsForCalcutta (artifacts/api-server/src/lib/calcuttaReturns.ts:
1421-1426) requires every entry in a Calcutta to have snapshot coverage at the same period
sequence, and silently drops the whole basis otherwise.

That works for a league where all 32 teams play every week. It breaks for an elimination
bracket: after round 1 of a 64-team March Madness pool, 32 teams never play again, so no
later round ever has complete coverage and every return disappears.

Fix one of two ways and say which in a comment:
(a) When the format is an elimination bracket, have the snapshot writer carry forward each
    eliminated entry's cumulative totals into every subsequent round. Cumulative snapshots
    make the values correct automatically - an eliminated team's totals simply stop changing.
(b) Teach the coverage check about elimination: an entry with no remaining events in the
    format is covered by its last snapshot.
(a) is simpler and keeps the coverage rule honest; (b) writes far fewer rows.

Two related NFL assumptions to make format-aware while you're here:
- routes/periods.ts:513-519 requires a sequence-18 realized baseline before any
  playoff-period snapshot. Derive the required baseline period from the adapter's period
  template instead of hardcoding 18.
- calcuttaAsOfDate (lib/calcuttaReturns.ts:40-42) hardcodes August 1 as the consortium
  membership anchor. That is meaningless for a March tournament or a June-July World Cup, and
  it decides which consortium each owner is attributed to for the entire historical report.
  Move the anchor onto the Calcutta (as_of_date already exists on the calcuttas table) and
  require it to be set when a non-NFL pool is created.
```
