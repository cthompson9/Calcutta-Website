import assert from "node:assert/strict";
import test from "node:test";
import { selectReferenceMark } from "./mtmReferenceMarks.ts";

const base = { provider: "kalshi", contractId: "event-1", ticker: "TICKER-1", status: "active" };

test("normalizes dollar fields before legacy cents and preserves zero/sub-cent values", () => {
  const result = selectReferenceMark({
    ...base,
    yes_bid_dollars: "0.001",
    yes_ask_dollars: "0.011",
    last_price_dollars: "0.006",
    yes_bid: 99,
    yes_ask: 99,
  });
  assert.equal(result.referencePrice, 0.006);
  assert.equal(result.selectionMethod, "last_in_book");
  assert.deepEqual(result.normalized, { bid: 0.001, ask: 0.011, last: 0.006 });
  assert.equal(selectReferenceMark({ ...base, yes_bid_dollars: "0", yes_ask_dollars: "0.02" }).referencePrice, 0.01);
});

test("uses settlement facts before active quote selection", () => {
  const yes = selectReferenceMark({ ...base, status: "finalized", result: "yes", yes_bid: 0.1 });
  const no = selectReferenceMark({ ...base, status: "settled", result: "no", yes_bid: 0.9 });
  assert.equal(yes.referencePrice, 1);
  assert.equal(yes.selectionMethod, "settlement");
  assert.equal(no.referencePrice, 0);
  assert.equal(no.selectionMethod, "settlement");
});

test("selects Last, then bid-only, then tight-book bid plus cent", () => {
  const last = selectReferenceMark({ ...base, yes_bid: 0.4, yes_ask: 0.5, last_price: 0.47 });
  assert.equal(last.referencePrice, 0.47);
  assert.equal(last.selectionMethod, "last_in_book");
  const bid = selectReferenceMark({ ...base, yes_bid: 0.4 });
  assert.equal(bid.referencePrice, 0.4);
  assert.equal(bid.selectionMethod, "bid_without_ask");
  const abs = selectReferenceMark({ ...base, yes_bid: 0.4, yes_ask: 0.42 });
  assert.equal(abs.referencePrice, 0.41);
  assert.equal(abs.selectionMethod, "bid_plus_cent");
  const relative = selectReferenceMark({ ...base, yes_bid: 0.4, yes_ask: 0.4421052631578947 });
  assert.equal(relative.selectionMethod, "bid_plus_cent");
  assert.equal(relative.referencePrice, 0.41);
});

test("uses inclusive tight-book boundaries and caps at ask and one", () => {
  assert.equal(selectReferenceMark({ ...base, yes_bid: 0.4, yes_ask: 0.42 }).selectionMethod, "bid_plus_cent");
  assert.equal(selectReferenceMark({ ...base, yes_bid: 0.4, yes_ask: 0.4421052631578947 }).selectionMethod, "bid_plus_cent");
  assert.equal(selectReferenceMark({ ...base, yes_bid: 0.995, yes_ask: 1 }).referencePrice, 1);
});

test("invalid fields and crossed books cannot be repaired into an eligible book", () => {
  const malformedAsk = selectReferenceMark({ ...base, yes_bid: 0.4, yes_ask: "not-a-number" });
  assert.equal(malformedAsk.selectionMethod, "unavailable");
  assert.ok(malformedAsk.reasons.some(({ code }) => code === "malformed_quote"));
  const crossed = selectReferenceMark({ ...base, yes_bid: 0.7, yes_ask: 0.4 });
  assert.equal(crossed.selectionMethod, "unavailable");
  assert.ok(crossed.reasons.some(({ code }) => code === "crossed_book"));
  const nonfinite = selectReferenceMark({ ...base, yes_bid: Infinity, yes_ask: 0.5 });
  assert.ok(nonfinite.reasons.some(({ code }) => code === "nonfinite_quote"));
});

test("carries the exact prior raw mark and original provenance", () => {
  const prior = {
    referencePrice: 0.37,
    source: { provider: "kalshi", contractId: "event-1", ticker: "TICKER-1" },
    timestamps: { fetchedAt: "2026-01-01T00:00:00Z", observedAt: "2025-12-31T23:59:00Z" },
  };
  const result = selectReferenceMark({ ...base, yes_bid: 0.1, yes_ask: 0.9 }, prior);
  assert.equal(result.referencePrice, 0.37);
  assert.equal(result.selectionMethod, "carried_forward");
  assert.equal(result.source.ticker, "TICKER-1");
  assert.equal(result.timestamps.fetchedAt, "2026-01-01T00:00:00Z");
});

test("does not carry a mismatched prior, and distinguishes no-prior failure reasons", () => {
  const mismatch = selectReferenceMark(
    { ...base, yes_bid: 0.1, yes_ask: 0.9 },
    { referencePrice: 0.37, source: { provider: "kalshi", contractId: "other", ticker: "OTHER" } },
  );
  assert.equal(mismatch.selectionMethod, "unavailable");
  assert.ok(mismatch.reasons.some(({ code }) => code === "prior_contract_mismatch"));
  assert.ok(mismatch.reasons.some(({ code }) => code === "no_prior_mark"));
  const missing = selectReferenceMark({ ...base, missingContract: true });
  assert.ok(missing.reasons.some(({ code }) => code === "missing_contract"));
  const failed = selectReferenceMark({ ...base, providerFailure: "timeout" });
  assert.ok(failed.reasons.some(({ code }) => code === "provider_failure"));
});

test("void, cancelled, and suspended states are explicit", () => {
  const voided = selectReferenceMark({ ...base, status: "void" }, {
    referencePrice: 0.5,
    source: { provider: "kalshi", contractId: "event-1", ticker: "TICKER-1" },
  });
  assert.equal(voided.selectionMethod, "unavailable");
  assert.ok(voided.reasons.some(({ code }) => code === "void_or_cancelled_contract"));
  const suspended = selectReferenceMark({ ...base, status: "suspended" });
  assert.equal(suspended.selectionMethod, "unavailable");
  assert.ok(suspended.reasons.some(({ code }) => code === "suspended_market"));
});