import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  mtmSnapshotsTable,
  teamSeasonAuctionsTable,
} from "@workspace/db";
import { WEEK_ZERO_SNAPSHOT_KEY } from "./weekZeroValuation";

export const MTM_SEASON_LOCK_NAMESPACE = 7_140;

export type ManualMtmWriteInput = {
  seasonId: number;
  teamId: number;
  snapshotDate: string;
  mtmValue: number;
  weekNum?: number | null;
};

export async function writeManualMtmSnapshot(input: ManualMtmWriteInput) {
  if (!Number.isFinite(input.mtmValue) || input.mtmValue < 0) {
    return { kind: "invalid_value" as const };
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${MTM_SEASON_LOCK_NAMESPACE}, ${input.seasonId})`,
    );
    const auctionedTeam = await tx
      .select({ teamId: teamSeasonAuctionsTable.teamId })
      .from(teamSeasonAuctionsTable)
      .where(
        and(
          eq(teamSeasonAuctionsTable.teamId, input.teamId),
          eq(teamSeasonAuctionsTable.seasonId, input.seasonId),
        ),
      )
      .limit(1);
    if (!auctionedTeam[0]) return { kind: "not_auctioned" as const };

    const existingAtDate = await tx
      .select({ snapshotKey: mtmSnapshotsTable.snapshotKey })
      .from(mtmSnapshotsTable)
      .where(
        and(
          eq(mtmSnapshotsTable.teamId, input.teamId),
          eq(mtmSnapshotsTable.seasonId, input.seasonId),
          eq(mtmSnapshotsTable.snapshotDate, input.snapshotDate),
        ),
      )
      .limit(1);
    if (existingAtDate[0]?.snapshotKey === WEEK_ZERO_SNAPSHOT_KEY) {
      return { kind: "protected_week_zero" as const };
    }

    const [snapshot] = await tx
      .insert(mtmSnapshotsTable)
      .values({
        teamId: input.teamId,
        seasonId: input.seasonId,
        weekNum: input.weekNum ?? null,
        snapshotDate: input.snapshotDate,
        mtmValue: input.mtmValue.toString(),
      })
      .onConflictDoUpdate({
        target: [
          mtmSnapshotsTable.teamId,
          mtmSnapshotsTable.seasonId,
          mtmSnapshotsTable.snapshotDate,
        ],
        set: {
          weekNum: input.weekNum ?? null,
          mtmValue: input.mtmValue.toString(),
          source: "manual",
          capturedAt: null,
          marketStatus: null,
          bankedPoints: null,
          seasonEquityPoints: null,
          bonusEquityPoints: null,
          totalPoints: null,
          normalizedShare: null,
          marketData: null,
        },
        setWhere: isNull(mtmSnapshotsTable.snapshotKey),
      })
      .returning();
    return snapshot
      ? { kind: "saved" as const, snapshot }
      : { kind: "protected_week_zero" as const };
  });
}