/**
 * Shared boundary between provider adapters and the event ledger.
 *
 * Adapters own provider-specific parsing, validation, and identity mapping.
 * Persistence code only needs this contract and never needs to know whether
 * an event came from NFL or college football.
 */
export const NFL_SPORT = "NFL" as const;
export const CFB_SPORT = "CFB" as const;
export const NFL_REGULAR_SEASON = "NFL_REGULAR_SEASON" as const;
export const CFB_REGULAR_SEASON = "CFB_REGULAR_SEASON" as const;

export type EventSport = typeof NFL_SPORT | typeof CFB_SPORT;
export type EventCompetition =
  | typeof NFL_REGULAR_SEASON
  | typeof CFB_REGULAR_SEASON
  | (string & {});
export type EventStatus = "scheduled" | "in_progress" | "final";

export type ProviderTeamIdentity = {
  providerTeamId: string;
  canonicalName: string;
  aliases: string[];
  providerAbbreviation: string | null;
  providerDisplayName: string | null;
};

export type IngestedEvent = {
  sport: EventSport;
  competition: EventCompetition;
  seasonYear: number;
  period: number;
  provider: string;
  providerEventId: string;
  awayTeam: ProviderTeamIdentity;
  homeTeam: ProviderTeamIdentity;
  kickoffAt: Date | null;
  eventDate: string;
  venue: string | null;
  network: string | null;
  status: EventStatus;
  awayScore: number | null;
  homeScore: number | null;
  /** The unmodified provider event, retained for audit and later replays. */
  rawProviderData: Record<string, unknown>;
};

export type EventIngestionScope = Pick<IngestedEvent, "sport" | "competition" | "seasonYear">;

export function eventScopeKey(scope: EventIngestionScope): string {
  return `${scope.sport}:${scope.competition}:${scope.seasonYear}`;
}

export type EventAdapter<TPayload> = {
  sport: EventSport;
  competition: EventCompetition;
  provider: string;
  parse(payload: TPayload, seasonYear: number): IngestedEvent[];
  validate(payload: TPayload, seasonYear: number): IngestedEvent[];
  fetch(seasonYear: number): Promise<TPayload>;
};