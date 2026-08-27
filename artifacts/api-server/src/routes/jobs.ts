import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, pool, refreshJobStatesTable } from "@workspace/db";
import { runCanonicalMtmRefresh } from "../lib/jobMtmRefresh";
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

const router: IRouter = Router();
const JOB_LOCK_NAMESPACE = 7_142;
const JOB_LOCK_KEY = 64;

const RefreshJobBody = z
  .object({
    job: z.enum(["standings", "mtm"]).default("standings"),
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
      lastSucceededAt: refreshJobStatesTable.lastSucceededAt,
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
      lastSucceededAt: now,
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
        lastSucceededAt: now,
        updatedAt: now,
      },
    });
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
    res.status(401).json({ error: "JOB_RUNNER_SECRET bearer token is required." });
    return;
  }

  const parsed = RefreshJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const startedAtMs = Date.now();
  const job = parsed.data.job;
  try {
    const sport = parsed.data.sport;
    const competition = parsed.data.competition ??
      (sport === CFB_SPORT ? CFB_REGULAR_SEASON : NFL_REGULAR_SEASON);
    const expectedCompetition =
      sport === CFB_SPORT ? CFB_REGULAR_SEASON : NFL_REGULAR_SEASON;
    if (competition !== expectedCompetition) {
      res.status(400).json({
        error: `${sport} refreshes require competition ${expectedCompetition}.`,
      });
      return;
    }
    if (sport === CFB_SPORT && job === "mtm") {
      res.status(400).json({ error: "CFB MTM refresh is not supported by this job." });
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
    const scope: RefreshScope = { seasonId, sport, competition };

    const locked = await withRefreshJobLock(async () => {
      if (job === "mtm") {
        const result = await runCanonicalMtmRefresh({ seasonYear });
        return {
          job,
          ...result,
          durationMs: Date.now() - startedAtMs,
        };
      }

      if (sport === CFB_SPORT) {
        const result = await runCfbEventRefresh({
          seasonId,
          seasonYear,
        });
        await recordSuccessfulStandingsRefresh(scope);
        return {
          job: "standings" as const,
          sport,
          competition,
          ran: true,
          eventsUpdated: result.eventsUpserted,
          durationMs: Date.now() - startedAtMs,
        };
      }

      const refreshState = await loadRefreshJobState(scope);
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
        await saveScheduleCache(scope, cachedGames);
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
          await recordObservedGameStatus(scope, statusSignature, false);
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
        await recordObservedGameStatus(scope, statusSignature, true);
      } else {
        await recordSuccessfulStandingsRefresh(scope);
      }
      return {
        job: "standings" as const,
        ran: true,
        reason: result.replay ? ("already-current" as const) : undefined,
        teamsUpdated: result.importedTeams,
        durationMs: Date.now() - startedAtMs,
      };
    }, scope);

    if (!locked.acquired) {
      res.json({
        job,
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
      "External refresh job failed",
    );
    res.status(500).json({
      job,
      ran: false,
      error: error instanceof Error ? error.message : "Refresh job failed.",
      durationMs: Date.now() - startedAtMs,
    });
  }
});

export default router;