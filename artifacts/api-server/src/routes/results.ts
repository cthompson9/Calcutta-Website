import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";
import { eq, and, ilike, inArray, sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  calcuttaEntriesTable,
  positionsTable,
  sportPeriodsTable,
  teamPeriodSnapshotsTable,
  teamResultsTable,
  seasonsTable,
  tradesTable,
  explicitRecordFromStoredValues,
} from "@workspace/db";
import {
  GetResultsQueryParams,
  GetResultsByOwnerQueryParams,
  GetResultsAvailabilityQueryParams,
  GetResultsCompareQueryParams,
  UpsertTeamResultBody,
  GetResultsResponse,
  GetResultsResponseItem,
  GetResultsByOwnerResponse,
  GetResultsAvailabilityResponse,
  GetResultsCompareResponse,
  UpsertTeamResultResponse,
} from "@workspace/api-zod";
import {
  loadCrossCalcuttaRollup,
  loadSeasonOwnership,
  type OwnershipSegment,
} from "../lib/seasonOwnership";
import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "../lib/ownershipShares";
import {
  hasConfiguredPayoutRulesForCalcutta,
  initializeNflWeekZeroSnapshots,
  loadCalculatedTeamReturnsForCalcutta,
  loadReturnSnapshotPeriods,
  type CalculatedTeamReturns,
} from "../lib/calcuttaReturns";
import { LEAGUE_POINT_TOTAL } from "../lib/weekZeroValuation";
import { loadCalcuttaConsortiums, loadSeasonConsortiums } from "../lib/consortiumMemberships";
import { resolveCalcuttaId } from "../lib/calcuttaContext";
import { calculateOwnerResultEconomics } from "../lib/ownerResultEconomics";
import { requireAdmin } from "../middlewares/requireAdmin";

const router: IRouter = Router();
const UpdateTeamSeedResponse = z.object({
  teamId: z.number(),
  seasonYear: z.number(),
  seed: z.number().nullable(),
}).strict();

async function resolveSeasonId(year: number): Promise<number | null> {
  const rows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, year))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function resolveNflCalcutta(
  seasonId: number,
  calcuttaId?: number | null,
): Promise<number | null> {
  return resolveCalcuttaId(db, { seasonId, calcuttaId });
}

async function loadCalcuttaTeamIds(calcuttaId: number): Promise<number[]> {
  const entries = await db
    .select({ teamId: calcuttaEntriesTable.teamId })
    .from(calcuttaEntriesTable)
    .where(eq(calcuttaEntriesTable.calcuttaId, calcuttaId));
  return entries.map((entry) => entry.teamId);
}

async function ensureWeekZeroReportingBaseline(
  seasonId: number,
  calcuttaId: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    await initializeNflWeekZeroSnapshots(tx, { calcuttaId });
  });
}

type ResultDisplay = {
  isProjectedRecord?: boolean;
  wins: string | number;
  losses: number;
  ties: number;
  ptDiff: number;
  playoffStatus: string;
  startingPoints: string | number;
  draftOrder: number | null;
  seed: number | null;
  playoffBerth: boolean;
  divRound: boolean;
  confRound: boolean;
  sbBerth: boolean;
  winSuperBowl: boolean;
  realizedReturn: string | number;
  realizedMultiple: string | number;
  netReturn: string | number;
  netPctReturn: string | number;
  markToMarket: string | number;
  netMtm?: string | number;
  dollarsPerPoint?: number | null;
  ptsToBreakeven?: number | null;
  marketStatus: "live" | "stale" | null;
  marketStatusReasons: string[];
};

type TeamOwnerEconomicPosition = {
  bidderId: number;
  bidderName: string;
  ownershipShare: number;
  originalCostBasis: number;
  tradePaid: number;
  tradeReceived: number;
};

function calculatePtsToBreakeven(
  netReturn: number,
  totalPot: number,
  totalRealizedPoints: number | null,
): number | null {
  if (
    totalPot <= 0 ||
    totalRealizedPoints == null ||
    totalRealizedPoints <= 0
  ) {
    return null;
  }
  const dollarsPerPoint = totalPot / totalRealizedPoints;
  return Number.isFinite(dollarsPerPoint) && dollarsPerPoint > 0
    ? Math.round(netReturn / dollarsPerPoint)
    : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function resultFromCalculatedSnapshots(
  legacy: typeof teamResultsTable.$inferSelect | null,
  calculated: CalculatedTeamReturns | undefined,
  cost: number,
  basis: "realized" | "mtm",
  payoutRulesConfigured: boolean,
  totalPot: number,
  totalRealizedPoints: number | null,
): ResultDisplay | null {
  const legacyDisplay = legacy
    ? {
        ...legacy,
        isProjectedRecord: basis === "mtm",
        realizedReturn: calculated?.realized?.grossReturn ?? 0,
        realizedMultiple:
          cost > 0 ? (calculated?.realized?.grossReturn ?? 0) / cost : 0,
        netReturn: (calculated?.realized?.grossReturn ?? 0) - cost,
        netPctReturn:
          cost > 0 ? ((calculated?.realized?.grossReturn ?? 0) - cost) / cost : 0,
        markToMarket: calculated?.mtm?.grossReturn ?? 0,
        netMtm: (calculated?.mtm?.grossReturn ?? 0) - cost,
        dollarsPerPoint: null,
        ptsToBreakeven: null,
        marketStatus: calculated?.mtm?.marketStatus ?? null,
        marketStatusReasons: calculated?.mtm?.marketStatusReasons ?? [],
      }
    : null;
  if (!payoutRulesConfigured) return legacyDisplay;
  const selected = calculated?.[basis];
  if (!calculated || !selected) {
    // The legacy response contract requires numeric financial fields. Missing
    // calculated coverage is represented explicitly by the surrounding
    // coverage flags and zero-valued compatibility fields, never stored entry
    // economics.
    if (legacyDisplay) return legacyDisplay;
    const realizedReturn = calculated?.realized?.grossReturn ?? 0;
    const markToMarket = calculated?.mtm?.grossReturn ?? 0;
    return {
      isProjectedRecord: basis === "mtm",
      wins: 0,
      losses: 0,
      ties: 0,
      ptDiff: 0,
      playoffStatus: "unknown",
      startingPoints: "150",
      draftOrder: null,
      seed: null,
      playoffBerth: false,
      divRound: false,
      confRound: false,
      sbBerth: false,
      winSuperBowl: false,
      realizedReturn,
      realizedMultiple: 0,
      netReturn: realizedReturn - cost,
      netPctReturn: cost > 0 ? (realizedReturn - cost) / cost : 0,
      markToMarket,
      netMtm: markToMarket - cost,
      dollarsPerPoint: null,
      ptsToBreakeven: null,
      marketStatus: calculated?.mtm?.marketStatus ?? null,
      marketStatusReasons: calculated?.mtm?.marketStatusReasons ?? [],
    };
  }
  const latest = selected.latest;

  // Realized and MTM coverage are independent. A valid snapshot for the
  // selected view must never zero the other legacy financial field.
  const realizedReturn = calculated.realized?.grossReturn ?? 0;
  const markToMarket = calculated.mtm?.grossReturn ?? 0;
  const netReturn = realizedReturn - cost;
  const netMtm = markToMarket - cost;
  const dollarsPerPoint =
    totalRealizedPoints != null && totalRealizedPoints > 0 && totalPot > 0
      ? totalPot / totalRealizedPoints
      : null;
  return {
    isProjectedRecord: basis === "mtm",
    wins: latest.wins,
    losses: latest.losses,
    ties: latest.ties,
    ptDiff: latest.ptDiff,
    playoffStatus: latest.playoffStatus,
    startingPoints: legacy?.startingPoints ?? "150",
    draftOrder: legacy?.draftOrder ?? null,
    seed: legacy?.seed ?? null,
    playoffBerth: latest.playoffBerth >= 0.999999,
    divRound: latest.divRound >= 0.999999,
    confRound: latest.confRound >= 0.999999,
    sbBerth: latest.sbBerth >= 0.999999,
    winSuperBowl: latest.winSuperBowl >= 0.999999,
    realizedReturn,
    realizedMultiple: cost > 0 ? realizedReturn / cost : 0,
    netReturn,
    netPctReturn: cost > 0 ? netReturn / cost : 0,
    markToMarket,
    netMtm,
    dollarsPerPoint,
    ptsToBreakeven: calculatePtsToBreakeven(
      netReturn,
      totalPot,
      totalRealizedPoints,
    ),
    marketStatus: calculated.mtm?.marketStatus ?? null,
    marketStatusReasons: calculated.mtm?.marketStatusReasons ?? [],
  };
}

// Helper: build TeamResultRow with effective current owners and season-scoped cost
function buildTeamResult(
  team: typeof teamsTable.$inferSelect,
  result: ResultDisplay | null,
  owners: TeamOwnerEconomicPosition[],
  ownershipSegments: OwnershipSegment[],
  cost: number,
) {
  const base = {
    teamId: team.id,
    teamName: team.name,
    conference: team.conference,
    division: team.division,
    owners: owners.map((owner) => {
      const economics = calculateOwnerResultEconomics({
        effectiveShare: owner.ownershipShare,
        originalCostBasis: owner.originalCostBasis,
        tradePaid: owner.tradePaid,
        tradeReceived: owner.tradeReceived,
        realizedTeamGross: result ? Number(result.realizedReturn) : 0,
        mtmTeamGross: result ? Number(result.markToMarket) : 0,
        dollarsPerPoint: result?.dollarsPerPoint ?? null,
      });
      return {
        bidderId: owner.bidderId,
        bidderName: owner.bidderName,
        ownershipShare: owner.ownershipShare,
        ...economics,
      };
    }),
    ownershipSegments,
    cost,
  };

  if (!result) {
    return {
      ...base,
      wins: 0,
      losses: 0,
      ties: 0,
      ptDiff: 0,
      playoffStatus: "unknown" as const,
      startingPoints: 150,
      draftOrder: null,
      seed: null,
      playoffBerth: false,
      divRound: false,
      confRound: false,
      sbBerth: false,
      winSuperBowl: false,
      realizedReturn: 0,
      realizedMultiple: 0,
      netReturn: 0,
      netPctReturn: 0,
      markToMarket: 0,
      netMtm: 0,
      ptsToBreakeven: null,
      marketStatus: null,
      marketStatusReasons: [],
    };
  }

  const record = result.isProjectedRecord
    ? { wins: Number(result.wins), losses: Number(result.losses), ties: Number(result.ties) }
    : explicitRecordFromStoredValues(result.wins, result.losses, result.ties);
  return {
    ...base,
    wins: record.wins,
    losses: record.losses,
    ties: record.ties,
    ptDiff: result.ptDiff,
    playoffStatus: result.playoffStatus,
    startingPoints: Number(result.startingPoints),
    draftOrder: result.draftOrder,
    seed: result.seed,
    playoffBerth: result.playoffBerth,
    divRound: result.divRound,
    confRound: result.confRound,
    sbBerth: result.sbBerth,
    winSuperBowl: result.winSuperBowl,
    realizedReturn: roundMoney(Number(result.realizedReturn)),
    realizedMultiple: Number(result.realizedMultiple),
    netReturn: roundMoney(Number(result.netReturn)),
    netPctReturn: Number(result.netPctReturn),
    markToMarket: roundMoney(Number(result.markToMarket)),
    netMtm: roundMoney(Number(result.netMtm ?? Number(result.markToMarket) - cost)),
    ptsToBreakeven: result.ptsToBreakeven ?? null,
    marketStatus: result.marketStatus,
    marketStatusReasons: result.marketStatusReasons,
  };
}

// Helper: build a per-owner team row in the SAME schema as buildTeamResult,
// but with financial fields scaled to this owner's economic position.
// Team-level NFL stats (wins, ptDiff, seed, playoff flags, etc.) are preserved.
function buildOwnerTeamResult(
  team: typeof teamsTable.$inferSelect,
  result: ResultDisplay | null,
  args: {
    bidderId: number;
    bidderName: string;
    effectiveShare: number;
    ownerCost: number;
    ownershipSegments: OwnershipSegment[];
  },
) {
  const {
    bidderId,
    bidderName,
    effectiveShare,
    ownerCost,
    ownershipSegments,
  } = args;

  const economics = calculateOwnerResultEconomics({
    effectiveShare,
    originalCostBasis: ownerCost,
    tradePaid: 0,
    tradeReceived: 0,
    realizedTeamGross: result ? Number(result.realizedReturn) : 0,
    mtmTeamGross: result ? Number(result.markToMarket) : 0,
    dollarsPerPoint: result?.dollarsPerPoint ?? null,
  });
  // This reflects THIS owner's signed effective share. A negative percentage is
  // a short position, not a current-team owner label.
  const owners = [{ bidderId, bidderName, ownershipShare: effectiveShare, ...economics }];

  // Owner-specific cost basis is what this bidder paid after trade economics.
  const base = {
    teamId: team.id,
    teamName: team.name,
    conference: team.conference,
    division: team.division,
    owners,
    ownershipSegments,
    cost: Math.round(ownerCost * 100) / 100,
  };

  if (!result) {
    return {
      ...base,
      wins: 0,
      losses: 0,
      ties: 0,
      ptDiff: 0,
      playoffStatus: "unknown" as const,
      startingPoints: 150,
      draftOrder: null,
      seed: null,
      playoffBerth: false,
      divRound: false,
      confRound: false,
      sbBerth: false,
      winSuperBowl: false,
      realizedReturn: economics.realizedGross,
      realizedMultiple: 0,
      netReturn: economics.net,
      netPctReturn: ownerCost > 0 ? economics.net / ownerCost : 0,
      markToMarket: economics.mtmGross,
      netMtm: economics.mtmNet,
      ptsToBreakeven: economics.ptsToBreakeven,
      marketStatus: null,
      marketStatusReasons: [],
    };
  }

  // Owner-scaled financials
  const realizedReturn = Number(result.realizedReturn) * effectiveShare;
  const markToMarket = Number(result.markToMarket) * effectiveShare;
  const netMtm = markToMarket - ownerCost;
  const netReturn = realizedReturn - ownerCost;
  const realizedMultiple = ownerCost > 0 ? realizedReturn / ownerCost : 0;
  const netPctReturn = ownerCost > 0 ? netReturn / ownerCost : 0;
  const ptsToBreakeven =
    result.dollarsPerPoint != null && result.dollarsPerPoint > 0
      ? Math.round(netReturn / result.dollarsPerPoint)
      : null;
  const record = result.isProjectedRecord
    ? { wins: Number(result.wins), losses: Number(result.losses), ties: Number(result.ties) }
    : explicitRecordFromStoredValues(result.wins, result.losses, result.ties);

  return {
    ...base,
    // Preserve team-level NFL stats verbatim
    wins: record.wins,
    losses: record.losses,
    ties: record.ties,
    ptDiff: result.ptDiff,
    playoffStatus: result.playoffStatus,
    startingPoints: Number(result.startingPoints),
    draftOrder: result.draftOrder,
    seed: result.seed,
    playoffBerth: result.playoffBerth,
    divRound: result.divRound,
    confRound: result.confRound,
    sbBerth: result.sbBerth,
    winSuperBowl: result.winSuperBowl,
    // Owner-specific financials
    realizedReturn: Math.round(realizedReturn * 100) / 100,
    realizedMultiple: Math.round(realizedMultiple * 10000) / 10000,
    netReturn: Math.round(netReturn * 100) / 100,
    netPctReturn: Math.round(netPctReturn * 10000) / 10000,
    markToMarket: Math.round(markToMarket * 100) / 100,
    netMtm: Math.round(netMtm * 100) / 100,
    ptsToBreakeven,
    marketStatus: result.marketStatus,
    marketStatusReasons: result.marketStatusReasons,
  };
}

// PATCH /results/seed — set a team's playoff seed for a season (admin only)
router.patch("/results/seed", requireAdmin, async (req, res): Promise<void> => {
  const { teamId, seasonYear, seed, calcuttaId } = req.body as {
    teamId: number;
    seasonYear: number;
    seed: number | null;
    calcuttaId?: number;
  };
  if (!teamId || !seasonYear) {
    sendParsedJson(res, ErrorResponse, { error: "teamId and seasonYear required" }, 400);
    return;
  }
  const seasonId = await resolveSeasonId(seasonYear);
  if (!seasonId) {
    sendParsedJson(res, ErrorResponse, { error: `Season ${seasonYear} not found` }, 400);
    return;
  }
  const resolvedCalcuttaId = await resolveNflCalcutta(seasonId, calcuttaId);
  if (!resolvedCalcuttaId) {
    sendParsedJson(res, ErrorResponse, { error: "Calcutta must be an NFL pool in the requested season." }, 400);
    return;
  }
  const seedWritten = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    const auctionedTeam = await tx
      .select({ id: positionsTable.id })
      .from(calcuttaEntriesTable)
      .innerJoin(positionsTable, and(
        eq(positionsTable.entryId, calcuttaEntriesTable.id),
        eq(positionsTable.source, "primary"),
      ))
      .where(
        and(
          eq(calcuttaEntriesTable.teamId, teamId),
          eq(calcuttaEntriesTable.calcuttaId, resolvedCalcuttaId),
        ),
      )
      .limit(1);
    if (!auctionedTeam[0]) return false;
    await tx
      .insert(teamResultsTable)
      .values({ teamId, seasonId, seed })
      .onConflictDoUpdate({
        target: [teamResultsTable.teamId, teamResultsTable.seasonId],
        set: { seed },
      });
    return true;
  });
  if (!seedWritten) {
    sendParsedJson(res, ErrorResponse, {
      error: "Team is not auctioned in this season and cannot receive a playoff seed.",
    }, 400);
    return;
  }
  sendParsedJson(res, UpdateTeamSeedResponse, { teamId, seasonYear, seed });
});

// GET /results?season=YYYY
router.get("/results", async (req, res): Promise<void> => {
  const parsed = GetResultsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const { season, calcuttaId, conference, search, period, basis } = parsed.data;
  const selectedBasis = basis ?? "realized";

  // Unknown season → empty list, never fall back to another season
  const seasonId = await resolveSeasonId(season);
  if (!seasonId) {
    sendParsedJson(res, GetResultsResponse, []);
    return;
  }
  const resolvedCalcuttaId = await resolveNflCalcutta(seasonId, calcuttaId);
  if (!resolvedCalcuttaId) {
    sendParsedJson(res, ErrorResponse, { error: "Calcutta must be an NFL pool in the requested season." }, 400);
    return;
  }
  await ensureWeekZeroReportingBaseline(seasonId, resolvedCalcuttaId);
  const calcuttaTeamIds = await loadCalcuttaTeamIds(resolvedCalcuttaId);

  let teamQuery = db.select().from(teamsTable).$dynamic();
  if (conference)
    teamQuery = teamQuery.where(eq(teamsTable.conference, conference));
  if (search)
    teamQuery = teamQuery.where(ilike(teamsTable.name, `%${search}%`));
  const allTeams = await teamQuery.orderBy(
    teamsTable.conference,
    teamsTable.division,
    teamsTable.name,
  );

  const resultsMap = new Map<number, typeof teamResultsTable.$inferSelect>();
  const results = await db
    .select()
    .from(teamResultsTable)
    .where(eq(teamResultsTable.seasonId, seasonId));
  for (const r of results) resultsMap.set(r.teamId, r);
  const calculatedResults = await loadCalculatedTeamReturnsForCalcutta(
    resolvedCalcuttaId,
    period,
  );
  // Week 0 is the fixed 150-point opening allocation and can be valued from
  // the default rubric before a commissioner saves custom payout rates.
  const payoutRulesConfigured =
    period === 0 || await hasConfiguredPayoutRulesForCalcutta(resolvedCalcuttaId);

  // Selected-Calcutta primary position costs
  const auctionRows = await db
    .select({
      entryId: calcuttaEntriesTable.id,
      teamId: calcuttaEntriesTable.teamId,
      costBasis: positionsTable.costBasis,
    })
    .from(calcuttaEntriesTable)
    .innerJoin(positionsTable, and(
      eq(positionsTable.entryId, calcuttaEntriesTable.id),
      eq(positionsTable.source, "primary"),
    ))
    .where(and(
      eq(calcuttaEntriesTable.calcuttaId, resolvedCalcuttaId),
      inArray(calcuttaEntriesTable.teamId, calcuttaTeamIds),
    ));
  const auctionPriceMap = new Map<number, number>();
  for (const row of auctionRows) {
    auctionPriceMap.set(row.teamId, (auctionPriceMap.get(row.teamId) ?? 0) + Number(row.costBasis));
  }
  const totalPot = [...auctionPriceMap.values()].reduce((sum, cost) => sum + cost, 0);
  const realizedCoverageComplete =
    auctionPriceMap.size > 0 &&
    [...auctionPriceMap.keys()].every((teamId) => calculatedResults.get(teamId)?.realized != null);
  const totalRealizedPoints = realizedCoverageComplete
    ? LEAGUE_POINT_TOTAL
    : null;

  // Effective ownership (applies approved trades)
  const ownership = await loadSeasonOwnership(seasonId, resolvedCalcuttaId);

  // Only include teams that have bidders or results for this specific season
  const rows = allTeams
    .filter(
      (t) => calcuttaTeamIds.includes(t.id) &&
        (ownership.currentOwnersByTeam.has(t.id) || resultsMap.has(t.id)),
    )
    .map((t) => {
      const cost = auctionPriceMap.get(t.id) ?? 0;
      // Team reporting must expose the full signed ownership ledger, not only
      // positive current owners. This keeps short sellers visible and gives
      // clients owner-level economics that require no re-scaling.
      const currentOwners: TeamOwnerEconomicPosition[] = [...ownership.byBidder]
        .flatMap(([bidderId, teamPositions]) => {
          const position = teamPositions.get(t.id);
          if (!position) return [];
          const cost = position.originalCostBasis + position.tradePaid - position.tradeReceived;
          if (Math.abs(position.effectiveShare) < 0.00005 && Math.abs(cost) < 0.005) return [];
          return [{
            bidderId,
            bidderName: ownership.bidderNames.get(bidderId) ?? "Unknown",
            ownershipShare: position.effectiveShare,
            originalCostBasis: position.originalCostBasis,
            tradePaid: position.tradePaid,
            tradeReceived: position.tradeReceived,
          }];
        })
        .sort((left, right) => right.ownershipShare - left.ownershipShare);
      const ownershipSegments = ownership.ownershipSegmentsByTeam.get(t.id) ?? [];
      return buildTeamResult(
        t,
        resultFromCalculatedSnapshots(
          resultsMap.get(t.id) ?? null,
          calculatedResults.get(t.id),
          cost,
          selectedBasis,
          payoutRulesConfigured,
          totalPot,
          totalRealizedPoints,
        ),
        currentOwners,
        ownershipSegments,
        cost,
      );
    });

  sendParsedJson(res, GetResultsResponse, rows);
});

// GET /results/by-owner?season=YYYY
// Accounts for approved trades: effective ownership, net costs, and returns are
// adjusted so each owner sees their real economic position after all trades.
router.get("/results/by-owner", async (req, res): Promise<void> => {
  const parsed = GetResultsByOwnerQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const { season, calcuttaId, period, basis } = parsed.data;
  const selectedBasis = basis ?? "realized";
  const membershipView = req.query.membershipView === "current" ? "current" : "historical";

  // Unknown season → safe empty response
  const seasonId = await resolveSeasonId(season);
  if (!seasonId) {
    sendParsedJson(res, GetResultsByOwnerResponse, []);
    return;
  }
  const resolvedCalcuttaId = await resolveNflCalcutta(seasonId, calcuttaId);
  if (!resolvedCalcuttaId) {
    sendParsedJson(res, ErrorResponse, { error: "Calcutta must be an NFL pool in the requested season." }, 400);
    return;
  }
  await ensureWeekZeroReportingBaseline(seasonId, resolvedCalcuttaId);
  const calcuttaTeamIds = await loadCalcuttaTeamIds(resolvedCalcuttaId);

  const allTeams = await db.select().from(teamsTable);
  const allBidders = await db
    .select({
      id: biddersTable.id,
      name: biddersTable.name,
    })
    .from(biddersTable);

  const resultsMap = new Map<number, typeof teamResultsTable.$inferSelect>();
  const seasonResults = await db
    .select()
    .from(teamResultsTable)
    .where(eq(teamResultsTable.seasonId, seasonId));
  for (const r of seasonResults) resultsMap.set(r.teamId, r);
  const calculatedResults = await loadCalculatedTeamReturnsForCalcutta(
    resolvedCalcuttaId,
    period,
  );
  const payoutRulesConfigured =
    period === 0 || await hasConfiguredPayoutRulesForCalcutta(resolvedCalcuttaId);

  // Selected-Calcutta primary position costs
  const auctionRows = await db
    .select({
      entryId: calcuttaEntriesTable.id,
      teamId: calcuttaEntriesTable.teamId,
      costBasis: positionsTable.costBasis,
    })
    .from(calcuttaEntriesTable)
    .innerJoin(positionsTable, and(
      eq(positionsTable.entryId, calcuttaEntriesTable.id),
      eq(positionsTable.source, "primary"),
    ))
    .where(and(
      eq(calcuttaEntriesTable.calcuttaId, resolvedCalcuttaId),
      inArray(calcuttaEntriesTable.teamId, calcuttaTeamIds),
    ));
  const auctionPriceMap = new Map<number, number>();
  for (const row of auctionRows) {
    auctionPriceMap.set(row.teamId, (auctionPriceMap.get(row.teamId) ?? 0) + Number(row.costBasis));
  }
  const totalPot = [...auctionPriceMap.values()].reduce((sum, cost) => sum + cost, 0);
  const realizedCoverageComplete =
    auctionPriceMap.size > 0 &&
    [...auctionPriceMap.keys()].every((teamId) => calculatedResults.get(teamId)?.realized != null);
  const totalRealizedPoints = realizedCoverageComplete
    ? LEAGUE_POINT_TOTAL
    : null;

  // Effective ownership from shared helper
  const ownership = await loadSeasonOwnership(seasonId, resolvedCalcuttaId);
  const consortiumByBidder = calcuttaId == null
    ? await loadSeasonConsortiums(seasonId, membershipView)
    : await loadCalcuttaConsortiums(resolvedCalcuttaId, membershipView);

  const teamMap = new Map(allTeams.map((t) => [t.id, t]));
  const bidderNameMap = new Map(allBidders.map((b) => [b.id, b.name]));

  // ── Aggregate per owner ──────────────────────────────────────────────────
  type OwnerAgg = {
    bidderId: number;
    bidderName: string;
    consortium: string | null;
    teamCount: number;
    totalCost: number;
    totalRealizedReturn: number;
    totalNetReturn: number;
    totalMtm: number;
    totalNetMtm: number;
    teams: ReturnType<typeof buildOwnerTeamResult>[];
  };

  const ownerAggMap = new Map<number, OwnerAgg>();

  // Initialize only season participants
  for (const bidderId of ownership.participantIds) {
    const name =
      bidderNameMap.get(bidderId) ??
      ownership.bidderNames.get(bidderId) ??
      "Unknown";
    ownerAggMap.set(bidderId, {
      bidderId,
      bidderName: name,
      consortium: consortiumByBidder.get(bidderId) ?? null,
      teamCount: 0,
      totalCost: 0,
      totalRealizedReturn: 0,
      totalNetReturn: 0,
      totalMtm: 0,
      totalNetMtm: 0,
      teams: [],
    });
  }

  // Iterate all (bidderId, teamId) pairs with economic interest
  for (const [bidderId, teamMap2] of ownership.byBidder) {
    const agg = ownerAggMap.get(bidderId);
    if (!agg) continue;

    for (const [teamId, entry] of teamMap2) {
      // Skip entries with no meaningful economic interest
      if (
        Math.abs(entry.effectiveShare) < 0.00005 &&
        entry.tradePaid === 0 &&
        entry.tradeReceived === 0
      )
        continue;

      const team = teamMap.get(teamId);
      if (!team) continue;
      const seasonAuctionPrice = auctionPriceMap.get(teamId) ?? 0;
      const result = resultFromCalculatedSnapshots(
        resultsMap.get(teamId) ?? null,
        calculatedResults.get(teamId),
        seasonAuctionPrice,
        selectedBasis,
        payoutRulesConfigured,
        totalPot,
        totalRealizedPoints,
      );

      // Owner-result reporting preserves the signed ledger position. A short
      // seller receives the inverse of a long holder's team-level outcome.
      const effectiveShare = entry.effectiveShare;

      // Cost basis: season auction price × original share + trade buys - trade sells
      const originalCostBasis = seasonAuctionPrice * entry.originalShare;
      const ownerCost =
        originalCostBasis + entry.tradePaid - entry.tradeReceived;

      // Returns scaled by effective (post-trade) share
      const realizedReturn = result
        ? Number(result.realizedReturn) * effectiveShare
        : 0;
      const markToMarket = result
        ? Number(result.markToMarket) * effectiveShare
        : 0;
      const netReturn = realizedReturn - ownerCost;
      const netMtm = markToMarket - ownerCost;

      agg.teamCount += effectiveShare;
      agg.totalCost += ownerCost;
      agg.totalRealizedReturn += realizedReturn;
      agg.totalNetReturn += netReturn;
      agg.totalMtm += markToMarket;
      agg.totalNetMtm += netMtm;

      // Add owner-specific team row once per owner. Financial fields are scaled
      // to this bidder's economic position; team-level NFL stats preserved.
      if (!agg.teams.find((t) => t.teamId === teamId)) {
        agg.teams.push(
          buildOwnerTeamResult(team, result, {
            bidderId,
            bidderName: agg.bidderName,
            effectiveShare,
            ownerCost,
            ownershipSegments: (
              ownership.ownershipSegmentsByTeam.get(teamId) ?? []
            ).filter((segment) => segment.bidderId === bidderId),
          }),
        );
      }
    }
  }

  const ownerRows = Array.from(ownerAggMap.values())
    .filter((o) => Math.abs(o.teamCount) > 0.00005 || o.totalCost !== 0)
    .map((o) => ({
      ...o,
      teamCount: Math.round(o.teamCount * 100) / 100,
      totalCost: Math.round(o.totalCost * 100) / 100,
      totalRealizedReturn: Math.round(o.totalRealizedReturn * 100) / 100,
      totalNetReturn: Math.round(o.totalNetReturn * 100) / 100,
      netPctReturn:
        o.totalCost > 0
          ? Math.round((o.totalNetReturn / o.totalCost) * 10000) / 10000
          : 0,
      totalMtm: Math.round(o.totalMtm * 100) / 100,
      totalNetMtm: Math.round(o.totalNetMtm * 100) / 100,
      marketStatus: o.teams.some((team) => team.marketStatus === "stale")
        ? "stale" as const
        : o.teams.some((team) => team.marketStatus === "live")
          ? "live" as const
          : null,
      marketStatusReasons: [...new Set(
        o.teams.flatMap((team) => team.marketStatusReasons),
      )],
      teams: o.teams.sort((a, b) => a.teamName.localeCompare(b.teamName)),
    }))
    .sort((a, b) =>
      selectedBasis === "mtm"
        ? b.totalNetMtm - a.totalNetMtm
        : b.totalNetReturn - a.totalNetReturn,
    );

  sendParsedJson(res, GetResultsByOwnerResponse, ownerRows);
});

// GET /results/availability?season=YYYY&basis=mtm
// Exposes actual stored reporting periods instead of relying on the full NFL
// template, which includes future periods during an in-progress season.
router.get("/results/availability", async (req, res): Promise<void> => {
  const parsed = GetResultsAvailabilityQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }

  const seasonId = await resolveSeasonId(parsed.data.season);
  if (!seasonId) {
    sendParsedJson(res, GetResultsAvailabilityResponse, { latestPeriod: null, previousPeriod: null });
    return;
  }
  const resolvedCalcuttaId = await resolveNflCalcutta(seasonId, parsed.data.calcuttaId);
  if (!resolvedCalcuttaId) {
    sendParsedJson(res, ErrorResponse, { error: "Calcutta must be an NFL pool in the requested season." }, 400);
    return;
  }
  await ensureWeekZeroReportingBaseline(seasonId, resolvedCalcuttaId);
  const periods = await loadReturnSnapshotPeriods(
    seasonId,
    parsed.data.basis ?? "realized",
    resolvedCalcuttaId,
  );
  sendParsedJson(res, GetResultsAvailabilityResponse, {
    latestPeriod: periods.at(-1) ?? null,
    previousPeriod: periods.at(-2) ?? null,
  });
});

// GET /results/compare?seasons=2025,2026
// Cross-Calcutta comparisons are computed from signed normalized position
// entries. A missing snapshot is represented explicitly in each cell instead
// of suppressing a bidder or silently borrowing another season's data.
router.get("/results/compare", async (req, res): Promise<void> => {
  const parsed = GetResultsCompareQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const selectedYears = parsed.data.seasons
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isInteger);
  const years = [...new Set(selectedYears)].sort((a, b) => a - b);
  if (years.length < 2 || years.length > 6 || years.length !== selectedYears.length) {
    sendParsedJson(res, ErrorResponse, {
      error: "seasons must contain two to six unique numeric season years.",
    }, 400);
    return;
  }

  const available = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(sql`${seasonsTable.year} in (${sql.join(years.map((year) => sql`${year}`), sql`, `)})`);
  const availableYears = new Set(available.map((season) => season.year));
  const missing = years.filter((year) => !availableYears.has(year));
  if (missing.length) {
    sendParsedJson(res, ErrorResponse, {
      error: `Season${missing.length === 1 ? "" : "s"} not found: ${missing.join(", ")}`,
    }, 400);
    return;
  }

  const rollup = await loadCrossCalcuttaRollup({
    years,
    period: parsed.data.period,
    basis: parsed.data.basis ?? "realized",
    membershipView: parsed.data.membershipView ?? "historical",
    groupBy: parsed.data.groupBy ?? "bidder",
  });
  const missingCalcuttas = years.filter(
    (year) => !rollup.calcuttas.some((calcutta) => calcutta.year === year),
  );
  if (missingCalcuttas.length) {
    sendParsedJson(res, ErrorResponse, {
      error: `No canonical NFL Calcutta found for season${missingCalcuttas.length === 1 ? "" : "s"}: ${missingCalcuttas.join(", ")}`,
    }, 400);
    return;
  }
  sendParsedJson(res, GetResultsCompareResponse, rollup);
});

// POST /results/upsert
router.post("/results/upsert", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpsertTeamResultBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const data = parsed.data;
  const wins = data.wins ?? 0;
  const losses = data.losses ?? 0;
  const ties = data.ties ?? 0;
  const recordValues = [wins, losses, ties];
  if (recordValues.some((value) => !Number.isInteger(value) || value < 0)) {
    sendParsedJson(res, ErrorResponse, {
      error:
        "wins, losses, and ties must be whole numbers greater than or equal to zero",
    }, 400);
    return;
  }
  if (wins + losses + ties > 17) {
    sendParsedJson(res, ErrorResponse, {
      error: "wins, losses, and ties cannot total more than 17 games",
    }, 400);
    return;
  }
  const seasonId = await resolveSeasonId(data.seasonYear);
  if (!seasonId) {
    sendParsedJson(res, ErrorResponse, { error: `Season ${data.seasonYear} not found` }, 400);
    return;
  }
  const resolvedCalcuttaId = await resolveNflCalcutta(seasonId, data.calcuttaId);
  if (!resolvedCalcuttaId) {
    sendParsedJson(res, ErrorResponse, { error: "Calcutta must be an NFL pool in the requested season." }, 400);
    return;
  }

  const writeOutcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    const auctionedTeam = await tx
      .select({
        entryId: calcuttaEntriesTable.id,
        costBasis: positionsTable.costBasis,
      })
      .from(calcuttaEntriesTable)
      .innerJoin(positionsTable, and(
        eq(positionsTable.entryId, calcuttaEntriesTable.id),
        eq(positionsTable.source, "primary"),
      ))
      .where(and(
        eq(calcuttaEntriesTable.teamId, data.teamId),
        eq(calcuttaEntriesTable.calcuttaId, resolvedCalcuttaId),
      ));
    if (!auctionedTeam[0]) return { kind: "not_auctioned" as const };

    const cost = auctionedTeam.reduce((sum, row) => sum + Number(row.costBasis), 0);
    const objectiveValues = {
      wins: wins.toString(),
      losses,
      ties,
      ptDiff: data.ptDiff ?? 0,
      playoffStatus: data.playoffStatus ?? "unknown",
      draftOrder: data.draftOrder ?? null,
      playoffBerth: data.playoffBerth ?? false,
      divRound: data.divRound ?? false,
      confRound: data.confRound ?? false,
      sbBerth: data.sbBerth ?? false,
      winSuperBowl: data.winSuperBowl ?? false,
    };
    const [row] = await tx
      .insert(teamResultsTable)
      .values({
        teamId: data.teamId,
        seasonId,
        ...objectiveValues,
        startingPoints: (data.startingPoints ?? 150).toString(),
      })
      .onConflictDoUpdate({
        target: [teamResultsTable.teamId, teamResultsTable.seasonId],
        set: objectiveValues,
      })
      .returning();
    return { kind: "saved" as const, row, cost };
  });
  if (writeOutcome.kind === "not_auctioned") {
    sendParsedJson(res, ErrorResponse, {
      error: "Team is not auctioned in this season and cannot receive results.",
    }, 400);
    return;
  }
  const cost = writeOutcome.cost;
  const calculated = await loadCalculatedTeamReturnsForCalcutta(resolvedCalcuttaId);
  const calculatedTeam = calculated.get(data.teamId);
  const realizedReturn = calculatedTeam?.realized?.grossReturn ?? 0;
  const markToMarket = calculatedTeam?.mtm?.grossReturn ?? 0;
  const row = {
    ...writeOutcome.row,
    realizedReturn,
    realizedMultiple: cost > 0 ? realizedReturn / cost : 0,
    netReturn: realizedReturn - cost,
    netPctReturn: cost > 0 ? (realizedReturn - cost) / cost : 0,
    markToMarket,
    marketStatus: calculatedTeam?.mtm?.marketStatus ?? null,
    marketStatusReasons: calculatedTeam?.mtm?.marketStatusReasons ?? [],
  };

  // Build response in TeamResultRow shape
  const teamInfo = await db
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.id, data.teamId))
    .limit(1);
  const team = teamInfo[0];
  if (!team) {
    sendParsedJson(res, ErrorResponse, { error: `Team ${data.teamId} not found` }, 400);
    return;
  }

  const ownership = await loadSeasonOwnership(seasonId, resolvedCalcuttaId);
  const currentOwners: TeamOwnerEconomicPosition[] = [...ownership.byBidder]
    .flatMap(([bidderId, teamPositions]) => {
      const position = teamPositions.get(data.teamId);
      if (!position) return [];
      const positionCost = position.originalCostBasis + position.tradePaid - position.tradeReceived;
      if (Math.abs(position.effectiveShare) < 0.00005 && Math.abs(positionCost) < 0.005) return [];
      return [{
        bidderId,
        bidderName: ownership.bidderNames.get(bidderId) ?? "Unknown",
        ownershipShare: position.effectiveShare,
        originalCostBasis: position.originalCostBasis,
        tradePaid: position.tradePaid,
        tradeReceived: position.tradeReceived,
      }];
    })
    .sort((left, right) => right.ownershipShare - left.ownershipShare);
  const ownershipSegments =
    ownership.ownershipSegmentsByTeam.get(data.teamId) ?? [];

  sendParsedJson(
    res,
    UpsertTeamResultResponse,
    buildTeamResult(team, row, currentOwners, ownershipSegments, cost),
  );
});

export default router;
