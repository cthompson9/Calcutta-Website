import assert from "node:assert/strict";
import test from "node:test";
import { referenceContractKey, resolveReferenceCandidates } from "./mtmReferencePersistence.ts";

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

test("applies bid plus one cent to wide playoff-qualifier books only", () => {
  const acceptedAt = new Date("2026-09-02T12:00:00.000Z");
  const [qualifier] = resolveReferenceCandidates(
    [{
      key: key({
        eventId: "KXNFLPLAYOFF-27",
        ticker: "KXNFLPLAYOFF-27-CAR",
        outcome: "playoff_qualifier",
      }),
      ticker: "KXNFLPLAYOFF-27-CAR",
      eventId: "KXNFLPLAYOFF-27",
      status: "active",
      yes_bid_dollars: "0.3500",
      yes_ask_dollars: "0.4000",
      last_price_dollars: "0.4200",
      fetched: true,
    }],
    [],
    acceptedAt,
    5,
  );
  const [stage] = resolveReferenceCandidates(
    [{
      key: key(),
      ticker: "STAGE-ARI-REG",
      status: "active",
      yes_bid_dollars: "0.3500",
      yes_ask_dollars: "0.4000",
      last_price_dollars: "0.4200",
      fetched: true,
    }],
    [],
    acceptedAt,
    5,
  );

  assert.equal(qualifier.referencePrice, 0.36);
  assert.equal(qualifier.selectionMethod, "bid_plus_cent");
  assert.equal(stage.referencePrice, null);
  assert.equal(stage.selectionMethod, "unavailable");
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

test("canonicalizes numeric strikes across database round-trips", () => {
  assert.equal(
    referenceContractKey(key({ ticker: "WIN-IND-4", outcome: null, strike: 4 })),
    referenceContractKey(key({ ticker: "WIN-IND-4", outcome: null, strike: "4.00" })),
  );
});

test("does not carry a prior mark across event identity boundaries", () => {
  const [row] = resolveReferenceCandidates(
    [{
      key: key({ eventId: "EVENT-NEW" }),
      ticker: "STAGE-ARI-REG",
      eventId: "EVENT-NEW",
      fetched: false,
      missingContract: true,
    }],
    [{
      key: key({ eventId: "EVENT-OLD" }),
      referencePrice: "0.31",
      referenceSourceSnapshotId: 4,
      referenceSourceTicker: "STAGE-ARI-REG",
      provider: "kalshi",
      contract: "STAGE-ARI-REG",
      marketTicker: "STAGE-ARI-REG",
      eventId: "EVENT-OLD",
    }],
    new Date("2026-09-02T12:00:00.000Z"),
    5,
  );
  assert.equal(row.referencePrice, null);
  assert.equal(row.referenceSourceSnapshotId, null);
});

test("preserves the original prior source identity and selection method", () => {
  const [row] = resolveReferenceCandidates(
    [{
      key: key(),
      ticker: "STAGE-ARI-REG",
      eventId: "evt-1",
      fetched: false,
      missingContract: true,
    }],
    [{
      key: key(),
      referencePrice: "1",
      selectionMethod: "settlement",
      referenceAcceptedAt: "2026-09-01T12:00:00.000Z",
      referenceSourceSnapshotId: 4,
      referenceSourceTicker: "STAGE-ARI-REG",
      provider: "kalshi",
      contract: "STAGE-ARI-REG",
      marketTicker: "STAGE-ARI-REG",
      eventId: "evt-1",
    }],
    new Date("2026-09-02T12:00:00.000Z"),
    5,
  );
  assert.equal(row.source.eventId, "evt-1");
  assert.equal(
    row.selectionReason.find(({ code }) => code === "carried_forward_prior_mark")?.sourceSelectionMethod,
    "settlement",
  );
});