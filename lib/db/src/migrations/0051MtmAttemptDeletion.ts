export const mtmAttemptDeletionMigration = {
  version: "0051_mtm_attempt_deletion",
  sql: `
    create or replace function mtm_admin_attempt_delete_guard() returns trigger language plpgsql as $$
    begin
      if current_setting('app.mtm_attempt_delete', true) is distinct from 'on' then
        raise exception 'MTM valuation records are append-only outside an authorized attempt deletion';
      end if;
      if tg_table_name = 'mtm_valuation_version' and old.status = 'current' then
        raise exception 'Current MTM valuation versions cannot be deleted';
      end if;
      return old;
    end $$;

    drop trigger if exists mtm_valuation_version_append_only on mtm_valuation_version;
    drop trigger if exists mtm_valuation_version_delete_guard on mtm_valuation_version;
    create trigger mtm_valuation_version_append_only before insert or update on mtm_valuation_version
      for each row execute function mtm_valuation_version_guard();
    drop trigger if exists mtm_valuation_version_admin_delete on mtm_valuation_version;
    create trigger mtm_valuation_version_admin_delete before delete on mtm_valuation_version
      for each row execute function mtm_admin_attempt_delete_guard();

    drop trigger if exists mtm_valuation_game_append_only on mtm_valuation_game;
    create trigger mtm_valuation_game_append_only before insert or update on mtm_valuation_game
      for each row execute function mtm_valuation_game_guard();
    drop trigger if exists mtm_valuation_game_admin_delete on mtm_valuation_game;
    create trigger mtm_valuation_game_admin_delete before delete on mtm_valuation_game
      for each row execute function mtm_admin_attempt_delete_guard();
  `,
} as const;