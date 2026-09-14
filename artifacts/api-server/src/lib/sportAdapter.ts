/**
 * Provider-neutral contract and settlement primitives.
 *
 * An adapter is deliberately smaller than an ingestion client.  It describes
 * which outcomes a competition can legally have and how an already captured
 * piece of evidence settles a contract.  In particular, adapters must not
 * infer an outcome from a missing provider field.  This makes the module safe
 * for both review runs and replaying historical captures.
 */

export const NFL = "NFL" as const;
export const CFB = "CFB" as const;
export const NBA = "NBA" as const;
export const MARCH_MADNESS = "MARCH_MADNESS" as const;
export const WORLD_CUP = "WORLD_CUP" as const;

export const NFL_REGULAR_SEASON = "NFL_REGULAR_SEASON" as const;
export const NFL_POSTSEASON = "NFL_POSTSEASON" as const;
export const NFL_PLAYOFFS = NFL_POSTSEASON;
export const CFB_PLAYOFF = "CFB_PLAYOFF" as const;
export const CFB_PLAYOFFS = "CFB_PLAYOFFS" as const;
export const CFB_POSTSEASON = "CFB_POSTSEASON" as const;
export const NBA_PLAYOFF = "NBA_PLAYOFF" as const;
export const NBA_PLAYOFFS = "NBA_PLAYOFFS" as const;
export const MARCH_MADNESS_PLAYOFFS = "MARCH_MADNESS_PLAYOFFS" as const;
export const WORLD_CUP_TOURNAMENT = "WORLD_CUP_TOURNAMENT" as const;
export const MARCH_MADNESS_COMPETITION = MARCH_MADNESS;
export const WORLD_CUP_COMPETITION = WORLD_CUP;

export type Sport = typeof NFL | typeof CFB | typeof NBA | typeof MARCH_MADNESS | typeof WORLD_CUP;
export type CompetitionFormat =
  | typeof NFL_REGULAR_SEASON
  | typeof NFL_POSTSEASON
  | typeof CFB_PLAYOFF
  | typeof CFB_PLAYOFFS
  | typeof CFB_POSTSEASON
  | typeof NBA_PLAYOFF
  | typeof NBA_PLAYOFFS
  | typeof MARCH_MADNESS_PLAYOFFS
  | typeof WORLD_CUP_TOURNAMENT
  | typeof MARCH_MADNESS
  | typeof WORLD_CUP;

export type CompetitionIdentity = {
  sport: Sport;
  competition: CompetitionFormat;
  seasonYear: number;
  /** Provider or competition identity, not a display label. */
  competitionId: string;
};

export type EventIdentity = {
  competition: CompetitionIdentity;
  eventId: string;
  provider?: string | null;
  sequence?: number | null;
  homeTeamId?: string | null;
  awayTeamId?: string | null;
};

export function competitionIdentityKey(identity: CompetitionIdentity): string {
  return [
    identity.sport,
    identity.competition,
    identity.seasonYear,
    identity.competitionId,
  ].join(":");
}

export function eventIdentityKey(identity: EventIdentity): string {
  return `${competitionIdentityKey(identity.competition)}:${identity.provider ?? "unknown"}:${identity.eventId}`;
}

function sameCompetition(left: CompetitionIdentity, right: CompetitionIdentity): boolean {
  return competitionIdentityKey(left) === competitionIdentityKey(right);
}

function sameEvent(left: EventIdentity, right: EventIdentity): boolean {
  return sameCompetition(left.competition, right.competition) &&
    left.eventId === right.eventId &&
    (left.provider == null || right.provider == null || left.provider === right.provider) &&
    (left.sequence == null || right.sequence == null || left.sequence === right.sequence);
}

export type OutcomeKind =
  | "home_win"
  | "away_win"
  | "tie"
  | "yes"
  | "no"
  | "advance"
  | "eliminate"
  | "threshold";

/**
 * `advancement` is nested rather than represented as a second, unrelated
 * contract.  A review solver can therefore inspect every legal terminal
 * outcome without inventing a bracket when an event is missing.
 */
export type LegalAdvancement = {
  stage: string;
  event?: EventIdentity;
  legalOutcomes: readonly LegalOutcome[];
};

export type LegalOutcome = {
  id: string;
  kind: OutcomeKind;
  label?: string;
  teamId?: string | null;
  threshold?: number | null;
  advancement?: LegalAdvancement | null;
};

export type ContractKind = "event_result" | "win_ladder" | "advancement";

export type SettlementContract = {
  id: string;
  competition: CompetitionIdentity;
  event?: EventIdentity;
  kind: ContractKind;
  /** Team, club, or entrant whose result is being contracted. */
  subjectId?: string | null;
  /** YES is the named outcome; another legal outcome settles NO. */
  yesOutcomeId: string;
  legalOutcomes: readonly LegalOutcome[];
  threshold?: number | null;
  stage?: string | null;
};

export type SettlementEvidence = {
  source: string;
  capturedAt: string;
  competition: CompetitionIdentity;
  event?: EventIdentity;
  /** Canonical value. `outcome` is accepted as a replay-friendly alias. */
  outcomeId?: string | null;
  outcome?: string | null;
  winnerId?: string | null;
  loserId?: string | null;
  tie?: boolean;
  actualWins?: number | null;
  advancement?: {
    stage: string;
    teamId: string;
    advanced: boolean;
    event?: EventIdentity;
  } | null;
  /** Original provider assertion, retained as evidence but never interpreted. */
  sourceData?: Record<string, unknown> | null;
};

export type SettlementResult =
  | {
      status: "settled";
      outcome: "yes" | "no";
      evidence: SettlementEvidence;
      reason: string;
    }
  | {
      status: "unsettled";
      outcome: null;
      evidence: SettlementEvidence | null;
      reason: string;
    };

export class UnsupportedSportError extends Error {
  readonly sport: Sport;
  readonly competition: CompetitionFormat;

  constructor(sport: Sport, competition: CompetitionFormat) {
    super(`No settlement adapter is implemented for ${sport} ${competition}.`);
    this.name = "UnsupportedSportError";
    this.sport = sport;
    this.competition = competition;
  }
}

export class ContractValidationError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`Invalid settlement contract: ${reasons.join("; ")}`);
    this.name = "ContractValidationError";
    this.reasons = reasons;
  }
}

export type SportAdapter = {
  sport: Sport;
  competition: CompetitionFormat;
  supported: boolean;
  legalOutcomes(contract: SettlementContract): readonly LegalOutcome[];
  settle(contract: SettlementContract, evidence: SettlementEvidence | null): SettlementResult;
};

function assertIdentity(contract: SettlementContract, evidence: SettlementEvidence): void {
  if (!sameCompetition(contract.competition, evidence.competition)) {
    throw new ContractValidationError([
      "settlement evidence belongs to a different competition identity",
    ]);
  }
  if (contract.event && (!evidence.event || !sameEvent(contract.event, evidence.event))) {
    throw new ContractValidationError(["settlement evidence belongs to a different event identity"]);
  }
  if (contract.event && !sameCompetition(contract.competition, contract.event.competition)) {
    throw new ContractValidationError(["event identity does not belong to contract competition"]);
  }
  if (evidence.event && !sameCompetition(evidence.competition, evidence.event.competition)) {
    throw new ContractValidationError(["event identity does not belong to evidence competition"]);
  }
}

function validateNestedOutcomes(outcomes: readonly LegalOutcome[], path = "outcomes"): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const outcome of outcomes) {
    if (!outcome.id.trim()) errors.push(`${path} contains an outcome with no id`);
    if (ids.has(outcome.id)) errors.push(`${path} contains duplicate outcome "${outcome.id}"`);
    ids.add(outcome.id);
    if (outcome.advancement) {
      if (!outcome.advancement.stage.trim()) {
        errors.push(`${path}.${outcome.id}.advancement requires a stage`);
      }
      errors.push(...validateNestedOutcomes(
        outcome.advancement.legalOutcomes,
        `${path}.${outcome.id}.advancement.legalOutcomes`,
      ));
    }
  }
  return errors;
}

export function validateSettlementContract(contract: SettlementContract): void {
  const errors: string[] = [];
  if (!contract.id.trim()) errors.push("id is required");
  if (!contract.competition.competitionId.trim()) errors.push("competitionId is required");
  if (!Number.isInteger(contract.competition.seasonYear)) errors.push("seasonYear must be an integer");
  if (contract.event && !contract.event.eventId.trim()) errors.push("eventId is required");
  if (contract.event && !sameCompetition(contract.competition, contract.event.competition)) {
    errors.push("event identity does not belong to contract competition");
  }
  if (contract.legalOutcomes.length === 0) errors.push("at least one legal outcome is required");
  errors.push(...validateNestedOutcomes(contract.legalOutcomes));
  if (!contract.legalOutcomes.some((outcome) => outcome.id === contract.yesOutcomeId)) {
    errors.push(`yesOutcomeId "${contract.yesOutcomeId}" is not a legal outcome`);
  }
  if (contract.kind === "win_ladder" &&
      (contract.threshold == null || !Number.isInteger(contract.threshold) || contract.threshold < 0)) {
    errors.push("win-ladder contracts require a non-negative integer threshold");
  }
  if (errors.length > 0) throw new ContractValidationError(errors);
}

function outcomeId(evidence: SettlementEvidence): string | null {
  if (evidence.outcomeId != null && evidence.outcome != null &&
      evidence.outcomeId !== evidence.outcome) {
    throw new ContractValidationError(["evidence outcomeId and outcome disagree"]);
  }
  return evidence.outcomeId ?? evidence.outcome ?? null;
}

function settleSupportedContract(
  contract: SettlementContract,
  evidence: SettlementEvidence | null,
): SettlementResult {
  validateSettlementContract(contract);
  if (!evidence) {
    return { status: "unsettled", outcome: null, evidence: null, reason: "settlement evidence is required" };
  }
  assertIdentity(contract, evidence);
  const observedOutcome = outcomeId(evidence);

  if (contract.kind === "win_ladder") {
    if (evidence.actualWins == null || !Number.isInteger(evidence.actualWins) || evidence.actualWins < 0) {
      return { status: "unsettled", outcome: null, evidence, reason: "a win-ladder contract requires final actualWins evidence" };
    }
    if (contract.subjectId == null) {
      throw new ContractValidationError(["win-ladder contracts require subjectId"]);
    }
    if (evidence.winnerId != null && evidence.winnerId !== contract.subjectId) {
      throw new ContractValidationError(["win-ladder evidence has a different subjectId"]);
    }
    const yes = evidence.actualWins >= contract.threshold!;
    return {
      status: "settled",
      outcome: yes ? "yes" : "no",
      evidence,
      reason: yes
        ? `actual wins ${evidence.actualWins} meet threshold ${contract.threshold}`
        : `actual wins ${evidence.actualWins} are below threshold ${contract.threshold}`,
    };
  }

  if (observedOutcome == null) {
    return { status: "unsettled", outcome: null, evidence, reason: "evidence has no legal outcome" };
  }
  const legal = contract.legalOutcomes.find((candidate) => candidate.id === observedOutcome);
  if (!legal) {
    throw new ContractValidationError([`evidence outcome "${observedOutcome}" is not legal for this contract`]);
  }
  if (legal.kind === "tie" && evidence.tie === false) {
    throw new ContractValidationError(["tie outcome disagrees with evidence.tie"]);
  }
  if (legal.kind !== "tie" && evidence.tie === true) {
    throw new ContractValidationError(["non-tie outcome disagrees with evidence.tie"]);
  }
  if (contract.kind === "event_result" && evidence.winnerId != null) {
    const expectedWinner = observedOutcome === "home_win"
      ? contract.event?.homeTeamId
      : observedOutcome === "away_win"
        ? contract.event?.awayTeamId
        : null;
    if (expectedWinner != null && evidence.winnerId !== expectedWinner) {
      throw new ContractValidationError(["event winnerId disagrees with event identity"]);
    }
    if (observedOutcome === "tie") {
      throw new ContractValidationError(["a tie outcome cannot include winnerId"]);
    }
  }

  if (contract.kind === "advancement") {
    const advancement = evidence.advancement;
    if (!advancement) {
      return { status: "unsettled", outcome: null, evidence, reason: "advancement evidence is required" };
    }
    if (advancement.stage !== contract.stage || advancement.teamId !== contract.subjectId) {
      throw new ContractValidationError(["advancement evidence does not match contract subject or stage"]);
    }
    const expected = advancement.advanced ? "advance" : "eliminate";
    if (observedOutcome !== expected) {
      throw new ContractValidationError(["advancement evidence outcome disagrees with advanced"]);
    }
  }

  return {
    status: "settled",
    outcome: observedOutcome === contract.yesOutcomeId ? "yes" : "no",
    evidence,
    reason: `legal outcome "${observedOutcome}" was observed`,
  };
}

export const NFL_ADVANCEMENT_STAGES = [
  "playoff_berth",
  "divisional",
  "conference",
  "sb_berth",
  "sb_win",
] as const;

export type NflAdvancementStage = (typeof NFL_ADVANCEMENT_STAGES)[number];

const NFL_REGULAR_OUTCOMES: readonly LegalOutcome[] = [
  { id: "home_win", kind: "home_win", label: "home team wins" },
  { id: "away_win", kind: "away_win", label: "away team wins" },
  { id: "tie", kind: "tie", label: "game is tied" },
];
const NFL_POSTSEASON_OUTCOMES: readonly LegalOutcome[] = NFL_REGULAR_OUTCOMES
  .filter((outcome) => outcome.kind !== "tie");

export function createNflEventContract(input: {
  id: string;
  competition: CompetitionIdentity;
  event: EventIdentity;
  postseason?: boolean;
}): SettlementContract {
  const legalOutcomes = input.postseason ? NFL_POSTSEASON_OUTCOMES : NFL_REGULAR_OUTCOMES;
  return {
    id: input.id,
    competition: input.competition,
    event: input.event,
    kind: "event_result",
    yesOutcomeId: "home_win",
    legalOutcomes,
  };
}

export function createNflWinLadderContract(input: {
  id: string;
  competition: CompetitionIdentity;
  teamId: string;
  threshold: number;
}): SettlementContract {
  if (!Number.isInteger(input.threshold) || input.threshold < 0 || input.threshold > 17) {
    throw new ContractValidationError(["NFL win threshold must be an integer from 0 through 17"]);
  }
  return {
    id: input.id,
    competition: input.competition,
    kind: "win_ladder",
    subjectId: input.teamId,
    threshold: input.threshold,
    yesOutcomeId: "yes",
    legalOutcomes: [
      { id: "yes", kind: "threshold", threshold: input.threshold, teamId: input.teamId },
      { id: "no", kind: "threshold", threshold: input.threshold, teamId: input.teamId },
    ],
  };
}

export function createNflAdvancementContract(input: {
  id: string;
  competition: CompetitionIdentity;
  event?: EventIdentity;
  teamId: string;
  stage: NflAdvancementStage;
}): SettlementContract {
  const advancement: LegalAdvancement = {
    stage: input.stage,
    event: input.event,
    legalOutcomes: [
      { id: "advance", kind: "advance", teamId: input.teamId },
      { id: "eliminate", kind: "eliminate", teamId: input.teamId },
    ],
  };
  return {
    id: input.id,
    competition: input.competition,
    event: input.event,
    kind: "advancement",
    subjectId: input.teamId,
    stage: input.stage,
    yesOutcomeId: "advance",
    legalOutcomes: [
      { id: "advance", kind: "advance", teamId: input.teamId, advancement },
      { id: "eliminate", kind: "eliminate", teamId: input.teamId },
    ],
  };
}

export const NFL_SPORT_ADAPTER: SportAdapter = {
  sport: NFL,
  competition: NFL_REGULAR_SEASON,
  supported: true,
  legalOutcomes(contract) {
    return contract.kind === "event_result" ? NFL_REGULAR_OUTCOMES : contract.legalOutcomes;
  },
  settle: settleSupportedContract,
};

export const NFL_POSTSEASON_ADAPTER: SportAdapter = {
  sport: NFL,
  competition: NFL_POSTSEASON,
  supported: true,
  legalOutcomes(contract) {
    return contract.kind === "event_result" ? NFL_POSTSEASON_OUTCOMES : contract.legalOutcomes;
  },
  settle: settleSupportedContract,
};

/**
 * These are real registry entries, rather than silently falling back to NFL
 * semantics.  A caller can display the reason or defer a review, but cannot
 * create fabricated postseason outcomes.
 */
export function unsupportedSportAdapter(
  sport: Sport,
  competition: CompetitionFormat,
): SportAdapter {
  return {
    sport,
    competition,
    supported: false,
    legalOutcomes() {
      throw new UnsupportedSportError(sport, competition);
    },
    settle() {
      throw new UnsupportedSportError(sport, competition);
    },
  };
}

export const UNSUPPORTED_SPORT_ADAPTERS: readonly SportAdapter[] = [
  unsupportedSportAdapter(CFB, CFB_PLAYOFF),
  unsupportedSportAdapter(CFB, CFB_PLAYOFFS),
  unsupportedSportAdapter(CFB, CFB_POSTSEASON),
  unsupportedSportAdapter(NBA, NBA_PLAYOFF),
  unsupportedSportAdapter(NBA, NBA_PLAYOFFS),
  unsupportedSportAdapter(MARCH_MADNESS, MARCH_MADNESS_PLAYOFFS),
  unsupportedSportAdapter(MARCH_MADNESS, MARCH_MADNESS_COMPETITION),
  unsupportedSportAdapter(WORLD_CUP, WORLD_CUP_TOURNAMENT),
  unsupportedSportAdapter(WORLD_CUP, WORLD_CUP_COMPETITION),
];

export const SUPPORTED_SPORT_ADAPTERS: readonly SportAdapter[] = [
  NFL_SPORT_ADAPTER,
  NFL_POSTSEASON_ADAPTER,
];
const ADAPTERS: readonly SportAdapter[] = [
  ...SUPPORTED_SPORT_ADAPTERS,
  ...UNSUPPORTED_SPORT_ADAPTERS,
];

export function getSportAdapter(
  sport: Sport,
  competition: CompetitionFormat,
): SportAdapter {
  const adapter = ADAPTERS.find((candidate) =>
    candidate.sport === sport && candidate.competition === competition,
  );
  if (adapter) return adapter;
  throw new UnsupportedSportError(sport, competition);
}

export function evaluateContract(
  adapter: SportAdapter,
  contract: SettlementContract,
  evidence: SettlementEvidence | null,
): SettlementResult {
  if (!adapter.supported) throw new UnsupportedSportError(adapter.sport, adapter.competition);
  if (contract.competition.sport !== adapter.sport) {
    throw new ContractValidationError(["contract sport does not match adapter"]);
  }
  // Ask the adapter for the legal set instead of trusting a caller-supplied
  // event outcome list.  This is what prevents an accidental tie in an NFL
  // playoff contract (or an invented outcome in a future adapter).
  const legalOutcomes = adapter.legalOutcomes(contract);
  return adapter.settle({ ...contract, legalOutcomes }, evidence);
}

export type WinLadderEntry = {
  threshold: number;
  probability?: number | null;
  contract?: SettlementContract;
};

/** Validate both threshold ordering and the expected descending YES ladder. */
export function validateWinLadderMonotonicity(entries: readonly WinLadderEntry[]): void {
  const errors: string[] = [];
  let previousProbability: number | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    if (!Number.isInteger(current.threshold) || current.threshold < 0) {
      errors.push(`win-ladder threshold at index ${index} is invalid`);
    }
    if (index > 0 && current.threshold <= entries[index - 1].threshold) {
      errors.push("win-ladder thresholds must be strictly increasing");
    }
    if (current.probability != null &&
        (!Number.isFinite(current.probability) || current.probability < 0 || current.probability > 1)) {
      errors.push(`win-ladder probability at index ${index} must be between 0 and 1`);
    }
    if (current.probability != null && previousProbability != null &&
        current.probability > previousProbability) {
      errors.push("win-ladder YES probabilities must be non-increasing");
    }
    if (current.probability != null) previousProbability = current.probability;
  }
  if (errors.length > 0) throw new ContractValidationError(errors);
}

export function isWinLadderMonotone(entries: readonly WinLadderEntry[]): boolean {
  try {
    validateWinLadderMonotonicity(entries);
    return true;
  } catch {
    return false;
  }
}

export function flattenLegalOutcomes(
  outcomes: readonly LegalOutcome[],
): LegalOutcome[] {
  return outcomes.flatMap((outcome) => [
    outcome,
    ...(outcome.advancement ? flattenLegalOutcomes(outcome.advancement.legalOutcomes) : []),
  ]);
}

export const evaluateSettlementContract = evaluateContract;
export const assertWinLadderMonotonicity = validateWinLadderMonotonicity;
export const settleContract = evaluateContract;