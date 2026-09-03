# The engine has one normalization mode and your rubrics use three

_Audit finding F-2._

Paste the block below to Replit as one task. Verify before moving on.

```
The return engine supports only one normalization mode. calculateNflTeamValues
(artifacts/api-server/src/lib/calcuttaReturns.ts:806) and calculateCompetitionTeamValues
(lib/competitionScoring.ts:533-548) both compute share as
entry.points / adapter.normalizationDenominator against a fixed constant.

The four Calcutta formats use three different mechanisms:
  - NFL: points / fixed inventory (11,420 for 2021+, 11,260 for 2020, 11,160 for <=2019)
  - NBA playoffs: points / TOTAL POINTS EARNED by all entries (inventory ranges 224-493)
  - World Cup: same, presumably (inventory ranges 1,476-1,732)
  - March Madness: no points at all - the rubric names pool percentages directly
    (0.5/1/2/4/8/10% by round reached, plus two 5% bonus pools; sums to exactly 100%)

Replace normalizationDenominator on the CompetitionScoringAdapter
(lib/competitionScoring.ts:44-45) with a discriminated normalization mode:

  normalization:
    | { mode: "fixed_inventory"; denominator: number }
    | { mode: "earned_total" }
    | { mode: "direct_share" }

- fixed_inventory: today's behaviour, unchanged.
- earned_total: divide each entry's points by the sum of all entries' points at the period
  being valued. Handle a zero total explicitly - before the first game, either split equally
  across entries or report the period as unavailable. Never divide by zero, never return a
  silent 0.
- direct_share: rules yield pool fractions directly; skip normalization and assert the
  shares sum to 1.0 (within a cent) at a completed period.

Also make PUT /payout-rules (routes/periods.ts:355-380) reject normalization_denominator for
earned_total and direct_share formats instead of accepting and ignoring it.

Add a test per format: a simulated completed season's shares must sum to exactly 1.0.
```
