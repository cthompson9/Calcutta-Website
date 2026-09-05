export const mtmInputProvenanceMigration = {
  version: "0031_mtm_input_provenance",
  sql: `
    alter table mtm_snapshot
      add column if not exists input_provenance jsonb;
  `,
} as const;