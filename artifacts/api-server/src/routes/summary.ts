import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  positionsTable,
  calcuttaEntriesTable,
  teamResultsTable,
  seasonsTable,
} from "@workspace/db";
import { GetAuctionSummaryQueryParams } from "@workspace/api-zod";
import { loadSeasonOwnership } from "../lib/seasonOwnership";
import { buildAuctionResults } from "../lib/auctionResults";
import { resolveCalcuttaId } from "../lib/calcuttaContext";

const router: IRouter = Router();

router.get("/summary", async (req, res): Promise<void> => {
  const parsed = GetAuctionSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { season } = parsed.data as typeof parsed.data & { calcuttaId?: number };

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
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId,
    calcuttaId: (parsed.data as typeof parsed.data & { calcuttaId?: number }).calcuttaId,
  });
  if (!calcuttaId) {
    res.status(404).json({ error: "Calcutta not found for this season." });
    return;
  }

  // The selected Calcutta's primary positions are its immutable auction ledger.
  // Do not read season-wide legacy auction rows: a season can have multiple pools.
  const primaryRows = await db
    .select({
      teamId: calcuttaEntriesTable.teamId,
      costBasis: positionsTable.costBasis,
      teamName: teamsTable.name,
      conference: teamsTable.conference,
    })
    .from(calcuttaEntriesTable)
    .innerJoin(teamsTable, eq(calcuttaEntriesTable.teamId, teamsTable.id))
    .leftJoin(positionsTable, and(
      eq(positionsTable.entryId, calcuttaEntriesTable.id),
      eq(positionsTable.source, "primary"),
    ))
    .where(eq(calcuttaEntriesTable.calcuttaId, calcuttaId));
  const auctionRows = [...primaryRows.reduce((byTeam, row) => {
    const existing = byTeam.get(row.teamId) ?? {
      teamId: row.teamId,
      teamName: row.teamName,
      conference: row.conference,
      bidAmount: 0,
    };
    existing.bidAmount += Number(row.costBasis ?? 0);
    byTeam.set(row.teamId, existing);
    return byTeam;
  }, new Map<number, { teamId: number; teamName: string; conference: string; bidAmount: number }>())
    .values()];

  const teamsAuctioned = auctionRows.length;
  const potSize = auctionRows.reduce((sum, a) => sum + a.bidAmount, 0);
  const avgBidPerTeam = teamsAuctioned > 0 ? potSize / teamsAuctioned : 0;

  // Conference breakdown
  const conferenceMap = new Map<string, { totalSpent: number; teamCount: number }>();
  for (const a of auctionRows) {
    const entry = conferenceMap.get(a.conference) ?? { totalSpent: 0, teamCount: 0 };
    entry.totalSpent += a.bidAmount;
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
      costBasis: positionsTable.costBasis,
      winnerName: biddersTable.name,
      draftOrder: teamResultsTable.draftOrder,
    })
    .from(calcuttaEntriesTable)
    .innerJoin(positionsTable, and(
      eq(positionsTable.entryId, calcuttaEntriesTable.id),
      eq(positionsTable.source, "primary"),
    ))
    .innerJoin(teamsTable, eq(calcuttaEntriesTable.teamId, teamsTable.id))
    .innerJoin(biddersTable, eq(positionsTable.bidderId, biddersTable.id))
    .leftJoin(
      teamResultsTable,
      and(
        eq(teamResultsTable.teamId, calcuttaEntriesTable.teamId),
        eq(teamResultsTable.seasonId, seasonId),
      ),
    )
    .where(eq(calcuttaEntriesTable.calcuttaId, calcuttaId));

  const auctionResults = buildAuctionResults(resultRows.map((row) => ({
    ...row,
    bidAmount: String(auctionRows.find((auction) => auction.teamId === row.teamId)?.bidAmount ?? 0),
  })));

  const mostExpensive = auctionRows.reduce<typeof auctionRows[number] | null>(
    (highest, row) =>
      !highest || row.bidAmount > highest.bidAmount
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
          bidAmount: Math.round(mostExpensive.bidAmount * 100) / 100,
        }
      : null,
    auctionResults,
    conferenceBreakdown,
  });
});

export default router;
