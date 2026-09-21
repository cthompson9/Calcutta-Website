import assert from "node:assert/strict";
import test from "node:test";
import { mtmPipelineTestUtils } from "./mtmPipeline.ts";
import { intervalFixture } from "./mtmIntervalPolicy.test.mjs";

test("canonical playoff publication validator selects interval policy and rejects runner mismatch", () => {
  const { engine, state, config } = intervalFixture();
  assert.equal(mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(engine, state, config).error, null);
  engine.model.name = "legacy";
  delete engine.model.pricing_policy;
  assert.match(mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(engine, state, config).error, /mismatch/);
});

test("shadow capture preserves books and executions without inventing last-trade timestamps", () => {
  const at = new Date("2026-09-20T14:04:00Z");
  const capture = mtmPipelineTestUtils.buildMarketEvidenceReview([{
    team: "CHI", series: "KXNFLSTAGEOFELIM", fetchedAt: at,
    market: { ticker: "KXNFLSTAGEOFELIM-27CHI-WC", status: "active",
      yes_bid: 30, yes_ask: 50, last_price: 42,
      trades: [{ id: "t", price: .41, size: 4, timestamp: "2026-09-20T14:03:00Z" }] },
  }], at);
  assert.equal(capture.review_only, true);
  assert.equal(capture.rows[0].last_price, .42);
  assert.equal(capture.rows[0].trades.length, 1);
  assert.equal(capture.rows[0].trades[0].timestamp, "2026-09-20T14:03:00Z");
  assert.deepEqual(capture.rows[0].bounds, { lower: .3, upper: .5, oneSided: false, side: "two-sided" });
  const bare = mtmPipelineTestUtils.buildMarketEvidenceReview([{
    team: "CHI", series: "KXNFLSTAGEOFELIM", fetchedAt: at,
    market: { ticker: "KXNFLSTAGEOFELIM-27CHI-WC", status: "active", yes_bid: 30, yes_ask: 50, last_price: 42 },
  }], at);
  assert.deepEqual(bare.rows[0].trades, []);
});

test("malformed shadow evidence is retained as an error without bypassing canonical failure handling", () => {
  const capture = mtmPipelineTestUtils.buildMarketEvidenceReview([{
    team: "CHI", series: "KXNFLSTAGEOFELIM", fetchedAt: new Date("2026-09-20T14:04:00Z"),
    market: { ticker: "bad", status: "active", yes_bid: 90, yes_ask: 10 },
  }], new Date("2026-09-20T14:04:00Z"));
  assert.equal(capture.rows[0].eligible, false);
  assert.ok(capture.rows[0].capture_error);
});

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
  const fetchedAt = new Date("2026-09-20T14:04:00.000Z");
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
      fetchedAt,
    },
    ...["REG", "WC", "DIV", "CONF", "FL", "FW"].map((suffix) => ({
      series: "KXNFLSTAGEOFELIM",
      team: "SEA",
      market: {
        ticker: `KXNFLSTAGEOFELIM-27SEA-${suffix}`,
        yes_bid_dollars: "0.1000",
        status: "active",
      },
      fetchedAt,
    })),
  ];
  const derived = mtmPipelineTestUtils.deriveQuoteState(
    config,
    [{ code: "SEA", name: "Seattle Seahawks" }],
    raw,
    fetchedAt,
  );
  assert.deepEqual(derived.winLadders.SEA[0], {
    strike: 1,
    yes_bid: 1,
    yes_ask: 1,
    volume: 2139,
    status: "finalized",
    result: "yes",
  });
  assert.equal(mtmPipelineTestUtils.quoteVolume({ volume_fp: "81.75", volume: 2 }), 81);
});

test("passes resolved stage marks unchanged and keeps unresolved supported win bounds model-derived", () => {
  const fetchedAt = new Date("2026-09-20T14:04:00.000Z");
  const config = {
    kalshi: { series: {
      win_totals: "KXNFLWINS",
      stage_of_elimination: "KXNFLSTAGEOFELIM",
    } },
    pricing: { max_spread_for_mid: 0.15 },
  };
  const winMarket = {
    ticker: "KXNFLWINS-27IND-4",
    floor_strike: 4,
    yes_bid_dollars: "0.9000",
    yes_ask_dollars: "1.0000",
    status: "active",
  };
  const stageMarket = {
    ticker: "KXNFLSTAGEOFELIM-27IND-REG",
    yes_bid_dollars: "0.2000",
    yes_ask_dollars: "0.2600",
    status: "active",
  };
  const outcomes = [
    ["REG", "no_playoffs", 0.21],
    ["WC", "wild_card", 0.22],
    ["DIV", "divisional", 0.23],
    ["CONF", "conference", 0.24],
    ["FL", "sb_loss", 0.25],
    ["FW", "sb_win", 0.26],
  ];
  const raw = [
    {
      series: "KXNFLWINS",
      team: "IND",
      market: winMarket,
      fetchedAt,
      resolvedReference: { referencePrice: null },
    },
    ...outcomes.map(([suffix, _outcome, referencePrice], index) => ({
      series: "KXNFLSTAGEOFELIM",
      team: "IND",
      market: index === 0
        ? stageMarket
        : { ...stageMarket, ticker: `KXNFLSTAGEOFELIM-27IND-${suffix}` },
      fetchedAt,
      resolvedReference: { referencePrice },
    })),
  ];
  const derived = mtmPipelineTestUtils.deriveQuoteState(
    config,
    [{ code: "IND", name: "Indianapolis Colts" }],
    raw,
    fetchedAt,
  );
  assert.deepEqual(derived.winLadders.IND[0], {
    strike: 4,
    yes_bid: 0.9,
    yes_ask: 1,
    volume: 0,
    status: "active",
    result: null,
  });
  assert.deepEqual(derived.elimination.IND, Object.fromEntries(
    outcomes.map(([_suffix, outcome, referencePrice]) => [outcome, referencePrice]),
  ));
  assert.equal(stageMarket.yes_bid_dollars, "0.2000");
  assert.equal(stageMarket.yes_ask_dollars, "0.2600");
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
  const fetchedAt = new Date("2026-09-20T14:04:00.000Z");
  const config = { pricing: { max_spread_for_mid: 0.15 } };
  const teams = [{ code: "BUF", name: "Buffalo Bills" }];
  const raw = [{
    series: "WINS", team: "BUF",
    market: {
      ticker: "WINS-27BUF-1", floor_strike: 1, status: "active",
      yes_bid_dollars: "0.0100", yes_ask_dollars: "0.9700",
    },
    fetchedAt,
  }, ...["REG", "WC", "DIV", "CONF", "FL", "FW"].map((suffix) => ({
    series: "STAGE", team: "BUF",
    market: { ticker: `STAGE-27BUF-${suffix}`, yes_bid_dollars: "0.10", status: "active" },
    fetchedAt,
  }))];
  const derived = mtmPipelineTestUtils.deriveQuoteState({
    ...config,
    kalshi: { series: { win_totals: "WINS", stage_of_elimination: "STAGE" } },
  }, teams, raw, fetchedAt);
  const quality = mtmPipelineTestUtils.assessWinMarketQuality(
    config, teams, derived.winLadders,
  );
  assert.equal(derived.winLadders.BUF[0].yes_bid, null);
  assert.equal(derived.winLadders.BUF[0].yes_ask, null);
  assert.equal(derived.winLadders.BUF[0].interpolated, true);
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
  assert.match(rejected.error, /maximum win-market residual/);
  assert.equal(rejected.diagnostics.status, "failed");
  assert.equal(rejected.diagnostics.gate_result, "failed");
  assert.deepEqual(rejected.diagnostics.offending_teams, [{ team: "T0", residual: 0.4 }]);
});

test("fails the win audit when only one team's maximum residual exceeds tolerance", () => {
  const { state, engine } = completeEngineFixture();
  const teams = Object.keys(state.realized);
  const quality = Object.fromEntries(teams.map((team) => [team, {
    status: "good", trustedRungs: 2, wideRungs: 0, missingRungs: 15, reason: null,
  }]));
  engine.calibration = teams.map((team, index) => ({
    metric: "remaining_win_probability",
    team,
    target_probability: 0.5,
    sample_metadata: { posterior_probability: index === 0 ? 0.5753 : 0.5 },
  }));
  engine.diagnostics = { simulation: { effective_sample_size: 9876.5 } };
  const result = mtmPipelineTestUtils.validateFinalWinMarketQuality(
    engine, state, { sim: { calibration_tolerance: 0.03 } }, quality,
  );
  assert.ok(result.diagnostics.weighted_absolute_residual < 0.03);
  assert.ok(Math.abs(result.diagnostics.max_absolute_residual - 0.0753) < 1e-12);
  assert.match(result.error, /maximum win-market residual 0.075300.*T0/);
  assert.equal(result.diagnostics.status, "failed");
  assert.equal(result.diagnostics.gate_result, "failed");
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
      metric, team, target_probability, simulated_probability: target_probability, tolerance: 0.03,
    }))),
  ];
  const accepted = mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(
    engine, state, { sim: { calibration_tolerance: 0.03 } },
  );
  assert.equal(accepted.error, null);
  assert.equal(accepted.diagnostics.gate_result, "passed");
  assert.equal(accepted.diagnostics.families.sb_win.gate_result, "passed");

  engine.calibration.find((row) => row.metric === "sb_win" && row.team === "T0")
    .simulated_probability = 0.2;
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
      metric, team, target_probability, simulated_probability: target_probability, tolerance: 0.03,
  })));
  const rejected = mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(
    engine, state, { sim: { calibration_tolerance: 0.03 } },
  );
  assert.match(rejected.error, /missing targets for sb_win/);
  assert.equal(rejected.diagnostics.families.sb_win.gate_result, "failed");
  assert.deepEqual(rejected.diagnostics.families.sb_win.missing_teams, teams);
});

test("playoff audit uses achieved calibration metrics and rejects malformed coverage", () => {
  const { state, engine } = completeEngineFixture();
  const teams = Object.keys(state.realized);
  engine.calibration = teams.flatMap((team) =>
    ["berth", "divisional", "conference", "sb_berth", "sb_win"].map((metric) => ({
      metric,
      team,
      target_probability: metric === "berth" ? 0.6 : 0.2,
      simulated_probability: metric === "berth" && team === "T0" ? 0.5 : metric === "berth" ? 0.6 : 0.2,
      tolerance: 0.03,
    })));
  engine.projections.T0.p_stage.berth = 0.6;
  const achievedFailure = mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(
    engine, state, { sim: { calibration_tolerance: 0.03 } },
  );
  assert.match(achievedFailure.error, /exceeds tolerance for berth/);
  assert.equal(achievedFailure.diagnostics.families.berth.rows[0].final_probability, 0.5);

  const missing = structuredClone(engine);
  missing.calibration = missing.calibration.filter((row) =>
    !(row.metric === "sb_win" && row.team === "T0"));
  assert.match(
    mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(missing, state, {}).error,
    /missing targets for sb_win/,
  );

  const duplicate = structuredClone(engine);
  duplicate.calibration.push(structuredClone(
    duplicate.calibration.find((row) => row.metric === "sb_win" && row.team === "T0"),
  ));
  assert.match(
    mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(duplicate, state, {}).error,
    /duplicate metrics for sb_win/,
  );

  const nonfinite = structuredClone(engine);
  nonfinite.calibration.find((row) => row.metric === "sb_win" && row.team === "T0")
    .simulated_probability = "not-a-number";
  assert.match(
    mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(nonfinite, state, {}).error,
    /missing targets for sb_win/,
  );
});

test("run information separates requested settings and meaningful input identity", () => {
  const state = { realized: { BUF: { wins: 1 } }, entries: [], remaining_schedule: [] };
  const config = { sim: { seed: 17, monte_carlo_runs: 40000, model: "seeded_monte_carlo" } };
  const first = mtmPipelineTestUtils.buildRunInformation({
    config,
    state,
    inputProvenance: { fetched_at: "2026-09-20T14:00:00Z", source_id: "ledger-1" },
    rawQuotes: [{
      series: "WINS", team: "BUF", fetchedAt: new Date("2026-09-20T14:00:00Z"),
      market: { ticker: "WINS-BUF-10", updated_time: "2026-09-20T13:00:00Z", yes_bid: 40 },
    }],
  });
  const replayed = mtmPipelineTestUtils.buildRunInformation({
    config,
    state,
    inputProvenance: { fetched_at: "2026-09-20T15:00:00Z", source_id: "ledger-1" },
    rawQuotes: [{
      series: "WINS", team: "BUF", fetchedAt: new Date("2026-09-20T15:00:00Z"),
      market: { ticker: "WINS-BUF-10", updated_time: "2026-09-20T14:00:00Z", yes_bid: 40 },
    }],
  });
  assert.equal(first.requested.seed, 17);
  assert.equal(first.requested.path_count, 40000);
  assert.deepEqual(first.effective_configuration, config);
  assert.equal(first.requested.pricing_policy, "normalized-point-v2");
  const retainedSeed = first.effective_configuration.sim.seed;
  config.sim.seed = 99;
  assert.equal(first.effective_configuration.sim.seed, retainedSeed);
  assert.equal(first.confirmed, null);
  assert.equal(first.diagnostic_policy_version, "mtm-diagnostics-v2");
  assert.equal(first.meaningful_model_inputs_hash, replayed.meaningful_model_inputs_hash);

  const candidate = mtmPipelineTestUtils.compactCandidateDiagnostics({
    status: "failed",
    path_count: 123,
    model: { name: "seeded_monte_carlo", seed: 17 },
    projections: { BUF: { e_remaining_wins: 8, p_stage: { berth: 0.5 }, rating: 2 } },
    calibration: [{ metric: "berth", team: "BUF", simulated_probability: 0.5 }],
    diagnostics: {
      rating_fit: { status: "good" },
      runtime: { stages: { rating_fit: { completed: true } } },
      monte_carlo_sampling: { effective_sample_size: 90, max_weight: 0.02 },
    },
  });
  assert.equal(candidate.seed, 17);
  assert.equal(candidate.path_count, 123);
  assert.equal(candidate.projections.BUF.p_stage.berth, 0.5);
  assert.equal(candidate.final_weighted_calibration.length, 1);
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
  assert.equal(row.sourceObservedAt.toISOString(), "2026-09-20T14:03:00.000Z");
  assert.equal(row.qualityReport.role, "active_price");
  assert.equal(row.qualityReport.usedInFitting, true);
  assert.equal(row.qualityReport.captureTime, fetchedAt.toISOString());
  assert.equal(row.qualityReport.metadataUpdatedAt, "2026-09-20T14:03:00.000Z");
  assert.deepEqual(row.qualityReport.transformation, {
    kind: "bounds", lower: 0.42, upper: 1, oneSided: true, side: "bid-only",
  });
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

  const unusedStaleWide = {
    series: "KXNFLWINS",
    team: "BUF",
    market: {
      ticker: "WINS-27BUF-11",
      floor_strike: 11,
      status: "active",
      yes_bid_dollars: "0.01",
      yes_ask_dollars: "0.97",
    },
    sourceUrl: "https://example.test/events/BUF",
    fetchedAt: new Date("2026-09-20T13:00:00.000Z"),
  };
  const acceptedWithUnusedStale = mtmPipelineTestUtils.validateFinalPublicationQuality(
    engine,
    {},
    [...rawQuotes, unusedStaleWide],
    captureManifest,
    new Date("2026-09-20T14:04:00.000Z"),
    new Date("2026-09-20T14:04:00.000Z"),
  );
  assert.equal(acceptedWithUnusedStale.error, null);

  const expiredAtPublication = mtmPipelineTestUtils.validateFinalPublicationQuality(
    engine,
    {},
    rawQuotes,
    captureManifest,
    new Date("2026-09-20T14:04:00.000Z"),
    new Date("2026-09-20T14:10:00.000Z"),
  );
  assert.match(expiredAtPublication.error, /market evidence is stale/);

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

test("excluded elimination evidence cannot enter fitting through the bid-plus-cent path", () => {
  const capturedAt = new Date("2026-09-20T14:04:00.000Z");
  const staleAt = new Date("2026-09-20T13:00:00.000Z");
  const config = {
    pricing: { max_spread_for_mid: 0.15 },
    kalshi: { series: {
      win_totals: "WINS",
      stage_of_elimination: "STAGE",
    } },
  };
  const raw = [{
    series: "WINS",
    team: "BUF",
    market: {
      ticker: "WINS-27BUF-1",
      floor_strike: 1,
      status: "finalized",
      result: "yes",
    },
    fetchedAt: capturedAt,
  }, ...["REG", "WC", "DIV", "CONF", "FL", "FW"].map((suffix) => ({
    series: "STAGE",
    team: "BUF",
    market: {
      ticker: `STAGE-27BUF-${suffix}`,
      status: "active",
      yes_bid_dollars: "0.10",
    },
    fetchedAt: suffix === "WC" ? staleAt : capturedAt,
  }))];
  assert.throws(
    () => mtmPipelineTestUtils.deriveQuoteState(
      config,
      [{ code: "BUF", name: "Buffalo Bills" }],
      raw,
      capturedAt,
    ),
    /Incomplete stage-of-elimination quotes for BUF/,
  );
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

test("failed engine errors survive payout normalization without fabricated rounding failures", () => {
  const { state } = completeEngineFixture();
  for (const message of ["fresh rating fit failed", "set PYTHONHASHSEED=0 for reproducible bracket ordering"]) {
    const engine = { status: "failed", error: message };
    assert.equal(mtmPipelineTestUtils.normalizeEngineValuationPayouts(engine, state), message);
    assert.equal(mtmPipelineTestUtils.validateCompleteEngineSnapshot(engine, state), message);
    assert.equal(engine.valuations, undefined);
  }
  assert.equal(mtmPipelineTestUtils.normalizeEngineValuationPayouts({ status: "failed" }, state), "MTM engine failed.");
});

test("missing or malformed achieved win probabilities cannot fall back to target projections", () => {
  for (const invalid of [undefined, null, "", false, [], {}, -0.1, 1.1]) {
    const { state, engine } = completeEngineFixture();
    const teams = Object.keys(state.realized);
    const quality = Object.fromEntries(teams.map((team) => [team, {
      status: "good", trustedRungs: 2, wideRungs: 0, missingRungs: 15, reason: null,
    }]));
    engine.calibration = teams.map((team) => ({
      metric: "remaining_win_probability", team, target_probability: 0.5,
      sample_metadata: { posterior_probability: 0.5 },
    }));
    engine.diagnostics = { simulation: { effective_sample_size: 9876.5 } };
    engine.calibration[0].sample_metadata.posterior_probability = invalid;
    const result = mtmPipelineTestUtils.validateFinalWinMarketQuality(
      engine, state, { sim: { calibration_tolerance: 0.03 } }, quality,
    );
    assert.notEqual(result.error, null);
    assert.equal(result.diagnostics.gate_result, "failed");
    assert.ok(result.diagnostics.missing_teams.includes(teams[0]));
  }
});

test("playoff null measurements fail and supplied tolerances cannot relax the configured gate", () => {
  const { state, engine } = completeEngineFixture();
  const teams = Object.keys(state.realized);
  engine.calibration = teams.flatMap((team) =>
    ["berth", "divisional", "conference", "sb_berth", "sb_win"].map((metric) => ({
      metric, team, target_probability: 0, simulated_probability: 0, tolerance: 0.03,
    })));
  engine.calibration[0].simulated_probability = null;
  let result = mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(
    engine, state, { sim: { calibration_tolerance: 0.03 } },
  );
  assert.equal(result.diagnostics.gate_result, "failed");
  engine.calibration[0].simulated_probability = 0.2;
  engine.calibration[0].tolerance = 1;
  result = mtmPipelineTestUtils.validateFinalPlayoffMarketQuality(
    engine, state, { sim: { calibration_tolerance: 0.03 } },
  );
  assert.equal(result.diagnostics.gate_result, "failed");
  assert.equal(result.diagnostics.families.berth.rows[0].tolerance, 0.03);
});
