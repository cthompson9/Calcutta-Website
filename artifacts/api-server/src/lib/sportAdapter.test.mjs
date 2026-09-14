import assert from "node:assert/strict";
import test from "node:test";
import {
  CFB,
  CFB_PLAYOFF,
  ContractValidationError,
  NFL,
  NFL_POSTSEASON,
  NFL_REGULAR_SEASON,
  NBA,
  NBA_PLAYOFFS,
  MARCH_MADNESS,
  MARCH_MADNESS_PLAYOFFS,
  WORLD_CUP,
  WORLD_CUP_TOURNAMENT,
  UnsupportedSportError,
  createNflAdvancementContract,
  createNflEventContract,
  createNflWinLadderContract,
  evaluateContract,
  getSportAdapter,
  isWinLadderMonotone,
  validateWinLadderMonotonicity,
} from "./sportAdapter.ts";

const competition = {
  sport: NFL,
  competition: NFL_REGULAR_SEASON,
  seasonYear: 2026,
  competitionId: "nfl-2026",
};
const event = {
  competition,
  eventId: "espn-401",
  provider: "espn",
};

test("NFL event contracts retain competition/event identity and allow regular-season ties", () => {
  const contract = createNflEventContract({ id: "game", competition, event });
  const result = evaluateContract(getSportAdapter(NFL, NFL_REGULAR_SEASON), contract, {
    source: "espn",
    capturedAt: "2026-01-01T00:00:00Z",
    competition,
    event,
    outcomeId: "tie",
    tie: true,
  });
  assert.equal(result.status, "settled");
  assert.equal(result.outcome, "no");
  assert.throws(() => evaluateContract(getSportAdapter(NFL, NFL_REGULAR_SEASON), contract, {
    source: "other",
    capturedAt: "2026-01-01T00:00:00Z",
    competition: { ...competition, competitionId: "other" },
    event,
    outcomeId: "tie",
  }), ContractValidationError);
});

test("NFL postseason adapter rejects a tie as a fabricated legal outcome", () => {
  const postseasonCompetition = { ...competition, competition: NFL_POSTSEASON };
  const postseasonEvent = { ...event, competition: postseasonCompetition };
  const contract = createNflEventContract({
    id: "playoff-game",
    competition: postseasonCompetition,
    event: postseasonEvent,
  });
  assert.throws(() => evaluateContract(getSportAdapter(NFL, NFL_POSTSEASON), contract, {
    source: "espn",
    capturedAt: "2026-01-01T00:00:00Z",
    competition: postseasonCompetition,
    event: postseasonEvent,
    outcomeId: "tie",
    tie: true,
  }), /not legal/);
});

test("NFL win ladder settles monotonically from final wins", () => {
  const ladder = [8, 9, 10].map((threshold) => createNflWinLadderContract({
    id: `wins-${threshold}`,
    competition,
    teamId: "BUF",
    threshold,
  }));
  ladder.forEach((contract, index) => {
    const result = evaluateContract(getSportAdapter(NFL, NFL_REGULAR_SEASON), contract, {
      source: "standings",
      capturedAt: "2026-01-01T00:00:00Z",
      competition,
      actualWins: 9,
      winnerId: "BUF",
    });
    assert.equal(result.status, "settled");
    assert.equal(result.outcome, index < 2 ? "yes" : "no");
  });
  validateWinLadderMonotonicity([
    { threshold: 8, probability: 0.8 },
    { threshold: 9, probability: 0.6 },
    { threshold: 10, probability: 0.4 },
  ]);
  assert.equal(isWinLadderMonotone([
    { threshold: 8, probability: 0.8 },
    { threshold: 9, probability: 0.9 },
  ]), false);
});

test("advancement evidence is nested and cannot settle without its stage assertion", () => {
  const contract = createNflAdvancementContract({
    id: "buf-afc",
    competition,
    event,
    teamId: "BUF",
    stage: "conference",
  });
  const evidence = {
    source: "bracket",
    capturedAt: "2026-01-01T00:00:00Z",
    competition,
    event,
    outcomeId: "advance",
    advancement: { stage: "conference", teamId: "BUF", advanced: true, event },
  };
  assert.equal(evaluateContract(getSportAdapter(NFL, NFL_REGULAR_SEASON), contract, evidence).outcome, "yes");
  assert.equal(evaluateContract(getSportAdapter(NFL, NFL_REGULAR_SEASON), contract, {
    ...evidence,
    advancement: null,
  }).status, "unsettled");
});

test("unsupported postseason adapters fail explicitly instead of fabricating outcomes", () => {
  for (const [sport, competitionName] of [
    [CFB, CFB_PLAYOFF],
    [NBA, NBA_PLAYOFFS],
    [MARCH_MADNESS, MARCH_MADNESS_PLAYOFFS],
    [WORLD_CUP, WORLD_CUP_TOURNAMENT],
  ]) {
    const adapter = getSportAdapter(sport, competitionName);
    assert.equal(adapter.supported, false);
    assert.throws(() => adapter.settle({}, null), UnsupportedSportError);
  }
});