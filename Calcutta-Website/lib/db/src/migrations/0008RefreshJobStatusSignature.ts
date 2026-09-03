export const refreshJobStatusSignatureMigration = {
  version: "0008_refresh_job_status_signature",
  sql: `
    alter table refresh_job_states
      add column if not exists last_game_status_signature text;
  `,
} as const;