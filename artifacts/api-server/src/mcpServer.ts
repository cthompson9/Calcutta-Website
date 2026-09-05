/**
 * Proper MCP server using the official @modelcontextprotocol/sdk.
 * Mounted at POST /mcp and GET /mcp (streamable HTTP transport, stateless).
 *
 * Auth: OAuth access tokens and MCP_API_KEY are ordinary principals.
 * ADMIN_API_KEY is accepted only as a distinct static bearer for commissioner
 * tools. If MCP_API_KEY is not set, all requests are rejected with 503.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ilike, eq, and, asc, isNull, sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  teamResultsTable,
  positionsTable,
  seasonsTable,
  tradesTable,
  mtmSnapshotsTable,
  ownershipAdjustmentsTable,
  consortiaTable,
  consortiumMembershipsTable,
  calcuttasTable,
  calcuttaEntriesTable,
  nflGamesTable,
  sportPeriodsTable,
  teamPeriodSnapshotsTable,
  payoutRulesTable,
  mtmMarketQuoteTable,
  mtmSnapshotTable,
  mtmTeamProjectionTable,
} from "@workspace/db";
import type { Router, IRouter, Request, Response } from "express";
import { Router as ExpressRouter } from "express";
import {
  loadCrossCalcuttaRollup,
  loadSeasonOwnership,
} from "./lib/seasonOwnership";
import {
  OWNERSHIP_SEASON_LOCK_NAMESPACE,
  validatePrimaryOwnership,
} from "./lib/ownershipShares";
import { currentYearInNewYork, todayInNewYork } from "./lib/newYorkTime";
import { writeManualMtmSnapshot } from "./lib/manualMtm";
import {
  NFL_SPORT,
  ensureNflSportPeriods,
  getOrCreateCalcuttaEntry,
  getOrCreateCanonicalCalcutta,
  hasCompleteNormalizedSnapshot,
  hasConfiguredPayoutRulesForCalcutta,
  loadCalculatedTeamReturnsForCalcutta,
  type NormalizedSnapshotWrite,
  upsertNormalizedSnapshotMetrics,
} from "./lib/calcuttaReturns";
import {
  resolveCalcuttaId as resolveSelectedCalcuttaId,
  resolveDefaultSeasonYearForSport,
  resolveSeasonIdForSport,
} from "./lib/calcuttaContext";
import { loadCurrentBidderConsortiums } from "./lib/consortiumMemberships";
import { applyNflStandingsImport, NflStandingsImportError } from "./lib/nflStandingsImport";
import { getMtmPipelineStatus } from "./lib/mtmPipeline";
import { createPendingTrade, validateTradeOwnership } from "./lib/tradeService";
import {
  mcpProtectedResourceMetadataUrl,
  matchesAdminApiKey,
  matchesMcpApiKey,
  verifyMcpOAuthAccessToken,
} from "./mcpOAuth";
import {
  getConsortiumLeaderboard,
  getGame,
  getOwnerPortfolio,
  getOwnerPortfolioPerformance,
  getOwnerSummary,
  getPointsRubric,
  getSchedule,
  getTeamSchedule,
} from "./routes/v2Agent";

// ─── DB helpers ─────────────────────────────────────────────────────────────
const CONSORTIUM_MEMBERSHIP_LOCK_NAMESPACE = 841204;

async function resolveSeasonId(year: number): Promise<number | null> {
  return resolveSeasonIdForSport(db, { year, sport: NFL_SPORT });
}

async function defaultSeasonYear(): Promise<number> {
  return await resolveDefaultSeasonYearForSport(db, {
    sport: NFL_SPORT,
    state: "complete",
  }) ?? 2025;
}

async function activeSeasonYear(): Promise<number | null> {
  return resolveDefaultSeasonYearForSport(db, {
    sport: NFL_SPORT,
    state: "active",
  });
}

async function findTeam(name: string) {
  const rows = await db
    .select()
    .from(teamsTable)
    .where(ilike(teamsTable.name, `%${name}%`))
    .limit(1);
  return rows[0] ?? null;
}

async function findBidder(name: string) {
  const rows = await db
    .select()
    .from(biddersTable)
    .where(ilike(biddersTable.name, `%${name}%`))
    .limit(1);
  return rows[0] ?? null;
}

function mtmQuoteTeamCode(team: string | null, ticker: string): string | null {
  return team ?? /-\d{2}([A-Z]{2,3})-/.exec(ticker)?.[1] ?? null;
}

async function resolveExistingTeam(name: string): Promise<NamedRecord | { error: string }> {
  const teams = await db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable);
  return resolveUniqueName(teams, name, "Team");
}

async function resolveExistingBidder(name: string): Promise<NamedRecord | { error: string }> {
  const bidders = await db.select({ id: biddersTable.id, name: biddersTable.name }).from(biddersTable);
  return resolveUniqueName(bidders, name, "Owner");
}

type NamedRecord = { id: number; name: string };

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function resolveUniqueName<T extends NamedRecord>(
  rows: T[],
  requestedName: string,
  label: string,
): T | { error: string } {
  const exact = rows.filter((row) => normalizeName(row.name) === normalizeName(requestedName));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return { error: `${label} "${requestedName}" is ambiguous.` };

  const partial = rows.filter((row) =>
    normalizeName(row.name).includes(normalizeName(requestedName)) ||
    normalizeName(requestedName).includes(normalizeName(row.name)),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) return { error: `${label} "${requestedName}" not found.` };
  return { error: `${label} "${requestedName}" is ambiguous. Use the full registered name.` };
}

/**
 * Resolve a bidder using the same unambiguous matching behavior as the other
 * MCP tools. A name with no matching identity becomes a new bidder so someone
 * can enter the pool through a trade instead of an auction result.
 */
export async function resolveOrCreateBidder(
  requestedName: string,
): Promise<{ bidder: NamedRecord; created: boolean } | { error: string }> {
  const name = requestedName.trim().replace(/\s+/g, " ");
  if (!name) return { error: "Owner name cannot be empty." };

  const bidders = await db
    .select({ id: biddersTable.id, name: biddersTable.name })
    .from(biddersTable);
  const existing = resolveUniqueName(bidders, name, "Owner");
  if (!("error" in existing)) return { bidder: existing, created: false };
  if (!existing.error.endsWith("not found.")) return existing;

  const [created] = await db
    .insert(biddersTable)
    .values({ name })
    .onConflictDoNothing({ target: biddersTable.name })
    .returning({ id: biddersTable.id, name: biddersTable.name });
  if (created) return { bidder: created, created: true };

  // A duplicate-name request may have won the race immediately before this
  // insert. Re-resolve instead of surfacing a misleading failure.
  const afterConflict = await db
    .select({ id: biddersTable.id, name: biddersTable.name })
    .from(biddersTable);
  const resolved = resolveUniqueName(afterConflict, name, "Owner");
  if ("error" in resolved) return resolved;
  return { bidder: resolved, created: false };
}

async function resolveWritableSeasonYear(): Promise<number> {
  return await activeSeasonYear() ?? await defaultSeasonYear();
}

async function validateMcpTradeApproval(trade: {
  seasonId: number;
  teamId: number;
  entryId: number;
  fromBidderId: number;
  toBidderId: number;
  percentage: string;
}, query: Pick<typeof db, "select"> = db, requireCompletePrimaryOwnership = false): Promise<string | null> {
  return validateTradeOwnership({
    entryId: trade.entryId,
    fromBidderId: trade.fromBidderId,
    toBidderId: trade.toBidderId,
    percentage: Number(trade.percentage),
  }, query, requireCompletePrimaryOwnership);
  /*
  if (trade.fromBidderId === trade.toBidderId) {
    return "Seller and buyer must be different owners.";
  }

  const percentage = Number(trade.percentage);
  if (!Number.isFinite(percentage) || percentage < 1 || percentage > 100) {
    return "Trade percentage must be between 1% and 100%.";
  }

  const primaryOwners = await query
    .select({
      bidderId: positionsTable.bidderId,
      ownershipShare: positionsTable.ownershipShare,
    })
    .from(positionsTable)
    .where(and(
      eq(positionsTable.entryId, trade.entryId),
      eq(positionsTable.source, "primary"),
    ));
  if (primaryOwners.length === 0) {
    return "Team has no primary positions in the selected Calcutta and cannot be traded.";
  }

  if (requireCompletePrimaryOwnership) {
    const split = validatePrimaryOwnership(
      primaryOwners.map((owner) => ({
        bidderId: owner.bidderId,
        share: Number(owner.ownershipShare),
      })),
    );
    if (!split.ok) {
      return `The team's original auction ownership is incomplete or invalid: ${split.error}`;
    }
  }

  // Do not cap a sale to a seller's long stake: approved trades are a signed
  // ledger and may intentionally open or increase a short position.
  return null;
  */
}

async function getTeamResult(teamId: number, seasonId: number) {
  const rows = await db
    .select()
    .from(teamResultsTable)
    .where(and(eq(teamResultsTable.teamId, teamId), eq(teamResultsTable.seasonId, seasonId)))
    .limit(1);
  return rows[0] ?? null;
}

async function getTeamCost(
  teamId: number,
  seasonId: number,
  calcuttaId?: number,
): Promise<number | null> {
  const resolvedCalcuttaId = await resolveSelectedCalcuttaId(db, { seasonId, calcuttaId });
  if (!resolvedCalcuttaId) return null;
  const rows = await db
    .select({ costBasis: positionsTable.costBasis })
    .from(calcuttaEntriesTable)
    .innerJoin(positionsTable, and(
      eq(positionsTable.entryId, calcuttaEntriesTable.id),
      eq(positionsTable.source, "primary"),
    ))
    .where(and(
      eq(calcuttaEntriesTable.teamId, teamId),
      eq(calcuttaEntriesTable.calcuttaId, resolvedCalcuttaId),
    ));
  return rows.length > 0
    ? rows.reduce((sum, row) => sum + Number(row.costBasis), 0)
    : null;
}

/** Returns effective current owner names for a team in a season (post-trades). */
async function getTeamOwners(teamId: number, seasonId: number, calcuttaId?: number): Promise<string[]> {
  const resolvedCalcuttaId = await resolveSelectedCalcuttaId(db, { seasonId, calcuttaId });
  if (!resolvedCalcuttaId) return [];
  const ownership = await loadSeasonOwnership(seasonId, resolvedCalcuttaId);
  return (ownership.currentOwnersByTeam.get(teamId) ?? []).map((o) => o.bidderName);
}

/** Aggregate cost/return/mtm for a bidder using effective ownership (post-trades). */
async function getOwnerAgg(bidderId: number, seasonId: number, calcuttaId?: number) {
  const resolvedCalcuttaId = await resolveSelectedCalcuttaId(db, { seasonId, calcuttaId });
  if (!resolvedCalcuttaId) {
    return { totalCost: 0, totalReturn: 0, totalMtm: 0, totalNetMtm: 0 };
  }
  const ownership = await loadSeasonOwnership(seasonId, resolvedCalcuttaId);
  const calculatedReturns = await loadCalculatedTeamReturnsForCalcutta(resolvedCalcuttaId);
  const teamMap = ownership.byBidder.get(bidderId);
  if (!teamMap) return { totalCost: 0, totalReturn: 0, totalMtm: 0, totalNetMtm: 0 };

  let totalCost = 0, totalReturn = 0, totalMtm = 0;
  let returnsAvailable = true, mtmAvailable = true;
  for (const [teamId, entry] of teamMap) {
    totalCost += entry.originalCostBasis + entry.tradePaid - entry.tradeReceived;

    // Short positions use the same signed economic treatment as owner results.
    const effectiveShare = entry.effectiveShare;
    if (Math.abs(effectiveShare) > 0.00005) {
      const calculated = calculatedReturns.get(teamId);
      if (calculated?.realized) totalReturn += calculated.realized.grossReturn * effectiveShare;
      else returnsAvailable = false;
      if (calculated?.mtm) totalMtm += calculated.mtm.grossReturn * effectiveShare;
      else mtmAvailable = false;
    }
  }
  return {
    totalCost,
    totalReturn: returnsAvailable ? totalReturn : null,
    totalMtm: mtmAvailable ? totalMtm : null,
    totalNetMtm: mtmAvailable ? totalMtm - totalCost : null,
  };
}

// ─── Text helper ─────────────────────────────────────────────────────────────

function text(v: string | number | null | undefined) {
  return { content: [{ type: "text" as const, text: String(v ?? "null") }] };
}

function jsonText(result: { status: number; body: unknown }) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(result.status >= 400
        ? { status: result.status, ...result.body as object }
        : result.body, null, 2),
    }],
    isError: result.status >= 400,
  };
}

function commissionerAuthorizationRequired() {
  return {
    content: [{
      type: "text" as const,
      text: "Error: Commissioner authorization is required for this MCP mutation.",
    }],
    isError: true,
  };
}

// ─── Build MCP server (called per-request in stateless mode) ─────────────────

function buildMcpServer(isAdmin: boolean) {
  const server = new McpServer({
    name: "nfl-auction",
    version: "1.0.0",
    description: "NFL Calcutta Pool auction data: ownership, costs, realized payouts, and mark-to-market valuations. Realized means earned payout from completed results. Gross MTM is current market-implied payout; net MTM is gross MTM minus signed cost basis. An unqualified request for 'MTM' means net MTM. Never substitute realized value for requested MTM.",
  });

  // Shared input schema fragments
  const teamInput = { team: z.string().describe("Full or partial team name, e.g. 'Seattle Seahawks' or 'Seahawks'") };
  const ownerInput = { owner: z.string().describe("Full or partial owner name, e.g. 'Zachary Long' or 'Zachary'") };
  const seasonInput = { season: z.number().optional().describe("Season year (e.g. 2025). Defaults to most recent completed season.") };
  const calcuttaInput = { calcuttaId: z.number().int().positive().optional().describe("Selected NFL Calcutta ID. Defaults to the season's canonical NFL Calcutta.") };

  // ── V2.1 agent tools ──────────────────────────────────────────────────────

  const basisInput = {
    basis: z.enum(["realized", "mtm"])
      .describe("Required value basis: 'mtm' means mark-to-market; when the user does not specify gross or net, report net MTM. 'realized' means payout earned from completed results. Never substitute realized for MTM."),
    period: z.number().int().min(0).max(22).optional()
      .describe("Optional reporting period sequence. Omit for the latest complete normalized period."),
  };
  const dateInput = {
    week: z.number().int().min(0).max(22).optional(),
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe("Inclusive New York calendar date, YYYY-MM-DD."),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe("Inclusive New York calendar date, YYYY-MM-DD."),
  };
  const requiredSeason = {
    season: z.number().int().describe("NFL season year, e.g. 2025."),
  };

  server.tool(
    "get_calcutta_glossary",
    "Returns authoritative Calcutta terminology and interpretation rules. Call this when a request uses MTM, WoW, XBook, Lion King, gross/net, realized, or other domain jargon ambiguously.",
    {},
    async () => text(JSON.stringify({
      interpretation_rules: {
        unqualified_mtm: "net_mtm",
        never_substitute_realized_for_mtm: true,
        missing_value: "Return unavailable with the reason; do not infer or substitute another basis.",
      },
      terms: {
        gross_mtm: "Current market-implied payout before cost basis.",
        net_mtm: "Gross MTM minus signed cost basis. This is the default meaning of an unqualified 'MTM' request.",
        realized_payout: "Payout earned from completed results. It is not MTM.",
        wow: "Week-over-week MTM change between two named weekly snapshots. In football this is period-over-period, not necessarily exactly seven days.",
        xbook: "A cross-book portfolio wager or synthetic position. Its scope, factor, basis, and reference owner must be read from the specific record; the name alone does not define one universal formula.",
        lion_king: "An auction-lot-only valuation basis used by some historical XBooks: trades are excluded and each auction lot is evaluated at 100% gain before the configured factor. Do not apply it unless the record explicitly selects this basis.",
        signed_cost_basis: "Auction cost plus trade cash paid minus trade cash received, preserving signed short positions.",
      },
    }, null, 2)),
  );

  server.tool(
    "get_current_team_valuation",
    "Returns the authoritative Live Tracker valuation for one team. An unqualified MTM request means net_mtm. The response always distinguishes gross MTM, auction cost, net MTM, source snapshot, method, week, and timestamp.",
    { ...teamInput, ...requiredSeason, ...calcuttaInput },
    async ({ team, season, calcuttaId }) => {
      const matchedTeam = await findTeam(team);
      if (!matchedTeam) return text(JSON.stringify({ available: false, reason: `Team not found: ${team}` }));
      const status = await getMtmPipelineStatus(season, calcuttaId);
      const valuation = status?.valuations.find((row) => row.teamId === matchedTeam.id) as Record<string, any> | undefined;
      const current = valuation?.history?.at(-1);
      if (!status || !valuation || !current || current.netPayout == null || current.auctionPrice == null) {
        return text(JSON.stringify({
          available: false,
          basis: "mtm",
          default_measure: "net_mtm",
          team: matchedTeam.name,
          reason: status?.staleReasons?.[0] ?? "No complete Live Tracker pipeline mark is available.",
        }, null, 2));
      }
      const [snapshot] = status.currentSnapshotId
        ? await db.select({
            methodVersion: mtmSnapshotTable.methodVersion,
          }).from(mtmSnapshotTable).where(eq(mtmSnapshotTable.id, status.currentSnapshotId)).limit(1)
        : [];
      const netMtm = Number(current.netPayout);
      const costBasis = Number(current.auctionPrice);
      return text(JSON.stringify({
        available: true,
        basis: "mtm",
        default_measure: "net_mtm",
        team: matchedTeam.name,
        gross_mtm: netMtm + costBasis,
        cost_basis: costBasis,
        net_mtm: netMtm,
        week: current.label,
        as_of: current.asOf,
        snapshot_id: status.currentSnapshotId,
        method_version: snapshot?.methodVersion ?? null,
        source: "live_mtm_pipeline",
        stale: status.stale,
        stale_reasons: status.staleReasons,
      }, null, 2));
    },
  );

  server.tool(
    "get_current_owner_valuation",
    "Returns an owner's authoritative Live Tracker portfolio valuation. An unqualified MTM request means net_mtm. Gross MTM, signed cost basis, net MTM, holdings, snapshot, method, week, and timestamp are returned separately.",
    { ...ownerInput, ...requiredSeason, ...calcuttaInput },
    async ({ owner, season, calcuttaId }) => {
      const bidder = await findBidder(owner);
      if (!bidder) return text(JSON.stringify({ available: false, reason: `Owner not found: ${owner}` }));
      const seasonId = await resolveSeasonId(season);
      const status = await getMtmPipelineStatus(season, calcuttaId);
      if (!seasonId || !status?.currentSnapshotId) {
        return text(JSON.stringify({
          available: false,
          basis: "mtm",
          default_measure: "net_mtm",
          owner: bidder.name,
          reason: status?.staleReasons?.[0] ?? "No complete Live Tracker pipeline mark is available.",
        }, null, 2));
      }
      const ownership = await loadSeasonOwnership(seasonId, status.poolId);
      const positions = ownership.byBidder.get(bidder.id);
      const [snapshot] = await db.select({
        methodVersion: mtmSnapshotTable.methodVersion,
      }).from(mtmSnapshotTable).where(eq(mtmSnapshotTable.id, status.currentSnapshotId)).limit(1);
      let grossMtm = 0;
      let signedCostBasis = 0;
      let complete = true;
      const holdings = [...(positions?.entries() ?? [])].map(([teamId, position]) => {
        const valuation = status.valuations.find((row) => row.teamId === teamId) as Record<string, any> | undefined;
        const point = valuation?.history?.at(-1);
        const teamGross = point?.netPayout == null || point?.auctionPrice == null
          ? null
          : Number(point.netPayout) + Number(point.auctionPrice);
        const cost = position.originalCostBasis + position.tradePaid - position.tradeReceived;
        signedCostBasis += cost;
        if (teamGross == null) complete = false;
        else grossMtm += teamGross * position.effectiveShare;
        return {
          team: valuation?.teamName ?? `Team ${teamId}`,
          signed_share: position.effectiveShare,
          gross_mtm_share: teamGross == null ? null : teamGross * position.effectiveShare,
          signed_cost_basis: cost,
          net_mtm: teamGross == null ? null : teamGross * position.effectiveShare - cost,
        };
      });
      const latestPoint = (status.valuations[0] as Record<string, any> | undefined)?.history?.at(-1);
      return text(JSON.stringify({
        available: complete,
        basis: "mtm",
        default_measure: "net_mtm",
        owner: bidder.name,
        gross_mtm: complete ? grossMtm : null,
        signed_cost_basis: signedCostBasis,
        net_mtm: complete ? grossMtm - signedCostBasis : null,
        holdings,
        week: latestPoint?.label ?? null,
        as_of: status.currentAsOf,
        snapshot_id: status.currentSnapshotId,
        method_version: snapshot?.methodVersion ?? null,
        source: "live_mtm_pipeline",
        stale: status.stale,
        stale_reasons: status.staleReasons,
      }, null, 2));
    },
  );

  server.tool(
    "get_mtm_snapshot_evidence",
    "Returns bounded, normalized evidence behind a Live Tracker MTM snapshot: formula, pipeline inputs, team projections including Super Bowl probabilities, and market quotes. Every market input includes provider, source URL, ticker, and fetch timestamp. Raw provider payloads and credentials are never returned.",
    {
      ...requiredSeason,
      ...calcuttaInput,
      team: z.string().optional().describe("Optional exact or partial team name. Omit for all teams."),
      quoteLimit: z.number().int().min(1).max(200).optional().describe("Maximum normalized quote inputs to return. Defaults to 100."),
    },
    async ({ season, calcuttaId, team, quoteLimit }) => {
      const status = await getMtmPipelineStatus(season, calcuttaId);
      if (!status?.currentSnapshotId) {
        return text(JSON.stringify({
          available: false,
          reason: status?.staleReasons?.[0] ?? "No successful Live Tracker pipeline snapshot is available.",
        }, null, 2));
      }
      const [snapshotRows, quotes, projections] = await Promise.all([
        db.select().from(mtmSnapshotTable).where(eq(mtmSnapshotTable.id, status.currentSnapshotId)).limit(1),
        db.select().from(mtmMarketQuoteTable)
          .where(eq(mtmMarketQuoteTable.snapshotId, status.currentSnapshotId))
          .orderBy(asc(mtmMarketQuoteTable.series), asc(mtmMarketQuoteTable.marketTicker)),
        db.select().from(mtmTeamProjectionTable)
          .where(eq(mtmTeamProjectionTable.snapshotId, status.currentSnapshotId))
          .orderBy(asc(mtmTeamProjectionTable.team)),
      ]);
      const snapshot = snapshotRows[0];
      if (!snapshot) return text(JSON.stringify({ available: false, reason: "Snapshot evidence was not found." }));
      const matched = team ? await findTeam(team) : null;
      const valuationRows = (status.valuations as Array<Record<string, any>>)
        .filter((row) => !matched || row.teamId === matched.id)
        .map((row) => {
          const point = row.history?.at(-1);
          return {
            team: row.teamName,
            entry_id: row.entryId,
            expected_points: Number(row.expectedPoints),
            gross_mtm: point?.netPayout == null || point?.auctionPrice == null
              ? null
              : Number(point.netPayout) + Number(point.auctionPrice),
            cost_basis: point?.auctionPrice ?? null,
            net_mtm: point?.netPayout ?? null,
          };
        });
      const state = snapshot.stateJson as Record<string, any> | null;
      const selectedEntryIds = new Set(valuationRows.map((row) => String(row.entry_id)));
      const selectedTeamCodes = new Set(
        (Array.isArray(state?.entries) ? state.entries : [])
          .filter((entry: any) => selectedEntryIds.has(String(entry?.entry_id)))
          .map((entry: any) => String(entry.team)),
      );
      const providerBaseUrl = "https://api.elections.kalshi.com/trade-api/v2";
      return text(JSON.stringify({
        available: true,
        schema_version: "1.0",
        snapshot: {
          id: snapshot.id,
          pool_id: snapshot.poolId,
          status: snapshot.status,
          trigger: snapshot.trigger,
          as_of: snapshot.asOf.toISOString(),
          created_at: snapshot.createdAt.toISOString(),
          method_version: snapshot.methodVersion,
          source: "live_mtm_pipeline",
        },
        interpretation: {
          unqualified_mtm: "net_mtm",
          gross_mtm: "Normalized market-implied payout before cost basis.",
          net_mtm: "Gross MTM minus signed cost basis.",
        },
        formula: {
          expected_points: "banked + win value + tie value + adjusted point-differential value + probability-weighted playoff bonuses",
          expected_share: "expected_points / denominator",
          gross_mtm: "expected_share * auction_pool, normalized so all team gross MTM values sum to the auction pool",
          net_mtm: "gross_mtm - signed_cost_basis",
          rubric: state?.rubric ?? null,
          auction_pool: state?.pot ?? null,
        },
        input_provenance: {
          market_quotes: {
            source_and_url: "Included per market input below.",
            timestamp: "Each quote has its own fetched_at timestamp.",
          },
          schedule_and_realized_state: {
            source: "persisted_pipeline_state",
            source_url: null,
            captured_at: snapshot.asOf.toISOString(),
            provenance_status: "partial",
            note: "The exact upstream URL for each schedule/result fact was not persisted by this pipeline version and is therefore not invented here.",
          },
        },
        valuations: valuationRows,
        projections: projections
          .filter((row) => !team || selectedTeamCodes.has(row.team))
          .map((row) => ({
            team_code: row.team,
            expected_total_wins: row.eWinsTotal == null ? null : Number(row.eWinsTotal),
            expected_remaining_wins: row.eRemainingWins == null ? null : Number(row.eRemainingWins),
            playoff_berth_probability: row.pBerth == null ? null : Number(row.pBerth),
            divisional_probability: row.pDivisional == null ? null : Number(row.pDivisional),
            conference_probability: row.pConf == null ? null : Number(row.pConf),
            super_bowl_berth_probability: row.pSbBerth == null ? null : Number(row.pSbBerth),
            super_bowl_win_probability: row.pSbWin == null ? null : Number(row.pSbWin),
            rating: row.rating == null ? null : Number(row.rating),
          })),
        market_inputs: quotes
          .filter((quote) => {
            const teamCode = mtmQuoteTeamCode(quote.team, quote.marketTicker);
            return !team || (teamCode != null && selectedTeamCodes.has(teamCode));
          })
          .slice(0, quoteLimit ?? 100)
          .map((quote) => ({
          provider: quote.source,
          source_url: `${providerBaseUrl}/markets/${encodeURIComponent(quote.marketTicker)}`,
          series: quote.series,
          ticker: quote.marketTicker,
          team_code: mtmQuoteTeamCode(quote.team, quote.marketTicker),
          strike: quote.strike == null ? null : Number(quote.strike),
          yes_bid: quote.yesBid == null ? null : Number(quote.yesBid),
          yes_ask: quote.yesAsk == null ? null : Number(quote.yesAsk),
          volume: quote.volume,
          fetched_at: quote.fetchedAt.toISOString(),
          })),
        diagnostics: snapshot.diagnostics,
        redaction: "Normalized evidence only; raw provider payloads and credentials are omitted.",
      }, null, 2));
    },
  );

  server.tool(
    "get_owner_portfolio",
    "Returns every signed economic position for one owner in one NFL Calcutta. Set basis='mtm' for a current mark-to-market request and use current_mtm/net_mtm; set basis='realized' only for earned-payout requests and use realized_return/net_return. The response includes both named fields for comparison, but total_return and ROI always follow the required basis.",
    { ...ownerInput, ...requiredSeason, ...calcuttaInput, ...basisInput },
    async ({ owner, season, calcuttaId, basis, period }) =>
      jsonText(await getOwnerPortfolio({ owner, season, calcuttaId, basis, period })),
  );

  server.tool(
    "get_owner_summary",
    "Returns an owner's Calcutta portfolio totals. For an MTM question, set basis='mtm': current_mtm is gross current market value and total_return/ROI use MTM. For an earned-payout question, set basis='realized': realized_return and total_return/ROI use completed results. Never report realized_return as MTM.",
    { ...ownerInput, ...requiredSeason, ...calcuttaInput, ...basisInput },
    async ({ owner, season, calcuttaId, basis, period }) =>
      jsonText(await getOwnerSummary({ owner, season, calcuttaId, basis, period })),
  );

  server.tool(
    "get_owner_portfolio_performance",
    "Returns the team-by-team breakdown behind an owner's portfolio summary. basis is required: use 'mtm' for current market value and 'realized' for payouts earned from completed results. Never substitute realized values for requested MTM.",
    { ...ownerInput, ...requiredSeason, ...calcuttaInput, ...basisInput },
    async ({ owner, season, calcuttaId, basis, period }) =>
      jsonText(await getOwnerPortfolioPerformance({ owner, season, calcuttaId, basis, period })),
  );

  server.tool(
    "get_schedule",
    "Returns canonical NFL games for a season with optional team, week, and inclusive New York date filters. Market and projection fields are included only when requested and remain null when no snapshot exists.",
    {
      ...requiredSeason,
      ...calcuttaInput,
      ...dateInput,
      team: z.string().optional().describe("Exact or unambiguous partial NFL team name."),
      includeMarket: z.boolean().optional(),
      includeProjection: z.boolean().optional(),
    },
    async ({ season, calcuttaId, week, dateFrom, dateTo, team, includeMarket, includeProjection }) =>
      jsonText(await getSchedule({
        season,
        calcuttaId,
        week,
        date_from: dateFrom,
        date_to: dateTo,
        team,
        include_market: includeMarket,
        include_projection: includeProjection,
      })),
  );

  server.tool(
    "get_team_schedule",
    "Returns one NFL team's canonical schedule plus ownership and selected-basis value. basis is required: 'mtm' makes current_calcutta_value the current market-implied gross value; 'realized' makes it the earned payout from completed results.",
    {
      ...requiredSeason,
      ...calcuttaInput,
      ...dateInput,
      ...basisInput,
      team: z.string().describe("Exact or unambiguous partial NFL team name."),
      includeMarket: z.boolean().optional(),
      includeProjection: z.boolean().optional(),
    },
    async ({ season, calcuttaId, week, dateFrom, dateTo, team, basis, period, includeMarket, includeProjection }) =>
      jsonText(await getTeamSchedule({
        season,
        calcuttaId,
        week,
        date_from: dateFrom,
        date_to: dateTo,
        team,
        basis,
        period,
        include_market: includeMarket,
        include_projection: includeProjection,
      })),
  );

  server.tool(
    "get_game",
    "Returns one canonical NFL game and selected-Calcutta team values. basis is required: 'mtm' returns current market-implied values; 'realized' returns earned payouts from completed results. Accepts the stable source-prefixed game ID, source ID, or database ID.",
    {
      gameId: z.string().describe("Game ID returned by get_schedule."),
      ...requiredSeason,
      ...calcuttaInput,
      ...basisInput,
    },
    async ({ gameId, season, calcuttaId, basis, period }) =>
      jsonText(await getGame({
        game_id: gameId,
        season,
        calcuttaId,
        basis,
        period,
      })),
  );

  server.tool(
    "get_points_rubric",
    "Returns the complete selected-Calcutta scoring rubric with descriptive rule names, configured values, units, playoff multipliers, starting points, and the fixed marquee point-differential multiplier. Missing configuration is null, never inferred.",
    { ...requiredSeason, ...calcuttaInput },
    async ({ season, calcuttaId }) =>
      jsonText(await getPointsRubric({ season, calcuttaId })),
  );

  server.tool(
    "get_consortium_leaderboard",
    "Returns a Calcutta-scoped consortium leaderboard. basis is required: for MTM requests use 'mtm' and report current_mtm/net_mtm; for completed-payout requests use 'realized' and report realized_return/net_return. Never label realized values as MTM.",
    {
      ...requiredSeason,
      ...calcuttaInput,
      ...basisInput,
      membershipView: z.enum(["historical", "current"]).optional(),
    },
    async ({ season, calcuttaId, basis, period, membershipView }) =>
      jsonText(await getConsortiumLeaderboard({
        season,
        calcuttaId,
        basis,
        period,
        membershipView,
      })),
  );

  // ── Team owner tools ──────────────────────────────────────────────────────

  for (const n of [1, 2, 3, 4, 5] as const) {
    server.tool(
      `get_team_owner${n}`,
      `Returns the ${["first", "second", "third", "fourth", "fifth"][n - 1]} owner of an NFL team in a given season. Returns null if the team has fewer than ${n} owner(s).`,
      { ...teamInput, ...seasonInput, ...calcuttaInput },
      async ({ team, season, calcuttaId }) => {
        const t = await findTeam(team);
        if (!t) return text(null);
        const year = season ?? await defaultSeasonYear();
        const sid = await resolveSeasonId(year);
        if (!sid) return text(null);
        const owners = await getTeamOwners(t.id, sid, calcuttaId);
        return text(owners[n - 1] ?? null);
      },
    );
  }

  // ── Team financial/stat tools ─────────────────────────────────────────────

  server.tool(
    "get_team_cost",
    "Returns the auction bid price paid for the team in a given season (in dollars).",
    { ...teamInput, ...seasonInput, ...calcuttaInput },
    async ({ team, season, calcuttaId }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      return text(await getTeamCost(t.id, sid, calcuttaId));
    },
  );

  server.tool(
    "get_team_wins",
    "Returns the number of regular season wins for a team in a given season.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const r = await getTeamResult(t.id, sid);
      return text(r ? parseFloat(r.wins) : null);
    },
  );

  server.tool(
    "import_nfl_standings",
    "Fetch, validate, and atomically import all 32 teams' current NFL regular-season W/L/T, point differential, and current playoff status from nfl.com. It does not infer weekly reporting snapshots or playoff-round results. Requires commissioner transport authorization and confirmed: true.",
    {
      season: z.number().optional().describe("Season year. Defaults to the active season."),
      confirmed: z.literal(true).describe("Must be true to confirm the standings update."),
    },
    async ({ season, confirmed: _confirmed }) => {
      if (!isAdmin) return commissionerAuthorizationRequired();
      const year = season ?? await activeSeasonYear();
      if (!year) return text("Error: No active season is configured for the NFL standings import.");
      try {
        const outcome = await applyNflStandingsImport({
          seasonYear: year,
          requestedBy: "mcp",
        });
        return text(JSON.stringify(outcome));
      } catch (error) {
        if (error instanceof NflStandingsImportError) {
          return text(`Error: ${error.message}`);
        }
        return text("Error: NFL standings import failed unexpectedly.");
      }
    },
  );

  server.tool(
    "get_team_ptdiff",
    "Returns the adjusted point differential for a team in a given season.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const r = await getTeamResult(t.id, sid);
      return text(r ? r.ptDiff : null);
    },
  );

  server.tool(
    "get_team_points",
    "Returns the starting points assigned to a team at the beginning of the season.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const r = await getTeamResult(t.id, sid);
      return text(r ? parseFloat(r.startingPoints) : null);
    },
  );

  server.tool(
    "get_team_return",
    "Returns only the realized dollar return earned from completed results. This is not MTM; use get_team_mtm or an explicit basis='mtm' tool for current market value.",
    { ...teamInput, ...seasonInput, ...calcuttaInput },
    async ({ team, season, calcuttaId }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const resolvedCalcuttaId = await resolveSelectedCalcuttaId(db, { seasonId: sid, calcuttaId });
      if (!resolvedCalcuttaId) return text(null);
      const calculated = (await loadCalculatedTeamReturnsForCalcutta(resolvedCalcuttaId)).get(t.id);
      return text(calculated?.realized?.grossReturn);
    },
  );

  server.tool(
    "get_team_mtm",
    "Legacy scalar alias returning net MTM only. An unqualified 'MTM' means net MTM. Prefer get_current_team_valuation for gross MTM, cost, net MTM, source snapshot, method, week, and timestamp. Never substitute realized payout.",
    { ...teamInput, ...seasonInput, ...calcuttaInput },
    async ({ team, season, calcuttaId }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await activeSeasonYear() ?? await defaultSeasonYear();
      const status = await getMtmPipelineStatus(year, calcuttaId);
      const valuation = status?.valuations.find((row) => row.teamId === t.id) as Record<string, any> | undefined;
      return text(valuation?.history?.at(-1)?.netPayout ?? null);
    },
  );

  server.tool(
    "get_team_draftorder",
    "Returns the draft/auction pick order number for a team in a given season.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const r = await getTeamResult(t.id, sid);
      return text(r?.draftOrder ?? null);
    },
  );

  // ── Owner aggregate tools ─────────────────────────────────────────────────

  server.tool(
    "get_owner_cost",
    "Returns the total auction spend for an owner in a given season (accounting for split ownership).",
    { ...ownerInput, ...seasonInput, ...calcuttaInput },
    async ({ owner, season, calcuttaId }) => {
      const b = await findBidder(owner);
      if (!b) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const agg = await getOwnerAgg(b.id, sid, calcuttaId);
      return text(Math.round(agg.totalCost * 100) / 100);
    },
  );

  server.tool(
    "get_owner_return",
    "Returns only total realized return earned from completed results. This is not MTM; use get_owner_mtm or an explicit basis='mtm' tool for current market value.",
    { ...ownerInput, ...seasonInput, ...calcuttaInput },
    async ({ owner, season, calcuttaId }) => {
      const b = await findBidder(owner);
      if (!b) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const agg = await getOwnerAgg(b.id, sid, calcuttaId);
      return text(agg.totalReturn == null ? null : Math.round(agg.totalReturn * 100) / 100);
    },
  );

  server.tool(
    "get_owner_mtm",
    "Legacy scalar alias returning total net MTM only. An unqualified 'MTM' means net MTM. Prefer get_current_owner_valuation for gross MTM, signed cost basis, net MTM, holdings, source snapshot, method, week, and timestamp. Never substitute realized payout.",
    { ...ownerInput, ...seasonInput, ...calcuttaInput },
    async ({ owner, season, calcuttaId }) => {
      const b = await findBidder(owner);
      if (!b) return text(null);
      const year = season ?? await activeSeasonYear() ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const status = await getMtmPipelineStatus(year, calcuttaId);
      if (!status?.currentSnapshotId) return text(null);
      const ownership = await loadSeasonOwnership(sid, status.poolId);
      const positions = ownership.byBidder.get(b.id);
      if (!positions) return text(0);
      let grossMtm = 0;
      let signedCostBasis = 0;
      for (const [teamId, position] of positions) {
        const valuation = status.valuations.find((row) => row.teamId === teamId) as Record<string, any> | undefined;
        const point = valuation?.history?.at(-1);
        if (point?.netPayout == null || point?.auctionPrice == null) return text(null);
        grossMtm += (Number(point.netPayout) + Number(point.auctionPrice)) * position.effectiveShare;
        signedCostBasis += position.originalCostBasis + position.tradePaid - position.tradeReceived;
      }
      return text(Math.round((grossMtm - signedCostBasis) * 100) / 100);
    },
  );

  // ── Bidder consortium tools ───────────────────────────────────────────────

  server.tool(
    "get_bidder_consortium",
    "Returns the consortium assigned to a bidder, or null when the bidder has not been assigned to one.",
    {
      bidder: z.string().describe("Full or partial bidder name, e.g. 'Zachary Long'"),
    },
    async ({ bidder }) => {
      const rows = await db
        .select({ id: biddersTable.id, name: biddersTable.name })
        .from(biddersTable);
      const match = resolveUniqueName(rows, bidder, "Bidder");
      if ("error" in match) return text(`Error: ${match.error}`);
      const consortiumByBidder = await loadCurrentBidderConsortiums([match.id]);
      return text(consortiumByBidder.get(match.id) ?? null);
    },
  );

  server.tool(
    "set_bidder_consortium",
    "Assign or clear a bidder's consortium. Provide a non-empty label to assign one, or null to explicitly clear the assignment. Empty and whitespace-only labels are rejected. Consortium names are reused case-insensitively. Requires commissioner transport authorization.",
    {
      bidder: z.string().describe("Full or partial bidder name, e.g. 'Zachary Long'"),
      consortium: z.string().max(200).nullable().describe("Non-empty consortium name to assign, or null to explicitly clear the assignment"),
    },
    async ({ bidder, consortium }) => {
      if (!isAdmin) return commissionerAuthorizationRequired();

      const bidders = await db
        .select({ id: biddersTable.id, name: biddersTable.name })
        .from(biddersTable);
      const bidderMatch = resolveUniqueName(bidders, bidder, "Bidder");
      if ("error" in bidderMatch) return text(`Error: ${bidderMatch.error}`);

      const normalizedConsortium = consortium?.trim().replace(/\s+/g, " ") ?? "";
      if (consortium !== null && !normalizedConsortium) {
        return text(
          "Error: A consortium label is required. Use null only when explicitly clearing the assignment.",
        );
      }
      let consortiumId: number | null = null;
      let consortiumName: string | null = null;

      if (normalizedConsortium) {
        const existing = await db
          .select({ id: consortiaTable.id, name: consortiaTable.name })
          .from(consortiaTable)
          .where(sql`lower(${consortiaTable.name}) = lower(${normalizedConsortium})`)
          .limit(1);

        if (existing[0]) {
          consortiumId = existing[0].id;
          consortiumName = existing[0].name;
        } else {
          const [created] = await db
            .insert(consortiaTable)
            .values({ name: normalizedConsortium })
            .onConflictDoNothing()
            .returning({ id: consortiaTable.id, name: consortiaTable.name });

          if (created) {
            consortiumId = created.id;
            consortiumName = created.name;
          } else {
            const afterConflict = await db
              .select({ id: consortiaTable.id, name: consortiaTable.name })
              .from(consortiaTable)
              .where(sql`lower(${consortiaTable.name}) = lower(${normalizedConsortium})`)
              .limit(1);
            if (!afterConflict[0]) {
              return text(`Error: Could not create consortium "${normalizedConsortium}".`);
            }
            consortiumId = afterConflict[0].id;
            consortiumName = afterConflict[0].name;
          }
        }
      }

      const fromDate = todayInNewYork();
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${CONSORTIUM_MEMBERSHIP_LOCK_NAMESPACE}, ${bidderMatch.id})`,
        );
        const active = await tx
          .select({
            id: consortiumMembershipsTable.id,
            consortiumId: consortiumMembershipsTable.consortiumId,
            fromDate: consortiumMembershipsTable.fromDate,
          })
          .from(consortiumMembershipsTable)
          .where(
            and(
              eq(consortiumMembershipsTable.bidderId, bidderMatch.id),
              isNull(consortiumMembershipsTable.toDate),
            ),
          );
        if (active.some((membership) => membership.consortiumId === consortiumId)) {
          return;
        }
        for (const membership of active) {
          if (membership.fromDate === fromDate) {
            await tx
              .delete(consortiumMembershipsTable)
              .where(eq(consortiumMembershipsTable.id, membership.id));
          } else {
            await tx
              .update(consortiumMembershipsTable)
              .set({ toDate: fromDate })
              .where(eq(consortiumMembershipsTable.id, membership.id));
          }
        }
        if (consortiumId != null) {
          await tx.insert(consortiumMembershipsTable).values({
            bidderId: bidderMatch.id,
            consortiumId,
            fromDate,
          });
        }
      });

      return text(
        consortiumName
          ? `Consortium set: ${bidderMatch.name} → ${consortiumName}.`
          : `Consortium cleared: ${bidderMatch.name}.`,
      );
    },
  );

  // ── Primary ownership adjustment ─────────────────────────────────────────

  server.tool(
    "set_team_primary_ownership",
    "Replace a team's complete original auction ownership split for a season. Use this only to correct the original auction record, not to record a later sale; approved trades must use create_trade. Requires commissioner transport authorization. Shares are decimal fractions that must add to 1 exactly (for example, 0.5 and 0.5).",
    {
      team: z.string().describe("Full or partial team name, e.g. 'Buffalo Bills' or 'Bills'"),
      owners: z.array(z.object({
        owner: z.string().describe("Registered bidder name, e.g. 'Zachary Long'"),
        share: z.number().positive().max(1).describe("Ownership fraction, e.g. 0.5 for 50%"),
      })).min(1).describe("Complete replacement ownership split; all shares must total 1."),
      season: z.number().optional().describe("Season year. Defaults to the active season."),
      calcuttaId: z.number().int().positive().optional().describe("Selected NFL Calcutta ID. Defaults to the season's canonical NFL Calcutta."),
      note: z.string().max(500).optional().describe("Optional correction rationale kept in the audit record."),
    },
    async ({ team, owners, season, calcuttaId, note }) => {
      if (!isAdmin) return commissionerAuthorizationRequired();

      const [teams, bidders] = await Promise.all([
        db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable),
        db.select({ id: biddersTable.id, name: biddersTable.name }).from(biddersTable),
      ]);
      const teamMatch = resolveUniqueName(teams, team, "Team");
      if ("error" in teamMatch) return text(`Error: ${teamMatch.error}`);

      const resolvedOwners: Array<{ bidderId: number; bidderName: string; share: number }> = [];
      for (const owner of owners) {
        const bidderMatch = resolveUniqueName(bidders, owner.owner, "Bidder");
        if ("error" in bidderMatch) return text(`Error: ${bidderMatch.error}`);
        resolvedOwners.push({
          bidderId: bidderMatch.id,
          bidderName: bidderMatch.name,
          share: owner.share,
        });
      }

      const split = validatePrimaryOwnership(
        resolvedOwners.map((owner) => ({ bidderId: owner.bidderId, share: owner.share })),
      );
      if (!split.ok) return text(`Error: ${split.error}`);

      const year = season ?? await resolveWritableSeasonYear();
      const seasonId = await resolveSeasonId(year);
      if (!seasonId) return text(`Error: Season ${year} not found.`);

      const writeOutcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
        );
        const calcutta = calcuttaId == null
          ? await getOrCreateCanonicalCalcutta(tx, { seasonId, year })
          : (await tx
            .select({ id: calcuttasTable.id })
            .from(calcuttasTable)
            .where(and(
              eq(calcuttasTable.id, calcuttaId),
              eq(calcuttasTable.seasonId, seasonId),
              eq(calcuttasTable.sport, NFL_SPORT),
            ))
            .limit(1))[0];
        if (!calcutta) return "calcutta_not_found" as const;
        const entry = await getOrCreateCalcuttaEntry(tx, {
          calcuttaId: calcutta.id,
          teamId: teamMatch.id,
        });
        const [primaryRows, approvedTrade] = await Promise.all([
          tx
            .select({ costBasis: positionsTable.costBasis })
            .from(positionsTable)
            .where(and(
              eq(positionsTable.entryId, entry.id),
              eq(positionsTable.source, "primary"),
            )),
          tx
            .select({ id: tradesTable.id })
            .from(tradesTable)
            .where(and(
              eq(tradesTable.entryId, entry.id),
              eq(tradesTable.status, "approved"),
            ))
            .limit(1),
        ]);
        if (primaryRows.length === 0) return "not_auctioned" as const;
        if (approvedTrade[0]) return "approved_trade" as const;

        const auctionCost = primaryRows.reduce(
          (sum, row) => sum + Number(row.costBasis),
          0,
        );
        await tx
          .delete(positionsTable)
          .where(and(eq(positionsTable.entryId, entry.id), eq(positionsTable.source, "primary")));
        await tx.insert(positionsTable).values(
          resolvedOwners.map((owner) => ({
            entryId: entry.id,
            bidderId: owner.bidderId,
            ownershipShare: split.owners.find((entry) => entry.bidderId === owner.bidderId)!.share.toFixed(6),
            source: "primary" as const,
            costBasis: (auctionCost * split.owners.find((entry) => entry.bidderId === owner.bidderId)!.share).toFixed(2),
          })),
        );
        await tx.insert(ownershipAdjustmentsTable).values({
          teamId: teamMatch.id,
          seasonId,
          source: "mcp_primary_ownership",
          note: note ?? "Manual primary ownership correction through MCP",
          owners: {
            owners: resolvedOwners.map((owner) => ({
              bidderId: owner.bidderId,
              bidderName: owner.bidderName,
              ownershipShare: split.owners.find((entry) => entry.bidderId === owner.bidderId)!.share,
            })),
          },
        });
        return "updated" as const;
      });
      if (writeOutcome === "calcutta_not_found") {
        return text(`Error: Calcutta ${calcuttaId} is not an NFL Calcutta for ${year}.`);
      }
      if (writeOutcome === "not_auctioned") {
        return text(`Error: ${teamMatch.name} has no primary cost basis in the selected Calcutta.`);
      }
      if (writeOutcome === "approved_trade") {
        return text("Error: This team has approved trades. Preserve that history with a trade correction instead of replacing its primary split.");
      }

      const formattedOwners = resolvedOwners
        .map((owner) => `${owner.bidderName} ${Math.round(owner.share * 10000) / 100}%`)
        .join(" / ");
      return text(`Primary ownership corrected: ${teamMatch.name} · ${year} → ${formattedOwners}. This correction is recorded separately from trades.`);
    },
  );

  // ── Trade tools ───────────────────────────────────────────────────────────

  server.tool(
    "create_trade",
    "Submit a trade proposal between existing bidders for an existing, unambiguously identified team. Sales may create a short position. Any authenticated MCP client may submit a proposal. Every trade starts PENDING and requires commissioner approval before it affects standings.",
    {
      team:        z.string().describe("Full or partial team name, e.g. 'Seattle Seahawks'"),
      fromOwner:   z.string().describe("Name of the existing owner selling the stake."),
      toOwner:     z.string().describe("Name of the existing owner buying the stake."),
      percentage:  z.number().min(1).max(100).optional().describe("Percentage of team traded (1–100). Default 100."),
      price:       z.number().optional().describe("Trade price in dollars. If omitted, defaults to team's draft cost × percentage / 100."),
      tradeDate:   z.string().optional().describe("Trade date as YYYY-MM-DD. Defaults to today."),
      season:      z.number().optional().describe("Season year. Defaults to current active season."),
      calcuttaId:  z.number().int().positive().optional().describe("Selected NFL Calcutta ID. Defaults to the season's canonical NFL Calcutta."),
      notes:       z.string().optional().describe("Optional notes about the trade"),
    },
    async ({ team, fromOwner, toOwner, percentage = 100, price, tradeDate, season, calcuttaId, notes }) => {
      const teamResult = await resolveExistingTeam(team);
      if ("error" in teamResult) return text(`Error: ${teamResult.error}`);
      const fromResult = await resolveExistingBidder(fromOwner);
      if ("error" in fromResult) return text(`Error: ${fromResult.error}`);
      const toResult = await resolveExistingBidder(toOwner);
      if ("error" in toResult) return text(`Error: ${toResult.error}`);
      const t = teamResult;
      const from = fromResult;
      const to = toResult;

      const year = season ?? await resolveWritableSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);

      if (price !== undefined && (!Number.isFinite(price) || price < 0)) {
        return text("Error: Trade price must be a non-negative number.");
      }

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${sid})`,
        );
        const created = await createPendingTrade(tx, {
          seasonId: sid, calcuttaId, teamId: t.id,
          fromBidderId: from.id, toBidderId: to.id, percentage, price,
          tradeDate: tradeDate ?? todayInNewYork(), notes,
        });
        return created.ok
          ? { kind: "created" as const, tradeId: created.tradeId, effectivePrice: created.price }
          : { kind: "invalid" as const, error: created.error };
      });
      if (outcome.kind === "invalid") return text(`Error: ${outcome.error}`);

      return text(
        `Trade #${outcome.tradeId} created: ${from.name} → ${to.name}, ${percentage}% of ${t.name} for $${outcome.effectivePrice}. Status: PENDING REVIEW. Admin must approve before it affects results.`,
      );
    },
  );

  server.tool(
    "get_trade_status",
    "Returns the current approval status of a trade by its ID (pending, approved, or rejected).",
    { tradeId: z.number().describe("Trade ID returned by create_trade") },
    async ({ tradeId }) => {
      const rows = await db
        .select({
          id: tradesTable.id,
          status: tradesTable.status,
          teamId: tradesTable.teamId,
          fromBidderId: tradesTable.fromBidderId,
          toBidderId: tradesTable.toBidderId,
          price: tradesTable.price,
          percentage: tradesTable.percentage,
          decisionAt: tradesTable.decisionAt,
          decisionSource: tradesTable.decisionSource,
          voidedAt: tradesTable.voidedAt,
          voidedSource: tradesTable.voidedSource,
          voidReason: tradesTable.voidReason,
          tradeDate: tradesTable.tradeDate,
        })
        .from(tradesTable)
        .where(eq(tradesTable.id, tradeId))
        .limit(1);

      if (!rows[0]) return text(`Trade #${tradeId} not found`);
      const r = rows[0];
      const decisionAudit = r.decisionAt
        ? ` Decision recorded ${r.decisionAt.toISOString()} via ${r.decisionSource ?? "unknown channel"}.`
        : r.status === "pending"
          ? ""
          : " Historical decision; audit details are unavailable.";
      const voidAudit = r.voidedAt
        ? ` Void recorded ${r.voidedAt.toISOString()} via ${r.voidedSource ?? "unknown channel"}${r.voidReason ? `: ${r.voidReason}` : "."}`
        : "";
      return text(
        `Trade #${r.id}: ${r.percentage}% stake for $${r.price} on ${r.tradeDate} — Status: ${r.status.toUpperCase()}.${decisionAudit}${voidAudit}`,
      );
    },
  );

  server.tool(
    "set_trade_status",
    "Record an approval or rejection for a pending trade, correct an approved trade to rejected, or void an approved trade. Requires commissioner transport authorization and confirmed: true. Voiding requires a reason and removes the trade from owner standings and returns while preserving its audit trail.",
    {
      tradeId:  z.number().describe("Trade ID to update"),
      status:   z.enum(["approved", "rejected", "voided"]).describe("New status: approved, rejected, or voided"),
      confirmed: z.literal(true).describe("Must be true to explicitly confirm this irreversible decision"),
      reason: z.string().optional().describe("Required when voiding: why the approved trade is being voided"),
    },
    async ({ tradeId, status, confirmed, reason }) => {
      if (!isAdmin) return commissionerAuthorizationRequired();
      if (confirmed !== true) {
        return text("Error: Set confirmed to true to record this irreversible trade decision.");
      }
      if (status === "voided" && !reason?.trim()) {
        return text("Error: Voiding an approved trade requires a non-empty reason.");
      }

      const outcome = await db.transaction(async (tx) => {
        const initial = await tx
          .select({ seasonId: tradesTable.seasonId })
          .from(tradesTable)
          .innerJoin(calcuttaEntriesTable, eq(calcuttaEntriesTable.id, tradesTable.entryId))
          .innerJoin(calcuttasTable, eq(calcuttasTable.id, calcuttaEntriesTable.calcuttaId))
          .where(and(
            eq(tradesTable.id, tradeId),
            eq(calcuttasTable.sport, NFL_SPORT),
          ))
          .limit(1);
        if (!initial[0]) return { kind: "not_found" as const };

        await tx.execute(
          sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${initial[0].seasonId})`,
        );
        const fresh = await tx
          .select()
          .from(tradesTable)
          .where(eq(tradesTable.id, tradeId))
          .limit(1);
        if (!fresh[0]) return { kind: "not_found" as const };
        const canCorrectApprovedTrade =
          fresh[0].status === "approved" &&
          (status === "rejected" || status === "voided");
        if (fresh[0].status !== "pending" && !canCorrectApprovedTrade) {
          return { kind: "already_decided" as const };
        }
        if (status === "voided" && fresh[0].status !== "approved") {
          return { kind: "invalid" as const, error: "Only an approved trade can be voided." };
        }

        if (status === "approved") {
          const validationError = await validateMcpTradeApproval(fresh[0], tx, true);
          if (validationError) return { kind: "invalid" as const, error: validationError };
        }

        const now = new Date();
        const updates: Partial<typeof tradesTable.$inferInsert> = { status };
        if (status === "voided") {
          updates.voidedAt = now;
          updates.voidedSource = "commissioner_mcp";
          updates.voidReason = reason!.trim();
        } else {
          updates.decisionAt = now;
          updates.decisionSource = "commissioner_mcp";
        }
        await tx.update(tradesTable).set(updates).where(eq(tradesTable.id, tradeId));
        if (status === "approved") {
          const share = Number(fresh[0].percentage) / 100;
          const price = Number(fresh[0].price);
          await tx.insert(positionsTable).values([
            {
              entryId: fresh[0].entryId,
              bidderId: fresh[0].fromBidderId,
              ownershipShare: (-share).toFixed(6),
              source: "trade",
              costBasis: (-price).toFixed(2),
              tradeId: fresh[0].id,
            },
            {
              entryId: fresh[0].entryId,
              bidderId: fresh[0].toBidderId,
              ownershipShare: share.toFixed(6),
              source: "trade",
              costBasis: price.toFixed(2),
              tradeId: fresh[0].id,
            },
          ]);
        } else if (fresh[0].status === "approved") {
          await tx.delete(positionsTable).where(and(
            eq(positionsTable.entryId, fresh[0].entryId),
            eq(positionsTable.tradeId, fresh[0].id),
          ));
        }
        return { kind: "updated" as const };
      });
      if (outcome.kind === "not_found") return text(`Trade #${tradeId} not found`);
      if (outcome.kind === "already_decided") {
        return text(`Error: Trade #${tradeId} cannot be changed from its current status. Pending trades can be approved or rejected; approved trades can be rejected or voided.`);
      }
      if (outcome.kind === "invalid") return text(`Error: Cannot ${status === "voided" ? "void" : "approve"} trade: ${outcome.error}`);

      return text(
        `Trade #${tradeId} has been ${status.toUpperCase()}. ${status === "approved" ? "It now affects owner standings and returns." : status === "voided" ? "It no longer affects owner standings or returns; its audit trail is preserved." : "It has been rejected and will not affect results."}`,
      );
    },
  );

  server.tool(
    "compare_calcutta_returns",
    "Compares signed bidder or consortium values across two to six selected NFL Calcuttas. basis is required: use 'mtm' for current market-implied values and 'realized' for payouts earned from completed results. Never substitute realized values for requested MTM.",
    {
      seasons: z.array(z.number().int()).min(2).max(6).describe("Two to six season years to compare"),
      groupBy: z.enum(["bidder", "consortium"]).default("bidder"),
      basis: z.enum(["realized", "mtm"]).describe("Required: 'mtm' for current market-implied value, or 'realized' for earned payout from completed results."),
      period: z.number().int().min(0).max(22).optional(),
      membershipView: z.enum(["historical", "current"]).default("historical"),
    },
    async ({ seasons, groupBy, basis, period, membershipView }) => {
      const years = [...new Set(seasons)].sort((a, b) => a - b);
      if (years.length !== seasons.length) {
        return text("Error: seasons must be unique.");
      }
      const known = await db
        .select({ year: seasonsTable.year })
        .from(seasonsTable)
        .where(sql`${seasonsTable.year} in (${sql.join(years.map((year) => sql`${year}`), sql`, `)})`);
      const knownYears = new Set(known.map((season) => season.year));
      const missing = years.filter((year) => !knownYears.has(year));
      if (missing.length) return text(`Error: Season not found: ${missing.join(", ")}`);

      const rollup = await loadCrossCalcuttaRollup({
        years,
        basis,
        period,
        groupBy,
        membershipView,
      });
      const missingCalcuttas = years.filter(
        (year) => !rollup.calcuttas.some((calcutta) => calcutta.year === year),
      );
      if (missingCalcuttas.length) {
        return text(
          `Error: No canonical NFL Calcutta found for season${missingCalcuttas.length === 1 ? "" : "s"}: ${missingCalcuttas.join(", ")}`,
        );
      }

      return text(JSON.stringify(rollup));
    },
  );

  // ── Period-return tools ───────────────────────────────────────────────────

  server.tool(
    "get_team_period_return",
    "Returns a team's calculated cumulative value through an NFL period. basis is required: 'mtm' is current market-implied gross value; 'realized' is payout earned from completed results. Never substitute realized for requested MTM.",
    {
      team: z.string().describe("Full or partial team name"),
      basis: z.enum(["realized", "mtm"]).describe("Required: 'mtm' for current market-implied value, or 'realized' for earned payout from completed results."),
      period: z.number().int().min(0).max(22).optional(),
      season: z.number().optional().describe("Season year, defaulting to the active season"),
      ...calcuttaInput,
    },
    async ({ team, basis, period, season, calcuttaId }) => {
      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);
      const resolvedCalcuttaId = await resolveSelectedCalcuttaId(db, { seasonId: sid, calcuttaId });
      if (!resolvedCalcuttaId) return text(null);
      const calculated = (await loadCalculatedTeamReturnsForCalcutta(resolvedCalcuttaId, period)).get(t.id);
      if (!await hasConfiguredPayoutRulesForCalcutta(resolvedCalcuttaId)) {
        return text(`No payout rules are configured for ${year}; no calculated period return is available.`);
      }
      const value = calculated?.[basis];
      return text(value
        ? JSON.stringify({
            team: t.name,
            season: year,
            basis,
            throughPeriod: value.latest.sequence,
            periodLabel: value.latest.label,
            grossReturn: value.grossReturn,
            playoffStatus: value.latest.playoffStatus,
          })
        : null);
    },
  );

  server.tool(
    "set_team_period_snapshot",
    "Upserts a cumulative NFL period snapshot used to calculate returns from payout rules. Requires commissioner transport authorization.",
    {
      team: z.string().describe("Full or partial team name"),
      season: z.number().describe("Season year"),
      period: z.number().int().min(0).max(22).describe("NFL period: Week 0–18, then 19–22 for playoffs"),
      basis: z.enum(["realized", "mtm"]),
      wins: z.number().nonnegative().default(0),
      losses: z.number().nonnegative().default(0),
      ties: z.number().nonnegative().default(0),
      ptDiff: z.number().default(0),
      playoffBerth: z.number().min(0).max(1).default(0),
      divRound: z.number().min(0).max(1).default(0),
      confRound: z.number().min(0).max(1).default(0),
      sbBerth: z.number().min(0).max(1).default(0),
      winSuperBowl: z.number().min(0).max(1).default(0),
      playoffStatus: z.enum(["unknown", "alive", "clinched", "eliminated"]).default("unknown"),
      ...calcuttaInput,
    },
    async ({ team, season, period, basis, calcuttaId, ...metrics }) => {
      if (!isAdmin) return commissionerAuthorizationRequired();
      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);
      const sid = await resolveSeasonId(season);
      if (!sid) return text(`Season ${season} not found`);
      const saved = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${sid})`);
        await ensureNflSportPeriods(tx);
        const resolvedCalcuttaId = await resolveSelectedCalcuttaId(tx, { seasonId: sid, calcuttaId });
        if (!resolvedCalcuttaId) return null;
        const entry = (await tx
          .select({ id: calcuttaEntriesTable.id })
          .from(calcuttaEntriesTable)
          .innerJoin(positionsTable, and(
            eq(positionsTable.entryId, calcuttaEntriesTable.id),
            eq(positionsTable.source, "primary"),
          ))
          .where(and(
            eq(calcuttaEntriesTable.calcuttaId, resolvedCalcuttaId),
            eq(calcuttaEntriesTable.teamId, t.id),
          ))
          .limit(1))[0];
        if (!entry) return null;
        const [periodRow] = await tx
          .select({
            id: sportPeriodsTable.id,
            label: sportPeriodsTable.label,
            isPlayoff: sportPeriodsTable.isPlayoff,
          })
          .from(sportPeriodsTable)
          .where(and(
            eq(sportPeriodsTable.sport, NFL_SPORT),
            eq(sportPeriodsTable.competition, "NFL_REGULAR_SEASON"),
            eq(sportPeriodsTable.sequence, period),
          ));
        if (!periodRow) throw new Error("NFL period was not seeded.");
        if (periodRow.isPlayoff) {
          const hasBaseline = await hasCompleteNormalizedSnapshot(tx, {
            calcuttaId: resolvedCalcuttaId,
            entryId: entry.id,
            basis,
            periodSequence: 18,
          });
          if (!hasBaseline) return "missing_regular_baseline";
        }
        if (basis === "realized" && period <= 18) {
          const ledgerGame = await tx
            .select({ id: nflGamesTable.id })
            .from(nflGamesTable)
            .where(eq(nflGamesTable.seasonId, sid))
            .limit(1);
          if (ledgerGame[0]) return "game_ledger_authoritative";
        }
        const snapshot: NormalizedSnapshotWrite = {
          ...metrics,
          ordinaryWins: metrics.wins,
          marqueeWins: 0,
          ordinaryTies: metrics.ties,
          marqueeTies: 0,
          ordinaryPtDiff: metrics.ptDiff,
          marqueePtDiff: 0,
        };
        const capturedAt = new Date();
        const values = {
          entryId: entry.id,
          periodId: periodRow.id,
          basis,
          wins: metrics.wins.toString(),
          losses: metrics.losses.toString(),
          ties: metrics.ties.toString(),
          ptDiff: metrics.ptDiff.toString(),
          playoffBerth: metrics.playoffBerth.toString(),
          divRound: metrics.divRound.toString(),
          confRound: metrics.confRound.toString(),
          sbBerth: metrics.sbBerth.toString(),
          winSuperBowl: metrics.winSuperBowl.toString(),
          playoffStatus: metrics.playoffStatus,
          ordinaryWins: snapshot.ordinaryWins.toString(),
          marqueeWins: snapshot.marqueeWins.toString(),
          ordinaryTies: snapshot.ordinaryTies.toString(),
          marqueeTies: snapshot.marqueeTies.toString(),
          ordinaryPtDiff: snapshot.ordinaryPtDiff.toString(),
          marqueePtDiff: snapshot.marqueePtDiff.toString(),
          capturedAt,
        };
        await tx.insert(teamPeriodSnapshotsTable).values(values).onConflictDoUpdate({
          target: [teamPeriodSnapshotsTable.entryId, teamPeriodSnapshotsTable.periodId, teamPeriodSnapshotsTable.basis],
          set: values,
        });
        await upsertNormalizedSnapshotMetrics(tx, {
          calcuttaId: resolvedCalcuttaId,
          entryId: entry.id,
          periodId: periodRow.id,
          basis,
          snapshot,
          source: "mcp",
          snapshotAt: capturedAt,
        });
        return periodRow.label;
      });
      if (!saved) return text(`Error: ${t.name} was not auctioned in ${season}.`);
      if (saved === "missing_regular_baseline") {
        return text("Error: Save a Week 18 cumulative baseline for this team and basis before recording a playoff snapshot.");
      }
      if (saved === "game_ledger_authoritative") {
        return text("Error: Realized regular-season snapshots are derived from the NFL game ledger. Update the final game instead.");
      }
      const resolvedCalcuttaId = await resolveSelectedCalcuttaId(db, { seasonId: sid, calcuttaId });
      const grossReturn = resolvedCalcuttaId
        ? (await loadCalculatedTeamReturnsForCalcutta(resolvedCalcuttaId, period)).get(t.id)?.[basis]?.grossReturn ?? 0
        : 0;
      return text(JSON.stringify({ team: t.name, season, basis, period, periodLabel: saved, grossReturn }));
    },
  );

  server.tool(
    "get_calcutta_payout_rules",
    "Lists the configured return payout rules for a season's canonical NFL Calcutta.",
    { season: z.number().optional().describe("Season year, defaulting to the active season") },
    async ({ season }) => {
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);
      const [calcutta] = await db
        .select({ id: calcuttasTable.id })
        .from(calcuttasTable)
        .where(and(eq(calcuttasTable.seasonId, sid), eq(calcuttasTable.sport, NFL_SPORT), eq(calcuttasTable.isCanonical, true)));
      if (!calcutta) return text("[]");
      const rules = await db
        .select({
          metric: payoutRulesTable.metric,
          dollarsPerUnit: payoutRulesTable.dollarsPerUnit,
          playoffMultiplier: payoutRulesTable.playoffMultiplier,
        })
        .from(payoutRulesTable)
        .where(eq(payoutRulesTable.calcuttaId, calcutta.id));
      return text(JSON.stringify(rules.map((rule) => ({
        metric: rule.metric,
        dollarsPerUnit: Number(rule.dollarsPerUnit),
        playoffMultiplier: Number(rule.playoffMultiplier),
      }))));
    },
  );

  server.tool(
    "set_calcutta_payout_rules",
    "Replaces every payout rule for a season's canonical NFL Calcutta. Requires commissioner transport authorization. Rates are dollars per cumulative metric unit; the playoff multiplier applies to changes recorded in playoff periods.",
    {
      season: z.number().describe("Season year"),
      rules: z.array(z.object({
        metric: z.enum(["win", "pt_diff", "playoff_berth", "div_round", "conf_round", "sb_berth", "win_super_bowl"]),
        dollarsPerUnit: z.number(),
        playoffMultiplier: z.number().nonnegative().default(2),
      })).min(1),
    },
    async ({ season, rules }) => {
      if (!isAdmin) return commissionerAuthorizationRequired();
      const sid = await resolveSeasonId(season);
      if (!sid) return text(`Season ${season} not found`);
      if (new Set(rules.map((rule) => rule.metric)).size !== rules.length) {
        return text("Error: Each payout metric may only appear once.");
      }
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${sid})`);
        await ensureNflSportPeriods(tx);
        const calcutta = await getOrCreateCanonicalCalcutta(tx, { seasonId: sid, year: season });
        await tx.delete(payoutRulesTable).where(eq(payoutRulesTable.calcuttaId, calcutta.id));
        await tx.insert(payoutRulesTable).values(rules.map((rule) => ({
          calcuttaId: calcutta.id,
          metric: rule.metric,
          dollarsPerUnit: rule.dollarsPerUnit.toString(),
          playoffMultiplier: rule.playoffMultiplier.toString(),
        })));
      });
      return text(`Saved ${rules.length} payout rule${rules.length === 1 ? "" : "s"} for ${season}.`);
    },
  );

  // ── Seed tools ────────────────────────────────────────────────────────────

  server.tool(
    "get_team_seed",
    "Returns the stored playoff seed (1–7) for a team in a given season, or null if not set / team missed playoffs.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);
      const [r] = await db
        .select({ seed: teamResultsTable.seed })
        .from(teamResultsTable)
        .where(and(eq(teamResultsTable.teamId, t.id), eq(teamResultsTable.seasonId, sid)));
      return text(r?.seed != null ? r.seed : null);
    },
  );

  server.tool(
    "set_team_seed",
    "Set the playoff seed (1–7) for a team in a given season. Use null to clear a seed. Requires commissioner transport authorization.",
    {
      team:     z.string().describe("Full or partial team name, e.g. 'Seattle Seahawks' or 'Seahawks'"),
      seed:     z.number().int().min(1).max(7).nullable().describe("Playoff seed 1–7 (1 = best), or null to clear"),
      season:   z.number().optional().describe("Season year (e.g. 2025). Defaults to most recent completed season."),
      ...calcuttaInput,
    },
    async ({ team, seed, season, calcuttaId }) => {
      if (!isAdmin) return commissionerAuthorizationRequired();
      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);
      const seedWritten = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${sid})`,
        );
        const resolvedCalcuttaId = await resolveSelectedCalcuttaId(tx, {
          seasonId: sid,
          calcuttaId,
        });
        if (!resolvedCalcuttaId) return false;
        const auctionedTeam = await tx
          .select({ id: positionsTable.id })
          .from(calcuttaEntriesTable)
          .innerJoin(positionsTable, and(
            eq(positionsTable.entryId, calcuttaEntriesTable.id),
            eq(positionsTable.source, "primary"),
          ))
          .where(and(
            eq(calcuttaEntriesTable.teamId, t.id),
            eq(calcuttaEntriesTable.calcuttaId, resolvedCalcuttaId),
          ))
          .limit(1);
        if (!auctionedTeam[0]) return false;
        await tx
          .insert(teamResultsTable)
          .values({ teamId: t.id, seasonId: sid, seed })
          .onConflictDoUpdate({
            target: [teamResultsTable.teamId, teamResultsTable.seasonId],
            set: { seed },
          });
        return true;
      });
      if (!seedWritten) return text(`Error: ${t.name} was not auctioned in ${year}.`);
      return text(seed != null
        ? `Seed set: ${t.name} · ${year} → #${seed}`
        : `Seed cleared: ${t.name} · ${year}`);
    },
  );

  // ── MTM snapshot tool ─────────────────────────────────────────────────────

  server.tool(
    "set_team_mtm",
    "Record or update a legacy manual mark-to-market value for a team on a specific date. This does not create or replace a Live Tracker pipeline run. Same-date submissions overwrite the previous manual value; different dates accumulate as separate manual points. Requires commissioner transport authorization.",
    {
      team:         z.string().describe("Full or partial team name, e.g. 'Seattle Seahawks' or 'Seahawks'"),
      mtmValue:     z.number().nonnegative().describe("Mark-to-market value in dollars (e.g. 320 or 45.50)"),
      snapshotDate: z.string().optional().describe("Date as YYYY-MM-DD. Defaults to today. Submitting the same date again overwrites the previous value for that team."),
      weekNum:      z.number().int().min(0).max(22).optional().describe("Optional week label (0=pre-season, 1–18=regular, 19+=playoffs). Stored for display only."),
      season:       z.number().optional().describe("Season year (e.g. 2026). Defaults to the active season."),
      ...calcuttaInput,
    },
    async ({ team, mtmValue, snapshotDate, weekNum, season, calcuttaId }) => {
      if (!isAdmin) return commissionerAuthorizationRequired();

      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);

      let year = season;
      if (!year) {
        year = await activeSeasonYear() ?? currentYearInNewYork();
      }

      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);
      const resolvedCalcuttaId = await resolveSelectedCalcuttaId(db, {
        seasonId: sid,
        calcuttaId,
      });
      if (!resolvedCalcuttaId) {
        return text(`Error: Calcutta ${calcuttaId ?? "canonical"} is not an NFL Calcutta for ${year}.`);
      }

      const today = snapshotDate ?? todayInNewYork();

      const writeOutcome = await writeManualMtmSnapshot({
        seasonId: sid,
        calcuttaId: resolvedCalcuttaId,
        teamId: t.id,
        snapshotDate: today,
        mtmValue,
        weekNum,
      });
      if (writeOutcome.kind === "invalid_value") {
        return text("Error: MTM value must be a non-negative number.");
      }
      if (writeOutcome.kind === "not_auctioned") {
        return text(`Error: ${t.name} was not auctioned in ${year}.`);
      }
      if (writeOutcome.kind === "protected_week_zero") {
        return text(
          "Error: That team/date is the protected Kalshi Week 0 snapshot. Use Week 0 recapture instead.",
        );
      }
      const snap = writeOutcome.snapshot;

      const weekLabel = weekNum !== undefined
        ? (weekNum === 0 ? " · Pre-season" : weekNum <= 18 ? ` · Week ${weekNum}` : ` · Playoff Wk ${weekNum - 18}`)
        : "";
      return text(
        `MTM snapshot saved: ${t.name}${weekLabel} · ${today} · ${year} = $${mtmValue >= 0 ? "+" : ""}${mtmValue} (snapshot ID: ${snap.id})`,
      );
    },
  );

  return server;
}

// ─── Auth middleware ─────────────────────────────────────────────────────────

type McpPrincipal = {
  isAdmin: boolean;
  source: "admin_api_key" | "mcp_api_key" | "oauth";
};

async function checkAuth(req: Request, res: Response): Promise<McpPrincipal | null> {
  const apiKey = process.env["MCP_API_KEY"];
  if (!apiKey) {
    res.status(503).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "MCP_API_KEY secret is not configured on the server." },
      id: null,
    });
    return null;
  }
  const auth = req.headers["authorization"];
  const bearerToken = typeof auth === "string" && auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : "";
  const customApiKey = req.headers["x-api-key"];
  const staticTokens = [
    bearerToken,
    typeof customApiKey === "string" ? customApiKey : "",
  ].filter(Boolean);
  for (const token of staticTokens) {
    if (matchesAdminApiKey(token)) {
      return { isAdmin: true, source: "admin_api_key" };
    }
    if (matchesMcpApiKey(token)) {
      return { isAdmin: false, source: "mcp_api_key" };
    }
  }
  const oauthPrincipal = bearerToken ? await verifyMcpOAuthAccessToken(bearerToken) : null;
  if (!oauthPrincipal) {
    res.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${mcpProtectedResourceMetadataUrl(req)}"`,
    );
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Unauthorized. Authorize with the MCP OAuth flow or provide Authorization: Bearer <MCP_API_KEY>.",
      },
      id: null,
    });
    return null;
  }
  return { isAdmin: oauthPrincipal.isAdmin, source: "oauth" };
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function createMcpRouter(): IRouter {
  const router: IRouter = ExpressRouter();

  // POST / — main message handler (stateless: one server per request)
  router.post("/", async (req, res): Promise<void> => {
    const principal = await checkAuth(req, res);
    if (!principal) return;

    const server = buildMcpServer(principal.isAdmin);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    } finally {
      await server.close().catch(() => {});
    }
  });

  // GET / — SSE session resumption (stateless: not supported)
  router.get("/", (_req, res): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "This MCP server runs in stateless mode. GET is not supported. Use POST /api/mcp.",
      },
      id: null,
    });
  });

  // DELETE / — session termination (no-op in stateless mode)
  router.delete("/", (_req, res): void => {
    res.status(200).json({ message: "Stateless mode — no session to terminate." });
  });

  return router;
}
