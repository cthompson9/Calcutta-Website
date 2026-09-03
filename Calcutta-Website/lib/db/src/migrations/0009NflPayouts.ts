export const nflPayoutsMigration = {
  version: "0009_nfl_payouts",
  sql: `
    alter table payout_rules drop constraint if exists payout_rules_metric_supported;
    alter table payout_rules add constraint payout_rules_metric_supported
      check (metric in ('win', 'tie', 'pt_diff', 'playoff_berth', 'div_round', 'conf_round', 'sb_berth', 'win_super_bowl'));

    alter table team_period_snapshots add column if not exists ordinary_wins numeric(8,4) not null default 0;
    alter table team_period_snapshots add column if not exists marquee_wins numeric(8,4) not null default 0;
    alter table team_period_snapshots add column if not exists ordinary_ties numeric(8,4) not null default 0;
    alter table team_period_snapshots add column if not exists marquee_ties numeric(8,4) not null default 0;
    alter table team_period_snapshots add column if not exists ordinary_pt_diff numeric(10,4) not null default 0;
    alter table team_period_snapshots add column if not exists marquee_pt_diff numeric(10,4) not null default 0;

    create table if not exists nfl_games (
      id serial primary key,
      season_id integer not null references seasons(id) on delete cascade,
      source text not null default 'manual',
      source_game_id text not null,
      period_sequence integer not null,
      round text not null default 'regular',
      home_team_id integer not null references teams(id),
      away_team_id integer not null references teams(id),
      home_score integer not null,
      away_score integer not null,
      actual_kickoff_at timestamptz not null,
      is_marquee boolean not null default false,
      marquee_multiplier integer not null default 1,
      status text not null default 'final',
      source_data jsonb,
      updated_at timestamptz not null default now(),
      unique (season_id, source, source_game_id)
    );
    create index if not exists nfl_games_season_period_idx on nfl_games(season_id, period_sequence);
    create index if not exists nfl_games_home_team_idx on nfl_games(home_team_id);
    create index if not exists nfl_games_away_team_idx on nfl_games(away_team_id);
  `,
} as const;