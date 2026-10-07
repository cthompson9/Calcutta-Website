import { NON_MLB_EVENT_MATCHUP_INDEX } from "../schema/events";
/**
 * Isolated fixtures and explicitly authorized development setup only.
 * Deliberately excluded from automatic startup migrations. Managed production
 * receives this index replacement through the user-controlled Publish flow.
 * No ownership, economics, NFL events, or historical records are rewritten.
 */
export const mlbEventIdentityMigration = {
  version: "0066_mlb_event_identity",
  sql: `
    drop index if exists events_season_scope_week_matchup_idx;
    drop index if exists ${NON_MLB_EVENT_MATCHUP_INDEX};
    create unique index ${NON_MLB_EVENT_MATCHUP_INDEX}
      on events(season_id, sport, competition, week, away_team_id, home_team_id)
      where sport <> 'MLB';
  `,
} as const;
