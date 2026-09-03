import assert from "node:assert/strict";
import test from "node:test";
import { assertForeignKeyTargetsHaveNaturalKeys } from "./snapshotNaturalKeys";

test("fails when a declared foreign-key target has no registered natural key", () => {
  const naturalKeys = new Map<string, readonly string[]>([
    ["historical_calcutta_links", ["normalized_calcutta_id"]],
  ]);

  assert.throws(
    () =>
      assertForeignKeyTargetsHaveNaturalKeys(naturalKeys, [
        {
          sourceTable: "historical_calcutta_links",
          sourceColumns: ["legacy_calcutta_id"],
          targetTable: "calcuttas",
          targetColumns: ["id"],
        },
      ]),
    /Foreign key target\(s\) have no registered natural key: calcuttas/,
  );
});

test("uses the declared target for non-conventional source column names", () => {
  const naturalKeys = new Map<string, readonly string[]>([
    ["calcuttas", ["name"]],
  ]);

  assert.doesNotThrow(() =>
    assertForeignKeyTargetsHaveNaturalKeys(naturalKeys, [
      {
        sourceTable: "mtm_snapshot",
        sourceColumns: ["pool_id"],
        targetTable: "calcuttas",
        targetColumns: ["id"],
      },
      {
        sourceTable: "historical_calcutta_links",
        sourceColumns: ["legacy_calcutta_id"],
        targetTable: "calcuttas",
        targetColumns: ["id"],
      },
    ]),
  );
});