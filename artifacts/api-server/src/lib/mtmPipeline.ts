import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  calcuttaEntriesTable,
  calcuttasTable,
  db,
  mtmEntryValuationTable,
  mtmMarketQuoteTable,
  mtmSnapshotTable,
  mtmTeamProjectionTable,
  nflGamesTable,
  positionsTable,
  seasonsTable,
  teamsTable,
  pool,
} from "@workspace/db";
import { loadSeasonOwnership } from "./seasonOwnership";
import {
  isNflMarqueeKickoff,
  NFL_SCORING_ADAPTER,
} from "./competitionScoring";

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = existsSync(resolve(process.cwd(), "mtm"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const ENGINE_DIR = resolve(WORKSPACE_ROOT, "mtm/engine");
const CONFIG_PATH = resolve(WORKSPACE_ROOT, "mtm/season-config-2026.json");
const MTM_LOCK_NAMESPACE = 7_143;
const ESPN_TEAM_CODE: Record<string, string> = { JAX: "JAC", WSH: "WAS" };
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
  remaining_schedule: Array<{ home: string; away: string; marquee: boolean; week: number }>;
  divisions: Record<string, string[]>;
  win_ladders: Record<string, Array<{ strike: number; yes_bid: number | null; yes_ask: number | null; volume: number }>>;
  elimination_quotes: Record<string, Record<string, number>>;
};

type EngineSnapshot = {
  status: "ok" | "failed";
  as_of: string;
  error?: string;
  projections?: Record<string, Record<string, unknown>>;
  valuations?: Array<Record<string, unknown>>;
  diagnostics?: Record<string, unknown>;
};

type RawMarketQuote = {
  series: string;
  team: string;
  market: Record<string, unknown>;
};

function mergeTeamQuoteResults(
  teamCode: string,
  series: { win_totals: string; stage_of_elimination: string },
  winResult: PromiseSettledResult<any[]>,
  stageResult: PromiseSettledResult<any[]>,
): { raw: RawMarketQuote[]; errors: string[] } {
  const raw: RawMarketQuote[] = [];
  const errors: string[] = [];
  if (winResult.status === "fulfilled") {
    raw.push(...winResult.value.map((market) => ({
      series: series.win_totals, team: teamCode, market,
    })));
    if (winResult.value.length === 0) {
      errors.push(`${teamCode} win totals: no markets received`);
    }
  } else {
    errors.push(`${teamCode} win totals: ${String(winResult.reason)}`);
  }
  if (stageResult.status === "fulfilled") {
    raw.push(...stageResult.value.map((market) => ({
      series: series.stage_of_elimination, team: teamCode, market,
    })));
    if (stageResult.value.length === 0) {
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
};

function asNumber(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function seasonCode(year: number): string {
  return String(year + 1).slice(-2);
}

async function loadConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Record<string, any>;
}

async function fetchKalshiEvent(baseUrl: string, ticker: string): Promise<any[]> {
  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/events/${encodeURIComponent(ticker)}?with_nested_markets=true`,
    { headers: { Accept: "application/json", "User-Agent": "calcutta-mtm/1.0" }, signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) throw new Error(`Kalshi event ${ticker} returned HTTP ${response.status}.`);
  const body = await response.json() as { event?: { markets?: any[] } };
  return body.event?.markets ?? [];
}

function quoteValue(market: any, field: string): number | null {
  const dollars = market?.[`${field}_dollars`];
  if (dollars != null && dollars !== "") return Number(dollars);
  const cents = market?.[field];
  if (cents == null || cents === "") return null;
  const number = Number(cents);
  return Number.isFinite(number) ? number / 100 : null;
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
        volume: Math.trunc(asNumber(market.volume)),
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

async function fetchEspnRemainingSchedule(seasonYear: number): Promise<MtmState["remaining_schedule"]> {
  const weeks = await Promise.all(Array.from({ length: 18 }, async (_, index) => {
    const week = index + 1;
    const url = new URL("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
    url.searchParams.set("dates", String(seasonYear));
    url.searchParams.set("seasontype", "2");
    url.searchParams.set("week", String(week));
    url.searchParams.set("limit", "100");
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "calcutta-mtm/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`ESPN NFL schedule week ${week} returned HTTP ${response.status}.`);
    const payload = await response.json() as {
      events?: Array<{
        id?: string;
        date?: string;
        week?: { number?: number };
        status?: { type?: { completed?: boolean } };
        competitions?: Array<{
          competitors?: Array<{ homeAway?: string; team?: { abbreviation?: string } }>;
        }>;
      }>;
    };
    return (payload.events ?? []).flatMap((event) => {
      if (event.status?.type?.completed || !event.date) return [];
      const competitors = event.competitions?.[0]?.competitors ?? [];
      const providerHome = competitors.find((team) => team.homeAway === "home")?.team?.abbreviation;
      const providerAway = competitors.find((team) => team.homeAway === "away")?.team?.abbreviation;
      if (!providerHome || !providerAway) return [];
      const home = ESPN_TEAM_CODE[providerHome] ?? providerHome;
      const away = ESPN_TEAM_CODE[providerAway] ?? providerAway;
      return [{
        providerId: event.id ?? `${week}:${away}:${home}:${event.date}`,
        home,
        away,
        marquee: isNflMarqueeKickoff(event.date),
        week: event.week?.number ?? week,
      }];
    });
  }));
  const allGames = weeks.flat();
  const identities = new Set(allGames.map((game) => game.providerId));
  if (identities.size !== allGames.length) {
    throw new Error("ESPN returned duplicate NFL schedule events.");
  }
  return allGames.map(({ providerId: _providerId, ...game }) => game);
}

async function exportState(seasonYear: number, calcuttaId?: number): Promise<{
  poolId: number;
  state: MtmState;
  rawQuotes: RawMarketQuote[];
  quoteErrors: string[];
  quoteTeams: Array<{ code: string; name: string }>;
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
  const remainingSchedule = await fetchEspnRemainingSchedule(seasonYear);
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
  const remainingGameIds = remainingSchedule.map((game) => `${game.week}:${game.away}:${game.home}`);
  const scheduleIdentityError = validateScheduleIdentitySets(completedGameIds, remainingGameIds);
  if (scheduleIdentityError) throw new Error(scheduleIdentityError);
  const knownCodes = new Set(entries.map((entry) => TEAM_CODE_BY_NAME[entry.name]));
  if (remainingSchedule.some((game) => !knownCodes.has(game.home) || !knownCodes.has(game.away))) {
    throw new Error("ESPN returned an NFL team that is not present in the canonical Calcutta.");
  }
  const remainingByTeam = new Map<string, number>();
  for (const game of remainingSchedule) {
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
    remaining_schedule: remainingSchedule,
    divisions,
    win_ladders: {},
    elimination_quotes: {},
  };
  return {
    poolId: poolRow.poolId,
    state,
    rawQuotes: quotes.raw,
    quoteErrors: quotes.errors,
    quoteTeams: teams,
  };
}

async function runEngine(state: MtmState): Promise<EngineSnapshot> {
  const dir = await mkdtemp(resolve(tmpdir(), "calcutta-mtm-"));
  const statePath = resolve(dir, "state.json");
  const outPath = resolve(dir, "snapshot.json");
  try {
    await writeFile(statePath, JSON.stringify(state), "utf8");
    await execFileAsync("python3", ["run_mtm.py", "--config", CONFIG_PATH, "--state", statePath, "--out", outPath], { cwd: ENGINE_DIR, timeout: 120_000 });
    return JSON.parse(await readFile(outPath, "utf8")) as EngineSnapshot;
  } catch (error) {
    try {
      return JSON.parse(await readFile(outPath, "utf8")) as EngineSnapshot;
    } catch {
      return { status: "failed", as_of: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hourStart(date: Date): Date {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

function validateCompleteEngineSnapshot(engine: EngineSnapshot, state: MtmState): string | null {
  if (engine.status !== "ok") return engine.error ?? "MTM engine failed.";
  const expectedTeams = new Set(Object.keys(state.realized));
  const projections = engine.projections ?? {};
  if (Object.keys(projections).length !== 32 || new Set(Object.keys(projections)).size !== 32) {
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
  }
  const expectedEntries = new Set(state.entries.map((entry) => entry.entry_id));
  const valuations = engine.valuations ?? [];
  const actualEntries = new Set(valuations.map((valuation) => String(valuation.entry_id)));
  if (valuations.length !== 32 || actualEntries.size !== 32 ||
      [...expectedEntries].some((entryId) => !actualEntries.has(entryId))) {
    return `MTM engine returned ${valuations.length} complete entry valuations; expected the pool's 32 unique entries.`;
  }
  for (const valuation of valuations) {
    if (["expected_points", "expected_share", "expected_payout", "auction_price", "mtm_multiple"]
      .some((field) => !Number.isFinite(Number(valuation[field])))) {
      return `MTM engine returned invalid numeric values for entry ${valuation.entry_id}.`;
    }
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
  fetchedAt: Date,
) {
  return rawQuotes.map(({ series, team, market }) => ({
    snapshotId,
    series,
    marketTicker: String(market.ticker),
    team,
    strike: quoteStrike(market),
    yesBid: quoteValue(market, "yes_bid") == null ? null : String(quoteValue(market, "yes_bid")),
    yesAsk: quoteValue(market, "yes_ask") == null ? null : String(quoteValue(market, "yes_ask")),
    volume: market.volume == null ? null : Math.trunc(asNumber(market.volume)),
    fetchedAt,
    rawQuote: market,
  }));
}

async function withMtmLock<T>(
  input: { seasonYear: number; calcuttaId?: number },
  run: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const poolId = await resolveMtmPoolId(input.seasonYear, input.calcuttaId);
  if (poolId == null) throw new Error(`NFL Calcutta for season ${input.seasonYear} was not found.`);
  const client = await pool.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1, $2) as acquired",
      [MTM_LOCK_NAMESPACE, poolId],
    );
    if (!lock.rows[0]?.acquired) return { acquired: false };
    try { return { acquired: true, value: await run() }; }
    finally { await client.query("select pg_advisory_unlock($1, $2)", [MTM_LOCK_NAMESPACE, poolId]); }
  } finally { client.release(); }
}

export async function runMtmPipeline(input: { seasonYear: number; calcuttaId?: number; trigger: "scheduled" | "manual"; now?: Date }): Promise<MtmPipelineResult> {
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
  const { poolId, state, rawQuotes, quoteErrors, quoteTeams } = exported;
  const snapshot = await db.insert(mtmSnapshotTable).values({
    poolId, asOf: now, asOfHour, trigger: input.trigger, status: "failed", methodVersion,
    stateJson: state,
  }).returning({ id: mtmSnapshotTable.id });
  const snapshotId = snapshot[0]!.id;
  if (rawQuotes.length) {
    await db.insert(mtmMarketQuoteTable).values(buildMarketQuoteRows(snapshotId, rawQuotes, now));
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
    await db.update(mtmSnapshotTable).set({ stateJson: state })
      .where(eq(mtmSnapshotTable.id, snapshotId));
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
  try {
    await db.transaction(async (tx) => {
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
      await tx.update(mtmSnapshotTable).set({
        status: "ok", error: null, diagnostics: engine.diagnostics ?? null,
      }).where(eq(mtmSnapshotTable.id, snapshotId));
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
    .where(eq(mtmSnapshotTable.poolId, selected[0].poolId))
    .orderBy(
      sql`${mtmSnapshotTable.createdAt} desc`,
      sql`${mtmSnapshotTable.id} desc`,
    ).limit(1);
  const attempt = attempts[0];
  if (!attempt) return null;
  const successfulRows = await db.select().from(mtmSnapshotTable)
    .where(and(eq(mtmSnapshotTable.poolId, selected[0].poolId), eq(mtmSnapshotTable.status, "ok")))
    .orderBy(
      sql`${mtmSnapshotTable.asOf} desc`,
      sql`${mtmSnapshotTable.id} desc`,
    );
  const current = successfulRows[0];
  const previous = successfulRows[1];
  const dataSnapshotId = current?.id ?? attempt.id;
  const successfulSnapshotIds = successfulRows.map((snapshot) => snapshot.id);
  const [projections, valuations, historicalValuations, entryRows, ownership] = await Promise.all([
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
  const previousPayoutByEntry = new Map(
    previous
      ? historicalValuations
          .filter((valuation) => valuation.snapshotId === previous.id)
          .map((valuation) => [valuation.entryId, valuation.expectedPayout])
      : [],
  );
  const chronologicalSnapshots = [...successfulRows].reverse();
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
      history: chronologicalSnapshots.flatMap((snapshot, index) => {
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
          label: index === 0 ? "Week 0" : `Week ${index}`,
          asOf: snapshot.asOf.toISOString(),
          expectedPayout,
          auctionPrice,
          netPayout: auctionPrice == null || payoutScale == null
            ? null
            : expectedPayout * payoutScale - auctionPrice,
        }];
      }),
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
  };
}

export { withMtmLock };

export const mtmPipelineTestUtils = {
  classifyEliminationMarket,
  hourStart,
  quoteValue,
  validateCompleteEngineSnapshot,
  mergeTeamQuoteResults,
  validateScheduleIdentitySets,
};