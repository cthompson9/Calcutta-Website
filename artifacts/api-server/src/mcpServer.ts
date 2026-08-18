/**
 * Proper MCP server using the official @modelcontextprotocol/sdk.
 * Mounted at POST /mcp and GET /mcp (streamable HTTP transport, stateless).
 *
 * Auth: Bearer token — set MCP_API_KEY environment secret.
 * If MCP_API_KEY is not set, all requests are rejected with 503.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ilike, eq, and } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  teamBiddersTable,
  teamResultsTable,
  seasonsTable,
  tradesTable,
  mtmSnapshotsTable,
} from "@workspace/db";
import type { Router, IRouter, Request, Response } from "express";
import { Router as ExpressRouter } from "express";

// ─── DB helpers ─────────────────────────────────────────────────────────────

async function resolveSeasonId(year: number): Promise<number | null> {
  const rows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, year))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function defaultSeasonYear(): Promise<number> {
  const rows = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.isComplete, true))
    .orderBy(seasonsTable.year)
    .limit(1);
  return rows[0]?.year ?? 2025;
}

async function findTeam(name: string) {
  const rows = await db
    .select()
    .from(teamsTable)
    .where(ilike(teamsTable.name, `%${name}%`))
    .limit(1);
  return rows[0] ?? null;
}

async function findBidder(name: string) {
  const rows = await db
    .select()
    .from(biddersTable)
    .where(ilike(biddersTable.name, `%${name}%`))
    .limit(1);
  return rows[0] ?? null;
}

async function getTeamResult(teamId: number, seasonId: number) {
  const rows = await db
    .select()
    .from(teamResultsTable)
    .where(and(eq(teamResultsTable.teamId, teamId), eq(teamResultsTable.seasonId, seasonId)))
    .limit(1);
  return rows[0] ?? null;
}

async function getTeamOwners(teamId: number, seasonId: number): Promise<string[]> {
  const rows = await db
    .select({ name: biddersTable.name })
    .from(teamBiddersTable)
    .innerJoin(biddersTable, eq(teamBiddersTable.bidderId, biddersTable.id))
    .where(and(eq(teamBiddersTable.teamId, teamId), eq(teamBiddersTable.seasonId, seasonId)));
  return rows.map((r) => r.name);
}

async function getOwnerAgg(bidderId: number, seasonId: number) {
  const ownerships = await db
    .select({ teamId: teamBiddersTable.teamId, ownershipShare: teamBiddersTable.ownershipShare })
    .from(teamBiddersTable)
    .where(and(eq(teamBiddersTable.bidderId, bidderId), eq(teamBiddersTable.seasonId, seasonId)));

  let totalCost = 0, totalReturn = 0, totalMtm = 0;
  for (const o of ownerships) {
    const share = parseFloat(o.ownershipShare);
    const teamRows = await db.select().from(teamsTable).where(eq(teamsTable.id, o.teamId)).limit(1);
    if (teamRows[0]) totalCost += parseFloat(teamRows[0].bidAmount) * share;
    const resultRows = await db.select().from(teamResultsTable)
      .where(and(eq(teamResultsTable.teamId, o.teamId), eq(teamResultsTable.seasonId, seasonId)))
      .limit(1);
    if (resultRows[0]) {
      totalReturn += parseFloat(resultRows[0].realizedReturn) * share;
      totalMtm += parseFloat(resultRows[0].markToMarket) * share;
    }
  }
  return { totalCost, totalReturn, totalMtm };
}

// ─── Text helper ─────────────────────────────────────────────────────────────

function text(v: string | number | null | undefined) {
  return { content: [{ type: "text" as const, text: String(v ?? "null") }] };
}

// ─── Build MCP server (called per-request in stateless mode) ─────────────────

function buildMcpServer() {
  const server = new McpServer({
    name: "nfl-auction",
    version: "1.0.0",
    description: "NFL Calcutta Pool auction data: team ownership, costs, results, and mark-to-market valuations.",
  });

  // Shared input schema fragments
  const teamInput = { team: z.string().describe("Full or partial team name, e.g. 'Seattle Seahawks' or 'Seahawks'") };
  const ownerInput = { owner: z.string().describe("Full or partial owner name, e.g. 'Zachary Long' or 'Zachary'") };
  const seasonInput = { season: z.number().optional().describe("Season year (e.g. 2025). Defaults to most recent completed season.") };

  // ── Team owner tools ──────────────────────────────────────────────────────

  for (const n of [1, 2, 3, 4, 5] as const) {
    server.tool(
      `get_team_owner${n}`,
      `Returns the ${["first", "second", "third", "fourth", "fifth"][n - 1]} owner of an NFL team in a given season. Returns null if the team has fewer than ${n} owner(s).`,
      { ...teamInput, ...seasonInput },
      async ({ team, season }) => {
        const t = await findTeam(team);
        if (!t) return text(null);
        const year = season ?? await defaultSeasonYear();
        const sid = await resolveSeasonId(year);
        if (!sid) return text(null);
        const owners = await getTeamOwners(t.id, sid);
        return text(owners[n - 1] ?? null);
      },
    );
  }

  // ── Team financial/stat tools ─────────────────────────────────────────────

  server.tool(
    "get_team_cost",
    "Returns the auction bid price paid for the team (in dollars).",
    { ...teamInput },
    async ({ team }) => {
      const t = await findTeam(team);
      return text(t ? parseFloat(t.bidAmount) : null);
    },
  );

  server.tool(
    "get_team_wins",
    "Returns the number of regular season wins for a team in a given season.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const r = await getTeamResult(t.id, sid);
      return text(r ? parseFloat(r.wins) : null);
    },
  );

  server.tool(
    "get_team_ptdiff",
    "Returns the adjusted point differential for a team in a given season.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const r = await getTeamResult(t.id, sid);
      return text(r ? r.ptDiff : null);
    },
  );

  server.tool(
    "get_team_points",
    "Returns the starting points assigned to a team at the beginning of the season.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const r = await getTeamResult(t.id, sid);
      return text(r ? parseFloat(r.startingPoints) : null);
    },
  );

  server.tool(
    "get_team_return",
    "Returns the realized dollar return (payouts received) for a team in a given season.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const r = await getTeamResult(t.id, sid);
      return text(r ? parseFloat(r.realizedReturn) : null);
    },
  );

  server.tool(
    "get_team_mtm",
    "Returns the mark-to-market valuation (net profit/loss vs. auction price) for a team in a given season.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const r = await getTeamResult(t.id, sid);
      return text(r ? parseFloat(r.markToMarket) : null);
    },
  );

  server.tool(
    "get_team_draftorder",
    "Returns the draft/auction pick order number for a team in a given season.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const r = await getTeamResult(t.id, sid);
      return text(r?.draftOrder ?? null);
    },
  );

  // ── Owner aggregate tools ─────────────────────────────────────────────────

  server.tool(
    "get_owner_cost",
    "Returns the total auction spend for an owner in a given season (accounting for split ownership).",
    { ...ownerInput, ...seasonInput },
    async ({ owner, season }) => {
      const b = await findBidder(owner);
      if (!b) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const agg = await getOwnerAgg(b.id, sid);
      return text(Math.round(agg.totalCost * 100) / 100);
    },
  );

  server.tool(
    "get_owner_return",
    "Returns the total realized return (payouts received) for an owner in a given season.",
    { ...ownerInput, ...seasonInput },
    async ({ owner, season }) => {
      const b = await findBidder(owner);
      if (!b) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const agg = await getOwnerAgg(b.id, sid);
      return text(Math.round(agg.totalReturn * 100) / 100);
    },
  );

  server.tool(
    "get_owner_mtm",
    "Returns the total mark-to-market net profit/loss for an owner across all their teams in a given season.",
    { ...ownerInput, ...seasonInput },
    async ({ owner, season }) => {
      const b = await findBidder(owner);
      if (!b) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const agg = await getOwnerAgg(b.id, sid);
      return text(Math.round(agg.totalMtm * 100) / 100);
    },
  );

  // ── Trade tools ───────────────────────────────────────────────────────────

  server.tool(
    "create_trade",
    "Submit a trade between two owners for a team. Always creates with status PENDING — admin must approve before it affects standings. Returns the trade ID and confirmation.",
    {
      team:        z.string().describe("Full or partial team name, e.g. 'Seattle Seahawks'"),
      fromOwner:   z.string().describe("Name of owner selling the stake"),
      toOwner:     z.string().describe("Name of owner buying the stake"),
      percentage:  z.number().min(1).max(100).optional().describe("Percentage of team traded (1–100). Default 100."),
      price:       z.number().optional().describe("Trade price in dollars. If omitted, defaults to team's draft cost × percentage / 100."),
      tradeDate:   z.string().optional().describe("Trade date as YYYY-MM-DD. Defaults to today."),
      season:      z.number().optional().describe("Season year. Defaults to current active season."),
      notes:       z.string().optional().describe("Optional notes about the trade"),
    },
    async ({ team, fromOwner, toOwner, percentage = 100, price, tradeDate, season, notes }) => {
      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);

      const from = await findBidder(fromOwner);
      if (!from) return text(`Owner not found: ${fromOwner}`);

      const to = await findBidder(toOwner);
      if (!to) return text(`Owner not found: ${toOwner}`);

      const activeSeasonRows = await db
        .select({ id: seasonsTable.id, year: seasonsTable.year })
        .from(seasonsTable)
        .where(eq(seasonsTable.isActive, true))
        .limit(1);
      const defaultYear = activeSeasonRows[0]?.year ?? 2026;
      const year = season ?? defaultYear;
      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);

      const effectivePrice =
        price !== undefined
          ? price
          : Math.round(parseFloat(t.bidAmount) * (percentage / 100) * 100) / 100;

      const today = tradeDate ?? new Date().toISOString().slice(0, 10);

      const [inserted] = await db
        .insert(tradesTable)
        .values({
          seasonId: sid,
          teamId: t.id,
          fromBidderId: from.id,
          toBidderId: to.id,
          price: effectivePrice.toString(),
          percentage: percentage.toString(),
          status: "pending",
          tradeDate: today,
          notes,
        })
        .returning();

      return text(
        `Trade #${inserted.id} created: ${from.name} → ${to.name}, ${percentage}% of ${t.name} for $${effectivePrice}. Status: PENDING REVIEW. Admin must approve before it affects results.`,
      );
    },
  );

  server.tool(
    "get_trade_status",
    "Returns the current approval status of a trade by its ID (pending, approved, or rejected).",
    { tradeId: z.number().describe("Trade ID returned by create_trade") },
    async ({ tradeId }) => {
      const rows = await db
        .select({
          id: tradesTable.id,
          status: tradesTable.status,
          teamId: tradesTable.teamId,
          fromBidderId: tradesTable.fromBidderId,
          toBidderId: tradesTable.toBidderId,
          price: tradesTable.price,
          percentage: tradesTable.percentage,
          tradeDate: tradesTable.tradeDate,
        })
        .from(tradesTable)
        .where(eq(tradesTable.id, tradeId))
        .limit(1);

      if (!rows[0]) return text(`Trade #${tradeId} not found`);
      const r = rows[0];
      return text(
        `Trade #${r.id}: ${r.percentage}% stake for $${r.price} on ${r.tradeDate} — Status: ${r.status.toUpperCase()}`,
      );
    },
  );

  server.tool(
    "set_trade_status",
    "Approve or reject a pending trade. Requires the ADMIN_API_KEY as the adminKey parameter. Only approved trades affect owner standings and returns.",
    {
      tradeId:  z.number().describe("Trade ID to update"),
      status:   z.enum(["approved", "rejected"]).describe("New status: approved or rejected"),
      adminKey: z.string().describe("Admin API key — only the pool admin knows this"),
    },
    async ({ tradeId, status, adminKey }) => {
      const expectedKey = process.env["ADMIN_API_KEY"];
      if (!expectedKey || adminKey !== expectedKey) {
        return text("Error: Invalid admin key. Only the pool admin can approve or reject trades.");
      }

      const rows = await db
        .select({ id: tradesTable.id, status: tradesTable.status })
        .from(tradesTable)
        .where(eq(tradesTable.id, tradeId))
        .limit(1);

      if (!rows[0]) return text(`Trade #${tradeId} not found`);

      await db
        .update(tradesTable)
        .set({ status })
        .where(eq(tradesTable.id, tradeId));

      return text(
        `Trade #${tradeId} has been ${status.toUpperCase()}. ${status === "approved" ? "It now affects owner standings and returns." : "It has been rejected and will not affect results."}`,
      );
    },
  );

  // ── Seed tools ────────────────────────────────────────────────────────────

  server.tool(
    "get_team_seed",
    "Returns the stored playoff seed (1–7) for a team in a given season, or null if not set / team missed playoffs.",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);
      const [r] = await db
        .select({ seed: teamResultsTable.seed })
        .from(teamResultsTable)
        .where(and(eq(teamResultsTable.teamId, t.id), eq(teamResultsTable.seasonId, sid)));
      return text(r?.seed != null ? r.seed : null);
    },
  );

  server.tool(
    "set_team_seed",
    "Set the playoff seed (1–7) for a team in a given season. Use null to clear a seed. Requires ADMIN_API_KEY.",
    {
      team:     z.string().describe("Full or partial team name, e.g. 'Seattle Seahawks' or 'Seahawks'"),
      seed:     z.number().int().min(1).max(7).nullable().describe("Playoff seed 1–7 (1 = best), or null to clear"),
      season:   z.number().optional().describe("Season year (e.g. 2025). Defaults to most recent completed season."),
      adminKey: z.string().describe("Admin API key — only the pool admin knows this"),
    },
    async ({ team, seed, season, adminKey }) => {
      const expectedKey = process.env["ADMIN_API_KEY"];
      if (!expectedKey || adminKey !== expectedKey) {
        return text("Error: Invalid admin key. Only the pool admin can set seeds.");
      }
      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);
      await db
        .insert(teamResultsTable)
        .values({ teamId: t.id, seasonId: sid, seed })
        .onConflictDoUpdate({
          target: [teamResultsTable.teamId, teamResultsTable.seasonId],
          set: { seed },
        });
      return text(seed != null
        ? `Seed set: ${t.name} · ${year} → #${seed}`
        : `Seed cleared: ${t.name} · ${year}`);
    },
  );

  // ── MTM snapshot tool ─────────────────────────────────────────────────────

  server.tool(
    "set_team_mtm",
    "Record or update the mark-to-market value for a team on a specific date. Same-date submissions overwrite the previous value; different dates accumulate as separate data points. Requires the ADMIN_API_KEY as adminKey.",
    {
      team:         z.string().describe("Full or partial team name, e.g. 'Seattle Seahawks' or 'Seahawks'"),
      mtmValue:     z.number().describe("Mark-to-market value in dollars (net profit/loss vs auction cost, e.g. 320 or -45.50)"),
      snapshotDate: z.string().optional().describe("Date as YYYY-MM-DD. Defaults to today. Submitting the same date again overwrites the previous value for that team."),
      weekNum:      z.number().int().min(0).max(22).optional().describe("Optional week label (0=pre-season, 1–18=regular, 19+=playoffs). Stored for display only."),
      season:       z.number().optional().describe("Season year (e.g. 2026). Defaults to the active season."),
      adminKey:     z.string().describe("Admin API key — only the pool admin knows this"),
    },
    async ({ team, mtmValue, snapshotDate, weekNum, season, adminKey }) => {
      const expectedKey = process.env["ADMIN_API_KEY"];
      if (!expectedKey || adminKey !== expectedKey) {
        return text("Error: Invalid admin key. Only the pool admin can record MTM values.");
      }

      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);

      let year = season;
      if (!year) {
        const activeRows = await db
          .select({ year: seasonsTable.year })
          .from(seasonsTable)
          .where(eq(seasonsTable.isActive, true))
          .limit(1);
        year = activeRows[0]?.year ?? new Date().getFullYear();
      }

      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);

      const today = snapshotDate ?? new Date().toISOString().slice(0, 10);

      const [snap] = await db
        .insert(mtmSnapshotsTable)
        .values({
          teamId: t.id,
          seasonId: sid,
          weekNum: weekNum ?? null,
          snapshotDate: today,
          mtmValue: mtmValue.toString(),
        })
        .onConflictDoUpdate({
          target: [mtmSnapshotsTable.teamId, mtmSnapshotsTable.seasonId, mtmSnapshotsTable.snapshotDate],
          set: {
            weekNum: weekNum ?? null,
            mtmValue: mtmValue.toString(),
          },
        })
        .returning();

      const weekLabel = weekNum !== undefined
        ? (weekNum === 0 ? " · Pre-season" : weekNum <= 18 ? ` · Week ${weekNum}` : ` · Playoff Wk ${weekNum - 18}`)
        : "";
      return text(
        `MTM snapshot saved: ${t.name}${weekLabel} · ${today} · ${year} = $${mtmValue >= 0 ? "+" : ""}${mtmValue} (snapshot ID: ${snap.id})`,
      );
    },
  );

  return server;
}

// ─── Auth middleware ─────────────────────────────────────────────────────────

function checkAuth(req: Request, res: Response): boolean {
  const apiKey = process.env["MCP_API_KEY"];
  if (!apiKey) {
    res.status(503).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "MCP_API_KEY secret is not configured on the server." },
      id: null,
    });
    return false;
  }
  const auth = req.headers["authorization"];
  if (!auth || auth !== `Bearer ${apiKey}`) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unauthorized. Provide: Authorization: Bearer <MCP_API_KEY>" },
      id: null,
    });
    return false;
  }
  return true;
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function createMcpRouter(): IRouter {
  const router: IRouter = ExpressRouter();

  // POST / — main message handler (stateless: one server per request)
  router.post("/", async (req, res): Promise<void> => {
    if (!checkAuth(req, res)) return;

    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    } finally {
      await server.close().catch(() => {});
    }
  });

  // GET / — SSE session resumption (stateless: not supported)
  router.get("/", (_req, res): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "This MCP server runs in stateless mode. GET is not supported. Use POST /api/mcp.",
      },
      id: null,
    });
  });

  // DELETE / — session termination (no-op in stateless mode)
  router.delete("/", (_req, res): void => {
    res.status(200).json({ message: "Stateless mode — no session to terminate." });
  });

  return router;
}
