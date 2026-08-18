import { Router, type IRouter } from "express";
import { eq, and, ilike } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  teamBiddersTable,
  teamResultsTable,
  seasonsTable,
  tradesTable,
} from "@workspace/db";
import {
  GetResultsQueryParams,
  GetResultsByOwnerQueryParams,
  UpsertTeamResultBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function resolveSeasonId(year: number): Promise<number | null> {
  const rows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, year))
    .limit(1);
  return rows[0]?.id ?? null;
}

// Helper: build TeamResultRow with owner info from joined data
function buildTeamResult(
  team: typeof teamsTable.$inferSelect,
  result: typeof teamResultsTable.$inferSelect | null,
  owners: { bidderId: number; bidderName: string; ownershipShare: string }[],
) {
  const cost = parseFloat(team.bidAmount);

  if (!result) {
    return {
      teamId: team.id,
      teamName: team.name,
      conference: team.conference,
      division: team.division,
      owners: owners.map((o) => ({
        bidderId: o.bidderId,
        bidderName: o.bidderName,
        ownershipShare: parseFloat(o.ownershipShare),
      })),
      cost,
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
    teamId: team.id,
    teamName: team.name,
    conference: team.conference,
    division: team.division,
    owners: owners.map((o) => ({
      bidderId: o.bidderId,
      bidderName: o.bidderName,
      ownershipShare: parseFloat(o.ownershipShare),
    })),
    cost,
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

// PATCH /results/seed  — set a team's playoff seed for a season (admin only)
router.patch("/results/seed", async (req, res): Promise<void> => {
  const adminKey = process.env["ADMIN_API_KEY"];
  const auth = req.headers["authorization"];
  if (!adminKey || auth !== `Bearer ${adminKey}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { teamId, seasonYear, seed } = req.body as { teamId: number; seasonYear: number; seed: number | null };
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
  const seasonId = await resolveSeasonId(season);

  let teamQuery = db.select().from(teamsTable).$dynamic();
  if (conference) teamQuery = teamQuery.where(eq(teamsTable.conference, conference));
  if (search) teamQuery = teamQuery.where(ilike(teamsTable.name, `%${search}%`));
  const teams = await teamQuery.orderBy(teamsTable.conference, teamsTable.division, teamsTable.name);

  const resultsMap = new Map<number, typeof teamResultsTable.$inferSelect>();
  if (seasonId) {
    const results = await db
      .select()
      .from(teamResultsTable)
      .where(eq(teamResultsTable.seasonId, seasonId));
    for (const r of results) resultsMap.set(r.teamId, r);
  }

  const ownershipsQuery = db
    .select({
      teamId: teamBiddersTable.teamId,
      bidderId: biddersTable.id,
      bidderName: biddersTable.name,
      ownershipShare: teamBiddersTable.ownershipShare,
    })
    .from(teamBiddersTable)
    .innerJoin(biddersTable, eq(teamBiddersTable.bidderId, biddersTable.id));

  const allOwnerships = await (seasonId
    ? ownershipsQuery.where(eq(teamBiddersTable.seasonId, seasonId))
    : ownershipsQuery);

  const ownershipMap = new Map<number, { bidderId: number; bidderName: string; ownershipShare: string }[]>();
  for (const o of allOwnerships) {
    if (!ownershipMap.has(o.teamId)) ownershipMap.set(o.teamId, []);
    ownershipMap.get(o.teamId)!.push(o);
  }

  // Only include teams that have bidders or results for this specific season.
  // Without this filter every team appears for seasons that haven't been auctioned yet.
  const rows = teams
    .filter((t) => ownershipMap.has(t.id) || resultsMap.has(t.id))
    .map((t) =>
      buildTeamResult(t, resultsMap.get(t.id) ?? null, ownershipMap.get(t.id) ?? []),
    );

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
  const seasonId = await resolveSeasonId(season);

  const teams = await db.select().from(teamsTable);
  const bidders = await db.select().from(biddersTable);

  const resultsMap = new Map<number, typeof teamResultsTable.$inferSelect>();
  if (seasonId) {
    const results = await db
      .select()
      .from(teamResultsTable)
      .where(eq(teamResultsTable.seasonId, seasonId));
    for (const r of results) resultsMap.set(r.teamId, r);
  }

  // Base ownership from teamBidders
  const ownershipsQuery = db
    .select({
      teamId: teamBiddersTable.teamId,
      bidderId: biddersTable.id,
      bidderName: biddersTable.name,
      ownershipShare: teamBiddersTable.ownershipShare,
    })
    .from(teamBiddersTable)
    .innerJoin(biddersTable, eq(teamBiddersTable.bidderId, biddersTable.id));

  const ownerships = await (seasonId
    ? ownershipsQuery.where(eq(teamBiddersTable.seasonId, seasonId))
    : ownershipsQuery);

  // Approved trades for this season
  const approvedTrades = seasonId
    ? await db
        .select()
        .from(tradesTable)
        .where(and(eq(tradesTable.seasonId, seasonId), eq(tradesTable.status, "approved")))
    : [];

  const teamMap = new Map(teams.map((t) => [t.id, t]));
  const bidderNameMap = new Map(bidders.map((b) => [b.id, b.name]));

  // ── Build effective ownership ─────────────────────────────────────────────
  // effectiveOwnership: bidderId → teamId → {
  //   originalShare: fraction from teamBidders (0 if only acquired via trade)
  //   effectiveShare: originalShare ± trade adjustments
  //   tradePaid:      cash paid as toBidder in trades
  //   tradeReceived:  cash received as fromBidder in trades
  // }
  type OwnerEntry = {
    originalShare: number;
    effectiveShare: number;
    tradePaid: number;
    tradeReceived: number;
  };
  const effectiveOwnership = new Map<number, Map<number, OwnerEntry>>();

  const getEntry = (bidderId: number, teamId: number): OwnerEntry => {
    if (!effectiveOwnership.has(bidderId)) effectiveOwnership.set(bidderId, new Map());
    if (!effectiveOwnership.get(bidderId)!.has(teamId)) {
      effectiveOwnership.get(bidderId)!.set(teamId, {
        originalShare: 0,
        effectiveShare: 0,
        tradePaid: 0,
        tradeReceived: 0,
      });
    }
    return effectiveOwnership.get(bidderId)!.get(teamId)!;
  };

  // Seed from teamBidders
  for (const o of ownerships) {
    const share = parseFloat(o.ownershipShare);
    const entry = getEntry(o.bidderId, o.teamId);
    entry.originalShare += share;
    entry.effectiveShare += share;
  }

  // Apply approved trades
  for (const trade of approvedTrades) {
    const tradeShare = parseFloat(trade.percentage) / 100;
    const tradePrice = parseFloat(trade.price);

    // fromBidder: loses effectiveShare, receives cash (reducing net cost)
    const fromEntry = getEntry(trade.fromBidderId, trade.teamId);
    fromEntry.effectiveShare -= tradeShare;
    fromEntry.tradeReceived += tradePrice;

    // toBidder: gains effectiveShare, pays cash (increasing net cost)
    const toEntry = getEntry(trade.toBidderId, trade.teamId);
    toEntry.effectiveShare += tradeShare;
    toEntry.tradePaid += tradePrice;
  }

  // ── Aggregate per owner ──────────────────────────────────────────────────
  type OwnerAgg = {
    bidderId: number;
    bidderName: string;
    teamCount: number;
    totalCost: number;        // net economic cost (original + trade buys - trade sells)
    totalRealizedReturn: number;
    totalNetReturn: number;
    totalMtm: number;
    teams: ReturnType<typeof buildTeamResult>[];
  };

  const ownerAggMap = new Map<number, OwnerAgg>();
  for (const b of bidders) {
    ownerAggMap.set(b.id, {
      bidderId: b.id,
      bidderName: b.name,
      teamCount: 0,
      totalCost: 0,
      totalRealizedReturn: 0,
      totalNetReturn: 0,
      totalMtm: 0,
      teams: [],
    });
  }

  // Iterate all (bidderId, teamId) pairs that have any economic interest
  for (const [bidderId, teamMap2] of effectiveOwnership) {
    const agg = ownerAggMap.get(bidderId);
    if (!agg) continue;

    for (const [teamId, entry] of teamMap2) {
      // Skip entries with no meaningful economic interest
      if (
        Math.abs(entry.effectiveShare) < 0.0001 &&
        entry.tradePaid === 0 &&
        entry.tradeReceived === 0
      ) continue;

      const team = teamMap.get(teamId);
      if (!team) continue;
      const result = resultsMap.get(teamId) ?? null;

      const effectiveShare = Math.max(0, entry.effectiveShare);

      // Cost basis: what they originally paid × original fraction, plus trade buys, minus trade sells
      const originalCostBasis = parseFloat(team.bidAmount) * entry.originalShare;
      const ownerCost = originalCostBasis + entry.tradePaid - entry.tradeReceived;

      // Returns scaled by effective (post-trade) share
      const realizedReturn = result ? parseFloat(result.realizedReturn) * effectiveShare : 0;
      const markToMarket = result ? parseFloat(result.markToMarket) * effectiveShare : 0;

      // Net return = return - cost (recalculated per owner using their true cost basis)
      const netReturn = realizedReturn - ownerCost;

      agg.teamCount += effectiveShare;
      agg.totalCost += ownerCost;
      agg.totalRealizedReturn += realizedReturn;
      agg.totalNetReturn += netReturn;
      agg.totalMtm += markToMarket;

      // Build team row for display (use effective owners list)
      if (!agg.teams.find((t) => t.teamId === teamId)) {
        // Collect all effective owners of this team for display
        const displayOwners: { bidderId: number; bidderName: string; ownershipShare: string }[] = [];
        for (const [oBidderId, oTeamMap] of effectiveOwnership) {
          const oEntry = oTeamMap.get(teamId);
          if (oEntry && oEntry.effectiveShare > 0.0001) {
            displayOwners.push({
              bidderId: oBidderId,
              bidderName: bidderNameMap.get(oBidderId) ?? "Unknown",
              ownershipShare: oEntry.effectiveShare.toFixed(4),
            });
          }
        }
        agg.teams.push(buildTeamResult(team, result, displayOwners));
      }
    }
  }

  const ownerRows = Array.from(ownerAggMap.values())
    .filter((o) => o.teamCount > 0.0001 || o.totalCost !== 0)
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

  const teamInfo = await db
    .select({ bidAmount: teamsTable.bidAmount })
    .from(teamsTable)
    .where(eq(teamsTable.id, data.teamId))
    .limit(1);
  const cost = parseFloat(teamInfo[0]?.bidAmount ?? "0");

  const realizedReturn = data.realizedReturn ?? 0;
  const realizedMultiple = data.realizedMultiple ?? 0;
  const netReturn = data.netReturn ?? realizedReturn - cost;
  const netPctReturn = data.netPctReturn ?? 0;
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

  res.json(row);
});

export default router;
