# The scored-metric vocabulary is a hardcoded NFL list selected positionally

_Audit finding F-5._

Paste the block below to Replit as one task. Verify before moving on.

```
Make the scored-metric vocabulary and the rule vocabulary properties of the competition
format instead of hardcoded NFL lists.

Today artifacts/api-server/src/lib/competitionScoring.ts defines NFL_RETURN_METRICS and
NFL_REALIZED_METRICS as fixed const arrays (lines 76-104) and selects the required set
positionally with NFL_REALIZED_METRICS.slice(0, 10) at line 385 - so adding or reordering an
entry silently changes which metrics the completeness gate demands. Move the metric list into
each format's definition and name required metrics explicitly.

Then implement these rule kinds, which together cover all four Calcutta rubrics:
  per_unit           metric x rate                     (NFL win/tie/pt_diff; WC pool win +3, tie +1)
  per_unit_weighted  metric x rate x period weight     (NBA game win x round 1/2/4/8)
  state_bonus        flat award for reaching a state    (WC +5 advance, +5 first in group; NBA +15 sweep)
  outcome_tier       rate by outcome type AND round     (WC knockout win 10/20/50/100/200,
                                                         shootout loss 2/4/10/20/40)
  predicate_bonus    award when a predicate holds       (NBA +10 underdog conference series;
                                                         MM upset by seed gap)
  group_rank_bonus   top scorer in a subgroup, split    (WC +48 per seeding pot)  [see F-1]
  split_pool         pool share / qualifying count      (MM 5% among 3+ seed upsets)  [see F-1]
  direct_share       value IS a pool fraction           (MM advancement payouts)

Two things to get right:
- The NBA round multiplier is NOT the existing playoffMultiplier (one scalar on playoff-period
  deltas). Add a per-period weight to the period definition so R1/R2/R3/Finals carry 1/2/4/8.
- The World Cup knockout table is two-dimensional (outcome type x round), not one rate per
  metric.

Also make point differential optional - most Calcuttas do not use the mechanic. A format
without it should omit the metric entirely rather than carrying a zero rate, per
.agents/memory/v2-agent-value-completeness.md.
```
