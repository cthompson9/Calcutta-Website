export const mtmAttemptDeletionGuardReconciliationMigration = {
  version: "0052_mtm_attempt_deletion_guard_reconciliation",
  sql: `
    drop trigger if exists mtm_valuation_version_delete_guard on mtm_valuation_version;
  `,
} as const;