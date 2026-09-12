import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCurrentMtmResolution,
  classifyCanonicalNflFinals,
  normalizeSourceActuals,
  planNflMtmReconciliation,
  validateCurrentMtmVersion,
} from "./currentMtm.ts";
import {
  computeActualsStateHash,
} from "./mtmValuationHelpers.ts";

const game = (eventId, homeScore = 10, awayScore = 7) => ({
  eventId, week: eventId, homeTeamId: eventId * 2, awayTeamId: eventId * 2 + 1,
  homeScore, awayScore,
});
const source = (actuals = [game(1)]) => ({
  poolId: 9, status: "ok", methodVersion: "frozen-mtm-2026",
  stateJson: { pot: 32 }, finalizedGames: actuals,
});
const version = (actuals, extra = {}) => ({
  poolId: 9, sourceSnapshotId: 44,
  actualsStateHash: computeActualsStateHash(actuals),
  markType: "official", status: "current", ...extra,
});
const link = (actual, extra = {}) => ({ ...actual, eventId: actual.eventId, ...extra });
const officialValuations = (count = 32) => Array.from({ length: count }, (_, index) => ({
  entryId: index + 1, expectedPayout: 1,
}));

test("actuals hash is order independent and ignores provenance", async () => {
  const { computeActualsStateHash: hash } = await import("./mtmValuationHelpers.ts");
  const a = { ...game(1), fetchedAt: "2026-01-01", source: "espn" };
  const b = { ...game(2), fetchedAt: "2026-01-02", source: "manual" };
  assert.equal(hash([a, b]), hash([{ ...b, source: "other", source_id: "different" }, { ...a, fetchedAt: "later" }]));
  assert.notEqual(hash([a, b]), hash([{ ...a, homeScore: 11 }, b]));
});

test("production realized_results map provider/source_id to canonical event and teams", () => {
  const persisted = {
    poolId: 9,
    inputProvenance: {
      realized_results: [{
        provider: "espn", source_id: "espn-7", week: 3,
        home: "HOM", away: "AWY", home_score: 17, away_score: 14,
        fetched_at: "2026-09-20T19:00:00Z",
      }],
    },
  };
  const [actual] = normalizeSourceActuals(persisted, [{
    id: 77, source: "espn", sourceEventId: "espn-7", week: 3,
    homeTeamId: 1001, awayTeamId: 1002,
  }]);
  assert.deepEqual(actual, {
    eventId: 77, week: 3, homeTeamId: 1001, awayTeamId: 1002,
    homeScore: 17, awayScore: 14,
  });
});

test("source normalization preserves persisted week and team identity for corrections", () => {
  const [actual] = normalizeSourceActuals({
    inputProvenance: {
      realized_results: [{
        provider: "espn", source_id: "x", week: 2,
        home: "OLD", away: "AWY", homeTeamId: 99, home_score: 10, away_score: 7,
      }],
    },
  }, [{
    id: 9, source: "espn", sourceEventId: "x", week: 3,
    homeTeamId: 20, awayTeamId: 21, homeTeamCode: "NEW", awayTeamCode: "AWY",
  }]);
  assert.deepEqual(actual, {
    eventId: 9, week: 2, homeTeamId: 99, awayTeamId: 21,
    homeScore: 10, awayScore: 7,
  });
});

test("NFL MTM reconciliation plans official when there are no new finals", () => {
  assert.deepEqual(planNflMtmReconciliation({
    postAnchorFinalEventIds: [],
    conditionalEvidenceValid: false,
  }), { markType: "official", staleReason: null });
});

test("NFL MTM reconciliation plans one supported final as provisional", () => {
  assert.deepEqual(planNflMtmReconciliation({
    postAnchorFinalEventIds: [77],
    conditionalEvidenceValid: true,
    provisionalOutcome: "home_win",
  }), {
    markType: "provisional",
    provisionalEventId: 77,
    provisionalOutcome: "home_win",
    staleReason: null,
  });
});

test("NFL MTM reconciliation plans pending for multiple or weak finals", () => {
  assert.equal(planNflMtmReconciliation({
    postAnchorFinalEventIds: [77, 78],
    conditionalEvidenceValid: true,
    provisionalOutcome: "home_win",
  }).markType, "pending_recalculation");
  assert.equal(planNflMtmReconciliation({
    postAnchorFinalEventIds: [77],
    conditionalEvidenceValid: false,
    provisionalOutcome: "home_win",
  }).markType, "pending_recalculation");
});

test("canonical final classification detects corrected scores and identities without kickoff gating", () => {
  const sourceActual = game(77, 10, 7);
  const corrected = { ...sourceActual, homeScore: 11 };
  const classified = classifyCanonicalNflFinals({
    sourceActuals: [sourceActual],
    canonicalFinals: [corrected, game(78, 3, 0)],
  });
  assert.equal(classified.incorporated.length, 0);
  assert.deepEqual(classified.pending.map((row) => row.eventId), [77, 78]);
  assert.deepEqual(classified.incompleteSourceEventIds, []);
  assert.deepEqual(classified.correctedEventIds, ["77"]);
});

test("missing canonical source final is explicit incomplete evidence", () => {
  const classified = classifyCanonicalNflFinals({
    sourceActuals: [game(77)],
    canonicalFinals: [],
  });
  assert.deepEqual(classified.incompleteSourceEventIds, ["77"]);
});

test("official version validates against its immutable source and exact game set", () => {
  const actuals = [game(1)];
  const result = validateCurrentMtmVersion({
    version: version(actuals),
    sourceSnapshot: source(actuals),
    actuals,
    incorporatedGames: [link(actuals[0])],
    officialValuations: officialValuations(),
    poolValue: 32,
  });
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("official conservation is mandatory", () => {
  const actuals = [game(1)];
  const result = validateCurrentMtmVersion({
    version: version(actuals),
    sourceSnapshot: source(actuals),
    actuals,
    incorporatedGames: [link(actuals[0])],
    officialValuations: officialValuations(31),
    poolValue: 32,
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("; "), /exactly the pool's 32 entries/);
});

function provisionalRows(eventId, count = 32, quality = "good") {
  return Array.from({ length: count }, (_, index) => ({
    eventId, outcome: "home_win", entryId: index + 1,
    grossBaseline: 1, grossConditional: 1, qualityStatus: quality,
  }));
}

test("a valid single provisional outcome requires complete conditional coverage", () => {
  const actuals = [game(1), game(2, 3, 10)];
  const result = validateCurrentMtmVersion({
    version: version(actuals, {
      markType: "provisional", provisionalEventId: 2, provisionalOutcome: "away_win",
    }),
    sourceSnapshot: source([actuals[0]]),
    actuals,
    incorporatedGames: [link(actuals[0]), link(actuals[1], { isProvisional: true })],
    conditionalRows: provisionalRows(2).map((row) => ({ ...row, outcome: "away_win" })),
    officialValuations: officialValuations(),
    poolValue: 32,
  });
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("provisional outcome must match the finalized score", () => {
  const actuals = [game(1), game(2, 3, 10)];
  const result = validateCurrentMtmVersion({
    version: version(actuals, {
      markType: "provisional", provisionalEventId: 2, provisionalOutcome: "home_win",
    }),
    sourceSnapshot: source([actuals[0]]),
    sourceActuals: [actuals[0]],
    actuals,
    incorporatedGames: [link(actuals[0]), link(actuals[1], { isProvisional: true })],
    conditionalRows: provisionalRows(2),
    officialValuations: officialValuations(),
    expectedEntryIds: Array.from({ length: 32 }, (_, index) => index + 1),
    poolValue: 32,
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("; "), /does not match the finalized score/);
});

test("pending versions identify unincorporated actuals", () => {
  const sourceActual = game(1);
  const pendingActual = game(2);
  const actuals = [sourceActual, pendingActual];
  const result = validateCurrentMtmVersion({
    version: version(actuals, {
      markType: "pending_recalculation",
      staleReason: "Game 2 finalized after the official mark.",
    }),
    sourceSnapshot: source([sourceActual]),
    sourceActuals: [sourceActual],
    actuals,
    incorporatedGames: [link(sourceActual)],
    pendingGames: [link(pendingActual, { linkageStatus: "pending" })],
    officialValuations: officialValuations(),
    poolValue: 32,
  });
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("two provisional outcomes are rejected", () => {
  const actuals = [game(1), game(2), game(3)];
  const result = validateCurrentMtmVersion({
    version: version(actuals, { markType: "provisional", provisionalEventId: 2, provisionalOutcome: "home_win" }),
    sourceSnapshot: source([actuals[0]]),
    actuals,
    incorporatedGames: [
      link(actuals[0]),
      link(actuals[1], { isProvisional: true }),
      link(actuals[2], { isProvisional: true }),
    ],
    conditionalRows: provisionalRows(2),
    officialValuations: officialValuations(),
    poolValue: 32,
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("; "), /At most one provisional/);
});

test("review, invalid, and cross-pool sources are rejected", () => {
  const actuals = [game(1)];
  for (const patch of [
    { sourceSnapshot: { ...source(actuals), status: "failed" } },
    { sourceSnapshot: { ...source(actuals), methodVersion: "mtm-v3-review" } },
    { sourceSnapshot: { ...source(actuals), poolId: 10 } },
  ]) {
    const result = validateCurrentMtmVersion({
      version: version(actuals), ...patch, actuals,
      incorporatedGames: [link(actuals[0])],
      officialValuations: officialValuations(),
      poolValue: 32,
    });
    assert.equal(result.valid, false);
  }
});

test("incomplete and poor-quality conditional rows are rejected", () => {
  const actuals = [game(1), game(2)];
  const result = validateCurrentMtmVersion({
    version: version(actuals, {
      markType: "provisional", provisionalEventId: 2, provisionalOutcome: "home_win",
    }),
    sourceSnapshot: source([actuals[0]]), actuals,
    incorporatedGames: [link(actuals[0]), link(actuals[1], { isProvisional: true })],
    conditionalRows: provisionalRows(2, 31, "insufficient"), poolValue: 32,
    officialValuations: officialValuations(),
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("; "), /complete 32-entry|acceptable quality/);
});

test("resolver reconciles signed owner totals to team MTM", () => {
  const result = buildCurrentMtmResolution({
    version: {
      id: 12, sourceSnapshotId: 44, markType: "official",
      actualsAsOf: "2026-01-03T00:00:00Z", mtmAsOf: "2026-01-04T00:00:00Z",
    },
    teamValues: [
      { entryId: 1, teamId: 101, teamName: "A", expectedPayout: 100, auctionPrice: 40 },
      { entryId: 2, teamId: 102, teamName: "B", expectedPayout: 200, auctionPrice: 60 },
    ],
    ownership: [
      {
        bidderId: 7, bidderName: "Owner", teamId: 101, effectiveShare: 0.5,
        originalCostBasis: 20, tradePaid: 5, tradeReceived: 0,
      },
      {
        bidderId: 7, bidderName: "Owner", teamId: 102, effectiveShare: 0.25,
        originalCostBasis: 15, tradePaid: 0, tradeReceived: 2,
      },
      {
        bidderId: 8, bidderName: "Short", teamId: 102, effectiveShare: -0.25,
        originalCostBasis: 0, tradePaid: 0, tradeReceived: 10,
      },
    ],
  });
  assert.equal(result.teams.reduce((sum, team) => sum + team.officialMtm, 0), 300);
  assert.equal(result.owners.find((owner) => owner.bidderId === 7).grossExpectedPayout, 100);
  assert.equal(result.owners.find((owner) => owner.bidderId === 7).net, 62);
  assert.equal(result.owners.find((owner) => owner.bidderId === 8).grossExpectedPayout, -50);
  assert.equal(result.owners.find((owner) => owner.bidderId === 8).net, -40);
});