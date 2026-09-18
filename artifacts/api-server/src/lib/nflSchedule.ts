import {
  fetchEspnNflScoreboard,
  fetchEspnNflScoreboardForDate,
  type EspnScoreboardPayload,
} from "./nflEspnClient";
import { todayInNewYork } from "./newYorkTime";
export const NFL_SCHEDULE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const NFL_RECENT_FINAL_WINDOW_MS = 15 * 60 * 1000;
export const NFL_POST_KICKOFF_POLL_DELAY_MS = 2 * 60 * 60 * 1000;
export const NFL_POST_KICKOFF_POLL_WINDOW_MS = 6 * 60 * 60 * 1000;

export type NflScheduledGame = {
  sourceEventId: string | null;
  kickoffAt: string | null;
  state: string;
  completed: boolean;
  statusUpdatedAt: string | null;
};

export function shouldRefreshNflScheduleCache(
  fetchedAt: Date | null,
  nowMs: number,
): boolean {
  return !fetchedAt || nowMs - fetchedAt.getTime() >= NFL_SCHEDULE_CACHE_TTL_MS;
}

export function parseEspnNflSchedule(payload: EspnScoreboardPayload): NflScheduledGame[] {
  return (payload.events ?? []).map((event) => {
    const competition = event.competitions?.[0];
    const status = competition?.status ?? event.status;
    return {
      sourceEventId: event.id ?? null,
      kickoffAt: competition?.date ?? event.date ?? null,
      state: status?.type?.state ?? "unknown",
      completed: status?.type?.completed === true,
      statusUpdatedAt:
        competition?.endDate ??
        event.lastModified ??
        null,
    };
  });
}

/**
 * Cached schedules provide only planned kickoff times. Dynamic game status is
 * fetched again while a game could be live or have just become final.
 */
export function isNflGameInPostKickoffPollingWindow(
  game: NflScheduledGame,
  nowMs: number,
): boolean {
  if (!game.kickoffAt) return false;
  const kickoffMs = Date.parse(game.kickoffAt);
  return (
    Number.isFinite(kickoffMs) &&
    nowMs >= kickoffMs + NFL_POST_KICKOFF_POLL_DELAY_MS &&
    nowMs <= kickoffMs + NFL_POST_KICKOFF_POLL_WINDOW_MS
  );
}

export const isNflGameInLiveStatusWindow = isNflGameInPostKickoffPollingWindow;

export function needsFreshNflGameStatus(
  games: NflScheduledGame[],
  nowMs: number,
): boolean {
  return games.some((game) => isNflGameInPostKickoffPollingWindow(game, nowMs));
}

export function nflGameStatusSignature(games: NflScheduledGame[]): string {
  return JSON.stringify(
    games
      .map((game) => ({
        sourceEventId: game.sourceEventId,
        kickoffAt: game.kickoffAt,
        state: game.state,
        completed: game.completed,
        statusUpdatedAt: game.statusUpdatedAt,
      }))
      .sort((a, b) => (a.kickoffAt ?? "").localeCompare(b.kickoffAt ?? "")),
  );
}

export function hasLiveOrRecentlyFinalNflGame(
  games: NflScheduledGame[],
  nowMs: number,
): boolean {
  return games.some((game) => {
    if (game.state.toLowerCase() === "in") return true;
    if (!game.completed || !game.statusUpdatedAt) return false;
    const completedAtMs = Date.parse(game.statusUpdatedAt);
    return (
      Number.isFinite(completedAtMs) &&
      completedAtMs <= nowMs &&
      nowMs - completedAtMs <= NFL_RECENT_FINAL_WINDOW_MS
    );
  });
}

export function shouldRunStandingsRefresh(input: {
  force: boolean;
  games: NflScheduledGame[];
  lastSuccessfulRunAt: Date | null;
  lastGameStatusSignature: string | null;
  nowMs: number;
}): boolean {
  if (input.force) return true;
  if (input.games.some((game) => game.state.toLowerCase() === "in")) return true;
  const hasNewCompletedGame =
    input.games.some((game) => game.completed) &&
    nflGameStatusSignature(input.games) !== input.lastGameStatusSignature;
  if (hasNewCompletedGame) return true;
  if (hasLiveOrRecentlyFinalNflGame(input.games, input.nowMs)) return true;
  if (!input.lastSuccessfulRunAt) return true;
  return input.nowMs - input.lastSuccessfulRunAt.getTime() >= NFL_SCHEDULE_CACHE_TTL_MS;
}

export function parseCachedNflSchedule(value: unknown): NflScheduledGame[] | null {
  if (!Array.isArray(value)) return null;
  const games: NflScheduledGame[] = [];
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof (candidate as NflScheduledGame).state !== "string" ||
      typeof (candidate as NflScheduledGame).completed !== "boolean" ||
      ((candidate as NflScheduledGame).sourceEventId !== null &&
        typeof (candidate as NflScheduledGame).sourceEventId !== "string") ||
      ((candidate as NflScheduledGame).kickoffAt !== null &&
        typeof (candidate as NflScheduledGame).kickoffAt !== "string")
    ) {
      return null;
    }
    const statusUpdatedAt = (candidate as NflScheduledGame).statusUpdatedAt;
    if (statusUpdatedAt !== null && typeof statusUpdatedAt !== "string") return null;
    games.push({
      sourceEventId: (candidate as NflScheduledGame).sourceEventId ?? null,
      kickoffAt: (candidate as NflScheduledGame).kickoffAt,
      state: (candidate as NflScheduledGame).state,
      completed: (candidate as NflScheduledGame).completed,
      statusUpdatedAt,
    });
  }
  return games;
}

export async function fetchNflSchedule(
  seasonYear: number,
): Promise<NflScheduledGame[]> {
  const { games } = await fetchNflScheduleWithPayload(seasonYear);
  return games;
}

export async function fetchNflScheduleWithPayload(
  seasonYear: number,
): Promise<{ games: NflScheduledGame[]; payload: EspnScoreboardPayload }> {
  const payload = await fetchEspnNflScoreboard(seasonYear);
  return { games: parseEspnNflSchedule(payload), payload };
}

export async function fetchTodayNflScheduleWithPayload(
  now = new Date(),
): Promise<{ games: NflScheduledGame[]; payload: EspnScoreboardPayload; date: string }> {
  const date = todayInNewYork(now);
  const payload = await fetchEspnNflScoreboardForDate(date.replaceAll("-", ""));
  return { games: parseEspnNflSchedule(payload), payload, date };
}

export function hasNewlyCompletedNflGame(
  previous: NflScheduledGame[],
  current: NflScheduledGame[],
): boolean {
  const priorById = new Map(
    previous
      .filter((game) => game.sourceEventId)
      .map((game) => [game.sourceEventId, game.completed]),
  );
  return current.some((game) =>
    game.completed &&
    game.sourceEventId != null &&
    priorById.get(game.sourceEventId) !== true
  );
}
