/**
 * Deterministic evidence quality primitives for MTM marks.
 *
 * This module intentionally has no pipeline or persistence dependencies.  It
 * accepts an already captured market observation and returns an auditable
 * description of what was used, what was discounted, and why.
 */

export const MTM_EVIDENCE_POLICY_VERSION = "mtm-evidence-v1";
export const EVIDENCE_POLICY_VERSION = MTM_EVIDENCE_POLICY_VERSION;

export type EvidenceStatus = "active" | "settled" | "suspended" | "unknown";
export type EvidenceClassification =
  | "strong"
  | "usable"
  | "degraded"
  | "excluded";
export type EvidenceQualityStatus = "good" | "warning" | "insufficient";

export type EvidenceDepth = {
  bid?: number | null;
  ask?: number | null;
  bidSize?: number | null;
  askSize?: number | null;
};

export type EvidenceTrade = {
  id: string;
  price: number;
  size?: number | null;
  timestamp?: string | null;
};

export type EvidenceProviderMetadata = {
  provider: string;
  sourceId?: string | null;
  sourceUrl?: string | null;
  trust?: number | null;
  [key: string]: unknown;
};

export type MtmEvidenceGroup = {
  id: string;
  /** A group is a correlated source set (for example, one provider feed). */
  cap?: number | null;
  influence?: number | null;
  label?: string | null;
};

export type MtmEvidenceInput = {
  id: string;
  yesBid?: number | null;
  yesAsk?: number | null;
  status?: EvidenceStatus;
  settlement?: "yes" | "no" | "void" | null;
  depth?: EvidenceDepth | null;
  observedAt?: string | null;
  fetchedAt?: string | null;
  timestamp?: string | null;
  trades?: EvidenceTrade[] | null;
  materialEvent?: {
    occurred?: boolean;
    occurredAt?: string | null;
    description?: string | null;
  } | null;
  provider?: EvidenceProviderMetadata | null;
  evidenceGroup?: MtmEvidenceGroup | string | null;
  metadata?: Record<string, unknown> | null;
};

export type NormalizedMtmEvidence = Omit<MtmEvidenceInput, "evidenceGroup"> & {
  yesBid: number | null;
  yesAsk: number | null;
  status: EvidenceStatus;
  settlement: "yes" | "no" | "void" | null;
  evidenceGroup: MtmEvidenceGroup | null;
};

export type MtmEvidencePolicy = {
  version: string;
  maxAgeMs: number;
  staleAfterMs: number;
  maxSpread: number;
  maxRelativeSpread: number;
  minDepth: number;
  maxTradeWeight: number;
  maxGroupInfluence: number;
  minGoodScore: number;
  minWarningScore: number;
  uncertaintyFloor: number;
  uncertaintyCeiling: number;
};

export const DEFAULT_MTM_EVIDENCE_POLICY: Readonly<MtmEvidencePolicy> = {
  version: MTM_EVIDENCE_POLICY_VERSION,
  maxAgeMs: 15 * 60_000,
  staleAfterMs: 5 * 60_000,
  maxSpread: 0.15,
  maxRelativeSpread: 0.5,
  minDepth: 1,
  maxTradeWeight: 10,
  maxGroupInfluence: 0.5,
  minGoodScore: 0.7,
  minWarningScore: 0.4,
  uncertaintyFloor: 0.01,
  uncertaintyCeiling: 0.5,
};
export const MTM_EVIDENCE_DEFAULTS = DEFAULT_MTM_EVIDENCE_POLICY;

export type EvidenceValidationResult = {
  valid: boolean;
  errors: string[];
};

export class MtmEvidenceValidationError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`Invalid MTM evidence: ${reasons.join("; ")}`);
    this.name = "MtmEvidenceValidationError";
    this.reasons = reasons;
  }
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function validTimestamp(value: string | null | undefined): boolean {
  return value == null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function validatePrice(name: string, value: unknown, errors: string[]): void {
  if (value == null) return;
  if (!finite(value) || value < 0 || value > 1) {
    errors.push(`${name} must be a finite number between 0 and 1`);
  }
}

/** Validate without silently repairing malformed source data. */
export function validateMtmEvidence(input: unknown): EvidenceValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== "object") {
    return { valid: false, errors: ["evidence must be an object"] };
  }
  const value = input as Partial<MtmEvidenceInput>;
  if (typeof value.id !== "string" || value.id.trim() === "") errors.push("id is required");
  validatePrice("yesBid", value.yesBid, errors);
  validatePrice("yesAsk", value.yesAsk, errors);
  if (value.yesBid != null && value.yesAsk != null &&
      finite(value.yesBid) && finite(value.yesAsk) && value.yesBid > value.yesAsk) {
    errors.push("yesBid must not exceed yesAsk");
  }
  if (value.status != null &&
      !["active", "settled", "suspended", "unknown"].includes(value.status)) {
    errors.push("status is not supported");
  }
  if (value.settlement != null && !["yes", "no", "void"].includes(value.settlement)) {
    errors.push("settlement is not supported");
  }
  if (!validTimestamp(value.observedAt)) errors.push("observedAt must be an ISO timestamp");
  if (!validTimestamp(value.fetchedAt)) errors.push("fetchedAt must be an ISO timestamp");
  if (!validTimestamp(value.timestamp)) errors.push("timestamp must be an ISO timestamp");
  if (value.materialEvent?.occurredAt != null && !validTimestamp(value.materialEvent.occurredAt)) {
    errors.push("materialEvent.occurredAt must be an ISO timestamp");
  }
  if (value.depth != null) {
    if (typeof value.depth !== "object") errors.push("depth must be an object");
    else {
      for (const side of ["bid", "ask"] as const) {
        const amount = value.depth[side] ?? value.depth[`${side}Size`];
        if (amount != null && (!finite(amount) || amount < 0)) {
          errors.push(`depth.${side} must be a non-negative finite number`);
        }
      }
    }
  }
  if (value.trades != null && !Array.isArray(value.trades)) errors.push("trades must be an array");
  for (const trade of Array.isArray(value.trades) ? value.trades : []) {
    if (!trade || typeof trade !== "object" || typeof trade.id !== "string" || trade.id === "") {
      errors.push("each trade requires a non-empty id");
      continue;
    }
    validatePrice(`trade ${trade.id} price`, trade.price, errors);
    if (trade.size != null && (!finite(trade.size) || trade.size < 0)) {
      errors.push(`trade ${trade.id} size must be a non-negative finite number`);
    }
    if (!validTimestamp(trade.timestamp)) errors.push(`trade ${trade.id} timestamp must be an ISO timestamp`);
  }
  if (value.provider != null &&
      (typeof value.provider !== "object" || typeof value.provider.provider !== "string" ||
       value.provider.provider.trim() === "")) {
    errors.push("provider.provider is required");
  }
  if (typeof value.evidenceGroup === "object" && value.evidenceGroup != null) {
    if (typeof value.evidenceGroup.id !== "string" || value.evidenceGroup.id === "") {
      errors.push("evidenceGroup.id is required");
    }
    for (const field of ["cap", "influence"] as const) {
      const number = value.evidenceGroup[field];
      if (number != null && (!finite(number) || number < 0 || number > 1)) {
        errors.push(`evidenceGroup.${field} must be between 0 and 1`);
      }
    }
  } else if (value.evidenceGroup != null && typeof value.evidenceGroup !== "string") {
    errors.push("evidenceGroup must be a string or object");
  }
  return { valid: errors.length === 0, errors };
}

function cloneGroup(group: MtmEvidenceInput["evidenceGroup"]): MtmEvidenceGroup | null {
  if (group == null) return null;
  return typeof group === "string" ? { id: group } : { ...group };
}

/** Normalize optional fields while preserving an active zero bid. */
export function normalizeMtmEvidence(input: MtmEvidenceInput): NormalizedMtmEvidence {
  const validation = validateMtmEvidence(input);
  if (!validation.valid) throw new MtmEvidenceValidationError(validation.errors);
  return {
    ...input,
    yesBid: input.yesBid ?? null,
    yesAsk: input.yesAsk ?? null,
    status: input.status ?? "unknown",
    settlement: input.settlement ?? null,
    evidenceGroup: cloneGroup(input.evidenceGroup),
    trades: input.trades == null ? null : input.trades.map((trade) => ({ ...trade })),
  };
}

export type QuoteBounds = {
  lower: number;
  upper: number;
  oneSided: boolean;
  side: "two-sided" | "bid-only" | "ask-only" | "none";
};

/**
 * A YES bid is a lower bound and a YES ask is an upper bound.  A bid of zero
 * is deliberately represented as bid-only (not as a missing/settled quote).
 */
export function acceptedYesBounds(evidence: MtmEvidenceInput): QuoteBounds {
  const normalized = normalizeMtmEvidence(evidence);
  if (normalized.settlement === "yes") {
    return { lower: 1, upper: 1, oneSided: false, side: "two-sided" };
  }
  if (normalized.settlement === "no") {
    return { lower: 0, upper: 0, oneSided: false, side: "two-sided" };
  }
  const hasBid = normalized.yesBid !== null;
  const hasAsk = normalized.yesAsk !== null;
  if (hasBid && hasAsk) {
    return { lower: normalized.yesBid!, upper: normalized.yesAsk!, oneSided: false, side: "two-sided" };
  }
  if (hasBid) return { lower: normalized.yesBid!, upper: 1, oneSided: true, side: "bid-only" };
  if (hasAsk) return { lower: 0, upper: normalized.yesAsk!, oneSided: true, side: "ask-only" };
  return { lower: 0, upper: 1, oneSided: true, side: "none" };
}

export type EvidenceFactors = {
  spread: number | null;
  relativeSpread: number | null;
  depth: number | null;
  freshness: number | null;
  metadata: number;
  materialEvent: number;
  oneSided: boolean;
  activeZeroBid: boolean;
  settled: boolean;
};

export type EvidenceAssessment = {
  id: string;
  classification: EvidenceClassification;
  qualityStatus: EvidenceQualityStatus;
  score: number;
  factors: EvidenceFactors;
  reasons: string[];
  exclusionReasons: string[];
  degradationReasons: string[];
  acceptedBounds: QuoteBounds;
  groupId: string | null;
  policyVersion: string;
};

function freshnessScore(evidence: NormalizedMtmEvidence, asOfMs: number, policy: MtmEvidencePolicy): number | null {
  const timestamp = evidence.observedAt ?? evidence.fetchedAt ?? evidence.timestamp;
  if (!timestamp) return null;
  const age = asOfMs - Date.parse(timestamp);
  if (age < 0) return 0.5;
  if (age >= policy.maxAgeMs) return 0;
  return Math.max(0, 1 - age / policy.maxAgeMs);
}

function metadataScore(evidence: NormalizedMtmEvidence): number {
  const provider = evidence.provider;
  if (!provider) return 0.5;
  return provider.trust == null ? 0.75 : Math.max(0, Math.min(1, provider.trust));
}

function finiteAsOf(asOf: string | number | Date): number {
  const value = asOf instanceof Date ? asOf.getTime() : typeof asOf === "number" ? asOf : Date.parse(asOf);
  if (!Number.isFinite(value)) throw new Error("asOf must be a valid timestamp");
  return value;
}

export function assessMtmEvidence(
  input: MtmEvidenceInput,
  asOf: string | number | Date,
  suppliedPolicy: Partial<MtmEvidencePolicy> = {},
): EvidenceAssessment {
  const policy = { ...DEFAULT_MTM_EVIDENCE_POLICY, ...suppliedPolicy };
  const evidence = normalizeMtmEvidence(input);
  const bounds = acceptedYesBounds(evidence);
  const bothSides = evidence.yesBid !== null && evidence.yesAsk !== null;
  const midpoint = bothSides ? (evidence.yesBid! + evidence.yesAsk!) / 2 : null;
  const spread = bothSides ? evidence.yesAsk! - evidence.yesBid! : null;
  const relativeSpread = spread != null && midpoint! > 0 ? spread / midpoint! : null;
  const depth = evidence.depth == null
    ? null
    : (evidence.depth.bid ?? evidence.depth.bidSize ?? 0) +
      (evidence.depth.ask ?? evidence.depth.askSize ?? 0);
  const freshness = freshnessScore(evidence, finiteAsOf(asOf), policy);
  const metadata = metadataScore(evidence);
  const reasons: string[] = [];
  const exclusionReasons: string[] = [];
  const degradationReasons: string[] = [];

  if (evidence.status === "settled" || evidence.settlement != null) {
    exclusionReasons.push("settled evidence is not an active quote");
  }
  if (evidence.status === "suspended") exclusionReasons.push("market is suspended");
  if (!bothSides && bounds.side === "none" && evidence.status !== "settled") {
    exclusionReasons.push("no YES bid or ask");
  }
  if (spread != null && spread > policy.maxSpread) degradationReasons.push("spread exceeds policy");
  if (relativeSpread != null && relativeSpread > policy.maxRelativeSpread) degradationReasons.push("relative spread exceeds policy");
  if (depth != null && depth < policy.minDepth) degradationReasons.push("insufficient displayed depth");
  if (freshness == null) degradationReasons.push("timestamp is missing");
  else if (freshness === 0) degradationReasons.push("evidence is stale");
  else {
    const capturedAt = evidence.observedAt ?? evidence.fetchedAt ?? evidence.timestamp;
    if (capturedAt != null && finiteAsOf(asOf) - Date.parse(capturedAt) >= policy.staleAfterMs) {
      degradationReasons.push("evidence is stale");
    }
  }
  if (evidence.materialEvent?.occurred) degradationReasons.push("material event requires review");
  if (!bothSides) degradationReasons.push("one-sided quote");
  if (evidence.yesBid === 0 && evidence.status === "active") reasons.push("active zero YES bid");
  if (evidence.status === "settled") reasons.push("settlement is distinct from active zero bid");

  const spreadFactor = spread == null ? 0.65 : Math.max(0, 1 - spread / policy.maxSpread);
  const relativeFactor = relativeSpread == null ? 0.65 : Math.max(0, 1 - relativeSpread / policy.maxRelativeSpread);
  const depthFactor = depth == null ? 0.5 : Math.min(1, depth / Math.max(policy.minDepth, 1));
  const freshFactor = freshness ?? 0.5;
  const eventFactor = evidence.materialEvent?.occurred ? 0.5 : 1;
  const score = Math.max(0, Math.min(1,
    spreadFactor * 0.3 + relativeFactor * 0.2 + depthFactor * 0.15 +
    freshFactor * 0.2 + metadata * 0.1 + eventFactor * 0.05));
  const qualityStatus: EvidenceQualityStatus =
    exclusionReasons.length > 0 || score < policy.minWarningScore
      ? "insufficient"
      : score >= policy.minGoodScore && degradationReasons.length === 0
        ? "good"
        : "warning";
  const classification: EvidenceClassification =
    qualityStatus === "insufficient" ? "excluded"
      : qualityStatus === "good" ? "strong" : degradationReasons.length > 0 ? "degraded" : "usable";
  reasons.push(...degradationReasons);
  return {
    id: evidence.id,
    classification,
    qualityStatus,
    score,
    factors: {
      spread, relativeSpread, depth, freshness, metadata, materialEvent: eventFactor,
      oneSided: !bothSides, activeZeroBid: evidence.status === "active" && evidence.yesBid === 0,
      settled: evidence.status === "settled" || evidence.settlement != null,
    },
    reasons: [...new Set(reasons)],
    exclusionReasons,
    degradationReasons,
    acceptedBounds: bounds,
    groupId: evidence.evidenceGroup?.id ?? null,
    policyVersion: policy.version,
  };
}

export type TradeEstimate = {
  estimate: number | null;
  uncertainty: number;
  acceptedTradeCount: number;
  duplicateTradeIdsRemoved: number;
  effectiveWeight: number;
  bounds: QuoteBounds;
  reasons: string[];
};

function tradeTime(trade: EvidenceTrade): number {
  return trade.timestamp == null ? Number.NEGATIVE_INFINITY : Date.parse(trade.timestamp);
}

/**
 * Estimate a price using a capped weighted median. Duplicate IDs are reduced
 * deterministically (newest timestamp, then price, then input order).
 */
export function estimateMtmTrades(
  input: MtmEvidenceInput,
  suppliedPolicy: Partial<MtmEvidencePolicy> = {},
): TradeEstimate {
  const policy = { ...DEFAULT_MTM_EVIDENCE_POLICY, ...suppliedPolicy };
  const evidence = normalizeMtmEvidence(input);
  const bounds = acceptedYesBounds(evidence);
  const trades = evidence.trades ?? [];
  const byId = new Map<string, { trade: EvidenceTrade; index: number }>();
  trades.forEach((trade, index) => {
    const old = byId.get(trade.id);
    if (!old || tradeTime(trade) > tradeTime(old.trade) ||
        (tradeTime(trade) === tradeTime(old.trade) && trade.price > old.trade.price)) {
      byId.set(trade.id, { trade, index });
    }
  });
  const unique = [...byId.values()].sort((a, b) => a.trade.id.localeCompare(b.trade.id));
  const rows = unique.map(({ trade }) => ({
    price: Math.max(bounds.lower, Math.min(bounds.upper, trade.price)),
    weight: Math.min(policy.maxTradeWeight, Math.max(0, trade.size ?? 1)),
  })).filter((row) => row.weight > 0).sort((a, b) => a.price - b.price);
  const duplicateTradeIdsRemoved = trades.length - unique.length;
  if (rows.length === 0) {
    return {
      estimate: null, uncertainty: policy.uncertaintyCeiling, acceptedTradeCount: 0,
      duplicateTradeIdsRemoved, effectiveWeight: 0, bounds,
      reasons: trades.length ? ["all trade sizes are zero"] : ["no trades"],
    };
  }
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  let cumulative = 0;
  let median = rows[rows.length - 1].price;
  for (const row of rows) {
    cumulative += row.weight;
    if (cumulative >= total / 2) {
      median = row.price;
      break;
    }
  }
  const deviations = rows.map((row) => ({
    deviation: Math.abs(row.price - median),
    weight: row.weight,
  })).sort((a, b) => a.deviation - b.deviation);
  cumulative = 0;
  let mad = deviations[deviations.length - 1].deviation;
  for (const row of deviations) {
    cumulative += row.weight;
    if (cumulative >= total / 2) {
      mad = row.deviation;
      break;
    }
  }
  const uncertainty = Math.max(policy.uncertaintyFloor, Math.min(
    policy.uncertaintyCeiling,
    mad * 1.4826 + 0.02 / Math.sqrt(total),
  ));
  return {
    estimate: median, uncertainty, acceptedTradeCount: rows.length,
    duplicateTradeIdsRemoved, effectiveWeight: total, bounds,
    reasons: duplicateTradeIdsRemoved ? ["duplicate trade IDs removed"] : [],
  };
}

export type EvidenceAggregate = {
  value: number | null;
  uncertainty: number;
  assessments: EvidenceAssessment[];
  influenceByGroup: Record<string, number>;
  groupCapsApplied: string[];
  excluded: Array<{ id: string; reasons: string[] }>;
  degradationReasons: string[];
  policyVersion: string;
};

/**
 * Combine marks while capping correlated evidence groups. Group influence is
 * reported explicitly so downstream consumers can show why a mark moved.
 */
export function aggregateMtmEvidence(
  inputs: MtmEvidenceInput[],
  asOf: string | number | Date,
  suppliedPolicy: Partial<MtmEvidencePolicy> = {},
): EvidenceAggregate {
  const policy = { ...DEFAULT_MTM_EVIDENCE_POLICY, ...suppliedPolicy };
  // Sort before scoring so equivalent captures produce byte-for-byte stable
  // diagnostics regardless of provider response order.
  const orderedInputs = [...inputs].sort((a, b) => a.id.localeCompare(b.id));
  const assessments = orderedInputs.map((input) => assessMtmEvidence(input, asOf, policy));
  const eligible = assessments.filter((assessment) => assessment.classification !== "excluded");
  const rawWeights = eligible.map((assessment) => Math.max(0.0001, assessment.score));
  const groupTotals = new Map<string, number>();
  eligible.forEach((assessment, index) => {
    const group = assessment.groupId ?? `evidence:${assessment.id}`;
    groupTotals.set(group, (groupTotals.get(group) ?? 0) + rawWeights[index]);
  });
  const cappedGroups = new Set<string>();
  const groupMembers = new Map<string, number>();
  const configuredCaps = new Map<string, number>();
  orderedInputs.forEach((input) => {
    const group = typeof input.evidenceGroup === "string"
      ? input.evidenceGroup : input.evidenceGroup?.id ?? `evidence:${input.id}`;
    const cap = typeof input.evidenceGroup === "object" && input.evidenceGroup?.cap != null
      ? input.evidenceGroup.cap : undefined;
    if (cap != null) {
      configuredCaps.set(group, Math.min(configuredCaps.get(group) ?? 1, cap));
    }
  });
  eligible.forEach((assessment) => {
    const group = assessment.groupId ?? `evidence:${assessment.id}`;
    groupMembers.set(group, (groupMembers.get(group) ?? 0) + 1);
  });
  const weights = eligible.map((assessment, index) => {
    const group = assessment.groupId ?? `evidence:${assessment.id}`;
    // A singleton is not correlated with another observation. The default
    // cap applies only to groups with multiple members; callers may still
    // explicitly cap a singleton in its group metadata.
    const cap = configuredCaps.get(group) ??
      (groupMembers.get(group)! > 1 ? policy.maxGroupInfluence : 1);
    const total = groupTotals.get(group)!;
    const otherTotal = [...groupTotals.entries()]
      .filter(([other]) => other !== group)
      .reduce((sum, [, weight]) => sum + weight, 0);
    // Interpret cap as a fraction of final influence rather than as an
    // arbitrary raw-weight unit. This remains deterministic when scores
    // change and makes the audit field directly meaningful to consumers.
    const allowedRaw = otherTotal > 0 && cap < 1
      ? (cap / (1 - cap)) * otherTotal
      : total;
    const scale = Math.min(1, allowedRaw / total);
    if (scale < 1) cappedGroups.add(group);
    return rawWeights[index] * scale;
  });
  const denominator = weights.reduce((sum, value) => sum + value, 0);
  const value = denominator === 0 ? null : eligible.reduce((sum, assessment, index) => {
    const bounds = assessment.acceptedBounds;
    return sum + ((bounds.lower + bounds.upper) / 2) * weights[index];
  }, 0) / denominator;
  const influenceByGroup: Record<string, number> = {};
  eligible.forEach((assessment, index) => {
    const group = assessment.groupId ?? `evidence:${assessment.id}`;
    influenceByGroup[group] = (influenceByGroup[group] ?? 0) + weights[index] / (denominator || 1);
  });
  return {
    value, uncertainty: value == null ? policy.uncertaintyCeiling : Math.min(
      policy.uncertaintyCeiling,
      Math.max(policy.uncertaintyFloor, eligible.reduce((sum, assessment, index) =>
        sum + (1 - assessment.score) * weights[index], 0) / (denominator || 1) * 0.5),
    ),
    assessments,
    influenceByGroup,
    groupCapsApplied: [...cappedGroups].sort(),
    excluded: assessments.filter((assessment) => assessment.classification === "excluded")
      .map((assessment) => ({ id: assessment.id, reasons: assessment.exclusionReasons })),
    degradationReasons: [...new Set(assessments.flatMap((assessment) => assessment.degradationReasons))],
    policyVersion: policy.version,
  };
}

// Short aliases make the small, standalone API convenient without changing
// the versioned names used in persisted diagnostics.
export const validateEvidence = validateMtmEvidence;
export const normalizeEvidence = normalizeMtmEvidence;
export const assessEvidenceQuality = assessMtmEvidence;
export const estimateTradeValue = estimateMtmTrades;
export const aggregateEvidence = aggregateMtmEvidence;
export const scoreEvidence = assessMtmEvidence;
export const classifyEvidence = assessMtmEvidence;
export const weightedMedianTrades = estimateMtmTrades;