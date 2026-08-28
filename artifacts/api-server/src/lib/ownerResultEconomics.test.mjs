import assert from "node:assert/strict";
import test from "node:test";
import { calculateOwnerResultEconomics } from "./ownerResultEconomics.ts";

test("owner result economics allocate trade-aware gross and net values", () => {
  const seller = calculateOwnerResultEconomics({
    effectiveShare: 0.5,
    originalCostBasis: 500,
    tradePaid: 0,
    tradeReceived: 400,
    realizedTeamGross: 600,
    mtmTeamGross: 600,
    dollarsPerPoint: 10,
  });
  const buyer = calculateOwnerResultEconomics({
    effectiveShare: 0.5,
    originalCostBasis: 0,
    tradePaid: 400,
    tradeReceived: 0,
    realizedTeamGross: 600,
    mtmTeamGross: 600,
    dollarsPerPoint: 10,
  });
  assert.deepEqual(seller, {
    cost: 100, realizedGross: 300, net: 200, mtmGross: 300, mtmNet: 200, ptsToBreakeven: 20,
  });
  assert.deepEqual(buyer, {
    cost: 400, realizedGross: 300, net: -100, mtmGross: 300, mtmNet: -100, ptsToBreakeven: -10,
  });
});