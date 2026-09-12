import { mtmPendingReplacementMigration } from "./0044MtmPendingReplacement";

export const mtmRetainedEvidenceIdentityMigration = {
  version: "0048_mtm_retained_evidence_identity",
  sql: mtmPendingReplacementMigration.sql,
} as const;