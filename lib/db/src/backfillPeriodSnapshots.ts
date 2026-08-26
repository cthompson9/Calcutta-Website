import { and, eq, inArray } from "drizzle-orm";
import {
  calcuttasTable,
  calcuttaEntriesTable,
  db,
  seasonsTable,
  sportPeriodsTable,
  snapshotMetricsTable,
  teamPeriodSnapshotsTable,
  teamResultsTable,
} from "./index";

const NFL_PERIODS = [
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
];

async function seedNflPeriods() {
  for (const period of NFL_PERIODS) {
    await db
      .insert(sportPeriodsTable)
      .values({ sport: "NFL", ...period })
      .onConflictDoUpdate({
        target: [sportPeriodsTable.sport, sportPeriodsTable.sequence],
        set: { label: period.label, isPlayoff: period.isPlayoff },
      });
  }
}

async function removeSparsePlayoffSnapshots() {
  const playoffSnapshots = await db
    .select({
      id: teamPeriodSnapshotsTable.id,
      entryId: teamPeriodSnapshotsTable.entryId,
      basis: teamPeriodSnapshotsTable.basis,
    })
    .from(teamPeriodSnapshotsTable)
    .innerJoin(
      sportPeriodsTable,
      eq(sportPeriodsTable.id, teamPeriodSnapshotsTable.periodId),
    )
    .where(and(eq(sportPeriodsTable.sport, "NFL"), eq(sportPeriodsTable.isPlayoff, true)));

  for (const snapshot of playoffSnapshots) {
    const baseline = await db
      .select({ id: teamPeriodSnapshotsTable.id })
      .from(teamPeriodSnapshotsTable)
      .innerJoin(
        sportPeriodsTable,
        eq(sportPeriodsTable.id, teamPeriodSnapshotsTable.periodId),
      )
      .where(
        and(
          eq(teamPeriodSnapshotsTable.entryId, snapshot.entryId),
          eq(teamPeriodSnapshotsTable.basis, snapshot.basis),
          eq(sportPeriodsTable.sport, "NFL"),
          eq(sportPeriodsTable.sequence, 18),
        ),
      )
      .limit(1);
    if (!baseline[0]) {
      await db
        .delete(teamPeriodSnapshotsTable)
        .where(eq(teamPeriodSnapshotsTable.id, snapshot.id));
    }
  }
}

/**
 * Mirrors the legacy sparse-playoff guard for V2 rows. Snapshot metric writers
 * arrive with the calculation engine; keeping both guards makes that cutover
 * safe without changing the current reporting fallback.
 */
async function removeSparsePlayoffMetrics() {
  const playoffMetrics = await db
    .select({
      entryId: snapshotMetricsTable.entryId,
      basis: snapshotMetricsTable.basis,
    })
    .from(snapshotMetricsTable)
    .innerJoin(
      sportPeriodsTable,
      eq(sportPeriodsTable.id, snapshotMetricsTable.periodId),
    )
    .where(and(eq(sportPeriodsTable.sport, "NFL"), eq(sportPeriodsTable.isPlayoff, true)));

  const playoffPeriods = await db
    .select({ id: sportPeriodsTable.id })
    .from(sportPeriodsTable)
    .where(and(eq(sportPeriodsTable.sport, "NFL"), eq(sportPeriodsTable.isPlayoff, true)));
  const playoffPeriodIds = playoffPeriods.map((period) => period.id);

  for (const metric of playoffMetrics) {
    const baseline = await db
      .select({ id: snapshotMetricsTable.id })
      .from(snapshotMetricsTable)
      .innerJoin(
        sportPeriodsTable,
        eq(sportPeriodsTable.id, snapshotMetricsTable.periodId),
      )
      .where(
        and(
          eq(snapshotMetricsTable.entryId, metric.entryId),
          eq(snapshotMetricsTable.basis, metric.basis),
          eq(sportPeriodsTable.sport, "NFL"),
          eq(sportPeriodsTable.sequence, 18),
        ),
      )
      .limit(1);
    if (!baseline[0] && playoffPeriodIds.length) {
      await db
        .delete(snapshotMetricsTable)
        .where(
          and(
            eq(snapshotMetricsTable.entryId, metric.entryId),
            eq(snapshotMetricsTable.basis, metric.basis),
            inArray(snapshotMetricsTable.periodId, playoffPeriodIds),
          ),
        );
    }
  }
}

async function main() {
  await seedNflPeriods();
  await removeSparsePlayoffSnapshots();
  await removeSparsePlayoffMetrics();
  const seasons = await db.select().from(seasonsTable);
  for (const season of seasons) {
    const name = `${season.year} NFL Calcutta`;
    await db
      .insert(calcuttasTable)
      .values({
        seasonId: season.id,
        year: season.year,
        sport: "NFL",
        name,
        isCanonical: true,
      })
      .onConflictDoNothing({ target: calcuttasTable.name });
    const calcutta = await db
      .select({ id: calcuttasTable.id })
      .from(calcuttasTable)
      .where(eq(calcuttasTable.name, name))
      .limit(1);
    if (!calcutta[0]) throw new Error(`Could not create Calcutta for ${season.year}.`);

    const results = await db
      .select()
      .from(teamResultsTable)
      .where(eq(teamResultsTable.seasonId, season.id));
    for (const result of results) {
      await db
        .insert(calcuttaEntriesTable)
        .values({ calcuttaId: calcutta[0].id, teamId: result.teamId })
        .onConflictDoNothing({
          target: [calcuttaEntriesTable.calcuttaId, calcuttaEntriesTable.teamId],
        });
    }
  }

  process.stdout.write("Backfilled canonical Calcuttas and team entries; legacy financial results remain the reporting fallback.\n");
  await db.$client.end();
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await db.$client.end();
  process.exitCode = 1;
});