export const refreshJobObservabilityMigration = {
  version: "0040_refresh_job_observability",
  sql: `
    alter table refresh_job_states
      add column if not exists last_attempted_at timestamptz,
      add column if not exists last_failed_at timestamptz,
      add column if not exists last_error text,
      add column if not exists last_result jsonb;
  `,
} as const;