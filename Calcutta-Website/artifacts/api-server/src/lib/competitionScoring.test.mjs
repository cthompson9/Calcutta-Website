import assert from "node:assert/strict";
import test from "node:test";
import {
  CFB_SCORING_ADAPTER,
  NFL_PAYOUT_RULES,
  NFL_SCORING_ADAPTER,
  calculateCompetitionTeamValues,
  calculateCompetitionValuesFromEvents,
  createCompetitionScoringAdapter,
  validateCompetitionScoringRules,
} from "./competitionScoring.ts";
import {
  aggregateNflRegularSeasonGames,
  calculateNflPoints,
  calculateNflTeamValues,
} from "./calcuttaReturns.ts";

function nflMetrics(snapshot) {
  return {
    win: snapshot.wins,
    tie: snapshot.ties,
    pt_diff: snapshot.ptDiff,
    playoff_berth: snapshot.playoffBerth,
    div_round: snapshot.divRound,
    conf_round: snapshot.confRound,
    sb_berth: snapshot.sbBerth,
    win_super_bowl: snapshot.winSuperBowl,
    ordinary_wins: snapshot.ordinaryWins ?? 0,
    marquee_wins: snapshot.marqueeWins ?? 0,
    ordinary_ties: snapshot.ordinaryTies ?? 0,
    marquee_ties: snapshot.marqueeTies ?? 0,
    ordinary_pt_diff: snapshot.ordinaryPtDiff ?? 0,
    marquee_pt_diff: snapshot.marqueePtDiff ?? 0,
  };
}

test("NFL adapter is a golden differential match for legacy points, shares, and dollars", () => {
  const fixtures = [
    {
      teamId: 1,
      cost: 600,
      snapshot: {
        wins: 0, losses: 0, ties: 0, ptDiff: 0,
        playoffBerth: 0, divRound: 0, confRound: 0, sbBerth: 0, winSuperBowl: 0,
      },
    },
    {
      teamId: 2,
      cost: 1_200,
      snapshot: {
        wins: 10, losses: 7, ties: 0, ptDiff: 84,
        playoffBerth: 1, divRound: 1, confRound: 0, sbBerth: 0, winSuperBowl: 0,
        ordinaryWins: 7, marqueeWins: 3, ordinaryTies: 0, marqueeTies: 0,
        ordinaryPtDiff: 40, marqueePtDiff: 22,
      },
    },
    {
      teamId: 3,
      cost: 2_400,
      snapshot: {
        wins: 14, losses: 3, ties: 0, ptDiff: 140,
        playoffBerth: 1, divRound: 1, confRound: 1, sbBerth: 1, winSuperBowl: 1,
        ordinaryWins: 10, marqueeWins: 4, ordinaryTies: 0, marqueeTies: 0,
        ordinaryPtDiff: 80, marqueePtDiff: 30,
      },
    },
  ];
  const potSize = 97_625;
  const legacy = calculateNflTeamValues(fixtures, potSize);
  const adapted = calculateCompetitionTeamValues(
    NFL_SCORING_ADAPTER,
    fixtures.map((fixture) => ({
      teamId: fixture.teamId,
      cost: fixture.cost,
      metrics: nflMetrics(fixture.snapshot),
    })),
    potSize,
    NFL_PAYOUT_RULES,
  );
  assert.deepEqual(adapted.map((value) => value.points), [150, 484, 1980]);
  assert.deepEqual(adapted.map((value) => value.fairValue), [
    1282.2898423817865,
    4137.521891418564,
    16926.225919439577,
  ]);

  for (let index = 0; index < fixtures.length; index += 1) {
    const legacyPoints = calculateNflPoints(fixtures[index].snapshot);
    assert.equal(adapted[index].points, legacyPoints.points);
    assert.equal(adapted[index].points, legacy[index].points);
    assert.equal(adapted[index].normalizedShare, legacy[index].normalizedShare);
    assert.equal(adapted[index].fairValue, legacy[index].fairValue);
    assert.equal(adapted[index].grossReturn, legacy[index].grossReturn);
    assert.equal(adapted[index].netReturn, legacy[index].netReturn);
    assert.equal(adapted[index].multiple, legacy[index].multiple);
  }
});

test("a complete 272-game NFL season sums to the fixed denominator with arbitrary marquee games", () => {
  const events = Array.from({ length: 272 }, (_, index) => ({
    seasonId: 2026,
    source: "normalization-regression",
    sourceEventId: `game-${index}`,
    periodSequence: (index % 18) + 1,
    homeTeamId: (index % 32) + 1,
    awayTeamId: ((index + 1) % 32) + 1,
    homeScore: 21,
    awayScore: 14,
    // Thursday for arbitrary marquee games; Sunday afternoon otherwise.
    actualKickoffAt: index % 3 === 0
      ? "2026-09-17T00:15:00.000Z"
      : "2026-09-13T17:00:00.000Z",
    status: "final",
  }));
  const outcomes = NFL_SCORING_ADAPTER.aggregateOutcomes(events);
  const playoffMetrics = (teamId) => ({
    playoff_berth: teamId <= 14 ? 1 : 0,
    div_round: teamId <= 8 ? 1 : 0,
    conf_round: teamId <= 4 ? 1 : 0,
    sb_berth: teamId <= 2 ? 1 : 0,
    win_super_bowl: teamId === 1 ? 1 : 0,
  });
  const values = calculateCompetitionTeamValues(
    NFL_SCORING_ADAPTER,
    Array.from({ length: 32 }, (_, index) => {
      const teamId = index + 1;
      return {
        teamId,
        metrics: { ...outcomes.get(teamId).metrics, ...playoffMetrics(teamId) },
      };
    }),
    0,
    NFL_PAYOUT_RULES,
  );
  assert.equal(
    values.reduce((total, value) => total + value.points, 0),
    NFL_SCORING_ADAPTER.normalizationDenominator,
  );
});

test("NFL adapter produces the same normalized snapshot inputs as the legacy aggregator", () => {
  const games = [
    {
      seasonId: 2026,
      source: "golden",
      sourceGameId: "ordinary",
      periodSequence: 1,
      homeTeamId: 1,
      awayTeamId: 2,
      homeScore: 24,
      awayScore: 17,
      actualKickoffAt: "2026-09-13T17:00:00.000Z",
      status: "final",
    },
    {
      seasonId: 2026,
      source: "golden",
      sourceGameId: "marquee",
      periodSequence: 2,
      homeTeamId: 2,
      awayTeamId: 1,
      homeScore: 20,
      awayScore: 20,
      actualKickoffAt: "2026-09-18T00:15:00.000Z",
      status: "final",
    },
  ];
  const legacy = aggregateNflRegularSeasonGames(games);
  const adapted = NFL_SCORING_ADAPTER.aggregateOutcomes(
    games.map(({ sourceGameId, ...game }) => ({
      ...game,
      sourceEventId: sourceGameId,
    })),
  );
  for (const teamId of [1, 2]) {
    const old = legacy.get(teamId);
    const current = adapted.get(teamId);
    assert.deepEqual(current.metrics, {
      win: old.wins,
      loss: old.losses,
      tie: old.ties,
      pt_diff: old.ptDiff,
      ordinary_wins: old.ordinaryWins,
      marquee_wins: old.marqueeWins,
      ordinary_ties: old.ordinaryTies,
      marquee_ties: old.marqueeTies,
      ordinary_pt_diff: old.ordinaryPtDiff,
      marquee_pt_diff: old.marqueePtDiff,
    });
    assert.deepEqual(
      current.sourceEvents.map((event) => event.sourceEventId),
      old.games.map((event) => event.sourceGameId),
    );
  }
});

test("synthetic CFB provider events flow through normalized outcomes to points and dollars", () => {
  const adapter = createCompetitionScoringAdapter({
    ...CFB_SCORING_ADAPTER,
    allowedMetrics: ["win", "loss", "tie", "pt_diff"],
    startingPoints: 20,
    normalizationDenominator: 200,
    defaultRules: null,
  });
  const rules = [
    { metric: "win", dollarsPerUnit: 12, playoffMultiplier: 1 },
    { metric: "loss", dollarsPerUnit: 0, playoffMultiplier: 1 },
    { metric: "tie", dollarsPerUnit: 6, playoffMultiplier: 1 },
    { metric: "pt_diff", dollarsPerUnit: 2, playoffMultiplier: 1 },
  ];
  const events = [
    {
      seasonId: 2026,
      source: "synthetic-provider",
      sourceEventId: "cfb-1",
      periodSequence: 1,
      homeTeamId: 10,
      awayTeamId: 20,
      homeScore: 28,
      awayScore: 21,
      status: "final",
      sourceData: { providerPayloadId: "raw-1" },
    },
    {
      seasonId: 2026,
      source: "synthetic-provider",
      sourceEventId: "cfb-2",
      periodSequence: 2,
      homeTeamId: 20,
      awayTeamId: 10,
      homeScore: 17,
      awayScore: 17,
      status: "completed",
      sourceData: { providerPayloadId: "raw-2" },
    },
  ];

  const result = calculateCompetitionValuesFromEvents(
    adapter,
    events,
    [{ teamId: 10, cost: 30 }, { teamId: 20, cost: 70 }],
    100,
    rules,
  );

  assert.deepEqual(result.outcomes.get(10).metrics, {
    win: 1,
    loss: 0,
    tie: 1,
    pt_diff: 7,
  });
  assert.deepEqual(
    result.outcomes.get(10).sourceEvents.map((event) => event.sourceEventId),
    ["cfb-1", "cfb-2"],
  );
  assert.deepEqual(result.values.map((value) => ({
    teamId: value.teamId,
    points: value.points,
    normalizedShare: value.normalizedShare,
    grossReturn: value.grossReturn,
    netReturn: value.netReturn,
  })), [
    { teamId: 10, points: 52, normalizedShare: 0.26, grossReturn: 26, netReturn: -4 },
    { teamId: 20, points: 12, normalizedShare: 0.06, grossReturn: 6, netReturn: -64 },
  ]);
});

test("CFB null configuration and incomplete rule sets are rejected instead of defaulted", () => {
  assert.deepEqual(
    validateCompetitionScoringRules(CFB_SCORING_ADAPTER, [
      { metric: "win", dollarsPerUnit: null },
      { metric: "loss", dollarsPerUnit: null },
      { metric: "tie", dollarsPerUnit: null },
      { metric: "pt_diff", dollarsPerUnit: null },
    ]),
    { ok: false, error: "CFB starting points are not configured." },
  );

  const configured = createCompetitionScoringAdapter({
    ...CFB_SCORING_ADAPTER,
    allowedMetrics: ["win", "pt_diff"],
    startingPoints: 0,
    normalizationDenominator: 100,
  });
  assert.throws(
    () => calculateCompetitionTeamValues(
      configured,
      [{ teamId: 1, metrics: { win: 1, pt_diff: 7 } }],
      100,
      [{ metric: "win", dollarsPerUnit: 10 }],
    ),
    /exactly one rule for every allowed metric/,
  );
});