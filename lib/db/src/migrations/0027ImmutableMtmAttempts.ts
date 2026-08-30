export const immutableMtmAttemptsMigration = {
  version: "0027_immutable_mtm_attempts_v1",
  sql: `
    alter table if exists mtm_snapshot
      drop constraint if exists mtm_snapshot_pool_id_as_of_hour_key;

    alter table if exists mtm_snapshot
      drop constraint if exists mtm_snapshot_pool_as_of_hour_idx;

    drop index if exists mtm_snapshot_pool_as_of_hour_idx;

    create index if not exists mtm_snapshot_pool_as_of_hour_idx
      on mtm_snapshot (pool_id, as_of_hour);
  `,
} as const;