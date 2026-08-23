import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  importRunsTable,
  seasonsTable,
  teamResultsTable,
  teamSeasonAuctionsTable,
  teamsTable,
} from "@workspace/db";
import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "./ownershipShares";

export const NFL_STANDINGS_PHASE = "REG" as const;
export const NFL_STANDINGS_SOURCE = "nfl_standings_reg";
export const NFL_STANDINGS_MAX_BYTES = 4_000_000;
const COMPLETE_NFL_TEAM_COUNT = 32;

export type PlayoffStatus = "unknown" | "alive" | "clinched" | "eliminated";

export type NflStandingsTeam = {
  abbreviation: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  ptDiff: number;
  rank: number;
  playoffStatus: PlayoffStatus;
};

export type NflStandingsPayload = {
  seasonYear: number;
  phase: typeof NFL_STANDINGS_PHASE;
  sourceUrl: string;
  fetchedAt: string;
  sourceHash: string;
  teams: NflStandingsTeam[];
};

export type ResolvedNflStandingsTeam = NflStandingsTeam & {
  teamId: number;
  registeredTeamName: string;
  conference: string;
  division: string;
};

export class NflStandingsImportError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = "NflStandingsImportError";
    this.statusCode = statusCode;
  }
}

export const NFL_TEAM_CATALOG: Record<
  string,
  { name: string; conference: "AFC" | "NFC"; division: "East" | "North" | "South" | "West" }
> = {
  ARI: { name: "Arizona Cardinals", conference: "NFC", division: "West" },
  ATL: { name: "Atlanta Falcons", conference: "NFC", division: "South" },
  BAL: { name: "Baltimore Ravens", conference: "AFC", division: "North" },
  BUF: { name: "Buffalo Bills", conference: "AFC", division: "East" },
  CAR: { name: "Carolina Panthers", conference: "NFC", division: "South" },
  CHI: { name: "Chicago Bears", conference: "NFC", division: "North" },
  CIN: { name: "Cincinnati Bengals", conference: "AFC", division: "North" },
  CLE: { name: "Cleveland Browns", conference: "AFC", division: "North" },
  DAL: { name: "Dallas Cowboys", conference: "NFC", division: "East" },
  DEN: { name: "Denver Broncos", conference: "AFC", division: "West" },
  DET: { name: "Detroit Lions", conference: "NFC", division: "North" },
  GB: { name: "Green Bay Packers", conference: "NFC", division: "North" },
  HOU: { name: "Houston Texans", conference: "AFC", division: "South" },
  IND: { name: "Indianapolis Colts", conference: "AFC", division: "South" },
  JAX: { name: "Jacksonville Jaguars", conference: "AFC", division: "South" },
  KC: { name: "Kansas City Chiefs", conference: "AFC", division: "West" },
  LV: { name: "Las Vegas Raiders", conference: "AFC", division: "West" },
  LAC: { name: "Los Angeles Chargers", conference: "AFC", division: "West" },
  LAR: { name: "Los Angeles Rams", conference: "NFC", division: "West" },
  MIA: { name: "Miami Dolphins", conference: "AFC", division: "East" },
  MIN: { name: "Minnesota Vikings", conference: "NFC", division: "North" },
  NE: { name: "New England Patriots", conference: "AFC", division: "East" },
  NO: { name: "New Orleans Saints", conference: "NFC", division: "South" },
  NYG: { name: "New York Giants", conference: "NFC", division: "East" },
  NYJ: { name: "New York Jets", conference: "AFC", division: "East" },
  PHI: { name: "Philadelphia Eagles", conference: "NFC", division: "East" },
  PIT: { name: "Pittsburgh Steelers", conference: "AFC", division: "North" },
  SEA: { name: "Seattle Seahawks", conference: "NFC", division: "West" },
  SF: { name: "San Francisco 49ers", conference: "NFC", division: "West" },
  TB: { name: "Tampa Bay Buccaneers", conference: "NFC", division: "South" },
  TEN: { name: "Tennessee Titans", conference: "AFC", division: "South" },
  WAS: { name: "Washington Commanders", conference: "NFC", division: "East" },
};

// nfl.com uses legacy two-letter logo identifiers for these franchises while
// the rest of the application uses the modern three-letter team abbreviations.
const NFL_SOURCE_ABBREVIATION_ALIASES: Record<string, string> = {
  AZ: "ARI",
  LA: "LAR",
};

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x2F;|&#47;/gi, "/")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number(decimal)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

function textFromHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function clubNameFromHtml(value: string): string {
  // nfl.com renders clinch/elimination letters inside the fullname element as
  // superscripts (for example, "Pittsburgh Steelers <sup>x</sup><sup>z</sup>").
  // Exclude only that marker markup from identity matching; the complete cell
  // is still inspected separately to derive playoffStatus.
  return textFromHtml(value.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, ""));
}

function integerCell(value: string, label: string, allowBlank = false): number {
  const text = textFromHtml(value);
  if (!text && allowBlank) return 0;
  if (!/^-?\d+$/.test(text)) {
    throw new NflStandingsImportError(`NFL standings ${label} is not an integer: "${text}".`);
  }
  return Number(text);
}

function teamMarkerStatus(teamCell: string, gamesPlayed: number): PlayoffStatus {
  const lower = teamCell.toLocaleLowerCase("en-US");
  if (/\beliminated\b/.test(lower)) return "eliminated";
  if (/\b(?:clinched|playoff|wild[\s-]?card|division|home[\s-]?field)\b/.test(lower)) {
    return "clinched";
  }
  const visible = textFromHtml(teamCell);
  if (/(?:^|\s)e(?:\s|$)/i.test(visible)) return "eliminated";
  if (/(?:^|\s)[xyz*](?:\s|$)/i.test(visible)) return "clinched";
  // The public standings table does not reliably distinguish a team that is
  // still alive from one eliminated before the final week. Never infer either
  // result from a missing marker; 0-0-0 is the unambiguous preseason case.
  return gamesPlayed === 0 ? "alive" : "unknown";
}

function sourceAbbreviation(teamCell: string): string {
  const matches = [...teamCell.matchAll(/\/logos\/([A-Z0-9]{2,4})(?:["'?/]|$)/gi)];
  const sourceAbbreviation = matches.at(-1)?.[1]?.toUpperCase();
  const abbreviation = sourceAbbreviation
    ? (NFL_SOURCE_ABBREVIATION_ALIASES[sourceAbbreviation] ?? sourceAbbreviation)
    : undefined;
  if (!abbreviation || !NFL_TEAM_CATALOG[abbreviation]) {
    throw new NflStandingsImportError("NFL standings row is missing a recognized team logo identifier.");
  }
  return abbreviation;
}

/**
 * Parses the server-rendered detailed tables on nfl.com. The adapter only
 * consumes the stable logo abbreviation and the first nine statistic columns;
 * decorative markup and additional columns are intentionally ignored.
 */
export function parseNflStandingsHtml(
  html: string,
  seasonYear: number,
  sourceUrl = `https://www.nfl.com/standings/conference/${seasonYear}/REG`,
): NflStandingsPayload {
  if (!html || html.length > NFL_STANDINGS_MAX_BYTES) {
    throw new NflStandingsImportError("NFL standings response is empty or exceeds the size limit.", 502);
  }

  const tables = [
    ...html.matchAll(
      /<table\b[^>]*d3-o-standings--detailed[^>]*>[\s\S]*?<\/table>/gi,
    ),
  ];
  if (tables.length === 0) {
    throw new NflStandingsImportError("NFL standings response did not contain detailed standings tables.", 502);
  }

  const teams: NflStandingsTeam[] = [];
  for (const tableMatch of tables) {
    const rows = [...tableMatch[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    for (const rowMatch of rows) {
      const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
        (match) => match[1],
      );
      if (cells.length < 9) continue;

      const fullNameMatch = cells[0]!.match(
        /class=["'][^"']*d3-o-club-fullname[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      );
      const teamName = clubNameFromHtml(fullNameMatch?.[1] ?? "");
      const abbreviation = sourceAbbreviation(cells[0]!);
      const expected = NFL_TEAM_CATALOG[abbreviation]!;
      if (!teamName || teamName !== expected.name) {
        throw new NflStandingsImportError(
          `NFL standings team ${abbreviation} is "${teamName}", expected "${expected.name}".`,
        );
      }

      const wins = integerCell(cells[1]!, `${abbreviation} wins`);
      const losses = integerCell(cells[2]!, `${abbreviation} losses`);
      const ties = integerCell(cells[3]!, `${abbreviation} ties`);
      const rank = integerCell(cells[4]!, `${abbreviation} rank`);
      const ptDiff = integerCell(cells[8]!, `${abbreviation} point differential`, true);
      teams.push({
        abbreviation,
        teamName,
        wins,
        losses,
        ties,
        ptDiff,
        rank,
        playoffStatus: teamMarkerStatus(cells[0]!, wins + losses + ties),
      });
    }
  }

  validateNflStandingsTeams(teams);
  const canonical = teams
    .slice()
    .sort((a, b) => a.abbreviation.localeCompare(b.abbreviation));
  return {
    seasonYear,
    phase: NFL_STANDINGS_PHASE,
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    sourceHash: createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex"),
    teams,
  };
}

export function validateNflStandingsTeams(teams: NflStandingsTeam[]): void {
  if (teams.length !== COMPLETE_NFL_TEAM_COUNT) {
    throw new NflStandingsImportError(
      `NFL standings must contain all ${COMPLETE_NFL_TEAM_COUNT} teams; received ${teams.length}.`,
    );
  }
  const seen = new Set<string>();
  for (const team of teams) {
    if (!NFL_TEAM_CATALOG[team.abbreviation]) {
      throw new NflStandingsImportError(`Unknown NFL team abbreviation "${team.abbreviation}".`);
    }
    if (seen.has(team.abbreviation)) {
      throw new NflStandingsImportError(`NFL standings contain duplicate team "${team.abbreviation}".`);
    }
    seen.add(team.abbreviation);
    if (
      !Number.isInteger(team.wins) ||
      !Number.isInteger(team.losses) ||
      !Number.isInteger(team.ties) ||
      team.wins < 0 ||
      team.losses < 0 ||
      team.ties < 0 ||
      team.wins + team.losses + team.ties > 17
    ) {
      throw new NflStandingsImportError(
        `Invalid ${team.abbreviation} record ${team.wins}-${team.losses}-${team.ties}; total games must be an integer from 0 to 17.`,
      );
    }
    if (!Number.isInteger(team.ptDiff) || !Number.isInteger(team.rank) || team.rank < 1 || team.rank > 32) {
      throw new NflStandingsImportError(`Invalid standings rank or point differential for ${team.abbreviation}.`);
    }
  }
}

export async function fetchNflStandingsPayload(
  seasonYear: number,
): Promise<NflStandingsPayload> {
  if (!Number.isInteger(seasonYear) || seasonYear < 2000 || seasonYear > 2100) {
    throw new NflStandingsImportError("seasonYear must be a valid NFL season year.", 400);
  }
  const sourceUrl = `https://www.nfl.com/standings/conference/${seasonYear}/REG`;
  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      headers: {
        accept: "text/html",
        "user-agent": "NFL Auction Manager standings importer/1.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new NflStandingsImportError(
      `Unable to fetch NFL standings: ${error instanceof Error ? error.message : "network error"}`,
      502,
    );
  }
  if (!response.ok) {
    throw new NflStandingsImportError(
      `NFL standings returned HTTP ${response.status}.`,
      502,
    );
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > NFL_STANDINGS_MAX_BYTES) {
    throw new NflStandingsImportError("NFL standings response exceeds the size limit.", 502);
  }
  const html = await response.text();
  return parseNflStandingsHtml(html, seasonYear, sourceUrl);
}

async function resolveSeasonId(seasonYear: number): Promise<number> {
  const seasons = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, seasonYear))
    .limit(1);
  if (!seasons[0]) throw new NflStandingsImportError(`Season ${seasonYear} not found.`, 404);
  return seasons[0].id;
}

async function hasReplay(seasonId: number, sourceHash: string): Promise<boolean> {
  const previousRuns = await db
    .select({ id: importRunsTable.id })
    .from(importRunsTable)
    .where(
      and(
        eq(importRunsTable.seasonId, seasonId),
        eq(importRunsTable.source, NFL_STANDINGS_SOURCE),
        eq(importRunsTable.sourceHash, sourceHash),
      ),
    )
    .limit(1);
  return Boolean(previousRuns[0]);
}

async function resolvePayload(
  payload: NflStandingsPayload,
  seasonYear: number,
  seasonId: number,
): Promise<{ seasonId: number; teams: ResolvedNflStandingsTeam[] }> {

  const [registeredTeams, auctions] = await Promise.all([
    db
      .select({
        id: teamsTable.id,
        name: teamsTable.name,
        conference: teamsTable.conference,
        division: teamsTable.division,
      })
      .from(teamsTable),
    db
      .select({ teamId: teamSeasonAuctionsTable.teamId })
      .from(teamSeasonAuctionsTable)
      .where(eq(teamSeasonAuctionsTable.seasonId, seasonId)),
  ]);
  const auctioned = new Set(auctions.map((row) => row.teamId));
  const resolved = payload.teams.map((sourceTeam) => {
    const expected = NFL_TEAM_CATALOG[sourceTeam.abbreviation]!;
    const matches = registeredTeams.filter(
      (team) =>
        team.name === expected.name &&
        team.conference === expected.conference &&
        team.division === expected.division,
    );
    if (matches.length !== 1) {
      throw new NflStandingsImportError(
        `NFL team ${sourceTeam.abbreviation} does not resolve to exactly one registered team.`,
      );
    }
    const team = matches[0]!;
    if (!auctioned.has(team.id)) {
      throw new NflStandingsImportError(
        `NFL team ${team.name} is not auctioned in season ${seasonYear}; refusing a partial pool import.`,
      );
    }
    return {
      ...sourceTeam,
      teamId: team.id,
      registeredTeamName: team.name,
      conference: team.conference,
      division: team.division,
    };
  });
  return { seasonId, teams: resolved };
}

export async function previewNflStandingsImport(seasonYear: number) {
  const payload = await fetchNflStandingsPayload(seasonYear);
  const seasonId = await resolveSeasonId(seasonYear);
  const resolved = await resolvePayload(payload, seasonYear, seasonId);
  const replay = await hasReplay(seasonId, payload.sourceHash);
  const current = await db
    .select({
      teamId: teamResultsTable.teamId,
      wins: teamResultsTable.wins,
      losses: teamResultsTable.losses,
      ties: teamResultsTable.ties,
      ptDiff: teamResultsTable.ptDiff,
      playoffStatus: teamResultsTable.playoffStatus,
    })
    .from(teamResultsTable)
    .where(eq(teamResultsTable.seasonId, resolved.seasonId));
  const currentByTeam = new Map(current.map((row) => [row.teamId, row]));
  return {
    seasonYear,
    phase: payload.phase,
    sourceUrl: payload.sourceUrl,
    sourceHash: payload.sourceHash,
    fetchedAt: payload.fetchedAt,
    teamCount: resolved.teams.length,
    replay,
    teams: resolved.teams.map((team) => {
      const existing = currentByTeam.get(team.teamId);
      return {
        ...team,
        changed:
          !existing ||
          Number(existing.wins) !== team.wins ||
          existing.losses !== team.losses ||
          existing.ties !== team.ties ||
          existing.ptDiff !== team.ptDiff ||
          existing.playoffStatus !== team.playoffStatus,
      };
    }),
  };
}

export async function applyNflStandingsImport(args: {
  seasonYear: number;
  requestedBy: string;
  requestId?: string;
  periodSequence?: number;
}) {
  if (args.periodSequence !== undefined) {
    throw new NflStandingsImportError(
      "Automatic NFL standings imports do not infer a reporting week from cumulative standings; use the period snapshot endpoint with an explicit period.",
      400,
    );
  }
  const seasonId = await resolveSeasonId(args.seasonYear);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    // A season lock covers the remote fetch through the commit. This prevents
    // an older response from acquiring the lock after a newer import.
    const payload = await fetchNflStandingsPayload(args.seasonYear);
    const resolved = await resolvePayload(payload, args.seasonYear, seasonId);
    const replay = await tx
      .select({ id: importRunsTable.id })
      .from(importRunsTable)
      .where(
        and(
          eq(importRunsTable.seasonId, resolved.seasonId),
          eq(importRunsTable.source, NFL_STANDINGS_SOURCE),
          eq(importRunsTable.sourceHash, payload.sourceHash),
        ),
      )
      .limit(1);
    if (replay[0]) {
      return {
        seasonYear: args.seasonYear,
        source: NFL_STANDINGS_SOURCE,
        sourceUrl: payload.sourceUrl,
        sourceHash: payload.sourceHash,
        fetchedAt: payload.fetchedAt,
        importedTeams: 0,
        replay: true,
      };
    }

    for (const team of resolved.teams) {
      await tx
        .insert(teamResultsTable)
        .values({
          teamId: team.teamId,
          seasonId: resolved.seasonId,
          wins: String(team.wins),
          losses: team.losses,
          ties: team.ties,
          ptDiff: team.ptDiff,
          playoffStatus: team.playoffStatus,
        })
        .onConflictDoUpdate({
          target: [teamResultsTable.teamId, teamResultsTable.seasonId],
          set: {
            wins: String(team.wins),
            losses: team.losses,
            ties: team.ties,
            ptDiff: team.ptDiff,
            playoffStatus: team.playoffStatus,
          },
        });
    }
    await tx.insert(importRunsTable).values({
      seasonId: resolved.seasonId,
      source: NFL_STANDINGS_SOURCE,
      sourceHash: payload.sourceHash,
      importedTeams: resolved.teams.length,
      importedOwners: 0,
      requestedBy: args.requestedBy,
      requestId: args.requestId ?? null,
    });
    return {
      seasonYear: args.seasonYear,
      source: NFL_STANDINGS_SOURCE,
      sourceUrl: payload.sourceUrl,
      sourceHash: payload.sourceHash,
      fetchedAt: payload.fetchedAt,
      importedTeams: resolved.teams.length,
      replay: false,
    };
  });
}