export const mtmActualsRequestsMigration = {
  version: "0059_mtm_actuals_requests",
  sql: `
    create table if not exists mtm_actuals_request (
      pool_id integer primary key constraint mtm_actuals_request_pool_fk references calcuttas(id) on delete cascade,
      requested_revision text not null,
      completed_revision text,
      status text not null default 'pending',
      attempts integer not null default 0,
      next_attempt_at timestamptz,
      last_error text,
      requested_at timestamptz not null default now(),
      completed_at timestamptz,
      updated_at timestamptz not null default now(),
      constraint mtm_actuals_request_status_supported
        check (status in ('pending', 'running', 'completed', 'failed'))
    );
    create index if not exists mtm_actuals_request_status_idx
      on mtm_actuals_request(status, next_attempt_at);
  `,
} as const;