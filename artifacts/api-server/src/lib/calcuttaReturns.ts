import { and, asc, eq, lte } from "drizzle-orm";
import {
  calcuttasTable,
  calcuttaEntriesTable,
  db,
  payoutRulesTable,
  sportPeriodsTable,
  teamPeriodSnapshotsTable,
} from "@workspace/db";

export const NFL_SPORT = "NFL";
function calcuttaAsOfDate(year: number): string | undefined {
  return year >= 1 && year <= 9999 ? `${year}-08-01` : undefined;
}
export const RETURN_METRICS = [
  "win",
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

function metricValue(metrics: SnapshotMetrics, metric: ReturnMetric): number {
  switch (metric) {
    case "win":
      return metrics.wins;
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
};

export type CalculatedTeamReturns = {
  realized?: CalculatedPeriodReturn;
  mtm?: CalculatedPeriodReturn;
  rulesConfigured: boolean;
};

export async function hasConfiguredPayoutRules(seasonId: number): Promise<boolean> {
  const rows = await db
    .select({ id: payoutRulesTable.id })
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
    .limit(1);
  return Boolean(rows[0]);
}

/** Returns whether this exact Calcutta has any payout rules configured. */
export async function hasConfiguredPayoutRulesForCalcutta(
  calcuttaId: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: payoutRulesTable.id })
    .from(payoutRulesTable)
    .where(eq(payoutRulesTable.calcuttaId, calcuttaId))
    .limit(1);
  return Boolean(rows[0]);
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
): Promise<Map<number, CalculatedTeamReturns>> {
  const rawRules = await db
    .select({
      metric: payoutRulesTable.metric,
      dollarsPerUnit: payoutRulesTable.dollarsPerUnit,
      playoffMultiplier: payoutRulesTable.playoffMultiplier,
    })
    .from(payoutRulesTable)
    .where(eq(payoutRulesTable.calcuttaId, calcuttaId));
  const rules = rawRules.map((rule) => ({
    metric: rule.metric as ReturnMetric,
    dollarsPerUnit: Number(rule.dollarsPerUnit),
    playoffMultiplier: Number(rule.playoffMultiplier),
  }));

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

  const result = new Map<number, CalculatedTeamReturns>();
  for (const [teamId, byBasis] of grouped) {
    const calculated: CalculatedTeamReturns = { rulesConfigured: rules.length > 0 };
    for (const basis of ["realized", "mtm"] as const) {
      const basisSnapshots = byBasis.get(basis);
      if (!basisSnapshots?.length) continue;
      // Write APIs require this baseline. Retaining the check here also keeps
      // historical sparse data from becoming calculable if a later snapshot is
      // added around it outside the supported write path.
      if (
        basisSnapshots.some((snapshot) => snapshot.isPlayoff) &&
        !basisSnapshots.some(
          (snapshot) => !snapshot.isPlayoff && snapshot.sequence === 18,
        )
      ) continue;
      const latest = basisSnapshots[basisSnapshots.length - 1];
      calculated[basis] = {
        latest,
        grossReturn: calculateReturnFromSnapshots(basisSnapshots, rules),
      };
    }
    result.set(teamId, calculated);
  }
  return result;
}