import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mtmPipelineTestUtils } from "./mtmPipeline.ts";
import {
  acceptedYesBounds,
  aggregateMtmEvidence,
  assessMtmEvidence,
  estimateMtmTrades,
} from "./mtmEvidence.ts";

const fixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__/reproducibility",
);
const fixturePath = resolve(fixtureDirectory, "legacy-normalization-incident.json");
const manifestPath = resolve(fixtureDirectory, "manifest.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

test("committed incident fixture is synthetic and discloses unavailable source bytes", () => {
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.source.kind, "synthetic");
  assert.equal(fixture.source.historicalSha256, null);
  assert.equal(fixture.source.sourceBytes, null);
  assert.equal(manifest.fixturePolicy, "synthetic-only");
  assert.equal(manifest.historicalSha256, null);
  assert.equal(manifest.sourceBytes, null);
  assert.equal(manifest.fixtures.length, 1);
});

test("manifest records the exact fixture bytes and SHA-256", async () => {
  const bytes = await readFile(fixturePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const entry = manifest.fixtures.find(
    (candidate) => candidate.path === "legacy-normalization-incident.json",
  );
  assert.ok(entry);
  assert.equal(entry.bytes, bytes.length);
  assert.equal(entry.sha256, hash);
  assert.notEqual(entry.sha256, "TO_BE_COMPUTED");
});

function quoteConfig() {
  return fixture.config;
}

test("legacy 1/97 PHI rung is retained as weak diagnostics, not a midpoint", () => {
  const derived = mtmPipelineTestUtils.deriveQuoteState(
    quoteConfig(),
    fixture.teams,
    fixture.rawQuotes,
    undefined,
    false,
  );
  assert.deepEqual(derived.winLadders.PHI[0], {
    strike: 1,
    yes_bid: null,
    yes_ask: null,
    volume: 11,
    status: "active",
    result: null,
    weak: true,
    interpolated: true,
  });
  assert.deepEqual(derived.winLadders.HOU[0], {
    strike: 1,
    yes_bid: 0.5,
    yes_ask: 0.52,
    volume: 11,
    status: "active",
    result: null,
  });
});

test("HOU spillover sensitivity remains a diagnostic and has no target assertion", () => {
  const sensitivity = fixture.houSpilloverSensitivity;
  assert.equal(sensitivity.diagnosticOnly, true);
  assert.equal(sensitivity.targetAssertion, null);
  assert.equal(
    Number((sensitivity.oneRungSpilloverVariant - sensitivity.baseline).toFixed(2)),
    sensitivity.expectedDelta,
  );
});

test("quote semantics preserve zero bids and distinguish one-sided bounds", () => {
  assert.deepEqual(
    acceptedYesBounds({ id: "zero-bid", status: "active", yesBid: 0 }),
    { lower: 0, upper: 1, oneSided: true, side: "bid-only" },
  );
  assert.deepEqual(
    acceptedYesBounds({ id: "ask-only", status: "active", yesAsk: 0.61 }),
    { lower: 0, upper: 0.61, oneSided: true, side: "ask-only" },
  );
  const settled = assessMtmEvidence({
    id: "settled-zero",
    status: "settled",
    settlement: "no",
    yesBid: 0,
  }, "2026-09-20T14:00:00.000Z");
  assert.equal(settled.factors.activeZeroBid, false);
  assert.equal(settled.classification, "excluded");
});

test("duplicate trade IDs select the newest deterministic observation", () => {
  const estimate = estimateMtmTrades({
    id: "synthetic-trades",
    yesBid: 0.2,
    yesAsk: 0.8,
    trades: fixture.trades,
  });
  assert.equal(estimate.duplicateTradeIdsRemoved, 1);
  assert.equal(estimate.acceptedTradeCount, 2);
  assert.equal(estimate.estimate, 0.43);
});

test("duplicate refresh IDs remain visible in deterministic diagnostics", () => {
  const refreshIds = fixture.refreshes.map((refresh) => refresh.id);
  assert.equal(new Set(refreshIds).size, 1);
  const aggregate = aggregateMtmEvidence(
    fixture.refreshes.map((refresh, index) => ({
      id: refresh.id,
      status: "active",
      yesBid: 0.4 + index / 100,
      yesAsk: 0.5 + index / 100,
      observedAt: "2026-09-20T14:00:00.000Z",
    })),
    "2026-09-20T14:00:00.000Z",
  );
  assert.deepEqual(
    aggregate.assessments.map((assessment) => assessment.id),
    ["synthetic-refresh-1", "synthetic-refresh-1"],
  );
});