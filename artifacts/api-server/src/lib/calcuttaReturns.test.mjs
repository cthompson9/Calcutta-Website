import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateNflRegularSeasonGames,
  calculateNflPoints,
  calculateNflTeamValues,
  calculateReturnFromSnapshots,
  compareHistoricalPayoutParity,
  isNflMarqueeKickoff,
  NFL_PAYOUT_RULES,
  validateNflPayoutRules,
} from "./calcuttaReturns.ts";

const rules = [
  { metric: "win", dollarsPerUnit: 10, playoffMultiplier: 2 },
  { metric: "pt_diff", dollarsPerUnit: 1, playoffMultiplier: 2 },
  { metric: "div_round", dollarsPerUnit: 100, playoffMultiplier: 2 },
];

test("cumulative snapshots pay each metric delta once and double playoff-period changes", () => {
  const gross = calculateReturnFromSnapshots(
    [
      {
        sequence: 18,
        label: "Week 18",
        isPlayoff: false,
        playoffStatus: "alive",
        wins: 1,
        losses: 0,
        ties: 0,
        ptDiff: 7,
        playoffBerth: 0,
        divRound: 0,
        confRound: 0,
        sbBerth: 0,
        winSuperBowl: 0,
      },
      {
        sequence: 20,
        label: "Divisional",
        isPlayoff: true,
        playoffStatus: "clinched",
        wins: 2,
        losses: 0,
        ties: 0,
        ptDiff: 10,
        playoffBerth: 1,
        divRound: 1,
        confRound: 0,
        sbBerth: 0,
        winSuperBowl: 0,
      },
    ],
    rules,
  );

  // Week 18: (1 win × $10) + (7 PD × $1) = $17.
  // Divisional deltas: 1 win, 3 PD, and 1 divisional berth, all doubled:
  // (10 + 3 + 100) × 2 = $226. Total = $243.
  assert.equal(gross, 243);
});

test("negative probability adjustments correctly reduce mark-to-market return", () => {
  const gross = calculateReturnFromSnapshots(
    [
      {
        sequence: 0,
        label: "Week 0",
        isPlayoff: false,
        playoffStatus: "alive",
        wins: 8,
        losses: 0,
        ties: 0,
        ptDiff: 0,
        playoffBerth: 0,
        divRound: 0,
        confRound: 0,
        sbBerth: 0,
        winSuperBowl: 0,
      },
      {
        sequence: 3,
        label: "Week 3",
        isPlayoff: false,
        playoffStatus: "alive",
        wins: 7.5,
        losses: 0,
        ties: 0,
        ptDiff: 0,
        playoffBerth: 0,
        divRound: 0,
        confRound: 0,
        sbBerth: 0,
        winSuperBowl: 0,
      },
    ],
    [{ metric: "win", dollarsPerUnit: 50, playoffMultiplier: 2 }],
  );

  assert.equal(gross, 375);
});

test("a Week 0 baseline plus sparse playoff snapshot does not multiply regular-season totals", () => {
  const gross = calculateReturnFromSnapshots(
    [
      {
        sequence: 0,
        label: "Week 0",
        isPlayoff: false,
        playoffStatus: "alive",
        wins: 0,
        losses: 0,
        ties: 0,
        ptDiff: 0,
        playoffBerth: 0,
        divRound: 0,
        confRound: 0,
        sbBerth: 0,
        winSuperBowl: 0,
      },
      {
        sequence: 22,
        label: "Super Bowl",
        isPlayoff: true,
        playoffStatus: "clinched",
        wins: 12,
        losses: 5,
        ties: 0,
        ptDiff: 120,
        playoffBerth: 1,
        divRound: 1,
        confRound: 1,
        sbBerth: 1,
        winSuperBowl: 1,
      },
    ],
    [{ metric: "win", dollarsPerUnit: 10, playoffMultiplier: 2 }],
  );

  assert.equal(gross, 120);
});

test("the confirmed NFL rubric validates every metric and rejects incomplete rules", () => {
  assert.deepEqual(validateNflPayoutRules([...NFL_PAYOUT_RULES]), { ok: true });
  assert.equal(validateNflPayoutRules(NFL_PAYOUT_RULES.slice(0, -1)).ok, false);
  assert.equal(
    validateNflPayoutRules(NFL_PAYOUT_RULES.map((rule) => ({
      ...rule,
      dollarsPerUnit: rule.metric === "tie" ? 10 : rule.dollarsPerUnit,
    }))).ok,
    false,
  );
});

test("actual Eastern kickoff, including a rescheduled Sunday game, controls marquee classification", () => {
  // 1 PM ET Sunday is ordinary; 8 PM ET Sunday is marquee.
  assert.equal(isNflMarqueeKickoff("2025-09-07T17:00:00.000Z"), false);
  assert.equal(isNflMarqueeKickoff("2025-09-08T00:00:00.000Z"), true);
});

test("game aggregates preserve ordinary and marquee audit inputs and de-duplicate replays", () => {
  const games = [
    {
      seasonId: 1, source: "test", sourceGameId: "ordinary", periodSequence: 1,
      homeTeamId: 10, awayTeamId: 20, homeScore: 21, awayScore: 14,
      actualKickoffAt: "2025-09-07T17:00:00.000Z",
    },
    {
      seasonId: 1, source: "test", sourceGameId: "marquee-tie", periodSequence: 1,
      homeTeamId: 10, awayTeamId: 30, homeScore: 20, awayScore: 20,
      actualKickoffAt: "2025-09-08T00:00:00.000Z",
    },
    // Same stable identity is ignored as an idempotent re-scrape.
    {
      seasonId: 1, source: "test", sourceGameId: "ordinary", periodSequence: 1,
      homeTeamId: 10, awayTeamId: 20, homeScore: 21, awayScore: 14,
      actualKickoffAt: "2025-09-07T17:00:00.000Z",
    },
  ];
  const aggregate = aggregateNflRegularSeasonGames(games).get(10);
  assert.deepEqual(
    {
      wins: aggregate.wins, ties: aggregate.ties, ptDiff: aggregate.ptDiff,
      ordinaryWins: aggregate.ordinaryWins, marqueeTies: aggregate.marqueeTies,
      ordinaryPtDiff: aggregate.ordinaryPtDiff, marqueePtDiff: aggregate.marqueePtDiff,
      games: aggregate.games.length,
    },
    { wins: 1, ties: 1, ptDiff: 7, ordinaryWins: 1, marqueeTies: 1, ordinaryPtDiff: 7, marqueePtDiff: 0, games: 2 },
  );
});

test("points use the game-level marquee multiplier once and retain playoff bonuses", () => {
  const result = calculateNflPoints({
    wins: 2, losses: 0, ties: 1, ptDiff: 10,
    ordinaryWins: 1, marqueeWins: 1,
    ordinaryTies: 0, marqueeTies: 1,
    ordinaryPtDiff: 4, marqueePtDiff: 3,
    playoffBerth: 1, divRound: 1, confRound: 0, sbBerth: 0, winSuperBowl: 0,
  });
  // 150 + (10 × (1 + 2)) + (5 × 2) + (4 + 3 × 2) + 50 + 100
  assert.equal(result.points, 350);
  assert.equal(result.breakdown.ptDiff, 10);
});

test("fair values use the fixed final-season denominator before all points are earned", () => {
  const values = calculateNflTeamValues([
    { teamId: 1, cost: 100, snapshot: { wins: 0, losses: 0, ties: 0, ptDiff: 0, playoffBerth: 0, divRound: 0, confRound: 0, sbBerth: 0, winSuperBowl: 0 } },
    { teamId: 2, cost: 200, snapshot: { wins: 1, losses: 0, ties: 0, ptDiff: 10, playoffBerth: 0, divRound: 0, confRound: 0, sbBerth: 0, winSuperBowl: 0 } },
  ], 300);
  assert.equal(values[0].normalizedShare, 150 / 11420);
  assert.equal(values[1].normalizedShare, 170 / 11420);
  assert.ok(Math.abs(values.reduce((sum, value) => sum + value.normalizedShare, 0) - 320 / 11420) < 1e-12);
  assert.ok(Math.abs(values.reduce((sum, value) => sum + value.fairValue, 0) - (320 / 11420) * 300) < 1e-9);
  assert.equal(values[1].netReturn, values[1].fairValue - 200);
});

test("equal point totals split the pool using the normalized dollar formula", () => {
  const snapshot = {
    wins: 0, losses: 0, ties: 0, ptDiff: 0,
    playoffBerth: 0, divRound: 0, confRound: 0, sbBerth: 0, winSuperBowl: 0,
  };
  const entries = [
    { teamId: 1, cost: 1000, snapshot },
    {
      teamId: 2,
      cost: 1000,
      snapshot: { ...snapshot, ptDiff: 11120 },
    },
  ];
  const values = calculateNflTeamValues(entries, 97625);
  assert.equal(values[0].points, 150);
  assert.equal(Math.round(values[0].grossReturn * 100) / 100, 1282.29);
  assert.equal(Math.round(values[0].netReturn * 100) / 100, 282.29);
});

test("historical parity stays visibly non-authoritative for partial coverage or a mismatch", () => {
  const partial = compareHistoricalPayoutParity(2, [{ teamId: 1, grossReturn: 100 }], new Map());
  assert.equal(partial.isAuthoritative, false);
  assert.match(partial.message, /Incomplete/);
  const mismatch = compareHistoricalPayoutParity(
    1,
    [{ teamId: 1, grossReturn: 100 }],
    new Map([[1, { rulesConfigured: true, realized: { grossReturn: 101, latest: {}, points: 0, normalizedShare: 0, fairValue: 0, pointsBreakdown: {} } }]]),
  );
  assert.equal(mismatch.isAuthoritative, false);
  assert.equal(mismatch.mismatches[0].difference, 1);
});