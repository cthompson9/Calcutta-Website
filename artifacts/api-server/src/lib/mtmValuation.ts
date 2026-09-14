import { and, eq, inArray, desc, gt } from "drizzle-orm";
import {
  db,
  eventsTable,
  mtmGameConditionalTable,
  mtmSnapshotTable,
  mtmEntryValuationTable,
  mtmMarketQuoteTable,
  mtmValuationVersionTable,
  calcuttaEntriesTable,
  teamsTable,
} from "@workspace/db";
import { loadSeasonOwnership } from "./seasonOwnership";
import { resolveCalcuttaId } from "./calcuttaContext";
import { resolveSeasonIdForSport } from "./calcuttaContext";
import {
  calculateMidpointDrift,
  computeValuationInvariants,
  deriveGameEvSwings,
  deriveOwnerGameEvSwings,
} from "./mtmValuationHelpers";
import {
  resolveCurrentMtm,
  sourceSnapshotHasCompletePublicationAudit,
} from "./currentMtm";

// The durable current-version resolver is shared by all displayed valuation
// consumers. Raw snapshots remain evidence-only read paths.
export {
  resolveCurrentMtm,
  buildCurrentMtmResolution,
  validateCurrentMtmVersion,
  assertValidCurrentMtmVersion,
  validateAndPromoteCurrentMtm,
  validateAndPromoteCurrentMtmVersion,
  mapSourceActualsForPool,
  mapSourceActuals,
  normalizeSourceActuals,
  reconcileNflCurrentMtm,
  planNflMtmReconciliation,
} from "./currentMtm";

export type MtmMarkType = "authoritative" | "latest" | "canonical" | "provisional";

export type MtmPublicationStatus =
  | "official"
  | "estimated-degraded"
  | "stale-pending"
  | "unavailable";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string =>
    typeof value === "string" && value.trim().length > 0) ?? null;
}

function isoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

/**
 * Turn the engine's intentionally open-ended diagnostics into a stable,
 * additive read model.  Keep the original diagnostics beside this summary:
 * older consumers can continue to inspect the persisted engine payload while
 * new consumers get names that do not depend on a Python implementation.
 */
export function buildMtmQualityExposure(args: {
  diagnostics: JsonObject | null;
  snapshot: Record<string, any> | null;
  resolution: {
    available: boolean;
    markType: string | null;
    staleReason: string | null;
    actualsAsOf: string | null;
    mtmAsOf: string | null;
  };
  priorOfficialAsOf?: string | null;
  priorVersion?: number | null;
  priorModelVersion?: string | null;
}) {
  const diagnostics = asObject(args.diagnostics);
  // publication_audit is the pipeline's final publication audit.  It is
  // deliberately kept separate from older engine diagnostics below:
  // legacy fields may explain a degraded mark, but cannot certify one.
  const authoritativePublicationAudit = asObject(
    diagnostics.publication_audit ?? diagnostics.publicationAudit,
  );
  const publicationAudit = asObject(
    diagnostics.publication_audit ??
    diagnostics.publicationAudit ??
    // Pre-audit candidates remain readable as degraded evidence.
    diagnostics.publication_quality ??
    diagnostics.publicationQuality,
  );
  const marketQuality = asObject(diagnostics.market_quality);
  const simulation = asObject(diagnostics.simulation);
  const calibration = asObject(diagnostics.market_calibration);
  const auditCalibration = asObject(
    authoritativePublicationAudit.calibration ??
    authoritativePublicationAudit.market_calibration ??
    authoritativePublicationAudit.marketCalibration,
  );
  const auditPolicyVersion = firstString(
    authoritativePublicationAudit.policy_version,
    authoritativePublicationAudit.policyVersion,
  );
  const legacyPolicyVersion = firstString(
    diagnostics.policy_version,
    diagnostics.policyVersion,
    calibration.policy_version,
    calibration.policyVersion,
    asObject(diagnostics.evidence_policy).version,
    asObject(diagnostics.evidencePolicy).version,
    ...((Array.isArray(marketQuality.rows) ? marketQuality.rows : [])
      .filter((row): row is JsonObject => Boolean(row && typeof row === "object"))
      .map((row) => row.policy_version ?? row.policyVersion)),
  );
  const displayPolicyVersion = firstString(
    publicationAudit.policy_version,
    publicationAudit.policyVersion,
  ) ?? legacyPolicyVersion;
  const auditPublicationRaw = firstString(
    authoritativePublicationAudit.publication_decision,
    authoritativePublicationAudit.publicationDecision,
    authoritativePublicationAudit.decision,
  );
  const legacyPublicationRaw = firstString(
    diagnostics.publication_decision,
    diagnostics.publicationDecision,
    marketQuality.publication_decision,
    marketQuality.publicationDecision,
  );
  const displayPublicationRaw = firstString(
    publicationAudit.publication_decision,
    publicationAudit.publicationDecision,
    publicationAudit.decision,
  ) ?? legacyPublicationRaw;
  const publicationRaw = auditPublicationRaw ?? displayPublicationRaw;
  const auditFinalEss = firstNumber(
    asObject(authoritativePublicationAudit.final_ess).value,
    asObject(authoritativePublicationAudit.finalEss).value,
    authoritativePublicationAudit.final_effective_sample_size,
    authoritativePublicationAudit.finalEffectiveSampleSize,
    asObject(authoritativePublicationAudit.global_ess).value,
    asObject(authoritativePublicationAudit.globalEss).value,
  );
  const legacyFinalEss = firstNumber(
    diagnostics.final_effective_sample_size,
    diagnostics.finalEffectiveSampleSize,
  );
  const displayFinalEss = firstNumber(
    asObject(publicationAudit.final_ess).value,
    asObject(publicationAudit.finalEss).value,
    publicationAudit.final_effective_sample_size,
    publicationAudit.finalEffectiveSampleSize,
    asObject(publicationAudit.global_ess).value,
    asObject(publicationAudit.globalEss).value,
    legacyFinalEss,
  );
  const finalEss = auditFinalEss ?? displayFinalEss;
  const maxWeight = firstNumber(
    asObject(publicationAudit.max_weight).value,
    asObject(publicationAudit.maxWeight).value,
    diagnostics.final_max_weight,
    diagnostics.max_weight,
    diagnostics.maxWeight,
    simulation.max_weight,
    simulation.maxWeight,
    asObject(diagnostics.monte_carlo_sampling).max_weight,
  );
  const precision = firstNumber(
    publicationAudit.final_precision,
    publicationAudit.finalPrecision,
    asObject(publicationAudit.precision).value,
    diagnostics.final_precision,
    diagnostics.precision,
    simulation.max_team_payout_mc_se,
    simulation.max_payout_mc_se,
  );
  const rows = Array.isArray(marketQuality.rows)
    ? marketQuality.rows.filter((row): row is JsonObject => Boolean(row && typeof row === "object"))
    : [];
  const derivedMaxWeight = rows.reduce((maximum, row) => Math.max(maximum, Number(row.weight ?? 0)), 0);
  const excludedEvidence = rows
    .filter((row) => String(row.quality_status ?? row.qualityStatus ?? "").toLowerCase() !== "good")
    .map((row) => ({
      id: String(row.team ?? row.id ?? "unknown"),
      reason: firstString(row.reason, row.quality_status, row.qualityStatus) ?? "Evidence did not meet the final quality threshold.",
    }));
  const declaredExcluded = Array.isArray(diagnostics.excluded_evidence)
    ? diagnostics.excluded_evidence
      .filter((item): item is JsonObject => Boolean(item && typeof item === "object"))
      .map((item) => ({
        id: String(item.id ?? item.team ?? "unknown"),
        reason: firstString(item.reason, item.exclusion_reason) ?? "Excluded by evidence policy.",
      }))
    : [];
  const dominantRow = rows
    .slice()
    .sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0))[0];
  const decision = args.snapshot?.status === "ok"
    ? (publicationRaw ?? "not_published")
    : (publicationRaw ?? "not_published");
  const reasons = [
    args.resolution.staleReason,
    typeof diagnostics.engineError === "string" ? diagnostics.engineError : null,
    ...((marketQuality.weak_teams as unknown[] | undefined) ?? []).map(String),
  ].filter((reason): reason is string => Boolean(reason));
  const calibrationStatus = String(
    calibration.status ?? args.snapshot?.calibrationStatus ?? "",
  ).trim().toLowerCase();
  const auditCalibrationStatus = String(
    auditCalibration.status ??
    authoritativePublicationAudit.calibration_status ??
    authoritativePublicationAudit.calibrationStatus ??
    "",
  ).trim().toLowerCase();
  const snapshotStatus = String(args.snapshot?.status ?? "").trim().toLowerCase();
  const calibrationAvailable = Object.keys(calibration).length > 0 ||
    firstString(args.snapshot?.calibrationStatus) != null;
  const publicationStatus = publicationRaw?.trim().toLowerCase() ?? "";
  const publicationVerified = ["approved", "official", "ok", "pass", "passed", "publish", "published"].includes(publicationStatus);
  const auditStatus = String(authoritativePublicationAudit.status ?? "").trim().toLowerCase();
  const auditStatusVerified = ["good", "ok", "passed", "official"].includes(auditStatus);
  const auditCalibrationVerified = ["good", "ok", "passed"].includes(auditCalibrationStatus);
  const auditGateResults = asObject(authoritativePublicationAudit.gate_results);
  const requiredAuditGates = [
    "capture_completeness",
    "freshness",
    "metadata",
    "final_ess",
    "max_weight",
    "precision",
    "support",
    "win_market_quality",
    "playoff_market_calibration",
  ];
  const failedAuditGates = requiredAuditGates.filter((gate) => {
    const result = String(auditGateResults[gate] ?? "").trim().toLowerCase();
    return result !== "passed" && !(["precision", "support"].includes(gate) && result === "not_applicable");
  });
  const auditGateReasons = Array.isArray(authoritativePublicationAudit.gate_reasons)
    ? authoritativePublicationAudit.gate_reasons.filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0)
    : [];
  const missingAuditSignals = [
    !sourceSnapshotHasCompletePublicationAudit({
      ...(args.snapshot ?? {}),
      diagnostics,
    })
      ? "Authoritative publication audit is incomplete; this mark cannot be verified as official." : null,
    Object.keys(authoritativePublicationAudit).length === 0
      ? "Authoritative publication audit is missing; this mark cannot be verified as official." : null,
    !auditStatusVerified
      ? "Authoritative publication audit did not pass; this mark cannot be verified as official." : null,
    Object.keys(auditGateResults).length === 0
      ? "Authoritative publication gate results are missing; this mark cannot be verified as official." : null,
    failedAuditGates.length > 0
      ? `Authoritative publication gates are not all passed: ${failedAuditGates.join(", ")}.` : null,
    auditGateReasons.length > 0
      ? `Authoritative publication audit has gate failures: ${auditGateReasons.join("; ")}.` : null,
    auditPolicyVersion == null
      ? "Authoritative evidence policy version is missing; this mark cannot be verified as official." : null,
    auditFinalEss == null || auditFinalEss <= 0
      ? "Authoritative final effective sample size is missing; this mark cannot be verified as official." : null,
    auditPublicationRaw == null
      ? "Authoritative publication decision is missing; this mark cannot be verified as official." : null,
    auditPublicationRaw != null && !publicationVerified
      ? `Publication decision "${publicationRaw}" does not verify an official mark.` : null,
    !auditCalibrationVerified
      ? "Authoritative calibration result is missing or not good; this mark cannot be verified as official." : null,
    Object.keys(authoritativePublicationAudit).length === 0 && !calibrationAvailable
      ? "Calibration diagnostics are missing; this legacy mark is estimated/degraded." : null,
    snapshotStatus !== "ok" ? "The source snapshot is not marked successful; this mark cannot be verified as official." : null,
  ].filter((reason): reason is string => Boolean(reason));
  const status: MtmPublicationStatus = !args.resolution.available
    ? "unavailable"
    : args.resolution.markType === "pending_recalculation"
      ? "stale-pending"
      : args.resolution.markType === "provisional" ||
          missingAuditSignals.length > 0 ||
          (Object.keys(authoritativePublicationAudit).length === 0 &&
            (calibrationStatus === "warning" ||
              calibrationStatus === "insufficient" ||
              calibrationStatus === "failed" ||
              calibrationStatus === "error" ||
              String(args.snapshot?.calibrationStatus ?? "").toLowerCase() === "warning" ||
              String(args.snapshot?.calibrationStatus ?? "").toLowerCase() === "insufficient"))
        ? "estimated-degraded"
        : "official";
  reasons.push(...missingAuditSignals);
  if (Object.keys(authoritativePublicationAudit).length === 0 &&
      (calibrationStatus === "warning" || calibrationStatus === "insufficient" ||
        calibrationStatus === "failed" || calibrationStatus === "error")) {
    reasons.push(`Calibration status is ${calibrationStatus}; the mark is estimated/degraded.`);
  }
  if (status === "estimated-degraded" && reasons.length === 0) {
    reasons.push("The mark is available, but one or more quality checks are degraded.");
  }
  if (status === "unavailable" && reasons.length === 0) {
    reasons.push("No coherent current MTM mark is available.");
  }
  return {
    status,
    reasons: [...new Set(reasons)],
    actualsCutoff: args.resolution.actualsAsOf,
    evidenceCutoff: isoTimestamp(args.snapshot?.marketAnchor),
    markTimestamp: args.resolution.markType === "pending_recalculation"
      ? (args.priorOfficialAsOf ?? args.resolution.mtmAsOf)
      : args.resolution.mtmAsOf,
    priorModelVersion: args.priorModelVersion ?? null,
    priorVersion: args.priorVersion ?? null,
    modelVersion: args.snapshot?.methodVersion ?? null,
    policyVersion: displayPolicyVersion,
    excludedEvidence: [...excludedEvidence, ...declaredExcluded],
    dominantEvidence: dominantRow
      ? {
          id: String(dominantRow.team ?? dominantRow.id ?? "unknown"),
          weight: firstNumber(dominantRow.weight),
        }
      : null,
    finalEffectiveSampleSize: finalEss,
    finalMaxWeight: maxWeight ?? (derivedMaxWeight > 0 ? derivedMaxWeight : null),
    precision,
    publicationDecision: decision,
    prefitDiagnostics: {
      label: "Prefit diagnostics (informational; not the publication decision)",
      marketCalibration: diagnostics.market_calibration ?? null,
      available: Object.keys(calibration).length > 0,
    },
  };
}

export async function assessMarketDrift(snapshotId: number, threshold = 0.05) {
  const selected = (await db.select({ snapshotId: mtmSnapshotTable.id, poolId: mtmSnapshotTable.poolId, inputHash: mtmSnapshotTable.inputHash, createdAt: mtmSnapshotTable.createdAt })
    .from(mtmSnapshotTable).where(eq(mtmSnapshotTable.id, snapshotId)).limit(1))[0];
  if (!selected) return { available: false, reason: "Snapshot not found.", threshold, comparedTickerCount: 0, maxDrift: null, weightedDrift: null, recommendsRerun: false };
  const laterSnapshots = await db.select({ id: mtmSnapshotTable.id, createdAt: mtmSnapshotTable.createdAt, inputHash: mtmSnapshotTable.inputHash })
    .from(mtmSnapshotTable).where(and(
      eq(mtmSnapshotTable.poolId, selected.poolId),
      eq(mtmSnapshotTable.status, "ok"),
      gt(mtmSnapshotTable.createdAt, selected.createdAt),
    ));
  const later = laterSnapshots.filter((row) => row.inputHash !== selected.inputHash).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!later) return { available: false, reason: "No later distinct successful quote capture is available.", threshold, comparedTickerCount: 0, maxDrift: null, weightedDrift: null, recommendsRerun: false };
  const [before, after] = await Promise.all([
    db.select().from(mtmMarketQuoteTable).where(eq(mtmMarketQuoteTable.snapshotId, snapshotId)),
    db.select().from(mtmMarketQuoteTable).where(eq(mtmMarketQuoteTable.snapshotId, later.id)),
  ]);
  const result = calculateMidpointDrift(before.map((q) => ({ ticker: q.marketTicker, bid: q.yesBid == null ? null : Number(q.yesBid), ask: q.yesAsk == null ? null : Number(q.yesAsk), volume: q.volume })), after.map((q) => ({ ticker: q.marketTicker, bid: q.yesBid == null ? null : Number(q.yesBid), ask: q.yesAsk == null ? null : Number(q.yesAsk), volume: q.volume })), threshold);
  return { ...result, laterSnapshotId: later.id, reason: result.available ? null : "No comparable quote intersection is available." };
}

/**
 * Normalized valuation read model. This is intentionally shared by HTTP and
 * MCP callers; it never starts a simulation or mutates a mark.
 */
export async function getNormalizedMtmValuation(args: {
  season: number;
  calcuttaId?: number;
  markType?: MtmMarkType;
  owner?: string;
}) {
  const seasonId = await resolveSeasonIdForSport(db, { year: args.season, sport: "NFL" });
  const poolId = seasonId == null
    ? null
    : await resolveCalcuttaId(db, { seasonId, sport: "NFL", calcuttaId: args.calcuttaId });
  const resolution = poolId == null
    ? {
        available: false,
        versionId: null,
        sourceSnapshotId: null,
        status: null,
        actualsStateHash: null,
        markType: null,
        provisionalEventId: null,
        provisionalOutcome: null,
        actualsAsOf: null,
        mtmAsOf: null,
        teams: [],
        owners: [],
        incorporatedGames: [],
        pendingGames: [],
        staleReason: "No NFL Calcutta is available for the requested season.",
      }
    : await resolveCurrentMtm(poolId);
  const priorOfficial = poolId != null
    ? (await db.select({
        id: mtmValuationVersionTable.id,
        mtmAsOf: mtmValuationVersionTable.mtmAsOf,
        sourceSnapshotId: mtmValuationVersionTable.sourceSnapshotId,
      }).from(mtmValuationVersionTable).where(and(
        eq(mtmValuationVersionTable.poolId, poolId),
        eq(mtmValuationVersionTable.markType, "official"),
        eq(mtmValuationVersionTable.status, "superseded"),
      )).orderBy(desc(mtmValuationVersionTable.mtmAsOf), desc(mtmValuationVersionTable.id)).limit(1))[0] ?? null
    : null;
  const priorSnapshot = priorOfficial
    ? (await db.select({ methodVersion: mtmSnapshotTable.methodVersion })
        .from(mtmSnapshotTable)
        .where(eq(mtmSnapshotTable.id, priorOfficial.sourceSnapshotId))
        .limit(1))[0] ?? null
    : null;
  const unavailableQuality = buildMtmQualityExposure({
    diagnostics: null,
    snapshot: null,
    resolution,
    priorOfficialAsOf: priorOfficial?.mtmAsOf.toISOString() ?? null,
    priorVersion: priorOfficial?.id ?? null,
    priorModelVersion: priorSnapshot?.methodVersion ?? null,
  });
  const unavailableMark = {
    versionId: resolution.versionId,
    sourceSnapshotId: resolution.sourceSnapshotId,
    status: resolution.status,
    type: resolution.markType ?? args.markType ?? "authoritative",
    approximate: resolution.markType === "provisional",
    quality: "insufficient" as const,
    stale: true,
    staleReasons: [resolution.staleReason ?? "No current coherent MTM version is available."],
    reason: resolution.staleReason ?? "No current coherent MTM version is available.",
    actualsStateHash: resolution.actualsStateHash,
    provisionalEventId: resolution.provisionalEventId,
    provisionalOutcome: resolution.provisionalOutcome,
    actualsAsOf: resolution.actualsAsOf,
    mtmAsOf: unavailableQuality.markTimestamp,
    evidenceCutoff: null,
    markTimestamp: unavailableQuality.markTimestamp,
    qualityStatus: unavailableQuality.status,
    qualityReasons: unavailableQuality.reasons,
    qualityExposure: unavailableQuality,
  };
  if (!resolution.available || resolution.sourceSnapshotId == null) {
    return {
      available: false,
      mark: unavailableMark,
      versionId: resolution.versionId,
      sourceSnapshotId: resolution.sourceSnapshotId,
      markType: resolution.markType,
      provisionalEventId: resolution.provisionalEventId,
      provisionalOutcome: resolution.provisionalOutcome,
      actualsAsOf: resolution.actualsAsOf,
      mtmAsOf: unavailableQuality.markTimestamp,
      evidenceCutoff: null,
      markTimestamp: unavailableQuality.markTimestamp,
      incorporatedGames: resolution.incorporatedGames,
      pendingGames: resolution.pendingGames,
      staleReason: resolution.staleReason,
      teams: [], owners: [], conditionalPayouts: {}, gameEvSwings: [],
      diagnostics: null,
      quality: unavailableQuality,
      invariants: {
        teamGrossPoolConservation: { status: "unavailable" },
        entryNetVersusAuctionProceeds: { status: "unavailable" },
        ownerSecondaryTradeCash: { status: "unavailable" },
      },
    };
  }
  const snapshot = (await db.select().from(mtmSnapshotTable)
    .where(eq(mtmSnapshotTable.id, resolution.sourceSnapshotId)).limit(1))[0];
  if (!snapshot) {
    const mark = { ...unavailableMark, reason: "Current MTM source snapshot is missing.",
      staleReasons: ["Current MTM source snapshot is missing."] };
    return {
      available: false, mark, teams: [], owners: [], conditionalPayouts: {}, gameEvSwings: [],
      versionId: resolution.versionId,
      sourceSnapshotId: resolution.sourceSnapshotId,
      markType: resolution.markType,
      provisionalEventId: resolution.provisionalEventId,
      provisionalOutcome: resolution.provisionalOutcome,
      actualsAsOf: resolution.actualsAsOf,
      mtmAsOf: unavailableQuality.markTimestamp,
      evidenceCutoff: null,
      markTimestamp: unavailableQuality.markTimestamp,
      incorporatedGames: resolution.incorporatedGames,
      pendingGames: resolution.pendingGames,
      staleReason: resolution.staleReason,
      diagnostics: null,
      quality: unavailableQuality,
      invariants: {
        teamGrossPoolConservation: { status: "unavailable" },
        entryNetVersusAuctionProceeds: { status: "unavailable" },
        ownerSecondaryTradeCash: { status: "unavailable" },
      },
    };
  }
  const quality = buildMtmQualityExposure({
    diagnostics: snapshot.diagnostics,
    snapshot,
    resolution,
    priorOfficialAsOf: priorOfficial?.mtmAsOf.toISOString() ?? null,
    priorVersion: priorOfficial?.id ?? null,
    priorModelVersion: priorSnapshot?.methodVersion ?? null,
  });
  // A pending replacement must not move the public mark clock forward.  The
  // pending version's actuals cutoff remains visible above, while the legacy
  // mark timestamp stays at the last official mark.
  const effectiveMtmAsOf = quality.markTimestamp;
  const selectedSnapshotId = snapshot.id;
  const currentStaleReason = resolution.staleReason ??
    (resolution.markType === "pending_recalculation"
      ? "Current MTM version is pending recalculation."
      : null);
  const entries = await db.select({
    entryId: calcuttaEntriesTable.id, teamId: calcuttaEntriesTable.teamId, teamName: teamsTable.name,
  }).from(calcuttaEntriesTable).innerJoin(teamsTable, eq(teamsTable.id, calcuttaEntriesTable.teamId))
    .where(eq(calcuttaEntriesTable.calcuttaId, poolId!));
  const ownership = await loadSeasonOwnership(seasonId!, poolId!);
  const entryById = new Map(entries.map((entry) => [entry.entryId, entry]));
  // The durable resolver is the sole authority for current team and owner
  // values. In particular, do not rebuild provisional values from live events.
  const teams = resolution.teams.map((team: Record<string, any>) => ({
    entryId: team.entryId,
    teamId: team.teamId,
    teamName: team.teamName,
    grossExpectedPayout: Number(team.currentMtm ?? team.grossExpectedPayout),
    auctionPrice: team.auctionPrice == null ? null : Number(team.auctionPrice),
    net: team.net == null ? null : Number(team.net),
  }));
  const owners = resolution.owners
    .filter((owner: Record<string, any>) => !args.owner || String(owner.bidderName).toLocaleLowerCase().includes(args.owner.toLocaleLowerCase()));
  const conditionals = await db.select().from(mtmGameConditionalTable)
    .where(eq(mtmGameConditionalTable.snapshotId, snapshot.id));
  const conditionalEventIds = [...new Set(conditionals.map((row) => row.eventId))];
  const conditionalEvents = conditionalEventIds.length
    ? await db.select({
        id: eventsTable.id,
        week: eventsTable.week,
        home: eventsTable.homeTeamId,
        away: eventsTable.awayTeamId,
        status: eventsTable.status,
        homeScore: eventsTable.homeScore,
        awayScore: eventsTable.awayScore,
        updatedAt: eventsTable.updatedAt,
      })
      .from(eventsTable).where(inArray(eventsTable.id, conditionalEventIds))
    : [];
  const eventById = new Map(conditionalEvents.map((event) => [event.id, event]));
  const conditionalPayouts: Record<string, any> = {};
  for (const row of conditionals) {
    const event = eventById.get(row.eventId);
    const key = String(row.eventId);
    const item = conditionalPayouts[key] ?? { event_id: row.eventId, home: event?.home ?? null, away: event?.away ?? null, week: event?.week ?? null, outcomes: {} };
    const outcome = item.outcomes[row.outcome] ?? { teams: [], owners: [] };
    outcome.teams.push({
      entry_id: row.entryId,
      team_id: entryById.get(row.entryId)?.teamId ?? null,
      gross_baseline: row.grossBaseline == null ? null : Number(row.grossBaseline),
      gross_expected_payout: row.grossConditional == null ? null : Number(row.grossConditional),
      gross_delta: row.grossDelta == null ? null : Number(row.grossDelta),
      probability: row.probability == null ? null : Number(row.probability),
      sample_count: row.sampleCount,
      sample_share: row.sampleShare == null ? null : Number(row.sampleShare),
      effective_sample_size: row.effectiveSampleSize == null ? null : Number(row.effectiveSampleSize),
      standard_error: row.standardError == null ? null : Number(row.standardError),
      quality_status: row.qualityStatus,
      reconciliation_residual: row.reconciliationResidual == null ? null : Number(row.reconciliationResidual),
    });
    item.outcomes[row.outcome] = outcome;
    conditionalPayouts[key] = item;
  }
  for (const event of Object.values(conditionalPayouts)) {
    for (const outcome of Object.values(event.outcomes) as any[]) {
      const grossByTeam = new Map(outcome.teams.map((team: any) => [team.team_id, team.gross_expected_payout]));
      outcome.owners = [...ownership.byBidder.entries()].map(([bidderId, positions]) => ({
        bidderId,
        bidderName: ownership.bidderNames.get(bidderId) ?? "Unknown",
        grossExpectedPayout: [...positions.entries()].reduce((sum, [teamId, position]) =>
          sum + Number(grossByTeam.get(teamId) ?? 0) * position.effectiveShare, 0),
      }));
    }
  }
  const gameEvSwings = deriveOwnerGameEvSwings(
    deriveGameEvSwings(
      Object.values(conditionalPayouts),
      new Map(entries.map((entry) => [entry.teamId, entry.teamName])),
    ),
    [...ownership.byBidder.entries()].map(([bidderId, positions]) => ({
      bidderId,
      bidderName: ownership.bidderNames.get(bidderId) ?? "Unknown",
      positions,
    })),
  );
  const expectedPot = Number((snapshot.stateJson as Record<string, unknown> | null)?.pot ?? 0);
  const secondaryTradePaid = [...ownership.byBidder.values()].reduce((sum, positions) =>
    sum + [...positions.values()].reduce((inner, position) => inner + position.tradePaid, 0), 0);
  const secondaryTradeReceived = [...ownership.byBidder.values()].reduce((sum, positions) =>
    sum + [...positions.values()].reduce((inner, position) => inner + position.tradeReceived, 0), 0);
  const invariants = computeValuationInvariants({
    expectedPot,
    teams: teams.map((team: { grossExpectedPayout: number; auctionPrice: number | null }) => ({ gross: team.grossExpectedPayout, auctionPrice: team.auctionPrice ?? 0 })),
    secondaryTradePaid,
    secondaryTradeReceived,
  });
  return {
    available: true,
    mark: {
       snapshotId: snapshot.id,
       versionId: resolution.versionId,
       sourceSnapshotId: resolution.sourceSnapshotId,
       status: resolution.status,
       type: resolution.markType ?? "official",
       approximate: resolution.markType === "provisional",
      quality: snapshot.calibrationStatus ?? "insufficient",
       stale: resolution.markType === "pending_recalculation" || Boolean(currentStaleReason),
       staleReasons: currentStaleReason ? [currentStaleReason] : [],
        asOf: effectiveMtmAsOf,
       actualsAsOf: resolution.actualsAsOf,
        mtmAsOf: effectiveMtmAsOf,
       evidenceCutoff: isoTimestamp(snapshot.marketAnchor),
       markTimestamp: effectiveMtmAsOf,
       actualsStateHash: resolution.actualsStateHash,
       provisionalEventId: resolution.provisionalEventId,
       provisionalOutcome: resolution.provisionalOutcome,
      inputHash: snapshot.inputHash,
      model: { name: snapshot.methodVersion, seed: snapshot.randomSeed },
      pathCount: snapshot.pathCount,
       selectionReason: "promoted coherent current MTM version",
       provisionalSuppressionReason: null,
       qualityStatus: quality.status,
       qualityReasons: quality.reasons,
       qualityExposure: quality,
    },
     versionId: resolution.versionId,
     sourceSnapshotId: resolution.sourceSnapshotId,
     markType: resolution.markType,
     provisionalEventId: resolution.provisionalEventId,
     provisionalOutcome: resolution.provisionalOutcome,
     actualsAsOf: resolution.actualsAsOf,
      mtmAsOf: effectiveMtmAsOf,
     evidenceCutoff: isoTimestamp(snapshot.marketAnchor),
     markTimestamp: effectiveMtmAsOf,
     incorporatedGames: resolution.incorporatedGames,
     pendingGames: resolution.pendingGames,
      staleReason: currentStaleReason,
     quality,
    teams, owners, conditionalPayouts, gameEvSwings,
    diagnostics: {
      market_calibration: snapshot.diagnostics?.market_calibration ?? { status: snapshot.calibrationStatus ?? "insufficient" },
       market_drift: await assessMarketDrift(snapshot.id),
       quality,
       raw: snapshot.diagnostics,
    },
    invariants,
  };
}