# Two of your rubrics can't value a team without looking at every other team, and the engine scores one entry at a time

_Audit finding F-1._

Paste the block below to Replit as one task. Verify before moving on.

```
The scoring engine in artifacts/api-server/src/lib/competitionScoring.ts scores each entry
independently: pointMetricValues(metrics) is a pure function of one entry's own metrics, and
calculateCompetitionTeamValues maps over entries. Two Calcutta rubrics cannot be expressed
that way and need a second, cross-entry pass:

  - World Cup pot bonus: the highest base scorer in each of 4 seeding pots gets +48 points,
    split on ties, explicitly excluding the bonus itself from the comparison.
  - March Madness upset pools: 5% of the pool split among every upset of 3+ seed positions,
    and another 5% among every upset of 8+ positions - cascading to 7+, then 6+, etc. if
    none qualify. One team's payout depends on the number of qualifying upsets across the
    whole tournament.

Restructure the allocator into two explicit passes:

  pass 1  scoreEntry(entry)                -> base points (or direct pool share)
  pass 2  applyCrossEntryRules(allResults) -> group_rank_bonus and split_pool awards

Both passes must run inside the same transaction against the same snapshot period, so two
entries can never be valued against different views of the tournament.

Add two rule kinds to the adapter's rule vocabulary:
  group_rank_bonus: { groupAttribute: 'pot', award: 48, tie: 'split' }
  split_pool:       { poolShare: 0.05, qualifier: , fallbackChain: [...] }

State the rounding rule explicitly rather than letting float arithmetic decide: 5% of a pool
split among 7 upsets does not divide evenly. Round to cents and assign the remainder
deterministically (e.g. to the earliest-round qualifying upset), and add a test asserting
that the sum of all awarded shares is exactly the pool share, never a cent more or less.
```
