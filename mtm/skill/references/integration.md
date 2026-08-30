# Integration with Calcutta-Website

## Division of labor

| Concern | Owner |
|---|---|
| Realized wins/ties/adj diff, remaining schedule, marquee flags, pot, entries | Repo (TypeScript, existing scoring engine + standings refresh) |
| Market fetch, transforms, ratings fit, projections | This skill's Python (`scripts/`) |
| Persistence (mtm_* tables), UI, snapshot pointer, admin endpoint | Repo |

The seam is two JSON files: the repo **exports** `state.json`, Python
**returns** `snapshot.json`. Python never touches the DB; the repo never
re-implements market math.

## state.json contract (repo → engine)

```json
{
  "as_of": "2026-10-27T07:00:00Z",
  "pot": 123456.0,
  "entries": [{"entry_id": "uuid", "team": "KC", "price": 4200.0}],
  "realized": {"KC": {"wins": 5, "ties": 0, "adj_pt_diff": 61}},
  "remaining_schedule": [{"home": "KC", "away": "BUF", "marquee": true, "week": 8}],
  "divisions": {"AFC West": ["KC", "LAC", "DEN", "LV"]},
  "win_ladders": {"KC": [{"strike": 9, "yes_bid": 0.61, "yes_ask": 0.66, "volume": 1200}]},
  "elimination_quotes": {"KC": {"no_playoffs": 0.08, "wild_card": 0.10,
      "divisional": 0.22, "conference": 0.25, "sb_loss": 0.15, "sb_win": 0.20}}
}
```

Notes:
- `realized.adj_pt_diff` is engine-computed (raw + marquee SUMIF equivalent).
- `elimination_quotes` values are already bid+1¢ in probability units; for a
  settled team pass exact 0/1 — normalization holds them fixed.
- Quote fetch can live on either side of the seam. Simplest: the Node fetcher
  pulls Kalshi (or Python's `kalshi_client.py` does, via a `--fetch` wrapper)
  and both raw quotes and the assembled state are written to disk/DB before
  the transform step runs.

## snapshot.json (engine → repo)

`status`, `projections` per team, `valuations` per entry
(expected_points/share/payout, auction price, mtm_multiple), `diagnostics`
(per-team wins method, playoff alphas + residuals, rating-fit error, league
coverage). Persist verbatim; flip the "current snapshot" pointer only on
`status == "ok"`.

## Schema (additive, Stage-1-style)

```sql
create table mtm_snapshot (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references pool(id),
  as_of timestamptz not null,
  trigger text not null check (trigger in ('scheduled','manual')),
  status text not null check (status in ('ok','failed')),
  method_version text not null,
  error text,
  created_at timestamptz not null default now()
);

create table mtm_market_quote (
  snapshot_id uuid not null references mtm_snapshot(id),
  source text not null default 'kalshi',
  series text not null,
  market_ticker text not null,
  team text,
  strike numeric,
  yes_bid numeric(5,4),
  yes_ask numeric(5,4),
  volume integer,
  fetched_at timestamptz not null,
  primary key (snapshot_id, market_ticker)
);

create table mtm_team_projection (
  snapshot_id uuid not null references mtm_snapshot(id),
  team text not null,
  e_wins_total numeric(6,3),
  e_remaining_wins numeric(6,3),
  p_berth numeric(5,4), p_divisional numeric(5,4), p_conf numeric(5,4),
  p_sb_berth numeric(5,4), p_sb_win numeric(5,4),
  e_remaining_raw_diff numeric(8,2),
  e_remaining_marquee_addon numeric(8,2),
  rating numeric(6,3),
  primary key (snapshot_id, team)
);

create table mtm_entry_valuation (
  snapshot_id uuid not null references mtm_snapshot(id),
  entry_id uuid not null,
  expected_points numeric(10,2),
  expected_share numeric(9,6),
  expected_payout numeric(12,2),
  primary key (snapshot_id, entry_id)
);
```

## refresh.yml wiring

The workflow already has `workflow_dispatch` with a `job: mtm` option. Add:

```yaml
  schedule:
    - cron: "0 7,8 * * 2"   # 3am ET candidates; in-code gate picks the right one
```

MTM job steps: checkout → setup-node (export state.json via a repo script that
reads the DB) → setup-python 3.11 (`pip install requests`) → run
`run_mtm.py` → node persist step. Guard the doubled cron with an ET check
(run only when `TZ=America/New_York date +%H` == 03) and make the persist step
idempotent on (pool_id, as_of-hour) so a retry can't double-write.

Admin button: server endpoint (admin-authed) that executes the same
export → run → persist chain inline and returns the snapshot id. Both paths
write `trigger` accordingly.

## Failure semantics

- Kalshi unreachable / a team's ladder unpriced → snapshot `status='failed'`,
  UI serves prior snapshot + staleness banner. Never partial.
- `playoff_residuals` materially nonzero or `coverage` drifting from ~1.0 →
  succeed but surface in an admin diagnostics panel; these are the early-
  warning gauges for ticker changes or market structure changes mid-season.
