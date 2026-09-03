import {
  NFL_REGULAR_SEASON,
  NFL_SPORT,
  type EventAdapter,
  type IngestedEvent,
} from "./eventIngestion";
import {
  fetchEspnNflEvents,
  parseEspnRegularSeasonEvents,
  TEAM_ABBREVIATION_ALIASES,
  validateEspnRegularSeasonEvents,
  type EspnScoreboardPayload,
  type ParsedNflEvent,
} from "./nflEventSync";

function toIngestedEvent(
  event: ParsedNflEvent,
  seasonYear: number,
  rawProviderData: Record<string, unknown>,
): IngestedEvent {
  const identity = (abbreviation: string) => ({
    providerTeamId: abbreviation,
    canonicalName: TEAM_ABBREVIATION_ALIASES[abbreviation] ?? abbreviation,
    aliases: [abbreviation],
    providerAbbreviation: abbreviation,
    providerDisplayName: null,
  });
  return {
    sport: NFL_SPORT,
    competition: NFL_REGULAR_SEASON,
    seasonYear,
    period: event.week,
    provider: "espn",
    providerEventId: event.sourceEventId,
    awayTeam: identity(event.awayAbbreviation),
    homeTeam: identity(event.homeAbbreviation),
    kickoffAt: event.kickoffAt,
    eventDate: event.eventDate,
    venue: event.venue,
    network: event.network,
    status: event.status,
    awayScore: event.awayScore,
    homeScore: event.homeScore,
    rawProviderData,
  };
}

function rawEventById(payload: EspnScoreboardPayload): Map<string, Record<string, unknown>> {
  return new Map(
    (payload.events ?? [])
      .filter((event) => event.id)
      .map((event) => [
        event.id!,
        { ...event } as unknown as Record<string, unknown>,
      ]),
  );
}

/**
 * The NFL adapter delegates to the existing parser and validator. This keeps
 * its output and validation behavior unchanged while making it the first
 * implementation of the shared adapter contract.
 */
export const nflEventAdapter: EventAdapter<EspnScoreboardPayload> = {
  sport: NFL_SPORT,
  competition: NFL_REGULAR_SEASON,
  provider: "espn",
  parse: (payload, seasonYear) => {
    const rawById = rawEventById(payload);
    return parseEspnRegularSeasonEvents(payload, seasonYear).map((event) =>
      toIngestedEvent(event, seasonYear, rawById.get(event.sourceEventId) ?? event.sourceData),
    );
  },
  validate: (payload, seasonYear) => {
    const rawById = rawEventById(payload);
    return validateEspnRegularSeasonEvents(payload, seasonYear).map((event) =>
      toIngestedEvent(event, seasonYear, rawById.get(event.sourceEventId) ?? event.sourceData),
    );
  },
  fetch: fetchEspnNflEvents,
};