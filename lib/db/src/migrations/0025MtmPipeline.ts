export const mtmPipelineMigration = {
  version: "0025_mtm_pipeline_v1",
  sql: `
    create table if not exists mtm_snapshot (
      id serial primary key,
      pool_id integer not null references calcuttas(id) on delete cascade,
      as_of timestamptz not null,
      as_of_hour timestamptz not null,
      trigger text not null check (trigger in ('scheduled', 'manual')),
      status text not null check (status in ('ok', 'failed')),
      method_version text not null,
      error text,
      diagnostics jsonb,
      state_json jsonb,
      created_at timestamptz not null default now(),
      unique (pool_id, as_of_hour)
    );

    create index if not exists mtm_snapshot_pool_created_idx
      on mtm_snapshot (pool_id, created_at);

    create table if not exists mtm_market_quote (
      snapshot_id integer not null references mtm_snapshot(id) on delete cascade,
      source text not null default 'kalshi',
      series text not null,
      market_ticker text not null,
      team text,
      strike numeric(6,2),
      yes_bid numeric(5,4),
      yes_ask numeric(5,4),
      volume integer,
      fetched_at timestamptz not null,
      raw_quote jsonb,
      primary key (snapshot_id, market_ticker)
    );

    create table if not exists mtm_team_projection (
      snapshot_id integer not null references mtm_snapshot(id) on delete cascade,
      team text not null,
      e_wins_total numeric(6,3),
      e_remaining_wins numeric(6,3),
      p_berth numeric(5,4),
      p_divisional numeric(5,4),
      p_conf numeric(5,4),
      p_sb_berth numeric(5,4),
      p_sb_win numeric(5,4),
      e_remaining_raw_diff numeric(8,2),
      e_remaining_marquee_addon numeric(8,2),
      rating numeric(6,3),
      primary key (snapshot_id, team)
    );

    create table if not exists mtm_entry_valuation (
      snapshot_id integer not null references mtm_snapshot(id) on delete cascade,
      entry_id integer not null references calcutta_entries(id) on delete cascade,
      expected_points numeric(10,2),
      expected_share numeric(9,6),
      expected_payout numeric(12,2),
      auction_price numeric(12,2),
      mtm_multiple numeric(12,3),
      primary key (snapshot_id, entry_id)
    );
  `,
} as const;