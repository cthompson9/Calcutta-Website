# Calcutta platform — handoff

Everything from the review, packaged for implementation. Drop this folder into the repo and
start at `STAGING.md`.

```
STAGING.md                  the sequence — read this first
prompts/
  stage-0-security/         8 prompts · this week · no schema change
  stage-1-model/            15 prompts · the model + the back data
  stage-2-read-paths/       5 prompts · historical UI
  stage-3-converge/         7 prompts · offseason
decisions/
  RULES.md                  the canonical rubrics, written down properly
  OPEN-DECISIONS.md         five questions that move money — the pool's call
  OWNER-IDENTITY.md         73 records, ~20 people, manual merge
data/
  calcutta-01..11.json      the eleven pools, transcribed from the Google Sheets
  team-by-team.csv          456 lots with tracking and payouts
  owner-by-owner.csv        80 owner rows
reference/
  schema.sql                the format-agnostic DDL
  views.sql                 tracking + owner roll-up views
  load_and_verify.py        loader, two-pass engine, reconciler
  DATA-CONTRACT.md          the JSON format, field by field
```

## Three things to know before starting

**1. Calcutta XII is live.** The new model is built *alongside* the existing tables. Nothing
in Stage 0, 1 or 2 alters a table that pool reads. Convergence is Stage 3, offseason.

**2. Stage 1 has an objective acceptance test.** The engine recomputes every payout from
events and rules alone — it never reads a dollar from the source data. Each workbook's own
answers live in separate `expected_*` tables used only for comparison. A correct
implementation reproduces:

```
456 / 456   lot payouts tie to the cent
112 / 112   point totals tie
 82 /  82   owner roll-ups tie
 11 /  11   pools where the engine's total payout equals the pot exactly
```

The reference implementation reaches all four. Anything less is a bug in the implementation,
not the data.

**3. The workbooks are evidence, not authority.** Seven of them contain defects, four of
which moved real money. They are catalogued in `OPEN-DECISIONS.md`. If a computation
disagrees with a workbook, record the variance — never adjust an input to force a match.

## The model in one paragraph

An **entry is an auction lot, not a team**: 456 lots hold 504 team slots, because every March
Madness pool bundles each region's 14/15/16 seeds and two NBA lots are play-in placeholders
auctioned before the team was known. **Scoring is one generic fact table** — 913 rows of
`(entry, period, metric, units)` across 24 metrics, with no dollars and no multipliers in it;
the round weight lives on the period and the rate lives on the rule. **The rubric is data**:
four rule kinds (`per_unit`, `direct_share`, `split_pool`, `group_rank_bonus`) and three
normalization modes (`fixed_inventory`, `earned_total`, `direct`) express all six rubrics
found across the eleven pools. Ownership stays relational and exact, with each entry's signed
shares netting to `1.000000` under a deferred constraint — which already absorbs naked
shorts, synthetic longs and leveraged longs without any change.

## Two things the engine must do that the current one doesn't

**Score in three passes.** `split_pool` and `group_rank_bonus` cannot value one lot without
the finished results of every other lot — a March Madness upset is worth 5% of the pot
divided by the number of qualifying upsets in the whole tournament, and the World Cup pot
bonus goes to the top pre-bonus scorer in each seeding pot. Book positions are a third pass
after that, valued from pre-book books. Two real edge cases: Calcutta VI's 8+ upset pool had
a denominator of one, and Calcutta XI's pot 4 was a four-way tie splitting 48 into 12s.

**Choose normalization per pool, not per sport.** Three of the NFL pools use three different
mechanisms. `NFL_SCORING_ADAPTER.validateRules` currently hard-rejects any rate that isn't
Calcutta XII's, so two of the three historical NFL pools cannot be expressed in the app as it
stands — and neither can whatever Calcutta XIII turns out to be.

## Running the reference implementation

```sh
createdb calcutta_v2
export DATABASE_URL=postgres://.../calcutta_v2
pip install psycopg2-binary
python3 reference/load_and_verify.py      # prints the reconciliation table
psql "$DATABASE_URL" -f reference/views.sql
```

```sql
-- team-by-team, no dollars in the narrative
select lot, seed, grouping, price, ownership, tracking, points, payout
  from cal.v_entry_results where ed = 9 order by payout desc;

-- owner-by-owner
select ed, owner, lots, cost, payout from cal.v_owner_results where ed = 11;
```
