---
name: Schema design
description: NFL auction season boundaries for prices, primary ownership, results, trades, and M2M data.
---

## New tables added

- `seasons`: year (unique), is_active, is_complete, label
- `team_results`: composite PK (team_id, season_id); stores wins, pt_diff, playoff flags, realized_return, mark_to_market
- `trades`: season_id, team_id, from_bidder_id, to_bidder_id, price, trade_date
- `mtm_snapshots`: unique(team_id, season_id, week_num); week 0 = pre-season
- `team_season_auctions`: unique(team_id, season_id); authoritative auction price for that season

## Season ownership and price boundaries

Primary ownership is keyed by team, bidder, and season. Approved trades overlay those primary shares to produce current ownership; pending or rejected trades do not.

Auction price reads and writes use the season auction record. The legacy global team price is only a one-time 2025 backfill source and must never be a runtime fallback.

**Why:** Reusing global prices or active-season owners silently leaks 2025 economics into a new, empty season and makes cross-season comparisons incorrect.

**How to apply:** Require an explicit season for financial views, return empty/zero data when that season has no auction rows, and keep the unfiltered bidder endpoint only as the global identity directory for selecting new buyers.
