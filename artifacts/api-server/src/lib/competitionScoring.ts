import { LEAGUE_POINT_TOTAL } from "./weekZeroValuation";

export type CompetitionPeriod = {
  sequence: number;
  label: string;
  isPlayoff: boolean;
};

export type ScoringRuleInput = {
  metric: string;
  dollarsPerUnit: number | null;
  playoffMultiplier?: number | null;
};

export type ConfiguredScoringRule = {
  metric: string;
  dollarsPerUnit: number;
  playoffMultiplier: number;
};

export type CompetitionOutcomeEvent = {
  seasonId: number;
  source?: string;
  sourceEventId: string;
  periodSequence: number;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number;
  awayScore: number;
  actualKickoffAt?: Date | string | null;
  status?: string;
  sourceData?: Record<string, unknown> | null;
};

export type AuditedOutcomeAggregate = {
  metrics: Record<string, number>;
  sourceEvents: CompetitionOutcomeEvent[];
};

export type CompetitionScoringAdapter = {
  sport: string;
  competitionFormat: string;
  allowedMetrics: readonly string[];
  realizedMetrics: readonly string[];
  mtmMetrics: readonly string[];
  periods: readonly CompetitionPeriod[];
  startingPoints: number | null;
  normalizationDenominator: number | null;
  defaultRules: readonly ScoringRuleInput[] | null;
  requiredSnapshotMetrics(
    basis: "realized" | "mtm",
    period: Pick<CompetitionPeriod, "sequence" | "isPlayoff">,
  ): readonly string[];
  aggregateOutcomes(events: CompetitionOutcomeEvent[]): Map<number, AuditedOutcomeAggregate>;
  pointMetricValues(metrics: Readonly<Record<string, number>>): Record<string, number>;
  validateRules?(
    rules: readonly ScoringRuleInput[],
  ): { ok: true; rules: ConfiguredScoringRule[] } | { ok: false; error: string };
};

export type ScoredCompetitionEntry = {
  teamId: number;
  points: number;
  pointsBreakdown: Record<string, number>;
  normalizedShare: number;
  fairValue: number;
  grossReturn: number;
  netReturn: number;
  multiple: number;
};

export const NFL_SPORT = "NFL" as const;
export const NFL_REGULAR_SEASON = "NFL_REGULAR_SEASON" as const;
export const CFB_SPORT = "CFB" as const;
export const CFB_REGULAR_SEASON = "CFB_REGULAR_SEASON" as const;

export const NFL_RETURN_METRICS = [
  "win",
  "tie",
  "pt_diff",
  "playoff_berth",
  "div_round",
  "conf_round",
  "sb_berth",
  "win_super_bowl",
] as const;

export const NFL_REALIZED_METRICS = [
  "wins",
  "losses",
  "ties",
  "pt_diff",
  "ordinary_wins",
  "marquee_wins",
  "ordinary_ties",
  "marquee_ties",
  "ordinary_pt_diff",
  "marquee_pt_diff",
  "playoff_berth",
  "div_round",
  "conf_round",
  "sb_berth",
  "win_super_bowl",
] as const;

export const NFL_PERIOD_TEMPLATE = [
  { sequence: 0, label: "Week 0", isPlayoff: false },
  ...Array.from({ length: 18 }, (_, index) => ({
    sequence: index + 1,
    label: `Week ${index + 1}`,
    isPlayoff: false,
  })),
  { sequence: 19, label: "Wild Card", isPlayoff: true },
  { sequence: 20, label: "Divisional", isPlayoff: true },
  { sequence: 21, label: "Conference Championship", isPlayoff: true },
  { sequence: 22, label: "Super Bowl", isPlayoff: true },
] as const;

export const CFB_OUTCOME_METRICS = ["win", "loss", "tie", "pt_diff"] as const;

/**
 * CFB period rows currently describe only the provider-backed regular season.
 * Postseason stages belong in the eventual approved adapter, not in guessed
 * defaults.
 */
export const CFB_PERIOD_TEMPLATE = [
  { sequence: 0, label: "Week 0", isPlayoff: false },
  ...Array.from({ length: 15 }, (_, index) => ({
    sequence: index + 1,
    label: `Week ${index + 1}`,
    isPlayoff: false,
  })),
] as const;

export const NFL_STARTING_POINTS = 150;
export const NFL_MARQUEE_MULTIPLIER = 2;
export const NFL_PAYOUT_RULES = [
  { metric: "win", dollarsPerUnit: 10, playoffMultiplier: 1 },
  { metric: "tie", dollarsPerUnit: 5, playoffMultiplier: 1 },
  { metric: "pt_diff", dollarsPerUnit: 1, playoffMultiplier: 1 },
  { metric: "playoff_berth", dollarsPerUnit: 50, playoffMultiplier: 1 },
  { metric: "div_round", dollarsPerUnit: 100, playoffMultiplier: 1 },
  { metric: "conf_round", dollarsPerUnit: 200, playoffMultiplier: 1 },
  { metric: "sb_berth", dollarsPerUnit: 400, playoffMultiplier: 1 },
  { metric: "win_super_bowl", dollarsPerUnit: 800, playoffMultiplier: 1 },
] as const;

function validateGenericRules(
  adapter: CompetitionScoringAdapter,
  rules: readonly ScoringRuleInput[],
): { ok: true; rules: ConfiguredScoringRule[] } | { ok: false; error: string } {
  if (
    adapter.startingPoints == null ||
    !Number.isFinite(adapter.startingPoints)
  ) {
    return { ok: false, error: `${adapter.sport} starting points are not configured.` };
  }
  if (
    adapter.normalizationDenominator == null ||
    !Number.isFinite(adapter.normalizationDenominator) ||
    adapter.normalizationDenominator <= 0
  ) {
    return { ok: false, error: `${adapter.sport} normalization denominator is not configured.` };
  }
  if (rules.length !== adapter.allowedMetrics.length) {
    return {
      ok: false,
      error: `${adapter.sport} scoring rules must include exactly one rule for every allowed metric.`,
    };
  }

  const allowed = new Set(adapter.allowedMetrics);
  const seen = new Set<string>();
  const configured: ConfiguredScoringRule[] = [];
  for (const rule of rules) {
    if (!allowed.has(rule.metric)) {
      return { ok: false, error: `Unsupported ${adapter.sport} scoring metric "${rule.metric}".` };
    }
    if (seen.has(rule.metric)) {
      return { ok: false, error: `${adapter.sport} scoring metric "${rule.metric}" was supplied more than once.` };
    }
    seen.add(rule.metric);
    if (rule.dollarsPerUnit == null || !Number.isFinite(rule.dollarsPerUnit)) {
      return { ok: false, error: `${adapter.sport} ${rule.metric} points per unit are not configured.` };
    }
    const playoffMultiplier = rule.playoffMultiplier ?? 1;
    if (!Number.isFinite(playoffMultiplier) || playoffMultiplier < 0) {
      return { ok: false, error: `${adapter.sport} ${rule.metric} playoff multiplier must be non-negative.` };
    }
    configured.push({
      metric: rule.metric,
      dollarsPerUnit: rule.dollarsPerUnit,
      playoffMultiplier,
    });
  }
  return { ok: true, rules: configured };
}

export function validateCompetitionScoringRules(
  adapter: CompetitionScoringAdapter,
  rules: readonly ScoringRuleInput[],
): { ok: true; rules: ConfiguredScoringRule[] } | { ok: false; error: string } {
  return adapter.validateRules?.(rules) ?? validateGenericRules(adapter, rules);
}

function normalizeFinalEvent(event: CompetitionOutcomeEvent): CompetitionOutcomeEvent {
  if (event.homeTeamId === event.awayTeamId) {
    throw new Error(`${event.source ?? "Provider"} event teams must be different.`);
  }
  if (![event.homeScore, event.awayScore].every((score) => Number.isInteger(score) && score >= 0)) {
    throw new Error(`${event.source ?? "Provider"} final scores must be non-negative integers.`);
  }
  return event;
}

function aggregateScoreOutcomes(
  events: CompetitionOutcomeEvent[],
  metricNames: { wins: string; losses: string; ties: string; pointDifferential: string },
): Map<number, AuditedOutcomeAggregate> {
  const result = new Map<number, AuditedOutcomeAggregate>();
  const ensure = (teamId: number) => {
    const current = result.get(teamId);
    if (current) return current;
    const aggregate: AuditedOutcomeAggregate = {
      metrics: {
        [metricNames.wins]: 0,
        [metricNames.losses]: 0,
        [metricNames.ties]: 0,
        [metricNames.pointDifferential]: 0,
      },
      sourceEvents: [],
    };
    result.set(teamId, aggregate);
    return aggregate;
  };
  const seen = new Set<string>();
  for (const rawEvent of events) {
    if (rawEvent.status && !["final", "completed", "post"].includes(rawEvent.status.toLowerCase())) {
      continue;
    }
    const event = normalizeFinalEvent(rawEvent);
    const identity = `${event.seasonId}:${event.source ?? "manual"}:${event.sourceEventId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const home = ensure(event.homeTeamId);
    const away = ensure(event.awayTeamId);
    home.sourceEvents.push(event);
    away.sourceEvents.push(event);
    const differential = event.homeScore - event.awayScore;
    home.metrics[metricNames.pointDifferential] += differential;
    away.metrics[metricNames.pointDifferential] -= differential;
    if (differential === 0) {
      home.metrics[metricNames.ties] += 1;
      away.metrics[metricNames.ties] += 1;
    } else {
      const winner = differential > 0 ? home : away;
      const loser = differential > 0 ? away : home;
      winner.metrics[metricNames.wins] += 1;
      loser.metrics[metricNames.losses] += 1;
    }
  }
  return result;
}

function easternKickoffParts(value: Date): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(value);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { weekday: read("weekday"), minutes: Number(read("hour")) * 60 + Number(read("minute")) };
}

export function isNflMarqueeKickoff(kickoff: Date | string): boolean {
  const date = kickoff instanceof Date ? kickoff : new Date(kickoff);
  if (!Number.isFinite(date.getTime())) throw new Error("NFL game kickoff must be a valid timestamp.");
  const eastern = easternKickoffParts(date);
  return eastern.weekday !== "Sun" || eastern.minutes < 13 * 60 || eastern.minutes >= 19 * 60;
}

function aggregateNflOutcomes(
  events: CompetitionOutcomeEvent[],
): Map<number, AuditedOutcomeAggregate> {
  const result = new Map<number, AuditedOutcomeAggregate>();
  const ensure = (teamId: number) => {
    const current = result.get(teamId);
    if (current) return current;
    const aggregate: AuditedOutcomeAggregate = {
      metrics: {
        win: 0,
        loss: 0,
        tie: 0,
        pt_diff: 0,
        ordinary_wins: 0,
        marquee_wins: 0,
        ordinary_ties: 0,
        marquee_ties: 0,
        ordinary_pt_diff: 0,
        marquee_pt_diff: 0,
      },
      sourceEvents: [],
    };
    result.set(teamId, aggregate);
    return aggregate;
  };
  const seen = new Set<string>();
  for (const rawEvent of events) {
    if (rawEvent.periodSequence > 18) continue;
    if (rawEvent.status && rawEvent.status.toLowerCase() !== "final") continue;
    const event = normalizeFinalEvent(rawEvent);
    if (event.actualKickoffAt == null) throw new Error("NFL game kickoff must be a valid timestamp.");
    const identity = `${event.seasonId}:${event.source ?? "manual"}:${event.sourceEventId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const marquee = isNflMarqueeKickoff(event.actualKickoffAt);
    const home = ensure(event.homeTeamId);
    const away = ensure(event.awayTeamId);
    home.sourceEvents.push(event);
    away.sourceEvents.push(event);
    const differential = event.homeScore - event.awayScore;
    home.metrics.pt_diff += differential;
    away.metrics.pt_diff -= differential;
    home.metrics[marquee ? "marquee_pt_diff" : "ordinary_pt_diff"] += differential;
    away.metrics[marquee ? "marquee_pt_diff" : "ordinary_pt_diff"] -= differential;
    if (differential === 0) {
      home.metrics.tie += 1;
      away.metrics.tie += 1;
      home.metrics[marquee ? "marquee_ties" : "ordinary_ties"] += 1;
      away.metrics[marquee ? "marquee_ties" : "ordinary_ties"] += 1;
    } else {
      const winner = differential > 0 ? home : away;
      const loser = differential > 0 ? away : home;
      winner.metrics.win += 1;
      loser.metrics.loss += 1;
      winner.metrics[marquee ? "marquee_wins" : "ordinary_wins"] += 1;
    }
  }
  return result;
}

function nflPointMetricValues(metrics: Readonly<Record<string, number>>): Record<string, number> {
  const hasBreakdown = [
    "ordinary_wins",
    "marquee_wins",
    "ordinary_ties",
    "marquee_ties",
    "ordinary_pt_diff",
    "marquee_pt_diff",
  ].some((metric) => (metrics[metric] ?? 0) !== 0);
  return {
    win: hasBreakdown
      ? (metrics.ordinary_wins ?? 0) + NFL_MARQUEE_MULTIPLIER * (metrics.marquee_wins ?? 0)
      : (metrics.win ?? metrics.wins ?? 0),
    tie: hasBreakdown
      ? (metrics.ordinary_ties ?? 0) + NFL_MARQUEE_MULTIPLIER * (metrics.marquee_ties ?? 0)
      : (metrics.tie ?? metrics.ties ?? 0),
    pt_diff: hasBreakdown
      ? (metrics.ordinary_pt_diff ?? 0) + NFL_MARQUEE_MULTIPLIER * (metrics.marquee_pt_diff ?? 0)
      : (metrics.pt_diff ?? 0),
    playoff_berth: metrics.playoff_berth ?? 0,
    div_round: metrics.div_round ?? 0,
    conf_round: metrics.conf_round ?? 0,
    sb_berth: metrics.sb_berth ?? 0,
    win_super_bowl: metrics.win_super_bowl ?? 0,
  };
}

export const NFL_SCORING_ADAPTER: CompetitionScoringAdapter = {
  sport: NFL_SPORT,
  competitionFormat: NFL_REGULAR_SEASON,
  allowedMetrics: NFL_RETURN_METRICS,
  realizedMetrics: NFL_REALIZED_METRICS,
  mtmMetrics: NFL_RETURN_METRICS,
  periods: NFL_PERIOD_TEMPLATE,
  startingPoints: NFL_STARTING_POINTS,
  normalizationDenominator: LEAGUE_POINT_TOTAL,
  defaultRules: NFL_PAYOUT_RULES,
  requiredSnapshotMetrics(basis, period) {
    if (basis === "mtm") return NFL_RETURN_METRICS;
    return period.isPlayoff
      ? NFL_REALIZED_METRICS
      : NFL_REALIZED_METRICS.slice(0, 10);
  },
  aggregateOutcomes: aggregateNflOutcomes,
  pointMetricValues: nflPointMetricValues,
  validateRules(rules) {
    const generic = validateGenericRules(NFL_SCORING_ADAPTER, rules);
    if (!generic.ok) return generic;
    const expected = new Map(NFL_PAYOUT_RULES.map((rule) => [rule.metric, rule]));
    for (const rule of generic.rules) {
      const target = expected.get(rule.metric as (typeof NFL_PAYOUT_RULES)[number]["metric"]);
      if (!target || rule.dollarsPerUnit !== target.dollarsPerUnit) {
        return {
          ok: false,
          error: `NFL ${rule.metric} must be worth ${target?.dollarsPerUnit ?? "an approved number of"} points per unit.`,
        };
      }
      if (rule.playoffMultiplier !== 1) {
        return { ok: false, error: "NFL playoff multipliers must be 1; marquee game weighting is applied separately." };
      }
    }
    return generic;
  },
};

export const CFB_SCORING_ADAPTER: CompetitionScoringAdapter = {
  sport: CFB_SPORT,
  competitionFormat: CFB_REGULAR_SEASON,
  allowedMetrics: CFB_OUTCOME_METRICS,
  realizedMetrics: CFB_OUTCOME_METRICS,
  mtmMetrics: CFB_OUTCOME_METRICS,
  periods: CFB_PERIOD_TEMPLATE,
  startingPoints: null,
  normalizationDenominator: null,
  defaultRules: null,
  requiredSnapshotMetrics() {
    return CFB_OUTCOME_METRICS;
  },
  aggregateOutcomes(events) {
    return aggregateScoreOutcomes(events, {
      wins: "win",
      losses: "loss",
      ties: "tie",
      pointDifferential: "pt_diff",
    });
  },
  pointMetricValues(metrics) {
    return Object.fromEntries(CFB_OUTCOME_METRICS.map((metric) => [metric, metrics[metric] ?? 0]));
  },
};

export function createCompetitionScoringAdapter(
  adapter: CompetitionScoringAdapter,
): CompetitionScoringAdapter {
  return {
    ...adapter,
    allowedMetrics: [...adapter.allowedMetrics],
    realizedMetrics: [...adapter.realizedMetrics],
    mtmMetrics: [...adapter.mtmMetrics],
    periods: adapter.periods.map((period) => ({ ...period })),
    defaultRules: adapter.defaultRules?.map((rule) => ({ ...rule })) ?? null,
  };
}

export function configureCompetitionScoringAdapter(
  adapter: CompetitionScoringAdapter,
  rules: ReadonlyArray<{
    ruleName: string;
    value: number | null;
    active?: boolean;
  }>,
): CompetitionScoringAdapter {
  const active = new Map(
    rules
      .filter((rule) => rule.active !== false)
      .map((rule) => [rule.ruleName, rule.value]),
  );
  const startingPoints =
    active.get("starting_points") ??
    active.get("banked") ??
    adapter.startingPoints;
  const normalizationDenominator =
    active.get("normalization_denominator") ??
    adapter.normalizationDenominator;
  return createCompetitionScoringAdapter({
    ...adapter,
    startingPoints,
    normalizationDenominator,
  });
}

export function getCompetitionScoringAdapter(
  sport: string,
  competitionFormat?: string,
): CompetitionScoringAdapter | undefined {
  const adapter = sport === NFL_SPORT
    ? NFL_SCORING_ADAPTER
    : sport === CFB_SPORT
      ? CFB_SCORING_ADAPTER
      : undefined;
  return adapter && (!competitionFormat || adapter.competitionFormat === competitionFormat)
    ? adapter
    : undefined;
}

function calculatePointsUnchecked(
  adapter: CompetitionScoringAdapter,
  metrics: Readonly<Record<string, number>>,
  rules: readonly ConfiguredScoringRule[],
): { points: number; breakdown: Record<string, number> } {
  const values = adapter.pointMetricValues(metrics);
  const breakdown: Record<string, number> = {
    startingPoints: adapter.startingPoints ?? 0,
  };
  for (const rule of rules) {
    const value = values[rule.metric];
    if (!Number.isFinite(value)) {
      throw new Error(`${adapter.sport} normalized metric "${rule.metric}" is missing or invalid.`);
    }
    breakdown[rule.metric] = value * rule.dollarsPerUnit;
  }
  return {
    points: Object.values(breakdown).reduce((total, value) => total + value, 0),
    breakdown,
  };
}

export function calculateCompetitionPoints(
  adapter: CompetitionScoringAdapter,
  metrics: Readonly<Record<string, number>>,
  rules: readonly ScoringRuleInput[],
): { points: number; breakdown: Record<string, number> } {
  const validation = validateCompetitionScoringRules(adapter, rules);
  if (!validation.ok) throw new Error(validation.error);
  return calculatePointsUnchecked(adapter, metrics, validation.rules);
}

export function calculateCompetitionTeamValues(
  adapter: CompetitionScoringAdapter,
  entries: Array<{ teamId: number; metrics: Readonly<Record<string, number>>; cost?: number }>,
  potSize: number,
  rules: readonly ScoringRuleInput[],
): ScoredCompetitionEntry[] {
  if (!Number.isFinite(potSize) || potSize < 0) {
    throw new Error("Calcutta pot size must be a non-negative number.");
  }
  const validation = validateCompetitionScoringRules(adapter, rules);
  if (!validation.ok) throw new Error(validation.error);
  const denominator = adapter.normalizationDenominator!;
  return entries.map((entry) => {
    const scored = calculatePointsUnchecked(adapter, entry.metrics, validation.rules);
    const normalizedShare = scored.points / denominator;
    const fairValue = normalizedShare * potSize;
    const cost = entry.cost ?? 0;
    return {
      teamId: entry.teamId,
      points: scored.points,
      pointsBreakdown: scored.breakdown,
      normalizedShare,
      fairValue,
      grossReturn: fairValue,
      netReturn: fairValue - cost,
      multiple: cost > 0 ? fairValue / cost : 0,
    };
  });
}

export function calculateCompetitionValuesFromEvents(
  adapter: CompetitionScoringAdapter,
  events: CompetitionOutcomeEvent[],
  entries: Array<{ teamId: number; cost?: number }>,
  potSize: number,
  rules: readonly ScoringRuleInput[],
): { outcomes: Map<number, AuditedOutcomeAggregate>; values: ScoredCompetitionEntry[] } {
  const outcomes = adapter.aggregateOutcomes(events);
  const values = calculateCompetitionTeamValues(
    adapter,
    entries.map((entry) => ({
      ...entry,
      metrics: outcomes.get(entry.teamId)?.metrics ?? {},
    })),
    potSize,
    rules,
  );
  return { outcomes, values };
}