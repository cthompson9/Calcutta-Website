import assert from "node:assert/strict";
import test from "node:test";
import {
  flattenEngineConditionals,
  chooseProvisionalOutcome,
  computeValuationInvariants,
  calculateSignedOwnerValue,
  calculateMidpointDrift,
  deriveGameEvSwings,
  deriveOwnerGameEvSwings,
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

test("derives home and away EV swings and gates weak pairs", () => {
  const team = (teamId, baseline, gross, qualityStatus = "good", ess = 200) => ({
    team_id: teamId,
    gross_baseline: baseline,
    gross_expected_payout: gross,
    sample_count: 300,
    sample_share: 0.45,
    effective_sample_size: ess,
    standard_error: 2,
    quality_status: qualityStatus,
  });
  const [game] = deriveGameEvSwings([{
    event_id: 9,
    home: 1,
    away: 2,
    week: 4,
    outcomes: {
      home_win: { teams: [team(1, 100, 130), team(2, 80, 65)] },
      away_win: { teams: [team(1, 100, 70), team(2, 80, 105)] },
      tie: { teams: [team(1, 100, 99), team(2, 80, 81)] },
    },
  }], new Map([[1, "Home"], [2, "Away"]]));
  assert.equal(game.teams[0].benefitOfWin, 30);
  assert.equal(game.teams[0].costOfLoss, 30);
  assert.equal(game.teams[0].totalEvSwing, 60);
  assert.equal(game.teams[1].benefitOfWin, 25);
  assert.equal(game.teams[1].costOfLoss, 15);
  assert.equal(game.teams[1].totalEvSwing, 40);

  const [weakGame] = deriveGameEvSwings([{
    event_id: 10,
    home: 1,
    away: 2,
    week: 5,
    outcomes: {
      home_win: { teams: [team(1, 100, 130)] },
      away_win: { teams: [team(1, 100, 70, "warning", 20)] },
    },
  }], new Map([[1, "Home"], [2, "Away"]]));
  assert.equal(weakGame.teams[0].available, false);
  assert.equal(weakGame.teams[0].qualityStatus, "warning");
  assert.equal(weakGame.teams[0].totalEvSwing, null);
  assert.equal(weakGame.teams[0].effectiveSampleSize, 20);
  assert.equal(weakGame.teams[1].qualityStatus, "insufficient");
});

test("applies signed owner shares to game swings and preserves unavailable quality", () => {
  const games = [{
    eventId: 9,
    week: 4,
    homeTeamId: 1,
    awayTeamId: 2,
    teams: [
      {
        teamId: 1, teamName: "Home", available: true, qualityStatus: "good",
        baselineGrossExpectedPayout: 100, winGrossExpectedPayout: 130,
        lossGrossExpectedPayout: 70, benefitOfWin: 30, costOfLoss: 30,
        totalEvSwing: 60, sampleCount: 300, sampleShare: 0.45,
        effectiveSampleSize: 200, standardError: 2,
      },
      {
        teamId: 2, teamName: "Away", available: false, qualityStatus: "insufficient",
        baselineGrossExpectedPayout: null, winGrossExpectedPayout: null,
        lossGrossExpectedPayout: null, benefitOfWin: null, costOfLoss: null,
        totalEvSwing: null, sampleCount: 10, sampleShare: 0.1,
        effectiveSampleSize: 8, standardError: 8,
      },
    ],
  }];
  const [game] = deriveOwnerGameEvSwings(games, [{
    bidderId: 7,
    bidderName: "Split & Short",
    positions: new Map([[1, { effectiveShare: 0.25 }], [2, { effectiveShare: -0.5 }]]),
  }]);
  assert.equal(game.owners[0].holdings[0].benefitOfWin, 7.5);
  assert.equal(game.owners[0].holdings[0].totalEvSwing, 15);
  assert.equal(game.owners[0].holdings[1].signedShare, -0.5);
  assert.equal(game.owners[0].holdings[1].available, false);
  assert.equal(game.owners[0].holdings[1].totalEvSwing, null);
});