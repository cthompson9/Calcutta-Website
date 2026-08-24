import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  importRunsTable,
  pool,
  seasonsTable,
} from "@workspace/db";
import { NFL_STANDINGS_SOURCE } from "../lib/nflStandingsImport";
import {
  resolveNflStandingsRefreshSeasonYear,
  runNflStandingsRefresh,
} from "../lib/nflStandingsRefresh";
import {
  loadCachedNflSchedule,
  shouldRunStandingsRefresh,
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

async function lastSuccessfulStandingsRunAt(
  seasonYear: number,
): Promise<Date | null> {
  const rows = await db
    .select({ createdAt: importRunsTable.createdAt })
    .from(importRunsTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, importRunsTable.seasonId))
    .where(
      and(
        eq(seasonsTable.year, seasonYear),
        eq(importRunsTable.source, NFL_STANDINGS_SOURCE),
      ),
    )
    .orderBy(desc(importRunsTable.createdAt))
    .limit(1);
  return rows[0]?.createdAt ?? null;
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
      const lastSuccessfulRunAt = await lastSuccessfulStandingsRunAt(seasonYear);
      const games = parsed.data.force
        ? []
        : await loadCachedNflSchedule(seasonYear, startedAtMs);

      if (
        !shouldRunStandingsRefresh({
          force: parsed.data.force,
          games,
          lastSuccessfulRunAt,
          nowMs: startedAtMs,
        })
      ) {
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