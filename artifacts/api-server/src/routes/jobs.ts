import { timingSafeEqual } from "node:crypto";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";
import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, pool, refreshJobStatesTable } from "@workspace/db";
import {
  resolveNflStandingsRefreshSeasonYear,
  runNflStandingsRefresh,
} from "../lib/nflStandingsRefresh";
import {
  resolveCfbRefreshSeasonYear,
  runCfbEventRefresh,
} from "../lib/cfbEventSync";
import {
  CFB_REGULAR_SEASON,
  CFB_SPORT,
  NFL_REGULAR_SEASON,
  NFL_SPORT,
  type EventCompetition,
  type EventSport,
} from "../lib/eventIngestion";
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
import { resolveSeasonIdForSport } from "../lib/calcuttaContext";
import { RefreshNflStandingsJobResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const JOB_LOCK_NAMESPACE = 7_142;
const JOB_LOCK_KEY = 64;

const RefreshJobBody = z
  .object({
    job: z.literal("standings").default("standings"),
    force: z.boolean().optional().default(false),
    sport: z.enum([NFL_SPORT, CFB_SPORT]).optional().default(NFL_SPORT),
    competition: z.string().trim().min(1).max(80).optional(),
    seasonYear: z.number().int().min(2000).max(2200).optional(),
  })
  .strict();

type RefreshScope = {
  seasonId: number;
  sport: EventSport;
  competition: EventCompetition;
};

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

async function loadRefreshJobState(scope: RefreshScope) {
  const rows = await db
    .select({
      scheduleCache: refreshJobStatesTable.scheduleCache,
      scheduleFetchedAt: refreshJobStatesTable.scheduleFetchedAt,
      lastGameStatusSignature: refreshJobStatesTable.lastGameStatusSignature,
      lastAttemptedAt: refreshJobStatesTable.lastAttemptedAt,
      lastSucceededAt: refreshJobStatesTable.lastSucceededAt,
      lastFailedAt: refreshJobStatesTable.lastFailedAt,
      lastError: refreshJobStatesTable.lastError,
      lastResult: refreshJobStatesTable.lastResult,
    })
    .from(refreshJobStatesTable)
    .where(
      and(
        eq(refreshJobStatesTable.seasonId, scope.seasonId),
        eq(refreshJobStatesTable.sport, scope.sport),
        eq(refreshJobStatesTable.competition, scope.competition),
        eq(refreshJobStatesTable.job, "standings"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function saveScheduleCache(
  scope: RefreshScope,
  games: NflScheduledGame[],
): Promise<void> {
  const now = new Date();
  await db
    .insert(refreshJobStatesTable)
    .values({
      seasonId: scope.seasonId,
      sport: scope.sport,
      competition: scope.competition,
      job: "standings",
      scheduleCache: games,
      scheduleFetchedAt: now,
      updatedAt: now,
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
        scheduleFetchedAt: now,
        updatedAt: now,
      },
    });
}

async function recordSuccessfulStandingsRefresh(scope: RefreshScope): Promise<void> {
  const now = new Date();
  await db
    .insert(refreshJobStatesTable)
    .values({
      seasonId: scope.seasonId,
      sport: scope.sport,
      competition: scope.competition,
      job: "standings",
      lastAttemptedAt: now,
      lastSucceededAt: now,
      lastError: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        refreshJobStatesTable.seasonId,
        refreshJobStatesTable.sport,
        refreshJobStatesTable.competition,
        refreshJobStatesTable.job,
      ],
      set: {
        lastAttemptedAt: now,
        lastSucceededAt: now,
        lastError: null,
        updatedAt: now,
      },
    });
}

async function recordRefreshAttempt(scope: RefreshScope): Promise<void> {
  const now = new Date();
  await db
    .insert(refreshJobStatesTable)
    .values({
      seasonId: scope.seasonId,
      sport: scope.sport,
      competition: scope.competition,
      job: "standings",
      lastAttemptedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        refreshJobStatesTable.seasonId,
        refreshJobStatesTable.sport,
        refreshJobStatesTable.competition,
        refreshJobStatesTable.job,
      ],
      set: { lastAttemptedAt: now, updatedAt: now },
    });
}

async function recordFailedRefresh(
  scope: RefreshScope,
  error: unknown,
): Promise<void> {
  const now = new Date();
  const message = error instanceof Error ? error.message : String(error);
  await db
    .insert(refreshJobStatesTable)
    .values({
      seasonId: scope.seasonId,
      sport: scope.sport,
      competition: scope.competition,
      job: "standings",
      lastAttemptedAt: now,
      lastFailedAt: now,
      lastError: message,
      lastResult: { status: "failed", error: message },
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        refreshJobStatesTable.seasonId,
        refreshJobStatesTable.sport,
        refreshJobStatesTable.competition,
        refreshJobStatesTable.job,
      ],
      set: {
        lastAttemptedAt: now,
        lastFailedAt: now,
        lastError: message,
        lastResult: { status: "failed", error: message },
        updatedAt: now,
      },
    });
}

async function recordRefreshResult(
  scope: RefreshScope,
  result: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db
    .update(refreshJobStatesTable)
    .set({
      lastResult: result,
      updatedAt: now,
    })
    .where(and(
      eq(refreshJobStatesTable.seasonId, scope.seasonId),
      eq(refreshJobStatesTable.sport, scope.sport),
      eq(refreshJobStatesTable.competition, scope.competition),
      eq(refreshJobStatesTable.job, "standings"),
    ));
}

async function recordObservedGameStatus(
  scope: RefreshScope,
  statusSignature: string,
  succeededAt: boolean,
): Promise<void> {
  const now = new Date();
  await db
    .insert(refreshJobStatesTable)
    .values({
      seasonId: scope.seasonId,
      sport: scope.sport,
      competition: scope.competition,
      job: "standings",
      lastGameStatusSignature: statusSignature,
      lastSucceededAt: succeededAt ? now : undefined,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        refreshJobStatesTable.seasonId,
        refreshJobStatesTable.sport,
        refreshJobStatesTable.competition,
        refreshJobStatesTable.job,
      ],
      set: {
        lastGameStatusSignature: statusSignature,
        ...(succeededAt ? { lastSucceededAt: now } : {}),
        updatedAt: now,
      },
    });
}

export function refreshJobLockKey(
  scope?: RefreshScope,
): readonly [number, number] {
  if (!scope) return [JOB_LOCK_NAMESPACE, JOB_LOCK_KEY];
  let hash = 2_166_136_261;
  for (const character of `${scope.sport}\0${scope.competition}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return [hash & 0x7fff_ffff, scope.seasonId];
}

export async function withRefreshJobLock<T>(
  run: () => Promise<T>,
  scope?: RefreshScope,
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
      await client.query("select pg_advisory_unlock($1, $2)", [
        lockNamespace,
        lockKey,
      ]);
    }
  } finally {
    client.release();
  }
}

router.post("/jobs/refresh", async (req, res): Promise<void> => {
  if (!isJobRunnerRequest(req)) {
    sendParsedJson(res, ErrorResponse, { error: "JOB_RUNNER_SECRET bearer token is required." }, 401);
    return;
  }

  const parsed = RefreshJobBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }

  const startedAtMs = Date.now();
  const job = parsed.data.job;
  let scope: RefreshScope | null = null;
  try {
    const sport = parsed.data.sport;
    const competition = parsed.data.competition ??
      (sport === CFB_SPORT ? CFB_REGULAR_SEASON : NFL_REGULAR_SEASON);
    const expectedCompetition =
      sport === CFB_SPORT ? CFB_REGULAR_SEASON : NFL_REGULAR_SEASON;
    if (competition !== expectedCompetition) {
      sendParsedJson(res, ErrorResponse, {
        error: `${sport} refreshes require competition ${expectedCompetition}.`,
      }, 400);
      return;
    }
    const seasonYear = parsed.data.seasonYear ??
      (sport === CFB_SPORT
        ? await resolveCfbRefreshSeasonYear()
        : await resolveNflStandingsRefreshSeasonYear());
    const seasonId = await resolveSeasonIdForSport(db, { year: seasonYear, sport });
    if (seasonId == null) {
      throw new Error(`Season ${seasonYear} has no canonical ${sport} Calcutta.`);
    }
    const resolvedScope: RefreshScope = { seasonId, sport, competition };
    scope = resolvedScope;
    await recordRefreshAttempt(resolvedScope);

    const locked = await withRefreshJobLock(async () => {
      if (sport === CFB_SPORT) {
        const result = await runCfbEventRefresh({
          seasonId,
          seasonYear,
        });
        await recordSuccessfulStandingsRefresh(resolvedScope);
        return {
          job: "standings" as const,
          sport,
          competition,
          ran: true,
          eventsUpdated: result.eventsUpserted,
          durationMs: Date.now() - startedAtMs,
        };
      }

      const refreshState = await loadRefreshJobState(resolvedScope);
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
        await saveScheduleCache(resolvedScope, cachedGames);
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
          await recordObservedGameStatus(resolvedScope, statusSignature, false);
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
        seasonYear,
      });
      if (statusSignature !== null) {
        await recordObservedGameStatus(resolvedScope, statusSignature, true);
      } else {
        await recordSuccessfulStandingsRefresh(resolvedScope);
      }
      return {
        job: "standings" as const,
        ran: true,
        reason: result.replay ? ("already-current" as const) : undefined,
        teamsUpdated: result.importedTeams,
        mtmReconciliation: result.mtmReconciliation,
        durationMs: Date.now() - startedAtMs,
      };
    }, resolvedScope);

    if (!locked.acquired) {
      sendParsedJson(res, RefreshNflStandingsJobResponse, {
        job,
        ran: false,
        reason: "already-running",
        durationMs: Date.now() - startedAtMs,
      });
      return;
    }

    await recordRefreshResult(resolvedScope, locked.value);
    sendParsedJson(res, RefreshNflStandingsJobResponse, locked.value);
  } catch (error) {
    if (scope) {
      await recordFailedRefresh(scope, error).catch((recordError) => {
        req.log.error(
          { error: recordError instanceof Error ? recordError.message : String(recordError) },
          "Failed to persist external refresh failure",
        );
      });
    }
    req.log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "External refresh job failed",
    );
    sendParsedJson(res, ErrorResponse, {
      job,
      ran: false,
      error: "Refresh job failed.",
      durationMs: Date.now() - startedAtMs,
    }, 500);
  }
});

export default router;