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
  calcuttaEntriesTable,
  positionsTable,
} from "@workspace/db";
import { loadSeasonOwnership } from "../lib/seasonOwnership";
import {
  resolveCalcuttaId,
  resolveDefaultSeasonYearForSport,
  resolveSeasonIdForSport,
} from "../lib/calcuttaContext";
import { loadCalculatedTeamReturnsForCalcutta } from "../lib/calcuttaReturns";

const router: IRouter = Router();

async function resolveSeasonId(year: number): Promise<number | null> {
  return resolveSeasonIdForSport(db, { year, sport: "NFL" });
}

// Resolve season from query (default to most recent complete season)
async function getSeason(seasonParam?: string): Promise<number> {
  if (seasonParam) return parseInt(seasonParam, 10);
  return await resolveDefaultSeasonYearForSport(db, {
    sport: "NFL",
    state: "complete",
  }) ?? 2025;
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

function selectedCalcuttaId(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : -1;
}

// Effective current owners for a team (post-trades)
async function getTeamOwners(teamId: number, seasonId: number, calcuttaId?: number): Promise<string[]> {
  const resolved = await resolveCalcuttaId(db, { seasonId, calcuttaId });
  if (!resolved) return [];
  const ownership = await loadSeasonOwnership(seasonId, resolved);
  return (ownership.currentOwnersByTeam.get(teamId) ?? []).map((o) => o.bidderName);
}

async function getTeamCost(teamId: number, seasonId: number, calcuttaId?: number): Promise<number | null> {
  const resolved = await resolveCalcuttaId(db, { seasonId, calcuttaId });
  if (!resolved) return null;
  const rows = await db
    .select({ costBasis: positionsTable.costBasis })
    .from(calcuttaEntriesTable)
    .innerJoin(positionsTable, and(
      eq(positionsTable.entryId, calcuttaEntriesTable.id),
      eq(positionsTable.source, "primary"),
    ))
    .where(and(
      eq(calcuttaEntriesTable.calcuttaId, resolved),
      eq(calcuttaEntriesTable.teamId, teamId),
    ));
  return rows.length > 0
    ? rows.reduce((sum, row) => sum + Number(row.costBasis), 0)
    : null;
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
    const owners = await getTeamOwners(team.id, seasonId, selectedCalcuttaId(req.query.calcuttaId));
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
  val(res, await getTeamCost(team.id, seasonId, selectedCalcuttaId(req.query.calcuttaId)));
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
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId,
    calcuttaId: selectedCalcuttaId(req.query.calcuttaId),
  });
  if (!calcuttaId) { val(res, null); return; }
  const calculated = (await loadCalculatedTeamReturnsForCalcutta(calcuttaId)).get(team.id);
  val(res, calculated?.realized?.grossReturn ?? null);
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
  const selectedId = selectedCalcuttaId(req.query.calcuttaId);
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId: resolvedSeasonId,
    calcuttaId: selectedId,
  });
  if (!calcuttaId) { val(res, null); return; }
  const cost = await getTeamCost(
    team.id,
    resolvedSeasonId,
    selectedId,
  );
  if (cost == null) { val(res, null); return; }
  const calculated = (await loadCalculatedTeamReturnsForCalcutta(calcuttaId)).get(team.id);
  val(res, calculated?.mtm ? calculated.mtm.grossReturn - cost : null);
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
async function getOwnerAgg(bidderId: number, seasonId: number, calcuttaId?: number) {
  const resolved = await resolveCalcuttaId(db, { seasonId, calcuttaId });
  if (!resolved) return { totalCost: 0, totalReturn: null, totalMtm: null };
  const ownership = await loadSeasonOwnership(seasonId, resolved);
  const calculatedReturns = await loadCalculatedTeamReturnsForCalcutta(resolved);
  const teamMap = ownership.byBidder.get(bidderId);
  if (!teamMap) return { totalCost: 0, totalReturn: 0, totalMtm: 0 };

  let totalCost = 0;
  let totalReturn = 0;
  let totalMtm = 0;
  let returnsAvailable = true;
  let mtmAvailable = true;

  for (const [teamId, entry] of teamMap) {
    totalCost += entry.originalCostBasis + entry.tradePaid - entry.tradeReceived;

    // Keep owner financial reporting signed so approved short positions receive
    // the inverse of a long holder's return and mark-to-market result.
    const effectiveShare = entry.effectiveShare;
    if (Math.abs(effectiveShare) > 0.00005) {
      const calculated = calculatedReturns.get(teamId);
      if (calculated?.realized) totalReturn += calculated.realized.grossReturn * effectiveShare;
      else returnsAvailable = false;
      if (calculated?.mtm) totalMtm += calculated.mtm.grossReturn * effectiveShare;
      else mtmAvailable = false;
    }
  }

  return {
    totalCost,
    totalReturn: returnsAvailable ? totalReturn : null,
    totalMtm: mtmAvailable ? totalMtm : null,
  };
}

// GET /mcp/get_owner_cost
router.get("/mcp/get_owner_cost", async (req, res): Promise<void> => {
  const ownerName = req.query.owner as string;
  if (!ownerName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const seasonId = await resolveSeasonId(season);
  const bidder = await findBidder(ownerName);
  if (!bidder || !seasonId) { val(res, null); return; }
  const agg = await getOwnerAgg(bidder.id, seasonId, selectedCalcuttaId(req.query.calcuttaId));
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
  const agg = await getOwnerAgg(bidder.id, seasonId, selectedCalcuttaId(req.query.calcuttaId));
  val(res, agg.totalReturn == null ? null : Math.round(agg.totalReturn * 100) / 100);
});

// GET /mcp/get_owner_mtm
router.get("/mcp/get_owner_mtm", async (req, res): Promise<void> => {
  const ownerName = req.query.owner as string;
  if (!ownerName) { val(res, null); return; }
  const season = await getSeason(req.query.season as string | undefined);
  const seasonId = await resolveSeasonId(season);
  const bidder = await findBidder(ownerName);
  if (!bidder || !seasonId) { val(res, null); return; }
  const agg = await getOwnerAgg(bidder.id, seasonId, selectedCalcuttaId(req.query.calcuttaId));
  val(res, agg.totalMtm == null ? null : Math.round((agg.totalMtm - agg.totalCost) * 100) / 100);
});

export default router;
