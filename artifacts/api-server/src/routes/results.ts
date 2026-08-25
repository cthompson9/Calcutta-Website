import { Router, type IRouter } from "express";
import { eq, and, ilike, sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  teamBiddersTable,
  teamResultsTable,
  teamSeasonAuctionsTable,
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
} from "@workspace/api-zod";
import {
  loadCrossCalcuttaRollup,
  loadSeasonOwnership,
  type OwnershipSegment,
} from "../lib/seasonOwnership";
import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "../lib/ownershipShares";
import {
  hasConfiguredPayoutRules,
  initializeNflWeekZeroSnapshots,
  loadCalculatedTeamReturns,
  loadReturnSnapshotPeriods,
  type CalculatedTeamReturns,
} from "../lib/calcuttaReturns";
import { loadSeasonConsortiums } from "../lib/consortiumMemberships";

const router: IRouter = Router();

function isAdminRequest(req: import("express").Request): boolean {
  const adminKey = process.env["ADMIN_API_KEY"];
  return Boolean(adminKey && req.headers.authorization === `Bearer ${adminKey}`);
}

async function resolveSeasonId(year: number): Promise<number | null> {
  const rows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, year))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function ensureWeekZeroReportingBaseline(
  seasonId: number,
  year: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    await initializeNflWeekZeroSnapshots(tx, { seasonId, year });
  });
}

async function getSeasonCost(
  teamId: number,
  seasonId: number,
): Promise<number> {
  const rows = await db
    .select({ bidAmount: teamSeasonAuctionsTable.bidAmount })
    .from(teamSeasonAuctionsTable)
    .where(
      and(
        eq(teamSeasonAuctionsTable.teamId, teamId),
        eq(teamSeasonAuctionsTable.seasonId, seasonId),
      ),
    )
    .limit(1);
  return parseFloat(rows[0]?.bidAmount ?? "0");
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
        realizedReturn: Number(legacy.realizedReturn),
        realizedMultiple: cost > 0 ? Number(legacy.realizedReturn) / cost : 0,
        netReturn: Number(legacy.realizedReturn) - cost,
        netPctReturn: cost > 0 ? (Number(legacy.realizedReturn) - cost) / cost : 0,
        markToMarket: Number(legacy.markToMarket),
        netMtm: Number(legacy.markToMarket) - cost,
        dollarsPerPoint: null,
        ptsToBreakeven: null,
      }
    : null;
  if (!payoutRulesConfigured) return legacyDisplay;
  const selected = calculated?.[basis];
  if (!calculated || !selected) {
    // Historical rows remain authoritative until a complete, reconciled
    // snapshot ledger is available. Do not silently replace known returns
    // with a zero just because a rubric was configured early.
    if (legacyDisplay) return legacyDisplay;
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
      realizedReturn: 0,
      realizedMultiple: 0,
      netReturn: -cost,
      netPctReturn: cost > 0 ? -1 : 0,
      markToMarket: 0,
      netMtm: -cost,
      dollarsPerPoint: null,
      ptsToBreakeven: null,
    };
  }
  const latest = selected.latest;

  // Realized and MTM coverage are independent. A valid snapshot for the
  // selected view must never zero the other legacy financial field.
  const realizedReturn = calculated.realized?.grossReturn
    ?? Number(legacy?.realizedReturn ?? 0);
  const markToMarket = calculated.mtm?.grossReturn
    ?? Number(legacy?.markToMarket ?? 0);
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
    playoffStatus: legacy?.playoffStatus ?? "unknown",
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
  };
}

// Helper: build TeamResultRow with effective current owners and season-scoped cost
function buildTeamResult(
  team: typeof teamsTable.$inferSelect,
  result: ResultDisplay | null,
  owners: { bidderId: number; bidderName: string; ownershipShare: number }[],
  ownershipSegments: OwnershipSegment[],
  cost: number,
) {
  const base = {
    teamId: team.id,
    teamName: team.name,
    conference: team.conference,
    division: team.division,
    owners: owners.map((o) => ({
      bidderId: o.bidderId,
      bidderName: o.bidderName,
      ownershipShare: o.ownershipShare,
    })),
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
    realizedReturn: Number(result.realizedReturn),
    realizedMultiple: Number(result.realizedMultiple),
    netReturn: Number(result.netReturn),
    netPctReturn: Number(result.netPctReturn),
    markToMarket: Number(result.markToMarket),
    netMtm: Number(result.netMtm ?? Number(result.markToMarket) - cost),
    ptsToBreakeven: result.ptsToBreakeven ?? null,
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

  // This reflects THIS owner's signed effective share. A negative percentage is
  // a short position, not a current-team owner label.
  const owners = [{ bidderId, bidderName, ownershipShare: effectiveShare }];

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
      realizedReturn: 0,
      realizedMultiple: 0,
      netReturn: 0,
      netPctReturn: 0,
      markToMarket: 0,
      netMtm: 0,
      ptsToBreakeven: null,
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
    netPctReturn: Math.round(netPctReturn * 10000) / 100,
    markToMarket: Math.round(markToMarket * 100) / 100,
    netMtm: Math.round(netMtm * 100) / 100,
    ptsToBreakeven,
  };
}

// PATCH /results/seed — set a team's playoff seed for a season (admin only)
router.patch("/results/seed", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { teamId, seasonYear, seed } = req.body as {
    teamId: number;
    seasonYear: number;
    seed: number | null;
  };
  if (!teamId || !seasonYear) {
    res.status(400).json({ error: "teamId and seasonYear required" });
    return;
  }
  const seasonId = await resolveSeasonId(seasonYear);
  if (!seasonId) {
    res.status(400).json({ error: `Season ${seasonYear} not found` });
    return;
  }
  const seedWritten = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    const auctionedTeam = await tx
      .select({ teamId: teamSeasonAuctionsTable.teamId })
      .from(teamSeasonAuctionsTable)
      .where(
        and(
          eq(teamSeasonAuctionsTable.teamId, teamId),
          eq(teamSeasonAuctionsTable.seasonId, seasonId),
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
    res.status(400).json({
      error: "Team is not auctioned in this season and cannot receive a playoff seed.",
    });
    return;
  }
  res.json({ teamId, seasonYear, seed });
});

// GET /results?season=YYYY
router.get("/results", async (req, res): Promise<void> => {
  const parsed = GetResultsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { season, conference, search, period, basis } = parsed.data;
  const selectedBasis = basis ?? "realized";

  // Unknown season → empty list, never fall back to another season
  const seasonId = await resolveSeasonId(season);
  if (!seasonId) {
    res.json([]);
    return;
  }
  await ensureWeekZeroReportingBaseline(seasonId, season);

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
  const calculatedResults = await loadCalculatedTeamReturns(seasonId, period);
  // Week 0 is the fixed 150-point opening allocation and can be valued from
  // the default rubric before a commissioner saves custom payout rates.
  const payoutRulesConfigured =
    period === 0 || await hasConfiguredPayoutRules(seasonId);

  // Season auction prices
  const auctionRows = await db
    .select({
      teamId: teamSeasonAuctionsTable.teamId,
      bidAmount: teamSeasonAuctionsTable.bidAmount,
    })
    .from(teamSeasonAuctionsTable)
    .where(eq(teamSeasonAuctionsTable.seasonId, seasonId));
  const auctionPriceMap = new Map(
    auctionRows.map((a) => [a.teamId, parseFloat(a.bidAmount)]),
  );
  const totalPot = auctionRows.reduce((sum, a) => sum + parseFloat(a.bidAmount), 0);
  const realizedCoverageComplete =
    auctionRows.length > 0 &&
    auctionRows.every((a) => calculatedResults.get(a.teamId)?.realized != null);
  const totalRealizedPoints = realizedCoverageComplete
    ? auctionRows.reduce(
        (sum, a) => sum + Number(calculatedResults.get(a.teamId)?.realized?.points ?? 0),
        0,
      )
    : null;

  // Effective ownership (applies approved trades)
  const ownership = await loadSeasonOwnership(seasonId);

  // Only include teams that have bidders or results for this specific season
  const rows = allTeams
    .filter(
      (t) => ownership.currentOwnersByTeam.has(t.id) || resultsMap.has(t.id),
    )
    .map((t) => {
      const cost = auctionPriceMap.get(t.id) ?? 0;
      const currentOwners = ownership.currentOwnersByTeam.get(t.id) ?? [];
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

  res.json(rows);
});

// GET /results/by-owner?season=YYYY
// Accounts for approved trades: effective ownership, net costs, and returns are
// adjusted so each owner sees their real economic position after all trades.
router.get("/results/by-owner", async (req, res): Promise<void> => {
  const parsed = GetResultsByOwnerQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { season, period, basis } = parsed.data;
  const selectedBasis = basis ?? "realized";
  const membershipView = req.query.membershipView === "current" ? "current" : "historical";

  // Unknown season → safe empty response
  const seasonId = await resolveSeasonId(season);
  if (!seasonId) {
    res.json([]);
    return;
  }
  await ensureWeekZeroReportingBaseline(seasonId, season);

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
  const calculatedResults = await loadCalculatedTeamReturns(seasonId, period);
  const payoutRulesConfigured =
    period === 0 || await hasConfiguredPayoutRules(seasonId);

  // Season auction prices
  const auctionRows = await db
    .select({
      teamId: teamSeasonAuctionsTable.teamId,
      bidAmount: teamSeasonAuctionsTable.bidAmount,
    })
    .from(teamSeasonAuctionsTable)
    .where(eq(teamSeasonAuctionsTable.seasonId, seasonId));
  const auctionPriceMap = new Map(
    auctionRows.map((a) => [a.teamId, parseFloat(a.bidAmount)]),
  );
  const totalPot = auctionRows.reduce((sum, a) => sum + parseFloat(a.bidAmount), 0);
  const realizedCoverageComplete =
    auctionRows.length > 0 &&
    auctionRows.every((a) => calculatedResults.get(a.teamId)?.realized != null);
  const totalRealizedPoints = realizedCoverageComplete
    ? auctionRows.reduce(
        (sum, a) => sum + Number(calculatedResults.get(a.teamId)?.realized?.points ?? 0),
        0,
      )
    : null;

  // Effective ownership from shared helper
  const ownership = await loadSeasonOwnership(seasonId);
  const consortiumByBidder = await loadSeasonConsortiums(seasonId, membershipView);

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
          ? Math.round((o.totalNetReturn / o.totalCost) * 10000) / 100
          : 0,
      totalMtm: Math.round(o.totalMtm * 100) / 100,
      totalNetMtm: Math.round(o.totalNetMtm * 100) / 100,
      teams: o.teams.sort((a, b) => a.teamName.localeCompare(b.teamName)),
    }))
    .sort((a, b) =>
      selectedBasis === "mtm"
        ? b.totalNetMtm - a.totalNetMtm
        : b.totalNetReturn - a.totalNetReturn,
    );

  res.json(ownerRows);
});

// GET /results/availability?season=YYYY&basis=mtm
// Exposes actual stored reporting periods instead of relying on the full NFL
// template, which includes future periods during an in-progress season.
router.get("/results/availability", async (req, res): Promise<void> => {
  const parsed = GetResultsAvailabilityQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const seasonId = await resolveSeasonId(parsed.data.season);
  if (!seasonId) {
    res.json({ latestPeriod: null, previousPeriod: null });
    return;
  }
  await ensureWeekZeroReportingBaseline(seasonId, parsed.data.season);

  const periods = await loadReturnSnapshotPeriods(
    seasonId,
    parsed.data.basis ?? "realized",
  );
  res.json({
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
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const selectedYears = parsed.data.seasons
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isInteger);
  const years = [...new Set(selectedYears)].sort((a, b) => a - b);
  if (years.length < 2 || years.length > 6 || years.length !== selectedYears.length) {
    res.status(400).json({
      error: "seasons must contain two to six unique numeric season years.",
    });
    return;
  }

  const available = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(sql`${seasonsTable.year} in (${sql.join(years.map((year) => sql`${year}`), sql`, `)})`);
  const availableYears = new Set(available.map((season) => season.year));
  const missing = years.filter((year) => !availableYears.has(year));
  if (missing.length) {
    res.status(400).json({
      error: `Season${missing.length === 1 ? "" : "s"} not found: ${missing.join(", ")}`,
    });
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
    res.status(400).json({
      error: `No canonical NFL Calcutta found for season${missingCalcuttas.length === 1 ? "" : "s"}: ${missingCalcuttas.join(", ")}`,
    });
    return;
  }
  res.json(rollup);
});

// POST /results/upsert
router.post("/results/upsert", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = UpsertTeamResultBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const wins = data.wins ?? 0;
  const losses = data.losses ?? 0;
  const ties = data.ties ?? 0;
  const recordValues = [wins, losses, ties];
  if (recordValues.some((value) => !Number.isInteger(value) || value < 0)) {
    res.status(400).json({
      error:
        "wins, losses, and ties must be whole numbers greater than or equal to zero",
    });
    return;
  }
  if (wins + losses + ties > 17) {
    res
      .status(400)
      .json({
        error: "wins, losses, and ties cannot total more than 17 games",
      });
    return;
  }
  const seasonId = await resolveSeasonId(data.seasonYear);
  if (!seasonId) {
    res.status(400).json({ error: `Season ${data.seasonYear} not found` });
    return;
  }

  const writeOutcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    const auctionedTeam = await tx
      .select({ bidAmount: teamSeasonAuctionsTable.bidAmount })
      .from(teamSeasonAuctionsTable)
      .where(
        and(
          eq(teamSeasonAuctionsTable.teamId, data.teamId),
          eq(teamSeasonAuctionsTable.seasonId, seasonId),
        ),
      )
      .limit(1);
    if (!auctionedTeam[0]) return { kind: "not_auctioned" as const };

    const cost = Number(auctionedTeam[0].bidAmount);
    const realizedReturn = data.realizedReturn ?? 0;
    const realizedMultiple =
      data.realizedMultiple ?? (cost > 0 ? realizedReturn / cost : 0);
    const netReturn = data.netReturn ?? realizedReturn - cost;
    const netPctReturn = data.netPctReturn ?? (cost > 0 ? netReturn / cost : 0);
    const markToMarket = data.markToMarket ?? 0;
    const values = {
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
      realizedReturn: realizedReturn.toFixed(6),
      realizedMultiple: realizedMultiple.toFixed(7),
      netReturn: netReturn.toFixed(6),
      netPctReturn: netPctReturn.toFixed(7),
      markToMarket: markToMarket.toFixed(6),
    };
    const [row] = await tx
      .insert(teamResultsTable)
      .values({
        teamId: data.teamId,
        seasonId,
        ...values,
        startingPoints: (data.startingPoints ?? 150).toString(),
      })
      .onConflictDoUpdate({
        target: [teamResultsTable.teamId, teamResultsTable.seasonId],
        set: values,
      })
      .returning();
    return { kind: "saved" as const, row, cost };
  });
  if (writeOutcome.kind === "not_auctioned") {
    res.status(400).json({
      error: "Team is not auctioned in this season and cannot receive results.",
    });
    return;
  }
  const row = writeOutcome.row;
  const cost = writeOutcome.cost;

  // Build response in TeamResultRow shape
  const teamInfo = await db
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.id, data.teamId))
    .limit(1);
  const team = teamInfo[0];
  if (!team) {
    res.status(400).json({ error: `Team ${data.teamId} not found` });
    return;
  }

  const ownership = await loadSeasonOwnership(seasonId);
  const currentOwners = ownership.currentOwnersByTeam.get(data.teamId) ?? [];
  const ownershipSegments =
    ownership.ownershipSegmentsByTeam.get(data.teamId) ?? [];

  res.json(
    buildTeamResult(team, row, currentOwners, ownershipSegments, cost),
  );
});

export default router;
