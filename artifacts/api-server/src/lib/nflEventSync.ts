import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  calcuttaEntriesTable,
  calcuttasTable,
  db,
  eventsTable,
  nflGamesTable,
  snapshotMetricsTable,
  sportPeriodsTable,
  teamPeriodSnapshotsTable,
  teamsTable,
} from "@workspace/db";
import {
  aggregateNflRegularSeasonGames,
  ensureNflSportPeriods,
  isNflMarqueeKickoff,
  NFL_MARQUEE_MULTIPLIER,
  NFL_SPORT,
  normalizeNflGame,
} from "./calcuttaReturns";
import { NFL_REGULAR_SEASON } from "./eventIngestion";

const ESPN_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const EXPECTED_REGULAR_SEASON_GAMES = 272;
export const TEAM_ABBREVIATION_ALIASES: Record<string, string> = {
  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills", CAR: "Carolina Panthers", CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals", CLE: "Cleveland Browns", DAL: "Dallas Cowboys",
  DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers",
  HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars",
  KC: "Kansas City Chiefs", LV: "Las Vegas Raiders", LAC: "Los Angeles Chargers",
  LAR: "Los Angeles Rams", MIA: "Miami Dolphins", MIN: "Minnesota Vikings",
  NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants",
  NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers",
  SEA: "Seattle Seahawks", SF: "San Francisco 49ers", TB: "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans", WSH: "Washington Commanders",
};

type EspnCompetitor = {
  homeAway?: string;
  score?: string;
  team?: { abbreviation?: string };
};

type EspnEvent = {
  id?: string;
  date?: string;
  season?: { year?: number; type?: number };
  week?: { number?: number };
  status?: { type?: { state?: string; completed?: boolean; name?: string } };
  competitions?: Array<{
    date?: string;
    timeValid?: boolean;
    venue?: { fullName?: string };
    broadcasts?: Array<{ names?: string[] }>;
    competitors?: EspnCompetitor[];
    status?: { type?: { state?: string; completed?: boolean; name?: string } };
  }>;
};

export type EspnScoreboardPayload = { events?: EspnEvent[] };

export type ParsedNflEvent = {
  sourceEventId: string;
  week: number;
  kickoffAt: Date | null;
  eventDate: string;
  awayAbbreviation: string;
  homeAbbreviation: string;
  venue: string | null;
  network: string | null;
  status: "scheduled" | "in_progress" | "final";
  awayScore: number | null;
  homeScore: number | null;
  sourceData: Record<string, unknown>;
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

export function parseEspnRegularSeasonEvents(
  payload: EspnScoreboardPayload,
  seasonYear: number,
): ParsedNflEvent[] {
  return (payload.events ?? []).flatMap((event) => {
    if (event.season?.year !== seasonYear || event.season?.type !== 2) return [];
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors ?? [];
    const home = competitors.find((team) => team.homeAway === "home");
    const away = competitors.find((team) => team.homeAway === "away");
    const week = event.week?.number;
    const sourceEventId = event.id;
    const homeAbbreviation = home?.team?.abbreviation;
    const awayAbbreviation = away?.team?.abbreviation;
    if (!sourceEventId || !week || !homeAbbreviation || !awayAbbreviation) {
      throw new Error("ESPN returned an incomplete regular-season NFL event.");
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
    return [{
      sourceEventId,
      week,
      kickoffAt,
      eventDate: newYorkDate(parsedKickoff && !Number.isNaN(parsedKickoff.getTime())
        ? parsedKickoff
        : new Date(Date.UTC(seasonYear, 8, 1))),
      awayAbbreviation,
      homeAbbreviation,
      venue: competition?.venue?.fullName ?? null,
      network: competition?.broadcasts?.flatMap((broadcast) => broadcast.names ?? [])[0] ?? null,
      status: completed ? "final" : state === "in" ? "in_progress" : "scheduled",
      awayScore: completed || state === "in" ? parseScore(away?.score) : null,
      homeScore: completed || state === "in" ? parseScore(home?.score) : null,
      sourceData: {
        provider: "espn",
        statusName: statusType?.name ?? null,
        kickoffTimeConfirmed: competition?.timeValid !== false,
      },
    }];
  });
}

export function validateEspnRegularSeasonEvents(
  payload: EspnScoreboardPayload,
  seasonYear: number,
): ParsedNflEvent[] {
  const parsed = parseEspnRegularSeasonEvents(payload, seasonYear);
  if (parsed.length !== EXPECTED_REGULAR_SEASON_GAMES) {
    throw new Error(
      `Expected ${EXPECTED_REGULAR_SEASON_GAMES} regular-season NFL games for ${seasonYear}; received ${parsed.length}.`,
    );
  }
  const sourceIds = new Set(parsed.map((event) => event.sourceEventId));
  if (sourceIds.size !== parsed.length) {
    throw new Error(`ESPN returned duplicate regular-season event IDs for ${seasonYear}.`);
  }
  const matchups = new Set(parsed.map((event) =>
    `${event.week}:${event.awayAbbreviation}:${event.homeAbbreviation}`
  ));
  if (matchups.size !== parsed.length) {
    throw new Error(`ESPN returned duplicate regular-season week/matchups for ${seasonYear}.`);
  }
  const weeks = new Set(parsed.map((event) => event.week));
  if (
    weeks.size !== 18 ||
    [...weeks].some((week) => week < 1 || week > 18)
  ) {
    throw new Error(`ESPN did not return complete NFL Weeks 1 through 18 for ${seasonYear}.`);
  }
  return parsed;
}

export async function fetchEspnNflEvents(seasonYear: number): Promise<EspnScoreboardPayload> {
  const response = await fetch(
    `${ESPN_SCOREBOARD_URL}?dates=${seasonYear}0801-${seasonYear + 1}0228&limit=1000`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "NFL Auction Manager event importer/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`ESPN NFL scoreboard returned HTTP ${response.status}.`);
  return await response.json() as EspnScoreboardPayload;
}

const REALIZED_METRICS = [
  "wins", "losses", "ties", "pt_diff", "ordinary_wins", "marquee_wins",
  "ordinary_ties", "marquee_ties", "ordinary_pt_diff", "marquee_pt_diff",
] as const;

async function rebuildRealizedMetrics(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  seasonId: number,
): Promise<number> {
  await ensureNflSportPeriods(tx);
  const finals = await tx.select().from(eventsTable).where(and(
    eq(eventsTable.seasonId, seasonId),
    eq(eventsTable.sport, NFL_SPORT),
    eq(eventsTable.competition, NFL_REGULAR_SEASON),
    eq(eventsTable.source, "espn"),
    eq(eventsTable.status, "final"),
    lte(eventsTable.week, 18),
  ));

  const finalWeeks = [...new Set(finals.map((event) => event.week))].sort((a, b) => a - b);
  const periods = finalWeeks.length > 0
    ? await tx.select().from(sportPeriodsTable).where(and(
        eq(sportPeriodsTable.sport, NFL_SPORT),
          eq(sportPeriodsTable.competition, NFL_REGULAR_SEASON),
        inArray(sportPeriodsTable.sequence, finalWeeks),
      ))
    : [];
  const periodBySequence = new Map(periods.map((period) => [period.sequence, period.id]));
  const entries = await tx.select({
    entryId: calcuttaEntriesTable.id,
    teamId: calcuttaEntriesTable.teamId,
  }).from(calcuttaEntriesTable).innerJoin(
    calcuttasTable,
    eq(calcuttasTable.id, calcuttaEntriesTable.calcuttaId),
  ).where(and(
    eq(calcuttasTable.seasonId, seasonId),
    eq(calcuttasTable.sport, NFL_SPORT),
  ));

  // Reconciliation is a replacement of provider-derived regular-season facts,
  // not an append. This removes stale weeks if a provider corrects a status or
  // withdraws a previously final result.
  const regularPeriods = await tx.select({ id: sportPeriodsTable.id })
    .from(sportPeriodsTable)
    .where(and(
      eq(sportPeriodsTable.sport, NFL_SPORT),
      eq(sportPeriodsTable.competition, NFL_REGULAR_SEASON),
      gte(sportPeriodsTable.sequence, 1),
      lte(sportPeriodsTable.sequence, 18),
    ));
  const entryIds = entries.map((entry) => entry.entryId);
  const regularPeriodIds = regularPeriods.map((period) => period.id);
  if (entryIds.length > 0 && regularPeriodIds.length > 0) {
    await tx.delete(snapshotMetricsTable).where(and(
      inArray(snapshotMetricsTable.entryId, entryIds),
      inArray(snapshotMetricsTable.periodId, regularPeriodIds),
      eq(snapshotMetricsTable.basis, "realized"),
    ));
    await tx.delete(teamPeriodSnapshotsTable).where(and(
      inArray(teamPeriodSnapshotsTable.entryId, entryIds),
      inArray(teamPeriodSnapshotsTable.periodId, regularPeriodIds),
      eq(teamPeriodSnapshotsTable.basis, "realized"),
    ));
  }

  let rowsWritten = 0;
  for (const week of finalWeeks) {
    const periodId = periodBySequence.get(week);
    if (!periodId) throw new Error(`NFL Week ${week} period was not seeded.`);
    const games = finals.filter((event) =>
      event.week <= week &&
      event.kickoffAt &&
      event.homeScore != null &&
      event.awayScore != null
    ).map((event) => normalizeNflGame({
      seasonId,
      source: "events",
      sourceGameId: event.sourceEventId,
      periodSequence: event.week,
      round: "regular",
      homeTeamId: event.homeTeamId,
      awayTeamId: event.awayTeamId,
      homeScore: event.homeScore!,
      awayScore: event.awayScore!,
      actualKickoffAt: event.kickoffAt!,
      status: "final",
      sourceData: event.sourceData,
    }));
    const aggregate = aggregateNflRegularSeasonGames(games);
    for (const entry of entries) {
      const stats = aggregate.get(entry.teamId) ?? {
        wins: 0, losses: 0, ties: 0, ordinaryWins: 0, marqueeWins: 0,
        ordinaryTies: 0, marqueeTies: 0, ordinaryPtDiff: 0, marqueePtDiff: 0,
      };
      const values = [
        stats.wins, stats.losses, stats.ties,
        stats.ordinaryPtDiff + NFL_MARQUEE_MULTIPLIER * stats.marqueePtDiff,
        stats.ordinaryWins, stats.marqueeWins, stats.ordinaryTies,
        stats.marqueeTies, stats.ordinaryPtDiff, stats.marqueePtDiff,
      ];
      const capturedAt = new Date();
      for (let index = 0; index < REALIZED_METRICS.length; index += 1) {
        const row = {
          entryId: entry.entryId,
          periodId,
          basis: "realized" as const,
          metric: REALIZED_METRICS[index],
          value: String(values[index]),
          source: "events",
          sourceData: { throughWeek: week, finalGames: games.length },
          snapshotAt: capturedAt,
        };
        await tx.insert(snapshotMetricsTable).values(row).onConflictDoUpdate({
          target: [
            snapshotMetricsTable.entryId,
            snapshotMetricsTable.periodId,
            snapshotMetricsTable.basis,
            snapshotMetricsTable.metric,
          ],
          set: row,
        });
        rowsWritten += 1;
      }
      const legacyRow = {
        entryId: entry.entryId, periodId, basis: "realized" as const,
        wins: String(stats.wins), losses: String(stats.losses), ties: String(stats.ties),
        ptDiff: String(values[3]), ordinaryWins: String(stats.ordinaryWins),
        marqueeWins: String(stats.marqueeWins), ordinaryTies: String(stats.ordinaryTies),
        marqueeTies: String(stats.marqueeTies), ordinaryPtDiff: String(stats.ordinaryPtDiff),
        marqueePtDiff: String(stats.marqueePtDiff), capturedAt,
      };
      await tx.insert(teamPeriodSnapshotsTable).values(legacyRow).onConflictDoUpdate({
        target: [
          teamPeriodSnapshotsTable.entryId,
          teamPeriodSnapshotsTable.periodId,
          teamPeriodSnapshotsTable.basis,
        ],
        set: legacyRow,
      });
    }
  }
  return rowsWritten;
}

export async function syncNflEventsAndRealizedMetricsTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  seasonId: number,
  seasonYear: number,
  payload: EspnScoreboardPayload,
): Promise<{ eventsUpserted: number; finalGamesProjected: number; metricsUpserted: number }> {
  const parsed = validateEspnRegularSeasonEvents(payload, seasonYear);
  const teamRows = await tx.select().from(teamsTable);
  const teamIdByName = new Map(teamRows.map((team) => [team.name, team.id]));
  const resolveTeamId = (abbreviation: string): number => {
    const name = TEAM_ABBREVIATION_ALIASES[abbreviation];
    const id = name ? teamIdByName.get(name) : undefined;
    if (!id) throw new Error(`Could not resolve NFL team ${abbreviation}.`);
    return id;
  };

  let projected = 0;
  // Both ledgers are provider slices derived from the same validated payload.
  // Replacement handles provider ID corrections and withdrawn games cleanly.
  await tx.delete(nflGamesTable).where(and(
    eq(nflGamesTable.seasonId, seasonId),
    eq(nflGamesTable.source, "espn"),
  ));
  await tx.delete(eventsTable).where(and(
    eq(eventsTable.seasonId, seasonId),
    eq(eventsTable.sport, NFL_SPORT),
    eq(eventsTable.competition, NFL_REGULAR_SEASON),
    eq(eventsTable.source, "espn"),
  ));
  for (const event of parsed) {
      const awayTeamId = resolveTeamId(event.awayAbbreviation);
      const homeTeamId = resolveTeamId(event.homeAbbreviation);
      const row = {
        seasonId, sport: NFL_SPORT, competition: NFL_REGULAR_SEASON,
        source: "espn", sourceEventId: event.sourceEventId,
        week: event.week, eventDate: event.eventDate, kickoffAt: event.kickoffAt,
        timezone: "America/New_York", awayTeamId, homeTeamId, venue: event.venue,
        network: event.network, status: event.status, awayScore: event.awayScore,
        homeScore: event.homeScore, sourceData: event.sourceData,
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
      if (
        event.status === "final" &&
        event.kickoffAt &&
        event.homeScore != null &&
        event.awayScore != null
      ) {
        const gameRow = {
          seasonId, source: "espn", sourceGameId: event.sourceEventId,
          periodSequence: event.week, round: "regular", homeTeamId, awayTeamId,
          homeScore: event.homeScore, awayScore: event.awayScore,
          actualKickoffAt: event.kickoffAt,
          isMarquee: isNflMarqueeKickoff(event.kickoffAt),
          marqueeMultiplier: isNflMarqueeKickoff(event.kickoffAt)
            ? NFL_MARQUEE_MULTIPLIER
            : 1,
          status: "final", sourceData: { canonicalEventSource: "espn" },
        };
        await tx.insert(nflGamesTable).values(gameRow).onConflictDoUpdate({
          target: [nflGamesTable.seasonId, nflGamesTable.source, nflGamesTable.sourceGameId],
          set: gameRow,
        });
        projected += 1;
      }
  }
  const metricsUpserted = await rebuildRealizedMetrics(tx, seasonId);
  return {
    eventsUpserted: parsed.length,
    finalGamesProjected: projected,
    metricsUpserted,
  };
}

export async function syncNflEventsAndRealizedMetrics(
  seasonId: number,
  seasonYear: number,
  payload: EspnScoreboardPayload,
): Promise<{ eventsUpserted: number; finalGamesProjected: number; metricsUpserted: number }> {
  return db.transaction((tx) =>
    syncNflEventsAndRealizedMetricsTx(tx, seasonId, seasonYear, payload)
  );
}