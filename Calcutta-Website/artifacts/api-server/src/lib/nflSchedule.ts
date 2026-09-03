const ESPN_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
export const NFL_SCHEDULE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const NFL_RECENT_FINAL_WINDOW_MS = 15 * 60 * 1000;
export const NFL_LIVE_STATUS_LOOKBACK_MS = 30 * 60 * 1000;
export const NFL_LIVE_STATUS_LOOKAHEAD_MS = 6 * 60 * 60 * 1000;

export type NflScheduledGame = {
  kickoffAt: string | null;
  state: string;
  completed: boolean;
  statusUpdatedAt: string | null;
};

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
export function isNflGameInLiveStatusWindow(
  game: NflScheduledGame,
  nowMs: number,
): boolean {
  if (!game.kickoffAt) return false;
  const kickoffMs = Date.parse(game.kickoffAt);
  return (
    Number.isFinite(kickoffMs) &&
    nowMs >= kickoffMs - NFL_LIVE_STATUS_LOOKBACK_MS &&
    nowMs <= kickoffMs + NFL_LIVE_STATUS_LOOKAHEAD_MS
  );
}

export function needsFreshNflGameStatus(
  games: NflScheduledGame[],
  nowMs: number,
): boolean {
  return games.some((game) => isNflGameInLiveStatusWindow(game, nowMs));
}

export function nflGameStatusSignature(games: NflScheduledGame[]): string {
  return JSON.stringify(
    games
      .map((game) => ({
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
      ((candidate as NflScheduledGame).kickoffAt !== null &&
        typeof (candidate as NflScheduledGame).kickoffAt !== "string")
    ) {
      return null;
    }
    const statusUpdatedAt = (candidate as NflScheduledGame).statusUpdatedAt;
    if (statusUpdatedAt !== null && typeof statusUpdatedAt !== "string") return null;
    games.push({
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
  return games;
}