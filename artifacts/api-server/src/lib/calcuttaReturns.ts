import { and, asc, eq, lte, sql } from "drizzle-orm";
import {
  calcuttasTable,
  calcuttaEntriesTable,
  calcuttaRulesTable,
  db,
  mtmSnapshotsTable,
  payoutRulesTable,
  positionsTable,
  seasonsTable,
  snapshotMetricsTable,
  sportPeriodsTable,
  teamPeriodSnapshotsTable,
  teamResultsTable,
} from "@workspace/db";
import {
  calculateCompetitionTeamValues,
  configureCompetitionScoringAdapter,
  type CompetitionScoringAdapter,
  NFL_MARQUEE_MULTIPLIER,
  NFL_PAYOUT_RULES,
  NFL_PERIOD_TEMPLATE,
  NFL_RETURN_METRICS,
  NFL_SCORING_ADAPTER,
  NFL_SPORT,
  NFL_STARTING_POINTS,
  getCompetitionScoringAdapter,
  isNflMarqueeKickoff,
  validateCompetitionScoringRules,
} from "./competitionScoring";

export {
  NFL_MARQUEE_MULTIPLIER,
  NFL_PAYOUT_RULES,
  NFL_PERIOD_TEMPLATE,
  NFL_SPORT,
  NFL_STARTING_POINTS,
  isNflMarqueeKickoff,
} from "./competitionScoring";

function calcuttaAsOfDate(year: number): string | undefined {
  return year >= 1 && year <= 9999 ? `${year}-08-01` : undefined;
}
export const RETURN_METRICS = NFL_RETURN_METRICS;
export type ReturnMetric = (typeof RETURN_METRICS)[number];
export type SnapshotBasis = "realized" | "mtm";
export type PlayoffStatus = "unknown" | "alive" | "clinched" | "eliminated";

export function validateNflPayoutRules(
  rules: Array<{ metric: string; dollarsPerUnit: number | null; playoffMultiplier?: number | null }>,
): { ok: true } | { ok: false; error: string } {
  const validation = validateCompetitionScoringRules(NFL_SCORING_ADAPTER, rules);
  return validation.ok ? { ok: true } : validation;
}

export type SnapshotMetrics = {
  wins: number;
  losses: number;
  ties: number;
  ptDiff: number;
  playoffBerth: number;
  divRound: number;
  confRound: number;
  sbBerth: number;
  winSuperBowl: number;
  ordinaryWins?: number;
  marqueeWins?: number;
  ordinaryTies?: number;
  marqueeTies?: number;
  ordinaryPtDiff?: number;
  marqueePtDiff?: number;
};

export type SnapshotState = SnapshotMetrics & {
  sequence: number;
  label: string;
  isPlayoff: boolean;
  playoffStatus: PlayoffStatus;
  marketStatus: "live" | "stale" | null;
  marketStatusReasons: string[];
  metrics?: Record<string, number>;
};

export type CompetitionSnapshotState = {
  sequence: number;
  label: string;
  isPlayoff: boolean;
  playoffStatus: PlayoffStatus;
  marketStatus: "live" | "stale" | null;
  marketStatusReasons: string[];
  metrics: Record<string, number>;
};

export const REALIZED_GAME_METRICS = [
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
] as const;

export const REALIZED_PLAYOFF_METRICS = [
  "playoff_berth",
  "div_round",
  "conf_round",
  "sb_berth",
  "win_super_bowl",
] as const;

export type NormalizedMetricSnapshotRow = {
  entryId: number;
  teamId: number;
  basis: string;
  sequence: number;
  label: string;
  isPlayoff: boolean;
  metric: string;
  value: string | number;
  sourceData?: Record<string, unknown> | null;
};

export type NormalizedSnapshotWrite = {
  wins: number;
  losses: number;
  ties: number;
  ptDiff: number;
  ordinaryWins: number;
  marqueeWins: number;
  ordinaryTies: number;
  marqueeTies: number;
  ordinaryPtDiff: number;
  marqueePtDiff: number;
  playoffBerth: number;
  divRound: number;
  confRound: number;
  sbBerth: number;
  winSuperBowl: number;
  playoffStatus: PlayoffStatus;
};

export function normalizedMetricValues(
  basis: SnapshotBasis,
  snapshot: NormalizedSnapshotWrite,
): Array<{ metric: string; value: string }> {
  const byMetric: Record<string, number> = {
    win: snapshot.wins,
    tie: snapshot.ties,
    wins: snapshot.wins,
    losses: snapshot.losses,
    ties: snapshot.ties,
    pt_diff: snapshot.ptDiff,
    ordinary_wins: snapshot.ordinaryWins,
    marquee_wins: snapshot.marqueeWins,
    ordinary_ties: snapshot.ordinaryTies,
    marquee_ties: snapshot.marqueeTies,
    ordinary_pt_diff: snapshot.ordinaryPtDiff,
    marquee_pt_diff: snapshot.marqueePtDiff,
    playoff_berth: snapshot.playoffBerth,
    div_round: snapshot.divRound,
    conf_round: snapshot.confRound,
    sb_berth: snapshot.sbBerth,
    win_super_bowl: snapshot.winSuperBowl,
  };
  const metrics = basis === "mtm"
    ? RETURN_METRICS
    : [...REALIZED_GAME_METRICS, ...REALIZED_PLAYOFF_METRICS];
  return metrics.map((metric) => ({
    metric,
    value: String(byMetric[metric]),
  }));
}

type MetricWriter = Pick<typeof db, "insert">;

export async function upsertNormalizedSnapshotMetrics(
  writer: MetricWriter,
  args: {
    calcuttaId: number;
    entryId: number;
    periodId: number;
    basis: SnapshotBasis;
    snapshot: NormalizedSnapshotWrite;
    source: string;
    sourceData?: Record<string, unknown>;
    snapshotAt: Date;
  },
): Promise<void> {
  for (const metric of normalizedMetricValues(args.basis, args.snapshot)) {
    const row = {
      calcuttaId: args.calcuttaId,
      entryId: args.entryId,
      periodId: args.periodId,
      basis: args.basis,
      ...metric,
      source: args.source,
      sourceData: {
        ...args.sourceData,
        playoffStatus: args.snapshot.playoffStatus,
      },
      snapshotAt: args.snapshotAt,
    };
    await writer.insert(snapshotMetricsTable).values(row).onConflictDoUpdate({
      target: [
        snapshotMetricsTable.calcuttaId,
        snapshotMetricsTable.entryId,
        snapshotMetricsTable.periodId,
        snapshotMetricsTable.basis,
        snapshotMetricsTable.metric,
      ],
      targetWhere: sql`${snapshotMetricsTable.entryId} is not null`,
      set: row,
    });
  }
}

type MetricReader = Pick<typeof db, "select">;

export async function hasCompleteNormalizedSnapshot(
  reader: MetricReader,
  args: {
    calcuttaId: number;
    entryId: number;
    basis: SnapshotBasis;
    periodSequence: number;
    adapter?: CompetitionScoringAdapter;
  },
): Promise<boolean> {
  const adapter = args.adapter ?? NFL_SCORING_ADAPTER;
  const rows = await reader
    .select({ metric: snapshotMetricsTable.metric })
    .from(snapshotMetricsTable)
    .innerJoin(
      sportPeriodsTable,
      eq(sportPeriodsTable.id, snapshotMetricsTable.periodId),
    )
    .where(and(
      eq(snapshotMetricsTable.calcuttaId, args.calcuttaId),
      eq(snapshotMetricsTable.entryId, args.entryId),
      eq(snapshotMetricsTable.basis, args.basis),
      eq(sportPeriodsTable.sport, adapter.sport),
      eq(sportPeriodsTable.competition, adapter.competitionFormat),
      eq(sportPeriodsTable.sequence, args.periodSequence),
    ));
  const present = new Set(rows.map((row) => row.metric));
  const period = adapter.periods.find((candidate) =>
    candidate.sequence === args.periodSequence
  );
  if (!period) return false;
  const required = adapter.requiredSnapshotMetrics(args.basis, period);
  return required.every((metric) => present.has(metric));
}

function readPlayoffStatus(
  rows: NormalizedMetricSnapshotRow[],
): PlayoffStatus {
  const status = rows
    .map((row) => row.sourceData?.["playoffStatus"])
    .find((value) => typeof value === "string");
  return status === "alive" ||
    status === "clinched" ||
    status === "eliminated"
    ? status
    : "unknown";
}

function readMarketStatus(
  rows: NormalizedMetricSnapshotRow[],
): { marketStatus: "live" | "stale" | null; marketStatusReasons: string[] } {
  const statuses = rows
    .map((row) => row.sourceData?.["marketStatus"])
    .filter((value): value is "live" | "stale" =>
      value === "live" || value === "stale"
    );
  const marketStatus = statuses.includes("stale")
    ? "stale"
    : statuses.includes("live")
      ? "live"
      : null;
  const marketStatusReasons = [...new Set(rows.flatMap((row) => {
    const reasons = row.sourceData?.["marketStatusReasons"];
    return Array.isArray(reasons)
      ? reasons.filter((reason): reason is string => typeof reason === "string")
      : [];
  }))];
  return { marketStatus, marketStatusReasons };
}

/**
 * Converts the basis-specific normalized metric vocabularies into complete
 * cumulative calculation snapshots. A partial metric set is omitted rather
 * than zero-filled so callers can expose non-authoritative coverage.
 */
export function buildSnapshotStatesFromMetricRows(
  rows: NormalizedMetricSnapshotRow[],
): Map<number, Map<SnapshotBasis, SnapshotState[]>> {
  const generic = buildCompetitionSnapshotStatesFromMetricRows(rows, NFL_SCORING_ADAPTER);
  const grouped = new Map<number, Map<SnapshotBasis, SnapshotState[]>>();
  for (const [teamId, byBasis] of generic) {
    const converted = new Map<SnapshotBasis, SnapshotState[]>();
    for (const [basis, snapshots] of byBasis) {
      converted.set(basis, snapshots.map((snapshot) =>
        competitionSnapshotToCompatibilityState(snapshot, basis)
      ));
    }
    grouped.set(teamId, converted);
  }
  return grouped;
}

export function buildCompetitionSnapshotStatesFromMetricRows(
  rows: NormalizedMetricSnapshotRow[],
  adapter: CompetitionScoringAdapter,
): Map<number, Map<SnapshotBasis, CompetitionSnapshotState[]>> {
  const groups = new Map<string, NormalizedMetricSnapshotRow[]>();
  for (const row of rows) {
    if (row.basis !== "realized" && row.basis !== "mtm") continue;
    const key = `${row.entryId}:${row.basis}:${row.sequence}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const grouped = new Map<number, Map<SnapshotBasis, CompetitionSnapshotState[]>>();
  for (const metricRows of groups.values()) {
    const first = metricRows[0];
    const basis = first.basis as SnapshotBasis;
    const values = new Map<string, number>();
    let valid = true;
    for (const row of metricRows) {
      const value = Number(row.value);
      if (!Number.isFinite(value)) {
        valid = false;
        break;
      }
      values.set(row.metric, value);
    }
    const required = adapter.requiredSnapshotMetrics(basis, first);
    if (!valid || required.some((metric) => !values.has(metric))) continue;

    const snapshot: CompetitionSnapshotState = {
      sequence: first.sequence,
      label: first.label,
      isPlayoff: first.isPlayoff,
      playoffStatus: readPlayoffStatus(metricRows),
      ...readMarketStatus(metricRows),
      metrics: Object.fromEntries(values),
    };
    const byBasis = grouped.get(first.teamId) ??
      new Map<SnapshotBasis, CompetitionSnapshotState[]>();
    const snapshots = byBasis.get(basis) ?? [];
    snapshots.push(snapshot);
    byBasis.set(basis, snapshots);
    grouped.set(first.teamId, byBasis);
  }
  for (const byBasis of grouped.values()) {
    for (const snapshots of byBasis.values()) {
      snapshots.sort((left, right) => left.sequence - right.sequence);
    }
  }
  return grouped;
}

function competitionSnapshotToCompatibilityState(
  snapshot: CompetitionSnapshotState,
  basis: SnapshotBasis,
): SnapshotState {
  const values = snapshot.metrics;
  return {
    ...snapshot,
    wins: values[basis === "mtm" ? "win" : "wins"] ?? values.win ?? 0,
    losses: values.losses ?? values.loss ?? 0,
    ties: values[basis === "mtm" ? "tie" : "ties"] ?? values.tie ?? 0,
    ptDiff: values.pt_diff ?? 0,
    playoffBerth: values.playoff_berth ?? 0,
    divRound: values.div_round ?? 0,
    confRound: values.conf_round ?? 0,
    sbBerth: values.sb_berth ?? 0,
    winSuperBowl: values.win_super_bowl ?? 0,
    ...(basis === "realized" && adapterHasNflBreakdown(values)
      ? {
          ordinaryWins: values.ordinary_wins,
          marqueeWins: values.marquee_wins,
          ordinaryTies: values.ordinary_ties,
          marqueeTies: values.marquee_ties,
          ordinaryPtDiff: values.ordinary_pt_diff,
          marqueePtDiff: values.marquee_pt_diff,
        }
      : {}),
  };
}

function adapterHasNflBreakdown(values: Record<string, number>): boolean {
  return [
    "ordinary_wins",
    "marquee_wins",
    "ordinary_ties",
    "marquee_ties",
    "ordinary_pt_diff",
    "marquee_pt_diff",
  ].every((metric) => values[metric] != null);
}

type RuleValue = {
  metric: ReturnMetric;
  dollarsPerUnit: number;
  playoffMultiplier: number;
};

const emptyMetrics = (): SnapshotMetrics => ({
  wins: 0,
  losses: 0,
  ties: 0,
  ptDiff: 0,
  playoffBerth: 0,
  divRound: 0,
  confRound: 0,
  sbBerth: 0,
  winSuperBowl: 0,
});

export type NflGameInput = {
  seasonId: number;
  source?: string;
  sourceGameId: string;
  periodSequence: number;
  round?: string;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number;
  awayScore: number;
  actualKickoffAt: Date | string;
  status?: string;
  sourceData?: Record<string, unknown> | null;
};

export type NormalizedNflGame = NflGameInput & {
  actualKickoffAt: Date;
  isMarquee: boolean;
  marqueeMultiplier: number;
};

export function normalizeNflGame(input: NflGameInput): NormalizedNflGame {
  const actualKickoffAt = input.actualKickoffAt instanceof Date
    ? input.actualKickoffAt
    : new Date(input.actualKickoffAt);
  if (!Number.isFinite(actualKickoffAt.getTime())) throw new Error("NFL game kickoff must be a valid timestamp.");
  if (input.homeTeamId === input.awayTeamId) throw new Error("NFL game teams must be different.");
  if (![input.homeScore, input.awayScore].every((score) => Number.isInteger(score) && score >= 0)) {
    throw new Error("NFL final scores must be non-negative integers.");
  }
  const isMarquee = isNflMarqueeKickoff(actualKickoffAt);
  return {
    ...input,
    actualKickoffAt,
    isMarquee,
    marqueeMultiplier: isMarquee ? NFL_MARQUEE_MULTIPLIER : 1,
  };
}

export type NflGameAggregate = {
  wins: number;
  losses: number;
  ties: number;
  ptDiff: number;
  ordinaryWins: number;
  marqueeWins: number;
  ordinaryTies: number;
  marqueeTies: number;
  ordinaryPtDiff: number;
  marqueePtDiff: number;
  games: NormalizedNflGame[];
};

/**
 * Aggregates final regular-season games without treating a repeat scrape as a
 * second game. Marquee fields retain raw game results; scoring applies 2x.
 */
export function aggregateNflRegularSeasonGames(games: NflGameInput[]): Map<number, NflGameAggregate> {
  const aggregates = new Map<number, NflGameAggregate>();
  const ensure = (teamId: number) => {
    const current = aggregates.get(teamId);
    if (current) return current;
    const next: NflGameAggregate = {
      wins: 0, losses: 0, ties: 0, ptDiff: 0,
      ordinaryWins: 0, marqueeWins: 0, ordinaryTies: 0, marqueeTies: 0,
      ordinaryPtDiff: 0, marqueePtDiff: 0, games: [],
    };
    aggregates.set(teamId, next);
    return next;
  };
  const seen = new Set<string>();
  for (const input of games) {
    const game = normalizeNflGame(input);
    if ((game.round ?? "regular") !== "regular" || game.periodSequence > 18) continue;
    const identity = `${game.seasonId}:${game.source ?? "manual"}:${game.sourceGameId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const home = ensure(game.homeTeamId);
    const away = ensure(game.awayTeamId);
    const diff = game.homeScore - game.awayScore;
    home.games.push(game); away.games.push(game);
    if (game.isMarquee) {
      home.marqueePtDiff += diff; away.marqueePtDiff -= diff;
    } else {
      home.ordinaryPtDiff += diff; away.ordinaryPtDiff -= diff;
    }
    home.ptDiff += diff; away.ptDiff -= diff;
    if (diff === 0) {
      home.ties++; away.ties++;
      if (game.isMarquee) { home.marqueeTies++; away.marqueeTies++; }
      else { home.ordinaryTies++; away.ordinaryTies++; }
    } else {
      const winner = diff > 0 ? home : away;
      const loser = diff > 0 ? away : home;
      winner.wins++; loser.losses++;
      if (game.isMarquee) winner.marqueeWins++;
      else winner.ordinaryWins++;
    }
  }
  return aggregates;
}

function metricValue(metrics: SnapshotMetrics, metric: ReturnMetric): number {
  switch (metric) {
    case "win":
      return metrics.wins;
    case "tie":
      return metrics.ties;
    case "pt_diff":
      return metrics.ptDiff;
    case "playoff_berth":
      return metrics.playoffBerth;
    case "div_round":
      return metrics.divRound;
    case "conf_round":
      return metrics.confRound;
    case "sb_berth":
      return metrics.sbBerth;
    case "win_super_bowl":
      return metrics.winSuperBowl;
  }
}

/**
 * Snapshots are cumulative through their period. The return engine only pays
 * each delta once, so writing a new period cannot re-award earlier wins or
 * milestones. A period's playoff flag applies the rule's multiplier to the
 * delta earned in that period, but only after a Week 18 baseline exists.
 * This defensive fallback prevents a sparse first playoff snapshot from
 * incorrectly multiplying the team's entire cumulative regular-season record.
 */
export function calculateReturnFromSnapshots(
  snapshots: SnapshotState[],
  rules: RuleValue[],
): number {
  const prior = emptyMetrics();
  let gross = 0;
  let hasWeekEighteenBaseline = false;
  const ordered = [...snapshots].sort((a, b) => a.sequence - b.sequence);

  for (const snapshot of ordered) {
    for (const rule of rules) {
      const current = metricValue(snapshot, rule.metric);
      const previous = metricValue(prior, rule.metric);
      const periodMultiplier =
        snapshot.isPlayoff && hasWeekEighteenBaseline
          ? rule.playoffMultiplier
          : 1;
      gross += (current - previous) * rule.dollarsPerUnit * periodMultiplier;
    }
    if (!snapshot.isPlayoff && snapshot.sequence === 18) {
      hasWeekEighteenBaseline = true;
    }
    Object.assign(prior, snapshot);
  }

  return Math.round(gross * 100) / 100;
}

export type TeamPointsBreakdown = {
  startingPoints: number;
  wins: number;
  ties: number;
  ptDiff: number;
  playoffBerth: number;
  divRound: number;
  confRound: number;
  sbBerth: number;
  winSuperBowl: number;
};

export type CalculatedTeamValue = {
  teamId: number;
  points: number;
  pointsBreakdown: TeamPointsBreakdown;
  normalizedShare: number;
  fairValue: number;
  grossReturn: number;
  netReturn: number;
  multiple: number;
};

export type HistoricalParityDiagnostic = {
  isAuthoritative: boolean;
  coverage: { expectedTeams: number; calculatedTeams: number };
  mismatches: Array<{ teamId: number; legacyGrossReturn: number; calculatedGrossReturn: number; difference: number }>;
  message: string | null;
};

export function compareHistoricalPayoutParity(
  expectedTeams: number,
  legacyReturns: Array<{ teamId: number; grossReturn: number }>,
  calculated: Map<number, CalculatedTeamReturns>,
  tolerance = 0.01,
): HistoricalParityDiagnostic {
  const mismatches = legacyReturns.flatMap((legacy) => {
    const current = calculated.get(legacy.teamId)?.realized?.grossReturn;
    if (current == null || Math.abs(current - legacy.grossReturn) <= tolerance) return [];
    return [{
      teamId: legacy.teamId,
      legacyGrossReturn: legacy.grossReturn,
      calculatedGrossReturn: current,
      difference: current - legacy.grossReturn,
    }];
  });
  const calculatedTeams = [...calculated.values()].filter((entry) => entry.realized).length;
  const coverageComplete = expectedTeams > 0 && calculatedTeams === expectedTeams;
  const message = !coverageComplete
    ? `Incomplete realized snapshot coverage: ${calculatedTeams} of ${expectedTeams} auctioned teams are calculable.`
    : mismatches.length
      ? `${mismatches.length} historical payout mismatch${mismatches.length === 1 ? "" : "es"} require review.`
      : null;
  return {
    isAuthoritative: coverageComplete && mismatches.length === 0,
    coverage: { expectedTeams, calculatedTeams },
    mismatches,
    message,
  };
}

/**
 * Comparison-only migration diagnostic for the five deprecated entry economics
 * columns. Stored values are deliberately never supplied to the calculator.
 * Callers should treat `ok: false` as a review gate, not a runtime fallback.
 */
export type EntryReturnDiscrepancyAudit = {
  ok: boolean;
  calcuttaId: number;
  auditedEntries: number;
  issues: Array<{
    entryId: number;
    teamId: number;
    kind: "missing_calculation_input" | "ambiguous_cost_basis" | "partial_coverage" | "mismatch";
    field?: "realizedReturn" | "realizedMultiple" | "netReturn" | "netPctReturn" | "markToMarket";
    stored?: number;
    calculated?: number;
    message: string;
  }>;
};

export async function auditStoredEntryReturnDiscrepancies(
  calcuttaId: number,
  tolerance = 0.01,
): Promise<EntryReturnDiscrepancyAudit> {
  const entries = await db
    .select({
      entryId: calcuttaEntriesTable.id,
      teamId: calcuttaEntriesTable.teamId,
      realizedReturn: calcuttaEntriesTable.realizedReturn,
      realizedMultiple: calcuttaEntriesTable.realizedMultiple,
      netReturn: calcuttaEntriesTable.netReturn,
      netPctReturn: calcuttaEntriesTable.netPctReturn,
      markToMarket: calcuttaEntriesTable.markToMarket,
    })
    .from(calcuttaEntriesTable)
    .where(eq(calcuttaEntriesTable.calcuttaId, calcuttaId));
  const primaryPositions = await db
    .select({
      entryId: positionsTable.entryId,
      costBasis: positionsTable.costBasis,
    })
    .from(positionsTable)
    .innerJoin(calcuttaEntriesTable, eq(calcuttaEntriesTable.id, positionsTable.entryId))
    .where(and(
      eq(calcuttaEntriesTable.calcuttaId, calcuttaId),
      eq(positionsTable.source, "primary"),
    ));
  const costRows = new Map<number, number[]>();
  for (const position of primaryPositions) {
    const costs = costRows.get(position.entryId) ?? [];
    costs.push(Number(position.costBasis));
    costRows.set(position.entryId, costs);
  }
  const rulesConfigured = await hasConfiguredPayoutRulesForCalcutta(calcuttaId);
  const calculated = rulesConfigured
    ? await loadCalculatedTeamReturnsForCalcutta(calcuttaId, undefined, false)
    : new Map<number, CalculatedTeamReturns>();
  const issues: EntryReturnDiscrepancyAudit["issues"] = [];
  for (const entry of entries) {
    if (!rulesConfigured) {
      issues.push({
        entryId: entry.entryId, teamId: entry.teamId, kind: "missing_calculation_input",
        message: "A complete payout-rule configuration is required for comparison.",
      });
      continue;
    }
    const costs = costRows.get(entry.entryId) ?? [];
    if (!costs.length) {
      issues.push({
        entryId: entry.entryId, teamId: entry.teamId, kind: "missing_calculation_input",
        message: "No primary position supplies this entry's cost basis.",
      });
      continue;
    }
    if (costs.some((cost) => !Number.isFinite(cost))) {
      issues.push({
        entryId: entry.entryId, teamId: entry.teamId, kind: "ambiguous_cost_basis",
        message: "Primary position cost basis is not finite.",
      });
      continue;
    }
    const returns = calculated.get(entry.teamId);
    if (!returns?.realized) {
      issues.push({
        entryId: entry.entryId, teamId: entry.teamId, kind: "partial_coverage",
        field: "realizedReturn",
        message: "Realized normalized calculation snapshots are required for comparison.",
      });
      issues.push({
        entryId: entry.entryId, teamId: entry.teamId, kind: "partial_coverage",
        field: "realizedMultiple",
        message: "Realized normalized calculation snapshots are required for comparison.",
      });
      issues.push({
        entryId: entry.entryId, teamId: entry.teamId, kind: "partial_coverage",
        field: "netReturn",
        message: "Realized normalized calculation snapshots are required for comparison.",
      });
      issues.push({
        entryId: entry.entryId, teamId: entry.teamId, kind: "partial_coverage",
        field: "netPctReturn",
        message: "Realized normalized calculation snapshots are required for comparison.",
      });
    }
    const cost = costs.reduce((sum, value) => sum + value, 0);
    const expected: Partial<Record<NonNullable<EntryReturnDiscrepancyAudit["issues"][number]["field"]>, number>> = {
      ...(returns?.realized ? {
        realizedReturn: returns.realized.grossReturn,
        realizedMultiple: cost > 0 ? returns.realized.grossReturn / cost : 0,
        netReturn: returns.realized.grossReturn - cost,
        netPctReturn: cost > 0 ? (returns.realized.grossReturn - cost) / cost : 0,
      } : {}),
      ...(returns?.mtm ? { markToMarket: returns.mtm.grossReturn } : {}),
    };
    if (!returns?.mtm) {
      issues.push({
        entryId: entry.entryId, teamId: entry.teamId, kind: "partial_coverage",
        field: "markToMarket",
        message: "MTM normalized calculation snapshots are required for comparison.",
      });
    }
    for (const field of Object.keys(expected) as Array<keyof typeof expected>) {
      const stored = Number(entry[field]);
      const value = expected[field]!;
      if (!Number.isFinite(stored) || Math.abs(stored - value) > tolerance) {
        issues.push({
          entryId: entry.entryId, teamId: entry.teamId, kind: "mismatch", field,
          stored, calculated: value,
          message: `Stored ${field} differs from its calculated entry-scoped value.`,
        });
      }
    }
  }
  return { ok: issues.length === 0, calcuttaId, auditedEntries: entries.length, issues };
}

function ruleAmount(rules: RuleValue[], metric: ReturnMetric): number {
  return rules.find((rule) => rule.metric === metric)?.dollarsPerUnit ?? 0;
}

/**
 * Scores the cumulative state. It deliberately does not use
 * `playoffMultiplier`: that legacy period multiplier is a different concept
 * from the confirmed game-level marquee rule and cannot be applied twice.
 */
export function calculateNflPoints(
  snapshot: SnapshotMetrics,
  rules: RuleValue[] = NFL_PAYOUT_RULES as unknown as RuleValue[],
): { points: number; breakdown: TeamPointsBreakdown } {
  const hasGameBreakdown = [
    snapshot.ordinaryWins, snapshot.marqueeWins, snapshot.ordinaryTies,
    snapshot.marqueeTies, snapshot.ordinaryPtDiff, snapshot.marqueePtDiff,
  ].some((value) => value != null && value !== 0);
  const weightedWins = hasGameBreakdown
    ? (snapshot.ordinaryWins ?? 0) + (snapshot.marqueeWins ?? 0)
    : snapshot.wins;
  const weightedTies = hasGameBreakdown
    ? (snapshot.ordinaryTies ?? 0) + (snapshot.marqueeTies ?? 0)
    : snapshot.ties;
  const weightedPtDiff = hasGameBreakdown
    ? (snapshot.ordinaryPtDiff ?? 0) + NFL_MARQUEE_MULTIPLIER * (snapshot.marqueePtDiff ?? 0)
    : snapshot.ptDiff;
  const breakdown: TeamPointsBreakdown = {
    startingPoints: NFL_STARTING_POINTS,
    wins: weightedWins * ruleAmount(rules, "win"),
    ties: weightedTies * ruleAmount(rules, "tie"),
    ptDiff: weightedPtDiff * ruleAmount(rules, "pt_diff"),
    playoffBerth: snapshot.playoffBerth * ruleAmount(rules, "playoff_berth"),
    divRound: snapshot.divRound * ruleAmount(rules, "div_round"),
    confRound: snapshot.confRound * ruleAmount(rules, "conf_round"),
    sbBerth: snapshot.sbBerth * ruleAmount(rules, "sb_berth"),
    winSuperBowl: snapshot.winSuperBowl * ruleAmount(rules, "win_super_bowl"),
  };
  const points = Object.values(breakdown).reduce((total, value) => total + value, 0);
  return { points, breakdown };
}

export function calculateNflTeamValues(
  entries: Array<{ teamId: number; snapshot: SnapshotMetrics; cost?: number }>,
  potSize: number,
  rules: RuleValue[] = NFL_PAYOUT_RULES as unknown as RuleValue[],
): CalculatedTeamValue[] {
  if (!Number.isFinite(potSize) || potSize < 0) throw new Error("Calcutta pot size must be a non-negative number.");
  const scored = entries.map((entry) => ({ ...entry, ...calculateNflPoints(entry.snapshot, rules) }));
  return scored.map((entry) => {
    // Returns accrue against the league's complete season scorecard rather
    // than being renormalized to the points earned so far. Until the season is
    // complete, the total displayed gross can therefore be below the full pot.
    const normalizedShare = entry.points / NFL_SCORING_ADAPTER.normalizationDenominator!;
    const fairValue = normalizedShare * potSize;
    const cost = entry.cost ?? 0;
    return {
      teamId: entry.teamId,
      points: entry.points,
      pointsBreakdown: entry.breakdown,
      normalizedShare,
      fairValue,
      grossReturn: fairValue,
      netReturn: fairValue - cost,
      multiple: cost > 0 ? fairValue / cost : 0,
    };
  });
}

type CalcuttaWriter = Pick<typeof db, "insert" | "select" | "selectDistinct">;

function weekZeroMetricValues(basis: SnapshotBasis) {
  const metrics = basis === "mtm"
    ? RETURN_METRICS
    : [...REALIZED_GAME_METRICS, ...REALIZED_PLAYOFF_METRICS];
  return metrics.map((metric) => ({ metric, value: "0" }));
}

export async function ensureCompetitionSportPeriods(
  adapter: {
    sport: string;
    competitionFormat: string;
    periods: ReadonlyArray<{ sequence: number; label: string; isPlayoff: boolean }>;
  },
  writer: CalcuttaWriter = db,
): Promise<void> {
  for (const period of adapter.periods) {
    await writer
      .insert(sportPeriodsTable)
      .values({
        sport: adapter.sport,
        competition: adapter.competitionFormat,
        ...period,
      })
      .onConflictDoUpdate({
        target: [
          sportPeriodsTable.sport,
          sportPeriodsTable.competition,
          sportPeriodsTable.sequence,
        ],
        set: { label: period.label, isPlayoff: period.isPlayoff },
      });
  }
}

export async function ensureNflSportPeriods(writer: CalcuttaWriter = db): Promise<void> {
  await ensureCompetitionSportPeriods(NFL_SCORING_ADAPTER, writer);
}

export type WeekZeroPointsInitialization =
  | {
      kind: "saved";
      teamCount: number;
      realizedSnapshotsWritten: number;
      mtmSnapshotsWritten: number;
      snapshotsWritten: number;
      alreadyInitialized: boolean;
    }
  | { kind: "no_auctioned_teams" };

/**
 * Creates the zero-stat Week 0 baseline used by both return bases.
 *
 * Week 0 is an immutable starting point for the period ledger: retries only
 * insert a missing basis row and never update an existing row. That protects a
 * later imported snapshot at the same period while still repairing a partial
 * first initialization.
 */
export async function initializeNflWeekZeroSnapshots(
  writer: CalcuttaWriter,
  args: { calcuttaId: number },
): Promise<WeekZeroPointsInitialization> {
  await ensureNflSportPeriods(writer);
  // A pool's Week 0 ledger belongs exclusively to entries already created in
  // that pool. In particular, do not infer a canonical pool or manufacture
  // entries from the season-wide legacy auction table here.
  const entryRows = await writer
    .selectDistinct({
      entryId: calcuttaEntriesTable.id,
      teamId: calcuttaEntriesTable.teamId,
    })
    .from(calcuttaEntriesTable)
    .innerJoin(
      positionsTable,
      and(
        eq(positionsTable.entryId, calcuttaEntriesTable.id),
        eq(positionsTable.source, "primary"),
      ),
    )
    .where(eq(calcuttaEntriesTable.calcuttaId, args.calcuttaId));
  if (entryRows.length === 0) return { kind: "no_auctioned_teams" };
  // Read primary cost basis from this pool's ownership ledger. Week 0 does not
  // persist prices, but deriving them here keeps its selected-entry definition
  // aligned with the return engine and avoids any season-wide auction fallback.
  const primaryPositions = await writer
    .select({
      entryId: positionsTable.entryId,
      costBasis: positionsTable.costBasis,
    })
    .from(positionsTable)
    .innerJoin(
      calcuttaEntriesTable,
      eq(calcuttaEntriesTable.id, positionsTable.entryId),
    )
    .where(and(
      eq(calcuttaEntriesTable.calcuttaId, args.calcuttaId),
      eq(positionsTable.source, "primary"),
    ));
  const auctionPriceByEntry = new Map<number, number>();
  for (const position of primaryPositions) {
    auctionPriceByEntry.set(
      position.entryId,
      (auctionPriceByEntry.get(position.entryId) ?? 0) + Number(position.costBasis),
    );
  }
  const auctionEntries = entryRows.map((entry) => ({
    ...entry,
    auctionPrice: auctionPriceByEntry.get(entry.entryId) ?? 0,
  }));
  const period = await writer
    .select({ id: sportPeriodsTable.id })
    .from(sportPeriodsTable)
    .where(
      and(
        eq(sportPeriodsTable.sport, NFL_SPORT),
        eq(sportPeriodsTable.competition, NFL_SCORING_ADAPTER.competitionFormat),
        eq(sportPeriodsTable.sequence, 0),
      ),
    )
    .limit(1);
  if (!period[0]) throw new Error("NFL Week 0 period was not seeded.");

  let realizedSnapshotsWritten = 0;
  let mtmSnapshotsWritten = 0;
  const existingMtmSnapshots = await writer
    .select({ entryId: mtmSnapshotsTable.entryId })
    .from(mtmSnapshotsTable)
    .where(sql`${mtmSnapshotsTable.entryId} in (${sql.join(
      auctionEntries.map((entry) => sql`${entry.entryId}`),
      sql`, `,
    )})`);
  const entriesWithMtmSnapshots = new Set(
    existingMtmSnapshots.map((snapshot) => snapshot.entryId),
  );
  for (const entry of auctionEntries) {
    for (const basis of ["realized", "mtm"] as const) {
      if (basis === "mtm" && entriesWithMtmSnapshots.has(entry.entryId)) {
        continue;
      }
      const [inserted] = await writer
        .insert(teamPeriodSnapshotsTable)
        .values({
          entryId: entry.entryId,
          periodId: period[0].id,
          basis,
          wins: "0",
          losses: "0",
          ties: "0",
          ptDiff: "0",
          ordinaryWins: "0",
          marqueeWins: "0",
          ordinaryTies: "0",
          marqueeTies: "0",
          ordinaryPtDiff: "0",
          marqueePtDiff: "0",
          playoffBerth: "0",
          divRound: "0",
          confRound: "0",
          sbBerth: "0",
          winSuperBowl: "0",
          playoffStatus: "unknown",
          capturedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [
            teamPeriodSnapshotsTable.entryId,
            teamPeriodSnapshotsTable.periodId,
            teamPeriodSnapshotsTable.basis,
          ],
        })
        .returning({ id: teamPeriodSnapshotsTable.id });
      const capturedAt = new Date();
      for (const metric of weekZeroMetricValues(basis)) {
        await writer
          .insert(snapshotMetricsTable)
          .values({
            calcuttaId: args.calcuttaId,
            entryId: entry.entryId,
            periodId: period[0].id,
            basis,
            ...metric,
            source: "week_zero",
            sourceData: { playoffStatus: "unknown" },
            snapshotAt: capturedAt,
          })
          .onConflictDoNothing({
            target: [
              snapshotMetricsTable.calcuttaId,
              snapshotMetricsTable.entryId,
              snapshotMetricsTable.periodId,
              snapshotMetricsTable.basis,
              snapshotMetricsTable.metric,
            ],
            where: sql`${snapshotMetricsTable.entryId} is not null`,
          });
      }
      if (!inserted) continue;
      if (basis === "realized") realizedSnapshotsWritten += 1;
      else mtmSnapshotsWritten += 1;
    }
  }

  const snapshotsWritten = realizedSnapshotsWritten + mtmSnapshotsWritten;
  return {
    kind: "saved",
    teamCount: auctionEntries.length,
    realizedSnapshotsWritten,
    mtmSnapshotsWritten,
    snapshotsWritten,
    alreadyInitialized: snapshotsWritten === 0,
  };
}

export async function getOrCreateCanonicalCalcutta(
  writer: CalcuttaWriter,
  args: { seasonId: number; year: number },
): Promise<{ id: number }> {
  const existing = await writer
    .select({ id: calcuttasTable.id })
    .from(calcuttasTable)
    .where(
      and(
        eq(calcuttasTable.seasonId, args.seasonId),
        eq(calcuttasTable.sport, NFL_SPORT),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const name = `${args.year} NFL Calcutta`;
  await writer
    .insert(calcuttasTable)
    .values({
      seasonId: args.seasonId,
      year: args.year,
      sport: NFL_SPORT,
      name,
      isCanonical: true,
      asOfDate: calcuttaAsOfDate(args.year),
    })
    .onConflictDoNothing();

  const created = await writer
    .select({ id: calcuttasTable.id })
    .from(calcuttasTable)
    .where(
      and(
        eq(calcuttasTable.seasonId, args.seasonId),
        eq(calcuttasTable.sport, NFL_SPORT),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
    .limit(1);
  if (!created[0]) throw new Error("Unable to create the canonical NFL Calcutta.");
  return created[0];
}

export async function getOrCreateCalcuttaEntry(
  writer: CalcuttaWriter,
  args: { calcuttaId: number; teamId: number },
): Promise<{ id: number }> {
  await writer
    .insert(calcuttaEntriesTable)
    .values(args)
    .onConflictDoNothing({
      target: [calcuttaEntriesTable.calcuttaId, calcuttaEntriesTable.teamId],
    });
  const entry = await writer
    .select({ id: calcuttaEntriesTable.id })
    .from(calcuttaEntriesTable)
    .where(
      and(
        eq(calcuttaEntriesTable.calcuttaId, args.calcuttaId),
        eq(calcuttaEntriesTable.teamId, args.teamId),
      ),
    )
    .limit(1);
  if (!entry[0]) throw new Error("Unable to create the Calcutta team entry.");
  return entry[0];
}

export type CalculatedPeriodReturn = {
  grossReturn: number;
  latest: SnapshotState;
  points: number;
  normalizedShare: number;
  fairValue: number;
  pointsBreakdown: TeamPointsBreakdown;
  marketStatus: "live" | "stale" | null;
  marketStatusReasons: string[];
};

export type CalculatedTeamReturns = {
  realized?: CalculatedPeriodReturn;
  mtm?: CalculatedPeriodReturn;
  rulesConfigured: boolean;
};

export async function hasConfiguredPayoutRules(seasonId: number): Promise<boolean> {
  const calcutta = await db
    .select({ id: calcuttasTable.id })
    .from(calcuttasTable)
    .where(
      and(
        eq(calcuttasTable.seasonId, seasonId),
        eq(calcuttasTable.sport, NFL_SPORT),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
    .limit(1);
  return calcutta[0]
    ? hasConfiguredPayoutRulesForCalcutta(calcutta[0].id)
    : false;
}

async function configureAdapterForCalcutta(
  adapter: CompetitionScoringAdapter,
  calcuttaId: number,
): Promise<CompetitionScoringAdapter> {
  const configurationRows = await db
    .select({
      ruleName: calcuttaRulesTable.ruleName,
      value: calcuttaRulesTable.value,
      active: calcuttaRulesTable.active,
    })
    .from(calcuttaRulesTable)
    .where(eq(calcuttaRulesTable.calcuttaId, calcuttaId));
  return configureCompetitionScoringAdapter(
    adapter,
    configurationRows.map((row) => ({
      ruleName: row.ruleName,
      value: row.value == null ? null : Number(row.value),
      active: row.active,
    })),
  );
}

/** Returns whether this exact Calcutta has any payout rules configured. */
export async function hasConfiguredPayoutRulesForCalcutta(
  calcuttaId: number,
): Promise<boolean> {
  const [calcutta, rows] = await Promise.all([
    db
      .select({
        sport: calcuttasTable.sport,
        competitionFormat: calcuttasTable.competitionFormat,
      })
      .from(calcuttasTable)
      .where(eq(calcuttasTable.id, calcuttaId))
      .limit(1),
    db
    .select({
      metric: payoutRulesTable.metric,
      dollarsPerUnit: payoutRulesTable.dollarsPerUnit,
      playoffMultiplier: payoutRulesTable.playoffMultiplier,
    })
    .from(payoutRulesTable)
    .where(eq(payoutRulesTable.calcuttaId, calcuttaId)),
  ]);
  const adapter = calcutta[0] && getCompetitionScoringAdapter(
    calcutta[0].sport,
    calcutta[0].competitionFormat,
  );
  if (!adapter) return false;
  const configuredAdapter = await configureAdapterForCalcutta(adapter, calcuttaId);
  const configuredRules = rows.map((row) => ({
    metric: row.metric,
    dollarsPerUnit: row.dollarsPerUnit == null ? null : Number(row.dollarsPerUnit),
    playoffMultiplier: row.playoffMultiplier == null ? null : Number(row.playoffMultiplier),
  }));
  const effectiveRules =
    configuredRules.length === 0 && configuredAdapter.defaultRules != null
      ? configuredAdapter.defaultRules
      : configuredRules;
  return validateCompetitionScoringRules(configuredAdapter, effectiveRules).ok;
}

/**
 * Loads the current calculated return for every team that has snapshot data.
 */
export async function loadCalculatedTeamReturns(
  seasonId: number,
  periodSequence?: number,
): Promise<Map<number, CalculatedTeamReturns>> {
  const calcutta = await db
    .select({ id: calcuttasTable.id })
    .from(calcuttasTable)
    .where(
      and(
        eq(calcuttasTable.seasonId, seasonId),
        eq(calcuttasTable.sport, NFL_SPORT),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
    .limit(1);
  if (!calcutta[0]) return new Map();
  return loadCalculatedTeamReturnsForCalcutta(calcutta[0].id, periodSequence);
}

/**
 * Returns every distinct period that has a stored return snapshot for the
 * canonical Calcutta and selected basis. This is intentionally independent of
 * the template: an in-progress season must never imply future zero-movement
 * periods simply because they exist on the NFL calendar.
 */
export async function loadReturnSnapshotPeriods(
  seasonId: number,
  basis: SnapshotBasis,
  selectedCalcuttaId?: number,
): Promise<number[]> {
  const calcutta = selectedCalcuttaId == null
    ? await db
      .select({ id: calcuttasTable.id })
      .from(calcuttasTable)
      .where(
        and(
          eq(calcuttasTable.seasonId, seasonId),
          eq(calcuttasTable.sport, NFL_SPORT),
          eq(calcuttasTable.isCanonical, true),
        ),
      )
      .limit(1)
    : await db
      .select({ id: calcuttasTable.id })
      .from(calcuttasTable)
      .where(and(
        eq(calcuttasTable.id, selectedCalcuttaId),
        eq(calcuttasTable.seasonId, seasonId),
        eq(calcuttasTable.sport, NFL_SPORT),
      ))
      .limit(1);
  if (!calcutta[0]) return [];

  const rows = await db
    .select({ sequence: sportPeriodsTable.sequence })
    .from(calcuttaEntriesTable)
    .innerJoin(
      snapshotMetricsTable,
      eq(snapshotMetricsTable.entryId, calcuttaEntriesTable.id),
    )
    .innerJoin(
      sportPeriodsTable,
      eq(sportPeriodsTable.id, snapshotMetricsTable.periodId),
    )
    .where(
      and(
        eq(calcuttaEntriesTable.calcuttaId, calcutta[0].id),
        eq(snapshotMetricsTable.calcuttaId, calcutta[0].id),
        eq(snapshotMetricsTable.basis, basis),
        eq(sportPeriodsTable.sport, NFL_SCORING_ADAPTER.sport),
        eq(sportPeriodsTable.competition, NFL_SCORING_ADAPTER.competitionFormat),
      ),
    )
    .orderBy(asc(sportPeriodsTable.sequence));

  const candidates = [...new Set(rows.map((row) => row.sequence))];
  const complete: number[] = [];
  for (const sequence of candidates) {
    const calculated = await loadCalculatedTeamReturnsForCalcutta(
      calcutta[0].id,
      sequence,
    );
    if (
      calculated.size > 0 &&
      [...calculated.values()].every((team) => team[basis] != null)
    ) {
      complete.push(sequence);
    }
  }
  return complete;
}

/**
 * Loads calculated returns for one Calcutta entry set. This intentionally
 * accepts non-canonical Calcuttas so cross-pool reporting uses each pool's
 * own rules and snapshots.
 */
export async function loadCalculatedTeamReturnsForCalcutta(
  calcuttaId: number,
  periodSequence?: number,
  enforceHistoricalParity = false,
): Promise<Map<number, CalculatedTeamReturns>> {
  const calcutta = await db
    .select({
      seasonId: calcuttasTable.seasonId,
      sport: calcuttasTable.sport,
      competitionFormat: calcuttasTable.competitionFormat,
      isCanonical: calcuttasTable.isCanonical,
      isComplete: seasonsTable.isComplete,
    })
    .from(calcuttasTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .where(eq(calcuttasTable.id, calcuttaId))
    .limit(1);
  if (!calcutta[0]) return new Map();
  const baseAdapter = getCompetitionScoringAdapter(
    calcutta[0].sport,
    calcutta[0].competitionFormat,
  );
  if (!baseAdapter) return new Map();
  const adapter = await configureAdapterForCalcutta(baseAdapter, calcuttaId);

  const rawRules = await db
    .select({
      metric: payoutRulesTable.metric,
      dollarsPerUnit: payoutRulesTable.dollarsPerUnit,
      playoffMultiplier: payoutRulesTable.playoffMultiplier,
    })
    .from(payoutRulesTable)
    .where(eq(payoutRulesTable.calcuttaId, calcuttaId));
  const configuredRules = rawRules.map((rule) => ({
    metric: rule.metric,
    dollarsPerUnit: rule.dollarsPerUnit == null ? null : Number(rule.dollarsPerUnit),
    playoffMultiplier: rule.playoffMultiplier == null ? null : Number(rule.playoffMultiplier),
  }));
  const validation = validateCompetitionScoringRules(adapter, configuredRules);
  const rulesValid = validation.ok;
  // A completely absent override uses the adapter's established rubric. A
  // partial or invalid override still fails closed instead of blending defaults.
  const useDefaultRules = rawRules.length === 0 && adapter.defaultRules != null;
  if (!rulesValid && !useDefaultRules) return new Map();
  const rules = rulesValid
    ? validation.rules
    : adapter.defaultRules!.map((rule) => ({
        metric: rule.metric,
        dollarsPerUnit: rule.dollarsPerUnit!,
        playoffMultiplier: rule.playoffMultiplier ?? 1,
      }));
  const entryRows = await db
    .select({
      entryId: calcuttaEntriesTable.id,
      teamId: calcuttaEntriesTable.teamId,
    })
    .from(calcuttaEntriesTable)
    .where(eq(calcuttaEntriesTable.calcuttaId, calcuttaId));
  const primaryPositions = await db
    .select({
      entryId: positionsTable.entryId,
      costBasis: positionsTable.costBasis,
    })
    .from(positionsTable)
    .innerJoin(
      calcuttaEntriesTable,
      eq(calcuttaEntriesTable.id, positionsTable.entryId),
    )
    .where(and(
      eq(calcuttaEntriesTable.calcuttaId, calcuttaId),
      eq(positionsTable.source, "primary"),
    ));
  const costsByEntry = new Map<number, number>();
  for (const position of primaryPositions) {
    costsByEntry.set(
      position.entryId,
      (costsByEntry.get(position.entryId) ?? 0) + Number(position.costBasis),
    );
  }
  const costs = new Map(entryRows.map((entry) => [
    entry.teamId,
    costsByEntry.get(entry.entryId) ?? 0,
  ]));
  const potSize = [...costsByEntry.values()]
    .reduce((total, cost) => total + cost, 0);

  const where = [
    eq(calcuttaEntriesTable.calcuttaId, calcuttaId),
    eq(snapshotMetricsTable.calcuttaId, calcuttaId),
    eq(sportPeriodsTable.sport, calcutta[0].sport),
    eq(sportPeriodsTable.competition, calcutta[0].competitionFormat),
    ...(periodSequence == null
      ? []
      : [lte(sportPeriodsTable.sequence, periodSequence)]),
  ];
  const metricRows = await db
    .select({
      entryId: calcuttaEntriesTable.id,
      teamId: calcuttaEntriesTable.teamId,
      basis: snapshotMetricsTable.basis,
      sequence: sportPeriodsTable.sequence,
      label: sportPeriodsTable.label,
      isPlayoff: sportPeriodsTable.isPlayoff,
      metric: snapshotMetricsTable.metric,
      value: snapshotMetricsTable.value,
      sourceData: snapshotMetricsTable.sourceData,
    })
    .from(calcuttaEntriesTable)
    .innerJoin(
      snapshotMetricsTable,
      eq(snapshotMetricsTable.entryId, calcuttaEntriesTable.id),
    )
    .innerJoin(
      sportPeriodsTable,
      eq(sportPeriodsTable.id, snapshotMetricsTable.periodId),
    )
    .where(and(...where))
    .orderBy(asc(sportPeriodsTable.sequence));

  const grouped = buildCompetitionSnapshotStatesFromMetricRows(metricRows, adapter);

  const result = new Map<number, CalculatedTeamReturns>();
  for (const team of entryRows) result.set(team.teamId, { rulesConfigured: true });

  for (const basis of ["realized", "mtm"] as const) {
    const targetSequence = periodSequence ?? Math.max(
      -1,
      ...[...grouped.values()].flatMap((byBasis) => (byBasis.get(basis) ?? []).map((row) => row.sequence)),
    );
    if (targetSequence < 0) continue;
    const latestByTeam = entryRows.map((entry) => ({
      teamId: entry.teamId,
      snapshot: (grouped.get(entry.teamId)?.get(basis) ?? [])
        .filter((snapshot) => snapshot.sequence === targetSequence)
        .at(-1),
    }));
    // A share is meaningful only when every selected Calcutta entry is marked
    // at the same period. Missing coverage remains a visible incomplete state.
    if (latestByTeam.some((entry) => !entry.snapshot) || potSize <= 0) continue;
    if (
      adapter.sport === NFL_SPORT &&
      latestByTeam.some((entry) =>
        entry.snapshot!.isPlayoff &&
        !(grouped.get(entry.teamId)?.get(basis) ?? []).some((snapshot) => snapshot.sequence === 18)
      )
    ) continue;
    const values = adapter.sport === NFL_SPORT
      ? calculateNflTeamValues(
          latestByTeam.map((entry) => ({
            teamId: entry.teamId,
            snapshot: competitionSnapshotToCompatibilityState(entry.snapshot!, basis),
            cost: costs.get(entry.teamId) ?? 0,
          })),
          potSize,
          rules as RuleValue[],
        )
      : calculateCompetitionTeamValues(
          adapter,
          latestByTeam.map((entry) => ({
            teamId: entry.teamId,
            metrics: entry.snapshot!.metrics,
            cost: costs.get(entry.teamId) ?? 0,
          })),
          potSize,
          rules,
        );
    for (const value of values) {
      const calculated = result.get(value.teamId) ?? { rulesConfigured: true };
      const genericLatest = latestByTeam.find((entry) =>
        entry.teamId === value.teamId
      )?.snapshot!;
      const latest = competitionSnapshotToCompatibilityState(genericLatest, basis);
      calculated[basis] = {
        latest,
        grossReturn: Math.round(value.grossReturn * 100) / 100,
        points: value.points,
        normalizedShare: value.normalizedShare,
        fairValue: value.fairValue,
        pointsBreakdown: value.pointsBreakdown as TeamPointsBreakdown,
        marketStatus: basis === "mtm" ? genericLatest.marketStatus : null,
        marketStatusReasons:
          basis === "mtm" ? genericLatest.marketStatusReasons : [],
      };
      result.set(value.teamId, calculated);
    }
  }
  // team_results contains only the canonical season-wide legacy economics.
  // Comparing another pool's snapshots and primary costs against those rows
  // would incorrectly reject an otherwise complete non-canonical ledger.
  if (enforceHistoricalParity && calcutta[0].isCanonical && calcutta[0].isComplete) {
    const legacy = await db
      .select({ teamId: teamResultsTable.teamId, realizedReturn: teamResultsTable.realizedReturn })
      .from(teamResultsTable)
      .where(eq(teamResultsTable.seasonId, calcutta[0].seasonId));
    const parity = compareHistoricalPayoutParity(
      entryRows.length,
      legacy.map((row) => ({ teamId: row.teamId, grossReturn: Number(row.realizedReturn) })),
      result,
    );
    if (!parity.isAuthoritative) {
      return new Map(entryRows.map((row) => [row.teamId, { rulesConfigured: true }]));
    }
  }
  return result;
}