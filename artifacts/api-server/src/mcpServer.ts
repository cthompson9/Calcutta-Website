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

async function getTeamOwners(teamId: number): Promise<string[]> {
  const rows = await db
    .select({ name: biddersTable.name })
    .from(teamBiddersTable)
    .innerJoin(biddersTable, eq(teamBiddersTable.bidderId, biddersTable.id))
    .where(eq(teamBiddersTable.teamId, teamId));
  return rows.map((r) => r.name);
}

async function getOwnerAgg(bidderId: number, seasonId: number) {
  const ownerships = await db
    .select({ teamId: teamBiddersTable.teamId, ownershipShare: teamBiddersTable.ownershipShare })
    .from(teamBiddersTable)
    .where(eq(teamBiddersTable.bidderId, bidderId));

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
      `Returns the ${["first", "second", "third", "fourth", "fifth"][n - 1]} owner of an NFL team. Returns null if the team has fewer than ${n} owner(s).`,
      { ...teamInput },
      async ({ team }) => {
        const t = await findTeam(team);
        if (!t) return text(null);
        const owners = await getTeamOwners(t.id);
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
