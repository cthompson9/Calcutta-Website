export const mtmRatingPrecisionMigration = {
  version: "0026_mtm_rating_precision_v1",
  sql: `
    alter table if exists mtm_team_projection
      alter column rating type numeric(12,3);
  `,
} as const;