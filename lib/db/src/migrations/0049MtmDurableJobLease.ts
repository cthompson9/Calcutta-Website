export const mtmDurableJobLeaseMigration = {
  version: "0049_mtm_durable_job_lease",
  sql: `
    create table if not exists mtm_job_leases (
      pool_id integer primary key constraint mtm_job_lease_pool_fk references calcuttas(id) on delete cascade,
      owner_token text not null,
      run_id text not null,
      lease_until timestamptz not null,
      heartbeat_at timestamptz not null,
      started_at timestamptz not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists mtm_job_runs (
      run_id text primary key,
      pool_id integer not null constraint mtm_job_run_pool_fk references calcuttas(id) on delete cascade,
      owner_token text not null,
      status text not null,
      failure_kind text,
      error text,
      snapshot_id integer constraint mtm_job_run_snapshot_fk references mtm_snapshot(id) on delete set null,
      started_at timestamptz not null,
      heartbeat_at timestamptz not null,
      lease_until timestamptz not null,
      completed_at timestamptz,
      constraint mtm_job_runs_status_supported
        check (status in ('running', 'completed', 'failed', 'abandoned'))
    );
    create index if not exists mtm_job_runs_pool_started_idx
      on mtm_job_runs(pool_id, started_at);
  `,
} as const;