/**
 * Small public boundary for review solvers that only need contract
 * settlement.  Sport-specific identity and legal-outcome definitions live in
 * sportAdapter.ts; this file keeps callers from depending on adapter
 * implementation details.
 */

import {
  evaluateContract,
  type SettlementContract,
  type SettlementEvidence,
  type SettlementResult,
  type SportAdapter,
} from "./sportAdapter";

export type SettlementPredicate = (
  contract: SettlementContract,
  evidence: SettlementEvidence | null,
) => SettlementResult;

export function deterministicSettlement(
  adapter: SportAdapter,
): SettlementPredicate {
  return (contract, evidence) => evaluateContract(adapter, contract, evidence);
}

/** Return the full auditable result, including the evidence and reason. */
export function settleWithEvidence(
  adapter: SportAdapter,
  contract: SettlementContract,
  evidence: SettlementEvidence | null,
): SettlementResult {
  return evaluateContract(adapter, contract, evidence);
}

/** A predicate is deliberately false for an absent/unsettled assertion. */
export function settlementPredicate(
  adapter: SportAdapter,
  contract: SettlementContract,
  evidence: SettlementEvidence | null,
): boolean {
  return evaluateContract(adapter, contract, evidence).status === "settled";
}
