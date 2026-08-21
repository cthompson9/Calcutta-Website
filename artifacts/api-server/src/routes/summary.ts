import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  teamBiddersTable,
  teamResultsTable,
  teamSeasonAuctionsTable,
  seasonsTable,
} from "@workspace/db";
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
      avgBidPerTeam: 0,
      mostExpensiveTeam: null,
      auctionResults: [],
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
      teamName: teamsTable.name,
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

  // These are original auction winners, rather than effective post-trade owners.
  // Results should remain a historical record of how the auction concluded.
  const resultRows = await db
    .select({
      teamId: teamsTable.id,
      teamName: teamsTable.name,
      bidAmount: teamSeasonAuctionsTable.bidAmount,
      winnerName: biddersTable.name,
      draftOrder: teamResultsTable.draftOrder,
    })
    .from(teamSeasonAuctionsTable)
    .innerJoin(teamsTable, eq(teamSeasonAuctionsTable.teamId, teamsTable.id))
    .innerJoin(
      teamBiddersTable,
      and(
        eq(teamBiddersTable.teamId, teamSeasonAuctionsTable.teamId),
        eq(teamBiddersTable.seasonId, teamSeasonAuctionsTable.seasonId),
      ),
    )
    .innerJoin(biddersTable, eq(teamBiddersTable.bidderId, biddersTable.id))
    .leftJoin(
      teamResultsTable,
      and(
        eq(teamResultsTable.teamId, teamSeasonAuctionsTable.teamId),
        eq(teamResultsTable.seasonId, teamSeasonAuctionsTable.seasonId),
      ),
    )
    .where(eq(teamSeasonAuctionsTable.seasonId, seasonId));

  const auctionResults = resultRows
    .map((result) => ({
      teamId: result.teamId,
      teamName: result.teamName,
      winnerName: result.winnerName,
      bidAmount: Math.round(parseFloat(result.bidAmount) * 100) / 100,
      draftOrder: result.draftOrder,
    }))
    .sort(
      (a, b) =>
        (a.draftOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.draftOrder ?? Number.MAX_SAFE_INTEGER) ||
        a.teamName.localeCompare(b.teamName),
    );

  const mostExpensive = auctionRows.reduce<typeof auctionRows[number] | null>(
    (highest, row) =>
      !highest || parseFloat(row.bidAmount) > parseFloat(highest.bidAmount)
        ? row
        : highest,
    null,
  );

  res.json({
    potSize: Math.round(potSize * 100) / 100,
    teamsAuctioned,
    avgBidPerTeam: Math.round(avgBidPerTeam * 100) / 100,
    mostExpensiveTeam: mostExpensive
      ? {
          name: mostExpensive.teamName,
          bidAmount: Math.round(parseFloat(mostExpensive.bidAmount) * 100) / 100,
        }
      : null,
    auctionResults,
    conferenceBreakdown,
  });
});

export default router;
