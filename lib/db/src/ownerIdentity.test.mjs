import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  historicalOwnerRecordKey,
  loadOwnerIdentityFile,
  listHistoricalOwnerRecords,
  validateOwnerIdentity,
} from "./ownerIdentity.ts";

const root = resolve(new URL(".", import.meta.url).pathname, "../../..");

async function sourceDocuments() {
  return Promise.all(
    Array.from({ length: 11 }, (_, index) =>
      readFile(
        resolve(root, "data", `calcutta-${String(index + 1).padStart(2, "0")}.json`),
        "utf8",
      ).then(JSON.parse),
    ),
  );
}

test("owner identity decision file covers all 73 source records", async () => {
  const [mapping, documents] = await Promise.all([
    loadOwnerIdentityFile(resolve(root, "decisions/owner-identity.yaml")),
    sourceDocuments(),
  ]);
  const report = validateOwnerIdentity(mapping, documents);
  assert.equal(report.sourceRecords, 73);
  assert.equal(report.mappedRecords, 73);
  assert.equal(report.personCount, 30);
  assert.deepEqual(report.unresolvedMappings, []);
  assert.equal(report.reviewApproved, true);
  assert.equal(report.passed, true);
  assert.equal(
    historicalOwnerRecordKey("Zach", "Zach", 4),
    "Zach [ed4]",
  );
  assert.equal(listHistoricalOwnerRecords(documents).length, 73);
});

test("approved review covers all records and preserves protected non-merges", async () => {
  const [mapping, documents] = await Promise.all([
    loadOwnerIdentityFile(resolve(root, "decisions/owner-identity.yaml")),
    sourceDocuments(),
  ]);
  const approved = mapping;
  const report = validateOwnerIdentity(approved, documents);
  assert.equal(report.reviewApproved, true);
  assert.equal(report.passed, true);

  const collapsed = {
    ...approved,
    records: approved.records.map((record) =>
      record.record === "Zach [ed4]"
        ? { ...record, person: "Zack Miller" }
        : record,
    ),
  };
  const collapsedReport = validateOwnerIdentity(collapsed, documents);
  assert.equal(collapsedReport.passed, false);
  assert.deepEqual(collapsedReport.nonMergeViolations, [
    "Zach [ed4] must remain mapped to Zachary Long",
  ]);
});

test("identity validation rejects missing, duplicate, and ambiguous records", async () => {
  const [mapping, documents] = await Promise.all([
    loadOwnerIdentityFile(resolve(root, "decisions/owner-identity.yaml")),
    sourceDocuments(),
  ]);
  const incomplete = {
    ...mapping,
    records: mapping.records
      .filter((record) => record.record !== "KD [ed10]")
      .concat({ record: "Zach [ed4]", person: null, status: "ambiguous" }),
  };
  const report = validateOwnerIdentity(incomplete, documents);
  assert.equal(report.passed, false);
  assert.deepEqual(report.missingMappings, ["KD [ed10]"]);
  assert.deepEqual(report.unresolvedMappings, ["Zach [ed4]"]);
  assert.deepEqual(report.duplicateMappings, ["Zach [ed4]"]);
});