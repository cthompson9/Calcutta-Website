import { db } from "@workspace/db";
import { logger } from "../lib/logger";
import { resolveNflStandingsRefreshSeasonYear } from "../lib/nflStandingsRefresh";
import {
  fetchTodayNflScheduleWithPayload,
  hasNewlyCompletedNflGame,
  isNflGameInPostKickoffPollingWindow,
  nflGameStatusSignature,
  type NflScheduledGame,
} from "../lib/nflSchedule";
import { runFullMtmRecalculation } from "../lib/mtmRecalculation";
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
import { syncNflEventsAndRealizedMetrics } from "../lib/nflEventSync";
import { reconcileNflCurrentMtm } from "../lib/currentMtm";
import { todayInNewYork } from "../lib/newYorkTime";

export const NFL_REFRESH_POLL_INTERVAL_MS = 5 * 60 * 1000;

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
    const now = Date.now();
    if (!scheduleLoaded) {
      const persisted = await loadNflScheduleCache(seasonId);
      if (persisted.games) cachedGames = persisted.games;
      scheduleLoaded = persisted.games !== null;
      scheduleFetchedAt = persisted.fetchedAt?.getTime() ?? 0;
    }
    const today = todayInNewYork(new Date(now));
    let previousGames = cachedGames;
    let fetchedToday: Awaited<ReturnType<typeof fetchTodayNflScheduleWithPayload>> | null = null;
    if (
      !scheduleLoaded ||
      !scheduleFetchedAt ||
      todayInNewYork(new Date(scheduleFetchedAt)) !== today
    ) {
      fetchedToday = await fetchTodayNflScheduleWithPayload(new Date(now));
      const fetched = fetchedToday;
      previousGames = cachedGames;
      cachedGames = fetched.games;
      scheduleLoaded = true;
      scheduleFetchedAt = now;
      await persistNflScheduleCache(seasonId, cachedGames);
    }
    const initialFetchFoundNewFinal = fetchedToday
      ? hasNewlyCompletedNflGame(previousGames, fetchedToday.games)
      : false;
    if (
      cachedGames.length === 0 ||
      (cachedGames.every((game) => game.completed) && !initialFetchFoundNewFinal) ||
      !cachedGames.some((game) => isNflGameInPostKickoffPollingWindow(game, now))
    ) {
      await recordObservedGameStatus(activeScope, nflGameStatusSignature(cachedGames), false);
      await recordRefreshResult(activeScope, { ran: false, reason: "no-games-ready-for-results" });
      return;
    }

    const fresh = fetchedToday ?? await fetchTodayNflScheduleWithPayload(new Date(now));
    if (!initialFetchFoundNewFinal && !hasNewlyCompletedNflGame(previousGames, fresh.games)) {
      cachedGames = fresh.games;
      scheduleFetchedAt = now;
      await persistNflScheduleCache(seasonId, cachedGames);
      await recordObservedGameStatus(activeScope, nflGameStatusSignature(fresh.games), false);
      await recordRefreshResult(activeScope, { ran: false, reason: "no-new-final-game" });
      return;
    }

    const locked = await withRefreshJobLock(
      async () => {
        // Commit the newly final game and rebuilt actuals before reconciling or
        // recalculating MTM. The daily payload is intentionally non-destructive.
        const eventSync = await syncNflEventsAndRealizedMetrics(
          seasonId,
          seasonYear,
          fresh.payload,
          { completeSeasonPayload: false },
        );
        const mtmReconciliation = await reconcileNflCurrentMtm({ seasonId });
        for (const result of mtmReconciliation) {
          if (result.poolId === 0 || result.markType !== "pending_recalculation") continue;
          try {
            await runFullMtmRecalculation({
              seasonYear,
              calcuttaId: result.poolId,
              trigger: "scheduled",
            });
          } catch (error) {
            result.status = "warning";
            result.warning = `${result.warning ? `${result.warning} ` : ""}Full recalculation required: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
        return { ran: true, eventSync, mtmReconciliation };
      },
      { seasonId, sport: "NFL", competition: "NFL_REGULAR_SEASON" },
    );
    if (!locked.acquired) {
      await recordRefreshResult(activeScope, { ran: false, reason: "already-running" });
      return;
    }
    cachedGames = fresh.games;
    scheduleLoaded = true;
    scheduleFetchedAt = now;
    await persistNflScheduleCache(seasonId, cachedGames);
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