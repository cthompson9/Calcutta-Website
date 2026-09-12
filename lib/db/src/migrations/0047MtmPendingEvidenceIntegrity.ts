import { mtmPendingReplacementMigration } from "./0044MtmPendingReplacement";

export const mtmPendingEvidenceIntegrityMigration = {
  version: "0047_mtm_pending_evidence_integrity",
  // Reapply the corrected pending-promotion function and trigger for databases
  // that recorded the initial replacement migration before retained-evidence
  // and exact canonical checks were strengthened.
  sql: mtmPendingReplacementMigration.sql,
} as const;