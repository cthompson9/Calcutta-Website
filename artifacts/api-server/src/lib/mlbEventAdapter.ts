import {
  MLB_POSTSEASON,
  MLB_SPORT,
  type EventStatus,
  type IngestedEvent,
  type ProviderTeamIdentity,
} from "./eventIngestion";
import { type EspnMlbEvent, type EspnMlbPayload } from "./mlbEspnClient";

export const MLB_ROUNDS = {
  wild_card: { sequence: 1, bestOf: 3, seriesCount: 4 },
  division_series: { sequence: 2, bestOf: 5, seriesCount: 4 },
  league_championship: { sequence: 3, bestOf: 7, seriesCount: 2 },
  world_series: { sequence: 4, bestOf: 7, seriesCount: 1 },
} as const;
export type MlbRound = keyof typeof MLB_ROUNDS;

export type IngestedMlbEvent = IngestedEvent & {
  sport: typeof MLB_SPORT;
  competition: typeof MLB_POSTSEASON;
  round: MlbRound;
  league: "AL" | "NL" | null;
  seriesKey: string;
  gameNumber: number;
  bestOf: 3 | 5 | 7;
  sourceUrl: string;
  sourceFetchedAt: string;
};

type EspnCompetitor = EspnMlbEvent["competitions"][number]["competitors"][number];
function teamIdentity(competitor: EspnCompetitor): ProviderTeamIdentity {
  const team = competitor.team;
  if (!team.id.trim() || !team.displayName.trim()) throw new Error("ESPN MLB team identity is missing.");
  return {
    providerTeamId: team.id,
    canonicalName: team.displayName,
    aliases: [team.displayName, team.shortDisplayName, team.abbreviation]
      .filter((name): name is string => Boolean(name)),
    providerAbbreviation: team.abbreviation ?? null,
    providerDisplayName: team.displayName,
  };
}

function finalScore(value: string | undefined): number {
  if (value == null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("ESPN MLB final score must be a non-negative integer.");
  }
  return Number(value);
}

function statusOf(event: EspnMlbEvent): EventStatus {
  const status = event.competitions[0]?.status?.type ?? event.status?.type;
  if (!status) throw new Error(`ESPN MLB event ${event.id} has no status.`);
  if (status.name === "STATUS_POSTPONED") return "postponed";
  if (status.name === "STATUS_SUSPENDED") return "suspended";
  if (["STATUS_CANCELED", "STATUS_CANCELLED", "STATUS_UNNECESSARY"].includes(status.name ?? "")) {
    return "cancelled";
  }
  // "post" by itself is not authoritative final evidence.
  if (status.completed === true && ["STATUS_FINAL", "STATUS_FINAL_OT"].includes(status.name ?? "")) {
    return "final";
  }
  if (status.state === "in") return "in_progress";
  if (status.state === "pre" && status.completed !== true) return "scheduled";
  throw new Error(`ESPN MLB event ${event.id} has an unsupported status ${status.name ?? status.state}.`);
}

function roundOf(event: EspnMlbEvent): {
  round: MlbRound; league: "AL" | "NL" | null; gameNumber: number;
} {
  const candidates = event.competitions[0]?.notes?.flatMap((note) => {
    const match = /^(ALWC|NLWC|ALDS|NLDS|ALCS|NLCS|WS|World Series)\s*-\s*Game\s+(\d+)$/i
      .exec(note.headline?.trim() ?? "");
    return match ? [match] : [];
  }) ?? [];
  if (candidates.length !== 1) throw new Error(`ESPN MLB event ${event.id} has no unambiguous postseason round/game.`);
  const match = candidates[0]!;
  const code = match[1]!.toUpperCase();
  const round: MlbRound = code.endsWith("WC") ? "wild_card"
    : code.endsWith("DS") ? "division_series"
      : code.endsWith("CS") ? "league_championship" : "world_series";
  const gameNumber = Number(match[2]);
  if (!Number.isInteger(gameNumber) || gameNumber < 1 || gameNumber > MLB_ROUNDS[round].bestOf) {
    throw new Error(`ESPN MLB event ${event.id} has an illegal game number.`);
  }
  return { round, league: code.startsWith("AL") ? "AL" : code.startsWith("NL") ? "NL" : null, gameNumber };
}

export function parseEspnMlbPostseason(
  payload: EspnMlbPayload,
  seasonYear: number,
): IngestedMlbEvent[] {
  if (!Number.isInteger(seasonYear) || seasonYear < 2022 || seasonYear > 2200) {
    throw new Error("This MLB adapter supports the 12-team postseason format from 2022 onward.");
  }
  const seen = new Set<string>();
  return payload.events.flatMap((event) => {
    if (event.season.year !== seasonYear || event.season.type !== 3) return [];
    if (!event.id.trim() || seen.has(event.id)) throw new Error("ESPN MLB daily payload has a missing or duplicate event identity.");
    seen.add(event.id);
    if (event.competitions.length !== 1) throw new Error(`ESPN MLB event ${event.id} has an ambiguous competition.`);
    const competition = event.competitions[0]!;
    const home = competition.competitors.filter((competitor) => competitor.homeAway === "home");
    const away = competition.competitors.filter((competitor) => competitor.homeAway === "away");
    if (competition.competitors.length !== 2 || home.length !== 1 || away.length !== 1) {
      throw new Error(`ESPN MLB event ${event.id} must have exactly two distinct sides.`);
    }
    const homeTeam = teamIdentity(home[0]!);
    const awayTeam = teamIdentity(away[0]!);
    if (homeTeam.providerTeamId === awayTeam.providerTeamId) throw new Error("ESPN MLB event teams must differ.");
    const { round, league, gameNumber } = roundOf(event);
    const bestOf = MLB_ROUNDS[round].bestOf;
    if (competition.series?.totalCompetitions != null && competition.series.totalCompetitions !== bestOf) {
      throw new Error(`ESPN MLB event ${event.id} has a conflicting series length.`);
    }
    const timestamp = competition.date ?? event.date;
    const date = timestamp ? new Date(timestamp) : null;
    if (!date || !Number.isFinite(date.getTime())) throw new Error(`ESPN MLB event ${event.id} has no valid date.`);
    const status = statusOf(event);
    const homeScore = status === "final" ? finalScore(home[0]!.score) : null;
    const awayScore = status === "final" ? finalScore(away[0]!.score) : null;
    if (status === "final") {
      if (homeScore === awayScore) throw new Error("A final MLB postseason game cannot be tied.");
      const homeWon = homeScore! > awayScore!;
      if ((home[0]!.winner != null && home[0]!.winner !== homeWon) ||
          (away[0]!.winner != null && away[0]!.winner === homeWon)) {
        throw new Error("ESPN MLB winner flag disagrees with final scores.");
      }
    }
    const eventDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date);
    // Home-field changes do not create a different series; individual games
    // retain their provider ID. The round prevents cross-round collisions.
    const seriesKey = `MLB:MLB_POSTSEASON:${seasonYear}:espn:${round}:` +
      [homeTeam.providerTeamId, awayTeam.providerTeamId].sort().join(":");
    return [{
      sport: MLB_SPORT, competition: MLB_POSTSEASON, seasonYear,
      period: MLB_ROUNDS[round].sequence, provider: "espn", providerEventId: event.id,
      awayTeam, homeTeam, kickoffAt: competition.timeValid === false ? null : date,
      eventDate, venue: competition.venue?.fullName ?? null,
      network: competition.broadcasts?.flatMap((broadcast) => broadcast.names ?? [])[0] ?? null,
      status, homeScore, awayScore, rawProviderData: event,
      round, league, seriesKey, gameNumber, bestOf,
      sourceUrl: payload.provenance.sourceUrl, sourceFetchedAt: payload.provenance.fetchedAt,
    }];
  });
}
