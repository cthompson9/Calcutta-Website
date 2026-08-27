import { and, eq } from "drizzle-orm";
import {
  db,
  eventsTable,
  providerTeamIdentitiesTable,
  teamsTable,
} from "@workspace/db";
import { resolveDefaultSeasonYearForSport } from "./calcuttaContext";
import {
  CFB_REGULAR_SEASON,
  CFB_SPORT,
  type EventAdapter,
  type IngestedEvent,
  type ProviderTeamIdentity,
} from "./eventIngestion";

const ESPN_CFB_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard";

type EspnCfbTeam = {
  id?: string;
  abbreviation?: string;
  displayName?: string;
  shortDisplayName?: string;
  location?: string;
  name?: string;
  slug?: string;
};

type EspnCfbCompetitor = {
  homeAway?: string;
  score?: string;
  team?: EspnCfbTeam;
};

type EspnCfbStatus = {
  type?: {
    state?: string;
    completed?: boolean;
    name?: string;
  };
};

export type EspnCfbEvent = {
  id?: string;
  date?: string;
  season?: { year?: number; type?: number };
  week?: { number?: number };
  status?: EspnCfbStatus;
  competitions?: Array<{
    date?: string;
    timeValid?: boolean;
    venue?: { fullName?: string };
    broadcasts?: Array<{ names?: string[] }>;
    competitors?: EspnCfbCompetitor[];
    status?: EspnCfbStatus;
  }>;
  /** Keep new provider fields without weakening the typed fields above. */
  [key: string]: unknown;
};

export type EspnCfbScoreboardPayload = { events?: EspnCfbEvent[] };
export type ParsedCfbEvent = IngestedEvent;

/**
 * ESPN uses a mixture of abbreviations, display names, and location names.
 * Keep aliases here instead of teaching the provider-neutral ledger about
 * college naming conventions.
 */
export const CFB_TEAM_ALIASES: Record<string, string> = {
  "ALABAMA CRIMSON TIDE": "Alabama",
  "ALABAMA": "Alabama",
  "ARKANSAS RAZORBACKS": "Arkansas",
  "CLEMSON TIGERS": "Clemson",
  "FLORIDA STATE SEMINOLES": "Florida State",
  "GEORGIA BULLDOGS": "Georgia",
  "LSU TIGERS": "LSU",
  "MICHIGAN WOLVERINES": "Michigan",
  "NOTRE DAME FIGHTING IRISH": "Notre Dame",
  "OHIO STATE BUCKEYES": "Ohio State",
  "OKLAHOMA SOONERS": "Oklahoma",
  "OREGON DUCKS": "Oregon",
  "PENN STATE NITTANY LIONS": "Penn State",
  "TEXAS LONGHORNS": "Texas",
  "TEXAS A&M AGGIES": "Texas A&M",
  "TEXAS TECH RED RAIDERS": "Texas Tech",
  "USC TROJANS": "USC",
  "WASHINGTON HUSKIES": "Washington",
};

function newYorkDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseScore(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const score = Number.parseInt(value, 10);
  return Number.isFinite(score) ? score : null;
}

function normalizeAlias(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function teamIdentity(team: EspnCfbTeam): ProviderTeamIdentity {
  const candidates = [
    team.location,
    team.displayName,
    team.shortDisplayName,
    team.name,
    team.abbreviation,
  ].filter((value): value is string => Boolean(value?.trim()));
  const canonicalName =
    candidates.map((value) => CFB_TEAM_ALIASES[normalizeAlias(value)]).find(Boolean) ??
    team.location ??
    team.displayName ??
    team.shortDisplayName ??
    team.name;
  if (!team.id || !canonicalName) {
    throw new Error("ESPN returned an incomplete CFB team identity.");
  }
  return {
    providerTeamId: team.id,
    canonicalName,
    aliases: [...new Set(candidates)],
    providerAbbreviation: team.abbreviation ?? null,
    providerDisplayName: team.displayName ?? null,
  };
}

export function parseEspnCfbEvents(
  payload: EspnCfbScoreboardPayload,
  seasonYear: number,
): ParsedCfbEvent[] {
  return (payload.events ?? []).flatMap((event) => {
    if (event.season?.year !== seasonYear || event.season?.type !== 2) return [];
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors ?? [];
    const home = competitors.find((team) => team.homeAway === "home");
    const away = competitors.find((team) => team.homeAway === "away");
    const week = event.week?.number;
    const providerEventId = event.id;
    if (!providerEventId || !week || !home?.team || !away?.team) {
      throw new Error("ESPN returned an incomplete regular-season CFB event.");
    }
    const kickoffText = competition?.date ?? event.date;
    const parsedKickoff = kickoffText ? new Date(kickoffText) : null;
    const kickoffAt =
      competition?.timeValid === false ||
      !parsedKickoff ||
      Number.isNaN(parsedKickoff.getTime())
        ? null
        : parsedKickoff;
    const statusType = competition?.status?.type ?? event.status?.type;
    const completed = statusType?.completed === true;
    const state = statusType?.state?.toLowerCase();
    const rawProviderData = { ...event } as Record<string, unknown>;
    return [{
      sport: CFB_SPORT,
      competition: CFB_REGULAR_SEASON,
      seasonYear,
      period: week,
      provider: "espn",
      providerEventId,
      awayTeam: teamIdentity(away.team),
      homeTeam: teamIdentity(home.team),
      kickoffAt,
      eventDate: newYorkDate(
        parsedKickoff && !Number.isNaN(parsedKickoff.getTime())
          ? parsedKickoff
          : new Date(Date.UTC(seasonYear, 8, 1)),
      ),
      venue: competition?.venue?.fullName ?? null,
      network: competition?.broadcasts?.flatMap((broadcast) => broadcast.names ?? [])[0] ?? null,
      status: completed ? "final" : state === "in" ? "in_progress" : "scheduled",
      awayScore: completed || state === "in" ? parseScore(away.score) : null,
      homeScore: completed || state === "in" ? parseScore(home.score) : null,
      rawProviderData,
    }];
  });
}

export function validateEspnCfbEvents(
  payload: EspnCfbScoreboardPayload,
  seasonYear: number,
): ParsedCfbEvent[] {
  const parsed = parseEspnCfbEvents(payload, seasonYear);
  if (parsed.length === 0) {
    throw new Error(`ESPN returned no regular-season CFB events for ${seasonYear}.`);
  }
  const sourceIds = new Set(parsed.map((event) => event.providerEventId));
  if (sourceIds.size !== parsed.length) {
    throw new Error(`ESPN returned duplicate CFB event IDs for ${seasonYear}.`);
  }
  const matchups = new Set(parsed.map((event) =>
    `${event.period}:${event.awayTeam.providerTeamId}:${event.homeTeam.providerTeamId}`,
  ));
  if (matchups.size !== parsed.length) {
    throw new Error(`ESPN returned duplicate CFB period/matchups for ${seasonYear}.`);
  }
  if (parsed.some((event) => event.period < 1)) {
    throw new Error(`ESPN returned an invalid CFB period for ${seasonYear}.`);
  }
  return parsed;
}

export async function fetchEspnCfbEvents(
  seasonYear: number,
): Promise<EspnCfbScoreboardPayload> {
  const response = await fetch(
    `${ESPN_CFB_SCOREBOARD_URL}?dates=${seasonYear}0801-${seasonYear + 1}0228&limit=1000`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "NFL Auction Manager CFB event importer/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`ESPN CFB scoreboard returned HTTP ${response.status}.`);
  return await response.json() as EspnCfbScoreboardPayload;
}

async function resolveOrCreateTeam(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  identity: ProviderTeamIdentity,
  teamIdByName: Map<string, number>,
): Promise<number> {
  const existing = teamIdByName.get(identity.canonicalName);
  if (existing) return existing;
  await tx.insert(teamsTable).values({
    name: identity.canonicalName,
    conference: "CFB",
    division: "CFB",
  }).onConflictDoNothing({ target: teamsTable.name });
  const rows = await tx.select({ id: teamsTable.id })
    .from(teamsTable)
    .where(eq(teamsTable.name, identity.canonicalName))
    .limit(1);
  const teamId = rows[0]?.id;
  if (!teamId) throw new Error(`Could not create CFB team ${identity.canonicalName}.`);
  teamIdByName.set(identity.canonicalName, teamId);
  return teamId;
}

export async function syncCfbEventsTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  seasonId: number,
  seasonYear: number,
  payload: EspnCfbScoreboardPayload,
): Promise<{ eventsUpserted: number }> {
  const parsed = validateEspnCfbEvents(payload, seasonYear);
  const teamRows = await tx.select().from(teamsTable);
  const teamIdByName = new Map(teamRows.map((team) => [team.name, team.id]));
  const knownIdentities = await tx.select({
    providerTeamId: providerTeamIdentitiesTable.providerTeamId,
    teamId: providerTeamIdentitiesTable.teamId,
    canonicalName: providerTeamIdentitiesTable.canonicalName,
    aliases: providerTeamIdentitiesTable.aliases,
  }).from(providerTeamIdentitiesTable).where(and(
    eq(providerTeamIdentitiesTable.sport, CFB_SPORT),
    eq(providerTeamIdentitiesTable.competition, CFB_REGULAR_SEASON),
    eq(providerTeamIdentitiesTable.provider, "espn"),
  ));
  const identityByProviderId = new Map(
    knownIdentities.map((identity) => [identity.providerTeamId, identity]),
  );
  const teamNameById = new Map(teamRows.map((team) => [team.id, team.name]));

  // CFB payloads are reconciled non-destructively because ESPN does not expose
  // an authoritative completeness marker for this date-range endpoint. Scoped
  // upserts make partial responses safe while still converging corrections.
  for (const event of parsed) {
    const knownAway = identityByProviderId.get(event.awayTeam.providerTeamId);
    const knownHome = identityByProviderId.get(event.homeTeam.providerTeamId);
    const awayTeamId = knownAway?.teamId ??
      await resolveOrCreateTeam(tx, event.awayTeam, teamIdByName);
    const homeTeamId = knownHome?.teamId ??
      await resolveOrCreateTeam(tx, event.homeTeam, teamIdByName);
    identityByProviderId.set(event.awayTeam.providerTeamId, {
      providerTeamId: event.awayTeam.providerTeamId,
      teamId: awayTeamId,
      canonicalName: teamNameById.get(awayTeamId) ?? event.awayTeam.canonicalName,
      aliases: [...new Set([...(knownAway?.aliases ?? []), ...event.awayTeam.aliases])],
    });
    identityByProviderId.set(event.homeTeam.providerTeamId, {
      providerTeamId: event.homeTeam.providerTeamId,
      teamId: homeTeamId,
      canonicalName: teamNameById.get(homeTeamId) ?? event.homeTeam.canonicalName,
      aliases: [...new Set([...(knownHome?.aliases ?? []), ...event.homeTeam.aliases])],
    });
    const row = {
      seasonId,
      sport: event.sport,
      competition: event.competition,
      source: event.provider,
      sourceEventId: event.providerEventId,
      week: event.period,
      eventDate: event.eventDate,
      kickoffAt: event.kickoffAt,
      timezone: "America/New_York",
      awayTeamId,
      homeTeamId,
      venue: event.venue,
      network: event.network,
      status: event.status,
      awayScore: event.awayScore,
      homeScore: event.homeScore,
      sourceData: event.rawProviderData,
    };
    await tx.insert(eventsTable).values(row).onConflictDoUpdate({
      target: [
        eventsTable.seasonId,
        eventsTable.sport,
        eventsTable.competition,
        eventsTable.source,
        eventsTable.sourceEventId,
      ],
      set: row,
    });
    for (const identity of [event.awayTeam, event.homeTeam]) {
      const knownIdentity = identityByProviderId.get(identity.providerTeamId)!;
      const identityRow = {
        sport: event.sport,
        competition: event.competition,
        provider: event.provider,
        providerTeamId: identity.providerTeamId,
        teamId: knownIdentity.teamId,
        canonicalName: knownIdentity.canonicalName,
        aliases: [...new Set([...knownIdentity.aliases, ...identity.aliases])],
      };
      await tx.insert(providerTeamIdentitiesTable).values(identityRow)
        .onConflictDoUpdate({
          target: [
            providerTeamIdentitiesTable.sport,
            providerTeamIdentitiesTable.competition,
            providerTeamIdentitiesTable.provider,
            providerTeamIdentitiesTable.providerTeamId,
          ],
          set: identityRow,
        });
    }
  }
  return { eventsUpserted: parsed.length };
}

export async function syncCfbEvents(
  seasonId: number,
  seasonYear: number,
  payload: EspnCfbScoreboardPayload,
): Promise<{ eventsUpserted: number }> {
  return db.transaction((tx) => syncCfbEventsTx(tx, seasonId, seasonYear, payload));
}

export async function resolveCfbRefreshSeasonYear(): Promise<number> {
  const activeYear = await resolveDefaultSeasonYearForSport(db, {
    sport: CFB_SPORT,
    state: "active",
    newestFirst: true,
  });
  if (activeYear != null) return activeYear;
  throw new Error("No active season is configured for the CFB event refresh.");
}

export async function runCfbEventRefresh(input: {
  seasonId: number;
  seasonYear: number;
}): Promise<{ eventsUpserted: number }> {
  const payload = await fetchEspnCfbEvents(input.seasonYear);
  validateEspnCfbEvents(payload, input.seasonYear);
  return syncCfbEvents(input.seasonId, input.seasonYear, payload);
}

export const cfbEventAdapter: EventAdapter<EspnCfbScoreboardPayload> = {
  sport: CFB_SPORT,
  competition: CFB_REGULAR_SEASON,
  provider: "espn",
  parse: parseEspnCfbEvents,
  validate: validateEspnCfbEvents,
  fetch: fetchEspnCfbEvents,
};