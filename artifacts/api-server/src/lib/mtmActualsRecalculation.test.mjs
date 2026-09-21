import assert from "node:assert/strict";
import test from "node:test";
import {
  hashMtmActualsRevision,
  shouldQueueMtmRevision,
} from "./mtmActualsRecalculation.ts";

test("revision hash ignores fetch and provider metadata", () => {
  const base = { events: [{ eventId: 1, week: 1, homeScore: 7, awayScore: 3, status: "final" }] };
  assert.equal(
    hashMtmActualsRevision(base),
    hashMtmActualsRevision({ ...base, events: [{ ...base.events[0], fetchedAt: "later", provider: "espn-2" }] }),
  );
});

test("scores and corrections create a new revision", () => {
  const base = { events: [{ eventId: 1, week: 1, homeScore: 7, awayScore: 3, status: "final" }] };
  assert.notEqual(
    hashMtmActualsRevision(base),
    hashMtmActualsRevision({ events: [{ ...base.events[0], homeScore: 8 }] }),
  );
});

test("unchanged and replayed revisions coalesce", () => {
  assert.equal(shouldQueueMtmRevision({ requestedRevision: "a", completedRevision: "a" }, "a"), false);
  assert.equal(shouldQueueMtmRevision({ requestedRevision: "a", completedRevision: "a" }, "b"), true);
  assert.equal(shouldQueueMtmRevision(null, "a"), true);
});