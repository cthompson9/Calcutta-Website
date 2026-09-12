import { mtmCurrentVersionMigration } from "./0042MtmCurrentVersion";

const guardSqlStart = mtmCurrentVersionMigration.sql.indexOf(
  "create or replace function mtm_valuation_version_guard()",
);

if (guardSqlStart < 0) {
  throw new Error("MTM current-version guard SQL was not found.");
}

export const mtmCurrentVersionGuardsMigration = {
  version: "0043_mtm_current_version_guards",
  // Reapply the corrected guard functions and triggers for databases that
  // already recorded the additive table migration before these constraints
  // were strengthened.
  sql: mtmCurrentVersionMigration.sql.slice(guardSqlStart),
} as const;