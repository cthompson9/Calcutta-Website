# The rubrics, as settled

Written down properly for the first time. Everything here was either stated by the pool owner
or derived from a workbook and verified against its own numbers. Where a pool's workbook
disagrees with the rule, that is recorded in `OPEN-DECISIONS.md` rather than silently
reconciled.

---

## Normalization — three modes, chosen per pool, not per sport

| Mode | Share formula | Pools |
|---|---|---|
| `fixed_inventory` | `points ÷ a fixed denominator` | VIII (NFL 2025), XII |
| `earned_total` | `points ÷ total points earned by all entries` | VII, X (NBA), XI (World Cup) |
| `direct` | rules yield pot fractions directly; no points | I, II, IV, VI, IX (March Madness), III, V (NFL) |

Under `earned_total` an entry's share moves when *other* entries score, so an intra-season
mark is unstable by construction. Fine for completed pools; a real decision before running a
live NBA or World Cup pool. The denominator is also zero before the first game, so a Week 0
baseline must be an equal split or explicitly unavailable — never a divide by zero, never a
silent zero.

## Four rule kinds

| Kind | Semantics |
|---|---|
| `per_unit` | `units × rate × the period's weight` |
| `direct_share` | `units × rate`, where rate is a fraction of the pot |
| `split_pool` | a fixed pot share divided by the total qualifying units across the whole pool, with an ordered fallback chain |
| `group_rank_bonus` | fixed award to the top scorer within a subgroup, split on ties |

The last two are **cross-entry**: they cannot value one lot without the finished results of
every other lot. That is why scoring is two-pass.

---

## NFL

Three editions, three different rubrics. The app currently hard-rejects any rate that isn't
Calcutta XII's, which is why two of these cannot be expressed in it today.

### NFL 2025 (VIII) and 2026 (XII) — points, fixed inventory

150 banked points per team, +10 a win, +5 a tie, +1 per point of differential, and playoff
bonuses of +50 berth, +100 divisional, +200 conference, +400 Super Bowl berth, +800 winning
it. Share = `points ÷ 11,420`.

**The 2× marquee multiplier applies to point differential ONLY.** Not to wins, not to ties.
Verified mechanically: Calcutta VIII computes `Adj. Point Differential` as the raw
differential plus a `SUMIF` over a 74-game primetime tab, and the wins cell carries no
primetime term at all.

The 11,420 denominator is exactly `32 × 150` banked + `272 games × 10` + `3,900` in playoff
bonuses, with point differential contributing zero because it is zero-sum. **It is
era-specific**: 11,260 for a 16-game season with 14 playoff teams (2020), 11,160 for 16 games
with 12 (≤2019). A regression test should assert that a complete season's league points equal
the denominator exactly — no existing test sums across the league, which is how the marquee
bug survived.

One nuance on the marquee window: the workbook's primetime tab includes Sunday 9:30am
international games and Saturday afternoon games. The code's "outside Sunday 1:00–7:00pm
Eastern" test catches those correctly; the rubric tab's own prose ("after 6pm ET or isn't
played on Sunday") would miss them. **The code is right and the prose is wrong** — fix the
rubric description in `v2Agent.ts`, not the test.

### NFL 2024 (V) — percent of pot, differential by rank

No points. Regular-season wins pay 0.16% of pot each; playoff bonuses 0.25 / 0.5 / 1 / 2 / 5%.
Total point differential (regular + playoff) is **ranked** across all 32 teams and paid off a
hard-coded 20-step ladder from 6.48% for rank 1 down to 0.10% for rank 20, zero below that.
Ties average the tied ranks. Rank 1's odd 6.48% is a plug that lands the whole rubric on
exactly 100%.

### NFL 2023 (III) — percent of pot, no differential at all

No points, no differential mechanic. Regular-season wins 0.1% each; playoff bonuses 0.75 /
1.5 / 3 / 6 / 12%. Plus three metrics unique to that year: a 5%-of-pot **split pool** across
the league's fifty-two 20-point wins, a `Weekly Big Winner` award at 0.5% × 18, and one
`Reg. Season BigWin` at 0.3%.

---

## March Madness (I, II, IV, VI, IX) — percent of pot, and it closes exactly

Identical rubric in all five editions. Payouts **accumulate** — a team reaching the Elite
Eight collects 0.5% + 1.0% + 2.0%.

| Round reached | Teams | Each | Distributes |
|---|---|---|---|
| Round of 32 | 32 | 0.5% | 16.0% |
| Sweet Sixteen | 16 | 1.0% | 16.0% |
| Elite Eight | 8 | 2.0% | 16.0% |
| Final Four | 4 | 4.0% | 16.0% |
| Championship game | 2 | 8.0% | 16.0% |
| Champion | 1 | 10.0% | 10.0% |
| **Advancement subtotal** | | | **90.0%** |
| Upset pools | | 5% + 5% | 10.0% |
| **Total** | | | **100.0%** |

Two 5%-of-pot **split pools**: one shared among every upset of 3+ seed positions, one among
every upset of 8+, cascading to 7+, 6+ … if none qualify. Each pool's per-unit award is
`5% × pot ÷ total qualifying units`. Calcutta VI is the stress case — its 8+ pool had exactly
one qualifying upset, so one team took the whole $3,681.50.

**Auction structure**: each region's 14/15/16 seeds are sold as one bundle, so 64 teams
become 56 lots. Play-in positions are auctioned as placeholders before the team is known, and
a First Four win scores nothing. Bidding is in $10 increments.

---

## NBA playoffs (VII, X) — points, renormalized to points earned

16-team bracket of best-of-seven series.

- **Game win** = 1 point, multiplied by round: R1 ×1, R2 ×2, Conference Finals ×4, Finals ×8
- **Sweep** = +15
- **Winning a series as the lower seed** = +10, conference rounds only, not the Finals
- Share = `points ÷ total points earned by all teams`

The round ladder is self-balancing: series count halves as the multiplier doubles, so every
round contributes an identical 32–56 points. Total inventory ranges 224–493 depending on
sweeps and upsets, which is why this format cannot have a fixed denominator.

The round multiplier is **not** the existing `playoffMultiplier` (one scalar on playoff-period
deltas). It is a per-round weight and belongs on the period definition. `scoring_events` must
carry **raw game counts**; the engine applies the weight.

---

## World Cup (XI) — points, renormalized to points earned

48 teams, 12 groups of four, 32 advance to a Round of 32.

**Pool play**: win +3, draw +1, +5 for finishing first in the group, +5 for advancing to the
knockouts. Both bonuses are 1/0 flags.

**Knockouts**, by round — and a shootout loss is its own outcome type, worth 20% of a win:

| | R32 | R16 | QF | SF | Final |
|---|---|---|---|---|---|
| Win | 10 | 20 | 50 | 100 | 200 |
| Shootout loss | 2 | 4 | 10 | 20 | 40 |

**Pot bonus**: the highest *pre-bonus* scorer in each of the four seeding pots gets +48, split
on ties. This is a `group_rank_bonus` and is self-referential — it excludes itself from the
comparison, which is why scoring is two-pass. Calcutta XI's pot 4 had a four-way tie at 9
points, so four teams took +12 each.

Worked check: Spain went 2W-1D, won its group, and won every knockout round —
`6 + 1 + 5 + 5 + 10 + 20 + 50 + 100 + 200 = 397`, plus the 48 pot bonus = 445 points, paying
$32,385.47 at $72.7763/point.

---

## Book positions — crossbooks and synthetics

An owner may hold synthetic long/short exposure on another owner's whole book **without
winning any lot at auction**. Two owners in Calcutta X hold nothing else.

**The formula**: A's payout on an *n*× levered crossbook with B is `n × (book(A) − book(B))`.
A single-sided variant also exists: `n × book(reference_owner)`.

**The basis**: every crossbook so far has been a **Lion King** crossbook, which means `book`
is computed from **auction lots only — trades excluded — with each lot counted at 100%
regardless of the share actually bought.** Two owners who split a team 50/50 at auction each
carry that team's full gain in their Lion King book.

Store the basis per trade (`lion_king` | `net`); default `lion_king`. Trade `scope` has five values, because the workbooks mix instruments: `entry` (a share of one lot, including naked shorts and synthetics), `book` (a spread between two owners), `synthetic_book` (one owner's whole book), `sidebet` (a prop wager, 7 of them in Calcutta VII) and `cash` (a bare payment). Only the two book scopes carry a basis, and a book trade may have a null `factor` when the leverage was never recorded cleanly — Calcutta IV's "2x 3x levered" bet — in which case the booked cash is carried and nothing is derived. Both shapes are
zero-sum between the parties and must not change any pool total. Value them from
**pre-book** books, or the calculation is circular — and Calcutta X stacks three instruments
on the same pair, so the evaluation order has to be defined.

Verification against history: III, V, VI and VIII reproduce exactly on this rule. VII and X
were computed on plain share-weighted net instead, and IX matches neither. See
`OPEN-DECISIONS.md`.

---

## Two invariants worth asserting in code

1. **Ownership.** Each entry's signed positions net to exactly `1.000000`, as a deferred
   constraint. This survives naked shorts, synthetic longs and leveraged longs above 100%,
   because both legs of every trade cancel. Verified across all 456 historical lots after
   applying all 62 entry-level transfers.

2. **Closure.** For any format, a completed season's shares sum to exactly 1.0. March
   Madness proves it by construction (90% + 10%); the NFL fixed inventory proves it at season
   end; `earned_total` proves it trivially. One test per format. This is the check that would
   have caught the marquee bug on day one.
