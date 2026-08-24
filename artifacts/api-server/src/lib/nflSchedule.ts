const ESPN_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
export const NFL_SCHEDULE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const NFL_RECENT_FINAL_WINDOW_MS = 15 * 60 * 1000;

export type NflScheduledGame = {
  state: string;
  completed: boolean;
  statusUpdatedAt: string | null;
};

type CachedSchedule = {
  seasonYear: number;
  fetchedAtMs: number;
  games: NflScheduledGame[];
};

let cachedSchedule: CachedSchedule | null = null;

type EspnScoreboardPayload = {
  events?: Array<{
    status?: {
      type?: {
        state?: string;
        completed?: boolean;
      };
    };
    competitions?: Array<{
      status?: {
        type?: {
          state?: string;
          completed?: boolean;
        };
      };
      endDate?: string;
      date?: string;
    }>;
    date?: string;
    lastModified?: string;
  }>;
};

export function shouldRefreshNflScheduleCache(
  cache: CachedSchedule | null,
  seasonYear: number,
  nowMs: number,
): boolean {
  return (
    !cache ||
    cache.seasonYear !== seasonYear ||
    nowMs - cache.fetchedAtMs >= NFL_SCHEDULE_CACHE_TTL_MS
  );
}

export function parseEspnNflSchedule(payload: EspnScoreboardPayload): NflScheduledGame[] {
  return (payload.events ?? []).map((event) => {
    const competition = event.competitions?.[0];
    const status = competition?.status ?? event.status;
    return {
      state: status?.type?.state ?? "unknown",
      completed: status?.type?.completed === true,
      statusUpdatedAt:
        competition?.endDate ??
        event.lastModified ??
        competition?.date ??
        event.date ??
        null,
    };
  });
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
  nowMs: number;
}): boolean {
  if (input.force) return true;
  if (hasLiveOrRecentlyFinalNflGame(input.games, input.nowMs)) return true;
  if (!input.lastSuccessfulRunAt) return true;
  return input.nowMs - input.lastSuccessfulRunAt.getTime() >= NFL_SCHEDULE_CACHE_TTL_MS;
}

export async function loadCachedNflSchedule(
  seasonYear: number,
  nowMs: number = Date.now(),
): Promise<NflScheduledGame[]> {
  if (!shouldRefreshNflScheduleCache(cachedSchedule, seasonYear, nowMs)) {
    return cachedSchedule!.games;
  }

  const response = await fetch(
    `${ESPN_SCOREBOARD_URL}?dates=${encodeURIComponent(`${seasonYear}0801-${seasonYear + 1}0228`)}&limit=1000`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "NFL Auction Manager refresh scheduler/1.0",
      },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) {
    throw new Error(`NFL schedule returned HTTP ${response.status}.`);
  }

  const games = parseEspnNflSchedule(
    (await response.json()) as EspnScoreboardPayload,
  );
  cachedSchedule = { seasonYear, fetchedAtMs: nowMs, games };
  return games;
}