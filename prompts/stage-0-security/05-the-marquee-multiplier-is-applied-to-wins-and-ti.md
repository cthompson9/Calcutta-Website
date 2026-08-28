# The marquee multiplier is applied to wins and ties, which breaks the fixed denominator and over-distributes the pot

_Audit finding P0-1._

Paste the block below to Replit as one task. Verify before moving on.

```
In artifacts/api-server/src/lib/calcuttaReturns.ts (calculateNflPoints, ~line 767) and
artifacts/api-server/src/lib/competitionScoring.ts (nflPointMetricValues, ~line 345), the
NFL_MARQUEE_MULTIPLIER of 2 is currently applied to wins, ties AND point differential.

Per docs/calcutta-v2-agent-playbook.md line 53, the marquee multiplier applies ONLY to
point differential. The 11,420-point normalization denominator is arithmetically built on
one 10-point win unit per game (32 x 150 banked = 4800, plus 3900 playoff bonuses, leaves
2720 = 272 games x 10), so weighting wins and ties inflates league total points above the
denominator and over-distributes the pot.

Change both functions so that:
- win is scored from the raw win count (metrics.win / metrics.wins / snapshot.wins)
- tie is scored from the raw tie count
- pt_diff keeps the 2x marquee weighting exactly as it is today

Then add a regression test asserting that for ANY complete 272-game season with an
arbitrary number of marquee games, the sum of all 32 teams' points equals exactly the
adapter's normalizationDenominator. No existing test sums points across the league, which
is why 28 scoring tests pass today with this bug present.

Do not change the denominator, the banked points, or the playoff bonus values.
```
