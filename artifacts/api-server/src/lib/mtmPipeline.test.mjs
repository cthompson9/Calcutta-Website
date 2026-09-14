import assert from "node:assert/strict";
import test from "node:test";
import { mtmPipelineTestUtils } from "./mtmPipeline.ts";

test("normalizes Kalshi fixed-point and legacy cent quotes", () => {
  assert.equal(
    mtmPipelineTestUtils.quoteValue(
      { yes_bid_dollars: "0.4200", yes_bid: 99 },
      "yes_bid",
    ),
    0.42,
  );
  assert.equal(
    mtmPipelineTestUtils.quoteValue({ yes_ask: 57 }, "yes_ask"),
    0.57,
  );
  assert.equal(
    mtmPipelineTestUtils.quoteValue({ yes_ask: null }, "yes_ask"),
    null,
  );
});

test("preserves settled win contracts and fixed-point volume for the engine", () => {
  const config = {
    kalshi: { series: {
      win_totals: "KXNFLWINS",
      stage_of_elimination: "KXNFLSTAGEOFELIM",
    } },
  };
  const raw = [
    {
      series: "KXNFLWINS",
      team: "SEA",
      market: {
        ticker: "KXNFLWINS-27SEA-1",
        floor_strike: 1,
        yes_bid_dollars: "0.0000",
        yes_ask_dollars: "1.0000",
        volume_fp: "2139.21",
        status: "finalized",
        result: "yes",
      },
    },
    ...["REG", "WC", "DIV", "CONF", "FL", "FW"].map((suffix) => ({
      series: "KXNFLSTAGEOFELIM",
      team: "SEA",
      market: {
        ticker: `KXNFLSTAGEOFELIM-27SEA-${suffix}`,
        yes_bid_dollars: "0.1000",
      },
    })),
  ];
  const derived = mtmPipelineTestUtils.deriveQuoteState(
    config,
    [{ code: "SEA", name: "Seattle Seahawks" }],
    raw,
  );
  assert.deepEqual(derived.winLadders.SEA[0], {
    strike: 1,
    yes_bid: 0,
    yes_ask: 1,
    volume: 2139,
    status: "finalized",
    result: "yes",
  });
  assert.equal(mtmPipelineTestUtils.quoteVolume({ volume_fp: "81.75", volume: 2 }), 81);
});

test("persists the exact Kalshi event request URL with every nested market", () => {
  const originalUrl = mtmPipelineTestUtils.kalshiEventUrl(
    "https://historical.example.test/trade-api/v2/",
    "KXNFLWINS-27BUF",
  );
  const [row] = mtmPipelineTestUtils.buildMarketQuoteRows(17, [{
    series: "KXNFLWINS",
    team: "BUF",
    market: { ticker: "KXNFLWINS-27BUF-W10", yes_bid: 42 },
    sourceUrl: originalUrl,
    fetchedAt: new Date("2026-09-20T14:04:00.000Z"),
  }]);
  assert.equal(
    row.sourceUrl,
    "https://historical.example.test/trade-api/v2/events/KXNFLWINS-27BUF?with_nested_markets=true",
  );
  assert.equal(row.fetchedAt.toISOString(), "2026-09-20T14:04:00.000Z");
});

test("maps every confirmed stage ticker suffix to the frozen engine contract", () => {
  const expected = {
    REG: "no_playoffs",
    WC: "wild_card",
    DIV: "divisional",
    CONF: "conference",
    FL: "sb_loss",
    FW: "sb_win",
  };
  for (const [suffix, outcome] of Object.entries(expected)) {
    assert.equal(
      mtmPipelineTestUtils.classifyEliminationMarket({
        ticker: `KXNFLSTAGEOFELIM-27BUF-${suffix}`,
      }),
      outcome,
    );
  }
});

test("coalesces retries into one UTC as-of hour", () => {
  assert.equal(
    mtmPipelineTestUtils.hourStart(
      new Date("2026-10-27T07:59:59.999Z"),
    ).toISOString(),
    "2026-10-27T07:00:00.000Z",
  );
});

test("rejects partial engine output before a snapshot can be promoted", () => {
  const state = {
    pot: 3200,
    entries: [],
    realized: {},
  };
  assert.match(
    mtmPipelineTestUtils.validateCompleteEngineSnapshot(
      {
        status: "ok",
        as_of: "2026-08-29T00:00:00.000Z",
        projections: {},
        valuations: [],
      },
      state,
    ),
    /32 unique teams/,
  );
});

function completeEngineFixture() {
  const teams = Array.from({ length: 32 }, (_, index) => `T${index}`);
  const state = {
    pot: 3200,
    realized: Object.fromEntries(teams.map((team) => [
      team,
      { wins: 0, ties: 0, adj_pt_diff: 0 },
    ])),
    entries: teams.map((team, index) => ({
      entry_id: String(index + 1),
      team,
      price: 100,
    })),
  };
  const projections = Object.fromEntries(teams.map((team) => [team, {
    e_wins_total: 8.5,
    e_remaining_wins: 8.5,
    e_remaining_raw_diff: 0,
    e_remaining_marquee_addon: 0,
    rating: 0,
    p_stage: {
      berth: 0.5,
      divisional: 0.25,
      conference: 0.125,
      sb_berth: 0.0625,
      sb_win: 0.03125,
    },
  }]));
  const valuations = state.entries.map((entry) => ({
    entry_id: entry.entry_id,
    team: entry.team,
    expected_points: 100,
    expected_share: 1 / 32,
    expected_payout: 100,
    auction_price: 100,
    mtm_multiple: 1,
  }));
  return {
    state,
    engine: {
      status: "ok",
      as_of: "2026-08-29T00:00:00.000Z",
      projections,
      valuations,
    },
  };
}

test("accepts a complete pool-conserving engine snapshot", () => {
  const { state, engine } = completeEngineFixture();
  assert.equal(
    mtmPipelineTestUtils.validateCompleteEngineSnapshot(engine, state),
    null,
  );
});

test("rejects an engine snapshot whose payouts do not conserve the pool", () => {
  const { state, engine } = completeEngineFixture();
  engine.valuations[0].expected_payout += 0.01;
  engine.valuations[0].expected_share = engine.valuations[0].expected_payout / state.pot;
  assert.match(
    mtmPipelineTestUtils.validateCompleteEngineSnapshot(engine, state),
    /payouts total/,
  );
});

test("rejects fractional-cent published payouts", () => {
  const { state, engine } = completeEngineFixture();
  engine.valuations[0].expected_payout = 100.001;
  engine.valuations[0].expected_share = engine.valuations[0].expected_payout / state.pot;
  assert.match(
    mtmPipelineTestUtils.validateCompleteEngineSnapshot(engine, state),
    /fractional-cent payout/,
  );
});

test("normalizes a legitimate independent-rounding residual before validation", () => {
  const { state, engine } = completeEngineFixture();
  engine.valuations[0].expected_payout = 100.005;
  engine.valuations[1].expected_payout = 100.005;
  assert.equal(
    mtmPipelineTestUtils.normalizeEngineValuationPayouts(engine, state),
    null,
  );
  assert.equal(
    mtmPipelineTestUtils.validateCompleteEngineSnapshot(engine, state),
    null,
  );
  assert.equal(
    engine.valuations.reduce((sum, valuation) => sum + Math.round(valuation.expected_payout * 100), 0),
    320_000,
  );
});

test("does not normalize a material engine payout mismatch", () => {
  const { state, engine } = completeEngineFixture();
  engine.valuations[0].expected_payout = 110;
  assert.match(
    mtmPipelineTestUtils.normalizeEngineValuationPayouts(engine, state),
    /maximum cent-rounding residual/,
  );
});

test("bounds full-season conditional persistence batches", () => {
  const rows = Array.from({ length: 272 * 3 * 32 }, (_, index) => index);
  const batches = mtmPipelineTestUtils.conditionalPersistenceBatches(rows);
  assert.equal(batches.flat().length, rows.length);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.length <= 500));
});

test("rejects invalid stage nesting and mismatched entry teams", () => {
  const invalidStage = completeEngineFixture();
  invalidStage.engine.projections.T0.p_stage.sb_win = 0.9;
  assert.match(
    mtmPipelineTestUtils.validateCompleteEngineSnapshot(
      invalidStage.engine,
      invalidStage.state,
    ),
    /invalid nested stage probabilities/,
  );

  const mismatchedTeam = completeEngineFixture();
  mismatchedTeam.engine.valuations[0].team = "T1";
  assert.match(
    mtmPipelineTestUtils.validateCompleteEngineSnapshot(
      mismatchedTeam.engine,
      mismatchedTeam.state,
    ),
    /mismatched team/,
  );
});

test("retains a fulfilled win-total response when the paired stage request fails", () => {
  const merged = mtmPipelineTestUtils.mergeTeamQuoteResults(
    "BUF",
    { win_totals: "KXNFLWINS", stage_of_elimination: "KXNFLSTAGEOFELIM" },
    { status: "fulfilled", value: [{ ticker: "KXNFLWINS-27BUF-10" }] },
    { status: "rejected", reason: new Error("timeout") },
  );
  assert.equal(merged.raw.length, 1);
  assert.equal(merged.raw[0].market.ticker, "KXNFLWINS-27BUF-10");
  assert.match(merged.errors[0], /stage of elimination.*timeout/);
});

test("keeps each Kalshi response URL and fetch time with its own markets", () => {
  const fetchedAt = new Date("2026-09-20T14:04:12.345Z");
  const merged = mtmPipelineTestUtils.mergeTeamQuoteResults(
    "BUF",
    { win_totals: "KXNFLWINS", stage_of_elimination: "KXNFLSTAGEOFELIM" },
    {
      status: "fulfilled",
      value: {
        markets: [{ ticker: "KXNFLWINS-27BUF-10" }],
        sourceUrl: "https://historical.example/events/KXNFLWINS-27BUF?with_nested_markets=true",
        fetchedAt,
      },
    },
    { status: "rejected", reason: new Error("timeout") },
  );
  assert.equal(merged.raw[0].sourceUrl, "https://historical.example/events/KXNFLWINS-27BUF?with_nested_markets=true");
  assert.equal(merged.raw[0].fetchedAt, fetchedAt);
});

test("treats an empty successful Kalshi response as missing market evidence", () => {
  const merged = mtmPipelineTestUtils.mergeTeamQuoteResults(
    "BUF",
    { win_totals: "KXNFLWINS", stage_of_elimination: "KXNFLSTAGEOFELIM" },
    { status: "fulfilled", value: [] },
    { status: "fulfilled", value: [] },
  );
  assert.deepEqual(merged.raw, []);
  assert.deepEqual(merged.errors, [
    "BUF win totals: no markets received",
    "BUF stage of elimination: no markets received",
  ]);
});

test("rejects overlap between completed and remaining canonical fixtures", () => {
  const completed = ["1:BUF:NYJ"];
  const remaining = [
    "1:BUF:NYJ",
    ...Array.from({ length: 270 }, (_, index) => `2:A${index}:H${index}`),
  ];
  assert.match(
    mtmPipelineTestUtils.validateScheduleIdentitySets(completed, remaining),
    /overlap/,
  );
});

test("requires an explicitly active unsettled quote", () => {
  assert.equal(
    mtmPipelineTestUtils.validateActiveQuote({
      status: "active", yes_bid_dollars: "0.41", yes_ask_dollars: "0.44",
    }),
    null,
  );
  assert.match(
    mtmPipelineTestUtils.validateActiveQuote({
      status: "closed", yes_bid_dollars: "0.41", yes_ask_dollars: "0.44",
    }),
    /not active/,
  );
  assert.match(
    mtmPipelineTestUtils.validateActiveQuote({
      status: "active", result: "yes", yes_bid_dollars: "0.41", yes_ask_dollars: "0.44",
    }),
    /settled result/,
  );
  assert.equal(
    mtmPipelineTestUtils.validateActiveQuote({ status: "settled", result: "yes" }),
    null,
  );
});

test("does not treat Snapshot-14-style 1/97 books as good win evidence", () => {
  const config = { pricing: { max_spread_for_mid: 0.15 } };
  const teams = [{ code: "BUF", name: "Buffalo Bills" }];
  const raw = [{
    series: "WINS", team: "BUF",
    market: {
      ticker: "WINS-27BUF-1", floor_strike: 1, status: "active",
      yes_bid_dollars: "0.0100", yes_ask_dollars: "0.9700",
    },
  }, ...["REG", "WC", "DIV", "CONF", "FL", "FW"].map((suffix) => ({
    series: "STAGE", team: "BUF",
    market: { ticker: `STAGE-27BUF-${suffix}`, yes_bid_dollars: "0.10" },
  }))];
  const derived = mtmPipelineTestUtils.deriveQuoteState({
    ...config,
    kalshi: { series: { win_totals: "WINS", stage_of_elimination: "STAGE" } },
  }, teams, raw);
  const quality = mtmPipelineTestUtils.assessWinMarketQuality(
    config, teams, derived.winLadders,
  );
  assert.equal(derived.winLadders.BUF[0].yes_bid, null);
  assert.equal(derived.winLadders.BUF[0].yes_ask, null);
  assert.equal(quality.BUF.status, "missing");
  assert.equal(quality.BUF.wideRungs, 1);
});

test("checks final weighted win quality and reports the final ESS", () => {
  const { state, engine } = completeEngineFixture();
  const teams = Object.keys(state.realized).map((code) => ({ code, name: code }));
  const quality = Object.fromEntries(teams.map(({ code }) => [code, {
    status: "good", trustedRungs: 2, wideRungs: 0, missingRungs: 15, reason: null,
  }]));
  engine.calibration = teams.map(({ code }) => ({
    metric: "remaining_win_probability", team: code,
    target_probability: 0.5, sample_metadata: { posterior_probability: 0.5 },
  }));
  engine.diagnostics = { simulation: { effective_sample_size: 9876.5 } };
  const accepted = mtmPipelineTestUtils.validateFinalWinMarketQuality(
    engine, state, { sim: { calibration_tolerance: 0.03 } }, quality,
  );
  assert.equal(accepted.error, null);
  assert.equal(accepted.effectiveSampleSize, 9876.5);
  engine.calibration[0].sample_metadata.posterior_probability = 0.9;
  const rejected = mtmPipelineTestUtils.validateFinalWinMarketQuality(
    engine, state, { sim: { calibration_tolerance: 0.03 } }, quality,
  );
  assert.match(rejected.error, /weighted win-market residual/);
});

test("blocks a win-calibrated run when any playoff family misses market expectations", () => {
  const { state, engine } = completeEngineFixture();
  const teams = Object.keys(state.realized);
  engine.calibration = [
    ...teams.map((team) => ({
      metric: "remaining_win_probability", team,
      target_probability: 0.5, sample_metadata: { posterior_probability: 0.5 },
    })),
    ...teams.flatMap((team) => [
      ["berth", 0.5],
      ["divisional", 0.25],
      ["conference", 0.125],
      ["sb_berth", 0.0625],
      ["sb_win", 0.03125],
    ].map(([metric, target_probability]) => ({
      metric, team, target_probability, tolerance: 0.03,
    }))),
  ];
  const accepted = mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(
    engine, state, { sim: { calibration_tolerance: 0.03 } },
  );
  assert.equal(accepted.error, null);
  assert.equal(accepted.diagnostics.gate_result, "passed");
  assert.equal(accepted.diagnostics.families.sb_win.gate_result, "passed");

  engine.projections.T0.p_stage.sb_win = 0.2;
  const rejected = mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(
    engine, state, { sim: { calibration_tolerance: 0.03 } },
  );
  assert.match(rejected.error, /exceeds tolerance for sb_win/);
  assert.equal(rejected.diagnostics.gate_result, "failed");
  assert.equal(rejected.diagnostics.families.sb_win.gate_result, "failed");
  assert.equal(rejected.diagnostics.families.sb_win.rows[0].gate_result, "failed");
  assert.equal(rejected.diagnostics.families.sb_win.rows[0].tolerance, 0.03);
  assert.ok(rejected.diagnostics.families.sb_win.rows[0].residual > 0.16);
});

test("fails closed when a payout-driving playoff calibration family is missing", () => {
  const { state, engine } = completeEngineFixture();
  const teams = Object.keys(state.realized);
  engine.calibration = teams.flatMap((team) => [
    ["berth", 0.5],
    ["divisional", 0.25],
    ["conference", 0.125],
    ["sb_berth", 0.0625],
  ].map(([metric, target_probability]) => ({
    metric, team, target_probability, tolerance: 0.03,
  })));
  const rejected = mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(
    engine, state, { sim: { calibration_tolerance: 0.03 } },
  );
  assert.match(rejected.error, /missing targets for sb_win/);
  assert.equal(rejected.diagnostics.families.sb_win.gate_result, "failed");
  assert.deepEqual(rejected.diagnostics.families.sb_win.missing_teams, teams);
});

test("persists additive evidence metadata without collapsing one-sided books", () => {
  const fetchedAt = new Date("2026-09-20T14:04:00.000Z");
  const [row] = mtmPipelineTestUtils.buildMarketQuoteRows(22, [{
    series: "KXNFLWINS", team: "BUF",
    market: {
      ticker: "KXNFLWINS-27BUF-10", floor_strike: 10, status: "active",
      yes_bid_dollars: "0.42", yes_ask_dollars: null, volume_fp: "17",
      observation_id: "obs-10", updated_time: "2026-09-20T14:03:00.000Z",
    },
    sourceUrl: "https://example.test/events/BUF?with_nested_markets=true",
    fetchedAt,
    completenessManifest: { expected: 17, received: 1 },
    captureMetadata: { request_id: "capture-1" },
  }]);
  assert.equal(row.yesBid, "0.42");
  assert.equal(row.yesAsk, null);
  assert.equal(row.normalizedYesBid, "0.42");
  assert.equal(row.normalizedYesAsk, null);
  assert.equal(row.observationId, "obs-10");
  assert.equal(row.provider, "kalshi");
  assert.equal(row.qualityPolicyVersion, "mtm-evidence-v1");
  assert.equal(row.acceptedLower, "0.42");
  assert.equal(row.acceptedUpper, "1");
  assert.deepEqual(row.completenessManifest, { expected: 17, received: 1 });
  assert.deepEqual(row.rawMetadata, { request_id: "capture-1" });
  assert.equal(row.evidenceGroup.id, "kalshi:KXNFLWINS:BUF");
});

test("builds stable review-only joint-fit constraints with correlated groups", () => {
  const fetchedAt = new Date("2026-09-20T14:04:00.000Z");
  const raw = [
    {
      series: "KXNFLWINS", team: "BUF",
      market: {
        ticker: "KXNFLWINS-27BUF-10", floor_strike: 10, status: "active",
        yes_bid_dollars: "0.42", yes_ask_dollars: "0.44",
      }, fetchedAt,
    },
    {
      series: "KXNFLSTAGEOFELIM", team: "BUF",
      market: {
        ticker: "KXNFLSTAGEOFELIM-27BUF-WC", status: "active",
        yes_bid_dollars: "0.25", yes_ask_dollars: "0.26",
      }, fetchedAt,
    },
    {
      series: "KXNFLSTAGEOFELIM", team: "BUF",
      market: {
        ticker: "KXNFLSTAGEOFELIM-27BUF-REG", status: "active",
        yes_bid_dollars: "0.10", yes_ask_dollars: "0.11",
      }, fetchedAt,
    },
    {
      series: "KXNFLWINS", team: "BUF",
      market: {
        ticker: "KXNFLWINS-27BUF-11", floor_strike: 11, status: "active",
        yes_bid_dollars: "0.01", yes_ask_dollars: "0.97",
      }, fetchedAt,
    },
  ];
  const first = mtmPipelineTestUtils.buildJointFitConstraints(raw);
  const second = mtmPipelineTestUtils.buildJointFitConstraints([...raw].reverse());
  assert.deepEqual(first, second);
  assert.ok(first.some((row) => row.metric === "no_playoffs:BUF"));
  const berth = first.find((row) => row.metric === "stage:BUF:berth");
  assert.ok(berth);
  assert.ok(berth.lower > 0.8 && berth.upper < 0.95);
  assert.notEqual(berth.lower, 0.25);
  assert.equal(berth.group, "advancement:BUF");
  assert.equal(berth.group_cap, 0.5);
  const win = first.find((row) => row.metric === "wins:BUF:10");
  assert.equal(win.group, "wins:BUF");
  const capped = mtmPipelineTestUtils.buildJointFitConstraints(raw, { "wins:BUF": 0.1 });
  const cappedWin = capped.find((row) => row.metric === "wins:BUF:10");
  assert.equal(cappedWin.group_cap, 0.1);
  assert.ok(cappedWin.reliability <= 0.1);
  const settled = mtmPipelineTestUtils.buildJointFitConstraints([{
    series: "KXNFLSTAGEOFELIM", team: "BUF",
    market: {
      ticker: "KXNFLSTAGEOFELIM-27BUF-REG", status: "finalized", result: "yes",
    },
    fetchedAt,
  }]);
  const settledNoPlayoffs = settled.find((row) => row.metric === "no_playoffs:BUF");
  assert.equal(settledNoPlayoffs.lower, 1);
  assert.equal(settledNoPlayoffs.upper, 1);
});

test("publication audit fail-closes every required gate and emits an official-compatible pass", () => {
  const { engine } = completeEngineFixture();
  engine.path_count = 40000;
  engine.diagnostics = {
    simulation: { effective_sample_size: 2500, max_weight: 0.005 },
    review_gates: { checks: { precision: true, support: true } },
  };
  const rawQuotes = [{
    series: "KXNFLWINS", team: "BUF",
    market: {
      ticker: "WINS-27BUF-10", floor_strike: 10, status: "active",
      yes_bid_dollars: "0.40", yes_ask_dollars: "0.42",
    },
    sourceUrl: "https://example.test/events/BUF",
    fetchedAt: new Date("2026-09-20T14:04:00.000Z"),
    completenessManifest: { complete: true, expected: 1, received: 1 },
  }];
  const captureManifest = {
    policy: "internal-request-capture-v1",
    expected_request_count: 1, fulfilled_request_count: 1,
    failed_request_count: 0, nonempty_request_count: 1, complete: true,
    requests: [{
      identity: "BUF:WIN:WINS-27BUF", team: "BUF", series: "WIN",
      ticker: "WINS-27BUF", status: "fulfilled", market_count: 1,
      source_url: "https://example.test/events/BUF",
      fetched_at: "2026-09-20T14:04:00.000Z",
      provider_manifest: { complete: true }, error: null,
    }],
  };
  const accepted = mtmPipelineTestUtils.validateFinalPublicationQuality(
    engine, {}, rawQuotes, captureManifest,
  );
  assert.equal(accepted.error, null);
  assert.equal(accepted.audit.status, "good");
  assert.equal(accepted.audit.policy_version, "mtm-evidence-v1");
  assert.equal(accepted.audit.publication_decision, "approved");
  assert.equal(accepted.audit.gate_results.capture_completeness, "passed");
  assert.equal(accepted.audit.gate_results.final_ess, "passed");
  assert.equal(accepted.audit.gate_results.max_weight, "passed");
  assert.equal(accepted.audit.gate_results.precision, "passed");
  assert.equal(accepted.audit.gate_results.support, "passed");

  const missingManifest = mtmPipelineTestUtils.validateFinalPublicationQuality(
    engine, {}, [{ ...rawQuotes[0], completenessManifest: undefined }], null,
  );
  assert.match(missingManifest.error, /capture manifest/);
  const missingEssEngine = structuredClone(engine);
  delete missingEssEngine.diagnostics.simulation.effective_sample_size;
  const missingEss = mtmPipelineTestUtils.validateFinalPublicationQuality(
    missingEssEngine, {}, rawQuotes, captureManifest,
  );
  assert.match(missingEss.error, /ESS/);
  const missingWeightEngine = structuredClone(engine);
  delete missingWeightEngine.diagnostics.simulation.max_weight;
  const missingWeight = mtmPipelineTestUtils.validateFinalPublicationQuality(
    missingWeightEngine, {}, rawQuotes, captureManifest,
  );
  assert.match(missingWeight.error, /weight/);
  const missingReviewEngine = structuredClone(engine);
  missingReviewEngine.diagnostics.review_gates.checks.precision = undefined;
  missingReviewEngine.diagnostics.review_gates.checks.support = undefined;
  const missingReview = mtmPipelineTestUtils.validateFinalPublicationQuality(
    missingReviewEngine, { prototype_review: { require_precision_support: true } }, rawQuotes, captureManifest,
  );
  assert.match(missingReview.error, /precision/);
  assert.match(missingReview.error, /support/);
  engine.diagnostics.simulation.effective_sample_size = 1000;
  const rejected = mtmPipelineTestUtils.validateFinalPublicationQuality(
    engine, {}, rawQuotes, captureManifest,
  );
  assert.match(rejected.error, /global ESS/);
});

test("internal capture manifest counts mixed and empty fetch outcomes independently of provider manifests", () => {
  const request = (identity, status, market_count) => ({
    identity, team: identity.split(":")[0], series: identity.split(":")[1],
    ticker: identity, status, market_count,
    source_url: `https://example.test/events/${identity}`, fetched_at: "2026-09-20T14:04:00.000Z",
    provider_manifest: { complete: true }, error: status === "failed" ? "timeout" : null,
  });
  const mixed = mtmPipelineTestUtils.buildInternalCaptureManifest(4, [
    request("BUF:WIN:wins", "fulfilled", 1),
    request("BUF:STAGE:stage", "fulfilled", 0),
    request("ARI:WIN:wins", "failed", 0),
  ]);
  assert.equal(mixed.complete, false);
  assert.equal(mixed.expected_request_count, 4);
  assert.equal(mixed.fulfilled_request_count, 2);
  assert.equal(mixed.failed_request_count, 1);
  assert.equal(mixed.nonempty_request_count, 1);
  assert.equal(mixed.requests.length, 3);

  const complete = mtmPipelineTestUtils.buildInternalCaptureManifest(2, [
    request("ARI:STAGE:stage", "fulfilled", 3),
    request("ARI:WIN:wins", "fulfilled", 17),
  ]);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.requests.map((row) => row.identity), [
    "ARI:STAGE:stage", "ARI:WIN:wins",
  ]);
});