import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mtmEvidenceStorageMigration } from "./migrations/0050MtmEvidenceStorage.ts";

const schemaSource = await readFile(new URL("./schema/mtmPipeline.ts", import.meta.url), "utf8");
const migrationSource = mtmEvidenceStorageMigration.sql;

const evidenceColumns = [
  "observationId",
  "provider",
  "contract",
  "settlementPredicate",
  "family",
  "eventId",
  "sourceObservedAt",
  "capturedAt",
  "normalizedYesBid",
  "normalizedYesAsk",
  "depth",
  "status",
  "outcome",
  "materialEvent",
  "stateVersion",
  "qualityReport",
  "qualityPolicyVersion",
  "acceptedLower",
  "acceptedUpper",
  "tradeEstimate",
  "tradeUncertainty",
  "fallbackIdentity",
  "fallbackAge",
  "evidenceGroup",
  "completenessManifest",
  "rawMetadata",
];

test("MTM quote evidence is additive and keeps unknown values nullable", () => {
  for (const column of evidenceColumns) {
    assert.match(schemaSource, new RegExp(`${column}:`), `missing schema field ${column}`);
  }
  assert.match(schemaSource, /mtmMarketQuoteTable = pgTable\(\s*"mtm_market_quote"/);
  assert.match(schemaSource, /foreignKey\(\{[\s\S]*name: "mtm_quote_snapshot_fk"/);
  assert.match(schemaSource, /foreignKey\(\{[\s\S]*name: "mtm_quote_event_fk"/);
});

test("MTM evidence migration preserves the legacy quote relation", () => {
  assert.match(migrationSource, /alter table mtm_market_quote/);
  assert.match(migrationSource, /add column if not exists observation_id text/);
  assert.match(migrationSource, /add column if not exists raw_metadata jsonb/);
  assert.match(migrationSource, /mtm_quote_snapshot_fk/);
  assert.match(migrationSource, /mtm_quote_event_fk/);
  assert.match(migrationSource, /where observation_id is not null/);
  assert.match(migrationSource, /normalized_yes_bid <= normalized_yes_ask/);
});

test("evidence bounds allow null while rejecting impossible known values", () => {
  assert.match(schemaSource, /normalized_bid_bounds/);
  assert.match(schemaSource, /normalized_ask_bounds/);
  assert.match(schemaSource, /accepted_bounds/);
  assert.match(schemaSource, /trade_estimate_bounds/);
  assert.match(schemaSource, /fallback_age_non_negative/);
  assert.match(migrationSource, /status in \('active', 'settled', 'suspended', 'unknown'\)/);
  assert.match(migrationSource, /outcome in \('yes', 'no', 'void'\)/);
});