export const sportScopedEventIngestionMigration = {
  version: "0016_sport_scoped_event_ingestion",
  sql: `
    alter table events
      add column if not exists sport text not null default 'NFL',
      add column if not exists competition text not null default 'NFL_REGULAR_SEASON';

    drop index if exists events_season_source_event_idx;
    drop index if exists events_season_week_matchup_idx;
    drop index if exists events_season_week_idx;
    create unique index if not exists events_season_scope_source_event_idx
      on events(season_id, sport, competition, source, source_event_id);
    create unique index if not exists events_season_scope_week_matchup_idx
      on events(season_id, sport, competition, week, away_team_id, home_team_id);
    create index if not exists events_season_scope_week_idx
      on events(season_id, sport, competition, week);

    alter table refresh_job_states
      add column if not exists sport text not null default 'NFL',
      add column if not exists competition text not null default 'NFL_REGULAR_SEASON';
    drop index if exists refresh_job_states_season_job_idx;
    create unique index if not exists refresh_job_states_season_scope_job_idx
      on refresh_job_states(season_id, sport, competition, job);

    create table if not exists provider_team_identities (
      id serial primary key,
      sport text not null,
      competition text not null,
      provider text not null,
      provider_team_id text not null,
      team_id integer not null references teams(id) on delete cascade,
      canonical_name text not null,
      aliases jsonb not null default '[]'::jsonb
    );
    create unique index if not exists provider_team_identities_scope_provider_id_idx
      on provider_team_identities(sport, competition, provider, provider_team_id);
    create index if not exists provider_team_identities_team_idx
      on provider_team_identities(team_id);
  `,
} as const;