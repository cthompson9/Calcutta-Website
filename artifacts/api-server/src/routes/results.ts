import { Router, type IRouter } from "express";
import { eq, and, ilike } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  teamBiddersTable,
  teamResultsTable,
  teamSeasonAuctionsTable,
  seasonsTable,
  tradesTable,
} from "@workspace/db";
import {
  GetResultsQueryParams,
  GetResultsByOwnerQueryParams,
  UpsertTeamResultBody,
} from "@workspace/api-zod";
import { loadSeasonOwnership } from "../lib/seasonOwnership";

const router: IRouter = Router();

async function resolveSeasonId(year: number): Promise<number | null> {
  const rows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, year))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function getSeasonCost(teamId: number, seasonId: number): Promise<number> {
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

// Helper: build TeamResultRow with effective current owners and season-scoped cost
function buildTeamResult(
  team: typeof teamsTable.$inferSelect,
  result: typeof teamResultsTable.$inferSelect | null,
  owners: { bidderId: number; bidderName: string; ownershipShare: number }[],
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
    cost,
  };

  if (!result) {
    return {
      ...base,
      wins: 0,
      ptDiff: 0,
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
    };
  }

  return {
    ...base,
    wins: parseFloat(result.wins),
    ptDiff: result.ptDiff,
    startingPoints: parseFloat(result.startingPoints),
    draftOrder: result.draftOrder,
    seed: result.seed,
    playoffBerth: result.playoffBerth,
    divRound: result.divRound,
    confRound: result.confRound,
    sbBerth: result.sbBerth,
    winSuperBowl: result.winSuperBowl,
    realizedReturn: parseFloat(result.realizedReturn),
    realizedMultiple: parseFloat(result.realizedMultiple),
    netReturn: parseFloat(result.netReturn),
    netPctReturn: parseFloat(result.netPctReturn),
    markToMarket: parseFloat(result.markToMarket),
  };
}

// Helper: build a per-owner team row in the SAME schema as buildTeamResult,
// but with financial fields scaled to this owner's economic position.
// Team-level NFL stats (wins, ptDiff, seed, playoff flags, etc.) are preserved.
function buildOwnerTeamResult(
  team: typeof teamsTable.$inferSelect,
  result: typeof teamResultsTable.$inferSelect | null,
  args: {
    bidderId: number;
    bidderName: string;
    effectiveShare: number;
    ownerCost: number;
  },
) {
  const { bidderId, bidderName, effectiveShare, ownerCost } = args;

  // This reflects THIS owner's signed effective share. A negative percentage is
  // a short position, not a current-team owner label.
  const owners = [
    { bidderId, bidderName, ownershipShare: effectiveShare },
  ];

  // Owner-specific cost basis is what this bidder paid after trade economics.
  const base = {
    teamId: team.id,
    teamName: team.name,
    conference: team.conference,
    division: team.division,
    owners,
    cost: Math.round(ownerCost * 100) / 100,
  };

  if (!result) {
    return {
      ...base,
      wins: 0,
      ptDiff: 0,
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
    };
  }

  // Owner-scaled financials
  const realizedReturn = parseFloat(result.realizedReturn) * effectiveShare;
  const markToMarket = parseFloat(result.markToMarket) * effectiveShare;
  const netReturn = realizedReturn - ownerCost;
  const realizedMultiple = ownerCost > 0 ? realizedReturn / ownerCost : 0;
  const netPctReturn = ownerCost > 0 ? netReturn / ownerCost : 0;

  return {
    ...base,
    // Preserve team-level NFL stats verbatim
    wins: parseFloat(result.wins),
    ptDiff: result.ptDiff,
    startingPoints: parseFloat(result.startingPoints),
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
  };
}

// PATCH /results/seed — set a team's playoff seed for a season (admin only)
router.patch("/results/seed", async (req, res): Promise<void> => {
  const adminKey = process.env["ADMIN_API_KEY"];
  const auth = req.headers["authorization"];
  if (!adminKey || auth !== `Bearer ${adminKey}`) {
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
  await db
    .insert(teamResultsTable)
    .values({ teamId, seasonId, seed })
    .onConflictDoUpdate({
      target: [teamResultsTable.teamId, teamResultsTable.seasonId],
      set: { seed },
    });
  res.json({ teamId, seasonYear, seed });
});

// GET /results?season=YYYY
router.get("/results", async (req, res): Promise<void> => {
  const parsed = GetResultsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { season, conference, search } = parsed.data;

  // Unknown season → empty list, never fall back to another season
  const seasonId = await resolveSeasonId(season);
  if (!seasonId) {
    res.json([]);
    return;
  }

  let teamQuery = db.select().from(teamsTable).$dynamic();
  if (conference) teamQuery = teamQuery.where(eq(teamsTable.conference, conference));
  if (search) teamQuery = teamQuery.where(ilike(teamsTable.name, `%${search}%`));
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

  // Season auction prices
  const auctionRows = await db
    .select({
      teamId: teamSeasonAuctionsTable.teamId,
      bidAmount: teamSeasonAuctionsTable.bidAmount,
    })
    .from(teamSeasonAuctionsTable)
    .where(eq(teamSeasonAuctionsTable.seasonId, seasonId));
  const auctionPriceMap = new Map(auctionRows.map((a) => [a.teamId, parseFloat(a.bidAmount)]));

  // Effective ownership (applies approved trades)
  const ownership = await loadSeasonOwnership(seasonId);

  // Only include teams that have bidders or results for this specific season
  const rows = allTeams
    .filter((t) => ownership.currentOwnersByTeam.has(t.id) || resultsMap.has(t.id))
    .map((t) => {
      const cost = auctionPriceMap.get(t.id) ?? 0;
      const currentOwners = ownership.currentOwnersByTeam.get(t.id) ?? [];
      return buildTeamResult(t, resultsMap.get(t.id) ?? null, currentOwners, cost);
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
  const { season } = parsed.data;

  // Unknown season → safe empty response
  const seasonId = await resolveSeasonId(season);
  if (!seasonId) {
    res.json([]);
    return;
  }

  const allTeams = await db.select().from(teamsTable);
  const allBidders = await db.select().from(biddersTable);

  const resultsMap = new Map<number, typeof teamResultsTable.$inferSelect>();
  const seasonResults = await db
    .select()
    .from(teamResultsTable)
    .where(eq(teamResultsTable.seasonId, seasonId));
  for (const r of seasonResults) resultsMap.set(r.teamId, r);

  // Season auction prices
  const auctionRows = await db
    .select({
      teamId: teamSeasonAuctionsTable.teamId,
      bidAmount: teamSeasonAuctionsTable.bidAmount,
    })
    .from(teamSeasonAuctionsTable)
    .where(eq(teamSeasonAuctionsTable.seasonId, seasonId));
  const auctionPriceMap = new Map(auctionRows.map((a) => [a.teamId, parseFloat(a.bidAmount)]));

  // Effective ownership from shared helper
  const ownership = await loadSeasonOwnership(seasonId);

  const teamMap = new Map(allTeams.map((t) => [t.id, t]));
  const bidderNameMap = new Map(allBidders.map((b) => [b.id, b.name]));

  // ── Aggregate per owner ──────────────────────────────────────────────────
  type OwnerAgg = {
    bidderId: number;
    bidderName: string;
    teamCount: number;
    totalCost: number;
    totalRealizedReturn: number;
    totalNetReturn: number;
    totalMtm: number;
    teams: ReturnType<typeof buildOwnerTeamResult>[];
  };

  const ownerAggMap = new Map<number, OwnerAgg>();

  // Initialize only season participants
  for (const bidderId of ownership.participantIds) {
    const name = bidderNameMap.get(bidderId) ?? ownership.bidderNames.get(bidderId) ?? "Unknown";
    ownerAggMap.set(bidderId, {
      bidderId,
      bidderName: name,
      teamCount: 0,
      totalCost: 0,
      totalRealizedReturn: 0,
      totalNetReturn: 0,
      totalMtm: 0,
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
      const result = resultsMap.get(teamId) ?? null;

      // Owner-result reporting preserves the signed ledger position. A short
      // seller receives the inverse of a long holder's team-level outcome.
      const effectiveShare = entry.effectiveShare;

      // Cost basis: season auction price × original share + trade buys - trade sells
      const seasonAuctionPrice = auctionPriceMap.get(teamId) ?? 0;
      const originalCostBasis = seasonAuctionPrice * entry.originalShare;
      const ownerCost = originalCostBasis + entry.tradePaid - entry.tradeReceived;

      // Returns scaled by effective (post-trade) share
      const realizedReturn = result ? parseFloat(result.realizedReturn) * effectiveShare : 0;
      const markToMarket = result ? parseFloat(result.markToMarket) * effectiveShare : 0;
      const netReturn = realizedReturn - ownerCost;

      agg.teamCount += effectiveShare;
      agg.totalCost += ownerCost;
      agg.totalRealizedReturn += realizedReturn;
      agg.totalNetReturn += netReturn;
      agg.totalMtm += markToMarket;

      // Add owner-specific team row once per owner. Financial fields are scaled
      // to this bidder's economic position; team-level NFL stats preserved.
      if (!agg.teams.find((t) => t.teamId === teamId)) {
        agg.teams.push(
          buildOwnerTeamResult(team, result, {
            bidderId,
            bidderName: agg.bidderName,
            effectiveShare,
            ownerCost,
          }),
        );
      }
    }
  }

  const ownerRows = Array.from(ownerAggMap.values())
    .filter((o) => Math.abs(o.teamCount) > 0.00005 || o.totalCost !== 0)
    .map((o) => ({
      ...o,
      teamCount: Math.round(o.teamCount * 10) / 10,
      totalCost: Math.round(o.totalCost * 100) / 100,
      totalRealizedReturn: Math.round(o.totalRealizedReturn * 100) / 100,
      totalNetReturn: Math.round(o.totalNetReturn * 100) / 100,
      netPctReturn:
        o.totalCost > 0 ? Math.round((o.totalNetReturn / o.totalCost) * 10000) / 100 : 0,
      totalMtm: Math.round(o.totalMtm * 100) / 100,
      teams: o.teams.sort((a, b) => a.teamName.localeCompare(b.teamName)),
    }))
    .sort((a, b) => b.totalMtm - a.totalMtm);

  res.json(ownerRows);
});

// POST /results/upsert
router.post("/results/upsert", async (req, res): Promise<void> => {
  const parsed = UpsertTeamResultBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const seasonId = await resolveSeasonId(data.seasonYear);
  if (!seasonId) {
    res.status(400).json({ error: `Season ${data.seasonYear} not found` });
    return;
  }

  // Use season auction price as cost basis
  const cost = await getSeasonCost(data.teamId, seasonId);

  const realizedReturn = data.realizedReturn ?? 0;
  const realizedMultiple =
    data.realizedMultiple ?? (cost > 0 ? realizedReturn / cost : 0);
  const netReturn = data.netReturn ?? realizedReturn - cost;
  const netPctReturn = data.netPctReturn ?? (cost > 0 ? netReturn / cost : 0);
  const markToMarket = data.markToMarket ?? 0;

  const [row] = await db
    .insert(teamResultsTable)
    .values({
      teamId: data.teamId,
      seasonId,
      wins: (data.wins ?? 0).toString(),
      ptDiff: data.ptDiff ?? 0,
      startingPoints: (data.startingPoints ?? 150).toString(),
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
    })
    .onConflictDoUpdate({
      target: [teamResultsTable.teamId, teamResultsTable.seasonId],
      set: {
        wins: (data.wins ?? 0).toString(),
        ptDiff: data.ptDiff ?? 0,
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
      },
    })
    .returning();

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

  res.json(buildTeamResult(team, row, currentOwners, cost));
});

export default router;
