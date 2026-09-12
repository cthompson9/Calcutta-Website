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