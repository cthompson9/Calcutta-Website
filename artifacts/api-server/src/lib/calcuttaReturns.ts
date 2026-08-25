import { and, asc, eq, lte } from "drizzle-orm";
import {
  calcuttasTable,
  calcuttaEntriesTable,
  db,
  payoutRulesTable,
  seasonsTable,
  sportPeriodsTable,
  teamPeriodSnapshotsTable,
  teamResultsTable,
  teamSeasonAuctionsTable,
} from "@workspace/db";
import { LEAGUE_POINT_TOTAL } from "./weekZeroValuation";

export const NFL_SPORT = "NFL";
function calcuttaAsOfDate(year: number): string | undefined {
  return year >= 1 && year <= 9999 ? `${year}-08-01` : undefined;
}
export const RETURN_METRICS = [
  "win",
  "tie",
  "pt_diff",
  "playoff_berth",
  "div_round",
  "conf_round",
  "sb_berth",
  "win_super_bowl",
] as const;
export type ReturnMetric = (typeof RETURN_METRICS)[number];
export type SnapshotBasis = "realized" | "mtm";
export type PlayoffStatus = "unknown" | "alive" | "clinched" | "eliminated";

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

export function validateNflPayoutRules(
  rules: Array<{ metric: string; dollarsPerUnit: number; playoffMultiplier?: number }>,
): { ok: true } | { ok: false; error: string } {
  if (rules.length !== NFL_PAYOUT_RULES.length) {
    return { ok: false, error: "NFL payout rules must include exactly one rule for every confirmed metric." };
  }
  const expected = new Map(NFL_PAYOUT_RULES.map((rule) => [rule.metric, rule]));
  const seen = new Set<string>();
  for (const rule of rules) {
    const target = expected.get(rule.metric as (typeof NFL_PAYOUT_RULES)[number]["metric"]);
    if (!target) return { ok: false, error: `Unsupported NFL payout metric "${rule.metric}".` };
    if (seen.has(rule.metric)) return { ok: false, error: `NFL payout metric "${rule.metric}" was supplied more than once.` };
    seen.add(rule.metric);
    if (!Number.isFinite(rule.dollarsPerUnit) || rule.dollarsPerUnit !== target.dollarsPerUnit) {
      return { ok: false, error: `NFL ${rule.metric} must be worth ${target.dollarsPerUnit} points per unit.` };
    }
    if (rule.playoffMultiplier != null && rule.playoffMultiplier !== 1) {
      return { ok: false, error: "NFL playoff multipliers must be 1; marquee game weighting is applied separately." };
    }
  }
  return { ok: true };
}

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
};

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

/** Sunday 1:00 PM inclusive through 7:00 PM exclusive ET is ordinary. */
export function isNflMarqueeKickoff(kickoff: Date | string): boolean {
  const date = kickoff instanceof Date ? kickoff : new Date(kickoff);
  if (!Number.isFinite(date.getTime())) throw new Error("NFL game kickoff must be a valid timestamp.");
  const eastern = easternKickoffParts(date);
  return eastern.weekday !== "Sun" || eastern.minutes < 13 * 60 || eastern.minutes >= 19 * 60;
}

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
    ? (snapshot.ordinaryWins ?? 0) + NFL_MARQUEE_MULTIPLIER * (snapshot.marqueeWins ?? 0)
    : snapshot.wins;
  const weightedTies = hasGameBreakdown
    ? (snapshot.ordinaryTies ?? 0) + NFL_MARQUEE_MULTIPLIER * (snapshot.marqueeTies ?? 0)
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
    const normalizedShare = entry.points / LEAGUE_POINT_TOTAL;
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

type CalcuttaWriter = Pick<typeof db, "insert" | "select">;

export async function ensureNflSportPeriods(writer: CalcuttaWriter = db): Promise<void> {
  for (const period of NFL_PERIOD_TEMPLATE) {
    await writer
      .insert(sportPeriodsTable)
      .values({ sport: NFL_SPORT, ...period })
      .onConflictDoUpdate({
        target: [sportPeriodsTable.sport, sportPeriodsTable.sequence],
        set: { label: period.label, isPlayoff: period.isPlayoff },
      });
  }
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
  args: { seasonId: number; year: number },
): Promise<WeekZeroPointsInitialization> {
  await ensureNflSportPeriods(writer);
  const auctionRows = await writer
    .select({ teamId: teamSeasonAuctionsTable.teamId })
    .from(teamSeasonAuctionsTable)
    .where(eq(teamSeasonAuctionsTable.seasonId, args.seasonId));
  if (auctionRows.length === 0) return { kind: "no_auctioned_teams" };

  const calcutta = await getOrCreateCanonicalCalcutta(writer, args);
  const period = await writer
    .select({ id: sportPeriodsTable.id })
    .from(sportPeriodsTable)
    .where(
      and(
        eq(sportPeriodsTable.sport, NFL_SPORT),
        eq(sportPeriodsTable.sequence, 0),
      ),
    )
    .limit(1);
  if (!period[0]) throw new Error("NFL Week 0 period was not seeded.");

  let realizedSnapshotsWritten = 0;
  let mtmSnapshotsWritten = 0;
  for (const auction of auctionRows) {
    const entry = await getOrCreateCalcuttaEntry(writer, {
      calcuttaId: calcutta.id,
      teamId: auction.teamId,
    });
    for (const basis of ["realized", "mtm"] as const) {
      const [inserted] = await writer
        .insert(teamPeriodSnapshotsTable)
        .values({
          entryId: entry.id,
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
      if (!inserted) continue;
      if (basis === "realized") realizedSnapshotsWritten += 1;
      else mtmSnapshotsWritten += 1;
    }
  }

  const snapshotsWritten = realizedSnapshotsWritten + mtmSnapshotsWritten;
  return {
    kind: "saved",
    teamCount: auctionRows.length,
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
    .onConflictDoNothing({ target: calcuttasTable.name });

  const created = await writer
    .select({ id: calcuttasTable.id })
    .from(calcuttasTable)
    .where(eq(calcuttasTable.name, name))
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
};

export type CalculatedTeamReturns = {
  realized?: CalculatedPeriodReturn;
  mtm?: CalculatedPeriodReturn;
  rulesConfigured: boolean;
};

export async function hasConfiguredPayoutRules(seasonId: number): Promise<boolean> {
  const rows = await db
    .select({
      metric: payoutRulesTable.metric,
      dollarsPerUnit: payoutRulesTable.dollarsPerUnit,
      playoffMultiplier: payoutRulesTable.playoffMultiplier,
    })
    .from(calcuttasTable)
    .innerJoin(
      payoutRulesTable,
      eq(payoutRulesTable.calcuttaId, calcuttasTable.id),
    )
    .where(
      and(
        eq(calcuttasTable.seasonId, seasonId),
        eq(calcuttasTable.sport, NFL_SPORT),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
  return validateNflPayoutRules(rows.map((row) => ({
    metric: row.metric,
    dollarsPerUnit: Number(row.dollarsPerUnit),
    playoffMultiplier: Number(row.playoffMultiplier),
  }))).ok;
}

/** Returns whether this exact Calcutta has any payout rules configured. */
export async function hasConfiguredPayoutRulesForCalcutta(
  calcuttaId: number,
): Promise<boolean> {
  const rows = await db
    .select({
      metric: payoutRulesTable.metric,
      dollarsPerUnit: payoutRulesTable.dollarsPerUnit,
      playoffMultiplier: payoutRulesTable.playoffMultiplier,
    })
    .from(payoutRulesTable)
    .where(eq(payoutRulesTable.calcuttaId, calcuttaId))
  return validateNflPayoutRules(rows.map((row) => ({
    metric: row.metric,
    dollarsPerUnit: Number(row.dollarsPerUnit),
    playoffMultiplier: Number(row.playoffMultiplier),
  }))).ok;
}

function parseSnapshot(row: {
  sequence: number;
  label: string;
  isPlayoff: boolean;
  playoffStatus: string;
  wins: string;
  losses: string;
  ties: string;
  ptDiff: string;
  playoffBerth: string;
  divRound: string;
  confRound: string;
  sbBerth: string;
  winSuperBowl: string;
  ordinaryWins: string;
  marqueeWins: string;
  ordinaryTies: string;
  marqueeTies: string;
  ordinaryPtDiff: string;
  marqueePtDiff: string;
}): SnapshotState {
  return {
    sequence: row.sequence,
    label: row.label,
    isPlayoff: row.isPlayoff,
    playoffStatus: row.playoffStatus as PlayoffStatus,
    wins: Number(row.wins),
    losses: Number(row.losses),
    ties: Number(row.ties),
    ptDiff: Number(row.ptDiff),
    playoffBerth: Number(row.playoffBerth),
    divRound: Number(row.divRound),
    confRound: Number(row.confRound),
    sbBerth: Number(row.sbBerth),
    winSuperBowl: Number(row.winSuperBowl),
    ordinaryWins: Number(row.ordinaryWins),
    marqueeWins: Number(row.marqueeWins),
    ordinaryTies: Number(row.ordinaryTies),
    marqueeTies: Number(row.marqueeTies),
    ordinaryPtDiff: Number(row.ordinaryPtDiff),
    marqueePtDiff: Number(row.marqueePtDiff),
  };
}

/**
 * Loads the current calculated return for every team that has snapshot data.
 * Existing legacy results remain the reporting fallback until payout rules have
 * been configured for the Calcutta.
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
): Promise<number[]> {
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
  if (!calcutta[0]) return [];

  const rows = await db
    .select({ sequence: sportPeriodsTable.sequence })
    .from(calcuttaEntriesTable)
    .innerJoin(
      teamPeriodSnapshotsTable,
      eq(teamPeriodSnapshotsTable.entryId, calcuttaEntriesTable.id),
    )
    .innerJoin(
      sportPeriodsTable,
      eq(sportPeriodsTable.id, teamPeriodSnapshotsTable.periodId),
    )
    .where(
      and(
        eq(calcuttaEntriesTable.calcuttaId, calcutta[0].id),
        eq(teamPeriodSnapshotsTable.basis, basis),
      ),
    )
    .orderBy(asc(sportPeriodsTable.sequence));

  return [...new Set(rows.map((row) => row.sequence))];
}

/**
 * Loads calculated returns for one Calcutta entry set. This intentionally
 * accepts non-canonical Calcuttas so cross-pool reporting uses each pool's
 * own rules and snapshots.
 */
export async function loadCalculatedTeamReturnsForCalcutta(
  calcuttaId: number,
  periodSequence?: number,
  enforceHistoricalParity = true,
): Promise<Map<number, CalculatedTeamReturns>> {
  const rawRules = await db
    .select({
      metric: payoutRulesTable.metric,
      dollarsPerUnit: payoutRulesTable.dollarsPerUnit,
      playoffMultiplier: payoutRulesTable.playoffMultiplier,
    })
    .from(payoutRulesTable)
    .where(eq(payoutRulesTable.calcuttaId, calcuttaId));
  const configuredRules = rawRules.map((rule) => ({
    metric: rule.metric as ReturnMetric,
    dollarsPerUnit: Number(rule.dollarsPerUnit),
    playoffMultiplier: Number(rule.playoffMultiplier),
  }));
  const rulesValid = validateNflPayoutRules(configuredRules).ok;
  // Week 0 contains only the fixed 150-point opening allocation. It is safe to
  // calculate with the established default rubric when a new pool has not yet
  // saved custom rates; later periods keep the existing configuration guard.
  const useDefaultWeekZeroRules = periodSequence === 0 && rawRules.length === 0;
  if (!rulesValid && !useDefaultWeekZeroRules) return new Map();
  const rules = rulesValid
    ? configuredRules
    : NFL_PAYOUT_RULES as unknown as RuleValue[];

  const calcutta = await db
    .select({ seasonId: calcuttasTable.seasonId, isComplete: seasonsTable.isComplete })
    .from(calcuttasTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .where(eq(calcuttasTable.id, calcuttaId))
    .limit(1);
  if (!calcutta[0]) return new Map();
  const auctionRows = await db
    .select({
      teamId: teamSeasonAuctionsTable.teamId,
      bidAmount: teamSeasonAuctionsTable.bidAmount,
    })
    .from(teamSeasonAuctionsTable)
    .where(eq(teamSeasonAuctionsTable.seasonId, calcutta[0].seasonId));

  const where = [
    eq(calcuttaEntriesTable.calcuttaId, calcuttaId),
    ...(periodSequence == null
      ? []
      : [lte(sportPeriodsTable.sequence, periodSequence)]),
  ];
  const snapshots = await db
    .select({
      teamId: calcuttaEntriesTable.teamId,
      basis: teamPeriodSnapshotsTable.basis,
      sequence: sportPeriodsTable.sequence,
      label: sportPeriodsTable.label,
      isPlayoff: sportPeriodsTable.isPlayoff,
      playoffStatus: teamPeriodSnapshotsTable.playoffStatus,
      wins: teamPeriodSnapshotsTable.wins,
      losses: teamPeriodSnapshotsTable.losses,
      ties: teamPeriodSnapshotsTable.ties,
      ptDiff: teamPeriodSnapshotsTable.ptDiff,
      playoffBerth: teamPeriodSnapshotsTable.playoffBerth,
      divRound: teamPeriodSnapshotsTable.divRound,
      confRound: teamPeriodSnapshotsTable.confRound,
      sbBerth: teamPeriodSnapshotsTable.sbBerth,
      winSuperBowl: teamPeriodSnapshotsTable.winSuperBowl,
      ordinaryWins: teamPeriodSnapshotsTable.ordinaryWins,
      marqueeWins: teamPeriodSnapshotsTable.marqueeWins,
      ordinaryTies: teamPeriodSnapshotsTable.ordinaryTies,
      marqueeTies: teamPeriodSnapshotsTable.marqueeTies,
      ordinaryPtDiff: teamPeriodSnapshotsTable.ordinaryPtDiff,
      marqueePtDiff: teamPeriodSnapshotsTable.marqueePtDiff,
    })
    .from(calcuttaEntriesTable)
    .innerJoin(
      teamPeriodSnapshotsTable,
      eq(teamPeriodSnapshotsTable.entryId, calcuttaEntriesTable.id),
    )
    .innerJoin(
      sportPeriodsTable,
      eq(sportPeriodsTable.id, teamPeriodSnapshotsTable.periodId),
    )
    .where(and(...where))
    .orderBy(asc(sportPeriodsTable.sequence));

  const grouped = new Map<number, Map<SnapshotBasis, SnapshotState[]>>();
  for (const row of snapshots) {
    const basis = row.basis as SnapshotBasis;
    if (basis !== "realized" && basis !== "mtm") continue;
    const teamRows = grouped.get(row.teamId) ?? new Map<SnapshotBasis, SnapshotState[]>();
    const basisRows = teamRows.get(basis) ?? [];
    basisRows.push(parseSnapshot(row));
    teamRows.set(basis, basisRows);
    grouped.set(row.teamId, teamRows);
  }

  const costs = new Map(auctionRows.map((row) => [row.teamId, Number(row.bidAmount)]));
  const potSize = auctionRows.reduce((total, row) => total + Number(row.bidAmount), 0);
  const result = new Map<number, CalculatedTeamReturns>();
  for (const team of auctionRows) result.set(team.teamId, { rulesConfigured: true });

  for (const basis of ["realized", "mtm"] as const) {
    const targetSequence = periodSequence ?? Math.max(
      -1,
      ...[...grouped.values()].flatMap((byBasis) => (byBasis.get(basis) ?? []).map((row) => row.sequence)),
    );
    if (targetSequence < 0) continue;
    const latestByTeam = auctionRows.map((auction) => ({
      teamId: auction.teamId,
      snapshot: (grouped.get(auction.teamId)?.get(basis) ?? [])
        .filter((snapshot) => snapshot.sequence === targetSequence)
        .at(-1),
    }));
    // A share is meaningful only when every selected Calcutta entry is marked
    // at the same period. Missing coverage remains a visible incomplete state.
    if (latestByTeam.some((entry) => !entry.snapshot) || potSize <= 0) continue;
    if (latestByTeam.some((entry) =>
      entry.snapshot!.isPlayoff &&
      !(grouped.get(entry.teamId)?.get(basis) ?? []).some((snapshot) => snapshot.sequence === 18),
    )) continue;
    const values = calculateNflTeamValues(
      latestByTeam.map((entry) => ({
        teamId: entry.teamId,
        snapshot: entry.snapshot!,
        cost: costs.get(entry.teamId) ?? 0,
      })),
      potSize,
      rules,
    );
    for (const value of values) {
      const calculated = result.get(value.teamId) ?? { rulesConfigured: true };
      const latest = latestByTeam.find((entry) => entry.teamId === value.teamId)?.snapshot!;
      calculated[basis] = {
        latest,
        grossReturn: Math.round(value.grossReturn * 100) / 100,
        points: value.points,
        normalizedShare: value.normalizedShare,
        fairValue: value.fairValue,
        pointsBreakdown: value.pointsBreakdown,
      };
      result.set(value.teamId, calculated);
    }
  }
  if (enforceHistoricalParity && calcutta[0].isComplete) {
    const legacy = await db
      .select({ teamId: teamResultsTable.teamId, realizedReturn: teamResultsTable.realizedReturn })
      .from(teamResultsTable)
      .where(eq(teamResultsTable.seasonId, calcutta[0].seasonId));
    const parity = compareHistoricalPayoutParity(
      auctionRows.length,
      legacy.map((row) => ({ teamId: row.teamId, grossReturn: Number(row.realizedReturn) })),
      result,
    );
    if (!parity.isAuthoritative) {
      return new Map(auctionRows.map((row) => [row.teamId, { rulesConfigured: true }]));
    }
  }
  return result;
}