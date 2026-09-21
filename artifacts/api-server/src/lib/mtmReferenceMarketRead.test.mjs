import assert from "node:assert/strict";
import test from "node:test";
import {
  readMtmReferenceMarkets,
  ReferenceMarketReadError,
  sanitizeReferenceMarketUrl,
} from "./mtmReferenceMarketRead.ts";

const date = new Date("2026-01-01T00:00:00.000Z");

function repository({ currentSnapshotId = 10, poolId = 7, includeQuotes = true } = {}) {
  const snapshots = new Map([
    [10, { id: 10, poolId, status: "ok", asOf: date, methodVersion: "reference-mark-power-v1", diagnostics: { policy_version: "reference-mark-power-v1" }, stateJson: { entries: [{ entry_id: "101", team: "ARI" }] } }],
    [11, { id: 11, poolId, status: "ok", asOf: new Date("2026-01-02T00:00:00.000Z"), methodVersion: "reference-mark-power-v1", diagnostics: {}, stateJson: { entries: [{ entry_id: "101", team: "ARI" }] } }],
  ]);
  const versions = new Map([
    [10, { id: 100, poolId, sourceSnapshotId: 10, status: "current", markType: "official", actualsStateHash: "r10", createdAt: date }],
    [11, { id: 101, poolId, sourceSnapshotId: 11, status: "superseded", markType: "official", actualsStateHash: "r11", createdAt: date }],
  ]);
  const quotes = [
    { snapshotId: 10, marketTicker: "WIN-ARI-1", contract: "EV-ARI", source: "kalshi", provider: "kalshi", sourceUrl: "https://kalshi.example/events/EV-ARI?secret=no", series: "WIN_TOTALS", family: "wins", team: "ARI", strike: "8", yesBid: "0.30", yesAsk: "0.32", lastPrice: "0.31", referencePrice: "0.31", selectionMethod: "last_in_book", selectionReason: { reasons: [{ code: "selected_last_in_book" }] }, referenceAcceptedAt: date, referenceSourceSnapshotId: 10, referenceSourceTicker: "WIN-ARI-1", status: "active", outcome: null, capturedAt: date, fetchedAt: date },
    { snapshotId: 10, marketTicker: "STAGE-ARI", contract: "EV-ARI", source: "kalshi", provider: "kalshi", sourceUrl: "http://unsafe.example/raw", series: "STAGE", family: "elimination", team: "ARI", strike: null, yesBid: null, yesAsk: null, lastPrice: null, referencePrice: null, selectionMethod: "unavailable", selectionReason: { code: "no_prior" }, referenceAcceptedAt: date, referenceSourceSnapshotId: null, referenceSourceTicker: null, status: "suspended", outcome: "void", capturedAt: date, fetchedAt: date },
  ];
  return {
    async findSeasonId(year) { return year === 2026 ? 1 : null; },
    async findPoolId(seasonId, requested) { return seasonId === 1 && (requested == null || requested === poolId) ? poolId : null; },
    async findCurrent() { return [{ version: versions.get(currentSnapshotId), snapshot: snapshots.get(currentSnapshotId) }]; },
    async findOfficialSnapshot(_pool, id) {
      const version = versions.get(id);
      const snapshot = snapshots.get(id);
      return version && snapshot ? { version, snapshot } : null;
    },
    async listQuotes(id) { return includeQuotes ? quotes.filter((quote) => quote.snapshotId === id) : []; },
    async listProjections() { return [{ team: "ARI", pBerth: "0.5", pDivisional: "0.2", pConf: "0.1", pSbBerth: "0.05", pSbWin: "0.02" }]; },
    async listValuations() { return [{ entryId: 101, expectedPayout: "100.00" }]; },
  };
}

test("strict validation rejects malformed inputs before repository reads", async () => {
  let calls = 0;
  const repo = { ...repository(), findSeasonId: async () => { calls += 1; return 1; } };
  await assert.rejects(() => readMtmReferenceMarkets({ season: 2026, team: "not-a-team" }, repo), ReferenceMarketReadError);
  await assert.rejects(() => readMtmReferenceMarkets({ season: 2026, limit: 201 }, repo), ReferenceMarketReadError);
  assert.equal(calls, 0);
});

test("unknown season/pool and out-of-scope snapshot are 404", async () => {
  await assert.rejects(() => readMtmReferenceMarkets({ season: 2025 }, repository()), (error) => error.status === 404);
  await assert.rejects(() => readMtmReferenceMarkets({ season: 2026, calcuttaId: 999 }, repository()), (error) => error.status === 404);
  await assert.rejects(() => readMtmReferenceMarkets({ season: 2026, snapshotId: 999 }, repository()), (error) => error.status === 404);
});

test("valid unmatched team/filter returns an empty page and sanitizes URLs", async () => {
  const result = await readMtmReferenceMarkets({ season: 2026, team: "BAL", family: "wins" }, repository());
  assert.equal(result.available, true);
  assert.deepEqual(result.markets, []);
  const full = await readMtmReferenceMarkets({ season: 2026 }, repository());
  assert.equal(full.markets[0].sourceUrl, "https://kalshi.example/events/EV-ARI");
  assert.equal(full.markets[1].sourceUrl, null);
});

test("cursor binds filters and pins a promoted snapshot", async () => {
  const first = await readMtmReferenceMarkets({ season: 2026, limit: 1 }, repository());
  assert.ok(first.pagination.nextCursor);
  const second = await readMtmReferenceMarkets({ season: 2026, limit: 1, cursor: first.pagination.nextCursor }, repository({ currentSnapshotId: 11 }));
  assert.equal(second.snapshot.id, 10);
  await assert.rejects(
    () => readMtmReferenceMarkets({ season: 2026, family: "wins", cursor: first.pagination.nextCursor }, repository()),
    (error) => error.status === 400 && /cursor/i.test(error.message),
  );
});

test("REST/MCP callers can consume the same shared result without side effects", async () => {
  let writes = 0;
  let providerFetches = 0;
  let recalculations = 0;
  const repo = repository();
  const resultA = await readMtmReferenceMarkets({ season: 2026 }, repo);
  const resultB = await readMtmReferenceMarkets({ season: 2026 }, repo);
  assert.deepEqual(resultA, resultB);
  assert.equal(writes + providerFetches + recalculations, 0);
});

test("safe URL projection rejects credentials and non-HTTPS sources", () => {
  assert.equal(sanitizeReferenceMarketUrl("https://user:pass@example.com/path"), null);
  assert.equal(sanitizeReferenceMarketUrl("http://example.com/path"), null);
});