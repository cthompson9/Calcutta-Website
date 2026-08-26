import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  calcuttasTable,
  calcuttaEntriesTable,
  db,
  mtmSnapshotsTable,
  positionsTable,
  seasonsTable,
  sportPeriodsTable,
  teamPeriodSnapshotsTable,
  teamsTable,
} from "@workspace/db";
import { captureKalshiWeekZero } from "./kalshiWeekZero";
import { ensureNflSportPeriods, NFL_SPORT } from "./calcuttaReturns";
import { MTM_SEASON_LOCK_NAMESPACE } from "./manualMtm";
import { todayInNewYork } from "./newYorkTime";
import {
  buildWeekZeroSnapshotRows,
  calculateWeekZeroValuations,
  WEEK_ZERO_SNAPSHOT_KEY,
} from "./weekZeroValuation";

export function latestFullyCoveredNflPeriod(
  rows: Array<{ entryId: number; sequence: number }>,
  entryCount: number,
): number {
  const entriesByPeriod = new Map<number, Set<number>>();
  for (const row of rows) {
    const entries = entriesByPeriod.get(row.sequence) ?? new Set<number>();
    entries.add(row.entryId);
    entriesByPeriod.set(row.sequence, entries);
  }
  const complete = [...entriesByPeriod.entries()]
    .filter(([, entries]) => entries.size === entryCount)
    .map(([sequence]) => sequence);
  return complete.length ? Math.max(...complete) : 0;
}

export function canonicalMtmSnapshotKey(periodSequence: number): string {
  return periodSequence === 0
    ? WEEK_ZERO_SNAPSHOT_KEY
    : `canonical-mtm-period-${periodSequence}`;
}

export type CanonicalMtmRefreshResult =
  | {
      ran: false;
      reason: "already-marked";
      periodSeq: number;
      teamsUpdated: 0;
    }
  | {
      ran: true;
      periodSeq: number;
      teamsUpdated: number;
    };

export async function runCanonicalMtmRefresh(input: {
  seasonYear: number;
  now?: Date;
}): Promise<CanonicalMtmRefreshResult> {
  const now = input.now ?? new Date();
  await ensureNflSportPeriods();

  const selected = await db
    .select({
      seasonId: seasonsTable.id,
      calcuttaId: calcuttasTable.id,
    })
    .from(calcuttasTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .where(
      and(
        eq(seasonsTable.year, input.seasonYear),
        eq(calcuttasTable.sport, NFL_SPORT),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
    .limit(1);
  const target = selected[0];
  if (!target) {
    throw new Error(
      `Canonical NFL Calcutta for season ${input.seasonYear} was not found.`,
    );
  }

  const entries = await db
    .select({
      entryId: calcuttaEntriesTable.id,
      teamId: teamsTable.id,
      name: teamsTable.name,
      conference: teamsTable.conference,
    })
    .from(calcuttaEntriesTable)
    .innerJoin(teamsTable, eq(teamsTable.id, calcuttaEntriesTable.teamId))
    .where(eq(calcuttaEntriesTable.calcuttaId, target.calcuttaId))
    .orderBy(asc(teamsTable.id));
  if (entries.length !== 32) {
    throw new Error(
      `Canonical MTM refresh requires all 32 NFL entries; found ${entries.length}.`,
    );
  }

  const entryIds = entries.map((entry) => entry.entryId);
  const realizedCoverage = await db
    .select({
      entryId: teamPeriodSnapshotsTable.entryId,
      sequence: sportPeriodsTable.sequence,
    })
    .from(teamPeriodSnapshotsTable)
    .innerJoin(
      sportPeriodsTable,
      eq(sportPeriodsTable.id, teamPeriodSnapshotsTable.periodId),
    )
    .where(
      and(
        inArray(teamPeriodSnapshotsTable.entryId, entryIds),
        eq(teamPeriodSnapshotsTable.basis, "realized"),
        eq(sportPeriodsTable.sport, NFL_SPORT),
      ),
    );
  const requestedSequence = latestFullyCoveredNflPeriod(
    realizedCoverage,
    entries.length,
  );
  const period = await db
    .select({
      sequence: sportPeriodsTable.sequence,
      label: sportPeriodsTable.label,
    })
    .from(sportPeriodsTable)
    .where(
      and(
        eq(sportPeriodsTable.sport, NFL_SPORT),
        eq(sportPeriodsTable.sequence, requestedSequence),
      ),
    )
    .limit(1);
  if (!period[0]) {
    throw new Error(`NFL period ${requestedSequence} is not configured.`);
  }

  const snapshotKey = canonicalMtmSnapshotKey(period[0].sequence);
  const existing = await db
    .select({
      entryId: mtmSnapshotsTable.entryId,
      snapshotDate: mtmSnapshotsTable.snapshotDate,
    })
    .from(mtmSnapshotsTable)
    .where(
      and(
        inArray(mtmSnapshotsTable.entryId, entryIds),
        eq(mtmSnapshotsTable.snapshotKey, snapshotKey),
      ),
    );
  if (new Set(existing.map((row) => row.entryId)).size === entries.length) {
    return {
      ran: false,
      reason: "already-marked",
      periodSeq: period[0].sequence,
      teamsUpdated: 0,
    };
  }
  const existingDates = new Set(existing.map((row) => row.snapshotDate));
  if (existingDates.size > 1) {
    throw new Error(
      `Canonical MTM period ${period[0].sequence} has inconsistent snapshot dates.`,
    );
  }
  const snapshotDate = existing[0]?.snapshotDate ?? todayInNewYork(now);
  const dateRows = await db
    .select({
      entryId: mtmSnapshotsTable.entryId,
      snapshotKey: mtmSnapshotsTable.snapshotKey,
    })
    .from(mtmSnapshotsTable)
    .where(
      and(
        inArray(mtmSnapshotsTable.entryId, entryIds),
        eq(mtmSnapshotsTable.snapshotDate, snapshotDate),
      ),
    );
  if (dateRows.some((row) => row.snapshotKey !== snapshotKey)) {
    throw new Error(
      `Canonical MTM date ${snapshotDate} already contains noncanonical snapshots.`,
    );
  }

  const primaryPositions = await db
    .select({
      entryId: positionsTable.entryId,
      costBasis: positionsTable.costBasis,
    })
    .from(positionsTable)
    .where(
      and(
        inArray(positionsTable.entryId, entryIds),
        eq(positionsTable.source, "primary"),
      ),
    );
  const costByEntry = new Map<number, number>();
  for (const position of primaryPositions) {
    costByEntry.set(
      position.entryId,
      (costByEntry.get(position.entryId) ?? 0) + Number(position.costBasis),
    );
  }
  if (costByEntry.size !== entries.length) {
    throw new Error(
      `Canonical MTM refresh requires primary-position costs for all 32 entries; found ${costByEntry.size}.`,
    );
  }
  const potSize = [...costByEntry.values()].reduce((sum, value) => sum + value, 0);
  const marketSnapshots = await captureKalshiWeekZero({
    seasonYear: input.seasonYear,
    teams: entries.map((entry) => ({
      id: entry.teamId,
      name: entry.name,
      conference: entry.conference,
    })),
  });
  const calculation = calculateWeekZeroValuations(
    marketSnapshots,
    potSize,
    now,
  );
  const entryIdByTeam = new Map(
    entries.map((entry) => [entry.teamId, entry.entryId]),
  );
  const rows = buildWeekZeroSnapshotRows(calculation, {
    seasonId: target.seasonId,
    entryIdByTeam,
    snapshotDate,
    capturedAt: now,
  }).map((row) => ({
    ...row,
    weekNum: period[0].sequence,
    snapshotKey,
    marketData: {
      ...row.marketData,
      canonicalPeriodSequence: period[0].sequence,
      canonicalPeriodLabel: period[0].label,
    },
  }));

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${MTM_SEASON_LOCK_NAMESPACE}, ${target.calcuttaId})`,
    );
    const current = await tx
      .select({
        entryId: mtmSnapshotsTable.entryId,
        snapshotDate: mtmSnapshotsTable.snapshotDate,
      })
      .from(mtmSnapshotsTable)
      .where(
        and(
          inArray(mtmSnapshotsTable.entryId, entryIds),
          eq(mtmSnapshotsTable.snapshotKey, snapshotKey),
        ),
      );
    if (new Set(current.map((row) => row.entryId)).size === entries.length) {
      return "already-marked" as const;
    }
    if (
      new Set(current.map((row) => row.snapshotDate)).size > 1 ||
      current.some((row) => row.snapshotDate !== snapshotDate)
    ) {
      throw new Error(
        `Canonical MTM period ${period[0].sequence} changed snapshot dates during capture.`,
      );
    }
    const currentDateRows = await tx
      .select({ snapshotKey: mtmSnapshotsTable.snapshotKey })
      .from(mtmSnapshotsTable)
      .where(
        and(
          inArray(mtmSnapshotsTable.entryId, entryIds),
          eq(mtmSnapshotsTable.snapshotDate, snapshotDate),
        ),
      );
    if (currentDateRows.some((row) => row.snapshotKey !== snapshotKey)) {
      throw new Error(
        `Canonical MTM date ${snapshotDate} already contains noncanonical snapshots.`,
      );
    }
    for (const values of rows) {
      await tx
        .insert(mtmSnapshotsTable)
        .values(values)
        .onConflictDoUpdate({
          target: [
            mtmSnapshotsTable.entryId,
            mtmSnapshotsTable.snapshotDate,
          ],
          set: values,
        });
    }
    return "saved" as const;
  });

  return outcome === "already-marked"
    ? {
        ran: false,
        reason: "already-marked",
        periodSeq: period[0].sequence,
        teamsUpdated: 0,
      }
    : {
        ran: true,
        periodSeq: period[0].sequence,
        teamsUpdated: rows.length,
      };
}