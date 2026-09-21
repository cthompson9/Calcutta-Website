import { createHash } from "node:crypto";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import {
  calcuttasTable,
  db,
  eventsTable,
  mtmActualsRequestTable,
  snapshotMetricsTable,
} from "@workspace/db";

type RevisionEvent = {
  eventId?: number | string | null;
  week?: number | string | null;
  homeTeamId?: number | string | null;
  awayTeamId?: number | string | null;
  homeScore?: number | string | null;
  awayScore?: number | string | null;
  status?: string | null;
  result?: string | null;
};

type RevisionMetric = {
  teamId?: number | string | null;
  period?: number | string | null;
  metric?: string | null;
  value?: number | string | null;
};

export type MtmActualsRevisionInput = {
  events?: RevisionEvent[];
  metrics?: RevisionMetric[];
  schedule?: Array<{
    eventId?: number | string | null;
    week?: number | string | null;
    status?: string | null;
    kickoffAt?: string | null;
  }>;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/^(fetchedAt|sourceFetchedAt|provider|sourceUrl|sourceData|metadata)$/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Hashes only canonical valuation inputs; transport metadata never creates work. */
export function hashMtmActualsRevision(input: MtmActualsRevisionInput): string {
  const canonical = {
    events: (input.events ?? []).map((event) => ({
      eventId: event.eventId ?? null,
      week: event.week ?? null,
      homeTeamId: event.homeTeamId ?? null,
      awayTeamId: event.awayTeamId ?? null,
      homeScore: event.homeScore ?? null,
      awayScore: event.awayScore ?? null,
      status: event.status ?? null,
      result: event.result ?? null,
    })),
    metrics: (input.metrics ?? []).map((metric) => ({
      teamId: metric.teamId ?? null,
      period: metric.period ?? null,
      metric: metric.metric ?? null,
      value: metric.value ?? null,
    })),
    schedule: (input.schedule ?? []).map((game) => ({
      eventId: game.eventId ?? null,
      week: game.week ?? null,
      status: game.status ?? null,
      kickoffAt: game.kickoffAt ?? null,
    })),
  };
  return createHash("sha256").update(stable(canonical)).digest("hex");
}

export async function currentNflActualsRevision(seasonId: number): Promise<string> {
  const [events, metrics] = await Promise.all([
    db.select({
      eventId: eventsTable.id,
      week: eventsTable.week,
      homeTeamId: eventsTable.homeTeamId,
      awayTeamId: eventsTable.awayTeamId,
      homeScore: eventsTable.homeScore,
      awayScore: eventsTable.awayScore,
      status: eventsTable.status,
    }).from(eventsTable).where(eq(eventsTable.seasonId, seasonId)),
    db.select({
      teamId: snapshotMetricsTable.entryId,
      period: snapshotMetricsTable.periodId,
      metric: snapshotMetricsTable.metric,
      value: snapshotMetricsTable.value,
    }).from(snapshotMetricsTable)
      .innerJoin(calcuttasTable, eq(calcuttasTable.id, snapshotMetricsTable.calcuttaId))
      .where(and(
        eq(calcuttasTable.seasonId, seasonId),
        eq(snapshotMetricsTable.basis, "realized"),
      )),
  ]);
  return hashMtmActualsRevision({ events, metrics });
}

export function shouldQueueMtmRevision(
  current: { requestedRevision: string; completedRevision: string | null } | null,
  revision: string,
): boolean {
  return current == null || current.requestedRevision !== revision || current.completedRevision !== revision;
}

export async function requestMtmRecalculationAfterActualsCommit(args: {
  seasonId: number;
  revision: string;
}): Promise<{ queued: number; unchanged: number; poolIds: number[] }> {
  const pools = await db
    .select({ id: calcuttasTable.id })
    .from(calcuttasTable)
    .where(and(
      eq(calcuttasTable.seasonId, args.seasonId),
      eq(calcuttasTable.sport, "NFL"),
      eq(calcuttasTable.isCanonical, true),
    ));
  let queued = 0;
  let unchanged = 0;
  const poolIds: number[] = [];
  for (const pool of pools) {
    const existing = await db
      .select({
        requestedRevision: mtmActualsRequestTable.requestedRevision,
        completedRevision: mtmActualsRequestTable.completedRevision,
      })
      .from(mtmActualsRequestTable)
      .where(eq(mtmActualsRequestTable.poolId, pool.id))
      .limit(1);
    if (!shouldQueueMtmRevision(existing[0] ?? null, args.revision)) {
      unchanged += 1;
      continue;
    }
    const now = new Date();
    if (existing.length === 0) {
      await db.insert(mtmActualsRequestTable).values({
        poolId: pool.id,
        requestedRevision: args.revision,
        status: "pending",
        requestedAt: now,
        updatedAt: now,
      });
    } else {
      await db.update(mtmActualsRequestTable)
        .set({
          requestedRevision: args.revision,
          status: "pending",
          nextAttemptAt: null,
          lastError: null,
          requestedAt: now,
          updatedAt: now,
        })
        .where(eq(mtmActualsRequestTable.poolId, pool.id));
    }
    queued += 1;
    poolIds.push(pool.id);
  }
  return { queued, unchanged, poolIds };
}

export async function processPendingMtmActualsRecalculations(args: {
  poolIds?: number[];
  currentRevision: (poolId: number) => Promise<string>;
  run: (poolId: number) => Promise<void>;
}): Promise<{ completed: number; deferred: number; failed: number }> {
  const now = new Date();
  const rows = await db
    .select()
    .from(mtmActualsRequestTable)
    .where(and(
      args.poolIds?.length ? inArray(mtmActualsRequestTable.poolId, args.poolIds) : sql`true`,
      or(eq(mtmActualsRequestTable.status, "pending"), eq(mtmActualsRequestTable.status, "failed")),
      or(sql`${mtmActualsRequestTable.nextAttemptAt} is null`, lte(mtmActualsRequestTable.nextAttemptAt, now)),
    ));
  let completed = 0;
  let deferred = 0;
  let failed = 0;
  for (const row of rows) {
    const before = await args.currentRevision(row.poolId);
    if (before !== row.requestedRevision) {
      deferred += 1;
      continue;
    }
    await db.update(mtmActualsRequestTable).set({
      status: "running",
      attempts: row.attempts + 1,
      updatedAt: new Date(),
    }).where(eq(mtmActualsRequestTable.poolId, row.poolId));
    try {
      await args.run(row.poolId);
      const after = await args.currentRevision(row.poolId);
      if (after !== row.requestedRevision) {
        await db.update(mtmActualsRequestTable).set({
          status: "pending",
          requestedRevision: after,
          updatedAt: new Date(),
        }).where(eq(mtmActualsRequestTable.poolId, row.poolId));
        deferred += 1;
      } else {
        await db.update(mtmActualsRequestTable).set({
          status: "completed",
          completedRevision: row.requestedRevision,
          completedAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
          updatedAt: new Date(),
        }).where(eq(mtmActualsRequestTable.poolId, row.poolId));
        completed += 1;
      }
    } catch (error) {
      const attempts = row.attempts + 1;
      const delayMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(attempts, 7));
      const message = error instanceof Error ? error.message : String(error);
      const contended = /already running|lock contention|lease/i.test(message);
      await db.update(mtmActualsRequestTable).set({
        status: contended ? "pending" : "failed",
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastError: message,
        updatedAt: new Date(),
      }).where(eq(mtmActualsRequestTable.poolId, row.poolId));
      if (contended) deferred += 1;
      else failed += 1;
    }
  }
  return { completed, deferred, failed };
}