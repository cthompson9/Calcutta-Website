import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, teamsTable, biddersTable, teamBiddersTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/summary", async (_req, res): Promise<void> => {
  const teams = await db.select().from(teamsTable);
  const bidders = await db.select().from(biddersTable);
  const allOwnerships = await db
    .select({
      teamId: teamBiddersTable.teamId,
      bidderId: teamBiddersTable.bidderId,
      ownershipShare: teamBiddersTable.ownershipShare,
      bidAmount: teamsTable.bidAmount,
      conference: teamsTable.conference,
    })
    .from(teamBiddersTable)
    .innerJoin(teamsTable, eq(teamBiddersTable.teamId, teamsTable.id));

  const teamsAuctioned = teams.length;
  const potSize = teams.reduce((sum, t) => sum + parseFloat(t.bidAmount), 0);
  const avgBidPerTeam = teamsAuctioned > 0 ? potSize / teamsAuctioned : 0;

  // Build bidder standings
  const bidderMap = new Map(bidders.map((b) => [b.id, { id: b.id, name: b.name, totalPaid: 0, teamCount: 0 }]));

  for (const o of allOwnerships) {
    const b = bidderMap.get(o.bidderId);
    if (b) {
      b.totalPaid += parseFloat(o.bidAmount) * parseFloat(o.ownershipShare);
      b.teamCount += 1;
    }
  }

  const standings = Array.from(bidderMap.values())
    .map((b) => ({
      bidderId: b.id,
      bidderName: b.name,
      totalPaid: Math.round(b.totalPaid * 100) / 100,
      teamCount: b.teamCount,
      percentOfPot: potSize > 0 ? Math.round((b.totalPaid / potSize) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.totalPaid - a.totalPaid);

  // Conference breakdown
  const conferenceMap = new Map<string, { totalSpent: number; teamCount: number }>();
  for (const t of teams) {
    const entry = conferenceMap.get(t.conference) ?? { totalSpent: 0, teamCount: 0 };
    entry.totalSpent += parseFloat(t.bidAmount);
    entry.teamCount += 1;
    conferenceMap.set(t.conference, entry);
  }

  const conferenceBreakdown = Array.from(conferenceMap.entries()).map(([conference, data]) => ({
    conference,
    totalSpent: Math.round(data.totalSpent * 100) / 100,
    teamCount: data.teamCount,
    avgBid: data.teamCount > 0 ? Math.round((data.totalSpent / data.teamCount) * 100) / 100 : 0,
  }));

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
