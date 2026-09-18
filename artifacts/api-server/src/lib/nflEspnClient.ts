const ESPN_NFL_SCOREBOARD_URL =
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const ESPN_ERROR_BODY_LIMIT = 1_000;

export type EspnScoreboardEvent = {
  id?: string;
  date?: string;
  season?: { year?: number; type?: number };
  week?: { number?: number };
  status?: { type?: { state?: string; completed?: boolean; name?: string } };
  competitions?: Array<{
    date?: string;
    endDate?: string;
    timeValid?: boolean;
    venue?: { fullName?: string };
    broadcasts?: Array<{ names?: string[] }>;
    competitors?: Array<{
      homeAway?: string;
      score?: string;
      team?: { abbreviation?: string };
    }>;
    status?: { type?: { state?: string; completed?: boolean; name?: string } };
  }>;
  lastModified?: string;
};

export type EspnScoreboardPayload = {
  events?: EspnScoreboardEvent[];
  provenance?: { sourceUrl: string; fetchedAt: string };
};

export function buildEspnNflScoreboardUrls(seasonYear: number): string[] {
  const makeUrl = (week?: number) => {
    const params = new URLSearchParams({
      dates: String(seasonYear),
      seasontype: "2",
      limit: "1000",
      ...(week ? { week: String(week) } : {}),
    });
    return `${ESPN_NFL_SCOREBOARD_URL}?${params.toString()}`;
  };
  return [makeUrl(), makeUrl(17), makeUrl(18)];
}

export function buildEspnNflScoreboardDateUrl(date: string): string {
  if (!/^\d{8}$/.test(date)) {
    throw new Error("ESPN NFL scoreboard date must use YYYYMMDD.");
  }
  const params = new URLSearchParams({
    dates: date,
    limit: "100",
  });
  return `${ESPN_NFL_SCOREBOARD_URL}?${params.toString()}`;
}

async function fetchScoreboardPage(url: string): Promise<EspnScoreboardEvent[]> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "NFL Auction Manager ESPN client/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = (await response.text()).trim().slice(0, ESPN_ERROR_BODY_LIMIT);
    throw new Error(
      `ESPN NFL scoreboard returned HTTP ${response.status} for ${url}: ${body || "empty response body"}`,
    );
  }
  const payload = await response.json() as { events?: EspnScoreboardEvent[] };
  return payload.events ?? [];
}

export async function fetchEspnNflScoreboard(
  seasonYear: number,
): Promise<EspnScoreboardPayload> {
  const urls = buildEspnNflScoreboardUrls(seasonYear);
  const pages = await Promise.all(urls.map((url) => fetchScoreboardPage(url)));
  const eventsById = new Map<string, EspnScoreboardEvent>();
  for (const event of pages.flat()) {
    if (event.id) eventsById.set(event.id, event);
  }
  return {
    events: [...eventsById.values()],
    provenance: {
      sourceUrl: urls.join(","),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export async function fetchEspnNflScoreboardForDate(
  date: string,
): Promise<EspnScoreboardPayload> {
  const url = buildEspnNflScoreboardDateUrl(date);
  return {
    events: await fetchScoreboardPage(url),
    provenance: {
      sourceUrl: url,
      fetchedAt: new Date().toISOString(),
    },
  };
}

export { ESPN_NFL_SCOREBOARD_URL };