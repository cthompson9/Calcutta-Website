/**
 * Pure selection of a raw contract reference mark.
 *
 * This is intentionally separate from evidence-quality scoring. A quote can
 * be a poor diagnostic observation and still be the explicit reference mark
 * required by the pricing policy.
 */

export const MTM_REFERENCE_MARK_POLICY_VERSION = "reference-mark-selector-v2";

export type ReferenceSelectionMethod =
  | "last_in_book"
  | "bid_without_ask"
  | "bid_plus_cent"
  | "settlement"
  | "carried_forward"
  | "unavailable";

export type ReferenceReasonCode =
  | "selected_last_in_book"
  | "selected_bid_without_ask"
  | "selected_bid_plus_cent"
  | "selected_settlement"
  | "carried_forward_prior_mark"
  | "missing_contract"
  | "provider_failure"
  | "suspended_market"
  | "void_or_cancelled_contract"
  | "no_prior_mark"
  | "missing_quote"
  | "malformed_quote"
  | "nonfinite_quote"
  | "out_of_range_quote"
  | "crossed_book"
  | "last_outside_book"
  | "book_too_wide"
  | "unusable_quote"
  | "prior_contract_mismatch"
  | "invalid_settlement_result";

export type ReferenceReason = {
  code: ReferenceReasonCode;
  message: string;
  field?: "bid" | "ask" | "last" | "result" | "status" | "contract";
  sourceSelectionMethod?: ReferenceSelectionMethod | string | null;
};

export type ReferenceSourceIdentity = {
  provider?: string | null;
  contractId?: string | null;
  ticker?: string | null;
  eventId?: string | null;
};

export type ReferenceTimestamps = {
  fetchedAt?: string | null;
  observedAt?: string | null;
  lastTradeAt?: string | null;
};

export type PriorAcceptedReferenceMark = {
  referencePrice?: number | string | null;
  rawMark?: number | string | null;
  selectionMethod?: ReferenceSelectionMethod;
  source?: ReferenceSourceIdentity | null;
  sourceIdentity?: ReferenceSourceIdentity | null;
  timestamps?: ReferenceTimestamps | null;
  fetchedAt?: string | null;
  observedAt?: string | null;
  lastTradeAt?: string | null;
};

export type ReferenceMarkInput = {
  provider?: string | null;
  contractId?: string | number | null;
  ticker?: string | null;
  eventId?: string | number | null;
  status?: string | null;
  result?: string | null;
  settlement?: string | null;
  missingContract?: boolean;
  contractMissing?: boolean;
  providerFailure?: boolean | string;
  providerError?: boolean | string;
  error?: string | null;
  fetchedAt?: string | null;
  observedAt?: string | null;
  lastTradeAt?: string | null;
  yesBid?: unknown;
  yesAsk?: unknown;
  lastPrice?: unknown;
  bid?: unknown;
  ask?: unknown;
  last?: unknown;
  yes_bid?: unknown;
  yes_ask?: unknown;
  last_price?: unknown;
  yes_bid_dollars?: unknown;
  yes_ask_dollars?: unknown;
  last_price_dollars?: unknown;
  allowWideBookBidPlusCent?: boolean;
  [key: string]: unknown;
};

export type ReferenceMarkResult = {
  referencePrice: number | null;
  selectionMethod: ReferenceSelectionMethod;
  reasons: ReferenceReason[];
  source: ReferenceSourceIdentity;
  sourceIdentity: ReferenceSourceIdentity;
  timestamps: ReferenceTimestamps;
  policyVersion: typeof MTM_REFERENCE_MARK_POLICY_VERSION;
  /** Normalized raw inputs, useful for persistence and audit only. */
  normalized: {
    bid: number | null;
    ask: number | null;
    last: number | null;
  };
};

type ParsedPrice = {
  value: number | null;
  state: "missing" | "valid" | "malformed" | "nonfinite" | "out_of_range";
};

const MISSING = Symbol("missing");

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function parsePrice(value: unknown): ParsedPrice {
  if (value === undefined || value === null) return { value: null, state: "missing" };
  if (typeof value === "string" && value.trim() === "") {
    return { value: null, state: "malformed" };
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (typeof value !== "number" && typeof value !== "string") {
    return { value: null, state: "malformed" };
  }
  if (!Number.isFinite(parsed)) {
    return {
      value: null,
      state: Number.isNaN(parsed) ? "malformed" : "nonfinite",
    };
  }
  if (parsed < 0 || parsed > 1) return { value: null, state: "out_of_range" };
  return { value: parsed, state: "valid" };
}

function parseLegacyCents(value: unknown): ParsedPrice {
  if (value === undefined || value === null) return { value: null, state: "missing" };
  if (typeof value === "string" && value.trim() === "") {
    return { value: null, state: "malformed" };
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return { value: null, state: "malformed" };
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return {
      value: null,
      state: Number.isNaN(parsed) ? "malformed" : "nonfinite",
    };
  }
  const dollars = parsed / 100;
  if (dollars < 0 || dollars > 1) return { value: null, state: "out_of_range" };
  return { value: dollars, state: "valid" };
}

/**
 * Prefer fixed-point dollar fields when supplied. A null dollar field is an
 * absent field and may use the legacy cents field; malformed dollar data must
 * not be repaired by silently using a second representation.
 */
function normalizedField(
  quote: ReferenceMarkInput,
  dollarKey: string,
  legacyKey: string,
  aliases: string[],
): ParsedPrice {
  const dollar = quote[dollarKey];
  if (present(dollar)) return parsePrice(dollar);
  if (Object.prototype.hasOwnProperty.call(quote, dollarKey) && dollar !== null) {
    return parsePrice(dollar);
  }
  if (present(quote[legacyKey])) return parseLegacyCents(quote[legacyKey]);
  for (const key of aliases) {
    if (present(quote[key])) return parsePrice(quote[key]);
  }
  return { value: null, state: "missing" };
}

function sourceIdentity(quote: ReferenceMarkInput): ReferenceSourceIdentity {
  return {
    provider: quote.provider == null ? null : String(quote.provider),
    contractId: quote.contractId == null ? null : String(quote.contractId),
    ticker: quote.ticker == null ? null : String(quote.ticker),
    eventId: quote.eventId == null ? null : String(quote.eventId),
  };
}

function timestamps(quote: ReferenceMarkInput): ReferenceTimestamps {
  return {
    fetchedAt: quote.fetchedAt ?? null,
    observedAt: quote.observedAt ?? null,
    lastTradeAt: quote.lastTradeAt ?? null,
  };
}

function reason(
  code: ReferenceReasonCode,
  message: string,
  field?: ReferenceReason["field"],
): ReferenceReason {
  return field ? { code, message, field } : { code, message };
}

function carriedReason(prior: PriorAcceptedReferenceMark): ReferenceReason {
  return {
    code: "carried_forward_prior_mark",
    message: "Carried forward the prior accepted raw contract mark.",
    sourceSelectionMethod: prior.selectionMethod ?? null,
  };
}

function result(
  quote: ReferenceMarkInput,
  referencePrice: number | null,
  selectionMethod: ReferenceSelectionMethod,
  reasons: ReferenceReason[],
  normalized: { bid: number | null; ask: number | null; last: number | null },
  source = sourceIdentity(quote),
  time = timestamps(quote),
): ReferenceMarkResult {
  return {
    referencePrice,
    selectionMethod,
    reasons,
    source,
    sourceIdentity: source,
    timestamps: time,
    policyVersion: MTM_REFERENCE_MARK_POLICY_VERSION,
    normalized,
  };
}

function sameContract(
  left: ReferenceSourceIdentity,
  right: ReferenceSourceIdentity,
): boolean {
  const keys: Array<keyof ReferenceSourceIdentity> = ["provider", "contractId", "ticker", "eventId"];
  const identifyingKeys = keys.filter((key) => left[key] != null || right[key] != null);
  return identifyingKeys.length > 0 &&
    identifyingKeys.every((key) => left[key] != null && left[key] === right[key]);
}

function priorPrice(prior: PriorAcceptedReferenceMark): ParsedPrice {
  return parsePrice(prior.referencePrice ?? prior.rawMark);
}

function unavailable(
  quote: ReferenceMarkInput,
  reasons: ReferenceReason[],
  normalized: { bid: number | null; ask: number | null; last: number | null },
  prior?: PriorAcceptedReferenceMark | null,
  allowCarry = true,
): ReferenceMarkResult {
  if (allowCarry && prior) {
    const priorResult = priorPrice(prior);
    const priorSource = prior.sourceIdentity ?? prior.source ?? null;
    if (priorResult.state === "valid" && priorSource && sameContract(sourceIdentity(quote), priorSource)) {
      const source = {
        provider: priorSource.provider ?? null,
        contractId: priorSource.contractId ?? null,
        ticker: priorSource.ticker ?? null,
        eventId: priorSource.eventId ?? null,
      };
      return result(
        quote,
        priorResult.value,
        "carried_forward",
        [...reasons, carriedReason(prior)],
        normalized,
        source,
        prior.timestamps ?? {
          fetchedAt: prior.fetchedAt ?? null,
          observedAt: prior.observedAt ?? null,
          lastTradeAt: prior.lastTradeAt ?? null,
        },
      );
    }
    if (priorSource && !sameContract(sourceIdentity(quote), priorSource)) {
      reasons.push(reason("prior_contract_mismatch", "The prior mark belongs to a different exact contract.", "contract"));
    }
  }
  if (!reasons.some((item) => item.code === "no_prior_mark")) {
    reasons.push(reason("no_prior_mark", "No accepted prior raw mark is available for this exact contract."));
  }
  return result(quote, null, "unavailable", reasons, normalized);
}

/** Select the policy's raw reference mark without quality-score or I/O dependencies. */
export function selectReferenceMark(
  quote: ReferenceMarkInput | null | undefined,
  prior?: PriorAcceptedReferenceMark | null,
): ReferenceMarkResult {
  const input = quote ?? {};
  const identity = sourceIdentity(input);
  const normalized = {
    bid: normalizedField(input, "yes_bid_dollars", "yes_bid", ["yesBid", "bid"]).value,
    ask: normalizedField(input, "yes_ask_dollars", "yes_ask", ["yesAsk", "ask"]).value,
    last: normalizedField(input, "last_price_dollars", "last_price", ["lastPrice", "last"]).value,
  };
  const bid = normalizedField(input, "yes_bid_dollars", "yes_bid", ["yesBid", "bid"]);
  const ask = normalizedField(input, "yes_ask_dollars", "yes_ask", ["yesAsk", "ask"]);
  const last = normalizedField(input, "last_price_dollars", "last_price", ["lastPrice", "last"]);
  const reasons: ReferenceReason[] = [];
  const status = String(input.status ?? "").trim().toLowerCase();
  const outcome = String(input.result ?? input.settlement ?? "").trim().toLowerCase();
  const settledStatuses = new Set(["closed", "determined", "finalized", "settled"]);
  const voidStatuses = new Set(["void", "cancelled", "canceled"]);
  const isVoid = voidStatuses.has(status) || voidStatuses.has(outcome);
  const isSettled = settledStatuses.has(status) && (outcome === "yes" || outcome === "no");

  if (input.missingContract || input.contractMissing) {
    reasons.push(reason("missing_contract", "The expected contract was not returned.", "contract"));
  }
  if (input.providerFailure || input.providerError || input.error) {
    reasons.push(reason("provider_failure", "The provider fetch failed for this contract.", "contract"));
  }
  if (isVoid) {
    return unavailable(input, [
      ...reasons,
      reason("void_or_cancelled_contract", "Void or cancelled contracts cannot reuse an obsolete active mark.", "status"),
    ], normalized, prior, false);
  }
  if (isSettled) {
    return result(
      input,
      outcome === "yes" ? 1 : 0,
      "settlement",
      [...reasons, reason("selected_settlement", "Used the valid final settlement result.", "result")],
      normalized,
    );
  }
  if (status === "suspended") {
    reasons.push(reason("suspended_market", "The market is suspended.", "status"));
    return unavailable(input, reasons, normalized, prior);
  }
  if (bid.state === "malformed") reasons.push(reason("malformed_quote", "YES bid is malformed.", "bid"));
  if (ask.state === "malformed") reasons.push(reason("malformed_quote", "YES ask is malformed.", "ask"));
  if (last.state === "malformed") reasons.push(reason("malformed_quote", "Last price is malformed.", "last"));
  if (bid.state === "nonfinite") reasons.push(reason("nonfinite_quote", "YES bid is nonfinite.", "bid"));
  if (ask.state === "nonfinite") reasons.push(reason("nonfinite_quote", "YES ask is nonfinite.", "ask"));
  if (last.state === "nonfinite") reasons.push(reason("nonfinite_quote", "Last price is nonfinite.", "last"));
  if (bid.state === "out_of_range") reasons.push(reason("out_of_range_quote", "YES bid is outside [0,1].", "bid"));
  if (ask.state === "out_of_range") reasons.push(reason("out_of_range_quote", "YES ask is outside [0,1].", "ask"));
  if (last.state === "out_of_range") reasons.push(reason("out_of_range_quote", "Last price is outside [0,1].", "last"));

  const validBook = bid.state === "valid" && ask.state === "valid" && bid.value! <= ask.value!;
  if (bid.state === "valid" && ask.state === "valid" && bid.value! > ask.value!) {
    reasons.push(reason("crossed_book", "YES bid exceeds YES ask.", "bid"));
  }
  if (validBook && last.state === "valid" && last.value! >= bid.value! && last.value! <= ask.value!) {
    return result(input, last.value, "last_in_book", [
      ...reasons,
      reason("selected_last_in_book", "Selected Last because it is inside the valid ordered book.", "last"),
    ], normalized);
  }
  if (last.state === "valid" && validBook &&
      (last.value! < bid.value! || last.value! > ask.value!)) {
    reasons.push(reason("last_outside_book", "Last is not inside the valid ordered book.", "last"));
  }
  const askGenuinelyAbsent = ask.state === "missing";
  if (bid.state === "valid" && askGenuinelyAbsent) {
    return result(input, bid.value, "bid_without_ask", [
      ...reasons,
      reason("selected_bid_without_ask", "Selected the valid bid because ask is genuinely absent.", "bid"),
    ], normalized);
  }
  if (validBook) {
    const spread = ask.value! - bid.value!;
    const midpoint = (ask.value! + bid.value!) / 2;
    const relative = midpoint > 0 ? spread / midpoint : Number.POSITIVE_INFINITY;
    const comparisonTolerance = 1e-12;
    const tightBook = spread <= 0.02 + comparisonTolerance ||
      relative <= 0.10 + comparisonTolerance;
    if (tightBook || input.allowWideBookBidPlusCent === true) {
      const selected = Math.min(bid.value! + 0.01, ask.value!, 1);
      // Avoid binary floating-point artifacts without rounding the supplied
      // input used by the eligibility comparisons.
      return result(input, Number(selected.toFixed(12)), "bid_plus_cent", [
        ...reasons,
        reason(
          "selected_bid_plus_cent",
          tightBook
            ? "Selected capped bid plus one cent from a tight ordered book."
            : "Selected capped bid plus one cent from a valid ordered book under the contract pricing policy.",
        ),
      ], normalized);
    }
    reasons.push(reason("book_too_wide", "The ordered book exceeds both tight-book thresholds."));
  }
  if (bid.state === "missing" && ask.state === "missing" && last.state === "missing") {
    reasons.push(reason("missing_quote", "No bid, ask, or last price was supplied."));
  }
  if (!reasons.some((item) => ["crossed_book", "book_too_wide", "missing_quote", "malformed_quote", "nonfinite_quote", "out_of_range_quote"].includes(item.code))) {
    reasons.push(reason("unusable_quote", "The supplied quote cannot produce an active reference mark."));
  }
  return unavailable(input, reasons, normalized, prior);
}

export const resolveReferenceMark = selectReferenceMark;
export const selectMtmReferenceMark = selectReferenceMark;