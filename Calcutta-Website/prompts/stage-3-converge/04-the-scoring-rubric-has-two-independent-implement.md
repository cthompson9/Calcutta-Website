# The scoring rubric has two independent implementations held equal only by one parity test

_Audit finding P2-5._

Paste the block below to Replit as one task. Verify before moving on.

```
Consolidate the duplicated NFL scoring logic in artifacts/api-server/src/lib.

1. calculateNflPoints (calcuttaReturns.ts:763-793) and nflPointMetricValues +
   calculatePointsUnchecked (competitionScoring.ts:344-369, 489-509) are two
   implementations of one rubric, chosen at runtime on adapter.sport === NFL_SPORT. They
   already differ in the no-breakdown fallback key (snapshot.wins vs metrics.win ??
   metrics.wins), and only competitionScoring.test.mjs:69,88 keeps them in step. Delete
   calculateNflPoints and route NFL through the generic allocator with an NFL
   pointMetricValues, so there is one code path.

2. The marquee weighting `ordinary + 2 * marquee` is written longhand in five places
   (competitionScoring.ts:355,358,361; calcuttaReturns.ts:772,775,778; periods.ts:129,150;
   nflEventSync.ts:290) and inverted at periods.ts:547. Extract one helper and use it
   everywhere.

3. The marquee window is `13*60` to `19*60` in competitionScoring.ts:281 but described as
   prose ("Sunday 1:00-7:00 PM Eastern") at v2Agent.ts:800. Derive that description from
   the constants so it cannot drift.

4. Playoff period labels exist in four spellings: NFL_PERIOD_TEMPLATE
   (competitionScoring.ts:113-116), a re-declaration in
   lib/db/src/backfillPeriodSnapshots.ts:15-23, `Playoff Week ${n-18}` at routes/mtm.ts:201
   and `Playoff Wk ${n-18}` at mcpServer.ts:1644 - so the Super Bowl displays as "Playoff
   Week 4". Use NFL_PERIOD_TEMPLATE everywhere.

5. getOrCreateCalcuttaEntry is defined twice with different signatures: positional
   (writer, calcuttaId, teamId) at lib/calcuttaContext.ts:93 and object-argument at
   lib/calcuttaReturns.ts:1068, each with its own importers. Keep one.

6. Delete these zero-caller exports, two of which are dangerous season-scoped shadows of
   the Calcutta-scoped functions a future caller would actually want:
   hasConfiguredPayoutRules (calcuttaReturns.ts:1107), loadCalculatedTeamReturns
   (calcuttaReturns.ts:1189), calculateCompetitionPoints (competitionScoring.ts:511),
   syncNflEventsAndRealizedMetrics (nflEventSync.ts:423), formatPercentage
   (nfl-auction/src/lib/utils.ts:17), and the calculateReturnFromSnapshots delta engine
   (calcuttaReturns.ts:529-553), which is referenced only by its own test despite
   .agents/memory/period-return-model.md describing it as the return model. If you keep the
   delta engine, wire it into the generic allocator - otherwise reject a non-1
   playoffMultiplier in validateGenericRules (competitionScoring.ts:186-194), which
   currently stores the value and never reads it.
```
