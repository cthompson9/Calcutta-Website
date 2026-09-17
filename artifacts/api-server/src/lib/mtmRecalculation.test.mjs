import assert from "node:assert/strict";
import test from "node:test";
import { requiresFullMtmRecalculation } from "./mtmRecalculation.ts";

test("does not simulate unchanged or replayed actuals", () => {
  assert.equal(requiresFullMtmRecalculation([
    { poolId: 67, status: "unchanged", markType: "official" },
    { poolId: 68, status: "promoted", markType: "provisional" },
  ]), false);
});

test("simulates pending, weak-evidence, and failed reconciliation results", () => {
  assert.equal(requiresFullMtmRecalculation([
    { poolId: 67, status: "promoted", markType: "pending_recalculation" },
  ]), true);
  assert.equal(requiresFullMtmRecalculation([
    { poolId: 67, status: "warning" },
  ]), true);
});

test("ignores an aggregate warning without a scoped pool", () => {
  assert.equal(requiresFullMtmRecalculation([
    { poolId: 0, status: "warning" },
  ]), false);
});