import { and, eq } from "drizzle-orm";
import { db, pool, refreshJobStatesTable } from "@workspace/db";
import { parseCachedNflSchedule, type NflScheduledGame } from "./nflSchedule";

export type NflRefreshLockScope = {
  seasonId: number;
  sport: "NFL" | "CFB";
  competition: string;
};

export function refreshJobLockKey(
  scope?: NflRefreshLockScope,
): readonly [number, number] {
  if (!scope) return [7_142, 64];
  let hash = 2_166_136_261;
  for (const character of `${scope.sport}\0${scope.competition}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return [hash & 0x7fff_ffff, scope.seasonId];
}

export async function withRefreshJobLock<T>(
  run: () => Promise<T>,
  scope?: NflRefreshLockScope,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const [lockNamespace, lockKey] = refreshJobLockKey(scope);
  const client = await pool.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1, $2) as acquired",
      [lockNamespace, lockKey],
    );
    if (!lock.rows[0]?.acquired) return { acquired: false };
    try {
      return { acquired: true, value: await run() };
    } finally {
      await client.query("select pg_advisory_unlock($1, $2)", [lockNamespace, lockKey]);
    }
  } finally {
    client.release();
  }
}

export async function loadNflScheduleCache(seasonId: number): Promise<{
  games: NflScheduledGame[] | null;
  fetchedAt: Date | null;
}> {
  const rows = await db
    .select({
      scheduleCache: refreshJobStatesTable.scheduleCache,
      scheduleFetchedAt: refreshJobStatesTable.scheduleFetchedAt,
    })
    .from(refreshJobStatesTable)
    .where(and(
      eq(refreshJobStatesTable.seasonId, seasonId),
      eq(refreshJobStatesTable.sport, "NFL"),
      eq(refreshJobStatesTable.competition, "NFL_REGULAR_SEASON"),
      eq(refreshJobStatesTable.job, "standings"),
    ))
    .limit(1);
  const row = rows[0];
  const games = parseCachedNflSchedule(row?.scheduleCache);
  if (!row || !games) {
    return { games: null, fetchedAt: row?.scheduleFetchedAt ?? null };
  }
  return {
    games,
    fetchedAt: row.scheduleFetchedAt ?? null,
  };
}

export async function persistNflScheduleCache(
  seasonId: number,
  games: NflScheduledGame[],
  fetchedAt = new Date(),
): Promise<void> {
  await db
    .insert(refreshJobStatesTable)
    .values({
      seasonId,
      sport: "NFL",
      competition: "NFL_REGULAR_SEASON",
      job: "standings",
      scheduleCache: games,
      scheduleFetchedAt: fetchedAt,
      updatedAt: fetchedAt,
    })
    .onConflictDoUpdate({
      target: [
        refreshJobStatesTable.seasonId,
        refreshJobStatesTable.sport,
        refreshJobStatesTable.competition,
        refreshJobStatesTable.job,
      ],
      set: {
        scheduleCache: games,
        scheduleFetchedAt: fetchedAt,
        updatedAt: fetchedAt,
      },
    });
}

export type NflRefreshStateScope = NflRefreshLockScope & { job?: "standings" };

export async function recordRefreshAttempt(scope: NflRefreshStateScope): Promise<void> {
  const now = new Date();
  await db.insert(refreshJobStatesTable).values({
    seasonId: scope.seasonId, sport: scope.sport, competition: scope.competition,
    job: scope.job ?? "standings", lastAttemptedAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [refreshJobStatesTable.seasonId, refreshJobStatesTable.sport,
      refreshJobStatesTable.competition, refreshJobStatesTable.job],
    set: { lastAttemptedAt: now, updatedAt: now },
  });
}

export async function recordFailedRefresh(scope: NflRefreshStateScope, error: unknown): Promise<void> {
  const now = new Date();
  const message = error instanceof Error ? error.message : String(error);
  await db.insert(refreshJobStatesTable).values({
    seasonId: scope.seasonId, sport: scope.sport, competition: scope.competition,
    job: scope.job ?? "standings", lastAttemptedAt: now, lastFailedAt: now,
    lastError: message, lastResult: { status: "failed", error: message }, updatedAt: now,
  }).onConflictDoUpdate({
    target: [refreshJobStatesTable.seasonId, refreshJobStatesTable.sport,
      refreshJobStatesTable.competition, refreshJobStatesTable.job],
    set: {
      lastAttemptedAt: now, lastFailedAt: now, lastError: message,
      lastResult: { status: "failed", error: message }, updatedAt: now,
    },
  });
}

export async function recordRefreshResult(
  scope: NflRefreshStateScope,
  result: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db.update(refreshJobStatesTable).set({
    lastResult: result, updatedAt: now,
  }).where(and(
    eq(refreshJobStatesTable.seasonId, scope.seasonId),
    eq(refreshJobStatesTable.sport, scope.sport),
    eq(refreshJobStatesTable.competition, scope.competition),
    eq(refreshJobStatesTable.job, scope.job ?? "standings"),
  ));
}

export async function recordObservedGameStatus(
  scope: NflRefreshStateScope,
  statusSignature: string,
  succeededAt: boolean,
): Promise<void> {
  const now = new Date();
  await db.insert(refreshJobStatesTable).values({
    seasonId: scope.seasonId, sport: scope.sport, competition: scope.competition,
    job: scope.job ?? "standings", lastGameStatusSignature: statusSignature,
    ...(succeededAt ? { lastSucceededAt: now } : {}), updatedAt: now,
  }).onConflictDoUpdate({
    target: [refreshJobStatesTable.seasonId, refreshJobStatesTable.sport,
      refreshJobStatesTable.competition, refreshJobStatesTable.job],
    set: {
      lastGameStatusSignature: statusSignature,
      ...(succeededAt ? { lastSucceededAt: now } : {}),
      updatedAt: now,
    },
  });
}