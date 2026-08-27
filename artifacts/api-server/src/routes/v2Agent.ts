import { and, asc, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  biddersTable,
  calcuttaEntriesTable,
  calcuttasTable,
  eventMarketSnapshotsTable,
  eventProjectionsTable,
  eventsTable,
  payoutRulesTable,
  seasonsTable,
  teamResultsTable,
  teamsTable,
} from "@workspace/db";
import type { IRouter } from "express";
import { Router } from "express";
import {
  GetConsortiumLeaderboardV2Response,
  GetGameV2Response,
  GetOwnerPortfolioPerformanceV2Response,
  GetOwnerPortfolioV2Response,
  GetOwnerSummaryV2Response,
  GetPointsRubricV2Response,
  GetScheduleV2Response,
  GetTeamScheduleV2Response,
} from "@workspace/api-zod";
import {
  NFL_MARQUEE_MULTIPLIER,
  NFL_STARTING_POINTS,
  RETURN_METRICS,
  hasConfiguredPayoutRulesForCalcutta,
  isNflMarqueeKickoff,
  loadCalculatedTeamReturnsForCalcutta,
  validateNflPayoutRules,
  type CalculatedTeamReturns,
} from "../lib/calcuttaReturns";
import { resolveCalcuttaId } from "../lib/calcuttaContext";
import {
  loadCalcuttaConsortiums,
} from "../lib/consortiumMemberships";
import { loadSeasonOwnership, type OwnerEntry } from "../lib/seasonOwnership";
import { TEAM_ABBREVIATION_ALIASES } from "../lib/nflEventSync";
import { timestampInNewYork } from "../lib/newYorkTime";
import { NFL_REGULAR_SEASON, NFL_SPORT } from "../lib/eventIngestion";

const router: IRouter = Router();
const basisSchema = z.enum(["realized", "mtm"]).default("realized");
const membershipViewSchema = z.enum(["historical", "current"]).default("historical");
const queryNumber = z.coerce.number().int();

const ownerQuery = z.object({
  owner: z.string().trim().min(1),
  season: queryNumber,
  calcuttaId: z.coerce.number().int().positive().optional(),
  period: queryNumber.min(0).max(22).optional(),
  basis: basisSchema,
});

const scheduleQuery = z.object({
  season: queryNumber,
  team: z.string().trim().min(1).optional(),
  week: queryNumber.min(0).max(22).optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  include_market: z.coerce.boolean().default(false),
  include_projection: z.coerce.boolean().default(false),
  calcuttaId: z.coerce.number().int().positive().optional(),
});

const teamScheduleQuery = scheduleQuery.extend({
  team: z.string().trim().min(1),
  basis: basisSchema,
  period: queryNumber.min(0).max(22).optional(),
});

const gameQuery = z.object({
  game_id: z.string().trim().min(1),
  season: queryNumber,
  basis: basisSchema,
  period: queryNumber.min(0).max(22).optional(),
  calcuttaId: z.coerce.number().int().positive().optional(),
});

const rubricQuery = z.object({
  season: queryNumber,
  calcuttaId: z.coerce.number().int().positive().optional(),
});

const leaderboardQuery = z.object({
  season: queryNumber,
  calcuttaId: z.coerce.number().int().positive().optional(),
  period: queryNumber.min(0).max(22).optional(),
  basis: basisSchema,
  membershipView: membershipViewSchema,
});

type Context = {
  seasonId: number;
  seasonYear: number;
  calcuttaId: number;
};

type TeamRow = typeof teamsTable.$inferSelect;

type TeamPortfolioRow = {
  teamId: number;
  team: string;
  abbreviation: null;
  ownershipPercentage: number;
  originalOwnershipPercentage: number;
  costBasis: number;
  tradePaid: number;
  tradeReceived: number;
  currentMtm: number | null;
  realizedReturn: number | null;
  netMtm: number | null;
  netReturn: number | null;
  valueSource: "calculated" | "legacy" | "unavailable";
  wins: number | null;
  losses: number | null;
  ties: number | null;
  pointDifferential: number | null;
  playoffStatus: string | null;
};

type Portfolio = {
  owner: string;
  season: number;
  calcuttaId: number;
  basis: "realized" | "mtm";
  throughPeriod: number | null;
  teams: TeamPortfolioRow[];
  totalCost: number;
  currentMtm: number | null;
  realizedReturn: number | null;
  totalReturn: number | null;
  roi: number | null;
  calculationStatus: "calculated" | "legacy" | "mixed" | "unavailable";
};

const TEAM_ABBREVIATION_BY_NAME = new Map(
  Object.entries(TEAM_ABBREVIATION_ALIASES).map(([abbreviation, name]) => [name, abbreviation]),
);

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function validateResponse(schema: z.ZodType, body: unknown): unknown {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`V2 response violated its OpenAPI contract: ${parsed.error.message}`);
  }
  return body;
}

function roundShare(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function teamAbbreviation(name: string): string | null {
  return TEAM_ABBREVIATION_BY_NAME.get(name) ?? null;
}

function portfolioTeamView(row: TeamPortfolioRow) {
  return {
    team_id: row.teamId,
    team: row.team,
    abbreviation: teamAbbreviation(row.team),
    ownership_percentage: row.ownershipPercentage,
    original_ownership_percentage: row.originalOwnershipPercentage,
    cost_basis: row.costBasis,
    trade_paid: row.tradePaid,
    trade_received: row.tradeReceived,
    current_mtm: row.currentMtm,
    realized_return: row.realizedReturn,
    net_mtm: row.netMtm,
    net_return: row.netReturn,
    value_source: row.valueSource,
    wins: row.wins,
    losses: row.losses,
    ties: row.ties,
    point_differential: row.pointDifferential,
    playoff_status: row.playoffStatus,
    playoff_seed: null,
  };
}

function portfolioView(body: Portfolio) {
  return {
    owner: body.owner,
    season: body.season,
    calcutta_id: body.calcuttaId,
    basis: body.basis,
    through_period: body.throughPeriod,
    total_cost: body.totalCost,
    current_mtm: body.currentMtm,
    realized_return: body.realizedReturn,
    total_return: body.totalReturn,
    roi: body.roi,
    calculation_status: body.calculationStatus,
    teams: body.teams.map(portfolioTeamView),
  };
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function resolveUniqueName<T extends { id: number; name: string }>(
  rows: T[],
  requested: string,
  label: string,
): T | { error: string } {
  const normalized = normalizeName(requested);
  const exact = rows.filter((row) => normalizeName(row.name) === normalized);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return { error: `${label} "${requested}" is ambiguous.` };
  const partial = rows.filter((row) =>
    normalizeName(row.name).includes(normalized) ||
    normalized.includes(normalizeName(row.name)),
  );
  if (partial.length === 1) return partial[0];
  if (!partial.length) return { error: `${label} "${requested}" not found.` };
  return { error: `${label} "${requested}" is ambiguous. Use the full registered name.` };
}

async function resolveContext(
  seasonYear: number,
  requestedCalcuttaId?: number,
): Promise<Context | { error: string; status: number }> {
  const season = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, seasonYear))
    .limit(1);
  if (!season[0]) return { error: `Season ${seasonYear} not found.`, status: 404 };
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId: season[0].id,
    calcuttaId: requestedCalcuttaId,
  });
  if (!calcuttaId) {
    return {
      error: `No NFL Calcutta found for season ${seasonYear}${requestedCalcuttaId ? ` and calcuttaId ${requestedCalcuttaId}` : ""}.`,
      status: 404,
    };
  }
  return { seasonId: season[0].id, seasonYear, calcuttaId };
}

function isContext(value: Context | { error: string; status: number }): value is Context {
  return "seasonId" in value;
}

async function loadTeamsById(teamIds?: number[]): Promise<Map<number, TeamRow>> {
  const rows = await db
    .select()
    .from(teamsTable)
    .where(teamIds ? inArray(teamsTable.id, teamIds) : undefined);
  return new Map(rows.map((team) => [team.id, team]));
}

async function loadTeamResults(seasonId: number): Promise<Map<number, typeof teamResultsTable.$inferSelect>> {
  const rows = await db
    .select()
    .from(teamResultsTable)
    .where(eq(teamResultsTable.seasonId, seasonId));
  return new Map(rows.map((row) => [row.teamId, row]));
}

function currentTeamMetrics(
  calculated: CalculatedTeamReturns | undefined,
  basis: "realized" | "mtm",
  legacy: typeof teamResultsTable.$inferSelect | undefined,
): Pick<TeamPortfolioRow, "wins" | "losses" | "ties" | "pointDifferential" | "playoffStatus"> {
  const latest = calculated?.[basis]?.latest;
  if (latest) {
    return {
      wins: Number(latest.wins),
      losses: Number(latest.losses),
      ties: Number(latest.ties),
      pointDifferential: Number(latest.ptDiff),
      playoffStatus: latest.playoffStatus,
    };
  }
  if (!legacy) {
    return { wins: null, losses: null, ties: null, pointDifferential: null, playoffStatus: null };
  }
  return {
    wins: Number(legacy.wins),
    losses: Number(legacy.losses),
    ties: Number(legacy.ties),
    pointDifferential: Number(legacy.ptDiff),
    playoffStatus: legacy.playoffStatus ?? null,
  };
}

function valueSource(
  calculated: CalculatedTeamReturns | undefined,
  basis: "realized" | "mtm",
  hasLegacy: boolean,
  rulesConfigured: boolean,
): "calculated" | "legacy" | "unavailable" {
  return calculated?.[basis]
    ? "calculated"
    : !rulesConfigured && hasLegacy
      ? "legacy"
      : "unavailable";
}

async function buildPortfolio(
  context: Context,
  bidderId: number,
  ownerName: string,
  basis: "realized" | "mtm",
  period?: number,
): Promise<Portfolio> {
  const ownership = await loadSeasonOwnership(context.seasonId, context.calcuttaId);
  const bidderTeams = ownership.byBidder.get(bidderId) ?? new Map<number, OwnerEntry>();
  const teamIds = [...bidderTeams.keys()];
  const [teams, results, calculated, rulesConfigured] = await Promise.all([
    loadTeamsById(teamIds),
    loadTeamResults(context.seasonId),
    loadCalculatedTeamReturnsForCalcutta(context.calcuttaId, period),
    hasConfiguredPayoutRulesForCalcutta(context.calcuttaId),
  ]);
  const entryRows = teamIds.length
    ? await db
      .select({
        teamId: calcuttaEntriesTable.teamId,
        realizedReturn: calcuttaEntriesTable.realizedReturn,
        markToMarket: calcuttaEntriesTable.markToMarket,
      })
      .from(calcuttaEntriesTable)
      .where(and(
        eq(calcuttaEntriesTable.calcuttaId, context.calcuttaId),
        inArray(calcuttaEntriesTable.teamId, teamIds),
      ))
    : [];
  const entryByTeam = new Map(entryRows.map((row) => [row.teamId, row]));
  const rows: TeamPortfolioRow[] = [];
  for (const [teamId, entry] of bidderTeams) {
    if (
      Math.abs(entry.effectiveShare) <= 0.00005 &&
      entry.tradePaid === 0 &&
      entry.tradeReceived === 0
    ) continue;
    const team = teams.get(teamId);
    if (!team) continue;
    const financial = entryByTeam.get(teamId);
    const calc = calculated.get(teamId);
    const source = valueSource(calc, basis, financial != null, rulesConfigured);
    const teamGrossRealized = calc?.realized?.grossReturn
      ?? (!rulesConfigured && financial ? Number(financial.realizedReturn) : null);
    const teamGrossMtm = calc?.mtm?.grossReturn
      ?? (!rulesConfigured && financial ? Number(financial.markToMarket) : null);
    const costBasis = entry.originalCostBasis + entry.tradePaid - entry.tradeReceived;
    const realizedReturn = teamGrossRealized == null ? null : roundMoney(teamGrossRealized * entry.effectiveShare);
    const currentMtm = teamGrossMtm == null ? null : roundMoney(teamGrossMtm * entry.effectiveShare);
    const metrics = currentTeamMetrics(calc, basis, results.get(teamId));
    rows.push({
      teamId,
      team: team.name,
      abbreviation: null,
      ownershipPercentage: roundShare(entry.effectiveShare * 100),
      originalOwnershipPercentage: roundShare(entry.originalShare * 100),
      costBasis: roundMoney(costBasis),
      tradePaid: roundMoney(entry.tradePaid),
      tradeReceived: roundMoney(entry.tradeReceived),
      currentMtm,
      realizedReturn,
      netMtm: currentMtm == null ? null : roundMoney(currentMtm - costBasis),
      netReturn: realizedReturn == null ? null : roundMoney(realizedReturn - costBasis),
      valueSource: source,
      ...metrics,
    });
  }
  rows.sort((a, b) => a.team.localeCompare(b.team));
  const totalCost = rows.reduce((sum, row) => sum + row.costBasis, 0);
  const currentMtm = rows.every((row) => row.currentMtm != null)
    ? roundMoney(rows.reduce((sum, row) => sum + (row.currentMtm ?? 0), 0))
    : null;
  const realizedReturn = rows.every((row) => row.realizedReturn != null)
    ? roundMoney(rows.reduce((sum, row) => sum + (row.realizedReturn ?? 0), 0))
    : null;
  const totalReturn = basis === "realized" ? realizedReturn : currentMtm;
  const statuses = new Set(rows.map((row) => row.valueSource));
  const calculationStatus = statuses.size === 0 || statuses.has("unavailable")
    ? "unavailable"
    : statuses.size === 1
      ? [...statuses][0] === "calculated" ? "calculated" : "legacy"
      : "mixed";
  const throughPeriod = rows.length
    ? Math.max(...rows
      .map((row) => calculated.get(row.teamId)?.[basis]?.latest.sequence)
      .filter((sequence): sequence is number => sequence != null), -1)
    : -1;
  return {
    owner: ownerName,
    season: context.seasonYear,
    calcuttaId: context.calcuttaId,
    basis,
    throughPeriod: throughPeriod >= 0 ? throughPeriod : null,
    teams: rows,
    totalCost: roundMoney(totalCost),
    currentMtm,
    realizedReturn,
    totalReturn,
    roi: totalReturn != null && totalCost > 0
      ? roundMoney((totalReturn - totalCost) / totalCost)
      : null,
    calculationStatus,
  };
}

async function resolveBidderForContext(context: Context, owner: string) {
  const ownership = await loadSeasonOwnership(context.seasonId, context.calcuttaId);
  const bidders = [...ownership.bidderNames.entries()].map(([id, name]) => ({ id, name }));
  const result = resolveUniqueName(bidders, owner, "Owner");
  return { ownership, result };
}

export async function getOwnerPortfolio(args: z.input<typeof ownerQuery>) {
  const parsed = ownerQuery.parse(args);
  const context = await resolveContext(parsed.season, parsed.calcuttaId);
  if (!isContext(context)) return { status: context.status, body: { error: context.error } };
  const { result } = await resolveBidderForContext(context, parsed.owner);
  if ("error" in result) return { status: 404, body: { error: result.error } };
  return {
    status: 200,
    body: validateResponse(
      GetOwnerPortfolioV2Response,
      portfolioView(await buildPortfolio(context, result.id, result.name, parsed.basis, parsed.period)),
    ),
  };
}

export async function getOwnerSummary(args: z.input<typeof ownerQuery>) {
  const parsed = ownerQuery.parse(args);
  const context = await resolveContext(parsed.season, parsed.calcuttaId);
  if (!isContext(context)) return { status: context.status, body: { error: context.error } };
  const { result } = await resolveBidderForContext(context, parsed.owner);
  if ("error" in result) return { status: 404, body: { error: result.error } };
  const body = await buildPortfolio(context, result.id, result.name, parsed.basis, parsed.period);
  return {
    status: 200,
    body: validateResponse(GetOwnerSummaryV2Response, {
      owner: body.owner,
      season: body.season,
      calcutta_id: body.calcuttaId,
      team_count: body.teams.length,
      total_cost: body.totalCost,
      current_mtm: body.currentMtm,
      realized_return: body.realizedReturn,
      total_return: body.totalReturn,
      roi: body.roi,
      basis: body.basis,
      through_period: body.throughPeriod,
      calculation_status: body.calculationStatus,
    }),
  };
}

export async function getOwnerPortfolioPerformance(args: z.input<typeof ownerQuery>) {
  const parsed = ownerQuery.parse(args);
  const context = await resolveContext(parsed.season, parsed.calcuttaId);
  if (!isContext(context)) return { status: context.status, body: { error: context.error } };
  const { result } = await resolveBidderForContext(context, parsed.owner);
  if ("error" in result) return { status: 404, body: { error: result.error } };
  const body = await buildPortfolio(context, result.id, result.name, parsed.basis, parsed.period);
  return {
    status: 200,
    body: validateResponse(GetOwnerPortfolioPerformanceV2Response, {
      owner: body.owner,
      season: body.season,
      calcutta_id: body.calcuttaId,
      basis: body.basis,
      through_period: body.throughPeriod,
      teams: body.teams.map(portfolioTeamView),
      calculation_status: body.calculationStatus,
    }),
  };
}

type EventView = typeof eventsTable.$inferSelect & {
  awayTeam: TeamRow;
  homeTeam: TeamRow;
};

async function resolveTeamForCalcutta(
  teamName: string,
  calcuttaId: number,
): Promise<TeamRow | { error: string }> {
  const teams = await db.select({
    id: teamsTable.id,
    name: teamsTable.name,
    conference: teamsTable.conference,
    division: teamsTable.division,
  }).from(teamsTable).innerJoin(
    calcuttaEntriesTable,
    eq(calcuttaEntriesTable.teamId, teamsTable.id),
  ).where(eq(calcuttaEntriesTable.calcuttaId, calcuttaId));
  const canonicalName = TEAM_ABBREVIATION_ALIASES[teamName.trim().toUpperCase()];
  if (canonicalName) {
    const team = teams.find((candidate) => candidate.name === canonicalName);
    if (team) return team;
  }
  return resolveUniqueName(teams, teamName, "Team");
}

async function loadEventViews(context: Context, args: z.infer<typeof scheduleQuery>): Promise<EventView[] | { error: string }> {
  let teamId: number | undefined;
  if (args.team) {
    const team = await resolveTeamForCalcutta(args.team, context.calcuttaId);
    if ("error" in team) return team;
    teamId = team.id;
  }
  const conditions = [
    eq(eventsTable.seasonId, context.seasonId),
    eq(eventsTable.sport, NFL_SPORT),
    eq(eventsTable.competition, NFL_REGULAR_SEASON),
  ];
  if (args.week != null) conditions.push(eq(eventsTable.week, args.week));
  if (args.date_from) conditions.push(gte(eventsTable.eventDate, args.date_from));
  if (args.date_to) conditions.push(lte(eventsTable.eventDate, args.date_to));
  if (teamId != null) {
    conditions.push(
      // The team can be either the home or away side.
      // This is deliberately scoped to the selected season above.
      or(eq(eventsTable.awayTeamId, teamId), eq(eventsTable.homeTeamId, teamId))!,
    );
  }
  const eventRows = await db
    .select()
    .from(eventsTable)
    .where(and(...conditions))
    .orderBy(asc(eventsTable.eventDate), asc(eventsTable.week), asc(eventsTable.id));
  const teamIds = [...new Set(eventRows.flatMap((event) => [event.awayTeamId, event.homeTeamId]))];
  const teamMap = await loadTeamsById(teamIds);
  return eventRows.flatMap((event) => {
    const awayTeam = teamMap.get(event.awayTeamId);
    const homeTeam = teamMap.get(event.homeTeamId);
    return awayTeam && homeTeam ? [{ ...event, awayTeam, homeTeam }] : [];
  });
}

async function latestMarketAndProjection(eventIds: number[]) {
  if (!eventIds.length) return { market: new Map(), projection: new Map() };
  const [markets, projections] = await Promise.all([
    db.select().from(eventMarketSnapshotsTable)
      .where(inArray(eventMarketSnapshotsTable.eventId, eventIds))
      .orderBy(desc(eventMarketSnapshotsTable.snapshotAt)),
    db.select().from(eventProjectionsTable)
      .where(inArray(eventProjectionsTable.eventId, eventIds))
      .orderBy(desc(eventProjectionsTable.snapshotAt)),
  ]);
  const market = new Map<number, (typeof markets)[number]>();
  for (const row of markets) if (!market.has(row.eventId)) market.set(row.eventId, row);
  const projection = new Map<number, (typeof projections)[number]>();
  for (const row of projections) if (!projection.has(row.eventId)) projection.set(row.eventId, row);
  return { market, projection };
}

function eventId(event: typeof eventsTable.$inferSelect): string {
  return `${event.source}:${event.sourceEventId}`;
}

function marketView(row: Awaited<ReturnType<typeof latestMarketAndProjection>>["market"] extends Map<number, infer T> ? T : never) {
  return row ? {
    snapshot_at: row.snapshotAt.toISOString(),
    source: row.source,
    spread: row.spread == null ? null : Number(row.spread),
    home_moneyline: row.homeMoneyline,
    away_moneyline: row.awayMoneyline,
    home_implied_probability: row.homeImpliedProbability == null ? null : Number(row.homeImpliedProbability),
    away_implied_probability: row.awayImpliedProbability == null ? null : Number(row.awayImpliedProbability),
    total: row.total == null ? null : Number(row.total),
  } : null;
}

function projectionView(row: Awaited<ReturnType<typeof latestMarketAndProjection>>["projection"] extends Map<number, infer T> ? T : never) {
  return row ? {
    snapshot_at: row.snapshotAt.toISOString(),
    source: row.source,
    model_name: row.modelName,
    home_win_probability: row.homeWinProbability == null ? null : Number(row.homeWinProbability),
    away_win_probability: row.awayWinProbability == null ? null : Number(row.awayWinProbability),
    projected_home_score: row.projectedHomeScore == null ? null : Number(row.projectedHomeScore),
    projected_away_score: row.projectedAwayScore == null ? null : Number(row.projectedAwayScore),
    projected_point_differential: row.projectedPointDifferential == null ? null : Number(row.projectedPointDifferential),
  } : null;
}

function scheduleGameView(
  item: EventView,
  market: ReturnType<typeof marketView>,
  projection: ReturnType<typeof projectionView>,
) {
  const event = item;
  const kickoffAt = event.kickoffAt ? timestampInNewYork(event.kickoffAt) : null;
  const isMarquee = kickoffAt == null ? null : isNflMarqueeKickoff(event.kickoffAt!);
  return {
    game_id: eventId(event),
    source_game_id: event.sourceEventId,
    database_id: event.id,
    week: event.week,
    date: event.eventDate,
    kickoff_at: kickoffAt,
    timezone: event.timezone,
    away_team: event.awayTeam.name,
    away_abbreviation: teamAbbreviation(event.awayTeam.name),
    home_team: event.homeTeam.name,
    home_abbreviation: teamAbbreviation(event.homeTeam.name),
    venue: event.venue,
    network: event.network,
    status: event.status,
    away_score: event.awayScore,
    home_score: event.homeScore,
    is_marquee: isMarquee,
    point_diff_multiplier: isMarquee == null ? null : isMarquee ? NFL_MARQUEE_MULTIPLIER : 1,
    source: event.source,
    updated_at: event.updatedAt.toISOString(),
    market,
    projection,
  };
}

export async function getSchedule(args: z.input<typeof scheduleQuery>) {
  const parsed = scheduleQuery.parse(args);
  const context = await resolveContext(parsed.season, parsed.calcuttaId);
  if (!isContext(context)) return { status: context.status, body: { error: context.error } };
  const events = await loadEventViews(context, parsed);
  if (!Array.isArray(events)) return { status: 400, body: { error: events.error } };
  const extras = await latestMarketAndProjection(events.map((item) => item.id));
  const games = events.map((item) => scheduleGameView(
    item,
    parsed.include_market ? marketView(extras.market.get(item.id)) : null,
    parsed.include_projection ? projectionView(extras.projection.get(item.id)) : null,
  ));
  return {
    status: 200,
    body: validateResponse(GetScheduleV2Response, {
      season: parsed.season,
      calcutta_id: context.calcuttaId,
      games,
    }),
  };
}

export async function getTeamSchedule(args: z.input<typeof teamScheduleQuery>) {
  const parsed = teamScheduleQuery.parse(args);
  const schedule = await getSchedule(parsed);
  if (schedule.status !== 200) return schedule;
  const context = await resolveContext(parsed.season, parsed.calcuttaId);
  if (!isContext(context)) return { status: context.status, body: { error: context.error } };
  const team = await resolveTeamForCalcutta(parsed.team, context.calcuttaId);
  if ("error" in team) return { status: 404, body: { error: team.error } };
  const ownership = await loadSeasonOwnership(context.seasonId, context.calcuttaId);
  const [calculated, rulesConfigured] = await Promise.all([
    loadCalculatedTeamReturnsForCalcutta(context.calcuttaId, parsed.period),
    hasConfiguredPayoutRulesForCalcutta(context.calcuttaId),
  ]);
  const teamResult = (await loadTeamResults(context.seasonId)).get(team.id);
  const entry = (await db.select({
    realizedReturn: calcuttaEntriesTable.realizedReturn,
    markToMarket: calcuttaEntriesTable.markToMarket,
  }).from(calcuttaEntriesTable).where(and(
    eq(calcuttaEntriesTable.calcuttaId, context.calcuttaId),
    eq(calcuttaEntriesTable.teamId, team.id),
  )).limit(1))[0];
  const teamCalc = calculated.get(team.id);
  const value = teamCalc?.[parsed.basis]?.grossReturn
    ?? (!rulesConfigured
      ? (parsed.basis === "realized" ? Number(entry?.realizedReturn ?? NaN) : Number(entry?.markToMarket ?? NaN))
      : NaN);
  const teamView = (schedule.body as { games: ReturnType<typeof scheduleGameView>[] }).games;
  return {
    status: 200,
    body: validateResponse(GetTeamScheduleV2Response, {
      season: parsed.season,
      calcutta_id: context.calcuttaId,
      team: team.name,
      games: teamView.map((game) => ({
        ...game,
        opponent: game.away_team === team.name ? game.home_team : game.away_team,
        home_away: game.home_team === team.name ? "home" : "away",
        current_calcutta_value: Number.isFinite(value) ? value : null,
        projected_ev_impact: null,
      })),
      ownership: ownership.currentOwnersByTeam.get(team.id) ?? [],
      record: teamResult ? {
        wins: Number(teamResult.wins),
        losses: Number(teamResult.losses),
        ties: Number(teamResult.ties),
        pointDifferential: Number(teamResult.ptDiff),
      } : null,
    }),
  };
}

async function findEvent(gameId: string, seasonId: number) {
  const scope = [
    eq(eventsTable.seasonId, seasonId),
    eq(eventsTable.sport, NFL_SPORT),
    eq(eventsTable.competition, NFL_REGULAR_SEASON),
  ];
  const numericId = /^\d+$/.test(gameId) ? Number(gameId) : -1;
  if (numericId >= 0) {
    const rows = await db.select().from(eventsTable).where(and(
      ...scope,
      eq(eventsTable.id, numericId),
    )).limit(1);
    return rows[0] ?? null;
  }
  if (gameId.includes(":")) {
    const [source, ...sourceIdParts] = gameId.split(":");
    const rows = await db.select().from(eventsTable).where(and(
      ...scope,
      eq(eventsTable.source, source),
      eq(eventsTable.sourceEventId, sourceIdParts.join(":")),
    )).limit(1);
    return rows[0] ?? null;
  }
  const rows = await db.select().from(eventsTable).where(and(
    ...scope,
    eq(eventsTable.sourceEventId, gameId),
  )).limit(2);
  if (rows.length > 1) return { error: `Game ID "${gameId}" is ambiguous. Use the source-prefixed game ID.` };
  return rows[0] ?? null;
}

export async function getGame(args: z.input<typeof gameQuery>) {
  const parsed = gameQuery.parse(args);
  const context = await resolveContext(parsed.season, parsed.calcuttaId);
  if (!isContext(context)) return { status: context.status, body: { error: context.error } };
  const event = await findEvent(parsed.game_id, context.seasonId);
  if (!event) return { status: 404, body: { error: `Game "${parsed.game_id}" not found in season ${parsed.season}.` } };
  if ("error" in event) return { status: 400, body: { error: event.error } };
  const teams = await loadTeamsById([event.awayTeamId, event.homeTeamId]);
  const awayTeam = teams.get(event.awayTeamId);
  const homeTeam = teams.get(event.homeTeamId);
  if (!awayTeam || !homeTeam) return { status: 500, body: { error: "Game references an unknown team." } };
  const extras = await latestMarketAndProjection([event.id]);
  const ownership = await loadSeasonOwnership(context.seasonId, context.calcuttaId);
  const [calculated, rulesConfigured] = await Promise.all([
    loadCalculatedTeamReturnsForCalcutta(context.calcuttaId, parsed.period),
    hasConfiguredPayoutRulesForCalcutta(context.calcuttaId),
  ]);
  const entryRows = await db.select({
    teamId: calcuttaEntriesTable.teamId,
    realizedReturn: calcuttaEntriesTable.realizedReturn,
    markToMarket: calcuttaEntriesTable.markToMarket,
  }).from(calcuttaEntriesTable).where(and(
    eq(calcuttaEntriesTable.calcuttaId, context.calcuttaId),
    inArray(calcuttaEntriesTable.teamId, [event.homeTeamId, event.awayTeamId]),
  ));
  const entryByTeam = new Map(entryRows.map((row) => [row.teamId, row]));
  const teamValue = (teamId: number) => {
    const calculatedValue = calculated.get(teamId)?.[parsed.basis]?.grossReturn;
    if (calculatedValue != null) return calculatedValue;
    const entry = entryByTeam.get(teamId);
    if (!entry || rulesConfigured) return null;
    return Number(parsed.basis === "realized" ? entry.realizedReturn : entry.markToMarket);
  };
  return {
    status: 200,
    body: validateResponse(GetGameV2Response, {
      game: scheduleGameView(
        { ...event, awayTeam, homeTeam },
        marketView(extras.market.get(event.id)),
        projectionView(extras.projection.get(event.id)),
      ),
      market: marketView(extras.market.get(event.id)),
      projection: projectionView(extras.projection.get(event.id)),
      calcutta: {
        calcutta_id: context.calcuttaId,
        is_relevant: Boolean(ownership.byBidder.size && (
          ownership.currentOwnersByTeam.has(event.homeTeamId) ||
          ownership.currentOwnersByTeam.has(event.awayTeamId)
        )),
        teams: [
          {
            team: homeTeam.name,
            owners: ownership.currentOwnersByTeam.get(event.homeTeamId) ?? [],
            current_value: teamValue(event.homeTeamId),
          },
          {
            team: awayTeam.name,
            owners: ownership.currentOwnersByTeam.get(event.awayTeamId) ?? [],
            current_value: teamValue(event.awayTeamId),
          },
        ],
      },
    }),
  };
}

const RUBRIC_DESCRIPTIONS: Record<string, { ruleName: string; unit: string; description: string }> = {
  win: { ruleName: "regular_season_win", unit: "points", description: "Points awarded for a regular-season win." },
  tie: { ruleName: "regular_season_tie", unit: "points", description: "Points awarded for a regular-season tie." },
  pt_diff: { ruleName: "point_differential", unit: "points_per_point", description: "Points awarded for adjusted point differential." },
  playoff_berth: { ruleName: "playoff_berth", unit: "points", description: "Points awarded for qualifying for the playoffs." },
  div_round: { ruleName: "divisional_round", unit: "points", description: "Points awarded for reaching the divisional round." },
  conf_round: { ruleName: "conference_championship", unit: "points", description: "Points awarded for reaching the conference championship." },
  sb_berth: { ruleName: "super_bowl_appearance", unit: "points", description: "Points awarded for reaching the Super Bowl." },
  win_super_bowl: { ruleName: "super_bowl_win", unit: "points", description: "Points awarded for winning the Super Bowl." },
};

export async function getPointsRubric(args: z.input<typeof rubricQuery>) {
  const parsed = rubricQuery.parse(args);
  const context = await resolveContext(parsed.season, parsed.calcuttaId);
  if (!isContext(context)) return { status: context.status, body: { error: context.error } };
  const rules = await db.select().from(payoutRulesTable)
    .where(eq(payoutRulesTable.calcuttaId, context.calcuttaId));
  const validRules = validateNflPayoutRules(rules.map((rule) => ({
    metric: rule.metric,
    dollarsPerUnit: Number(rule.dollarsPerUnit),
    playoffMultiplier: Number(rule.playoffMultiplier),
  }))).ok;
  const byMetric = new Map(rules.map((rule) => [rule.metric, rule]));
  const pointsRules: Array<{
    rule_name: string;
    metric: string;
    value: number | null;
    unit: string;
    multiplier: number | null;
    description: string;
  }> = RETURN_METRICS.map((metric) => {
    const descriptor = RUBRIC_DESCRIPTIONS[metric];
    const row = byMetric.get(metric);
    return {
      rule_name: descriptor.ruleName,
      metric,
      value: validRules && row ? Number(row.dollarsPerUnit) : null,
      unit: descriptor.unit,
      multiplier: validRules && row ? Number(row.playoffMultiplier) : null,
      description: descriptor.description,
    };
  });
  pointsRules.push({
    rule_name: "marquee_point_differential_multiplier",
    metric: "marquee_pt_diff",
    value: NFL_MARQUEE_MULTIPLIER,
    unit: "multiplier",
    multiplier: NFL_MARQUEE_MULTIPLIER,
    description: "Point differential receives a 2x multiplier for games outside Sunday 1:00–7:00 PM Eastern.",
  });
  return {
    status: 200,
    body: validateResponse(GetPointsRubricV2Response, {
      season: parsed.season,
      calcutta_id: context.calcuttaId,
      starting_points: NFL_STARTING_POINTS,
      rules: pointsRules,
    }),
  };
}

export async function getConsortiumLeaderboard(args: z.input<typeof leaderboardQuery>) {
  const parsed = leaderboardQuery.parse(args);
  const context = await resolveContext(parsed.season, parsed.calcuttaId);
  if (!isContext(context)) return { status: context.status, body: { error: context.error } };
  const ownership = await loadSeasonOwnership(context.seasonId, context.calcuttaId);
  const consortiums = await loadCalcuttaConsortiums(context.calcuttaId, parsed.membershipView);
  const groups = new Map<string, { totalCost: number; totalReturn: number; totalMtm: number; realizedAvailable: boolean; mtmAvailable: boolean; owners: Set<number> }>();
  for (const bidderId of ownership.participantIds) {
    const name = consortiums.get(bidderId) ?? "Unassigned";
    const portfolio = await buildPortfolio(
      context,
      bidderId,
      ownership.bidderNames.get(bidderId) ?? "Unknown",
      parsed.basis,
      parsed.period,
    );
    const group = groups.get(name) ?? { totalCost: 0, totalReturn: 0, totalMtm: 0, realizedAvailable: true, mtmAvailable: true, owners: new Set<number>() };
    group.totalCost += portfolio.totalCost;
    if (portfolio.realizedReturn == null) group.realizedAvailable = false;
    else group.totalReturn += portfolio.realizedReturn;
    if (portfolio.currentMtm == null) group.mtmAvailable = false;
    else group.totalMtm += portfolio.currentMtm;
    group.owners.add(bidderId);
    groups.set(name, group);
  }
  const rows = [...groups.entries()].map(([consortium, group]) => {
    const selectedValue = parsed.basis === "mtm" ? group.totalMtm : group.totalReturn;
    const selectedAvailable = parsed.basis === "mtm" ? group.mtmAvailable : group.realizedAvailable;
    const net = selectedAvailable ? selectedValue - group.totalCost : null;
    return {
      consortium,
      owner_count: group.owners.size,
      total_cost: roundMoney(group.totalCost),
      realized_return: group.realizedAvailable ? roundMoney(group.totalReturn) : null,
      current_mtm: group.mtmAvailable ? roundMoney(group.totalMtm) : null,
      net_return: parsed.basis === "realized" && net != null ? roundMoney(net) : null,
      net_mtm: parsed.basis === "mtm" && net != null ? roundMoney(net) : null,
      roi: net != null && group.totalCost > 0 ? roundMoney(net / group.totalCost) : null,
    };
  }).sort((a, b) => (parsed.basis === "mtm" ? (b.net_mtm ?? 0) - (a.net_mtm ?? 0) : (b.net_return ?? 0) - (a.net_return ?? 0)));
  return {
    status: 200,
    body: validateResponse(GetConsortiumLeaderboardV2Response, {
      season: parsed.season,
      calcutta_id: context.calcuttaId,
      basis: parsed.basis,
      through_period: parsed.period ?? null,
      membership_view: parsed.membershipView,
      rows: rows.map((row, index) => ({ rank: index + 1, ...row })),
    }),
  };
}

function respond(result: { status: number; body: unknown }, res: import("express").Response) {
  res.status(result.status).json(result.body);
}

router.get("/v2/owner/portfolio", async (req, res): Promise<void> => {
  const parsed = ownerQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  respond(await getOwnerPortfolio(parsed.data), res);
});
router.get("/v2/owner/summary", async (req, res): Promise<void> => {
  const parsed = ownerQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  respond(await getOwnerSummary(parsed.data), res);
});
router.get("/v2/owner/portfolio/performance", async (req, res): Promise<void> => {
  const parsed = ownerQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  respond(await getOwnerPortfolioPerformance(parsed.data), res);
});
router.get("/v2/schedule", async (req, res): Promise<void> => {
  const parsed = scheduleQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  respond(await getSchedule(parsed.data), res);
});
router.get("/v2/team/schedule", async (req, res): Promise<void> => {
  const parsed = teamScheduleQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  respond(await getTeamSchedule(parsed.data), res);
});
router.get("/v2/game", async (req, res): Promise<void> => {
  const parsed = gameQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  respond(await getGame(parsed.data), res);
});
router.get("/v2/points-rubric", async (req, res): Promise<void> => {
  const parsed = rubricQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  respond(await getPointsRubric(parsed.data), res);
});
router.get("/v2/leaderboard/consortia", async (req, res): Promise<void> => {
  const parsed = leaderboardQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  respond(await getConsortiumLeaderboard(parsed.data), res);
});

export default router;