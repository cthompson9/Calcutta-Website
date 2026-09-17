import { and, desc, eq, gt } from "drizzle-orm";
import {
  db,
  mtmJobRunsTable,
  mtmValuationVersionTable,
  calcuttasTable,
  seasonsTable,
} from "@workspace/db";
import { runMtmPipeline, withMtmLock } from "./mtmPipeline";
import { validateAndPromoteCurrentMtm } from "./currentMtm";

export function requiresFullMtmRecalculation(
  results: Array<{
    poolId: number;
    status: "promoted" | "unchanged" | "skipped" | "warning";
    markType?: "official" | "provisional" | "pending_recalculation";
  }>,
): boolean {
  return results.some((result) =>
    result.poolId !== 0 &&
    (result.status === "warning" || result.markType === "pending_recalculation")
  );
}

export async function runFullMtmRecalculation(input: {
  seasonYear: number;
  calcuttaId: number;
  trigger: "scheduled" | "manual";
}): Promise<number> {
  const locked = await withMtmLock(
    { seasonYear: input.seasonYear, calcuttaId: input.calcuttaId },
    async (lease) => {
      const result = await runMtmPipeline({
        seasonYear: input.seasonYear,
        calcuttaId: input.calcuttaId,
        trigger: input.trigger,
        lease,
      });
      if (result.status !== "ok" || result.currentSnapshotId == null) {
        throw new Error(result.error ?? "MTM recalculation failed.");
      }
      await lease.assertOwned();
      await validateAndPromoteCurrentMtm({
        poolId: result.poolId,
        sourceSnapshotId: result.currentSnapshotId,
        markType: "official",
        lease: { runId: lease.runId, ownerToken: lease.ownerToken },
      });
      return result.currentSnapshotId;
    },
  );
  if (!locked.acquired) throw new Error("An MTM calculation is already running.");
  return locked.value;
}

export async function recoverPendingMtmRecalculations(seasonYear: number): Promise<{
  attempted: number;
  recovered: number;
  skipped: number;
  warnings: string[];
}> {
  const pools = await db
    .select({ poolId: mtmValuationVersionTable.poolId })
    .from(mtmValuationVersionTable)
    .innerJoin(calcuttasTable, eq(calcuttasTable.id, mtmValuationVersionTable.poolId))
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .where(and(
      eq(seasonsTable.year, seasonYear),
      eq(calcuttasTable.sport, "NFL"),
      eq(calcuttasTable.isCanonical, true),
      eq(mtmValuationVersionTable.status, "current"),
      eq(mtmValuationVersionTable.markType, "pending_recalculation"),
    ))
    .groupBy(mtmValuationVersionTable.poolId);
  let attempted = 0;
  let recovered = 0;
  let skipped = 0;
  const warnings: string[] = [];
  const retryAfter = new Date(Date.now() - 5 * 60 * 1000);
  for (const { poolId } of pools) {
    const recentFailure = await db
      .select({ id: mtmJobRunsTable.runId })
      .from(mtmJobRunsTable)
      .where(and(
        eq(mtmJobRunsTable.poolId, poolId),
        eq(mtmJobRunsTable.status, "failed"),
        gt(mtmJobRunsTable.completedAt, retryAfter),
      ))
      .orderBy(desc(mtmJobRunsTable.completedAt))
      .limit(1);
    if (recentFailure.length > 0) {
      skipped += 1;
      continue;
    }
    attempted += 1;
    try {
      await runFullMtmRecalculation({
        seasonYear,
        calcuttaId: poolId,
        trigger: "scheduled",
      });
      recovered += 1;
    } catch (error) {
      warnings.push(`Pool ${poolId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { attempted, recovered, skipped, warnings };
}