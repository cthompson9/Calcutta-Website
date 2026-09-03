export const scopedSnapshotMetricsMigration = {
  version: "0019_scoped_snapshot_metrics_v1",
  sql: `
    alter table calcutta_rules
      add column if not exists calculation text,
      add column if not exists condition text;

    alter table snapshot_metrics
      add column if not exists calcutta_id integer;

    create temporary table snapshot_metrics_0019_row_count
      on commit drop
      as select count(*) as row_count from snapshot_metrics;

    update snapshot_metrics as metric
      set calcutta_id = entry.calcutta_id
      from calcutta_entries as entry
      where metric.entry_id = entry.id
        and metric.calcutta_id is null;

    do $$
    begin
      if exists (
        select 1
        from snapshot_metrics
        where calcutta_id is null
      ) then
        raise exception 'snapshot_metrics calcutta_id backfill left null rows';
      end if;

      if exists (
        select 1
        from snapshot_metrics as metric
        left join calcutta_entries as entry on entry.id = metric.entry_id
        where metric.entry_id is not null
          and entry.id is null
      ) then
        raise exception 'snapshot_metrics contains orphaned entry rows';
      end if;

      if exists (
        select 1
        from snapshot_metrics as metric
        left join calcuttas as calcutta on calcutta.id = metric.calcutta_id
        where calcutta.id is null
      ) then
        raise exception 'snapshot_metrics contains orphaned calcutta rows';
      end if;

      if exists (
        select 1
        from snapshot_metrics as metric
        join calcutta_entries as entry on entry.id = metric.entry_id
        where metric.entry_id is not null
          and metric.calcutta_id <> entry.calcutta_id
      ) then
        raise exception 'snapshot_metrics entry rows have mismatched calcutta_id';
      end if;

      if exists (
        select 1
        from snapshot_metrics
        where entry_id is not null
        group by calcutta_id, entry_id, period_id, basis, metric
        having count(*) > 1
      ) then
        raise exception 'snapshot_metrics contains duplicate entry metric rows';
      end if;

      if exists (
        select 1
        from snapshot_metrics
        where entry_id is null
        group by calcutta_id, period_id, basis, metric
        having count(*) > 1
      ) then
        raise exception 'snapshot_metrics contains duplicate pool metric rows';
      end if;
    end
    $$;

    alter table snapshot_metrics
      add constraint snapshot_metrics_calcutta_id_calcuttas_id_fk
      foreign key (calcutta_id) references calcuttas(id) on delete cascade;
    alter table snapshot_metrics
      alter column calcutta_id set not null,
      alter column entry_id drop not null;

    drop index if exists snapshot_metrics_entry_period_basis_metric_idx;
    create unique index if not exists snapshot_metrics_calcutta_entry_period_basis_metric_idx
      on snapshot_metrics(calcutta_id, entry_id, period_id, basis, metric)
      where entry_id is not null;
    create unique index if not exists snapshot_metrics_calcutta_period_basis_metric_idx
      on snapshot_metrics(calcutta_id, period_id, basis, metric)
      where entry_id is null;

    do $$
    begin
      if (select row_count from snapshot_metrics_0019_row_count) <> (select count(*) from snapshot_metrics) then
        raise exception 'snapshot_metrics row count changed during scope migration';
      end if;
    end
    $$;
  `,
} as const;