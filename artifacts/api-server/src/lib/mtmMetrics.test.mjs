import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMtmMetricRows,
  hasCompleteMtmMetricCoverage,
  MTM_METRICS,
} from "./mtmMetrics.ts";

function valuation(overrides = {}) {
  return {
    teamId: 7,
    teamName: "Test Team",
    conference: "AFC",
    contractSetId: "test-contracts",
    marketStatus: "live",
    marketStatusReasons: [],
    expectedWins: 9.25,
    playoffProbability: 0.7,
    divisionalProbability: 0.4,
    conferenceGameProbability: 0.2,
    superBowlProbability: 0.1,
    championshipProbability: 0.05,
    ...overrides,
  };
}

function calculation(valuations) {
  return {
    valuations,
    rawPointTotal: 0,
    normalizedShareTotal: 1,
    statusCounts: { live: 0, stale: 0, incomplete: 0 },
  };
}

const context = {
  calcuttaId: 41,
  periodId: 18,
  periodSequence: 7,
  snapshotKey: "canonical-mtm-period-7",
  snapshotDate: "2026-10-27",
  capturedAt: new Date("2026-10-27T12:00:00.000Z"),
  entryIdByTeam: new Map([[7, 107]]),
  realizedPtDiffByEntry: new Map([[107, -13]]),
};

test("MTM conversion writes the complete calculation vocabulary with provenance", () => {
  const rows = buildMtmMetricRows(calculation([valuation()]), context);
  assert.equal(rows.length, MTM_METRICS.length);
  assert.deepEqual(rows.map((row) => row.metric), MTM_METRICS);

  const values = new Map(rows.map((row) => [row.metric, Number(row.value)]));
  assert.equal(values.get("win"), 9.25);
  assert.equal(values.get("tie"), 0);
  assert.equal(values.get("pt_diff"), -13);
  assert.equal(values.get("playoff_berth"), 0.7);
  assert.equal(values.get("win_super_bowl"), 0.05);

  assert.ok(rows.every((row) =>
    row.calcuttaId === 41 &&
    row.entryId === 107 &&
    row.periodId === 18 &&
    row.basis === "mtm" &&
    row.source === "kalshi" &&
    row.snapshotAt.toISOString() === "2026-10-27T12:00:00.000Z" &&
    row.sourceData.rawSnapshotKey === "canonical-mtm-period-7" &&
    row.sourceData.rawSnapshotDate === "2026-10-27" &&
    row.sourceData.marketStatus === "live"
  ));
  assert.equal(hasCompleteMtmMetricCoverage(rows, [107]), true);
});

test("stale values remain auditable while incomplete markets create no assertions", () => {
  const stale = buildMtmMetricRows(
    calculation([valuation({
      marketStatus: "stale",
      marketStatusReasons: ["Thin top of book."],
    })]),
    context,
  );
  assert.equal(stale.length, MTM_METRICS.length);
  assert.equal(stale[0].sourceData.marketStatus, "stale");
  assert.deepEqual(stale[0].sourceData.marketStatusReasons, ["Thin top of book."]);

  const incomplete = buildMtmMetricRows(
    calculation([valuation({
      marketStatus: "incomplete",
      marketStatusReasons: ["Championship quote unavailable."],
      championshipProbability: 0,
    })]),
    context,
  );
  assert.deepEqual(incomplete, []);
  assert.equal(hasCompleteMtmMetricCoverage(incomplete, [107]), false);
});

test("one incomplete team withholds the capture-wide normalized metric set", () => {
  const entryIdByTeam = new Map([[7, 107], [8, 108]]);
  const rows = buildMtmMetricRows(
    calculation([
      valuation(),
      valuation({
        teamId: 8,
        marketStatus: "incomplete",
        marketStatusReasons: ["Required quote unavailable."],
      }),
    ]),
    {
      ...context,
      entryIdByTeam,
      realizedPtDiffByEntry: new Map([[107, -13], [108, 4]]),
    },
  );
  assert.deepEqual(rows, []);
});

test("in-season MTM cannot default missing realized point differential to zero", () => {
  assert.throws(
    () => buildMtmMetricRows(
      calculation([valuation()]),
      { ...context, realizedPtDiffByEntry: new Map() },
    ),
    /requires realized point differential/,
  );

  const weekZero = buildMtmMetricRows(
    calculation([valuation()]),
    {
      ...context,
      periodSequence: 0,
      realizedPtDiffByEntry: new Map(),
    },
  );
  assert.equal(
    Number(weekZero.find((row) => row.metric === "pt_diff").value),
    0,
  );
});

test("coverage requires every supported metric for every selected entry", () => {
  const first = buildMtmMetricRows(calculation([valuation()]), context);
  const second = first.map((row) => ({ ...row, entryId: 108 }));
  assert.equal(hasCompleteMtmMetricCoverage([...first, ...second], [107, 108]), true);
  assert.equal(
    hasCompleteMtmMetricCoverage([...first, ...second.slice(1)], [107, 108]),
    false,
  );
});