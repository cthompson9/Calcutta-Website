/**
 * MCP-compatible endpoints for LLM tool use.
 * Each returns { value: string | number | null }
 *
 * Team endpoints (query: ?team=Buffalo+Bills&season=2025):
 *   GET /mcp/get_team_owner1..5
 *   GET /mcp/get_team_cost
 *   GET /mcp/get_team_points
 *   GET /mcp/get_team_return
 *   GET /mcp/get_team_wins
 *   GET /mcp/get_team_ptdiff
 *   GET /mcp/get_team_mtm
 *   GET /mcp/get_team_draftorder
 *
 * Owner endpoints (query: ?owner=Joey+Anthony&season=2025):
 *   GET /mcp/get_owner_cost
 *   GET /mcp/get_owner_return
 *   GET /mcp/get_owner_mtm
 */
import { Router, type IRouter, type Response } from "express";
import { ilike, eq, and } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  teamResultsTable,
  teamSeasonAuctionsTable,
  seasonsTable,
} from "@workspace/db";
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

// Resolve season from query (default to most recent complete season)
async function getSeason(seasonParam?: string): Promise<number> {
  if (seasonParam) return parseInt(seasonParam, 10);
  const rows = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.isComplete, true))
    .orderBy(seasonsTable.year)
    .limit(1);
  return rows[0]?.year ?? 2025;
}

// Fuzzy team match by name
async function findTeam(name: string) {
  const rows = await db
    .select()
    .from(teamsTable)
    .where(ilike(teamsTable.name, `%${name}%`))
    .limit(1);
  return rows[0] ?? null;
}

// Fuzzy bidder match by name
async function findBidder(name: string) {
  const rows = await db
    .select()
    .from(biddersTable)
    .where(ilike(biddersTable.name, `%${name}%`))
    .limit(1);
  return rows[0] ?? null;
}

// Helper: return single value
function val(res: Response, v: string | number | null) {
  res.json({ value: v });
}

// Effective current owners for a team (post-trades)
async function getTeamOwners(teamId: number, seasonId: number): Promise<string[]> {
  const ownership = await loadSeasonOwnership(seasonId);
  return (ownership.currentOwnersByTeam.get(teamId) ?? []).map((o) => o.bidderName);
}

async function getTeamResult(teamId: number, seasonId: number | null) {
  if (!seasonId) return null;
  const rows = await db
    .select()
    .from(teamResultsTable)
    .where(
      and(
        eq(teamResultsTable.teamId, teamId),
        eq(teamResultsTable.seasonId, seasonId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// GET /mcp/get_team_owner1..5
for (const n of [1, 2, 3, 4, 5]) {
  router.get(`/mcp/get_team_owner${n}`, async (req, res): Promise<void> => {
    const teamName = req.query.team as string;
    if (!teamName) { val(res, null); return; }
    const season = await getSeason(req.query.season as string | undefined);
    const seasonId = await resolveSeasonId(season);
    const team = await findTeam(teamName);
    if (!team || !seasonId) { val(res, null); return; }
    const owners = await getTeamOwners(team.id, seasonId);
    val(res, owners[n - 1] ?? null);
  });
}

// GET /mcp/get_team_cost
router.get("/mcp/get_team_cost", async (req, res): Promise<void> => {
  const teamName = req.query.team as string;
  if (!teamName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const seasonId = await resolveSeasonId(season);
  const team = await findTeam(teamName);
  if (!team || !seasonId) { val(res, null); return; }
  const auctionRows = await db
    .select({ bidAmount: teamSeasonAuctionsTable.bidAmount })
    .from(teamSeasonAuctionsTable)
    .where(and(eq(teamSeasonAuctionsTable.teamId, team.id), eq(teamSeasonAuctionsTable.seasonId, seasonId)))
    .limit(1);
  val(res, auctionRows[0] ? parseFloat(auctionRows[0].bidAmount) : null);
});

// GET /mcp/get_team_points — starting points (always 150 for this pool)
router.get("/mcp/get_team_points", async (req, res): Promise<void> => {
  const teamName = req.query.team as string;
  if (!teamName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const seasonId = await resolveSeasonId(season);
  const team = await findTeam(teamName);
  if (!team || !seasonId) { val(res, null); return; }
  const result = await getTeamResult(team.id, seasonId);
  val(res, result ? parseFloat(result.startingPoints) : null);
});

// GET /mcp/get_team_return
router.get("/mcp/get_team_return", async (req, res): Promise<void> => {
  const teamName = req.query.team as string;
  if (!teamName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const seasonId = await resolveSeasonId(season);
  const team = await findTeam(teamName);
  if (!team || !seasonId) { val(res, null); return; }
  const result = await getTeamResult(team.id, seasonId);
  val(res, result ? parseFloat(result.realizedReturn) : null);
});

// GET /mcp/get_team_wins
router.get("/mcp/get_team_wins", async (req, res): Promise<void> => {
  const teamName = req.query.team as string;
  if (!teamName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const seasonId = await resolveSeasonId(season);
  const team = await findTeam(teamName);
  if (!team || seasonId == null) { val(res, null); return; }
  const resolvedSeasonId = seasonId;
  const result = await getTeamResult(team.id, resolvedSeasonId);
  val(res, result ? parseFloat(result.wins) : null);
});

// GET /mcp/get_team_ptdiff
router.get("/mcp/get_team_ptdiff", async (req, res): Promise<void> => {
  const teamName = req.query.team as string;
  if (!teamName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const seasonId = await resolveSeasonId(season);
  const team = await findTeam(teamName);
  if (!team || seasonId == null) { val(res, null); return; }
  const result = await getTeamResult(team.id, seasonId);
  val(res, result ? result.ptDiff : null);
});

// GET /mcp/get_team_mtm
router.get("/mcp/get_team_mtm", async (req, res): Promise<void> => {
  const teamName = req.query.team as string;
  if (!teamName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const resolvedSeasonId = await resolveSeasonId(season);
  const team = await findTeam(teamName);
  if (!team || resolvedSeasonId == null) { val(res, null); return; }
  const result = await getTeamResult(team.id, resolvedSeasonId);
  const auctionRows = await db
    .select({ bidAmount: teamSeasonAuctionsTable.bidAmount })
    .from(teamSeasonAuctionsTable)
    .where(and(eq(teamSeasonAuctionsTable.teamId, team.id), eq(teamSeasonAuctionsTable.seasonId, resolvedSeasonId)))
    .limit(1);
  const cost = parseFloat(auctionRows[0]?.bidAmount ?? "0");
  val(res, result ? parseFloat(result.markToMarket) - cost : null);
});

// GET /mcp/get_team_draftorder
router.get("/mcp/get_team_draftorder", async (req, res): Promise<void> => {
  const teamName = req.query.team as string;
  if (!teamName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const seasonId = await resolveSeasonId(season);
  const team = await findTeam(teamName);
  if (!team) { val(res, null); return; }
  const result = await getTeamResult(team.id, seasonId);
  val(res, result?.draftOrder ?? null);
});

// Owner endpoints — uses effective ownership (post-trade) via shared helper
async function getOwnerAgg(bidderId: number, seasonId: number) {
  const ownership = await loadSeasonOwnership(seasonId);
  const teamMap = ownership.byBidder.get(bidderId);
  if (!teamMap) return { totalCost: 0, totalReturn: 0, totalMtm: 0 };

  let totalCost = 0;
  let totalReturn = 0;
  let totalMtm = 0;

  for (const [teamId, entry] of teamMap) {
    // Use season auction price; missing → 0
    const auctionRows = await db
      .select({ bidAmount: teamSeasonAuctionsTable.bidAmount })
      .from(teamSeasonAuctionsTable)
      .where(and(eq(teamSeasonAuctionsTable.teamId, teamId), eq(teamSeasonAuctionsTable.seasonId, seasonId)))
      .limit(1);
    const auctionPrice = auctionRows[0] ? parseFloat(auctionRows[0].bidAmount) : 0;
    totalCost += auctionPrice * entry.originalShare + entry.tradePaid - entry.tradeReceived;

    // Keep owner financial reporting signed so approved short positions receive
    // the inverse of a long holder's return and mark-to-market result.
    const effectiveShare = entry.effectiveShare;
    if (Math.abs(effectiveShare) > 0.00005) {
      const resultRows = await db
        .select()
        .from(teamResultsTable)
        .where(and(eq(teamResultsTable.teamId, teamId), eq(teamResultsTable.seasonId, seasonId)))
        .limit(1);
      if (resultRows[0]) {
        totalReturn += parseFloat(resultRows[0].realizedReturn) * effectiveShare;
        totalMtm += parseFloat(resultRows[0].markToMarket) * effectiveShare;
      }
    }
  }

  return { totalCost, totalReturn, totalMtm };
}

// GET /mcp/get_owner_cost
router.get("/mcp/get_owner_cost", async (req, res): Promise<void> => {
  const ownerName = req.query.owner as string;
  if (!ownerName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const seasonId = await resolveSeasonId(season);
  const bidder = await findBidder(ownerName);
  if (!bidder || !seasonId) { val(res, null); return; }
  const agg = await getOwnerAgg(bidder.id, seasonId);
  val(res, Math.round(agg.totalCost * 100) / 100);
});

// GET /mcp/get_owner_return
router.get("/mcp/get_owner_return", async (req, res): Promise<void> => {
  const ownerName = req.query.owner as string;
  if (!ownerName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const seasonId = await resolveSeasonId(season);
  const bidder = await findBidder(ownerName);
  if (!bidder || !seasonId) { val(res, null); return; }
  const agg = await getOwnerAgg(bidder.id, seasonId);
  val(res, Math.round(agg.totalReturn * 100) / 100);
});

// GET /mcp/get_owner_mtm
router.get("/mcp/get_owner_mtm", async (req, res): Promise<void> => {
  const ownerName = req.query.owner as string;
  if (!ownerName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const seasonId = await resolveSeasonId(season);
  const bidder = await findBidder(ownerName);
  if (!bidder || !seasonId) { val(res, null); return; }
  const agg = await getOwnerAgg(bidder.id, seasonId);
  val(res, Math.round((agg.totalMtm - agg.totalCost) * 100) / 100);
});

export default router;
