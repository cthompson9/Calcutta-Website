---
name: Schema design
description: NFl auction DB schema decisions, new tables added in the Calcutta Returns build.
---

## New tables added

- `seasons`: year (unique), is_active, is_complete, label
- `team_results`: composite PK (team_id, season_id); stores wins, pt_diff, playoff flags, realized_return, mark_to_market
- `trades`: season_id, team_id, from_bidder_id, to_bidder_id, price, trade_date
- `mtm_snapshots`: unique(team_id, season_id, week_num); week 0 = pre-season

## team_bidders change

- Added `season_id` (nullable FK to seasons) — kept nullable so existing data could be backfilled
- Composite PK is now (team_id, bidder_id) — season_id NOT in PK, just a filter column
- Backfilled via UPDATE ... WHERE season_id IS NULL

**Why:** Existing 36 rows were 2025 auction data. Making season_id NOT NULL at push time would require a default, which drizzle-kit refuses in non-TTY. Nullable + backfill via seed is the safe path.

**How to apply:** Future seasons add new team_bidders rows with the correct season_id. Query by season_id to filter ownership per year.
