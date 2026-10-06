import { z } from "zod/v4";

export const ESPN_MLB_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard";

const Status = z.object({
  state: z.string().optional(),
  completed: z.boolean().optional(),
  name: z.string().optional(),
}).passthrough();
const Competitor = z.object({
  homeAway: z.string().optional(),
  score: z.string().optional(),
  winner: z.boolean().optional(),
  team: z.object({
    id: z.string(),
    displayName: z.string(),
    abbreviation: z.string().optional(),
    shortDisplayName: z.string().optional(),
  }).passthrough(),
}).passthrough();
export const EspnMlbEventSchema = z.object({
  id: z.string(),
  date: z.string().optional(),
  season: z.object({ year: z.number(), type: z.number() }).passthrough(),
  status: z.object({ type: Status }).passthrough().optional(),
  competitions: z.array(z.object({
    date: z.string().optional(),
    timeValid: z.boolean().optional(),
    competitors: z.array(Competitor),
    status: z.object({ type: Status }).passthrough().optional(),
    notes: z.array(z.object({ headline: z.string().optional() }).passthrough()).optional(),
    series: z.object({
      type: z.string().optional(),
      completed: z.boolean().optional(),
      totalCompetitions: z.number().optional(),
      summary: z.string().optional(),
    }).passthrough().optional(),
    venue: z.object({ fullName: z.string().optional() }).passthrough().optional(),
    broadcasts: z.array(z.object({ names: z.array(z.string()).optional() }).passthrough()).optional(),
  }).passthrough()),
}).passthrough();

export type EspnMlbEvent = z.infer<typeof EspnMlbEventSchema>;
export type EspnMlbPayload = {
  events: EspnMlbEvent[];
  provenance: { sourceUrl: string; fetchedAt: string; requestedDate: string };
};

export function buildEspnMlbDateUrl(date: string): string {
  if (!/^\d{8}$/.test(date)) throw new Error("ESPN MLB date must use YYYYMMDD.");
  const value = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T12:00:00Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10).replaceAll("-", "") !== date) {
    throw new Error("ESPN MLB date must be a valid calendar day.");
  }
  // MLB's season filter is not reliable and range requests may fail. The
  // adapter below must validate event.season, even for a daily request.
  return `${ESPN_MLB_SCOREBOARD_URL}?${new URLSearchParams({ dates: date, limit: "100" })}`;
}

export async function fetchEspnMlbForDate(
  date: string,
  fetcher: typeof fetch = fetch,
): Promise<EspnMlbPayload> {
  const sourceUrl = buildEspnMlbDateUrl(date);
  const response = await fetcher(sourceUrl, {
    headers: { Accept: "application/json", "User-Agent": "Calcutta MLB results client/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`ESPN MLB scoreboard returned HTTP ${response.status}.`);
  const payload = z.object({ events: z.array(EspnMlbEventSchema) }).passthrough()
    .parse(await response.json());
  if (payload.events.length >= 100) {
    throw new Error("ESPN MLB daily scoreboard may be truncated; refusing an incomplete page.");
  }
  return {
    events: payload.events,
    provenance: { sourceUrl, requestedDate: date, fetchedAt: new Date().toISOString() },
  };
}
