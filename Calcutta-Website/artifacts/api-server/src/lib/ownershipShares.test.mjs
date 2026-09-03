import assert from "node:assert/strict";
import test from "node:test";
import { validatePrimaryOwnership } from "./ownershipShares.ts";

test("primary ownership accepts a complete 50/50 split", () => {
  const result = validatePrimaryOwnership([
    { bidderId: 1, share: 0.5 },
    { bidderId: 2, share: 0.5 },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.owners, [
    { bidderId: 1, share: 0.5 },
    { bidderId: 2, share: 0.5 },
  ]);
});

test("primary ownership rejects duplicate bidders and incomplete totals", () => {
  const duplicate = validatePrimaryOwnership([
    { bidderId: 1, share: 0.5 },
    { bidderId: 1, share: 0.5 },
  ]);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /only once/i);

  const incomplete = validatePrimaryOwnership([
    { bidderId: 1, share: 0.6 },
    { bidderId: 2, share: 0.3 },
  ]);
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error, /add up to 1/i);
});

test("primary ownership rejects totals that only appeared valid before database rounding", () => {
  const result = validatePrimaryOwnership([
    { bidderId: 1, share: 0.33334 },
    { bidderId: 2, share: 0.33333 },
    { bidderId: 3, share: 0.33333 },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.error, /four decimal places/i);
});