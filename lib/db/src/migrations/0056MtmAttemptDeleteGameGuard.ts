export const mtmAttemptDeleteGameGuardMigration = {
  version: "0056_mtm_attempt_delete_game_guard",
  sql: `
    create or replace function mtm_admin_attempt_delete_guard() returns trigger language plpgsql as $$
    begin
      if current_setting('app.mtm_attempt_delete', true) is distinct from 'on' then
        raise exception 'MTM valuation records are append-only outside an authorized attempt deletion';
      end if;
      if tg_table_name = 'mtm_valuation_version' then
        if old.status = 'current' then
          raise exception 'Current MTM valuation versions cannot be deleted';
        end if;
      end if;
      return old;
    end $$;
  `,
} as const;