export const nflGameSourceProvenanceMigration = {
  version: "0033_nfl_game_source_provenance",
  sql: `
    alter table nfl_games
      add column if not exists source_url text,
      add column if not exists source_fetched_at timestamptz;
  `,
} as const;