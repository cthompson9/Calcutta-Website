# The point inventory and period ladder are NFL-2021-shaped and applied to every season

_Audit finding P1-6._

Paste the block below to Replit as one task. Verify before moving on.

```
Make the NFL scoring model season-aware before loading pre-2021 Calcuttas.

1. lib/db/src/schema/sportPeriods.ts is unique on (sport, competition, sequence) with no
   season scope, so there is one global NFL period ladder (23 rows, sequences 0-22) applied
   to every year. A 2015 pool gets a Week 18 that never existed. Add a nullable season_id
   (or move the ladder onto a per-competition-format definition on calcuttas) so a 16-game
   / 17-week season can have its own periods. Use a guarded migration, not drizzle push.

2. Move LEAGUE_POINT_TOTAL (11_420) and REGULAR_SEASON_GAMES (272) out of
   lib/weekZeroValuation.ts:1-2 and into per-Calcutta configuration read through the
   scoring adapter, defaulting to today's values for 2021+ NFL pools. Per
   .agents/memory/period-return-model.md the denominator must be owned by each sport's
   scoring model and passed into shared allocation code.

3. nflPointMetricValues (lib/competitionScoring.ts:344-356) decides whether a snapshot has
   a marquee breakdown by checking whether ANY of six breakdown fields is non-zero. A bulk
   loader writing SQL directly that supplies wins=9 and a non-zero marquee_pt_diff but
   leaves ordinary_wins/marquee_wins at 0 gets hasBreakdown=true and scores win = 0 + 2*0
   = 0 - nine wins worth zero points, silently. Replace the heuristic with an explicit
   nullable flag or column on the snapshot, and reject a snapshot that has partial
   breakdown data.

4. lib/competitionScoring.ts:385 selects the required-metric set with
   NFL_REALIZED_METRICS.slice(0, 10) - positionally. Adding or reordering an entry in
   NFL_REALIZED_METRICS (lines 88-104) silently changes which metrics the completeness gate
   demands, with no type error. Name the required metrics explicitly.
```
