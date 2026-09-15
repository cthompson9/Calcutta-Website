import assert from "node:assert/strict";
import test from "node:test";
import { buildMtmQualityExposure, isUpcomingMtmEvent } from "./mtmValuation.ts";

const resolution = {
  available: true,
  markType: "official",
  staleReason: null,
  actualsAsOf: "2026-09-12T16:00:00.000Z",
  mtmAsOf: "2026-09-12T16:00:00.000Z",
};

function snapshot(overrides = {}) {
  return {
    status: "ok",
    calibrationStatus: "good",
    methodVersion: "mtm-v2",
    marketAnchor: new Date("2026-09-12T15:00:00.000Z"),
    ...overrides,
  };
}

test("legacy marks with null diagnostics are estimated/degraded, not official", () => {
  const quality = buildMtmQualityExposure({
    diagnostics: null,
    snapshot: snapshot({ calibrationStatus: null }),
    resolution,
  });

  assert.equal(quality.status, "estimated-degraded");
  assert.match(quality.reasons.join(" "), /policy version/i);
  assert.match(quality.reasons.join(" "), /effective sample size/i);
  assert.match(quality.reasons.join(" "), /publication decision/i);
  assert.match(quality.reasons.join(" "), /calibration diagnostics/i);
});

test("marks with null calibration diagnostics remain degraded despite other legacy fields", () => {
  const quality = buildMtmQualityExposure({
    diagnostics: {
      policy_version: "mtm-evidence-v1",
      final_effective_sample_size: 512,
      publication_decision: "published",
    },
    snapshot: snapshot({ calibrationStatus: null }),
    resolution,
  });

  assert.equal(quality.status, "estimated-degraded");
  assert.match(quality.reasons.join(" "), /calibration diagnostics/i);
});

test("a successful mark with complete audit diagnostics is official", () => {
  const quality = buildMtmQualityExposure({
    diagnostics: {
      policy_version: "mtm-evidence-v1",
      final_effective_sample_size: 512,
      publication_decision: "published",
      market_calibration: { status: "good" },
      publication_audit: {
        status: "good",
        policy_version: "mtm-evidence-v1",
        final_effective_sample_size: 512,
        publication_decision: "published",
        calibration: { status: "good" },
        gate_results: {
          capture_completeness: "passed", freshness: "passed", metadata: "passed",
          final_ess: "passed", max_weight: "passed", precision: "not_applicable",
          support: "not_applicable",
        },
        gate_results: {
          capture_completeness: "passed",
          freshness: "passed",
          metadata: "passed",
          final_ess: "passed",
          max_weight: "passed",
          precision: "passed",
          support: "passed",
          win_market_quality: "passed",
          playoff_market_calibration: "passed",
        },
        gate_reasons: [],
      },
    },
    snapshot: snapshot(),
    resolution,
  });

  assert.equal(quality.status, "official");
  assert.deepEqual(quality.reasons, []);
  assert.equal(quality.policyVersion, "mtm-evidence-v1");
  assert.equal(quality.finalEffectiveSampleSize, 512);
  assert.equal(quality.publicationDecision, "published");
});

test("authoritative audit values win over legacy diagnostics", () => {
  const quality = buildMtmQualityExposure({
    diagnostics: {
      policy_version: "legacy-policy",
      final_effective_sample_size: 1,
      publication_decision: "not_published",
      market_calibration: { status: "warning" },
      publication_audit: {
        status: "good",
        policy_version: "audited-policy-v2",
        final_effective_sample_size: 2048,
        publication_decision: "published",
        calibration: { status: "good" },
        gate_results: {
          capture_completeness: "passed", freshness: "passed", metadata: "passed",
          final_ess: "passed", max_weight: "passed", precision: "not_applicable",
          support: "not_applicable",
        },
        gate_results: {
          capture_completeness: "passed",
          freshness: "passed",
          metadata: "passed",
          final_ess: "passed",
          max_weight: "passed",
          precision: "passed",
          support: "passed",
          win_market_quality: "passed",
          playoff_market_calibration: "passed",
        },
        gate_reasons: [],
      },
    },
    snapshot: snapshot(),
    resolution,
  });

  assert.equal(quality.status, "official");
  assert.equal(quality.policyVersion, "audited-policy-v2");
  assert.equal(quality.finalEffectiveSampleSize, 2048);
  assert.equal(quality.publicationDecision, "published");
});

test("a mark missing a payout-driving market gate remains degraded", () => {
  const quality = buildMtmQualityExposure({
    diagnostics: {
      publication_audit: {
        status: "good",
        policy_version: "mtm-evidence-v1",
        final_effective_sample_size: 512,
        publication_decision: "published",
        calibration: { status: "good" },
        gate_reasons: [],
        gate_results: {
          capture_completeness: "passed",
          freshness: "passed",
          metadata: "passed",
          final_ess: "passed",
          max_weight: "passed",
          precision: "not_applicable",
          support: "not_applicable",
          win_market_quality: "passed",
        },
      },
    },
    snapshot: snapshot(),
    resolution,
  });
  assert.equal(quality.status, "estimated-degraded");
  assert.match(quality.reasons.join(" "), /incomplete|playoff_market_calibration/i);
});

test("pre-audit publication quality is displayable but cannot certify official", () => {
  const quality = buildMtmQualityExposure({
    diagnostics: {
      publication_quality: {
        status: "good",
        policy_version: "legacy-audit-policy",
        final_effective_sample_size: 256,
        publication_decision: "approved",
      },
    },
    snapshot: snapshot(),
    resolution,
  });

  assert.equal(quality.status, "estimated-degraded");
  assert.equal(quality.policyVersion, "legacy-audit-policy");
  assert.equal(quality.finalEffectiveSampleSize, 256);
  assert.equal(quality.publicationDecision, "approved");
  assert.match(quality.reasons.join(" "), /authoritative publication audit/i);
});

test("upcoming EV swings advance past stale scheduled games after kickoff", () => {
  const now = new Date("2026-09-15T12:00:00.000Z");
  assert.equal(isUpcomingMtmEvent({
    status: "scheduled",
    kickoffAt: new Date("2026-09-14T23:00:00.000Z"),
  }, now), false);
  assert.equal(isUpcomingMtmEvent({
    status: "scheduled",
    kickoffAt: new Date("2026-09-17T23:00:00.000Z"),
  }, now), true);
  assert.equal(isUpcomingMtmEvent({
    status: "final",
    kickoffAt: new Date("2026-09-17T23:00:00.000Z"),
  }, now), false);
});