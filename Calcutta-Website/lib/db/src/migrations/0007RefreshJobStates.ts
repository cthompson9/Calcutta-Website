export const refreshJobStatesMigration = {
  version: "0007_refresh_job_states",
  sql: `
    create table if not exists refresh_job_states (
      id serial primary key,
      season_id integer not null references seasons(id) on delete cascade,
      job text not null,
      schedule_cache jsonb,
      schedule_fetched_at timestamptz,
      last_succeeded_at timestamptz,
      updated_at timestamptz not null default now()
    );

    create unique index if not exists refresh_job_states_season_job_idx
      on refresh_job_states (season_id, job);
  `,
} as const;