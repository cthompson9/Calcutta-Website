import { mtmCurrentVersionMigration } from "./0042MtmCurrentVersion";

const guardSqlStart = mtmCurrentVersionMigration.sql.indexOf(
  "create or replace function mtm_valuation_version_guard()",
);

if (guardSqlStart < 0) {
  throw new Error("MTM current-version guard SQL was not found.");
}

export const mtmCurrentCanonicalGamesMigration = {
  version: "0045_mtm_current_canonical_games",
  sql: mtmCurrentVersionMigration.sql.slice(guardSqlStart),
} as const;