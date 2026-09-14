import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MTM_EVIDENCE_POLICY,
  MtmEvidenceValidationError,
  acceptedYesBounds,
  aggregateMtmEvidence,
  assessMtmEvidence,
  estimateMtmTrades,
  normalizeMtmEvidence,
  validateMtmEvidence,
} from "./mtmEvidence.ts";

const asOf = "2026-09-20T14:00:00.000Z";

test("hard validation rejects inverted, out-of-range, and malformed evidence", () => {
  const result = validateMtmEvidence({
    id: "bad", yesBid: 0.8, yesAsk: 0.2,
    trades: [{ id: "t", price: 2, size: -1 }],
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    "yesBid must not exceed yesAsk",
    "trade t price must be a finite number between 0 and 1",
    "trade t size must be a non-negative finite number",
  ]);
  assert.throws(() => normalizeMtmEvidence({
    id: "bad", yesBid: -1,
  }), (error) => error instanceof MtmEvidenceValidationError);
});

test("one-sided bounds accept a zero active bid and distinguish settlement", () => {
  const zeroBid = normalizeMtmEvidence({
    id: "zero", status: "active", yesBid: 0, yesAsk: null,
  });
  assert.equal(zeroBid.yesBid, 0);
  assert.deepEqual(acceptedYesBounds(zeroBid), {
    lower: 0, upper: 1, oneSided: true, side: "bid-only",
  });
  const activeAssessment = assessMtmEvidence(zeroBid, asOf);
  assert.equal(activeAssessment.factors.activeZeroBid, true);
  assert.equal(activeAssessment.factors.settled, false);
  const settlement = assessMtmEvidence({
    id: "settled", status: "settled", settlement: "no", yesBid: 0,
  }, asOf);
  assert.equal(settlement.classification, "excluded");
  assert.match(settlement.exclusionReasons[0], /settled evidence/);
  assert.equal(settlement.factors.activeZeroBid, false);
  assert.deepEqual(acceptedYesBounds({
    id: "settled-yes", status: "settled", settlement: "yes", yesBid: 0, yesAsk: 1,
  }), {
    lower: 1, upper: 1, oneSided: false, side: "two-sided",
  });
  assert.deepEqual(acceptedYesBounds({
    id: "settled-no", status: "settled", settlement: "no", yesBid: 0, yesAsk: 1,
  }), {
    lower: 0, upper: 0, oneSided: false, side: "two-sided",
  });
});

test("spread, relative spread, depth, freshness, and metadata are deterministic factors", () => {
  const assessment = assessMtmEvidence({
    id: "quote", status: "active", yesBid: 0.4, yesAsk: 0.5,
    depth: { bid: 4, ask: 3 }, observedAt: "2026-09-20T13:59:00.000Z",
    provider: { provider: "primary", trust: 0.9 },
  }, asOf);
  assert.ok(Math.abs(assessment.factors.spread - 0.1) < 1e-12);
  assert.ok(Math.abs(assessment.factors.relativeSpread - 0.1 / 0.45) < 1e-12);
  assert.equal(assessment.factors.depth, 7);
  assert.ok(Math.abs(assessment.factors.freshness - 14 / 15) < 1e-12);
});

test("trade estimation removes duplicate IDs and caps weights", () => {
  const evidence = {
    id: "trades", yesBid: 0.2, yesAsk: 0.8,
    trades: [
      { id: "dup", price: 0.25, size: 100, timestamp: "2026-09-20T13:59:00.000Z" },
      { id: "dup", price: 0.55, size: 2, timestamp: "2026-09-20T13:59:30.000Z" },
      { id: "middle", price: 0.5, size: 2 },
      { id: "outlier", price: 0.99, size: 2 },
    ],
  };
  const estimate = estimateMtmTrades(evidence);
  assert.equal(estimate.duplicateTradeIdsRemoved, 1);
  assert.equal(estimate.acceptedTradeCount, 3);
  assert.equal(estimate.estimate, 0.55);
  assert.equal(estimate.effectiveWeight, 6);
  assert.ok(estimate.uncertainty > 0);
  assert.deepEqual(estimate, estimateMtmTrades({
    ...evidence, trades: [...evidence.trades].reverse(),
  }));
});

test("correlated groups are capped and influence metadata is explicit", () => {
  const input = [
    { id: "a", yesBid: 0.4, yesAsk: 0.42, status: "active", evidenceGroup: { id: "feed", cap: 0.25 } },
    { id: "b", yesBid: 0.41, yesAsk: 0.43, status: "active", evidenceGroup: { id: "feed", cap: 0.25 } },
    { id: "independent", yesBid: 0.7, yesAsk: 0.72, status: "active", evidenceGroup: "other" },
  ];
  const aggregate = aggregateMtmEvidence(input, asOf);
  assert.deepEqual(aggregate.groupCapsApplied, ["feed"]);
  assert.ok(aggregate.influenceByGroup.feed <= 0.25 + 1e-12);
  assert.ok(aggregate.influenceByGroup.other > aggregate.influenceByGroup.feed);
  assert.equal(aggregate.policyVersion, "mtm-evidence-v1");
});

test("material events and missing timestamps are explicit degradation reasons", () => {
  const result = assessMtmEvidence({
    id: "event", yesBid: 0.2, yesAsk: 0.4, status: "active",
    depth: { bid: 10, ask: 10 },
    provider: { provider: "primary", trust: 1 },
    materialEvent: { occurred: true, description: "rules update" },
  }, asOf, { minWarningScore: 0.3 });
  assert.equal(result.qualityStatus, "warning");
  assert.deepEqual(result.degradationReasons, [
    "spread exceeds policy",
    "relative spread exceeds policy",
    "timestamp is missing",
    "material event requires review",
  ]);
});