export const sportScopedTeamsMigration = {
  version: "0063_sport_scoped_teams",
  sql: `
    alter table teams add column if not exists sport text not null default 'NFL';
    alter table teams drop constraint if exists teams_name_unique;
    drop index if exists teams_name_unique;
    create unique index if not exists teams_sport_name_idx on teams (sport, name);
  `,
} as const;