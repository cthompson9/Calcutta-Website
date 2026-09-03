import assert from "node:assert/strict";
import test from "node:test";
import { competitionScoringMigration } from "./migrations/0018CompetitionScoring.ts";

test("competition scoring migration removes NFL-only database assumptions", () => {
  assert.match(competitionScoringMigration.sql, /dollars_per_unit drop not null/);
  assert.match(competitionScoringMigration.sql, /sport_periods_competition_sequence_idx/);
  assert.match(competitionScoringMigration.sql, /drop constraint if exists team_results_record_total_at_most_17/);
  assert.doesNotMatch(
    competitionScoringMigration.sql,
    /metric in \('win', 'tie', 'pt_diff'/,
  );
});