import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { logger } from "../lib/logger";
import { resolveNflStandingsRefreshSeasonYear, runNflStandingsRefresh } from "../lib/nflStandingsRefresh";
import {
  fetchNflScheduleWithPayload,
  isNflGameInLiveStatusWindow,
  nflGameStatusSignature,
  type NflScheduledGame,
} from "../lib/nflSchedule";
import { recoverPendingMtmRecalculations } from "../lib/mtmRecalculation";
import {
  loadNflScheduleCache,
  persistNflScheduleCache,
  withRefreshJobLock,
  recordFailedRefresh,
  recordObservedGameStatus,
  recordRefreshAttempt,
  recordRefreshResult,
} from "../lib/nflRefreshState";
import { resolveSeasonIdForSport } from "../lib/calcuttaContext";

export const NFL_REFRESH_POLL_INTERVAL_MS = 5 * 60 * 1000;
const NFL_SCHEDULE_RECHECK_MS = 6 * 60 * 60 * 1000;

export function createNflRefreshPoller(
  runTick: () => Promise<void>,
  intervalMs = NFL_REFRESH_POLL_INTERVAL_MS,
): { runNow: () => Promise<void>; stop: () => void } {
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await runTick();
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => void tick(), intervalMs);
  interval.unref();
  return {
    runNow: tick,
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

export function startNflRefreshPoller(): () => void {
  let scheduleLoaded = false;
  let scheduleFetchedAt = 0;
  let cachedGames: NflScheduledGame[] = [];
  let activeScope: { seasonId: number; sport: "NFL"; competition: "NFL_REGULAR_SEASON" } | null = null;

  const tick = async (): Promise<void> => {
    activeScope = null;
    const seasonYear = await resolveNflStandingsRefreshSeasonYear();
    const seasonId = await resolveSeasonIdForSport(db, { year: seasonYear, sport: "NFL" });
    if (seasonId == null) throw new Error(`Season ${seasonYear} has no canonical NFL Calcutta.`);
    activeScope = { seasonId, sport: "NFL", competition: "NFL_REGULAR_SEASON" };
    await recordRefreshAttempt(activeScope);
    const recovery = await recoverPendingMtmRecalculations(seasonYear);
    if (recovery.warnings.length > 0) {
      logger.warn({ seasonYear, recovery }, "Pending MTM recovery remains incomplete");
    }
    const now = Date.now();
    let fetchedPayload: Awaited<ReturnType<typeof fetchNflScheduleWithPayload>>["payload"] | null = null;
    if (!scheduleLoaded) {
      const persisted = await loadNflScheduleCache(seasonId);
      if (persisted.games) cachedGames = persisted.games;
      scheduleLoaded = persisted.games !== null;
      scheduleFetchedAt = persisted.fetchedAt?.getTime() ?? 0;
    }
    if (!scheduleLoaded || now - scheduleFetchedAt >= NFL_SCHEDULE_RECHECK_MS) {
      const fetched = await fetchNflScheduleWithPayload(seasonYear);
      cachedGames = fetched.games;
      fetchedPayload = fetched.payload;
      scheduleLoaded = true;
      scheduleFetchedAt = now;
      await persistNflScheduleCache(seasonId, cachedGames);
    }
    if (!cachedGames.some((game) => isNflGameInLiveStatusWindow(game, now))) {
      await recordObservedGameStatus(activeScope, nflGameStatusSignature(cachedGames), false);
      await recordRefreshResult(activeScope, { ran: false, reason: "no-games-live" });
      return;
    }

    const fresh = fetchedPayload
      ? { games: cachedGames, payload: fetchedPayload }
      : await fetchNflScheduleWithPayload(seasonYear);
    cachedGames = fresh.games;
    scheduleLoaded = true;
    scheduleFetchedAt = now;
    await persistNflScheduleCache(seasonId, cachedGames);
    const locked = await withRefreshJobLock(
      () => runNflStandingsRefresh({
        requestedBy: "in_process_refresh_poller",
        requestId: randomUUID(),
        seasonYear,
        eventPayload: fresh.payload,
        runMtmInline: true,
      }),
      { seasonId, sport: "NFL", competition: "NFL_REGULAR_SEASON" },
    );
    if (!locked.acquired) {
      await recordRefreshResult(activeScope, { ran: false, reason: "already-running" });
      return;
    }
    await recordObservedGameStatus(activeScope, nflGameStatusSignature(fresh.games), true);
    await recordRefreshResult(activeScope, locked.value as Record<string, unknown>);
  };

  const controller = createNflRefreshPoller(async () => {
    try {
      await tick();
    } catch (error) {
      if (activeScope) await recordFailedRefresh(activeScope, error).catch(() => undefined);
      logger.warn({
        error: error instanceof Error ? error.message : String(error),
      }, "NFL in-process refresh tick failed");
    }
  });
  void controller.runNow();
  return controller.stop;
}