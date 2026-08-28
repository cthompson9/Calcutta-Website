# One period ladder per sport, and a bracket has no regular season for the playoff concept to contrast with

_Audit finding F-7._

Paste the block below to Replit as one task. Verify before moving on.

```
Give each competition format its own period ladder, and add the three missing adapters.

1. sport_periods is unique on (sport, competition, sequence), so version the
   competition_format string per era - no schema change needed:
     NFL_REGULAR_SEASON_18W  (2021+, the existing 23-period ladder)
     NFL_REGULAR_SEASON_17W  (<=2020)
     NCAA_MM_64              (Week 0, First Four [unscored], R64, R32, S16, E8, F4, Final)
     NBA_PLAYOFFS_16         (Week 0, R1, CSF, CF, Finals - with weights 1, 2, 4, 8)
     WORLD_CUP_48            (Week 0, 3 group matchdays, R32, R16, QF, SF, Final)
   Migrate the existing NFL rows to NFL_REGULAR_SEASON_18W in a guarded migration and keep
   NFL_REGULAR_SEASON as an alias so existing data and callers keep working.

2. Add a `kind` field to each period: 'regular' | 'group' | 'knockout'. The World Cup needs
   this - group matchdays allow draws and score +3/+1, while knockout uses a per-round rate
   table with no draws. A two-value regular/playoff flag cannot express that.

3. Add a `weight` field to each period for the NBA round multiplier (1/2/4/8). This is NOT
   the existing playoffMultiplier. None of these rubrics uses a playoff multiplier, so pin it
   to 1 in each new adapter's validateRules the way the NFL adapter does.

4. Mark the March Madness First Four periods as unscored - the rubric awards no points for a
   First Four win.

5. Remove the `adapter.sport === NFL_SPORT` branches in lib/calcuttaReturns.ts (around lines
   781, 806, 1425-1431) so every format goes through the generic allocator with its own
   configured normalization and periods. Today the NFL branch discards the configured adapter
   and uses module constants.
```
