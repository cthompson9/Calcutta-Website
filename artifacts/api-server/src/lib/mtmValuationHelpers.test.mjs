import assert from "node:assert/strict";
import test from "node:test";
import {
  flattenEngineConditionals,
  chooseProvisionalOutcome,
  computeValuationInvariants,
  calculateSignedOwnerValue,
  calculateMidpointDrift,
} from "./mtmValuationHelpers.ts";

test("flattens nested conditional outcomes for every team", () => {
  const result = flattenEngineConditionals({
    0: { event_id: 7, outcomes: {
      home_win: { AAA: { gross_expected_payout: 10, sample_share: 0.5, quality_status: "good" } },
      away_win: { AAA: { gross_expected_payout: 8, sample_share: 0.3, quality_status: "warning" } },
      tie: { AAA: { gross_expected_payout: 9, sample_share: 0.2, quality_status: "insufficient" } },
    } },
  }, new Map([["AAA", 1]]), new Map([[1, 7]]));
  assert.equal(result.length, 3);
  assert.equal(result[0].grossDelta, 3);
  assert.equal(result[2].qualityStatus, "insufficient");
});

test("provisional selection distinguishes suppression branches", () => {
  const base = { eventId: 1, final: true, completeIdentity: true, completeScore: true, observedAt: "2026-01-02", homeScore: 3, awayScore: 0 };
  assert.equal(chooseProvisionalOutcome({ actualAnchor: "2026-01-01", candidates: [], conditionalQuality: new Map() }).reason, "zero unanchored finals");
  assert.equal(chooseProvisionalOutcome({ actualAnchor: "2026-01-01", candidates: [base, { ...base, eventId: 2 }], conditionalQuality: new Map() }).reason, "multiple unanchored finals");
  assert.equal(chooseProvisionalOutcome({ actualAnchor: "2026-01-01", candidates: [{ ...base, completeScore: false }], conditionalQuality: new Map() }).reason, "incomplete final identity or score");
  assert.equal(chooseProvisionalOutcome({ actualAnchor: "2026-01-01", candidates: [base], conditionalQuality: new Map([["1:home_win", Array.from({ length: 32 }, () => ({ qualityStatus: "good", grossConditional: 1 }))]]) }).selected, true);
});

test("invariants and signed short owner economics are not absolute-valued", () => {
  assert.equal(calculateSignedOwnerValue(100, -0.25, 20, 5, 2).net, -48);
  const result = computeValuationInvariants({ expectedPot: 100, teams: [{ gross: 110, auctionPrice: 50 }, { gross: -5, auctionPrice: 50 }], secondaryTradePaid: 8, secondaryTradeReceived: 3 });
  assert.equal(result.teamGrossPoolConservation.residual, 5);
  assert.equal(result.ownerSecondaryTradeCash.observed, 5);
});

test("drift compares intersecting quote midpoints and exposes count", () => {
  const result = calculateMidpointDrift([{ ticker: "A", bid: 0.2, ask: 0.4 }], [{ ticker: "A", bid: 0.4, ask: 0.6 }, { ticker: "B", bid: 0, ask: 1 }]);
  assert.equal(result.comparedTickerCount, 1);
  assert.equal(result.weightedDrift, 0.2);
});