import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  pool,
  refreshJobStatesTable,
  seasonsTable,
} from "@workspace/db";
import {
  resolveNflStandingsRefreshSeasonYear,
  runNflStandingsRefresh,
} from "../lib/nflStandingsRefresh";
import {
  fetchNflSchedule,
  isNflGameInLiveStatusWindow,
  needsFreshNflGameStatus,
  nflGameStatusSignature,
  parseCachedNflSchedule,
  shouldRefreshNflScheduleCache,
  shouldRunStandingsRefresh,
  type NflScheduledGame,
} from "../lib/nflSchedule";

const router: IRouter = Router();
const JOB_LOCK_NAMESPACE = 7_142;
const JOB_LOCK_KEY = 64;

const RefreshJobBody = z
  .object({
    job: z.literal("standings").default("standings"),
    force: z.boolean().optional().default(false),
  })
  .strict();

export function isJobRunnerRequest(req: Pick<Request, "headers">): boolean {
  const expected = process.env["JOB_RUNNER_SECRET"];
  const authorization = req.headers.authorization;
  if (!expected || typeof authorization !== "string") return false;
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);
  return (
    expectedBuffer.length === tokenBuffer.length &&
    timingSafeEqual(expectedBuffer, tokenBuffer)
  );
}

async function loadRefreshJobState(seasonId: number) {
  const rows = await db
    .select({
      scheduleCache: refreshJobStatesTable.scheduleCache,
      scheduleFetchedAt: refreshJobStatesTable.scheduleFetchedAt,
      lastGameStatusSignature: refreshJobStatesTable.lastGameStatusSignature,
      lastSucceededAt: refreshJobStatesTable.lastSucceededAt,
    })
    .from(refreshJobStatesTable)
    .where(
      and(
        eq(refreshJobStatesTable.seasonId, seasonId),
        eq(refreshJobStatesTable.job, "standings"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function saveScheduleCache(
  seasonId: number,
  games: NflScheduledGame[],
): Promise<void> {
  const now = new Date();
  await db
    .insert(refreshJobStatesTable)
    .values({
      seasonId,
      job: "standings",
      scheduleCache: games,
      scheduleFetchedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [refreshJobStatesTable.seasonId, refreshJobStatesTable.job],
      set: {
        scheduleCache: games,
        scheduleFetchedAt: now,
        updatedAt: now,
      },
    });
}

async function recordSuccessfulStandingsRefresh(seasonId: number): Promise<void> {
  const now = new Date();
  await db
    .insert(refreshJobStatesTable)
    .values({
      seasonId,
      job: "standings",
      lastSucceededAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [refreshJobStatesTable.seasonId, refreshJobStatesTable.job],
      set: {
        lastSucceededAt: now,
        updatedAt: now,
      },
    });
}

async function recordObservedGameStatus(
  seasonId: number,
  statusSignature: string,
  succeededAt: boolean,
): Promise<void> {
  const now = new Date();
  await db
    .insert(refreshJobStatesTable)
    .values({
      seasonId,
      job: "standings",
      lastGameStatusSignature: statusSignature,
      lastSucceededAt: succeededAt ? now : undefined,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [refreshJobStatesTable.seasonId, refreshJobStatesTable.job],
      set: {
        lastGameStatusSignature: statusSignature,
        ...(succeededAt ? { lastSucceededAt: now } : {}),
        updatedAt: now,
      },
    });
}

async function withRefreshJobLock<T>(
  run: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1, $2) as acquired",
      [JOB_LOCK_NAMESPACE, JOB_LOCK_KEY],
    );
    if (!lock.rows[0]?.acquired) return { acquired: false };
    try {
      return { acquired: true, value: await run() };
    } finally {
      await client.query("select pg_advisory_unlock($1, $2)", [
        JOB_LOCK_NAMESPACE,
        JOB_LOCK_KEY,
      ]);
    }
  } finally {
    client.release();
  }
}

router.post("/jobs/refresh", async (req, res): Promise<void> => {
  if (!isJobRunnerRequest(req)) {
    res.status(401).json({ error: "JOB_RUNNER_SECRET bearer token is required." });
    return;
  }

  const parsed = RefreshJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const startedAtMs = Date.now();
  try {
    const locked = await withRefreshJobLock(async () => {
      const seasonYear = await resolveNflStandingsRefreshSeasonYear();
      const seasonRows = await db
        .select({ id: seasonsTable.id })
        .from(seasonsTable)
        .where(eq(seasonsTable.year, seasonYear))
        .limit(1);
      const season = seasonRows[0];
      if (!season) throw new Error(`Season ${seasonYear} not found.`);

      const refreshState = await loadRefreshJobState(season.id);
      let cachedGames = parsed.data.force
        ? []
        : parseCachedNflSchedule(refreshState?.scheduleCache);
      let refreshedSchedule = false;
      if (
        !parsed.data.force &&
        (!cachedGames ||
          shouldRefreshNflScheduleCache(
            refreshState?.scheduleFetchedAt ?? null,
            startedAtMs,
          ))
      ) {
        cachedGames = await fetchNflSchedule(seasonYear);
        await saveScheduleCache(season.id, cachedGames);
        refreshedSchedule = true;
      }
      const freshStatusGames =
        !parsed.data.force && needsFreshNflGameStatus(cachedGames ?? [], startedAtMs)
          ? refreshedSchedule
            ? cachedGames ?? []
            : await fetchNflSchedule(seasonYear)
          : [];
      const games = freshStatusGames.filter((game) =>
        isNflGameInLiveStatusWindow(game, startedAtMs),
      );
      const statusSignature =
        freshStatusGames.length > 0 ? nflGameStatusSignature(games) : null;

      if (
        !shouldRunStandingsRefresh({
          force: parsed.data.force,
          games,
          lastSuccessfulRunAt: refreshState?.lastSucceededAt ?? null,
          lastGameStatusSignature:
            refreshState?.lastGameStatusSignature ?? null,
          nowMs: startedAtMs,
        })
      ) {
        if (statusSignature !== null) {
          await recordObservedGameStatus(season.id, statusSignature, false);
        }
        return {
          job: "standings" as const,
          ran: false,
          reason: "no-games-live" as const,
          durationMs: Date.now() - startedAtMs,
        };
      }

      const result = await runNflStandingsRefresh({
        requestedBy: "external_job_runner",
        requestId: req.headers["x-request-id"] as string | undefined ?? randomUUID(),
      });
      if (statusSignature !== null) {
        await recordObservedGameStatus(season.id, statusSignature, true);
      } else {
        await recordSuccessfulStandingsRefresh(season.id);
      }
      return {
        job: "standings" as const,
        ran: true,
        reason: result.replay ? ("already-current" as const) : undefined,
        teamsUpdated: result.importedTeams,
        durationMs: Date.now() - startedAtMs,
      };
    });

    if (!locked.acquired) {
      res.json({
        job: "standings",
        ran: false,
        reason: "already-running",
        durationMs: Date.now() - startedAtMs,
      });
      return;
    }

    res.json(locked.value);
  } catch (error) {
    req.log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "External standings refresh failed",
    );
    res.status(500).json({
      error: error instanceof Error ? error.message : "Standings refresh failed.",
    });
  }
});

export default router;