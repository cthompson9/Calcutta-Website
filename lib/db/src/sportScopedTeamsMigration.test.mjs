import assert from "node:assert/strict";
import test from "node:test";
import { sportScopedTeamsUniqueIndexRepairMigration } from "./migrations/0064SportScopedTeamsUniqueIndexRepair.ts";

test("sport-scoped team migration removes differently named global name uniqueness safely", () => {
  const sql = sportScopedTeamsUniqueIndexRepairMigration.sql;
  assert.match(sql, /pg_constraint/);
  assert.match(sql, /con\.contype = 'u'/);
  assert.match(sql, /attr\.attname = 'name'/);
  assert.match(sql, /pg_index/);
  assert.match(sql, /ind\.indisunique/);
  assert.match(sql, /ind\.indnkeyatts = 1/);
  assert.match(sql, /create unique index if not exists teams_sport_name_idx on teams \(sport, name\)/);
  assert.doesNotMatch(sql, /\b(drop table|truncate)\b/i);
});