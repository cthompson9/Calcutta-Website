import assert from "node:assert/strict";
import test from "node:test";
import { calculateReturnFromSnapshots } from "./calcuttaReturns.ts";

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