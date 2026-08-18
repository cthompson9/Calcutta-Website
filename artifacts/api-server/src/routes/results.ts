import { Router, type IRouter } from "express";
import { eq, and, ilike } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  teamBiddersTable,
  teamResultsTable,
  seasonsTable,
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
  const effectiveCost = cost;

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
      cost: effectiveCost,
      wins: 0,
      ptDiff: 0,
      startingPoints: 150,
      draftOrder: null,
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
    cost: effectiveCost,
    wins: parseFloat(result.wins),
    ptDiff: result.ptDiff,
    startingPoints: parseFloat(result.startingPoints),
    draftOrder: result.draftOrder,
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

// GET /results?season=YYYY
router.get("/results", async (req, res): Promise<void> => {
  const parsed = GetResultsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { season, conference, search } = parsed.data;
  const seasonId = await resolveSeasonId(season);

  // Fetch all teams (with optional filters)
  let teamQuery = db.select().from(teamsTable).$dynamic();
  if (conference) teamQuery = teamQuery.where(eq(teamsTable.conference, conference));
  if (search) teamQuery = teamQuery.where(ilike(teamsTable.name, `%${search}%`));

  const teams = await teamQuery.orderBy(teamsTable.conference, teamsTable.division, teamsTable.name);

  // Fetch results for this season
  const resultsMap = new Map<number, typeof teamResultsTable.$inferSelect>();
  if (seasonId) {
    const results = await db
      .select()
      .from(teamResultsTable)
      .where(eq(teamResultsTable.seasonId, seasonId));
    for (const r of results) resultsMap.set(r.teamId, r);
  }

  // Fetch ownerships for this season
  const ownershipsQuery = db
    .select({
      teamId: teamBiddersTable.teamId,
      bidderId: biddersTable.id,
      bidderName: biddersTable.name,
      ownershipShare: teamBiddersTable.ownershipShare,
    })
    .from(teamBiddersTable)
    .innerJoin(biddersTable, eq(teamBiddersTable.bidderId, biddersTable.id));

  const ownerships = await ownershipsQuery;
  const ownershipMap = new Map<number, { bidderId: number; bidderName: string; ownershipShare: string }[]>();
  for (const o of ownerships) {
    if (!ownershipMap.has(o.teamId)) ownershipMap.set(o.teamId, []);
    ownershipMap.get(o.teamId)!.push(o);
  }

  const rows = teams.map((t) =>
    buildTeamResult(t, resultsMap.get(t.id) ?? null, ownershipMap.get(t.id) ?? []),
  );

  res.json(rows);
});

// GET /results/by-owner?season=YYYY
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

  const ownerships = await db
    .select({
      teamId: teamBiddersTable.teamId,
      bidderId: biddersTable.id,
      bidderName: biddersTable.name,
      ownershipShare: teamBiddersTable.ownershipShare,
    })
    .from(teamBiddersTable)
    .innerJoin(biddersTable, eq(teamBiddersTable.bidderId, biddersTable.id));

  const ownershipMap = new Map<number, { bidderId: number; bidderName: string; ownershipShare: string }[]>();
  for (const o of ownerships) {
    if (!ownershipMap.has(o.teamId)) ownershipMap.set(o.teamId, []);
    ownershipMap.get(o.teamId)!.push(o);
  }

  const teamMap = new Map(teams.map((t) => [t.id, t]));

  // Aggregate by owner
  type OwnerAgg = {
    bidderId: number;
    bidderName: string;
    teamCount: number;
    totalCost: number;
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

  for (const [teamId, owners] of ownershipMap.entries()) {
    const team = teamMap.get(teamId);
    if (!team) continue;
    const result = resultsMap.get(teamId) ?? null;
    const row = buildTeamResult(team, result, owners);

    for (const o of owners) {
      const share = parseFloat(o.ownershipShare);
      const agg = ownerAggMap.get(o.bidderId);
      if (!agg) continue;
      agg.teamCount += share;
      agg.totalCost += row.cost * share;
      agg.totalRealizedReturn += row.realizedReturn * share;
      agg.totalNetReturn += row.netReturn * share;
      agg.totalMtm += row.markToMarket * share;
      // Only add to teams list if not already there
      if (!agg.teams.find((t) => t.teamId === teamId)) {
        agg.teams.push(row);
      }
    }
  }

  const ownerRows = Array.from(ownerAggMap.values())
    .filter((o) => o.teamCount > 0)
    .map((o) => ({
      ...o,
      teamCount: Math.round(o.teamCount * 10) / 10,
      totalCost: Math.round(o.totalCost * 100) / 100,
      totalRealizedReturn: Math.round(o.totalRealizedReturn * 100) / 100,
      totalNetReturn: Math.round(o.totalNetReturn * 100) / 100,
      netPctReturn: o.totalCost > 0 ? Math.round((o.totalNetReturn / o.totalCost) * 10000) / 100 : 0,
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
    res.status(404).json({ error: `Season ${data.seasonYear} not found` });
    return;
  }

  const cost = data.realizedReturn !== undefined ? undefined : null;
  const realizedReturn = data.realizedReturn ?? 0;
  const realizedMultiple = data.realizedMultiple ?? 0;
  const netReturn = data.netReturn ?? realizedReturn - (cost ?? 0);
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
