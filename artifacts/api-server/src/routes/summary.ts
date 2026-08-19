import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, teamsTable, biddersTable, teamSeasonAuctionsTable, seasonsTable } from "@workspace/db";
import { GetAuctionSummaryQueryParams } from "@workspace/api-zod";
import { loadSeasonOwnership } from "../lib/seasonOwnership";

const router: IRouter = Router();

router.get("/summary", async (req, res): Promise<void> => {
  const parsed = GetAuctionSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { season } = parsed.data;

  // Resolve the requested season — no active-season fallback
  const seasonRows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, season))
    .limit(1);

  if (!seasonRows[0]) {
    res.json({
      potSize: 0,
      teamsAuctioned: 0,
      nominationsLeft: 32,
      avgBidPerTeam: 0,
      standings: [],
      conferenceBreakdown: [],
    });
    return;
  }

  const seasonId = seasonRows[0].id;

  // All auction rows for this season — authoritative source of prices and "auctioned" count
  const auctionRows = await db
    .select({
      teamId: teamSeasonAuctionsTable.teamId,
      bidAmount: teamSeasonAuctionsTable.bidAmount,
      conference: teamsTable.conference,
    })
    .from(teamSeasonAuctionsTable)
    .innerJoin(teamsTable, eq(teamSeasonAuctionsTable.teamId, teamsTable.id))
    .where(eq(teamSeasonAuctionsTable.seasonId, seasonId));

  const teamsAuctioned = auctionRows.length;
  const potSize = auctionRows.reduce((sum, a) => sum + parseFloat(a.bidAmount), 0);
  const avgBidPerTeam = teamsAuctioned > 0 ? potSize / teamsAuctioned : 0;

  // Conference breakdown
  const conferenceMap = new Map<string, { totalSpent: number; teamCount: number }>();
  for (const a of auctionRows) {
    const entry = conferenceMap.get(a.conference) ?? { totalSpent: 0, teamCount: 0 };
    entry.totalSpent += parseFloat(a.bidAmount);
    entry.teamCount += 1;
    conferenceMap.set(a.conference, entry);
  }
  const conferenceBreakdown = Array.from(conferenceMap.entries()).map(([conference, data]) => ({
    conference,
    totalSpent: Math.round(data.totalSpent * 100) / 100,
    teamCount: data.teamCount,
    avgBid: data.teamCount > 0 ? Math.round((data.totalSpent / data.teamCount) * 100) / 100 : 0,
  }));

  // Season auction price map
  const auctionPriceMap = new Map(auctionRows.map((a) => [a.teamId, parseFloat(a.bidAmount)]));

  // Load effective ownership (applies approved trades)
  const ownership = await loadSeasonOwnership(seasonId);

  // Only fetch bidder names for actual season participants
  const participantBidderIds = Array.from(ownership.participantIds);
  if (participantBidderIds.length === 0) {
    res.json({
      potSize: Math.round(potSize * 100) / 100,
      teamsAuctioned,
      nominationsLeft: 32 - teamsAuctioned,
      avgBidPerTeam: Math.round(avgBidPerTeam * 100) / 100,
      standings: [],
      conferenceBreakdown,
    });
    return;
  }

  const bidderRows = await db
    .select({ id: biddersTable.id, name: biddersTable.name })
    .from(biddersTable);
  const bidderNameMap = new Map(bidderRows.map((b) => [b.id, b.name]));

  // Build standings only for season participants using effective ownership
  type StandingEntry = {
    bidderId: number;
    bidderName: string;
    totalPaid: number;   // original auction cost × originalShare + tradePaid − tradeReceived
    teamCount: number;   // sum of effectiveShares
  };

  const standingMap = new Map<number, StandingEntry>();
  for (const bidderId of ownership.participantIds) {
    const name = bidderNameMap.get(bidderId) ?? ownership.bidderNames.get(bidderId) ?? "Unknown";
    standingMap.set(bidderId, { bidderId, bidderName: name, totalPaid: 0, teamCount: 0 });
  }

  for (const [bidderId, teamMap] of ownership.byBidder) {
    // Only include participants
    if (!ownership.participantIds.has(bidderId)) continue;
    const standing = standingMap.get(bidderId);
    if (!standing) continue;

    for (const [teamId, entry] of teamMap) {
      const auctionPrice = auctionPriceMap.get(teamId) ?? 0;
      // Economic cost: original cost basis + trade buys - trade sells
      const originalCost = auctionPrice * entry.originalShare;
      standing.totalPaid += originalCost + entry.tradePaid - entry.tradeReceived;
      // Team count: effective fractional ownership
      if (entry.effectiveShare > 0.00005) {
        standing.teamCount += entry.effectiveShare;
      }
    }
  }

  const standings = Array.from(standingMap.values())
    .filter((s) => s.teamCount > 0.00005 || s.totalPaid !== 0)
    .map((s) => ({
      bidderId: s.bidderId,
      bidderName: s.bidderName,
      totalPaid: Math.round(s.totalPaid * 100) / 100,
      teamCount: Math.round(s.teamCount * 10) / 10,
      percentOfPot: potSize > 0 ? Math.round((s.totalPaid / potSize) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.totalPaid - a.totalPaid);

  res.json({
    potSize: Math.round(potSize * 100) / 100,
    teamsAuctioned,
    nominationsLeft: 32 - teamsAuctioned,
    avgBidPerTeam: Math.round(avgBidPerTeam * 100) / 100,
    standings,
    conferenceBreakdown,
  });
});

export default router;
