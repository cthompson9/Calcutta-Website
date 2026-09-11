import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mtmRunMetadataAndConditionalsMigration } from "./migrations/0041MtmRunMetadataAndConditionals.ts";

const schemaSource = await readFile(new URL("./schema/mtmCanonical.ts", import.meta.url), "utf8");
const migrationSource = mtmRunMetadataAndConditionalsMigration.sql;

test("MTM canonical schema keeps migration constraint names aligned", () => {
  const names = [
    "mtm_cal_metric_target_probability_range",
    "mtm_cal_metric_simulated_probability_range",
    "mtm_cal_metric_sample_share_range",
    "mtm_game_cond_probability_range",
    "mtm_game_cond_outcome_supported",
    "mtm_game_cond_gross_baseline_non_negative",
    "mtm_game_cond_gross_conditional_non_negative",
    "mtm_game_cond_sample_share_range",
  ];
  for (const name of names) {
    assert.match(schemaSource, new RegExp(`check\\("${name}"`));
    assert.match(migrationSource, new RegExp(`constraint ${name}\\b`));
  }
});

test("MTM canonical migration enforces conditional outcomes and selection integrity", () => {
  assert.match(migrationSource, /outcome in \('home_win','away_win','tie'\)/);
  assert.match(migrationSource, /quality_status in \('good','warning','insufficient'\)/);
  assert.match(migrationSource, /s\.status = 'ok' and s\.pool_id = new\.pool_id/);
  assert.match(migrationSource, /updates are rejected/);
  assert.match(migrationSource, /deletes are rejected/);
  assert.match(schemaSource, /t\.selectedAt\.desc\(\)/);
});