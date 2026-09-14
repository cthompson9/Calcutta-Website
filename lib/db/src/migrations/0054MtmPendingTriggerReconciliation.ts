export const mtmPendingTriggerReconciliationMigration = {
  version: "0054_mtm_pending_trigger_reconciliation",
  sql: `
    drop trigger if exists mtm_valuation_version_append_only on mtm_valuation_version;
    create trigger mtm_valuation_version_append_only
      before insert or update on mtm_valuation_version
      for each row when (new.mark_type <> 'pending_recalculation')
      execute function mtm_valuation_version_guard();
  `,
} as const;