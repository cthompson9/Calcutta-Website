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
import { allocateMtmPoolCents } from "./mtmMoney";
import {
  isNflMarqueeKickoff,
  NFL_SCORING_ADAPTER,
} from "./competitionScoring";
import { flattenEngineConditionals } from "./mtmValuationHelpers";
import {
  MTM_EVIDENCE_POLICY_VERSION,
  assessMtmEvidence,
  acceptedYesBounds,
  canonicalQuoteDecision,
  estimateMtmTrades,
  type MtmEvidenceInput,
} from "./mtmEvidence";
import { validateMtmCanonicalDataFreshness } from "./currentMtm";
import { selectReferenceMark, MTM_REFERENCE_MARK_POLICY_VERSION } from "./mtmReferenceMarks";
import {
  resolveReferenceCandidates,
  type PersistedReference,
  type ReferenceCandidate,
  type ReferenceContractKey,
} from "./mtmReferencePersistence";
import { INTERVAL_POLICY, REFERENCE_MARK_POWER_POLICY, selectedMtmPolicy, validateMtmPolicyIdentity, validateFinalIntervalMarketQuality } from "./mtmIntervalPolicy";
import { nflDisplayWeek } from "./nflDisplayWeek";

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
    weak?: boolean;
  }>>;
  elimination_quotes: Record<string, Record<string, number>>;
  /** Captured evidence for the explicit offline market-policy shadow runner. */
  market_evidence_review?: Record<string, unknown>;
  /** Additive review-only evidence; canonical engine behavior ignores this. */
  joint_fit_constraints?: Array<Record<string, unknown>>;
  joint_fit_group_caps?: Record<string, number>;
};

type EngineSnapshot = {
  status: "ok" | "failed";
  as_of: string;
  error?: string;
  projections?: Record<string, Record<string, unknown>>;
  valuations?: Array<Record<string, unknown>>;
  diagnostics?: Record<string, unknown>;
  path_count?: number;
  model?: { name?: string; seed?: number; pricing_policy?: string; pricing_basis?: string };
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
  completenessManifest?: Record<string, unknown> | null;
  captureMetadata?: Record<string, unknown> | null;
  resolvedReference?: PersistedReference;
};

type WinMarketQuality = {
  status: "good" | "weak" | "missing";
  trustedRungs: number;
  wideRungs: number;
  missingRungs: number;
  reason: string | null;
};

type FetchedMarkets = {
  markets: any[];
  sourceUrl: string;
  fetchedAt: Date;
  completenessManifest?: Record<string, unknown> | null;
  captureMetadata?: Record<string, unknown> | null;
};

type CaptureRequestAudit = {
  identity: string;
  team: string;
  series: string;
  ticker: string;
  status: "fulfilled" | "failed";
  market_count: number;
  source_url: string | null;
  fetched_at: string | null;
  provider_manifest: Record<string, unknown> | null;
  error: string | null;
};

type InternalCaptureManifest = {
  policy: "internal-request-capture-v1";
  expected_request_count: number;
  fulfilled_request_count: number;
  failed_request_count: number;
  nonempty_request_count: number;
  complete: boolean;
  requests: CaptureRequestAudit[];
};

function buildInternalCaptureManifest(
  expectedRequestCount: number,
  requests: CaptureRequestAudit[],
): InternalCaptureManifest {
  const ordered = [...requests].sort((a, b) => a.identity.localeCompare(b.identity));
  return {
    policy: "internal-request-capture-v1",
    expected_request_count: expectedRequestCount,
    fulfilled_request_count: ordered.filter((request) => request.status === "fulfilled").length,
    failed_request_count: ordered.filter((request) => request.status === "failed").length,
    nonempty_request_count: ordered.filter((request) => request.market_count > 0).length,
    complete: ordered.length === expectedRequestCount &&
      ordered.every((request) => request.status === "fulfilled" && request.market_count > 0),
    requests: ordered,
  };
}

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
  tickersOrWinResult: { win: string; stage: string } | PromiseSettledResult<any[] | FetchedMarkets>,
  winOrStageResult: PromiseSettledResult<any[] | FetchedMarkets>,
  optionalStageResult?: PromiseSettledResult<any[] | FetchedMarkets>,
): { raw: RawMarketQuote[]; errors: string[]; requests: CaptureRequestAudit[] } {
  // Preserve the small direct-test/helper API used by older callers while
  // normal collection supplies deterministic request identities.
  const legacyCall = optionalStageResult == null;
  const tickers = legacyCall
    ? { win: `${teamCode}:${series.win_totals}`, stage: `${teamCode}:${series.stage_of_elimination}` }
    : tickersOrWinResult as { win: string; stage: string };
  const winResult = (legacyCall ? tickersOrWinResult : winOrStageResult) as PromiseSettledResult<any[] | FetchedMarkets>;
  const stageResult = (legacyCall ? winOrStageResult : optionalStageResult) as PromiseSettledResult<any[] | FetchedMarkets>;
  const raw: RawMarketQuote[] = [];
  const errors: string[] = [];
  const requests: CaptureRequestAudit[] = [];
  const requestAudit = (
    seriesName: string,
    ticker: string,
    result: PromiseSettledResult<any[] | FetchedMarkets>,
  ): CaptureRequestAudit => {
    if (result.status === "rejected") {
      return {
        identity: `${teamCode}:${seriesName}:${ticker}`,
        team: teamCode, series: seriesName, ticker, status: "failed",
        market_count: 0, source_url: null, fetched_at: null,
        provider_manifest: null, error: String(result.reason),
      };
    }
    const fetched = Array.isArray(result.value)
      ? { markets: result.value, sourceUrl: null, fetchedAt: null, completenessManifest: null }
      : result.value;
    return {
      identity: `${teamCode}:${seriesName}:${ticker}`,
      team: teamCode, series: seriesName, ticker, status: "fulfilled",
      market_count: fetched.markets.length,
      source_url: fetched.sourceUrl ?? null,
      fetched_at: fetched.fetchedAt?.toISOString() ?? null,
      provider_manifest: fetched.completenessManifest ?? null,
      error: null,
    };
  };
  requests.push(requestAudit(series.win_totals, tickers.win, winResult));
  requests.push(requestAudit(series.stage_of_elimination, tickers.stage, stageResult));
  if (winResult.status === "fulfilled") {
    const fetched = Array.isArray(winResult.value)
      ? { markets: winResult.value, sourceUrl: undefined, fetchedAt: undefined, completenessManifest: null, captureMetadata: null }
      : winResult.value;
    raw.push(...fetched.markets.map((market) => ({
      series: series.win_totals, team: teamCode, market,
      sourceUrl: fetched.sourceUrl, fetchedAt: fetched.fetchedAt,
      completenessManifest: fetched.completenessManifest ?? null,
      captureMetadata: fetched.captureMetadata ?? null,
    })));
    if (fetched.markets.length === 0) {
      errors.push(`${teamCode} win totals: no markets received`);
    }
  } else {
    errors.push(`${teamCode} win totals: ${String(winResult.reason)}`);
  }
  if (stageResult.status === "fulfilled") {
    const fetched = Array.isArray(stageResult.value)
      ? { markets: stageResult.value, sourceUrl: undefined, fetchedAt: undefined, completenessManifest: null, captureMetadata: null }
      : stageResult.value;
    raw.push(...fetched.markets.map((market) => ({
      series: series.stage_of_elimination, team: teamCode, market,
      sourceUrl: fetched.sourceUrl, fetchedAt: fetched.fetchedAt,
      completenessManifest: fetched.completenessManifest ?? null,
      captureMetadata: fetched.captureMetadata ?? null,
    })));
    if (fetched.markets.length === 0) {
      errors.push(`${teamCode} stage of elimination: no markets received`);
    }
  } else {
    errors.push(`${teamCode} stage of elimination: ${String(stageResult.reason)}`);
  }
  return { raw, errors, requests };
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
  const event = body.event as Record<string, unknown> | undefined;
  const completenessManifest =
    (event?.completeness_manifest ?? event?.completenessManifest
      ?? (body as Record<string, unknown>).completeness_manifest);
  return {
    markets: body.event?.markets ?? [],
    sourceUrl,
    fetchedAt: new Date(),
    completenessManifest: completenessManifest && typeof completenessManifest === "object"
      ? completenessManifest as Record<string, unknown>
      : null,
    captureMetadata: event?.metadata && typeof event.metadata === "object"
      ? event.metadata as Record<string, unknown>
      : null,
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

/**
 * A market without an order book is evidence of a missing quote, not a
 * probability of zero.  Settled contracts are still valid evidence, but an
 * unsettled contract must explicitly be active and must not carry a result.
 * Keep this check here (rather than in the Python engine) so every publisher
 * uses the same input contract.
 */
function validateActiveQuote(market: any): string | null {
  const status = market?.status == null ? "" : String(market.status).trim().toLowerCase();
  const result = market?.result == null ? "" : String(market.result).trim().toLowerCase();
  const settled = new Set(["closed", "determined", "finalized", "settled"]);
  const active = new Set(["active", "open", "initialized"]);
  if (settled.has(status)) {
    if (status === "closed" && result !== "yes" && result !== "no") {
      return `market status ${JSON.stringify(market?.status)} is not active`;
    }
    return result === "yes" || result === "no"
      ? null
      : `settled market has invalid result ${JSON.stringify(market?.result)}`;
  }
  if (!active.has(status)) {
    return `market status ${JSON.stringify(market?.status)} is not active`;
  }
  if (result) return `active market has settled result ${JSON.stringify(market?.result)}`;
  const bid = quoteValue(market, "yes_bid");
  const ask = quoteValue(market, "yes_ask");
  // An active market can legitimately have an empty or one-sided book.  It
  // remains weak/missing and is handled by assessWinMarketQuality below.
  if (bid == null || ask == null) return null;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask > 1 || bid > ask) {
    return "active market has an invalid yes bid/ask";
  }
  return null;
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
): Promise<{ raw: RawMarketQuote[]; errors: string[]; captureManifest: InternalCaptureManifest }> {
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
    }, { win: winTicker, stage: stageTicker }, winResult, stageResult);
  }));
  const requests = results.flatMap((result) => result.requests);
  return {
    raw: results.flatMap((result) => result.raw),
    errors: results.flatMap((result) => result.errors),
    captureManifest: buildInternalCaptureManifest(teams.length * 2, requests),
  };
}

type PriorReferenceRow = {
  key: ReferenceContractKey;
  referencePrice: string | null;
  selectionMethod: string | null;
  referenceAcceptedAt: Date | null;
  referenceSourceSnapshotId: number | null;
  referenceSourceTicker: string | null;
  provider: string | null;
  contract: string | null;
  marketTicker: string;
  eventId: number | null;
  fetchedAt: Date | null;
  sourceObservedAt: Date | null;
  source: string | null;
  team: string | null;
  series: string;
  strike: string | null;
  outcome: string | null;
};

async function loadPriorReferenceRows(poolId: number, seasonId: number): Promise<PriorReferenceRow[]> {
  const rows = await db.select({
    snapshotId: mtmSnapshotTable.id,
    snapshotAsOf: mtmSnapshotTable.asOf,
    versionAsOf: mtmValuationVersionTable.mtmAsOf,
    marketTicker: mtmMarketQuoteTable.marketTicker,
    source: mtmMarketQuoteTable.source,
    provider: mtmMarketQuoteTable.provider,
    contract: mtmMarketQuoteTable.contract,
    team: mtmMarketQuoteTable.team,
    series: mtmMarketQuoteTable.series,
    strike: mtmMarketQuoteTable.strike,
    outcome: mtmMarketQuoteTable.outcome,
    eventId: mtmMarketQuoteTable.eventId,
    fetchedAt: mtmMarketQuoteTable.fetchedAt,
    sourceObservedAt: mtmMarketQuoteTable.sourceObservedAt,
    referencePrice: mtmMarketQuoteTable.referencePrice,
    selectionMethod: mtmMarketQuoteTable.selectionMethod,
    referenceAcceptedAt: mtmMarketQuoteTable.referenceAcceptedAt,
    referenceSourceSnapshotId: mtmMarketQuoteTable.referenceSourceSnapshotId,
    referenceSourceTicker: mtmMarketQuoteTable.referenceSourceTicker,
  }).from(mtmMarketQuoteTable)
    .innerJoin(mtmSnapshotTable, eq(mtmSnapshotTable.id, mtmMarketQuoteTable.snapshotId))
    .innerJoin(mtmValuationVersionTable, eq(mtmValuationVersionTable.sourceSnapshotId, mtmSnapshotTable.id))
    .where(and(
      eq(mtmSnapshotTable.poolId, poolId),
      eq(mtmSnapshotTable.status, "ok"),
      eq(mtmValuationVersionTable.poolId, poolId),
      eq(mtmValuationVersionTable.markType, "official"),
      inArray(mtmValuationVersionTable.status, ["current", "superseded"]),
      ne(mtmSnapshotTable.methodVersion, "mtm-v3-review"),
    ))
    .orderBy(sql`${mtmValuationVersionTable.mtmAsOf} desc`, sql`${mtmMarketQuoteTable.marketTicker} asc`);
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (row.team == null || row.series == null) return [];
    const key: ReferenceContractKey = {
      poolId,
      seasonId,
      provider: row.provider ?? row.source ?? "kalshi",
      eventId: row.eventId,
      ticker: row.marketTicker,
      outcome: row.series.includes("STAGE") ? classifyEliminationMarket({ ticker: row.marketTicker }) : null,
      strike: row.series.includes("WIN") ? row.strike : null,
    };
    const identity = referenceContractKeyForPipeline(key);
    if (seen.has(identity) || row.referencePrice == null) return [];
    seen.add(identity);
    return [{ ...row, key, referencePrice: row.referencePrice == null ? null : String(row.referencePrice) }];
  });
}

function referenceContractKeyForPipeline(key: ReferenceContractKey): string {
  return [
    key.poolId, key.seasonId, key.provider, key.eventId ?? "",
    key.ticker, key.outcome ?? "", key.strike ?? "",
  ].join("|");
}

function quoteReferenceCandidate(
  quote: RawMarketQuote,
  poolId: number,
  seasonId: number,
): ReferenceCandidate {
  const strike = Number(quote.market.floor_strike ?? quote.market.floor_strike_fp);
  const isWin = Number.isInteger(strike) && strike >= 1 && strike <= 17;
  const ticker = String(quote.market.ticker ?? "");
  const key: ReferenceContractKey = {
    poolId, seasonId, provider: "kalshi",
    eventId: quote.market.event_id == null && quote.market.eventId == null
      ? null : String(quote.market.event_id ?? quote.market.eventId),
    ticker,
    outcome: isWin ? null : classifyEliminationMarket(quote.market),
    strike: isWin ? strike : null,
  };
  return {
    ...quote.market,
    provider: "kalshi",
    contractId: ticker,
    ticker,
    eventId: key.eventId,
    fetchedAt: quote.fetchedAt?.toISOString() ?? null,
    key,
    fetched: Boolean(quote.fetchedAt),
  };
}

async function resolvePipelineQuotes(
  snapshotId: number,
  poolId: number,
  seasonId: number,
  config: Record<string, any>,
  rawQuotes: RawMarketQuote[],
  quoteTeams: Array<{ code: string; name: string }>,
  quoteErrors: string[],
  acceptedAt: Date,
): Promise<{ quotes: RawMarketQuote[]; references: PersistedReference[]; unavailable: PersistedReference[] }> {
  const previous = await loadPriorReferenceRows(poolId, seasonId);
  const candidates = rawQuotes.map((quote) => quoteReferenceCandidate(quote, poolId, seasonId));
  const currentByKey = new Map(candidates.map((candidate, index) => [
    referenceContractKeyForPipeline(candidate.key), rawQuotes[index]!,
  ]));
  // Prior successful rows are also expected identities. This ensures a
  // missing ARI/BAL response still gets a candidate and a structured result.
  for (const prior of previous) {
    const identity = referenceContractKeyForPipeline(prior.key);
    if (currentByKey.has(identity)) continue;
    const market: Record<string, unknown> = {
      ticker: prior.marketTicker,
      status: "active",
      ...(prior.strike != null ? { floor_strike: Number(prior.strike) } : {}),
      ...(prior.eventId != null ? { event_id: prior.eventId } : {}),
    };
    const quote: RawMarketQuote = {
      series: prior.series,
      team: prior.team!,
      market,
      fetchedAt: undefined,
      sourceUrl: undefined,
    };
    currentByKey.set(identity, quote);
    candidates.push({
      ...market,
      provider: "kalshi",
      contractId: prior.marketTicker,
      ticker: prior.marketTicker,
      eventId: prior.eventId,
      missingContract: true,
      providerFailure: quoteErrors.some((error) => error.includes(prior.team!)),
      key: prior.key,
      fetched: false,
    });
  }
  const series = config.kalshi.series as Record<string, string>;
  const code = seasonCode(Number(config.season));
  const expected = quoteTeams.flatMap((team) => [
    ...Array.from({ length: 17 }, (_, index) => ({
      series: series.win_totals,
      ticker: `${series.win_totals}-${code}${team.code}-${index + 1}`,
      strike: index + 1,
      outcome: null,
    })),
    ...["REG", "WC", "DIV", "CONF", "FL", "FW"].map((suffix) => ({
      series: series.stage_of_elimination,
      ticker: `${series.stage_of_elimination}-${code}${team.code}-${suffix}`,
      strike: null,
      outcome: classifyEliminationMarket({ ticker: suffix }),
    })),
  ]);
  for (const expectedQuote of expected) {
    const key: ReferenceContractKey = {
      poolId, seasonId, provider: "kalshi", eventId: null,
      ticker: expectedQuote.ticker, outcome: expectedQuote.outcome, strike: expectedQuote.strike,
    };
    const identity = referenceContractKeyForPipeline(key);
    if (currentByKey.has(identity)) continue;
    const market = {
      ticker: expectedQuote.ticker,
      status: "active",
      ...(expectedQuote.strike == null ? {} : { floor_strike: expectedQuote.strike }),
    };
    const quote: RawMarketQuote = {
      series: expectedQuote.series,
      team: quoteTeams.find((team) => expectedQuote.ticker.includes(team.code))?.code ?? "",
      market,
    };
    currentByKey.set(identity, quote);
    candidates.push({
      ...market,
      provider: "kalshi",
      contractId: expectedQuote.ticker,
      ticker: expectedQuote.ticker,
      key,
      missingContract: true,
      fetched: false,
    });
  }
  const resolved = resolveReferenceCandidates(candidates, previous, acceptedAt, snapshotId);
  const referenceByKey = new Map(resolved.map((reference) => [
    referenceContractKeyForPipeline(reference.key), reference,
  ]));
  const quotes = [...currentByKey.entries()].map(([identity, quote]) => {
    const reference = referenceByKey.get(identity);
    if (!reference) return quote;
    const market = { ...quote.market };
    if (reference.referencePrice != null && reference.selectionMethod === "carried_forward") {
      market.yes_bid_dollars = String(reference.referencePrice);
      market.yes_ask_dollars = String(reference.referencePrice);
      market.status = "active";
      delete market.result;
    }
    return { ...quote, market, resolvedReference: reference };
  });
  return {
    quotes,
    references: resolved,
    unavailable: resolved.filter((reference) => reference.referencePrice == null),
  };
}

function deriveQuoteState(
  config: Record<string, any>,
  teams: Array<{ code: string; name: string }>,
  raw: RawMarketQuote[],
  evaluationTime: Date = latestQuoteCapture(raw),
  requireCompleteElimination = true,
): { winLadders: MtmState["win_ladders"]; elimination: MtmState["elimination_quotes"] } {
  const series = config.kalshi.series as Record<string, string>;
  const winLadders: MtmState["win_ladders"] = {};
  const elimination: MtmState["elimination_quotes"] = {};
  for (const team of teams) {
    const winQuotes = raw
      .filter((quote) => quote.team === team.code && quote.series === series.win_totals);
    const stageQuotes = raw
      .filter((quote) => quote.team === team.code && quote.series === series.stage_of_elimination);
    let ladders = winQuotes
      .map((quote) => {
        const market = quote.market;
        const validationError = validateActiveQuote(market);
        if (validationError) {
          throw new Error(`Invalid win-total quote for ${team.code}: ${validationError}.`);
        }
        const pricingMarket = quote.resolvedReference?.referencePrice == null
          ? market
          : {
              ...market,
              yes_bid_dollars: String(quote.resolvedReference.referencePrice),
              yes_ask_dollars: String(quote.resolvedReference.referencePrice),
            };
        return {
          quote,
          market: pricingMarket,
          strike: Number(market.floor_strike ?? market.floor_strike_fp),
          decision: quoteDecisionForPipeline(
            { ...quote, market: pricingMarket },
            evaluationTime,
            "bounds",
            asNumber(config.pricing?.max_spread_for_mid, 0.15),
          ),
        };
      })
      .filter(({ strike }) => Number.isFinite(strike) && strike >= 1 && strike <= 17)
      .sort((a, b) => a.strike - b.strike)
      .flatMap(({ market, strike, decision }) => {
        if (!decision.usedInFitting &&
            decision.transformation.kind !== "interpolated_missing") return [];
        const bounds = decision.transformation.kind === "bounds"
          ? decision.transformation
          : decision.transformation.kind === "settlement"
            ? { lower: decision.transformation.value, upper: decision.transformation.value }
            : null;
        const settled = ["closed", "determined", "finalized", "settled"].includes(
          String(market.status ?? "").trim().toLowerCase(),
        );
        const interpolated = decision.transformation.kind === "interpolated_missing";
        return [{
          strike,
          yes_bid: interpolated ? null : bounds?.lower ?? null,
          yes_ask: interpolated ? null : bounds?.upper ?? null,
          volume: quoteVolume(market),
          status: market.status == null ? null : String(market.status),
          result: market.result == null ? null : String(market.result),
          ...(interpolated ? { weak: true, interpolated: true } : {}),
        }];
      });
    if (ladders.length === 0 && !requireCompleteElimination) {
      const maxSpread = asNumber(config.pricing?.max_spread_for_mid, 0.15);
      ladders = winQuotes.flatMap((quote) => {
        const strike = Number(quote.market.floor_strike ?? quote.market.floor_strike_fp);
        const bid = quoteValue(quote.market, "yes_bid");
        const ask = quoteValue(quote.market, "yes_ask");
        if (!Number.isInteger(strike) || strike < 1 || strike > 17 ||
            bid == null || ask == null || bid > ask) return [];
        return [{
          strike, yes_bid: bid, yes_ask: ask, volume: quoteVolume(quote.market),
          status: quote.market.status == null ? null : String(quote.market.status),
          result: quote.market.result == null ? null : String(quote.market.result),
          ...(ask - bid > maxSpread ? { weak: true } : {}),
        }];
      });
    }
    if (ladders.length === 0) throw new Error(`No win-total ladder was discovered for ${team.code}.`);
    winLadders[team.code] = ladders;
    const classified: Record<string, number> = {};
    for (const quote of stageQuotes) {
      const market = quote.market;
      const validationError = validateActiveQuote(market);
      if (validationError) {
        throw new Error(`Invalid stage-of-elimination quote for ${team.code}: ${validationError}.`);
      }
      const outcome = classifyEliminationMarket(market);
      const pricingQuote = quote.resolvedReference?.referencePrice == null
        ? quote
        : {
            ...quote,
            market: {
              ...quote.market,
              yes_bid_dollars: String(quote.resolvedReference.referencePrice),
              yes_ask_dollars: String(quote.resolvedReference.referencePrice),
            },
          };
      const decision = quoteDecisionForPipeline(pricingQuote, evaluationTime, "bid_plus_cent");
      const transformed = decision.transformation;
      if (outcome && decision.usedInFitting &&
          (transformed.kind === "bid_plus_cent" || transformed.kind === "settlement")) {
        classified[outcome] = transformed.value;
      }
    }
    const required = ["no_playoffs", "wild_card", "divisional", "conference", "sb_loss", "sb_win"];
    if (required.some((key) => classified[key] == null)) {
      if (!requireCompleteElimination) continue;
      throw new Error(`Incomplete stage-of-elimination quotes for ${team.code}.`);
    }
    elimination[team.code] = classified;
  }
  return { winLadders, elimination };
}

function assessWinMarketQuality(
  config: Record<string, any>,
  teams: Array<{ code: string; name: string }>,
  winLadders: MtmState["win_ladders"],
): Record<string, WinMarketQuality> {
  const maxSpread = asNumber(config.pricing?.max_spread_for_mid, 0.15);
  return Object.fromEntries(teams.map((team) => {
    const ladder = winLadders[team.code] ?? [];
    let trustedRungs = 0;
    let wideRungs = 0;
    let missingRungs = Math.max(0, 17 - ladder.length);
    for (const rung of ladder) {
      const settled = ["closed", "determined", "finalized", "settled"].includes(
        String(rung.status ?? "").trim().toLowerCase(),
      ) && (rung.result === "yes" || rung.result === "no");
      if (settled) {
        trustedRungs += 1;
      } else if (rung.weak) {
        wideRungs += 1;
      } else if (rung.yes_bid == null || rung.yes_ask == null) {
        missingRungs += 1;
      } else if (rung.yes_ask - rung.yes_bid > maxSpread) {
        wideRungs += 1;
      } else {
        trustedRungs += 1;
      }
    }
    const status: WinMarketQuality["status"] =
      trustedRungs >= 2 ? "good" : trustedRungs > 0 ? "weak" : "missing";
    return [team.code, {
      status,
      trustedRungs,
      wideRungs,
      missingRungs,
      reason: status === "good"
        ? null
        : `${team.code} has ${trustedRungs} trusted win-total rungs; `
          + `${wideRungs} wide and ${missingRungs} missing/absent rungs.`,
    }];
  }));
}

function buildJointFitConstraints(
  rawQuotes: RawMarketQuote[],
  configuredGroupCaps: Record<string, number> = {},
  evaluationTime: Date = latestQuoteCapture(rawQuotes),
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const stageEvidence = new Map<string, Map<string, {
    lower: number;
    upper: number;
    reliability: number;
    resolved: boolean;
    qualityStatus: string;
    policyVersion: string;
    evidenceGroup: string | null;
    groupCap: number;
  }>>();
  const ordered = [...rawQuotes].sort((a, b) =>
    a.series.localeCompare(b.series) ||
    a.team.localeCompare(b.team) ||
    String(a.market.ticker ?? "").localeCompare(String(b.market.ticker ?? "")),
  );
  for (const quote of ordered) {
    const market = quote.market;
    const evidence = evidenceInputForQuote(quote);
    const strike = Number(market.floor_strike ?? market.floor_strike_fp);
    const isWin = Number.isInteger(strike) && strike >= 1 && strike <= 17;
    const decision = quoteDecisionForPipeline(
      quote,
      evaluationTime,
      isWin ? "bounds" : "bid_plus_cent",
    );
    const assessment = decision.assessment;
    const settled = decision.role === "settlement_fact";
    if (!decision.usedInFitting) continue;
    const evidenceGroup = evidence.evidenceGroup && typeof evidence.evidenceGroup === "object"
      ? evidence.evidenceGroup : null;
    const evidenceGroupId = assessment.groupId;
    const groupKey = evidenceGroupId ?? `evidence:${quote.series}:${quote.team}`;
    const groupCap = Math.min(
      evidenceGroup?.cap == null ? 0.5 : evidenceGroup.cap,
      configuredGroupCaps[groupKey] == null ? 0.5 : configuredGroupCaps[groupKey]!,
    );
    const outcome = isWin ? null : classifyEliminationMarket(market);
    if (isWin) {
      const usableBook = !settled &&
        (evidence.yesBid != null || evidence.yesAsk != null) &&
        (assessment.factors.spread == null || assessment.factors.spread <= 0.15);
      if (!settled && !usableBook) continue;
      const bounds = settled
        ? acceptedYesBounds(evidence)
        : acceptedYesBounds(evidence);
      const width = bounds.upper - bounds.lower;
      rows.push({
        name: `wins-${quote.team}-${strike}`,
        metric: `wins:${quote.team}:${strike}`,
        lower: bounds.lower,
        upper: bounds.upper,
        reliability: assessment.score,
        group: `wins:${quote.team}`,
        group_cap: groupCap,
        resolved: settled,
        // Precision rises as an active accepted interval narrows. Settled
        // rows are hard filters and deliberately have no soft precision.
        precision: settled ? 0 : 1 / Math.max(width, 0.01),
        evidence_group: assessment.groupId,
        quality_status: assessment.qualityStatus,
        policy_version: assessment.policyVersion,
      });
      continue;
    }
    if (!outcome || (!settled && evidence.yesBid == null) ||
        (settled && evidence.settlement == null)) continue;
    const stageBounds = acceptedYesBounds(evidence);
    const teamOutcomes = stageEvidence.get(quote.team) ?? new Map();
    teamOutcomes.set(outcome, {
      lower: stageBounds.lower,
      upper: stageBounds.upper,
      reliability: assessment.score,
      resolved: settled,
      qualityStatus: assessment.qualityStatus,
      policyVersion: assessment.policyVersion,
      evidenceGroup: evidenceGroupId,
      groupCap,
    });
    stageEvidence.set(quote.team, teamOutcomes);
  }
  for (const team of [...stageEvidence.keys()].sort()) {
    const outcomes = stageEvidence.get(team)!;
    const noPlayoffs = outcomes.get("no_playoffs");
    if (noPlayoffs) {
      rows.push({
        name: `advancement-${team}-no_playoffs`,
        metric: `no_playoffs:${team}`,
        lower: noPlayoffs.lower,
        upper: noPlayoffs.upper,
        reliability: noPlayoffs.reliability,
        resolved: noPlayoffs.resolved,
        group: `advancement:${team}`,
        group_cap: noPlayoffs.groupCap,
        precision: noPlayoffs.resolved ? 0 : 1 / Math.max(noPlayoffs.upper - noPlayoffs.lower, 0.01),
        evidence_group: noPlayoffs.evidenceGroup,
        quality_status: noPlayoffs.qualityStatus,
        policy_version: noPlayoffs.policyVersion,
      });
    }
    const reachDefinitions: Array<[string, string[]]> = [
      ["berth", ["no_playoffs"]],
      ["divisional", ["no_playoffs", "wild_card"]],
      ["conference", ["no_playoffs", "wild_card", "divisional"]],
      ["sb_berth", ["no_playoffs", "wild_card", "divisional", "conference"]],
    ];
    for (const [stage, excluded] of reachDefinitions) {
      const evidenceRows = excluded.map((outcome) => outcomes.get(outcome));
      // A reach probability is a complement of mutually exclusive
      // elimination outcomes. Never use the exact wild-card elimination
      // quote as a berth probability.
      if (evidenceRows.some((row) => row == null)) continue;
      const lower = Math.max(0, 1 - evidenceRows.reduce((sum, row) => sum + row!.upper, 0));
      const upper = Math.min(1, 1 - evidenceRows.reduce((sum, row) => sum + row!.lower, 0));
      rows.push({
        name: `advancement-${team}-${stage}`,
        metric: `stage:${team}:${stage}`,
        lower,
        upper,
        reliability: Math.min(...evidenceRows.map((row) => row!.reliability)),
        resolved: evidenceRows.every((row) => row!.resolved),
        group: `advancement:${team}`,
        group_cap: Math.min(...evidenceRows.map((row) => row!.groupCap)),
        precision: evidenceRows.every((row) => row!.resolved)
          ? 0
          : 1 / Math.max(upper - lower, 0.01),
        evidence_group: evidenceRows.map((row) => row!.evidenceGroup).filter(Boolean).sort().join(",") || null,
        quality_status: evidenceRows.some((row) => row!.qualityStatus !== "good") ? "warning" : "good",
        policy_version: evidenceRows[0]!.policyVersion,
      });
    }
    const sbWin = outcomes.get("sb_win");
    if (sbWin) {
      rows.push({
        name: `advancement-${team}-sb_win`,
        metric: `stage:${team}:sb_win`,
        lower: sbWin.lower,
        upper: sbWin.upper,
        reliability: sbWin.reliability,
        resolved: sbWin.resolved,
        group: `advancement:${team}`,
        group_cap: sbWin.groupCap,
        precision: sbWin.resolved ? 0 : 1 / Math.max(sbWin.upper - sbWin.lower, 0.01),
        evidence_group: sbWin.evidenceGroup,
        quality_status: sbWin.qualityStatus,
        policy_version: sbWin.policyVersion,
      });
    }
  }
  const groupCaps = new Map<string, number>();
  for (const row of rows) {
    const group = String(row.group);
    const cap = Number(row.group_cap);
    const configured = configuredGroupCaps[group];
    groupCaps.set(group, Math.min(
      groupCaps.get(group) ?? 0.5,
      cap,
      configured == null ? 0.5 : configured,
    ));
  }
  for (const row of rows) {
    row.group_cap = groupCaps.get(String(row.group)) ?? Number(row.group_cap);
  }
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const group = String(row.group);
    const members = grouped.get(group) ?? [];
    members.push(row);
    grouped.set(group, members);
  }
  // Apply caps to the actual reliability passed to review fitting, not just
  // as metadata. This keeps correlated ladders from dominating the fit.
  for (const [group, members] of grouped) {
    const cap = groupCaps.get(group) ?? 0.5;
    const total = members.reduce((sum, row) => sum + Number(row.reliability ?? 0), 0);
    const scale = total > cap ? cap / total : 1;
    for (const row of members) row.reliability = Number(row.reliability ?? 0) * scale;
  }
  return rows.sort((a, b) =>
    String(a.group).localeCompare(String(b.group)) ||
    String(a.name).localeCompare(String(b.name)) ||
    String(a.metric).localeCompare(String(b.metric)));
}

async function exportState(seasonYear: number, calcuttaId?: number): Promise<{
  poolId: number;
  seasonId: number;
  state: MtmState;
  rawQuotes: RawMarketQuote[];
  quoteErrors: string[];
  captureManifest: InternalCaptureManifest;
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
  const allEventRows = await db.select({
    id: eventsTable.id,
    source: eventsTable.source,
    sourceEventId: eventsTable.sourceEventId,
    week: eventsTable.week,
    kickoffAt: eventsTable.kickoffAt,
    sourceData: eventsTable.sourceData,
    updatedAt: eventsTable.updatedAt,
    status: eventsTable.status,
    homeScore: eventsTable.homeScore,
    awayScore: eventsTable.awayScore,
    homeTeamId: eventsTable.homeTeamId,
    awayTeamId: eventsTable.awayTeamId,
  }).from(eventsTable).where(and(
    eq(eventsTable.seasonId, poolRow.seasonId),
    eq(eventsTable.sport, "NFL"),
    eq(eventsTable.competition, "NFL_REGULAR_SEASON"),
  ));
  const eventRows = allEventRows.filter((event) => event.status !== "final");
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
  const freshnessErrors = validateMtmCanonicalDataFreshness({
    now: new Date(),
    events: allEventRows,
    inputProvenance,
  });
  if (freshnessErrors.length > 0) {
    throw new Error(`MTM canonical data freshness check failed: ${freshnessErrors.join("; ")}`);
  }
  return {
    poolId: poolRow.poolId,
    seasonId: poolRow.seasonId,
    state,
    rawQuotes: quotes.raw,
    quoteErrors: quotes.errors,
    captureManifest: quotes.captureManifest,
    quoteTeams: teams,
    inputProvenance,
  };
}

async function runEngine(state: MtmState, config: Record<string, any>): Promise<EngineSnapshot> {
  const dir = await mkdtemp(resolve(tmpdir(), "calcutta-mtm-"));
  const statePath = resolve(dir, "state.json");
  const outPath = resolve(dir, "snapshot.json");
  const configPath = resolve(dir, "effective-config.json");
  try {
    await writeFile(statePath, JSON.stringify(state), "utf8");
    await writeFile(configPath, JSON.stringify(config), "utf8");
    const interval = selectedMtmPolicy(config) === INTERVAL_POLICY;
    await execFileAsync(
      interval ? "uv" : "python3",
      [...(interval ? ["run", "--frozen", "--project", WORKSPACE_ROOT, "python"] : []),
        "run_mtm.py", "--config", configPath, "--state", statePath, "--out", outPath],
      { cwd: ENGINE_DIR, timeout: ENGINE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PYTHONHASHSEED: "0" } },
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
    ], { cwd: ENGINE_DIR, timeout: ENGINE_TIMEOUT_MS });
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
  const activationPolicy = config.review_activation &&
    typeof config.review_activation === "object"
    ? config.review_activation as Record<string, unknown>
    : {};
  const activationPolicyVersion = String(
    activationPolicy.policy_version ?? "unconfigured",
  );
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
    activationPolicy: {
      policyVersion: activationPolicyVersion,
      enabled: activationPolicy.enabled === true,
      decision: activationPolicy.decision ?? "unconfigured",
      requiresExplicitApproval: activationPolicy.requires_explicit_approval !== false,
    },
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
  const { seasonId, state, rawQuotes, quoteErrors, quoteTeams, inputProvenance, captureManifest } = exported;
  const evidencePreflightAt = new Date();
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
  const resolvedQuoteSet = await resolvePipelineQuotes(
    snapshotId, poolId, seasonId, config, rawQuotes, quoteTeams, quoteErrors, evidencePreflightAt,
  );
  const resolvedQuotes = resolvedQuoteSet.quotes;
  if (resolvedQuotes.length) {
    await db.insert(mtmMarketQuoteTable).values(
      buildMarketQuoteRows(snapshotId, resolvedQuotes, evidencePreflightAt),
    );
  }
  if (resolvedQuoteSet.unavailable.length) {
    const error = `MTM reference coverage is incomplete for ${resolvedQuoteSet.unavailable.length} contract(s).`;
    const diagnostics = {
      ...baseDiagnostics, quoteErrors,
      referenceResolution: { status: "incomplete", unavailable: resolvedQuoteSet.unavailable },
      reviewStatus: "failed",
    };
    await db.update(mtmSnapshotTable).set({ error, diagnostics }).where(eq(mtmSnapshotTable.id, snapshotId));
    return { id: snapshotId, poolId, status: "review", error, diagnostics };
  }
  let diagnostics: Record<string, unknown> = { ...baseDiagnostics };
  try {
    const derived = deriveQuoteState(config, quoteTeams, resolvedQuotes, evidencePreflightAt);
    state.market_evidence_review = buildMarketEvidenceReview(resolvedQuotes, evidencePreflightAt);
    state.win_ladders = derived.winLadders;
    state.elimination_quotes = derived.elimination;
    // The supported review endpoint supplies the same validated evidence
    // contract as the canonical exporter, plus deterministic group caps.
    // run_mtm_v3 consumes these only in its explicitly noncanonical path.
    const jointFitConstraints = buildJointFitConstraints(
      resolvedQuotes,
      (config.joint_fit_group_caps ?? config.prototype_review?.joint_fit_group_caps ?? {}) as Record<string, number>,
      evidencePreflightAt,
    );
    state.joint_fit_constraints = jointFitConstraints;
    state.joint_fit_group_caps = Object.fromEntries(
      [...new Set(jointFitConstraints.map((row) => String(row.group)))]
        .sort()
        .map((group) => [
          group,
          Math.min(...jointFitConstraints
            .filter((row) => String(row.group) === group)
            .map((row) => Number(row.group_cap))),
        ]),
    );
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

function normalizeEngineValuationPayouts(engine: EngineSnapshot, state: MtmState): string | null {
  // A failed engine has no payout set to round. Preserve its original error
  // rather than turning absent valuations into a misleading pool discrepancy.
  if (engine.status !== "ok") return engine.error ?? "MTM engine failed.";
  try {
    const allocated = allocateMtmPoolCents(
      (engine.valuations ?? []).map((valuation) => ({
        entryId: Number(valuation.entry_id),
        value: Number(valuation.expected_payout),
      })),
      state.pot,
    );
    for (const valuation of engine.valuations ?? []) {
      valuation.expected_payout = allocated.get(Number(valuation.entry_id));
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function finalEffectiveSampleSize(engine: EngineSnapshot): number | null {
  const diagnostics = engine.diagnostics ?? {};
  const simulation = diagnostics.simulation;
  const candidates = [
    simulation && typeof simulation === "object"
      ? (simulation as Record<string, unknown>).effective_sample_size
      : null,
    diagnostics.effective_sample_size,
    diagnostics.effectiveSampleSize,
  ];
  const value = candidates.map((candidate) => Number(candidate))
    .find((candidate) => Number.isFinite(candidate) && candidate > 0);
  return value == null ? null : value;
}

/**
 * Check the final, weighted win-market calibration after the engine has
 * produced its paths.  The engine's prefit diagnostics are intentionally not
 * used as the publication decision: posterior_probability is the final
 * simulated probability and target_probability is the market target.
 */
function achievedProbability(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && value.trim() === "")) return Number.NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1
    ? numeric : Number.NaN;
}

function validateFinalWinMarketQuality(
  engine: EngineSnapshot,
  state: MtmState,
  config: Record<string, any>,
  quality: Record<string, WinMarketQuality>,
): {
  error: string | null;
  diagnostics: Record<string, unknown>;
  effectiveSampleSize: number | null;
} {
  const tolerance = asNumber(config.sim?.calibration_tolerance, 0.03);
  const calibration = engine.calibration
    ?? engine.calibration_metrics
    ?? ((engine.diagnostics?.market_calibration as Record<string, unknown> | undefined)
      ?.metrics as Array<Record<string, unknown>> | undefined)
    ?? [];
  const winMetrics = calibration.filter((metric) =>
    String(metric.metric ?? metric.metric_key ?? metric.metricKey) === "remaining_win_probability",
  );
  const projectionTeams = Object.keys(state.realized);
  const rows = winMetrics.map((metric) => {
    const team = String(metric.team ?? "");
    const metadata = metric.sample_metadata ?? metric.sampleMetadata;
    const finalProbability = metadata && typeof metadata === "object"
      ? achievedProbability((metadata as Record<string, unknown>).posterior_probability)
      : Number.NaN;
    // Projections can contain the raw target: they are not evidence of an
    // achieved posterior. Missing final measurements must fail closed.
    const targetProbability = achievedProbability(metric.target_probability);
    const evidence = quality[team];
    // Weight by trusted market evidence, never by a wide/empty book.  The
    // quality gate below still requires every team to have enough evidence.
    const weight = evidence?.trustedRungs ?? 0;
    const residual = finalProbability - targetProbability;
    return {
      team,
      target_probability: targetProbability,
      final_probability: finalProbability,
      residual,
      tolerance,
      gate_result: Number.isFinite(targetProbability) &&
        Number.isFinite(finalProbability) &&
        Math.abs(residual) <= tolerance ? "passed" : "failed",
      weight,
      quality_status: evidence?.status ?? "missing",
      wide_rungs: evidence?.wideRungs ?? 0,
      missing_rungs: evidence?.missingRungs ?? 0,
    };
  });
  const usableRows = rows.filter((row) =>
    projectionTeams.includes(row.team) &&
    Number.isFinite(row.target_probability) &&
    Number.isFinite(row.final_probability) &&
    row.weight > 0,
  );
  const weightTotal = usableRows.reduce((sum, row) => sum + row.weight, 0);
  const weightedAbsoluteResidual = weightTotal
    ? usableRows.reduce((sum, row) => sum + row.weight * Math.abs(row.residual), 0) / weightTotal
    : Number.POSITIVE_INFINITY;
  const maxAbsoluteResidual = usableRows.reduce(
    (maximum, row) => Math.max(maximum, Math.abs(row.residual)),
    0,
  );
  const finalEss = finalEffectiveSampleSize(engine);
  const duplicateTeams = [...new Set(winMetrics.map((metric) => String(metric.team ?? ""))
    .filter((team, index, all) => team && all.indexOf(team) !== index))].sort();
  const weakTeams = projectionTeams.filter((team) => quality[team]?.status !== "good");
  const missingTeams = projectionTeams.filter((team) =>
    !usableRows.some((row) => row.team === team),
  );
  const offendingRows = usableRows
    .filter((row) => Math.abs(row.residual) > tolerance)
    .map((row) => ({ team: row.team, residual: row.residual }));
  const failed = weakTeams.length > 0 || missingTeams.length > 0 ||
    duplicateTeams.length > 0 || usableRows.length !== projectionTeams.length ||
    !finalEss || weightedAbsoluteResidual > tolerance || maxAbsoluteResidual > tolerance;
  const diagnostics = {
    status: failed ? "failed" : "good",
    gate_result: failed ? "failed" : "passed",
    tolerance,
    rows,
    weighted_absolute_residual: Number.isFinite(weightedAbsoluteResidual)
      ? weightedAbsoluteResidual
      : null,
    max_absolute_residual: maxAbsoluteResidual,
    weight_total: weightTotal,
    weak_teams: weakTeams,
    missing_teams: missingTeams,
    duplicate_teams: duplicateTeams,
    offending_teams: offendingRows,
    final_effective_sample_size: finalEss,
  };
  let error: string | null = null;
  if (weakTeams.length) {
    error = `Final win-market quality is weak for ${weakTeams.join(", ")}.`;
  } else if (duplicateTeams.length) {
    error = `Final win-market quality has duplicate team metrics for ${duplicateTeams.join(", ")}.`;
  } else if (missingTeams.length || usableRows.length !== projectionTeams.length) {
    error = "Final win-market quality is missing one or more team targets.";
  } else if (!finalEss) {
    error = "Final simulation effective sample size is missing.";
  } else if (weightedAbsoluteResidual > tolerance) {
    error = `Final weighted win-market residual ${weightedAbsoluteResidual.toFixed(6)} exceeds ${tolerance.toFixed(6)}.`;
  } else if (maxAbsoluteResidual > tolerance) {
    error = `Final maximum win-market residual ${maxAbsoluteResidual.toFixed(6)} exceeds ${tolerance.toFixed(6)} for ${offendingRows.map((row) => row.team).join(", ")}.`;
  }
  return { error, diagnostics, effectiveSampleSize: finalEss };
}

const PAYOUT_DRIVING_PLAYOFF_FAMILIES = [
  "berth",
  "divisional",
  "conference",
  "sb_berth",
  "sb_win",
] as const;

const MTM_DIAGNOSTIC_POLICY_VERSION = "mtm-diagnostics-v2";

function withoutIncidentalTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIncidentalTimestamps);
  if (!value || typeof value !== "object") return value;
  const ignored = new Set([
    "fetched_at", "fetchedAt", "captured_at", "capturedAt", "updated_time",
    "updatedTime", "last_updated", "lastUpdated", "observedAt", "sourceObservedAt",
  ]);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !ignored.has(key))
    .map(([key, item]) => [key, withoutIncidentalTimestamps(item)]));
}

function buildRunInformation(args: {
  config: Record<string, any>;
  state: MtmState;
  inputProvenance: MtmInputProvenance;
  rawQuotes: RawMarketQuote[];
}) {
  const sim = args.config.sim ?? {};
  const hash = (value: unknown) =>
    createHash("sha256").update(canonicalJson(value)).digest("hex");
  const meaningfulInputs = {
    state: withoutIncidentalTimestamps(args.state),
    quotes: args.rawQuotes.map((quote) => ({
      series: quote.series,
      team: quote.team,
      ticker: quote.market.ticker,
      market: withoutIncidentalTimestamps(quote.market),
    })),
  };
  return {
    diagnostic_policy_version: MTM_DIAGNOSTIC_POLICY_VERSION,
    requested: {
      seed: sim.seed == null ? null : Math.trunc(Number(sim.seed)),
      path_count: sim.monte_carlo_runs == null ? null : Math.trunc(Number(sim.monte_carlo_runs)),
      engine: String(sim.model ?? "seeded_monte_carlo"),
      executable: "run_mtm.py",
      pricing_policy: selectedMtmPolicy(args.config),
    },
    confirmed: null,
    effective_configuration_hash: hash(args.config),
    effective_configuration: JSON.parse(JSON.stringify(args.config)),
    input_provenance_identity: hash(withoutIncidentalTimestamps(args.inputProvenance)),
    meaningful_model_inputs_hash: hash(meaningfulInputs),
  };
}

function compactCandidateDiagnostics(engine: EngineSnapshot) {
  return {
    path_count: engine.path_count ?? null,
    seed: engine.model?.seed ?? null,
    model: engine.model?.name ?? null,
    effective_sample_size: finalEffectiveSampleSize(engine),
    maximum_path_weight: [
      (engine.diagnostics?.simulation as Record<string, unknown> | undefined)?.max_weight,
      (engine.diagnostics?.monte_carlo_sampling as Record<string, unknown> | undefined)?.max_weight,
    ].map(Number).find(Number.isFinite) ?? null,
    rating_fit: engine.diagnostics?.rating_fit ?? null,
    stage_timings: (engine.diagnostics?.runtime as Record<string, unknown> | undefined)?.stages ?? null,
    final_weighted_calibration: engine.calibration ?? engine.calibration_metrics ??
      (engine.diagnostics?.market_calibration as Record<string, unknown> | undefined)?.metrics ?? [],
    projections: Object.fromEntries(Object.entries(engine.projections ?? {}).map(([team, projection]) => [
      team,
      {
        e_remaining_wins: projection.e_remaining_wins ?? null,
        p_stage: projection.p_stage ?? null,
        rating: projection.rating ?? null,
      },
    ])),
  };
}

function validateFinalPlayoffMarketQuality(
  engine: EngineSnapshot,
  state: MtmState,
  config: Record<string, any>,
): {
  error: string | null;
  diagnostics: Record<string, unknown>;
} {
  const identityError = validateMtmPolicyIdentity(engine, config);
  if (identityError) return { error: identityError, diagnostics: { status: "failed", gate_result: "failed" } };
  if (selectedMtmPolicy(config) === INTERVAL_POLICY) return validateFinalIntervalMarketQuality(engine, state, config);
  const defaultTolerance = asNumber(config.sim?.calibration_tolerance, 0.03);
  const calibration = engine.calibration
    ?? engine.calibration_metrics
    ?? ((engine.diagnostics?.market_calibration as Record<string, unknown> | undefined)
      ?.metrics as Array<Record<string, unknown>> | undefined)
    ?? [];
  const projectionTeams = Object.keys(state.realized);
  const families = Object.fromEntries(PAYOUT_DRIVING_PLAYOFF_FAMILIES.map((family) => {
    const rows = projectionTeams.map((team) => {
      const matchingMetrics = calibration.filter((candidate) =>
        String(candidate.metric ?? candidate.metric_key ?? candidate.metricKey) === family &&
        String(candidate.team ?? "") === team);
      const metric = matchingMetrics.length === 1 ? matchingMetrics[0] : null;
      const targetProbability = achievedProbability(metric?.target_probability);
      const finalProbability = achievedProbability(metric?.simulated_probability);
      const configuredTolerance = Number(metric?.tolerance);
      const tolerance = Number.isFinite(configuredTolerance) && configuredTolerance >= 0
        ? Math.min(configuredTolerance, defaultTolerance)
        : defaultTolerance;
      const residual = finalProbability - targetProbability;
      const present = matchingMetrics.length === 1 &&
        Number.isFinite(targetProbability) &&
        Number.isFinite(finalProbability) &&
        Number.isFinite(tolerance);
      return {
        team,
        target_probability: Number.isFinite(targetProbability) ? targetProbability : null,
        final_probability: Number.isFinite(finalProbability) ? finalProbability : null,
        residual: present ? residual : null,
        tolerance,
        gate_result: present && Math.abs(residual) <= tolerance ? "passed" : "failed",
        metric_count: matchingMetrics.length,
      };
    });
    const missingTeams = rows.filter((row) =>
      row.metric_count === 0 || (row.metric_count === 1 && row.residual == null)
    ).map((row) => row.team);
    const duplicateTeams = rows.filter((row) => row.metric_count > 1).map((row) => row.team);
    const failedTeams = rows.filter((row) =>
      row.residual != null && Math.abs(row.residual) > row.tolerance).map((row) => row.team);
    const maxAbsoluteResidual = rows.reduce((maximum, row) =>
      row.residual == null ? maximum : Math.max(maximum, Math.abs(row.residual)), 0);
    return [family, {
      gate_result: missingTeams.length || duplicateTeams.length || failedTeams.length ? "failed" : "passed",
      tolerance: defaultTolerance,
      max_absolute_residual: maxAbsoluteResidual,
      missing_teams: missingTeams,
      duplicate_teams: duplicateTeams,
      failed_teams: failedTeams,
      rows,
    }];
  }));
  const missingFamilies = PAYOUT_DRIVING_PLAYOFF_FAMILIES.filter((family) =>
    (families[family] as Record<string, unknown>).gate_result === "failed" &&
    ((families[family] as Record<string, unknown>).missing_teams as string[]).length > 0);
  const failedFamilies = PAYOUT_DRIVING_PLAYOFF_FAMILIES.filter((family) =>
    (families[family] as Record<string, unknown>).gate_result === "failed" &&
    ((families[family] as Record<string, unknown>).failed_teams as string[]).length > 0);
  const duplicateFamilies = PAYOUT_DRIVING_PLAYOFF_FAMILIES.filter((family) =>
    ((families[family] as Record<string, unknown>).duplicate_teams as string[]).length > 0);
  const diagnostics = {
    status: missingFamilies.length || duplicateFamilies.length || failedFamilies.length ? "failed" : "good",
    gate_result: missingFamilies.length || duplicateFamilies.length || failedFamilies.length ? "failed" : "passed",
    required_families: PAYOUT_DRIVING_PLAYOFF_FAMILIES,
    families,
  };
  let error: string | null = null;
  if (missingFamilies.length) {
    error = `Final playoff-market calibration is missing targets for ${missingFamilies.join(", ")}.`;
  } else if (duplicateFamilies.length) {
    error = `Final playoff-market calibration has duplicate metrics for ${duplicateFamilies.join(", ")}.`;
  } else if (failedFamilies.length) {
    error = `Final playoff-market calibration exceeds tolerance for ${failedFamilies.join(", ")}.`;
  }
  return { error, diagnostics };
}

function validateFinalPublicationQuality(
  engine: EngineSnapshot,
  config: Record<string, any>,
  rawQuotes: RawMarketQuote[],
  captureManifest?: InternalCaptureManifest | null,
  inputEvaluationTime: Date = latestQuoteCapture(rawQuotes),
  publicationEvaluationTime: Date = inputEvaluationTime,
): { error: string | null; audit: Record<string, unknown> } {
  const settings = (config.prototype_review ?? {}) as Record<string, unknown>;
  const pathCount = Number(engine.path_count);
  const finalEss = finalEffectiveSampleSize(engine);
  const minEss = Math.max(
    asNumber(settings.min_global_ess, 1000),
    Number.isFinite(pathCount) ? pathCount * asNumber(settings.min_ess_fraction, 0.05) : 1000,
  );
  const reasons: string[] = [];
  const providerManifests = rawQuotes
    .map((quote) => quote.completenessManifest)
    .filter((manifest): manifest is Record<string, unknown> => manifest != null);
  const providerManifestComplete = providerManifests.length === 0
    ? null
    : providerManifests.every((manifest) =>
      manifest.complete === true ||
      (Number.isFinite(Number(manifest.expected)) &&
        Number.isFinite(Number(manifest.received)) &&
        Number(manifest.expected) === Number(manifest.received)) ||
      (Number.isFinite(Number(manifest.expected_markets)) &&
        Number.isFinite(Number(manifest.received_markets)) &&
        Number(manifest.expected_markets) === Number(manifest.received_markets)),
    );
  // A newly generated canonical candidate is never allowed to promote
  // without a capture manifest.  The legacy pointer is read separately and
  // remains available/stale when this candidate is rejected.
  const requireManifest = settings.require_complete_capture_manifest !== false;
  const completeManifest = captureManifest?.complete === true;
  if (requireManifest && !completeManifest) {
    reasons.push(captureManifest == null
      ? "internal capture manifest is unavailable"
      : "internal capture manifest is incomplete");
  }

  const evidenceRows = rawQuotes.flatMap((quote) => {
    const strike = Number(quote.market.floor_strike ?? quote.market.floor_strike_fp);
    const transformation = Number.isInteger(strike) && strike >= 1 && strike <= 17
      ? "bounds" as const
      : "bid_plus_cent" as const;
    const inputDecision = quoteDecisionForPipeline(
      quote,
      inputEvaluationTime,
      transformation,
      asNumber(config.pricing?.max_spread_for_mid, 0.15),
    );
    if (!inputDecision.usedInFitting) return [];
    const finalDecision = quoteDecisionForPipeline(
      quote,
      publicationEvaluationTime,
      transformation,
      asNumber(config.pricing?.max_spread_for_mid, 0.15),
    );
    const assessment = finalDecision.assessment;
    const activePrice = inputDecision.role === "active_price";
    return {
      qualityStatus: assessment.qualityStatus,
      freshness: assessment.factors.freshness,
      metadata: assessment.factors.metadata,
      activePrice,
      stale: activePrice && (
        finalDecision.exclusionReasons.includes("active price is stale") ||
        finalDecision.exclusionReasons.includes("capture timestamp is in the future")
      ),
      provider: evidenceInputForQuote(quote).provider?.provider ?? null,
    };
  });
  const activeEvidenceRows = evidenceRows.filter((row) => row.activePrice);
  const freshnessStatus = evidenceRows.length === 0
    ? "not_available"
    : activeEvidenceRows.some((row) => row.stale || row.freshness === 0)
      ? "failed"
      : activeEvidenceRows.some((row) => row.freshness == null)
        ? "not_available"
        : "good";
  const metadataStatus = evidenceRows.length === 0
    ? "not_available"
    : evidenceRows.some((row) => !row.provider || row.metadata <= 0)
      ? "failed"
      : "good";
  if (freshnessStatus === "failed") reasons.push("market evidence is stale");
  if (metadataStatus === "failed") reasons.push("market evidence metadata is incomplete");

  const essStatus = finalEss == null
    ? "not_available"
    : finalEss >= minEss ? "good" : "failed";
  if (essStatus === "failed") {
    reasons.push(`global ESS ${finalEss!.toFixed(2)} is below ${minEss.toFixed(2)}`);
  } else if (essStatus === "not_available") {
    reasons.push("global ESS diagnostic is unavailable");
  }

  const simulation = engine.diagnostics?.simulation;
  const simDiagnostics = simulation && typeof simulation === "object"
    ? simulation as Record<string, unknown> : {};
  const monteCarlo = engine.diagnostics?.monte_carlo_sampling;
  const monteCarloDiagnostics = monteCarlo && typeof monteCarlo === "object"
    ? monteCarlo as Record<string, unknown> : {};
  const maxWeightValue = [
    simDiagnostics.max_weight,
    simDiagnostics.weight_max,
    monteCarloDiagnostics.max_weight,
    engine.diagnostics?.max_weight,
  ].map(Number).find((value) => Number.isFinite(value));
  const maxWeightLimit = asNumber(settings.max_weight, 0.01);
  const maxWeightStatus = maxWeightValue == null
    ? "not_available"
    : maxWeightValue <= maxWeightLimit ? "good" : "failed";
  if (maxWeightStatus === "failed") {
    reasons.push(`maximum path weight ${maxWeightValue!.toFixed(6)} exceeds ${maxWeightLimit.toFixed(6)}`);
  }

  const reviewGates = engine.diagnostics?.review_gates;
  const reviewChecks = reviewGates && typeof reviewGates === "object"
    ? (reviewGates as Record<string, unknown>).checks : null;
  const reviewCheck = (name: string): "good" | "failed" | "not_available" => {
    if (!reviewChecks || typeof reviewChecks !== "object" ||
        !(name in (reviewChecks as Record<string, unknown>))) return "not_available";
    return (reviewChecks as Record<string, unknown>)[name] === true ? "good" : "failed";
  };
  const explicitDiagnosticStatus = (name: string): "good" | "failed" | "not_available" => {
    const candidates = [
      engine.diagnostics?.[name],
      (engine.diagnostics?.review as Record<string, unknown> | undefined)?.[name],
      simDiagnostics[name],
    ];
    const candidate = candidates.find((value) => value != null);
    if (candidate == null) return "not_available";
    if (typeof candidate === "boolean") return candidate ? "good" : "failed";
    if (typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      if (record.passed != null) return record.passed === true ? "good" : "failed";
      if (record.status != null) return ["good", "ok", "passed"].includes(String(record.status).toLowerCase()) ? "good" : "failed";
      if (Array.isArray(record.failures) || Array.isArray(record.unresolved_targets)) {
        return (record.failures as unknown[] | undefined)?.length ||
          (record.unresolved_targets as unknown[] | undefined)?.length ? "failed" : "good";
      }
    }
    return "not_available";
  };
  const precisionStatus = reviewCheck("precision") === "not_available"
    ? explicitDiagnosticStatus("precision") : reviewCheck("precision");
  const supportStatus = reviewCheck("support") === "not_available"
    ? (() => {
        const explicit = explicitDiagnosticStatus("support");
        if (explicit !== "not_available") return explicit;
        const support = simDiagnostics.support_sampling;
        if (!support || typeof support !== "object") return "not_available" as const;
        const unresolved = (support as Record<string, unknown>).unresolved_targets;
        return Array.isArray(unresolved) && unresolved.length > 0 ? "failed" as const : "good" as const;
      })()
    : reviewCheck("support");
  const requirePrecisionSupport = settings.require_precision_support === true ||
    settings.require_review_diagnostics === true || reviewGates != null;
  if (freshnessStatus === "not_available") reasons.push("freshness diagnostic is unavailable");
  if (metadataStatus === "not_available") reasons.push("metadata diagnostic is unavailable");
  if (maxWeightStatus === "not_available") reasons.push("maximum path weight diagnostic is unavailable");
  if (precisionStatus === "not_available" && requirePrecisionSupport) {
    reasons.push("precision diagnostic is unavailable");
  }
  if (supportStatus === "not_available" && requirePrecisionSupport) {
    reasons.push("support diagnostic is unavailable");
  }
  if (precisionStatus === "failed" && requirePrecisionSupport) reasons.push("precision review diagnostic failed");
  if (supportStatus === "failed" && requirePrecisionSupport) reasons.push("simulation support diagnostic failed");

  const missingDiagnostics = [
    !completeManifest ? "capture_manifest" : null,
    freshnessStatus === "not_available" ? "freshness" : null,
    metadataStatus === "not_available" ? "metadata" : null,
    maxWeightStatus === "not_available" ? "max_weight" : null,
    precisionStatus === "not_available" ? "precision" : null,
    supportStatus === "not_available" ? "support" : null,
  ].filter((value): value is string => value != null);
  const gateResults = {
    capture_completeness: completeManifest === true ? "passed" : "failed",
    freshness: freshnessStatus === "good" ? "passed" : freshnessStatus === "failed" ? "failed" : "missing",
    metadata: metadataStatus === "good" ? "passed" : metadataStatus === "failed" ? "failed" : "missing",
    final_ess: essStatus === "good" ? "passed" : "failed",
    max_weight: maxWeightStatus === "good" ? "passed" : "failed",
    precision: !requirePrecisionSupport && precisionStatus === "not_available"
      ? "not_applicable"
      : precisionStatus === "good" ? "passed" : precisionStatus === "failed" ? "failed" : "missing",
    support: !requirePrecisionSupport && supportStatus === "not_available"
      ? "not_applicable"
      : supportStatus === "good" ? "passed" : supportStatus === "failed" ? "failed" : "missing",
    win_market_quality: "passed",
  };
  const audit: Record<string, unknown> = {
    policy_version: MTM_EVIDENCE_POLICY_VERSION,
    status: reasons.length ? "failed" : "good",
    publication_decision: reasons.length ? "blocked" : "approved",
    gate_results: gateResults,
    gate_reasons: reasons,
    final_ess: { status: essStatus, value: finalEss, minimum: minEss, path_count: pathCount },
    final_effective_sample_size: finalEss,
    max_weight: { status: maxWeightStatus, value: maxWeightValue ?? null, maximum: maxWeightLimit },
    precision: precisionStatus,
    support: supportStatus,
    calibration: { status: "good" },
    evidence_completeness: {
      status: completeManifest === true ? "complete" : "incomplete",
      request_count: captureManifest?.expected_request_count ?? 0,
      fulfilled_request_count: captureManifest?.fulfilled_request_count ?? 0,
      failed_request_count: captureManifest?.failed_request_count ?? 0,
      nonempty_request_count: captureManifest?.nonempty_request_count ?? 0,
      requests: captureManifest?.requests ?? [],
      provider_manifest_count: providerManifests.length,
      provider_manifest_status: providerManifestComplete == null
        ? "not_available" : providerManifestComplete ? "complete" : "incomplete",
    },
    missing_diagnostics: missingDiagnostics,
  };
  return {
    error: reasons.length ? `Final publication quality failed: ${reasons.join("; ")}.` : null,
    audit,
  };
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

function quoteTimestamp(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function latestQuoteCapture(rawQuotes: RawMarketQuote[]): Date {
  return rawQuotes.reduce<Date | null>((latest, quote) =>
    quote.fetchedAt && (!latest || quote.fetchedAt > latest) ? quote.fetchedAt : latest, null
  ) ?? new Date(0);
}

function evidenceStatus(market: Record<string, unknown>): MtmEvidenceInput["status"] {
  const status = String(market.status ?? "").trim().toLowerCase();
  const outcome = String(market.result ?? "").trim().toLowerCase();
  if (["yes", "no", "void"].includes(outcome) ||
      ["closed", "determined", "finalized", "settled"].includes(status)) return "settled";
  if (["active", "open", "initialized"].includes(status)) return "active";
  if (["paused", "suspended"].includes(status)) return "suspended";
  return "unknown";
}

function evidenceInputForQuote(quote: RawMarketQuote): MtmEvidenceInput {
  const market = quote.market;
  const status = evidenceStatus(market);
  const result = String(market.result ?? "").trim().toLowerCase();
  const configuredGroup = market.evidence_group ?? market.evidenceGroup;
  const evidenceGroup = typeof configuredGroup === "string"
    ? configuredGroup
    : configuredGroup && typeof configuredGroup === "object"
      ? configuredGroup as MtmEvidenceInput["evidenceGroup"]
      : {
          id: `kalshi:${quote.series}:${quote.team}`,
          cap: 0.5,
          label: `${quote.series}/${quote.team}`,
        };
  const depth = market.depth && typeof market.depth === "object"
    ? market.depth as Record<string, unknown>
    : (market.yes_bid_size != null || market.yes_ask_size != null
      ? { bid: Number(market.yes_bid_size), ask: Number(market.yes_ask_size) }
      : null);
  const rawTrades = Array.isArray(market.trades) ? market.trades : null;
  const trades = rawTrades?.every((trade) =>
    trade && typeof trade === "object" && typeof trade.id === "string" &&
    Number.isFinite(Number(trade.price))
  ) ? rawTrades.map((trade) => ({
    id: String(trade.id),
    price: Number(trade.price),
    size: trade.size == null ? null : Number(trade.size),
    timestamp: trade.timestamp == null ? null : String(trade.timestamp),
  })) : null;
  return {
    id: String(market.observation_id ?? market.observationId ?? market.id ?? market.ticker),
    yesBid: quoteValue(market, "yes_bid"),
    yesAsk: quoteValue(market, "yes_ask"),
    status,
    settlement: ["yes", "no", "void"].includes(result)
      ? result as "yes" | "no" | "void"
      : null,
    depth: depth as MtmEvidenceInput["depth"],
    observedAt: quote.fetchedAt?.toISOString() ?? null,
    fetchedAt: quote.fetchedAt?.toISOString() ?? null,
    provider: {
      provider: "kalshi",
      sourceId: String(market.event_ticker ?? market.eventTicker ?? quote.series),
      sourceUrl: quote.sourceUrl ?? null,
    },
    evidenceGroup,
    materialEvent: market.material_event && typeof market.material_event === "object"
      ? market.material_event as MtmEvidenceInput["materialEvent"]
      : null,
    metadata: quote.captureMetadata ?? null,
    trades,
  };
}

function buildMarketEvidenceReview(rawQuotes: RawMarketQuote[], evaluationTime: Date) {
  return {
    schema_version: "market-policy-input-v1",
    evaluation_time: evaluationTime.toISOString(),
    review_only: true,
    rows: rawQuotes.map((quote) => {
      try {
      const evidence = evidenceInputForQuote(quote);
      const strike = Number(quote.market.floor_strike ?? quote.market.floor_strike_fp);
      const isWin = Number.isInteger(strike) && strike >= 1 && strike <= 17;
      const decision = quoteDecisionForPipeline(quote, evaluationTime, isWin ? "bounds" : "bid_plus_cent");
      return {
        id: String(quote.market.ticker ?? evidence.id), team: quote.team,
        family: isWin ? "wins" : "elimination",
        outcome: isWin ? String(strike) : classifyEliminationMarket(quote.market),
        eligible: decision.usedInFitting, resolved: decision.role === "settlement_fact",
        bounds: decision.assessment.acceptedBounds,
        score: decision.assessment.score,
        exclusion_reasons: decision.exclusionReasons,
        captured_at: evidence.observedAt,
        material_event_at: evidence.materialEvent?.occurredAt ?? null,
        depth: evidence.depth ?? null,
        trades: evidence.trades ?? [],
        // A bare last price has no verified execution time/size. The shadow
        // policy records it but cannot promote it to a qualifying trade.
        last_price: quoteValue(quote.market, "last_price"),
        evidence_policy_version: decision.assessment.policyVersion,
      };
      } catch (error) {
        return { id: String(quote.market.ticker ?? "unknown"), team: quote.team,
          eligible: false, capture_error: error instanceof Error ? error.message : String(error) };
      }
    }),
  };
}

function quoteDecisionForPipeline(
  quote: RawMarketQuote,
  evaluationTime: Date,
  transformation: "bounds" | "bid_plus_cent",
  maxSpread?: number,
) {
  const market = quote.market;
  const metadataUpdatedAt = quoteTimestamp(
    market.updated_time ?? market.updatedTime ?? market.last_updated ?? market.lastUpdated,
  );
  return canonicalQuoteDecision({
    evidence: evidenceInputForQuote(quote),
    ticker: String(market.ticker ?? ""),
    evaluationTime,
    transformation,
    maxSpread,
    metadataUpdatedAt: metadataUpdatedAt?.toISOString() ?? null,
  });
}

function buildMarketQuoteRows(
  snapshotId: number,
  rawQuotes: RawMarketQuote[],
  evaluationTime?: Date,
) {
  return rawQuotes.map((quote) => {
    const { series, team, market } = quote;
    const resolvedReference = quote.resolvedReference;
    const sourceUrl = quote.sourceUrl ??
      (resolvedReference?.selectionMethod === "carried_forward"
        ? `retained://mtm/${resolvedReference.referenceSourceSnapshotId ?? "unknown"}`
        : resolvedReference?.selectionMethod === "unavailable" ? "unavailable://mtm" : null);
    const fetchedAt = quote.fetchedAt ??
      (resolvedReference?.timestamps.fetchedAt ? new Date(resolvedReference.timestamps.fetchedAt) : evaluationTime ?? null);
    if (!sourceUrl || !fetchedAt) {
      throw new Error(`Missing capture-time provenance for Kalshi market ${String(market.ticker)}.`);
    }
    const evidence = evidenceInputForQuote(quote);
    const strike = Number(market.floor_strike ?? market.floor_strike_fp);
    const decision = quoteDecisionForPipeline(
      quote,
      evaluationTime ?? fetchedAt,
      Number.isInteger(strike) && strike >= 1 && strike <= 17 ? "bounds" : "bid_plus_cent",
    );
    const assessment = decision.assessment;
    const bounds = acceptedYesBounds(evidence);
    const tradeEstimate = estimateMtmTrades(evidence);
    const status = evidenceStatus(market);
    const result = String(market.result ?? "").trim().toLowerCase();
    const sourceObservedAt = quoteTimestamp(
      market.updated_time ?? market.updatedTime ?? market.last_updated ?? market.lastUpdated,
    );
    const completenessManifest = quote.completenessManifest
      ?? (market.completeness_manifest && typeof market.completeness_manifest === "object"
        ? market.completeness_manifest as Record<string, unknown>
        : market.completenessManifest && typeof market.completenessManifest === "object"
          ? market.completenessManifest as Record<string, unknown>
          : null);
    const reference = selectReferenceMark({
      ...market,
      provider: "kalshi",
      ticker: String(market.ticker),
      eventId: market.event_id == null && market.eventId == null
        ? null
        : String(market.event_id ?? market.eventId),
      fetchedAt: fetchedAt.toISOString(),
      observedAt: sourceObservedAt?.toISOString() ?? null,
    });
    const resolved = quote.resolvedReference ?? {
      referencePrice: reference.referencePrice,
      selectionMethod: reference.selectionMethod,
      selectionReason: reference.reasons,
      referenceAcceptedAt: reference.referencePrice == null ? null : fetchedAt.toISOString(),
      referenceSourceSnapshotId: snapshotId,
      referenceSourceTicker: String(market.ticker),
      referencePolicyVersion: reference.policyVersion,
      fetchOutcome: "fulfilled" as const,
      lastPrice: reference.normalized.last,
      key: {} as ReferenceContractKey,
      source: reference.source,
      timestamps: reference.timestamps,
    };
    return {
      snapshotId,
      source: "kalshi",
      sourceUrl,
      series,
      marketTicker: String(market.ticker),
      team,
      strike: quoteStrike(market),
      yesBid: quoteValue(market, "yes_bid") == null ? null : String(quoteValue(market, "yes_bid")),
      yesAsk: quoteValue(market, "yes_ask") == null ? null : String(quoteValue(market, "yes_ask")),
      lastPrice: resolved.lastPrice == null ? null : String(resolved.lastPrice),
      referencePrice: resolved.referencePrice == null ? null : String(resolved.referencePrice),
      selectionMethod: resolved.selectionMethod,
      selectionReason: { reasons: resolved.selectionReason },
      referenceAcceptedAt: resolved.referenceAcceptedAt == null ? null : new Date(resolved.referenceAcceptedAt),
      referenceSourceSnapshotId: resolved.referenceSourceSnapshotId,
      referenceSourceTicker: resolved.referenceSourceTicker,
      referencePolicyVersion: resolved.referencePolicyVersion ?? MTM_REFERENCE_MARK_POLICY_VERSION,
      fetchOutcome: resolved.fetchOutcome,
      volume: market.volume_fp == null && market.volume == null ? null : quoteVolume(market),
      fetchedAt,
      rawQuote: market,
      observationId: String(
        market.observation_id ?? market.observationId ?? market.id ?? market.ticker,
      ),
      provider: "kalshi",
      contract: String(market.ticker),
      settlementPredicate: market.settlement_predicate == null
        ? null : String(market.settlement_predicate),
      family: series,
      eventId: Number.isInteger(Number(market.event_id ?? market.eventId))
        ? Number(market.event_id ?? market.eventId) : null,
      sourceObservedAt,
      capturedAt: quote.fetchedAt ? fetchedAt : null,
      normalizedYesBid: evidence.yesBid == null ? null : String(evidence.yesBid),
      normalizedYesAsk: evidence.yesAsk == null ? null : String(evidence.yesAsk),
      depth: evidence.depth == null ? null : evidence.depth as Record<string, unknown>,
      status,
      outcome: ["yes", "no", "void"].includes(result) ? result : null,
      materialEvent: evidence.materialEvent == null ? null : evidence.materialEvent as Record<string, unknown>,
      stateVersion: market.state_version == null && market.stateVersion == null
        ? null : String(market.state_version ?? market.stateVersion),
      qualityReport: {
        role: decision.role,
        usedInFitting: decision.usedInFitting,
        eligibilityExclusionReasons: decision.exclusionReasons,
        transformation: decision.transformation,
        captureTime: decision.captureTime,
        metadataUpdatedAt: decision.metadataUpdatedAt,
        sourceProvenance: decision.sourceProvenance,
        classification: assessment.classification,
        qualityStatus: assessment.qualityStatus,
        score: assessment.score,
        factors: assessment.factors,
        reasons: assessment.reasons,
        exclusionReasons: assessment.exclusionReasons,
        degradationReasons: assessment.degradationReasons,
        acceptedBounds: assessment.acceptedBounds,
        groupId: assessment.groupId,
        policyVersion: assessment.policyVersion,
      },
      qualityPolicyVersion: assessment.policyVersion,
      acceptedLower: String(bounds.lower),
      acceptedUpper: String(bounds.upper),
      tradeEstimate: tradeEstimate.estimate == null ? null : String(tradeEstimate.estimate),
      tradeUncertainty: String(tradeEstimate.uncertainty),
      fallbackIdentity: null,
      fallbackAge: null,
      evidenceGroup: evidence.evidenceGroup == null
        ? null
        : typeof evidence.evidenceGroup === "string"
          ? { id: evidence.evidenceGroup }
          : evidence.evidenceGroup,
      completenessManifest,
      rawMetadata: quote.captureMetadata ?? null,
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
  const pricingPolicy = selectedMtmPolicy(config);
  const methodVersion = pricingPolicy === INTERVAL_POLICY
    ? `${INTERVAL_POLICY}-${config.season}`
    : pricingPolicy === REFERENCE_MARK_POWER_POLICY
      ? `${REFERENCE_MARK_POWER_POLICY}-${config.season}`
      : `frozen-mtm-${config.season}`;
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
  const { poolId, seasonId, state, rawQuotes, quoteErrors, quoteTeams, inputProvenance, captureManifest } = exported;
  const evidencePreflightAt = new Date();
  state.market_evidence_review = buildMarketEvidenceReview(rawQuotes, evidencePreflightAt);
  const snapshot = await db.insert(mtmSnapshotTable).values({
    poolId, asOf: now, asOfHour, trigger: input.trigger, status: "failed", methodVersion,
    stateJson: state,
    inputProvenance,
  }).returning({ id: mtmSnapshotTable.id });
  const snapshotId = snapshot[0]!.id;
  if (input.lease) await input.lease.attachSnapshot(snapshotId);
  const resolvedQuoteSet = await resolvePipelineQuotes(
    snapshotId, poolId, seasonId, config, rawQuotes, quoteTeams, quoteErrors, evidencePreflightAt,
  );
  const resolvedQuotes = resolvedQuoteSet.quotes;
  if (resolvedQuotes.length) {
    await db.insert(mtmMarketQuoteTable).values(
      buildMarketQuoteRows(snapshotId, resolvedQuotes, evidencePreflightAt),
    );
  }
  if (resolvedQuoteSet.unavailable.length > 0) {
    const message = `MTM reference coverage is incomplete for ${resolvedQuoteSet.unavailable.length} contract(s).`;
    const diagnostics = {
      quoteErrors,
      referenceResolution: {
        status: "incomplete",
        unavailable: resolvedQuoteSet.unavailable,
      },
    };
    await db.update(mtmSnapshotTable).set({ error: message, diagnostics }).where(eq(mtmSnapshotTable.id, snapshotId));
    return {
      id: snapshotId, currentSnapshotId: null, poolId, asOf: now.toISOString(),
      currentAsOf: null, status: "failed", error: message, stale: true,
      staleReasons: [message], diagnostics, valuations: [], projections: {},
    };
  }
  try {
    const derivedQuotes = deriveQuoteState(config, quoteTeams, resolvedQuotes, evidencePreflightAt);
    state.win_ladders = derivedQuotes.winLadders;
    state.elimination_quotes = derivedQuotes.elimination;
    state.joint_fit_constraints = buildJointFitConstraints(resolvedQuotes, {}, evidencePreflightAt);
    state.joint_fit_group_caps = Object.fromEntries(
      [...new Set(state.joint_fit_constraints.map((row) => String(row.group)))]
        .sort()
        .map((group) => [group, 0.5]),
    );
    const inputHash = createHash("sha256").update(canonicalJson({
      state,
      inputProvenance,
      quotes: resolvedQuotes.map((quote) => ({
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
    const latestQuoteAt = resolvedQuotes.reduce<Date | null>((latest, quote) =>
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
  const runInformation = buildRunInformation({
    config,
    state,
    inputProvenance,
    rawQuotes,
  });
  await db.update(mtmSnapshotTable).set({
    diagnostics: { run_information: runInformation },
  }).where(eq(mtmSnapshotTable.id, snapshotId));
  const engine = await runEngine(state, config);
  const confirmedRunInformation = {
    ...runInformation,
    confirmed: {
      seed: engine.model?.seed ?? null,
      path_count: engine.path_count ?? null,
      engine: engine.model?.name ?? null,
      pricing_policy: engine.model?.pricing_policy ?? null,
      pricing_basis: engine.model?.pricing_basis ?? null,
    },
  };
  const engineValidationError =
    normalizeEngineValuationPayouts(engine, state) ??
    validateCompleteEngineSnapshot(engine, state);
  if (engineValidationError) {
    const diagnostics = {
      ...(engine.diagnostics ?? {}),
      run_information: confirmedRunInformation,
      candidate: compactCandidateDiagnostics(engine),
      engineError: engineValidationError,
      engine_outcome: { status: engine.status, error: engine.error ?? null },
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
  const publicationCheck = validateFinalPublicationQuality(
    engine,
    config,
    rawQuotes,
    captureManifest,
    evidencePreflightAt,
    new Date(),
  );
  const winMarketCheck = validateFinalWinMarketQuality(
    engine,
    state,
    config,
    assessWinMarketQuality(config, quoteTeams, state.win_ladders),
  );
  const playoffMarketCheck = validateFinalPlayoffMarketQuality(engine, state, config);
  const finalDiagnostics: Record<string, unknown> = {
    ...(engine.diagnostics ?? {}),
    run_information: confirmedRunInformation,
    diagnostic_sets: {
      rating_fit_expectations: engine.diagnostics?.rating_fit ?? null,
      final_weighted_win_probabilities: winMarketCheck.diagnostics,
      final_weighted_playoff_probabilities: playoffMarketCheck.diagnostics,
    },
    candidate: compactCandidateDiagnostics(engine),
    market_quality: winMarketCheck.diagnostics,
    final_effective_sample_size: winMarketCheck.effectiveSampleSize,
    publication_audit: publicationCheck.audit,
  };
  const publicationAudit = finalDiagnostics.publication_audit as Record<string, unknown>;
  const gateResults = publicationAudit.gate_results as Record<string, unknown>;
  const gateReasons = publicationAudit.gate_reasons as string[];
  gateResults.win_market_quality = winMarketCheck.error ? "failed" : "passed";
  gateResults.playoff_market_calibration = playoffMarketCheck.error ? "failed" : "passed";
  publicationAudit.calibration = {
    status: winMarketCheck.error || playoffMarketCheck.error ? "failed" : "good",
    win_market: winMarketCheck.diagnostics,
    playoff_market: playoffMarketCheck.diagnostics,
  };
  if (winMarketCheck.error || playoffMarketCheck.error) {
    if (winMarketCheck.error) gateReasons.push(winMarketCheck.error);
    if (playoffMarketCheck.error) gateReasons.push(playoffMarketCheck.error);
    publicationAudit.publication_decision = "blocked";
    publicationAudit.status = "failed";
  } else if (!publicationCheck.error) {
    publicationAudit.status = "good";
  }
  if (winMarketCheck.error || playoffMarketCheck.error || publicationCheck.error) {
    const publicationError = publicationCheck.error ?? winMarketCheck.error ?? playoffMarketCheck.error!;
    const diagnostics = {
      ...finalDiagnostics,
      engineError: publicationError,
    };
    await db.update(mtmSnapshotTable).set({
      status: "failed",
      error: publicationError,
      diagnostics,
    }).where(eq(mtmSnapshotTable.id, snapshotId));
    return {
      id: snapshotId, currentSnapshotId: null, poolId, asOf: now.toISOString(),
      currentAsOf: null, status: "failed", error: publicationError, stale: true,
      staleReasons: [publicationError], diagnostics, valuations: [], projections: {},
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
    effectiveSampleSize: winMarketCheck.effectiveSampleSize == null
      ? (metric.effective_sample_size == null ? null : String(metric.effective_sample_size))
      : String(winMarketCheck.effectiveSampleSize),
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
        expectedShare: String(asNumber(valuation.expected_share)),
        expectedPayout: String(asNumber(valuation.expected_payout)),
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
      // Mark the simulation evidence successful only after all persisted
      // outputs and publication-quality gates have passed. This is not an
      // official publication transition.
      await tx.update(mtmSnapshotTable).set({
        status: "ok", error: null,
        // Keep all prefit/runtime diagnostics and append publication-time
        // quality checks; consumers need both to audit the final mark.
        diagnostics: finalDiagnostics,
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
      // A successful simulation is evidence, not publication. Canonical
      // period selections and calendar projections are published only by the
      // locked, fully validated current-version promotion boundary.
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
  const successfulCandidates = promotedSnapshotIds.length
    ? await db.select().from(mtmSnapshotTable)
        .where(and(
          eq(mtmSnapshotTable.poolId, selected[0].poolId),
          eq(mtmSnapshotTable.status, "ok"),
          ne(mtmSnapshotTable.methodVersion, "mtm-v3-review"),
        ))
        .orderBy(
          sql`${mtmSnapshotTable.asOf} desc`,
          sql`${mtmSnapshotTable.id} desc`,
        )
    : [];
  const promotedSnapshotIdSet = new Set(promotedSnapshotIds);
  const firstPromotionAt = promotedVersions.reduce<number | null>(
    (earliest, version) => {
      const timestamp = version.mtmAsOf.getTime();
      return earliest == null || timestamp < earliest ? timestamp : earliest;
    },
    null,
  );
  const successfulRows = successfulCandidates.filter((snapshot) =>
    promotedSnapshotIdSet.has(snapshot.id) ||
    (firstPromotionAt != null && snapshot.asOf.getTime() < firstPromotionAt),
  );
  const currentVersion = promotedVersions.find((version) => version.status === "current");
  const current = currentVersion
    ? successfulRows.find((snapshot) => snapshot.id === currentVersion.sourceSnapshotId)
    : undefined;
  const previous = successfulRows.find((snapshot) => snapshot.id !== current?.id);
  // Attempt metadata and current valuation data are intentionally independent:
  // this status endpoint may observe a newer attempt while current-version
  // rows still reflect the last committed promotion. Never expose attempt
  // evidence as current data unless it is linked by a validated current version.
  const dataSnapshotId = current?.id ?? null;
  const successfulSnapshotIds = successfulRows.map((snapshot) => snapshot.id);
  const [projections, valuations, historicalValuations, entryRows, ownership, weekZeroRows, primaryCostRows] = await Promise.all([
    dataSnapshotId != null
      ? db.select().from(mtmTeamProjectionTable).where(eq(mtmTeamProjectionTable.snapshotId, dataSnapshotId))
      : Promise.resolve([] as Array<typeof mtmTeamProjectionTable.$inferSelect>),
    dataSnapshotId != null
      ? db.select().from(mtmEntryValuationTable).where(eq(mtmEntryValuationTable.snapshotId, dataSnapshotId))
      : Promise.resolve([] as Array<typeof mtmEntryValuationTable.$inferSelect>),
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
          label: `Week ${nflDisplayWeek(snapshot.asOf)}`,
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
  runEngine,
  classifyEliminationMarket,
  hourStart,
  quoteValue,
  quoteVolume,
  validateActiveQuote,
  deriveQuoteState,
  assessWinMarketQuality,
  buildJointFitConstraints,
  finalEffectiveSampleSize,
  validateFinalWinMarketQuality,
  validateFinalPlayoffMarketQuality,
  validateFinalPublicationQuality,
  buildRunInformation,
  compactCandidateDiagnostics,
  buildInternalCaptureManifest,
  normalizeEngineValuationPayouts,
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
  buildMarketEvidenceReview,
  kalshiEventUrl,
};
