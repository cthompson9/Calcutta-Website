/**
 * Deliberately not in the automatic startup migration list. Applying this
 * requires separate authorization for MLB results activation.
 * No ownership, economics, NFL events, or historical records are rewritten.
 */
export const mlbEventIdentityMigration = {
  version: "0066_mlb_event_identity",
  sql: `
    drop index if exists events_season_scope_week_matchup_idx;
    create unique index events_season_scope_week_matchup_idx
      on events(season_id, sport, competition, week, away_team_id, home_team_id)
      where sport <> 'MLB';
  `,
} as const;
