import {
  selectReferenceMark,
  type PriorAcceptedReferenceMark,
  type ReferenceMarkInput,
  type ReferenceMarkResult,
} from "./mtmReferenceMarks";

/**
 * The lookup key intentionally contains every economic/provider identity
 * available at collection time. A quote from another pool, event, ticker, or
 * outcome can never seed a carried-forward mark.
 */
export type ReferenceContractKey = {
  poolId: number;
  seasonId: number;
  provider: string;
  eventId: string | number | null;
  ticker: string;
  outcome: string | null;
  strike: string | number | null;
};

export type ReferenceCandidate = ReferenceMarkInput & {
  key: ReferenceContractKey;
  fetched: boolean;
};

export type PersistedReference = {
  key: ReferenceContractKey;
  referencePrice: number | null;
  selectionMethod: ReferenceMarkResult["selectionMethod"];
  selectionReason: ReferenceMarkResult["reasons"];
  referenceAcceptedAt: string | null;
  referenceSourceSnapshotId: number | null;
  referenceSourceTicker: string | null;
  referencePolicyVersion: string;
  fetchOutcome: "fulfilled" | "failed" | "missing" | "not_requested";
  lastPrice: number | null;
  source: ReferenceMarkResult["source"];
  timestamps: ReferenceMarkResult["timestamps"];
};

type PriorRow = {
  key: ReferenceContractKey;
  referencePrice?: number | string | null;
  selectionMethod?: string | null;
  referenceAcceptedAt?: string | Date | null;
  referenceSourceSnapshotId?: number | null;
  referenceSourceTicker?: string | null;
  referencePolicyVersion?: string | null;
  provider?: string | null;
  contract?: string | null;
  marketTicker?: string | null;
  eventId?: string | number | null;
  fetchedAt?: string | Date | null;
  sourceObservedAt?: string | Date | null;
  source?: string | null;
};

function normalized(value: string | number | null | undefined): string {
  return value == null ? "" : String(value);
}

export function referenceContractKey(value: ReferenceContractKey): string {
  return [
    value.poolId,
    value.seasonId,
    value.provider,
    normalized(value.eventId),
    value.ticker,
    normalized(value.outcome),
    normalized(value.strike),
  ].join("|");
}

function priorForCandidate(candidate: ReferenceCandidate, row: PriorRow | undefined): PriorAcceptedReferenceMark | null {
  if (!row || row.referencePrice == null) return null;
  return {
    referencePrice: row.referencePrice,
    selectionMethod: row.selectionMethod as PriorAcceptedReferenceMark["selectionMethod"],
    source: {
      provider: candidate.provider ?? candidate.key.provider ?? row.provider ?? row.source ?? null,
      contractId: String(candidate.contractId ?? candidate.ticker ?? candidate.key.ticker ?? row.contract ?? row.marketTicker ?? "") || null,
      ticker: candidate.ticker ?? candidate.key.ticker ?? row.referenceSourceTicker ?? row.marketTicker ?? null,
      eventId: candidate.eventId == null && candidate.key.eventId == null && row.eventId == null
        ? null
        : String(candidate.eventId ?? candidate.key.eventId ?? row.eventId),
    },
    sourceIdentity: {
      provider: candidate.provider ?? candidate.key.provider ?? row.provider ?? row.source ?? null,
      contractId: String(candidate.contractId ?? candidate.ticker ?? candidate.key.ticker ?? row.contract ?? row.marketTicker ?? "") || null,
      ticker: candidate.ticker ?? candidate.key.ticker ?? row.referenceSourceTicker ?? row.marketTicker ?? null,
      eventId: candidate.eventId == null && candidate.key.eventId == null && row.eventId == null
        ? null
        : String(candidate.eventId ?? candidate.key.eventId ?? row.eventId),
    },
    timestamps: {
      fetchedAt: row.fetchedAt ? new Date(row.fetchedAt).toISOString() : null,
      observedAt: row.sourceObservedAt ? new Date(row.sourceObservedAt).toISOString() : null,
      lastTradeAt: null,
    },
  };
}

/**
 * Resolve all current candidates from one in-memory previous-reference set.
 * Callers should populate previousRows from successful official snapshots only.
 * The function never performs I/O and keeps original provenance on carry-forward.
 */
export function resolveReferenceCandidates(
  candidates: ReferenceCandidate[],
  previousRows: PriorRow[],
  acceptedAt: Date,
  sourceSnapshotId: number,
): PersistedReference[] {
  const previous = new Map<string, PriorRow>();
  for (const row of previousRows) {
    if (row.referencePrice == null) continue;
    const key = referenceContractKey(row.key);
    if (!previous.has(key)) previous.set(key, row);
  }

  return candidates.map((candidate) => {
    const key = referenceContractKey(candidate.key);
    const current = selectReferenceMark({
      ...candidate,
      provider: candidate.provider ?? candidate.key.provider,
      contractId: candidate.contractId ?? candidate.key.ticker,
      ticker: candidate.ticker ?? candidate.key.ticker,
      eventId: candidate.eventId ?? candidate.key.eventId,
    }, priorForCandidate(candidate, previous.get(key)));
    const carried = current.selectionMethod === "carried_forward";
    const acceptedAtValue = carried
      ? previous.get(key)?.referenceAcceptedAt ?? null
      : current.referencePrice == null ? null : acceptedAt.toISOString();
    const prior = previous.get(key);
    return {
      key: candidate.key,
      referencePrice: current.referencePrice,
      selectionMethod: current.selectionMethod,
      selectionReason: current.reasons,
      referenceAcceptedAt: acceptedAtValue
        ? new Date(acceptedAtValue).toISOString()
        : null,
      referenceSourceSnapshotId: carried
        ? prior?.referenceSourceSnapshotId ?? null
        : current.referencePrice == null ? null : sourceSnapshotId,
      referenceSourceTicker: carried
        ? prior?.referenceSourceTicker ?? current.source.ticker ?? null
        : current.source.ticker ?? null,
      referencePolicyVersion: current.policyVersion,
      fetchOutcome: candidate.fetched
        ? "fulfilled"
        : candidate.providerFailure || candidate.providerError || candidate.error
          ? "failed"
          : "missing",
      lastPrice: current.normalized.last,
      source: current.source,
      timestamps: current.timestamps,
    };
  });
}