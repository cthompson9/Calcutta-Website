import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarchMadnessBracket, buildMlbSeries, buildNbaSeries, buildNflBracket,
  nflReseedPairings, superiorSeedDesignation, validateSlotCoupling,
} from "./calcuttaCalendar";

test("all supported bracket formats have explicit builders", () => {
  assert.equal(buildNflBracket().topSeedByes, 2);
  assert.equal(buildNbaSeries().bestOf, 7);
  assert.deepEqual(buildMlbSeries([3, 5, 7]).roundBestOf, [3, 5, 7]);
  assert.equal(buildMarchMadnessBracket().teams, 64);
  assert.throws(() => buildMarchMadnessBracket(68));
});

test("neutral site is separate from superior-seed designation", () => {
  assert.equal(superiorSeedDesignation({ seed: 1 }, { seed: 8 }, true), "home");
  assert.equal(superiorSeedDesignation({ seed: 1 }, { seed: 1 }), null);
  assert.equal(superiorSeedDesignation({}, { seed: 8 }), null);
});

test("NFL divisional reseeding pairs strongest and weakest", () => {
  assert.deepEqual(nflReseedPairings([6, 1, 4, 2]), [[1, 6], [2, 4]]);
});

test("cross-competition coupling is rejected", () => {
  assert.throws(() => validateSlotCoupling(1, 2));
  assert.doesNotThrow(() => validateSlotCoupling(3, 3));
});