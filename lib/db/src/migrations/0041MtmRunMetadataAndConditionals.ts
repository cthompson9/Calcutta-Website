export const mtmRunMetadataAndConditionalsMigration = {
  version: "0041_mtm_run_metadata_and_conditionals",
  sql: `
    alter table mtm_snapshot
      add column if not exists path_count integer,
      add column if not exists random_seed integer,
      add column if not exists input_hash text,
      add column if not exists market_anchor timestamptz,
      add column if not exists actual_anchor timestamptz,
      add column if not exists calibration_status text,
      add column if not exists run_kind text;
    do $$ begin
      alter table mtm_snapshot add constraint mtm_snapshot_path_count_non_negative
        check (path_count is null or path_count >= 0);
    exception when duplicate_object then null; end $$;
    do $$ begin
      alter table mtm_snapshot add constraint mtm_snapshot_random_seed_non_negative
        check (random_seed is null or random_seed >= 0);
    exception when duplicate_object then null; end $$;
    do $$ begin
      alter table mtm_snapshot add constraint mtm_snapshot_calibration_status_supported
        check (calibration_status is null or calibration_status in ('good','warning','insufficient','not_run'));
    exception when duplicate_object then null; end $$;
    do $$ begin
      alter table mtm_snapshot add constraint mtm_snapshot_run_kind_supported
        check (run_kind is null or run_kind in ('week_0','scheduled','manual','postgame','backfill'));
    exception when duplicate_object then null; end $$;

    create table if not exists mtm_calibration_metric (
      id integer generated always as identity primary key,
      snapshot_id integer not null constraint mtm_cal_metric_snapshot_fk references mtm_snapshot(id) on delete cascade,
      metric_key text not null,
      market_ticker text,
      target_probability numeric(8,6),
      simulated_probability numeric(8,6),
      weight numeric(12,6),
      residual numeric(10,7),
      tolerance numeric(10,7),
      sample_count integer,
      sample_share numeric(8,6),
      effective_sample_size numeric(12,4),
      quality_status text not null default 'good',
      sample_metadata jsonb,
      constraint mtm_cal_metric_weight_non_negative check (weight is null or weight >= 0),
      constraint mtm_cal_metric_tolerance_non_negative check (tolerance is null or tolerance >= 0),
      constraint mtm_cal_metric_sample_count_non_negative check (sample_count is null or sample_count >= 0),
      constraint mtm_cal_metric_effective_size_non_negative check (effective_sample_size is null or effective_sample_size >= 0),
      constraint mtm_cal_metric_target_probability_range check (target_probability is null or target_probability between 0 and 1),
      constraint mtm_cal_metric_simulated_probability_range check (simulated_probability is null or simulated_probability between 0 and 1),
      constraint mtm_cal_metric_sample_share_range check (sample_share is null or sample_share between 0 and 1),
      constraint mtm_cal_metric_quality_supported check (quality_status in ('good','warning','insufficient'))
    );
    create unique index if not exists mtm_cal_metric_snapshot_key_idx on mtm_calibration_metric(snapshot_id, metric_key);
    create index if not exists mtm_cal_metric_snapshot_idx on mtm_calibration_metric(snapshot_id);

    create table if not exists mtm_game_conditional (
      id integer generated always as identity primary key,
      snapshot_id integer not null constraint mtm_game_cond_snapshot_fk references mtm_snapshot(id) on delete cascade,
      event_id integer not null constraint mtm_game_cond_event_fk references events(id) on delete cascade,
      entry_id integer not null constraint mtm_game_cond_entry_fk references calcutta_entries(id) on delete cascade,
      outcome text not null,
      probability numeric(8,6),
      gross_baseline numeric(14,4),
      gross_conditional numeric(14,4),
      gross_delta numeric(14,4),
      sample_count integer,
      sample_share numeric(8,6),
      effective_sample_size numeric(12,4),
      standard_error numeric(14,6),
      quality_status text not null default 'good',
      reconciliation_residual numeric(14,6),
      constraint mtm_game_cond_probability_range check (probability is null or probability between 0 and 1),
      constraint mtm_game_cond_outcome_supported check (outcome in ('home_win','away_win','tie')),
      constraint mtm_game_cond_gross_baseline_non_negative check (gross_baseline is null or gross_baseline >= 0),
      constraint mtm_game_cond_gross_conditional_non_negative check (gross_conditional is null or gross_conditional >= 0),
      constraint mtm_game_cond_sample_share_range check (sample_share is null or sample_share between 0 and 1),
      constraint mtm_game_cond_counts_non_negative check ((sample_count is null or sample_count >= 0) and (effective_sample_size is null or effective_sample_size >= 0) and (standard_error is null or standard_error >= 0)),
      constraint mtm_game_cond_quality_supported check (quality_status in ('good','warning','insufficient'))
    );
    create unique index if not exists mtm_game_cond_snapshot_event_entry_outcome_idx on mtm_game_conditional(snapshot_id, event_id, entry_id, outcome);
    create index if not exists mtm_game_cond_snapshot_event_idx on mtm_game_conditional(snapshot_id, event_id);

    create table if not exists mtm_canonical_period_selection (
      id integer generated always as identity primary key,
      pool_id integer not null constraint mtm_period_sel_pool_fk references calcuttas(id) on delete cascade,
      sport_period_id integer not null constraint mtm_period_sel_period_fk references sport_periods(id) on delete cascade,
      snapshot_id integer not null constraint mtm_period_sel_snapshot_fk references mtm_snapshot(id) on delete restrict,
      selected_at timestamptz not null default now(),
      selected_by text,
      selected_reason text,
      metadata jsonb
    );
    create index if not exists mtm_period_sel_latest_idx on mtm_canonical_period_selection(pool_id, sport_period_id, selected_at desc);
    create index if not exists mtm_period_sel_history_idx on mtm_canonical_period_selection(pool_id, sport_period_id, snapshot_id);

    create or replace function mtm_period_selection_guard() returns trigger language plpgsql as $$
    begin
      if tg_op = 'UPDATE' then raise exception 'canonical period selections are append-only: updates are rejected'; end if;
      if tg_op = 'DELETE' then raise exception 'canonical period selections are append-only: deletes are rejected'; end if;
      if not exists (select 1 from mtm_snapshot s where s.id = new.snapshot_id and s.status = 'ok' and s.pool_id = new.pool_id) then
        raise exception 'canonical period selection requires a successful MTM snapshot';
      end if;
      return new;
    end $$;
    drop trigger if exists mtm_period_selection_append_only on mtm_canonical_period_selection;
    create trigger mtm_period_selection_append_only before insert or update or delete on mtm_canonical_period_selection
      for each row execute function mtm_period_selection_guard();
  `,
} as const;