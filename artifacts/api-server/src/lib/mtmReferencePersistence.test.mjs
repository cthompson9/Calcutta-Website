import assert from "node:assert/strict";
import test from "node:test";
import { resolveReferenceCandidates } from "./mtmReferencePersistence.ts";

const key = (overrides = {}) => ({
  poolId: 7, seasonId: 2026, provider: "kalshi", eventId: "evt-1",
  ticker: "STAGE-ARI-REG", outcome: "no_playoffs", strike: null, ...overrides,
});

test("carries a missing quote from one prior accepted source", () => {
  const [row] = resolveReferenceCandidates(
    [{ key: key(), ticker: "STAGE-ARI-REG", fetched: false, missingContract: true }],
    [{
      key: key(), referencePrice: "0.31", selectionMethod: "last_in_book",
      referenceAcceptedAt: "2026-09-01T12:00:00.000Z", referenceSourceSnapshotId: 4,
      referenceSourceTicker: "STAGE-ARI-REG", provider: "kalshi", contract: "STAGE-ARI-REG",
      marketTicker: "STAGE-ARI-REG", eventId: "evt-1",
    }],
    new Date("2026-09-02T12:00:00.000Z"), 5,
  );
  assert.equal(row.referencePrice, 0.31);
  assert.equal(row.selectionMethod, "carried_forward");
  assert.equal(row.referenceSourceSnapshotId, 4);
  assert.equal(row.referenceAcceptedAt, "2026-09-01T12:00:00.000Z");
  assert.equal(row.fetchOutcome, "missing");
});

test("makes no-prior unavailable instead of fabricating a mark", () => {
  const [row] = resolveReferenceCandidates(
    [{ key: key(), fetched: false, providerFailure: true }],
    [],
    new Date("2026-09-02T12:00:00.000Z"), 5,
  );
  assert.equal(row.referencePrice, null);
  assert.equal(row.selectionMethod, "unavailable");
  assert.equal(row.referenceSourceSnapshotId, null);
  assert.equal(row.fetchOutcome, "failed");
});

test("preserves original provenance across repeated carry-forward", () => {
  const [row] = resolveReferenceCandidates(
    [{ key: key(), fetched: false, missingContract: true }],
    [{
      key: key(), referencePrice: 0.42, selectionMethod: "carried_forward",
      referenceAcceptedAt: "2026-09-01T12:00:00.000Z", referenceSourceSnapshotId: 3,
      referenceSourceTicker: "STAGE-ARI-REG", provider: "kalshi", contract: "STAGE-ARI-REG",
      marketTicker: "STAGE-ARI-REG", eventId: "evt-1",
      fetchedAt: "2026-09-01T12:00:00.000Z",
    }],
    new Date("2026-09-03T12:00:00.000Z"), 6,
  );
  assert.equal(row.referenceSourceSnapshotId, 3);
  assert.equal(row.referenceAcceptedAt, "2026-09-01T12:00:00.000Z");
});

test("does not cross pool or ticker boundaries during fallback", () => {
  const [row] = resolveReferenceCandidates(
    [{ key: key({ poolId: 8 }), fetched: false, missingContract: true }],
    [{
      key: key(), referencePrice: 0.5, referenceSourceSnapshotId: 2,
      referenceSourceTicker: "STAGE-ARI-REG", provider: "kalshi", contract: "STAGE-ARI-REG",
      marketTicker: "STAGE-ARI-REG", eventId: "evt-1",
    }],
    new Date("2026-09-03T12:00:00.000Z"), 6,
  );
  assert.equal(row.referencePrice, null);
});