import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  calcuttaEntriesTable,
  calcuttasTable,
  db,
  mtmEntryValuationTable,
  mtmMarketQuoteTable,
  mtmSnapshotTable,
  mtmSnapshotsTable,
  mtmTeamProjectionTable,
  mtmCalibrationMetricTable,
  mtmGameConditionalTable,
  calcuttaCalendarsTable,
  calendarRoundsTable,
  calendarSlotsTable,
  calendarProjectionSnapshotsTable,
  nflGamesTable,
  positionsTable,
  seasonsTable,
  teamsTable,
  eventsTable,
  mtmCanonicalPeriodSelectionTable,
  mtmValuationVersionTable,
  sportPeriodsTable,
} from "@workspace/db";
import { loadSeasonOwnership } from "./seasonOwnership";
import {
  isNflMarqueeKickoff,
  NFL_SCORING_ADAPTER,
} from "./competitionScoring";
import { flattenEngineConditionals } from "./mtmValuationHelpers";

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = existsSync(resolve(process.cwd(), "mtm"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const ENGINE_DIR = resolve(WORKSPACE_ROOT, "mtm/engine");
const CONFIG_PATH = resolve(WORKSPACE_ROOT, "mtm/season-config-2026.json");
const CONDITIONAL_PERSISTENCE_BATCH_SIZE = 500;
const ENGINE_TIMEOUT_MS = 15 * 60_000;
const MTM_LEASE_DURATION_MS = 5 * 60_000;
const MTM_LEASE_HEARTBEAT_MS = 60_000;
const TEAM_CODE_BY_NAME: Record<string, string> = {
  "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
  "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
  "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
  "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
  "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAC",
  "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
  "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
  "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
  "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
  "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
  "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
};

type MtmState = {
  as_of: string;
  pot: number;
  entries: Array<{ entry_id: string; team: string; price: number }>;
  realized: Record<string, { wins: number; ties: number; adj_pt_diff: number }>;
  remaining_schedule: Array<{ event_id: number; home: string; away: string; marquee: boolean; week: number }>;
  completed_results?: Array<{
    week: number;
    home: string;
    away: string;
    home_score: number;
    away_score: number;
  }>;
  divisions: Record<string, string[]>;
  win_ladders: Record<string, Array<{
    strike: number;
    yes_bid: number | null;
    yes_ask: number | null;
    volume: number;
    status: string | null;
    result: string | null;
  }>>;
  elimination_quotes: Record<string, Record<string, number>>;
};

type EngineSnapshot = {
  status: "ok" | "failed";
  as_of: string;
  error?: string;
  projections?: Record<string, Record<string, unknown>>;
  valuations?: Array<Record<string, unknown>>;
  diagnostics?: Record<string, unknown>;
  path_count?: number;
  model?: { name?: string; seed?: number };
  calibration?: Array<Record<string, unknown>>;
  conditionals?: Array<Record<string, unknown>>;
  calibration_metrics?: Array<Record<string, unknown>>;
  conditional_payouts?: Record<string, unknown>;
};

type RawMarketQuote = {
  series: string;
  team: string;
  market: Record<string, unknown>;
  sourceUrl?: string;
  fetchedAt?: Date;
};

type FetchedMarkets = {
  markets: any[];
  sourceUrl: string;
  fetchedAt: Date;
};

type InputSource = {
  provider: string;
  source_url: string | null;
  source_id: string;
  fetched_at: string | null;
};

type MtmInputProvenance = {
  schema_version: "1.0";
  schedule: Array<InputSource & {
    week: number;
    home: string;
    away: string;
    marquee: boolean;
  }>;
  realized_results: Array<InputSource & {
    week: number;
    home: string;
    away: string;
    home_score: number;
    away_score: number;
  }>;
  standings: Array<{
    provider: "derived_nfl_game_ledger";
    source_id: string;
    team: string;
    wins: number;
    ties: number;
    adjusted_point_differential: number;
    fetched_at: string | null;
    sources: InputSource[];
  }>;
};

type CanonicalScheduleEvent = {
  id: number;
  source: string;
  sourceEventId: string;
  week: number;
  kickoffAt: Date | null;
  sourceData: Record<string, unknown> | null;
  updatedAt: Date;
  homeTeamId: number;
  awayTeamId: number;
};

export function buildCanonicalRemainingSchedule(
  events: CanonicalScheduleEvent[],
  teamCodeById: Map<number, string>,
): {
  schedule: MtmState["remaining_schedule"];
  provenance: MtmInputProvenance["schedule"];
} {
  const rows = events.map((event) => {
    const home = teamCodeById.get(event.homeTeamId);
    const away = teamCodeById.get(event.awayTeamId);
    if (!home || !away) {
      throw new Error(`Canonical NFL event ${event.id} references a team outside the selected Calcutta.`);
    }
    const kickoffTimeConfirmed =
      event.kickoffAt != null && event.sourceData?.kickoffTimeConfirmed !== false;
    const marquee = kickoffTimeConfirmed
      ? isNflMarqueeKickoff(event.kickoffAt!)
      : false;
    const sourceUrl =
      typeof event.sourceData?.sourceUrl === "string" ? event.sourceData.sourceUrl : null;
    const sourceFetchedAt =
      typeof event.sourceData?.sourceFetchedAt === "string"
        ? event.sourceData.sourceFetchedAt
        : event.updatedAt.toISOString();
    return {
      game: {
        event_id: event.id,
        home,
        away,
        marquee,
        week: event.week,
      },
      source: {
        provider: event.source,
        source_url: sourceUrl,
        source_id: event.sourceEventId,
        fetched_at: sourceFetchedAt,
        week: event.week,
        home,
        away,
        marquee,
      },
    };
  });
  return {
    schedule: rows.map((row) => row.game),
    provenance: rows.map((row) => row.source),
  };
}

function mergeTeamQuoteResults(
  teamCode: string,
  series: { win_totals: string; stage_of_elimination: string },
  winResult: PromiseSettledResult<any[] | FetchedMarkets>,
  stageResult: PromiseSettledResult<any[] | FetchedMarkets>,
): { raw: RawMarketQuote[]; errors: string[] } {
  const raw: RawMarketQuote[] = [];
  const errors: string[] = [];
  if (winResult.status === "fulfilled") {
    const fetched = Array.isArray(winResult.value)
      ? { markets: winResult.value, sourceUrl: undefined, fetchedAt: undefined }
      : winResult.value;
    raw.push(...fetched.markets.map((market) => ({
      series: series.win_totals, team: teamCode, market,
      sourceUrl: fetched.sourceUrl, fetchedAt: fetched.fetchedAt,
    })));
    if (fetched.markets.length === 0) {
      errors.push(`${teamCode} win totals: no markets received`);
    }
  } else {
    errors.push(`${teamCode} win totals: ${String(winResult.reason)}`);
  }
  if (stageResult.status === "fulfilled") {
    const fetched = Array.isArray(stageResult.value)
      ? { markets: stageResult.value, sourceUrl: undefined, fetchedAt: undefined }
      : stageResult.value;
    raw.push(...fetched.markets.map((market) => ({
      series: series.stage_of_elimination, team: teamCode, market,
      sourceUrl: fetched.sourceUrl, fetchedAt: fetched.fetchedAt,
    })));
    if (fetched.markets.length === 0) {
      errors.push(`${teamCode} stage of elimination: no markets received`);
    }
  } else {
    errors.push(`${teamCode} stage of elimination: ${String(stageResult.reason)}`);
  }
  return { raw, errors };
}

function validateScheduleIdentitySets(completed: string[], remaining: string[]): string | null {
  const completedSet = new Set(completed);
  if (completedSet.size !== completed.length) return "The realized NFL schedule contains duplicate canonical fixtures.";
  const remainingSet = new Set(remaining);
  if (remainingSet.size !== remaining.length) return "The remaining NFL schedule contains duplicate canonical fixtures.";
  if ([...remainingSet].some((gameId) => completedSet.has(gameId))) {
    return "The completed and remaining NFL schedules overlap.";
  }
  if (new Set([...completedSet, ...remainingSet]).size !== 272) {
    return `NFL schedule coverage must contain 272 disjoint unique games; found ${completedSet.size} completed and ${remainingSet.size} remaining.`;
  }
  return null;
}

export type MtmPipelineResult = {
  id: number;
  currentSnapshotId: number | null;
  poolId: number;
  asOf: string;
  currentAsOf: string | null;
  status: "ok" | "failed";
  error: string | null;
  stale: boolean;
  staleReasons: string[];
  diagnostics: Record<string, unknown> | null;
  valuations: Array<Record<string, unknown>>;
  projections: Record<string, Record<string, unknown>>;
  currentSelectionType?: "canonical" | "latest";
};

function asNumber(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function pipelineMarkWeek(stateJson: Record<string, unknown> | null): number {
  const remainingSchedule = stateJson?.remaining_schedule;
  if (!Array.isArray(remainingSchedule)) return 0;
  const remainingWeeks = remainingSchedule
    .map((game) => (
      game && typeof game === "object" && "week" in game
        ? Number(game.week)
        : Number.NaN
    ))
    .filter((week) => Number.isInteger(week) && week > 0);
  if (remainingWeeks.length === 0) return 18;
  return Math.max(0, Math.min(...remainingWeeks) - 1);
}

async function selectOfficialWeeklySnapshots(
  poolId: number,
  successfulRows: Array<typeof mtmSnapshotTable.$inferSelect>,
): Promise<{
  snapshots: Array<typeof mtmSnapshotTable.$inferSelect>;
  canonicalSnapshotIds: Set<number>;
}> {
  const successfulByWeek = new Map<number, Array<typeof mtmSnapshotTable.$inferSelect>>();
  for (const snapshot of successfulRows) {
    const week = pipelineMarkWeek(snapshot.stateJson);
    const rows = successfulByWeek.get(week) ?? [];
    rows.push(snapshot);
    successfulByWeek.set(week, rows);
  }
  const periods = await db.select({
    id: sportPeriodsTable.id,
    sequence: sportPeriodsTable.sequence,
  }).from(sportPeriodsTable).where(and(
    eq(sportPeriodsTable.sport, "NFL"),
    eq(sportPeriodsTable.competition, "NFL_REGULAR_SEASON"),
  ));
  const weekByPeriodId = new Map(periods.map((period) => [period.id, period.sequence]));
  const canonicalRows = await db.select({
    selectionId: mtmCanonicalPeriodSelectionTable.id,
    sportPeriodId: mtmCanonicalPeriodSelectionTable.sportPeriodId,
    snapshot: mtmSnapshotTable,
  }).from(mtmCanonicalPeriodSelectionTable)
    .innerJoin(
      mtmSnapshotTable,
      eq(mtmSnapshotTable.id, mtmCanonicalPeriodSelectionTable.snapshotId),
    )
    .where(and(
      eq(mtmCanonicalPeriodSelectionTable.poolId, poolId),
      eq(mtmSnapshotTable.status, "ok"),
      ne(mtmSnapshotTable.methodVersion, "mtm-v3-review"),
    ))
    .orderBy(
      sql`${mtmCanonicalPeriodSelectionTable.selectedAt} desc`,
      sql`${mtmCanonicalPeriodSelectionTable.id} desc`,
    );
  const canonicalByWeek = new Map<number, typeof mtmSnapshotTable.$inferSelect>();
  for (const row of canonicalRows) {
    const week = weekByPeriodId.get(row.sportPeriodId);
    if (week == null || canonicalByWeek.has(week) ||
        pipelineMarkWeek(row.snapshot.stateJson) !== week) continue;
    canonicalByWeek.set(week, row.snapshot);
  }
  const canonicalSnapshotIds = new Set<number>();
  const snapshots = [...successfulByWeek.keys()]
    .sort((a, b) => b - a)
    .map((week) => {
      const canonical = canonicalByWeek.get(week);
      if (canonical) {
        canonicalSnapshotIds.add(canonical.id);
        return canonical;
      }
      return successfulByWeek.get(week)![0]!;
    });
  return { snapshots, canonicalSnapshotIds };
}

function seasonCode(year: number): string {
  return String(year + 1).slice(-2);
}

async function loadConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Record<string, any>;
}

async function fetchKalshiEvent(baseUrl: string, ticker: string): Promise<FetchedMarkets> {
  const sourceUrl = kalshiEventUrl(baseUrl, ticker);
  const response = await fetch(
    sourceUrl,
    { headers: { Accept: "application/json", "User-Agent": "calcutta-mtm/1.0" }, signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) throw new Error(`Kalshi event ${ticker} returned HTTP ${response.status}.`);
  const body = await response.json() as { event?: { markets?: any[] } };
  return {
    markets: body.event?.markets ?? [],
    sourceUrl,
    fetchedAt: new Date(),
  };
}

function kalshiEventUrl(baseUrl: string, ticker: string): string {
  return `${baseUrl.replace(/\/$/, "")}/events/${encodeURIComponent(ticker)}?with_nested_markets=true`;
}

function quoteValue(market: any, field: string): number | null {
  const dollars = market?.[`${field}_dollars`];
  if (dollars != null && dollars !== "") return Number(dollars);
  const cents = market?.[field];
  if (cents == null || cents === "") return null;
  const number = Number(cents);
  return Number.isFinite(number) ? number / 100 : null;
}

function quoteVolume(market: any): number {
  const value = market?.volume_fp ?? market?.volume;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function classifyEliminationMarket(market: any): string | null {
  const text = `${market?.ticker ?? ""} ${market?.title ?? ""} ${market?.subtitle ?? ""}`.toLowerCase();
  const suffix = String(market?.ticker ?? "").split("-").at(-1);
  const bySuffix: Record<string, string> = {
    REG: "no_playoffs", WC: "wild_card", DIV: "divisional",
    CONF: "conference", FL: "sb_loss", FW: "sb_win",
  };
  if (suffix && bySuffix[suffix]) return bySuffix[suffix];
  if (/(no[_ -]?playoffs|miss.*playoff|no postseason|miss postseason)/.test(text)) return "no_playoffs";
  if (/(wild[_ -]?card|wildcard)/.test(text) && /(lose|eliminat|exit)/.test(text)) return "wild_card";
  if (/(divisional|division round)/.test(text) && /(lose|eliminat|exit)/.test(text)) return "divisional";
  if (/(conference|conf round)/.test(text) && /(lose|eliminat|exit)/.test(text)) return "conference";
  if (/(super bowl|superbowl|sb)/.test(text) && /(lose|loss|eliminat)/.test(text)) return "sb_loss";
  if (/(win.*super bowl|super bowl.*win|champion)/.test(text)) return "sb_win";
  return null;
}

async function collectQuotes(
  config: Record<string, any>,
  teams: Array<{ code: string; name: string }>,
): Promise<{ raw: RawMarketQuote[]; errors: string[] }> {
  const baseUrl = config.kalshi.base_url as string;
  const series = config.kalshi.series as Record<string, string>;
  const code = seasonCode(config.season as number);
  const results = await Promise.all(teams.map(async (team) => {
    const winTicker = `${series.win_totals}-${code}${team.code}`;
    const stageTicker = `${series.stage_of_elimination}-${code}${team.code}`;
    const [winResult, stageResult] = await Promise.allSettled([
      fetchKalshiEvent(baseUrl, winTicker),
      fetchKalshiEvent(baseUrl, stageTicker),
    ]);
    return mergeTeamQuoteResults(team.code, series as {
      win_totals: string;
      stage_of_elimination: string;
    }, winResult, stageResult);
  }));
  return {
    raw: results.flatMap((result) => result.raw),
    errors: results.flatMap((result) => result.errors),
  };
}

function deriveQuoteState(
  config: Record<string, any>,
  teams: Array<{ code: string; name: string }>,
  raw: RawMarketQuote[],
): { winLadders: MtmState["win_ladders"]; elimination: MtmState["elimination_quotes"] } {
  const series = config.kalshi.series as Record<string, string>;
  const winLadders: MtmState["win_ladders"] = {};
  const elimination: MtmState["elimination_quotes"] = {};
  for (const team of teams) {
    const winMarkets = raw
      .filter((quote) => quote.team === team.code && quote.series === series.win_totals)
      .map((quote) => quote.market);
    const stageMarkets = raw
      .filter((quote) => quote.team === team.code && quote.series === series.stage_of_elimination)
      .map((quote) => quote.market);
    const ladders = winMarkets
      .map((market) => ({ market, strike: Number(market.floor_strike ?? market.floor_strike_fp) }))
      .filter(({ strike }) => Number.isFinite(strike) && strike >= 1 && strike <= 17)
      .sort((a, b) => a.strike - b.strike)
      .map(({ market, strike }) => ({
        strike,
        yes_bid: quoteValue(market, "yes_bid"),
        yes_ask: quoteValue(market, "yes_ask"),
        volume: quoteVolume(market),
        status: market.status == null ? null : String(market.status),
        result: market.result == null ? null : String(market.result),
      }));
    if (ladders.length === 0) throw new Error(`No win-total ladder was discovered for ${team.code}.`);
    winLadders[team.code] = ladders;
    const classified: Record<string, number> = {};
    for (const market of stageMarkets) {
      const outcome = classifyEliminationMarket(market);
      const bid = quoteValue(market, "yes_bid");
      if (outcome && bid != null) classified[outcome] = Math.min(1, bid + 0.01);
    }
    const required = ["no_playoffs", "wild_card", "divisional", "conference", "sb_loss", "sb_win"];
    if (required.some((key) => classified[key] == null)) {
      throw new Error(`Incomplete stage-of-elimination quotes for ${team.code}.`);
    }
    elimination[team.code] = classified;
  }
  return { winLadders, elimination };
}

async function exportState(seasonYear: number, calcuttaId?: number): Promise<{
  poolId: number;
  state: MtmState;
  rawQuotes: RawMarketQuote[];
  quoteErrors: string[];
  quoteTeams: Array<{ code: string; name: string }>;
  inputProvenance: MtmInputProvenance;
}> {
  const selected = await db
    .select({ poolId: calcuttasTable.id, seasonId: calcuttasTable.seasonId, year: seasonsTable.year })
    .from(calcuttasTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .where(and(eq(seasonsTable.year, seasonYear), eq(calcuttasTable.sport, "NFL"), calcuttaId == null ? eq(calcuttasTable.isCanonical, true) : eq(calcuttasTable.id, calcuttaId)))
    .limit(1);
  const poolRow = selected[0];
  if (!poolRow) throw new Error(`Canonical NFL Calcutta for season ${seasonYear} was not found.`);

  const entries = await db
    .select({ entryId: calcuttaEntriesTable.id, teamId: teamsTable.id, name: teamsTable.name, division: teamsTable.division, conference: teamsTable.conference })
    .from(calcuttaEntriesTable)
    .innerJoin(teamsTable, eq(teamsTable.id, calcuttaEntriesTable.teamId))
    .where(eq(calcuttaEntriesTable.calcuttaId, poolRow.poolId))
    .orderBy(asc(teamsTable.name));
  if (entries.length !== 32) throw new Error(`MTM state requires all 32 NFL entries; found ${entries.length}.`);
  const entryIds = entries.map((entry) => entry.entryId);
  const positions = await db.select({ entryId: positionsTable.entryId, cost: positionsTable.costBasis })
    .from(positionsTable).where(and(inArray(positionsTable.entryId, entryIds), eq(positionsTable.source, "primary")));
  const priceByEntry = new Map<number, number>();
  for (const row of positions) priceByEntry.set(row.entryId, (priceByEntry.get(row.entryId) ?? 0) + asNumber(row.cost));
  if (priceByEntry.size !== entries.length) throw new Error("MTM state requires a primary auction price for every NFL entry.");

  const games = await db.select({
    period: nflGamesTable.periodSequence, home: nflGamesTable.homeTeamId, away: nflGamesTable.awayTeamId,
    homeScore: nflGamesTable.homeScore, awayScore: nflGamesTable.awayScore,
    kickoff: nflGamesTable.actualKickoffAt, marquee: nflGamesTable.isMarquee,
    status: nflGamesTable.status, source: nflGamesTable.source,
    sourceGameId: nflGamesTable.sourceGameId,
    sourceUrl: nflGamesTable.sourceUrl,
    sourceFetchedAt: nflGamesTable.sourceFetchedAt,
    round: nflGamesTable.round,
  }).from(nflGamesTable).where(eq(nflGamesTable.seasonId, poolRow.seasonId));
  const teamNameById = new Map(entries.map((entry) => [entry.teamId, entry.name]));
  const realizedOutcomes = NFL_SCORING_ADAPTER.aggregateOutcomes(games.map((game) => ({
    seasonId: poolRow.seasonId,
    source: game.source,
    sourceEventId: game.sourceGameId,
    periodSequence: game.period,
    homeTeamId: game.home,
    awayTeamId: game.away,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
    actualKickoffAt: game.kickoff,
    status: game.status,
  })));
  const eventRows = await db.select({
    id: eventsTable.id,
    source: eventsTable.source,
    sourceEventId: eventsTable.sourceEventId,
    week: eventsTable.week,
    kickoffAt: eventsTable.kickoffAt,
    sourceData: eventsTable.sourceData,
    updatedAt: eventsTable.updatedAt,
    homeTeamId: eventsTable.homeTeamId,
    awayTeamId: eventsTable.awayTeamId,
  }).from(eventsTable).where(and(
    eq(eventsTable.seasonId, poolRow.seasonId),
    eq(eventsTable.sport, "NFL"),
    eq(eventsTable.competition, "NFL_REGULAR_SEASON"),
    ne(eventsTable.status, "final"),
  ));
  const teamCodeById = new Map(entries.map((entry) =>
    [entry.teamId, TEAM_CODE_BY_NAME[entry.name]] as const));
  const scheduleCapture = buildCanonicalRemainingSchedule(eventRows, teamCodeById);
  const remainingScheduleWithIds = scheduleCapture.schedule;
  const completedGames = games.filter((game) =>
    game.period >= 1 &&
    game.period <= 18 &&
    game.round === "regular" &&
    game.status.toLowerCase() === "final"
  );
  const completedGameIds = completedGames.map((game) => {
    const home = TEAM_CODE_BY_NAME[teamNameById.get(game.home) ?? ""];
    const away = TEAM_CODE_BY_NAME[teamNameById.get(game.away) ?? ""];
    return `${game.period}:${away}:${home}`;
  });
  const remainingGameIds = remainingScheduleWithIds.map((game) => `${game.week}:${game.away}:${game.home}`);
  const scheduleIdentityError = validateScheduleIdentitySets(completedGameIds, remainingGameIds);
  if (scheduleIdentityError) throw new Error(scheduleIdentityError);
  const knownCodes = new Set(entries.map((entry) => TEAM_CODE_BY_NAME[entry.name]));
  if (remainingScheduleWithIds.some((game) => !knownCodes.has(game.home) || !knownCodes.has(game.away))) {
    throw new Error("ESPN returned an NFL team that is not present in the canonical Calcutta.");
  }
  const remainingByTeam = new Map<string, number>();
  for (const game of remainingScheduleWithIds) {
    remainingByTeam.set(game.home, (remainingByTeam.get(game.home) ?? 0) + 1);
    remainingByTeam.set(game.away, (remainingByTeam.get(game.away) ?? 0) + 1);
  }
  for (const entry of entries) {
    const played = realizedOutcomes.get(entry.teamId);
    const completedGames = asNumber(played?.metrics.win) + asNumber(played?.metrics.loss) + asNumber(played?.metrics.tie);
    const expectedRemaining = 17 - completedGames;
    if ((remainingByTeam.get(TEAM_CODE_BY_NAME[entry.name]) ?? 0) !== expectedRemaining) {
      throw new Error(`Remaining schedule coverage is incomplete for ${TEAM_CODE_BY_NAME[entry.name]}.`);
    }
  }

  const teams = entries.map((entry) => ({ code: TEAM_CODE_BY_NAME[entry.name], name: entry.name }));
  const config = await loadConfig();
  const quotes = await collectQuotes(config, teams);
  const divisions: Record<string, string[]> = {};
  for (const entry of entries) {
    const key = `${entry.conference} ${entry.division}`;
    (divisions[key] ??= []).push(TEAM_CODE_BY_NAME[entry.name]);
  }
  const pot = [...priceByEntry.values()].reduce((sum, value) => sum + value, 0);
  const state: MtmState = {
    as_of: new Date().toISOString(),
    pot,
    entries: entries.map((entry) => ({ entry_id: String(entry.entryId), team: TEAM_CODE_BY_NAME[entry.name], price: priceByEntry.get(entry.entryId)! })),
    realized: Object.fromEntries(entries.map((entry) => {
      const metrics = NFL_SCORING_ADAPTER.pointMetricValues(realizedOutcomes.get(entry.teamId)?.metrics ?? {});
      return [TEAM_CODE_BY_NAME[entry.name], {
        wins: asNumber(metrics.win),
        ties: asNumber(metrics.tie),
        adj_pt_diff: asNumber(metrics.pt_diff),
      }];
    })),
    remaining_schedule: remainingScheduleWithIds,
    divisions,
    win_ladders: {},
    elimination_quotes: {},
  };
  const completedInputSources = completedGames.map((game) => {
    const home = TEAM_CODE_BY_NAME[teamNameById.get(game.home) ?? ""];
    const away = TEAM_CODE_BY_NAME[teamNameById.get(game.away) ?? ""];
    const sourceId = game.sourceGameId;
    return {
      provider: game.source,
      source_url: game.sourceUrl,
      source_id: sourceId,
      fetched_at: game.sourceFetchedAt?.toISOString() ?? null,
      week: game.period,
      home,
      away,
      home_score: asNumber(game.homeScore),
      away_score: asNumber(game.awayScore),
      homeTeamId: game.home,
      awayTeamId: game.away,
    };
  });
  const inputProvenance: MtmInputProvenance = {
    schema_version: "1.0",
    schedule: scheduleCapture.provenance,
    realized_results: completedInputSources.map(({ homeTeamId: _home, awayTeamId: _away, ...game }) => game),
    standings: entries.map((entry) => {
      const team = TEAM_CODE_BY_NAME[entry.name];
      const metrics = state.realized[team];
      const sources = completedInputSources
        .filter((game) => game.homeTeamId === entry.teamId || game.awayTeamId === entry.teamId)
        .map(({ homeTeamId: _home, awayTeamId: _away, week: _week, home: _hc, away: _ac, home_score: _hs, away_score: _as, ...source }) => source);
      return {
        provider: "derived_nfl_game_ledger",
        source_id: `nfl-standings:${seasonYear}:${team}`,
        team,
        wins: metrics.wins,
        ties: metrics.ties,
        adjusted_point_differential: metrics.adj_pt_diff,
        fetched_at: sources.reduce<string | null>((latest, source) => {
          if (!source.fetched_at) return latest;
          return !latest || source.fetched_at > latest ? source.fetched_at : latest;
        }, scheduleCapture.provenance.reduce<string | null>((latest, source) =>
          !latest || (source.fetched_at != null && source.fetched_at > latest)
            ? source.fetched_at
            : latest, null)),
        sources,
      };
    }),
  };
  return {
    poolId: poolRow.poolId,
    state,
    rawQuotes: quotes.raw,
    quoteErrors: quotes.errors,
    quoteTeams: teams,
    inputProvenance,
  };
}

async function runEngine(state: MtmState): Promise<EngineSnapshot> {
  const dir = await mkdtemp(resolve(tmpdir(), "calcutta-mtm-"));
  const statePath = resolve(dir, "state.json");
  const outPath = resolve(dir, "snapshot.json");
  try {
    await writeFile(statePath, JSON.stringify(state), "utf8");
    await execFileAsync(
      "python3",
      ["run_mtm.py", "--config", CONFIG_PATH, "--state", statePath, "--out", outPath],
      { cwd: ENGINE_DIR, timeout: ENGINE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(await readFile(outPath, "utf8")) as EngineSnapshot;
  } catch (error) {
    try {
      return JSON.parse(await readFile(outPath, "utf8")) as EngineSnapshot;
    } catch {
      const processError = error as Error & {
        killed?: boolean;
        signal?: string;
        stderr?: string;
      };
      const stderr = processError.stderr?.trim() || "";
      const lastProgress = stderr
        .split(/\r?\n/)
        .map((line) => {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            return parsed.event === "mtm_progress" ? parsed : null;
          } catch {
            return null;
          }
        })
        .filter((value): value is Record<string, unknown> => value !== null)
        .at(-1);
      const details = [
        processError.killed ? `Engine exceeded its ${ENGINE_TIMEOUT_MS / 60_000}-minute execution limit.` : null,
        processError.signal ? `Termination signal: ${processError.signal}.` : null,
        stderr || null,
      ].filter((detail): detail is string => Boolean(detail));
      return {
        status: "failed",
        as_of: new Date().toISOString(),
        error: details.length
          ? `${processError.message}\n${details.join("\n")}`
          : processError.message,
        diagnostics: lastProgress
          ? { runtime: { progress: lastProgress, source: "stderr_fallback" } }
          : undefined,
      };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Execute the side-by-side v3 engine.  Review attempts deliberately use the
 * same exported, provider-neutral state as production, but are never passed
 * through the production publication transaction.
 */
async function runReviewEngine(state: MtmState, configPath: string): Promise<EngineSnapshot> {
  const dir = await mkdtemp(resolve(tmpdir(), "calcutta-mtm-v3-review-"));
  const statePath = resolve(dir, "state.json");
  const outPath = resolve(dir, "snapshot.json");
  try {
    await writeFile(statePath, JSON.stringify(state), "utf8");
    await execFileAsync("python3", [
      "run_mtm_v3.py", "--config", configPath, "--state", statePath, "--out", outPath,
    ], { cwd: ENGINE_DIR, timeout: 300_000 });
    return JSON.parse(await readFile(outPath, "utf8")) as EngineSnapshot;
  } catch (error) {
    try {
      return JSON.parse(await readFile(outPath, "utf8")) as EngineSnapshot;
    } catch {
      return {
        status: "failed",
        as_of: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runMtmV3Review(input: {
  seasonYear: number;
  calcuttaId?: number;
  now?: Date;
}): Promise<{ id: number; poolId: number; status: "review"; error: string | null; diagnostics: Record<string, unknown> }> {
  const now = input.now ?? new Date();
  const asOfHour = hourStart(now);
  const config = await loadConfig();
  const selected = await db.select({ poolId: calcuttasTable.id }).from(calcuttasTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .where(and(
      eq(seasonsTable.year, input.seasonYear),
      eq(calcuttasTable.sport, "NFL"),
      input.calcuttaId == null ? eq(calcuttasTable.isCanonical, true) : eq(calcuttasTable.id, input.calcuttaId),
    )).limit(1);
  if (!selected[0]) throw new Error(`NFL Calcutta for season ${input.seasonYear} was not found.`);
  const poolId = selected[0].poolId;
  const methodVersion = "mtm-v3-review";
  const baseDiagnostics: Record<string, unknown> = {
    review: true,
    publication: "noncanonical",
    engine: "v3",
    effectiveConfig: config,
    requestedAt: now.toISOString(),
  };
  let exported: Awaited<ReturnType<typeof exportState>>;
  try {
    exported = await exportState(input.seasonYear, input.calcuttaId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [row] = await db.insert(mtmSnapshotTable).values({
      poolId, asOf: now, asOfHour, trigger: "manual", status: "failed",
      methodVersion, runKind: "backfill", error: message, diagnostics: {
        ...baseDiagnostics, pipelineError: message,
      },
    }).returning({ id: mtmSnapshotTable.id });
    return { id: row!.id, poolId, status: "review", error: message, diagnostics: { ...baseDiagnostics, pipelineError: message } };
  }
  const { state, rawQuotes, quoteErrors, quoteTeams, inputProvenance } = exported;
  state.completed_results = inputProvenance.realized_results.map((game) => ({
    week: game.week,
    home: game.home,
    away: game.away,
    home_score: game.home_score,
    away_score: game.away_score,
  }));
  const [row] = await db.insert(mtmSnapshotTable).values({
    poolId, asOf: now, asOfHour, trigger: "manual", status: "failed",
    methodVersion, runKind: "backfill", stateJson: state, inputProvenance,
    diagnostics: { ...baseDiagnostics, quoteErrors },
  }).returning({ id: mtmSnapshotTable.id });
  const snapshotId = row!.id;
  if (rawQuotes.length) await db.insert(mtmMarketQuoteTable).values(buildMarketQuoteRows(snapshotId, rawQuotes));
  if (quoteErrors.length) {
    const error = `Kalshi quote collection was incomplete: ${quoteErrors.join("; ")}`;
    const diagnostics = { ...baseDiagnostics, quoteErrors, reviewStatus: "failed" };
    await db.update(mtmSnapshotTable).set({ error, diagnostics }).where(eq(mtmSnapshotTable.id, snapshotId));
    return { id: snapshotId, poolId, status: "review", error, diagnostics };
  }
  let diagnostics: Record<string, unknown> = { ...baseDiagnostics };
  try {
    const derived = deriveQuoteState(config, quoteTeams, rawQuotes);
    state.win_ladders = derived.winLadders;
    state.elimination_quotes = derived.elimination;
    const engine = await runReviewEngine(state, CONFIG_PATH);
    diagnostics = {
      ...diagnostics,
      reviewStatus: engine.status === "ok"
        ? ((
            engine.diagnostics?.simulation as Record<string, unknown> | undefined
          )?.review_ready === true
          ? "completed_review_ready"
          : "completed_not_ready")
        : "failed",
      engineDiagnostics: engine.diagnostics ?? null,
      engineCodeVersion: engine.model?.name ?? "run_mtm_v3.py",
      seed: engine.model?.seed ?? null,
      pathCount: engine.path_count ?? null,
      valuations: engine.valuations ?? [],
      projections: engine.projections ?? {},
      calibration: engine.calibration ?? engine.calibration_metrics ?? [],
      conditionalDiagnostics: (
        engine.diagnostics?.simulation as Record<string, unknown> | undefined
      )?.conditional_quality ?? null,
    };
    const error = engine.status === "ok" ? null : (engine.error ?? "MTM v3 review engine failed.");
    await db.update(mtmSnapshotTable).set({
      error, diagnostics, stateJson: state,
      pathCount: engine.path_count == null ? null : Math.trunc(Number(engine.path_count)),
      randomSeed: engine.model?.seed == null ? null : Math.trunc(Number(engine.model.seed)),
    }).where(eq(mtmSnapshotTable.id, snapshotId));
    return { id: snapshotId, poolId, status: "review", error, diagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics = { ...diagnostics, reviewStatus: "failed", engineError: message };
    await db.update(mtmSnapshotTable).set({ error: message, diagnostics }).where(eq(mtmSnapshotTable.id, snapshotId));
    return { id: snapshotId, poolId, status: "review", error: message, diagnostics };
  }
}

function hourStart(date: Date): Date {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

function validateCompleteEngineSnapshot(engine: EngineSnapshot, state: MtmState): string | null {
  if (engine.status !== "ok") return engine.error ?? "MTM engine failed.";
  if (!Number.isFinite(state.pot) || state.pot <= 0) {
    return "MTM state has an invalid auction pool.";
  }
  const expectedTeamList = Object.keys(state.realized);
  const expectedTeams = new Set(expectedTeamList);
  const stateEntriesById = new Map(state.entries.map((entry) => [String(entry.entry_id), entry]));
  const entryTeams = new Set(state.entries.map((entry) => entry.team));
  if (expectedTeams.size !== 32 || state.entries.length !== 32 ||
      stateEntriesById.size !== 32 || entryTeams.size !== 32 ||
      [...expectedTeams].some((team) => !entryTeams.has(team))) {
    return "MTM state must contain 32 unique teams and 32 uniquely identified matching entries.";
  }
  const projections = engine.projections ?? {};
  const projectionTeams = Object.keys(projections);
  if (projectionTeams.length !== 32 || new Set(projectionTeams).size !== 32 ||
      projectionTeams.some((team) => !expectedTeams.has(team))) {
    return `MTM engine returned ${Object.keys(projections).length} team projections; expected 32.`;
  }
  for (const team of expectedTeams) {
    const projection = projections[team] as Record<string, any> | undefined;
    const values = projection && [
      projection.e_wins_total,
      projection.e_remaining_wins,
      projection.e_remaining_raw_diff,
      projection.e_remaining_marquee_addon,
      projection.rating,
      projection.p_stage?.berth,
      projection.p_stage?.divisional,
      projection.p_stage?.conference,
      projection.p_stage?.sb_berth,
      projection.p_stage?.sb_win,
    ];
    if (!projection || values!.some((value) => !Number.isFinite(Number(value)))) {
      return `MTM engine returned an incomplete projection for ${team}.`;
    }
    const stage = projection.p_stage as Record<string, unknown>;
    const stageValues = ["berth", "divisional", "conference", "sb_berth", "sb_win"]
      .map((key) => Number(stage[key]));
    if (stageValues.some((value) => value < 0 || value > 1) ||
        stageValues.some((value, index) => index > 0 && stageValues[index - 1]! < value)) {
      return `MTM engine returned invalid nested stage probabilities for ${team}.`;
    }
    const eWins = Number(projection.e_wins_total);
    const eRemainingWins = Number(projection.e_remaining_wins);
    if (eWins < 0 || eWins > 17 || eRemainingWins < 0 || eRemainingWins > 17) {
      return `MTM engine returned out-of-range win expectations for ${team}.`;
    }
  }
  const expectedEntries = new Set(state.entries.map((entry) => String(entry.entry_id)));
  const valuations = engine.valuations ?? [];
  const actualEntries = new Set(valuations.map((valuation) => String(valuation.entry_id)));
  if (valuations.length !== 32 || actualEntries.size !== 32 ||
      [...expectedEntries].some((entryId) => !actualEntries.has(entryId))) {
    return `MTM engine returned ${valuations.length} complete entry valuations; expected the pool's 32 unique entries.`;
  }
  let payoutCents = 0;
  let shareTotal = 0;
  for (const valuation of valuations) {
    if (["expected_points", "expected_share", "expected_payout", "auction_price", "mtm_multiple"]
      .some((field) => !Number.isFinite(Number(valuation[field])))) {
      return `MTM engine returned invalid numeric values for entry ${valuation.entry_id}.`;
    }
    const entry = stateEntriesById.get(String(valuation.entry_id));
    if (!entry || String(valuation.team) !== entry.team) {
      return `MTM engine returned a mismatched team for entry ${valuation.entry_id}.`;
    }
    const share = Number(valuation.expected_share);
    const payout = Number(valuation.expected_payout);
    if (share < 0 || share > 1 || payout < 0 || payout > state.pot) {
      return `MTM engine returned an out-of-range share or payout for entry ${valuation.entry_id}.`;
    }
    if (Math.abs(payout * 100 - Math.round(payout * 100)) > 1e-6) {
      return `MTM engine returned a fractional-cent payout for entry ${valuation.entry_id}.`;
    }
    if (Math.abs(payout - share * state.pot) > 0.0051) {
      return `MTM engine returned an inconsistent share and payout for entry ${valuation.entry_id}.`;
    }
    payoutCents += Math.round(payout * 100);
    shareTotal += share;
  }
  if (payoutCents !== Math.round(state.pot * 100)) {
    return `MTM engine payouts total ${(payoutCents / 100).toFixed(2)}; expected ${state.pot.toFixed(2)}.`;
  }
  if (Math.abs(shareTotal - 1) > 1e-9) {
    return `MTM engine shares total ${shareTotal}; expected 1.`;
  }
  return null;
}

async function resolveMtmPoolId(seasonYear: number, calcuttaId?: number): Promise<number | null> {
  const rows = await db.select({ poolId: calcuttasTable.id }).from(calcuttasTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .where(and(
      eq(seasonsTable.year, seasonYear),
      eq(calcuttasTable.sport, "NFL"),
      calcuttaId == null ? eq(calcuttasTable.isCanonical, true) : eq(calcuttasTable.id, calcuttaId),
    )).limit(1);
  return rows[0]?.poolId ?? null;
}

function quoteStrike(market: Record<string, unknown>): string | null {
  const value = market.floor_strike ?? market.floor_strike_fp;
  return value == null || value === "" ? null : String(value);
}

function buildMarketQuoteRows(
  snapshotId: number,
  rawQuotes: RawMarketQuote[],
) {
  return rawQuotes.map(({ series, team, market, sourceUrl, fetchedAt }) => {
    if (!sourceUrl || !fetchedAt) {
      throw new Error(`Missing capture-time provenance for Kalshi market ${String(market.ticker)}.`);
    }
    return {
    snapshotId,
    sourceUrl,
    series,
    marketTicker: String(market.ticker),
    team,
    strike: quoteStrike(market),
    yesBid: quoteValue(market, "yes_bid") == null ? null : String(quoteValue(market, "yes_bid")),
    yesAsk: quoteValue(market, "yes_ask") == null ? null : String(quoteValue(market, "yes_ask")),
    volume: market.volume_fp == null && market.volume == null ? null : quoteVolume(market),
    fetchedAt,
    rawQuote: market,
    };
  });
}

export type MtmLease = {
  poolId: number;
  runId: string;
  ownerToken: string;
  assertOwned: () => Promise<void>;
  attachSnapshot: (snapshotId: number) => Promise<void>;
};

async function assertMtmLeaseOwnedInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  lease: MtmLease,
): Promise<void> {
  const owned = await tx.execute<{ run_id: string }>(sql`
    select run_id
    from mtm_job_leases
    where pool_id = ${lease.poolId}
      and owner_token = ${lease.ownerToken}
      and run_id = ${lease.runId}
      and lease_until > clock_timestamp()
    for update
  `);
  if (owned.rows.length === 0) {
    throw new Error("MTM lease was lost before publication; this worker cannot publish its result.");
  }
}

function classifyMtmRunFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/lease (?:was )?lost|lease expired/i.test(message)) return "lease_lost";
  if (/engine exceeded|python3 run_mtm|termination signal/i.test(message)) return "engine";
  if (/timeout|timed out|aborted/i.test(message)) return "external_timeout";
  if (/postgres|database|connection|ECONNRESET/i.test(message)) return "database";
  if (/validation|calibration|coverage|invariant|incomplete/i.test(message)) return "validation";
  return "unknown";
}

async function withMtmLock<T>(
  input: { seasonYear: number; calcuttaId?: number },
  run: (lease: MtmLease) => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const poolId = await resolveMtmPoolId(input.seasonYear, input.calcuttaId);
  if (poolId == null) throw new Error(`NFL Calcutta for season ${input.seasonYear} was not found.`);
  const ownerToken = randomUUID();
  const runId = randomUUID();
  const acquired = await db.transaction(async (tx) => {
    const result = await tx.execute<{ run_id: string }>(sql`
      insert into mtm_job_leases (
        pool_id, owner_token, run_id, lease_until, heartbeat_at, started_at, updated_at
      ) values (
        ${poolId}, ${ownerToken}, ${runId},
        clock_timestamp() + (${MTM_LEASE_DURATION_MS} * interval '1 millisecond'),
        clock_timestamp(), clock_timestamp(), clock_timestamp()
      )
      on conflict (pool_id) do update set
        owner_token = excluded.owner_token,
        run_id = excluded.run_id,
        lease_until = excluded.lease_until,
        heartbeat_at = excluded.heartbeat_at,
        started_at = excluded.started_at,
        updated_at = clock_timestamp()
      where mtm_job_leases.lease_until <= clock_timestamp()
      returning run_id
    `);
    if (result.rows.length === 0) return false;
    await tx.execute(sql`
      update mtm_job_runs as run
      set status = case
            when exists (
              select 1 from mtm_valuation_version version
              where version.source_snapshot_id = run.snapshot_id
                and version.status = 'current'
            ) then 'completed'
            else 'abandoned'
          end,
          failure_kind = case
            when exists (
              select 1 from mtm_valuation_version version
              where version.source_snapshot_id = run.snapshot_id
                and version.status = 'current'
            ) then null
            else 'lease_expired'
          end,
          error = case
            when exists (
              select 1 from mtm_valuation_version version
              where version.source_snapshot_id = run.snapshot_id
                and version.status = 'current'
            ) then null
            else 'MTM worker stopped renewing its lease before completion.'
          end,
          completed_at = clock_timestamp()
      where run.pool_id = ${poolId}
        and run.status = 'running'
        and run.lease_until <= clock_timestamp()
    `);
    await tx.execute(sql`
      insert into mtm_job_runs (
        run_id, pool_id, owner_token, status, started_at, heartbeat_at, lease_until
      ) values (
        ${runId}, ${poolId}, ${ownerToken}, 'running',
        clock_timestamp(), clock_timestamp(),
        clock_timestamp() + (${MTM_LEASE_DURATION_MS} * interval '1 millisecond')
      )
    `);
    return true;
  });
  if (!acquired) return { acquired: false };

  const renew = async (): Promise<boolean> => db.transaction(async (tx) => {
    const result = await tx.execute<{ run_id: string }>(sql`
      update mtm_job_leases
      set lease_until = clock_timestamp() + (${MTM_LEASE_DURATION_MS} * interval '1 millisecond'),
          heartbeat_at = clock_timestamp(),
          updated_at = clock_timestamp()
      where pool_id = ${poolId}
        and owner_token = ${ownerToken}
        and run_id = ${runId}
        and lease_until > clock_timestamp()
      returning run_id
    `);
    if (result.rows.length === 0) return false;
    await tx.execute(sql`
      update mtm_job_runs
      set heartbeat_at = clock_timestamp(),
          lease_until = clock_timestamp() + (${MTM_LEASE_DURATION_MS} * interval '1 millisecond')
      where run_id = ${runId} and owner_token = ${ownerToken} and status = 'running'
    `);
    return true;
  });

  let leaseLost = false;
  let heartbeatRunning = false;
  const heartbeat = setInterval(() => {
    if (heartbeatRunning || leaseLost) return;
    heartbeatRunning = true;
    void renew()
      .then((renewed) => {
        if (!renewed) leaseLost = true;
      })
      .catch((error) => {
        console.error("[mtm lease] heartbeat failed; ownership will be rechecked", error);
      })
      .finally(() => {
        heartbeatRunning = false;
      });
  }, MTM_LEASE_HEARTBEAT_MS);
  heartbeat.unref();

  const lease: MtmLease = {
    poolId,
    runId,
    ownerToken,
    assertOwned: async () => {
      if (leaseLost || !(await renew())) {
        leaseLost = true;
        throw new Error("MTM lease was lost before publication; this worker cannot promote its result.");
      }
    },
    attachSnapshot: async (snapshotId) => {
      const attached = await db.execute<{ run_id: string }>(sql`
        update mtm_job_runs
        set snapshot_id = ${snapshotId}
        where run_id = ${runId}
          and owner_token = ${ownerToken}
          and status = 'running'
        returning run_id
      `);
      if (attached.rows.length === 0) {
        throw new Error("MTM lease run is no longer active; snapshot cannot be attached.");
      }
    },
  };

  try {
    const value = await run(lease);
    await lease.assertOwned();
    const snapshotId =
      Number.isInteger(value)
        ? Number(value)
        : value && typeof value === "object" && "id" in value && Number.isInteger(Number(value.id))
        ? Number(value.id)
        : null;
    const returnedError =
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : null;
    await db.transaction(async (tx) => {
      await assertMtmLeaseOwnedInTransaction(tx, lease);
      const terminal = await tx.execute<{ run_id: string }>(sql`
        update mtm_job_runs
        set status = ${returnedError ? "failed" : "completed"},
            failure_kind = ${returnedError ? classifyMtmRunFailure(returnedError) : null},
            error = ${returnedError},
            snapshot_id = ${snapshotId},
            completed_at = clock_timestamp()
        where run_id = ${runId} and owner_token = ${ownerToken} and status = 'running'
        returning run_id
      `);
      if (terminal.rows.length === 0) {
        throw new Error("MTM run could not be finalized by its active lease owner.");
      }
      await tx.execute(sql`
        delete from mtm_job_leases
        where pool_id = ${poolId} and owner_token = ${ownerToken} and run_id = ${runId}
      `);
    });
    return { acquired: true, value };
  } catch (error) {
    await db.transaction(async (tx) => {
      const terminal = await tx.execute<{ run_id: string }>(sql`
        update mtm_job_runs
        set status = 'failed',
            failure_kind = ${classifyMtmRunFailure(error)},
            error = ${error instanceof Error ? error.message : String(error)},
            completed_at = clock_timestamp()
        where run_id = ${runId} and owner_token = ${ownerToken} and status = 'running'
        returning run_id
      `);
      if (terminal.rows.length > 0) {
        await tx.execute(sql`
          delete from mtm_job_leases
          where pool_id = ${poolId} and owner_token = ${ownerToken} and run_id = ${runId}
        `);
      }
    }).catch((recordError) => {
      console.error("[mtm lease] failed to record terminal run state; lease will expire", recordError);
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function assertMtmLeaseForPublication(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  lease: MtmLease,
): Promise<void> {
  await assertMtmLeaseOwnedInTransaction(tx, lease);
}

export async function runMtmPipeline(input: { seasonYear: number; calcuttaId?: number; trigger: "scheduled" | "manual"; now?: Date; lease?: MtmLease }): Promise<MtmPipelineResult> {
  const now = input.now ?? new Date();
  const asOfHour = hourStart(now);
  const config = await loadConfig();
  if (input.seasonYear !== Number(config.season)) {
    throw new Error(`The frozen MTM configuration supports season ${config.season}, not ${input.seasonYear}.`);
  }
  const methodVersion = `frozen-mtm-${config.season}`;
  const selected = await db.select({ poolId: calcuttasTable.id }).from(calcuttasTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .where(and(eq(seasonsTable.year, input.seasonYear), eq(calcuttasTable.sport, "NFL"), input.calcuttaId == null ? eq(calcuttasTable.isCanonical, true) : eq(calcuttasTable.id, input.calcuttaId)))
    .limit(1);
  if (!selected[0]) {
    throw new Error(`Canonical NFL Calcutta for season ${input.seasonYear} was not found.`);
  }
  let exported: Awaited<ReturnType<typeof exportState>>;
  try {
    exported = await exportState(input.seasonYear, input.calcuttaId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = { pipelineError: message };
    const failed = await db.insert(mtmSnapshotTable).values({
      poolId: selected[0].poolId, asOf: now, asOfHour, trigger: input.trigger,
      status: "failed", methodVersion, error: message, diagnostics,
    }).returning({ id: mtmSnapshotTable.id });
    return {
      id: failed[0]!.id, currentSnapshotId: null, poolId: selected[0].poolId,
      asOf: now.toISOString(), currentAsOf: null, status: "failed", error: message,
      stale: true, staleReasons: [message], diagnostics, valuations: [], projections: {},
    };
  }
  const { poolId, state, rawQuotes, quoteErrors, quoteTeams, inputProvenance } = exported;
  const snapshot = await db.insert(mtmSnapshotTable).values({
    poolId, asOf: now, asOfHour, trigger: input.trigger, status: "failed", methodVersion,
    stateJson: state,
    inputProvenance,
  }).returning({ id: mtmSnapshotTable.id });
  const snapshotId = snapshot[0]!.id;
  if (input.lease) await input.lease.attachSnapshot(snapshotId);
  if (rawQuotes.length) {
    await db.insert(mtmMarketQuoteTable).values(buildMarketQuoteRows(snapshotId, rawQuotes));
  }
  if (quoteErrors.length > 0) {
    const message = `Kalshi quote collection was incomplete: ${quoteErrors.join("; ")}`;
    await db.update(mtmSnapshotTable).set({
      error: message,
      diagnostics: { quoteErrors },
    }).where(eq(mtmSnapshotTable.id, snapshotId));
    return {
      id: snapshotId, currentSnapshotId: null, poolId, asOf: now.toISOString(),
      currentAsOf: null, status: "failed", error: message, stale: true,
      staleReasons: [message], diagnostics: { quoteErrors }, valuations: [], projections: {},
    };
  }
  try {
    const derivedQuotes = deriveQuoteState(config, quoteTeams, rawQuotes);
    state.win_ladders = derivedQuotes.winLadders;
    state.elimination_quotes = derivedQuotes.elimination;
    const inputHash = createHash("sha256").update(canonicalJson({
      state,
      inputProvenance,
      quotes: rawQuotes.map((quote) => ({
        series: quote.series,
        team: quote.team,
        ticker: quote.market.ticker,
        market: quote.market,
      })),
    })).digest("hex");
    const actualAnchor = new Date(Math.max(
      0,
      ...((inputProvenance.realized_results ?? [])
        .map((result) => result.fetched_at ? Date.parse(result.fetched_at) : 0)),
    ));
    await db.update(mtmSnapshotTable).set({ stateJson: state })
      .where(eq(mtmSnapshotTable.id, snapshotId));
    const latestQuoteAt = rawQuotes.reduce<Date | null>((latest, quote) =>
      quote.fetchedAt && (!latest || quote.fetchedAt > latest) ? quote.fetchedAt : latest, null);
    await db.update(mtmSnapshotTable).set({
      inputHash,
      marketAnchor: latestQuoteAt,
      actualAnchor: actualAnchor.getTime() > 0 ? actualAnchor : null,
    }).where(eq(mtmSnapshotTable.id, snapshotId));
  } catch (error) {
    const message = `Kalshi quote transformation failed: ${error instanceof Error ? error.message : String(error)}`;
    const diagnostics = { quoteErrors: [], transformationError: message };
    await db.update(mtmSnapshotTable).set({ error: message, diagnostics }).where(eq(mtmSnapshotTable.id, snapshotId));
    return {
      id: snapshotId, currentSnapshotId: null, poolId, asOf: now.toISOString(),
      currentAsOf: null, status: "failed", error: message, stale: true,
      staleReasons: [message], diagnostics, valuations: [], projections: {},
    };
  }
  const engine = await runEngine(state);
  const engineValidationError = validateCompleteEngineSnapshot(engine, state);
  if (engineValidationError) {
    const diagnostics = {
      ...(engine.diagnostics ?? {}),
      engineError: engineValidationError,
    };
    await db.update(mtmSnapshotTable).set({
      status: "failed",
      error: engineValidationError,
      diagnostics,
    }).where(eq(mtmSnapshotTable.id, snapshotId));
    return {
      id: snapshotId, currentSnapshotId: null, poolId, asOf: now.toISOString(),
      currentAsOf: null, status: "failed", error: engineValidationError, stale: true,
      staleReasons: [engineValidationError], diagnostics, valuations: [], projections: {},
    };
  }
  const engineCalibration = engine.calibration
    ?? engine.calibration_metrics
    ?? ((engine.diagnostics?.market_calibration as Record<string, unknown> | undefined)?.metrics as Array<Record<string, unknown>> | undefined)
    ?? [];
  const conditionalSource = engine.conditionals
    ?? engine.conditional_payouts
    ?? ((engine.diagnostics?.conditional_payouts as unknown) ?? []);
  const rawConditionals: Array<Record<string, unknown>> = Array.isArray(conditionalSource)
    ? conditionalSource
    : Object.values((conditionalSource ?? {}) as Record<string, unknown>).flatMap((game) => {
      if (!game || typeof game !== "object") return [];
      const record = game as Record<string, unknown>;
      const outcomes = record.outcomes;
      if (!outcomes || typeof outcomes !== "object") return [record];
      return Object.entries(outcomes as Record<string, unknown>).flatMap(([outcome, value]) => {
        if (Array.isArray(value)) return value.map((entry) => ({ ...(entry as Record<string, unknown>), ...record, outcome }));
        if (value && typeof value === "object") return [{ ...(value as Record<string, unknown>), ...record, outcome }];
        return [];
      });
    });
  const entryMap = new Map(state.entries.map((entry) => [String(entry.entry_id), Number(entry.entry_id)]));
  const eventIds = rawConditionals.map((row) => Number(row.event_id ?? row.eventId)).filter(Number.isInteger);
  const eventRows = eventIds.length
    ? await db.select({ id: eventsTable.id }).from(eventsTable).where(inArray(eventsTable.id, eventIds))
    : [];
  const knownEvents = new Set(eventRows.map((row) => row.id));
  const calibrationRows = engineCalibration.map((metric) => ({
    snapshotId,
    metricKey: `${String(metric.metric ?? metric.metric_key ?? metric.metricKey ?? "unknown")}:${String(metric.team ?? "league")}`,
    marketTicker: metric.market_ticker == null ? null : String(metric.market_ticker),
    targetProbability: metric.target_probability == null ? null : String(metric.target_probability),
    simulatedProbability: metric.simulated_probability == null ? null : String(metric.simulated_probability),
    weight: metric.weight == null ? null : String(metric.weight),
    residual: metric.residual == null ? null : String(metric.residual),
    tolerance: metric.tolerance == null ? null : String(metric.tolerance),
    sampleCount: metric.sample_count == null ? null : Math.trunc(asNumber(metric.sample_count)),
    sampleShare: metric.sample_share == null ? null : String(metric.sample_share),
    effectiveSampleSize: metric.effective_sample_size == null ? null : String(metric.effective_sample_size),
    qualityStatus: String(metric.quality_status ?? "insufficient"),
    sampleMetadata: { ...(metric.sample_metadata as Record<string, unknown> | undefined), metric: metric.metric ?? null, team: metric.team ?? null },
  }));
  const baselineByEntry = new Map((engine.valuations ?? []).map((row) => [Number(row.entry_id), asNumber(row.expected_payout)]));
  const nestedRows = conditionalSource && !Array.isArray(conditionalSource) && typeof conditionalSource === "object"
    ? flattenEngineConditionals(conditionalSource as Record<string, any>, new Map(state.entries.map((entry) => [entry.team, Number(entry.entry_id)])), baselineByEntry)
    : [];
  const conditionalRows = (nestedRows.length ? nestedRows.map((row) => ({
    snapshotId,
    eventId: row.eventId,
    entryId: row.entryId,
    outcome: row.outcome,
    probability: row.probability == null ? null : String(row.probability),
    grossBaseline: row.grossBaseline == null ? null : String(row.grossBaseline),
    grossConditional: row.grossConditional == null ? null : String(row.grossConditional),
    grossDelta: row.grossDelta == null ? null : String(row.grossDelta),
    sampleCount: row.sampleCount,
    sampleShare: row.sampleShare == null ? null : String(row.sampleShare),
    effectiveSampleSize: row.effectiveSampleSize == null ? null : String(row.effectiveSampleSize),
    standardError: row.standardError == null ? null : String(row.standardError),
    qualityStatus: row.qualityStatus,
    reconciliationResidual: row.reconciliationResidual == null ? null : String(row.reconciliationResidual),
  })) : rawConditionals.flatMap((row) => {
    const eventId = Number(row.event_id ?? row.eventId);
    const entryId = Number(row.entry_id ?? row.entryId);
    const outcome = String(row.outcome ?? "");
    if (!Number.isInteger(eventId) || !knownEvents.has(eventId) || !entryMap.has(String(entryId)) ||
        !["home_win", "away_win", "tie"].includes(outcome)) {
      throw new Error(`MTM conditional has incomplete event, entry, or outcome mapping.`);
    }
    return [{
      snapshotId, eventId, entryId,
      outcome,
      probability: row.probability == null ? null : String(row.probability),
      grossBaseline: row.gross_baseline == null && row.grossBaseline == null ? null : String(row.gross_baseline ?? row.grossBaseline),
      grossConditional: row.gross_conditional == null && row.grossConditional == null ? null : String(row.gross_conditional ?? row.grossConditional),
      grossDelta: row.gross_delta == null && row.grossDelta == null ? null : String(row.gross_delta ?? row.grossDelta),
      sampleCount: row.sample_count == null && row.sampleCount == null ? null : Math.trunc(asNumber(row.sample_count ?? row.sampleCount)),
      sampleShare: row.sample_share == null && row.sampleShare == null ? null : String(row.sample_share ?? row.sampleShare),
      effectiveSampleSize: row.effective_sample_size == null && row.effectiveSampleSize == null ? null : String(row.effective_sample_size ?? row.effectiveSampleSize),
      standardError: row.standard_error == null && row.standardError == null ? null : String(row.standard_error ?? row.standardError),
      qualityStatus: String(row.quality_status ?? row.qualityStatus ?? "insufficient"),
      reconciliationResidual: row.reconciliation_residual == null && row.reconciliationResidual == null ? null : String(row.reconciliation_residual ?? row.reconciliationResidual),
    }];
  })).map((row: any) => row);
  if (nestedRows.length && nestedRows.length !== state.remaining_schedule.length * 3 * state.entries.length) {
    throw new Error(`MTM engine returned ${nestedRows.length} conditional rows; expected ${state.remaining_schedule.length * 3 * state.entries.length}.`);
  }
  try {
    await db.transaction(async (tx) => {
      if (input.lease) await assertMtmLeaseOwnedInTransaction(tx, input.lease);
      const projections = Object.entries(engine.projections ?? {}).map(([team, projection]) => ({
        snapshotId, team, eWinsTotal: String(asNumber(projection.e_wins_total)), eRemainingWins: String(asNumber(projection.e_remaining_wins)),
        pBerth: String(asNumber((projection.p_stage as any)?.berth)), pDivisional: String(asNumber((projection.p_stage as any)?.divisional)),
        pConf: String(asNumber((projection.p_stage as any)?.conference)), pSbBerth: String(asNumber((projection.p_stage as any)?.sb_berth)),
        pSbWin: String(asNumber((projection.p_stage as any)?.sb_win)), eRemainingRawDiff: String(asNumber(projection.e_remaining_raw_diff)),
        eRemainingMarqueeAddon: String(asNumber(projection.e_remaining_marquee_addon)), rating: String(asNumber(projection.rating)),
      }));
      if (projections.length) await tx.insert(mtmTeamProjectionTable).values(projections);
      const valuations = (engine.valuations ?? []).map((valuation) => ({
        snapshotId, entryId: Number(valuation.entry_id), expectedPoints: String(asNumber(valuation.expected_points)),
        expectedShare: String(asNumber(valuation.expected_share)), expectedPayout: String(asNumber(valuation.expected_payout)),
        auctionPrice: valuation.auction_price == null ? null : String(asNumber(valuation.auction_price)),
        mtmMultiple: valuation.mtm_multiple == null ? null : String(asNumber(valuation.mtm_multiple)),
      }));
      if (valuations.length) await tx.insert(mtmEntryValuationTable).values(valuations);
      if (calibrationRows.length) await tx.insert(mtmCalibrationMetricTable).values(calibrationRows);
      for (let offset = 0; offset < conditionalRows.length; offset += CONDITIONAL_PERSISTENCE_BATCH_SIZE) {
        await tx.insert(mtmGameConditionalTable).values(
          conditionalRows.slice(offset, offset + CONDITIONAL_PERSISTENCE_BATCH_SIZE),
        );
      }
      // Calendar projection parents are guarded by a database trigger that
      // requires the referenced MTM snapshot to already be successful. Keep
      // this status transition and projection publication in this transaction.
      await tx.update(mtmSnapshotTable).set({
        status: "ok", error: null,
        diagnostics: engine.diagnostics ?? null,
        pathCount: engine.path_count == null ? null : Math.trunc(asNumber(engine.path_count)),
        randomSeed: engine.model?.seed == null ? null : Math.trunc(asNumber(engine.model.seed)),
        calibrationStatus:
          engine.diagnostics?.market_calibration &&
          typeof engine.diagnostics.market_calibration === "object"
            ? String((engine.diagnostics.market_calibration as Record<string, unknown>).status ?? "insufficient")
            : null,
        runKind: Object.values(state.realized).every((team) =>
          team.wins === 0 && team.ties === 0 && team.adj_pt_diff === 0
        ) ? "week_0" : input.trigger === "manual" ? "manual" : "scheduled",
      }).where(eq(mtmSnapshotTable.id, snapshotId));
      const periodSequence = pipelineMarkWeek(state);
      const period = await tx.select({ id: sportPeriodsTable.id })
        .from(sportPeriodsTable)
        .where(and(
          eq(sportPeriodsTable.sport, "NFL"),
          eq(sportPeriodsTable.competition, "NFL_REGULAR_SEASON"),
          eq(sportPeriodsTable.sequence, periodSequence),
        )).limit(1);
      if (period[0]) {
        const existingSelection = await tx.select({ id: mtmCanonicalPeriodSelectionTable.id })
          .from(mtmCanonicalPeriodSelectionTable)
          .where(and(
            eq(mtmCanonicalPeriodSelectionTable.poolId, poolId),
            eq(mtmCanonicalPeriodSelectionTable.sportPeriodId, period[0].id),
            eq(mtmCanonicalPeriodSelectionTable.snapshotId, snapshotId),
          )).limit(1);
        if (!existingSelection[0]) {
          await tx.insert(mtmCanonicalPeriodSelectionTable).values({
            poolId, sportPeriodId: period[0].id, snapshotId,
            selectedReason: "successful MTM publication",
          });
        }
      }
      const calendars = await tx.select({ calendarId: calcuttaCalendarsTable.id })
        .from(calcuttaCalendarsTable).where(eq(calcuttaCalendarsTable.calcuttaId, poolId));
      for (const calendar of calendars) {
        const calendarSlots = await tx.select({ id: calendarSlotsTable.id })
          .from(calendarSlotsTable).innerJoin(calendarRoundsTable, eq(calendarRoundsTable.id, calendarSlotsTable.roundId))
          .where(eq(calendarRoundsTable.calendarId, calendar.calendarId));
        if (calendarSlots.length) {
          await tx.insert(calendarProjectionSnapshotsTable).values(calendarSlots.map((slot) => ({
            slotId: slot.id,
            mtmSnapshotId: snapshotId,
            status: "unavailable" as const,
            unavailableReason: "The current MTM engine does not provide exact-slot probabilities.",
          })));
        }
      }
    });
  } catch (error) {
    const message = `MTM persistence failed: ${error instanceof Error ? error.message : String(error)}`;
    const diagnostics = { persistenceError: message };
    await db.update(mtmSnapshotTable).set({ status: "failed", error: message, diagnostics })
      .where(eq(mtmSnapshotTable.id, snapshotId));
    return {
      id: snapshotId, currentSnapshotId: null, poolId, asOf: now.toISOString(),
      currentAsOf: null, status: "failed", error: message, stale: true,
      staleReasons: [message], diagnostics, valuations: [], projections: {},
    };
  }
  return {
    id: snapshotId, currentSnapshotId: snapshotId, poolId, asOf: now.toISOString(),
    currentAsOf: now.toISOString(), status: "ok", error: null, stale: false,
    staleReasons: [], diagnostics: engine.diagnostics ?? null,
    valuations: engine.valuations ?? [], projections: engine.projections ?? {},
  };
}

export async function getMtmPipelineStatus(seasonYear: number, calcuttaId?: number): Promise<MtmPipelineResult | null> {
  const selected = await db.select({
    poolId: calcuttasTable.id,
    seasonId: calcuttasTable.seasonId,
  }).from(calcuttasTable).innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .where(and(eq(seasonsTable.year, seasonYear), eq(calcuttasTable.sport, "NFL"), calcuttaId == null ? eq(calcuttasTable.isCanonical, true) : eq(calcuttasTable.id, calcuttaId))).limit(1);
  if (!selected[0]) return null;
  const attempts = await db.select().from(mtmSnapshotTable)
    .where(and(
      eq(mtmSnapshotTable.poolId, selected[0].poolId),
      ne(mtmSnapshotTable.methodVersion, "mtm-v3-review"),
    ))
    .orderBy(
      sql`${mtmSnapshotTable.createdAt} desc`,
      sql`${mtmSnapshotTable.id} desc`,
    ).limit(1);
  const attempt = attempts[0];
  if (!attempt) return null;
  const promotedVersions = await db.select({
    sourceSnapshotId: mtmValuationVersionTable.sourceSnapshotId,
    status: mtmValuationVersionTable.status,
    mtmAsOf: mtmValuationVersionTable.mtmAsOf,
  }).from(mtmValuationVersionTable)
    .where(and(
      eq(mtmValuationVersionTable.poolId, selected[0].poolId),
      inArray(mtmValuationVersionTable.status, ["current", "superseded"]),
    ))
    .orderBy(
      sql`${mtmValuationVersionTable.mtmAsOf} desc`,
      sql`${mtmValuationVersionTable.id} desc`,
    );
  const promotedSnapshotIds = [...new Set(
    promotedVersions.map((version) => version.sourceSnapshotId),
  )];
  const successfulRows = promotedSnapshotIds.length
    ? await db.select().from(mtmSnapshotTable)
        .where(and(
          eq(mtmSnapshotTable.poolId, selected[0].poolId),
          eq(mtmSnapshotTable.status, "ok"),
          ne(mtmSnapshotTable.methodVersion, "mtm-v3-review"),
          inArray(mtmSnapshotTable.id, promotedSnapshotIds),
        ))
        .orderBy(
          sql`${mtmSnapshotTable.asOf} desc`,
          sql`${mtmSnapshotTable.id} desc`,
        )
    : [];
  const currentVersion = promotedVersions.find((version) => version.status === "current");
  const current = currentVersion
    ? successfulRows.find((snapshot) => snapshot.id === currentVersion.sourceSnapshotId)
    : undefined;
  const previous = successfulRows.find((snapshot) => snapshot.id !== current?.id);
  const dataSnapshotId = current?.id ?? attempt.id;
  const successfulSnapshotIds = successfulRows.map((snapshot) => snapshot.id);
  const [projections, valuations, historicalValuations, entryRows, ownership, weekZeroRows, primaryCostRows] = await Promise.all([
    db.select().from(mtmTeamProjectionTable).where(eq(mtmTeamProjectionTable.snapshotId, dataSnapshotId)),
    db.select().from(mtmEntryValuationTable).where(eq(mtmEntryValuationTable.snapshotId, dataSnapshotId)),
    successfulSnapshotIds.length > 0
      ? db.select().from(mtmEntryValuationTable)
          .where(inArray(mtmEntryValuationTable.snapshotId, successfulSnapshotIds))
      : Promise.resolve([] as Array<typeof mtmEntryValuationTable.$inferSelect>),
    db.select({
      entryId: calcuttaEntriesTable.id,
      teamId: calcuttaEntriesTable.teamId,
      teamName: teamsTable.name,
    }).from(calcuttaEntriesTable)
      .innerJoin(teamsTable, eq(teamsTable.id, calcuttaEntriesTable.teamId))
      .where(eq(calcuttaEntriesTable.calcuttaId, selected[0].poolId)),
    loadSeasonOwnership(selected[0].seasonId, selected[0].poolId),
    db.select({
      id: mtmSnapshotsTable.id,
      entryId: mtmSnapshotsTable.entryId,
      mtmValue: mtmSnapshotsTable.mtmValue,
      capturedAt: mtmSnapshotsTable.capturedAt,
      snapshotDate: mtmSnapshotsTable.snapshotDate,
    }).from(mtmSnapshotsTable)
      .innerJoin(calcuttaEntriesTable, eq(calcuttaEntriesTable.id, mtmSnapshotsTable.entryId))
      .where(and(
        eq(calcuttaEntriesTable.calcuttaId, selected[0].poolId),
        eq(mtmSnapshotsTable.snapshotKey, "week-0"),
        eq(mtmSnapshotsTable.source, "kalshi"),
      )),
    db.select({
      entryId: positionsTable.entryId,
      costBasis: positionsTable.costBasis,
    }).from(positionsTable)
      .innerJoin(calcuttaEntriesTable, eq(calcuttaEntriesTable.id, positionsTable.entryId))
      .where(and(
        eq(calcuttaEntriesTable.calcuttaId, selected[0].poolId),
        eq(positionsTable.source, "primary"),
      )),
  ]);
  const entryById = new Map(entryRows.map((entry) => [entry.entryId, entry]));
  const historicalValuationBySnapshotAndEntry = new Map(
    historicalValuations.map((valuation) => [
      `${valuation.snapshotId}:${valuation.entryId}`,
      valuation,
    ]),
  );
  const historicalTotalsBySnapshot = new Map<number, {
    expectedPayout: number;
    auctionPrice: number;
  }>();
  for (const valuation of historicalValuations) {
    if (valuation.auctionPrice == null) continue;
    const totals = historicalTotalsBySnapshot.get(valuation.snapshotId) ?? {
      expectedPayout: 0,
      auctionPrice: 0,
    };
    totals.expectedPayout += asNumber(valuation.expectedPayout);
    totals.auctionPrice += asNumber(valuation.auctionPrice);
    historicalTotalsBySnapshot.set(valuation.snapshotId, totals);
  }
  const primaryCostByEntry = new Map<number, number>();
  for (const position of primaryCostRows) {
    primaryCostByEntry.set(
      position.entryId,
      (primaryCostByEntry.get(position.entryId) ?? 0) + asNumber(position.costBasis),
    );
  }
  const weekZeroByEntry = new Map(weekZeroRows.map((row) => [row.entryId, row]));
  const weekZeroTotal = weekZeroRows.reduce((sum, row) => sum + asNumber(row.mtmValue), 0);
  const weekZeroCostTotal = entryRows.reduce(
    (sum, entry) => sum + (primaryCostByEntry.get(entry.entryId) ?? 0),
    0,
  );
  const hasAuthoritativeWeekZero =
    weekZeroRows.length === entryRows.length &&
    weekZeroByEntry.size === entryRows.length &&
    entryRows.every((entry) =>
      weekZeroByEntry.has(entry.entryId) && primaryCostByEntry.has(entry.entryId),
    ) &&
    Math.abs(weekZeroTotal - weekZeroCostTotal) <= 0.01;
  const previousPayoutByEntry = new Map(
    previous
      ? historicalValuations
          .filter((valuation) => valuation.snapshotId === previous.id)
          .map((valuation) => [valuation.entryId, valuation.expectedPayout])
      : hasAuthoritativeWeekZero
        ? entryRows.map((entry) => [
            entry.entryId,
            weekZeroByEntry.get(entry.entryId)?.mtmValue ?? null,
          ])
        : [],
  );
  const chronologicalSnapshots = [...successfulRows].sort(
    (a, b) => a.asOf.getTime() - b.asOf.getTime() || a.id - b.id,
  );
  const enrichedValuations = valuations.map((valuation) => {
    const entry = entryById.get(valuation.entryId);
    const owners = entry
      ? (ownership.currentOwnersByTeam.get(entry.teamId) ?? []).map((owner) => ({
          name: owner.bidderName,
          share: owner.ownershipShare,
          bookValue: asNumber(valuation.expectedPayout) * owner.ownershipShare,
        }))
      : [];
    return {
      ...valuation,
      teamId: entry?.teamId ?? null,
      teamName: entry?.teamName ?? `Entry ${valuation.entryId}`,
      previousExpectedPayout: previousPayoutByEntry.get(valuation.entryId) ?? null,
      history: [
        ...(hasAuthoritativeWeekZero
          ? (() => {
              const baseline = weekZeroByEntry.get(valuation.entryId);
              const auctionPrice = primaryCostByEntry.get(valuation.entryId);
              if (!baseline || auctionPrice == null) return [];
              const expectedPayout = asNumber(baseline.mtmValue);
              const asOf = baseline.capturedAt
                ?? new Date(`${baseline.snapshotDate}T12:00:00-04:00`);
              return [{
                snapshotId: baseline.id,
                label: "Week 0",
                asOf: asOf.toISOString(),
                expectedPayout,
                auctionPrice,
                netPayout: expectedPayout - auctionPrice,
              }];
            })()
          : []),
        ...chronologicalSnapshots.flatMap((snapshot) => {
        const historical = historicalValuationBySnapshotAndEntry.get(
          `${snapshot.id}:${valuation.entryId}`,
        );
        if (!historical) return [];
        const expectedPayout = asNumber(historical.expectedPayout);
        const auctionPrice = historical.auctionPrice == null
          ? null
          : asNumber(historical.auctionPrice);
        const totals = historicalTotalsBySnapshot.get(snapshot.id);
        const payoutScale = totals && totals.expectedPayout !== 0
          ? totals.auctionPrice / totals.expectedPayout
          : null;
        return [{
          snapshotId: snapshot.id,
          label: `Week ${pipelineMarkWeek(snapshot.stateJson)}`,
          asOf: snapshot.asOf.toISOString(),
          expectedPayout,
          auctionPrice,
          netPayout: auctionPrice == null || payoutScale == null
            ? null
            : expectedPayout * payoutScale - auctionPrice,
        }];
        }),
      ],
      owners,
    };
  });
  const config = await loadConfig();
  const ageHours = current ? (Date.now() - current.asOf.getTime()) / 3_600_000 : Number.POSITIVE_INFINITY;
  const staleReasons = [
    ...(attempt.status === "failed" ? [attempt.error ?? "The latest MTM attempt failed."] : []),
    ...(ageHours > asNumber(config.pricing?.stale_after_hours, 168)
      ? [`The latest successful mark is ${Math.floor(ageHours)} hours old.`]
      : []),
    ...(!current ? ["No successful MTM snapshot is available."] : []),
  ];
  return {
    id: attempt.id, currentSnapshotId: current?.id ?? null, poolId: attempt.poolId,
    asOf: attempt.asOf.toISOString(), currentAsOf: current?.asOf.toISOString() ?? null,
    status: attempt.status as "ok" | "failed", error: attempt.error,
    stale: staleReasons.length > 0, staleReasons, diagnostics: current?.diagnostics ?? null,
    projections: Object.fromEntries(projections.map((projection) => [projection.team, projection])),
    valuations: enrichedValuations as unknown as Array<Record<string, unknown>>,
    currentSelectionType: current ? "canonical" : "latest",
  };
}

export { withMtmLock };

export const mtmPipelineTestUtils = {
  classifyEliminationMarket,
  hourStart,
  quoteValue,
  quoteVolume,
  deriveQuoteState,
  validateCompleteEngineSnapshot,
  conditionalPersistenceBatches<T>(rows: T[]): T[][] {
    const batches: T[][] = [];
    for (let offset = 0; offset < rows.length; offset += CONDITIONAL_PERSISTENCE_BATCH_SIZE) {
      batches.push(rows.slice(offset, offset + CONDITIONAL_PERSISTENCE_BATCH_SIZE));
    }
    return batches;
  },
  mergeTeamQuoteResults,
  validateScheduleIdentitySets,
  buildMarketQuoteRows,
  kalshiEventUrl,
};