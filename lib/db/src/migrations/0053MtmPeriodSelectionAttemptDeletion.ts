export const mtmPeriodSelectionAttemptDeletionMigration = {
  version: "0053_mtm_period_selection_attempt_deletion",
  sql: `
    create or replace function mtm_period_selection_guard() returns trigger language plpgsql as $$
    begin
      if tg_op = 'UPDATE' then
        raise exception 'canonical period selections are append-only: updates are rejected';
      end if;
      if tg_op = 'DELETE' then
        if current_setting('app.mtm_attempt_delete', true) is distinct from 'on' then
          raise exception 'canonical period selections are append-only: deletes are rejected';
        end if;
        return old;
      end if;
      if not exists (
        select 1
        from mtm_snapshot s
        where s.id = new.snapshot_id
          and s.status = 'ok'
          and s.pool_id = new.pool_id
      ) then
        raise exception 'canonical period selection requires a successful MTM snapshot';
      end if;
      return new;
    end $$;
  `,
} as const;