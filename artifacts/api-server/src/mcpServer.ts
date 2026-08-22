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
import { ilike, eq, and, isNull, sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  teamResultsTable,
  teamSeasonAuctionsTable,
  seasonsTable,
  tradesTable,
  mtmSnapshotsTable,
  teamBiddersTable,
  ownershipAdjustmentsTable,
  consortiaTable,
  consortiumMembershipsTable,
  calcuttasTable,
  calcuttaEntriesTable,
  sportPeriodsTable,
  teamPeriodSnapshotsTable,
  payoutRulesTable,
  syncSeasonPositions,
} from "@workspace/db";
import type { Router, IRouter, Request, Response } from "express";
import { Router as ExpressRouter } from "express";
import { loadSeasonOwnership } from "./lib/seasonOwnership";
import {
  OWNERSHIP_SEASON_LOCK_NAMESPACE,
  validatePrimaryOwnership,
} from "./lib/ownershipShares";
import { currentYearInNewYork, todayInNewYork } from "./lib/newYorkTime";
import { writeManualMtmSnapshot } from "./lib/manualMtm";
import {
  NFL_SPORT,
  ensureNflSportPeriods,
  getOrCreateCalcuttaEntry,
  getOrCreateCanonicalCalcutta,
  hasConfiguredPayoutRules,
  loadCalculatedTeamReturns,
} from "./lib/calcuttaReturns";

// ─── DB helpers ─────────────────────────────────────────────────────────────
const CONSORTIUM_MEMBERSHIP_LOCK_NAMESPACE = 841204;

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

type NamedRecord = { id: number; name: string };

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function resolveUniqueName<T extends NamedRecord>(
  rows: T[],
  requestedName: string,
  label: string,
): T | { error: string } {
  const exact = rows.filter((row) => normalizeName(row.name) === normalizeName(requestedName));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return { error: `${label} "${requestedName}" is ambiguous.` };

  const partial = rows.filter((row) =>
    normalizeName(row.name).includes(normalizeName(requestedName)) ||
    normalizeName(requestedName).includes(normalizeName(row.name)),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) return { error: `${label} "${requestedName}" not found.` };
  return { error: `${label} "${requestedName}" is ambiguous. Use the full registered name.` };
}

/**
 * Resolve a bidder using the same unambiguous matching behavior as the other
 * MCP tools. A name with no matching identity becomes a new bidder so someone
 * can enter the pool through a trade instead of an auction result.
 */
export async function resolveOrCreateBidder(
  requestedName: string,
): Promise<{ bidder: NamedRecord; created: boolean } | { error: string }> {
  const name = requestedName.trim().replace(/\s+/g, " ");
  if (!name) return { error: "Owner name cannot be empty." };

  const bidders = await db
    .select({ id: biddersTable.id, name: biddersTable.name })
    .from(biddersTable);
  const existing = resolveUniqueName(bidders, name, "Owner");
  if (!("error" in existing)) return { bidder: existing, created: false };
  if (!existing.error.endsWith("not found.")) return existing;

  const [created] = await db
    .insert(biddersTable)
    .values({ name })
    .onConflictDoNothing({ target: biddersTable.name })
    .returning({ id: biddersTable.id, name: biddersTable.name });
  if (created) return { bidder: created, created: true };

  // A duplicate-name request may have won the race immediately before this
  // insert. Re-resolve instead of surfacing a misleading failure.
  const afterConflict = await db
    .select({ id: biddersTable.id, name: biddersTable.name })
    .from(biddersTable);
  const resolved = resolveUniqueName(afterConflict, name, "Owner");
  if ("error" in resolved) return resolved;
  return { bidder: resolved, created: false };
}

async function resolveWritableSeasonYear(): Promise<number> {
  const rows = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.isActive, true))
    .limit(1);
  return rows[0]?.year ?? await defaultSeasonYear();
}

async function validateMcpTradeApproval(trade: {
  seasonId: number;
  teamId: number;
  fromBidderId: number;
  toBidderId: number;
  percentage: string;
}, query: Pick<typeof db, "select"> = db, requireCompletePrimaryOwnership = false): Promise<string | null> {
  if (trade.fromBidderId === trade.toBidderId) {
    return "Seller and buyer must be different owners.";
  }

  const percentage = Number(trade.percentage);
  if (!Number.isFinite(percentage) || percentage < 1 || percentage > 100) {
    return "Trade percentage must be between 1% and 100%.";
  }

  const auctionRow = await query
    .select({ teamId: teamSeasonAuctionsTable.teamId })
    .from(teamSeasonAuctionsTable)
    .where(and(
      eq(teamSeasonAuctionsTable.teamId, trade.teamId),
      eq(teamSeasonAuctionsTable.seasonId, trade.seasonId),
    ))
    .limit(1);
  if (!auctionRow[0]) {
    return "Team is not auctioned in this season and cannot be traded.";
  }

  if (requireCompletePrimaryOwnership) {
    const primaryOwners = await query
      .select({
        bidderId: teamBiddersTable.bidderId,
        ownershipShare: teamBiddersTable.ownershipShare,
      })
      .from(teamBiddersTable)
      .where(and(
        eq(teamBiddersTable.teamId, trade.teamId),
        eq(teamBiddersTable.seasonId, trade.seasonId),
      ));
    const split = validatePrimaryOwnership(
      primaryOwners.map((owner) => ({
        bidderId: owner.bidderId,
        share: Number(owner.ownershipShare),
      })),
    );
    if (!split.ok) {
      return `The team's original auction ownership is incomplete or invalid: ${split.error}`;
    }
  }

  // Do not cap a sale to a seller's long stake: approved trades are a signed
  // ledger and may intentionally open or increase a short position.
  return null;
}

async function getTeamResult(teamId: number, seasonId: number) {
  const rows = await db
    .select()
    .from(teamResultsTable)
    .where(and(eq(teamResultsTable.teamId, teamId), eq(teamResultsTable.seasonId, seasonId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Returns effective current owner names for a team in a season (post-trades). */
async function getTeamOwners(teamId: number, seasonId: number): Promise<string[]> {
  const ownership = await loadSeasonOwnership(seasonId);
  return (ownership.currentOwnersByTeam.get(teamId) ?? []).map((o) => o.bidderName);
}

/** Aggregate cost/return/mtm for a bidder using effective ownership (post-trades). */
async function getOwnerAgg(bidderId: number, seasonId: number) {
  const ownership = await loadSeasonOwnership(seasonId);
  const calculatedReturns = await loadCalculatedTeamReturns(seasonId);
  const payoutRulesConfigured = await hasConfiguredPayoutRules(seasonId);
  const teamMap = ownership.byBidder.get(bidderId);
  if (!teamMap) return { totalCost: 0, totalReturn: 0, totalMtm: 0 };

  let totalCost = 0, totalReturn = 0, totalMtm = 0;
  for (const [teamId, entry] of teamMap) {
    // Use season auction price; missing row → 0
    const auctionRows = await db
      .select({ bidAmount: teamSeasonAuctionsTable.bidAmount })
      .from(teamSeasonAuctionsTable)
      .where(and(eq(teamSeasonAuctionsTable.teamId, teamId), eq(teamSeasonAuctionsTable.seasonId, seasonId)))
      .limit(1);
    const auctionPrice = auctionRows[0] ? parseFloat(auctionRows[0].bidAmount) : 0;
    totalCost += auctionPrice * entry.originalShare + entry.tradePaid - entry.tradeReceived;

    // Short positions use the same signed economic treatment as owner results.
    const effectiveShare = entry.effectiveShare;
    if (Math.abs(effectiveShare) > 0.00005) {
      const resultRows = await db
        .select()
        .from(teamResultsTable)
        .where(and(eq(teamResultsTable.teamId, teamId), eq(teamResultsTable.seasonId, seasonId)))
        .limit(1);
      if (resultRows[0]) {
        const calculated = calculatedReturns.get(teamId);
        const realized = payoutRulesConfigured
          ? (calculated?.realized?.grossReturn ?? 0)
          : parseFloat(resultRows[0].realizedReturn);
        const mtm = payoutRulesConfigured
          ? (calculated?.mtm?.grossReturn ?? 0)
          : parseFloat(resultRows[0].markToMarket);
        totalReturn += realized * effectiveShare;
        totalMtm += mtm * effectiveShare;
      }
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
    "Returns the auction bid price paid for the team in a given season (in dollars).",
    { ...teamInput, ...seasonInput },
    async ({ team, season }) => {
      const t = await findTeam(team);
      if (!t) return text(null);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(null);
      const rows = await db
        .select({ bidAmount: teamSeasonAuctionsTable.bidAmount })
        .from(teamSeasonAuctionsTable)
        .where(and(eq(teamSeasonAuctionsTable.teamId, t.id), eq(teamSeasonAuctionsTable.seasonId, sid)))
        .limit(1);
      return text(rows[0] ? parseFloat(rows[0].bidAmount) : null);
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
      const calculated = (await loadCalculatedTeamReturns(sid)).get(t.id);
      const payoutRulesConfigured = await hasConfiguredPayoutRules(sid);
      return text(
        payoutRulesConfigured
          ? (calculated?.realized?.grossReturn ?? 0)
          : r
            ? parseFloat(r.realizedReturn)
            : null,
      );
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
      const calculated = (await loadCalculatedTeamReturns(sid)).get(t.id);
      const payoutRulesConfigured = await hasConfiguredPayoutRules(sid);
      return text(
        payoutRulesConfigured
          ? (calculated?.mtm?.grossReturn ?? 0)
          : r
            ? parseFloat(r.markToMarket)
            : null,
      );
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

  // ── Bidder consortium tools ───────────────────────────────────────────────

  server.tool(
    "get_bidder_consortium",
    "Returns the consortium assigned to a bidder, or null when the bidder has not been assigned to one.",
    {
      bidder: z.string().describe("Full or partial bidder name, e.g. 'Zachary Long'"),
    },
    async ({ bidder }) => {
      const rows = await db
        .select({
          id: biddersTable.id,
          name: biddersTable.name,
          consortium: consortiaTable.name,
        })
        .from(biddersTable)
        .leftJoin(consortiaTable, eq(biddersTable.consortiumId, consortiaTable.id));
      const match = resolveUniqueName(rows, bidder, "Bidder");
      if ("error" in match) return text(`Error: ${match.error}`);
      return text(match.consortium);
    },
  );

  server.tool(
    "set_bidder_consortium",
    "Assign or clear a bidder's consortium. Provide null or an empty string to clear the assignment. Consortium names are reused case-insensitively. Requires ADMIN_API_KEY.",
    {
      bidder: z.string().describe("Full or partial bidder name, e.g. 'Zachary Long'"),
      consortium: z.string().max(200).nullable().describe("Consortium name to assign, or null/empty to clear the assignment"),
      adminKey: z.string().describe("Admin API key — only the pool admin knows this"),
    },
    async ({ bidder, consortium, adminKey }) => {
      const expectedKey = process.env["ADMIN_API_KEY"];
      if (!expectedKey || adminKey !== expectedKey) {
        return text("Error: Invalid admin key. Only the pool admin can set bidder consortiums.");
      }

      const bidders = await db
        .select({ id: biddersTable.id, name: biddersTable.name })
        .from(biddersTable);
      const bidderMatch = resolveUniqueName(bidders, bidder, "Bidder");
      if ("error" in bidderMatch) return text(`Error: ${bidderMatch.error}`);

      const normalizedConsortium = consortium?.trim().replace(/\s+/g, " ") ?? "";
      let consortiumId: number | null = null;
      let consortiumName: string | null = null;

      if (normalizedConsortium) {
        const existing = await db
          .select({ id: consortiaTable.id, name: consortiaTable.name })
          .from(consortiaTable)
          .where(sql`lower(${consortiaTable.name}) = lower(${normalizedConsortium})`)
          .limit(1);

        if (existing[0]) {
          consortiumId = existing[0].id;
          consortiumName = existing[0].name;
        } else {
          const [created] = await db
            .insert(consortiaTable)
            .values({ name: normalizedConsortium })
            .onConflictDoNothing()
            .returning({ id: consortiaTable.id, name: consortiaTable.name });

          if (created) {
            consortiumId = created.id;
            consortiumName = created.name;
          } else {
            const afterConflict = await db
              .select({ id: consortiaTable.id, name: consortiaTable.name })
              .from(consortiaTable)
              .where(sql`lower(${consortiaTable.name}) = lower(${normalizedConsortium})`)
              .limit(1);
            if (!afterConflict[0]) {
              return text(`Error: Could not create consortium "${normalizedConsortium}".`);
            }
            consortiumId = afterConflict[0].id;
            consortiumName = afterConflict[0].name;
          }
        }
      }

      const fromDate = todayInNewYork();
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${CONSORTIUM_MEMBERSHIP_LOCK_NAMESPACE}, ${bidderMatch.id})`,
        );
        const active = await tx
          .select({
            id: consortiumMembershipsTable.id,
            consortiumId: consortiumMembershipsTable.consortiumId,
            fromDate: consortiumMembershipsTable.fromDate,
          })
          .from(consortiumMembershipsTable)
          .where(
            and(
              eq(consortiumMembershipsTable.bidderId, bidderMatch.id),
              isNull(consortiumMembershipsTable.toDate),
            ),
          );
        if (active.some((membership) => membership.consortiumId === consortiumId)) {
          return;
        }
        for (const membership of active) {
          if (membership.fromDate === fromDate) {
            await tx
              .delete(consortiumMembershipsTable)
              .where(eq(consortiumMembershipsTable.id, membership.id));
          } else {
            await tx
              .update(consortiumMembershipsTable)
              .set({ toDate: fromDate })
              .where(eq(consortiumMembershipsTable.id, membership.id));
          }
        }
        if (consortiumId != null) {
          await tx.insert(consortiumMembershipsTable).values({
            bidderId: bidderMatch.id,
            consortiumId,
            fromDate,
          });
        }
        // Retained during the transition so existing bidder-directory clients
        // continue to display a current consortium while reports use history.
        await tx
          .update(biddersTable)
          .set({ consortiumId })
          .where(eq(biddersTable.id, bidderMatch.id));
      });

      return text(
        consortiumName
          ? `Consortium set: ${bidderMatch.name} → ${consortiumName}.`
          : `Consortium cleared: ${bidderMatch.name}.`,
      );
    },
  );

  // ── Primary ownership adjustment ─────────────────────────────────────────

  server.tool(
    "set_team_primary_ownership",
    "Replace a team's complete original auction ownership split for a season. Use this only to correct the original auction record, not to record a later sale; approved trades must use create_trade. Requires ADMIN_API_KEY. Shares are decimal fractions that must add to 1 exactly (for example, 0.5 and 0.5).",
    {
      team: z.string().describe("Full or partial team name, e.g. 'Buffalo Bills' or 'Bills'"),
      owners: z.array(z.object({
        owner: z.string().describe("Registered bidder name, e.g. 'Zachary Long'"),
        share: z.number().positive().max(1).describe("Ownership fraction, e.g. 0.5 for 50%"),
      })).min(1).describe("Complete replacement ownership split; all shares must total 1."),
      season: z.number().optional().describe("Season year. Defaults to the active season."),
      note: z.string().max(500).optional().describe("Optional correction rationale kept in the audit record."),
      adminKey: z.string().describe("Admin API key — only the pool admin can correct primary ownership."),
    },
    async ({ team, owners, season, note, adminKey }) => {
      const expectedKey = process.env["ADMIN_API_KEY"];
      if (!expectedKey || adminKey !== expectedKey) {
        return text("Error: Invalid admin key. Only the pool admin can correct primary ownership.");
      }

      const [teams, bidders] = await Promise.all([
        db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable),
        db.select({ id: biddersTable.id, name: biddersTable.name }).from(biddersTable),
      ]);
      const teamMatch = resolveUniqueName(teams, team, "Team");
      if ("error" in teamMatch) return text(`Error: ${teamMatch.error}`);

      const resolvedOwners: Array<{ bidderId: number; bidderName: string; share: number }> = [];
      for (const owner of owners) {
        const bidderMatch = resolveUniqueName(bidders, owner.owner, "Bidder");
        if ("error" in bidderMatch) return text(`Error: ${bidderMatch.error}`);
        resolvedOwners.push({
          bidderId: bidderMatch.id,
          bidderName: bidderMatch.name,
          share: owner.share,
        });
      }

      const split = validatePrimaryOwnership(
        resolvedOwners.map((owner) => ({ bidderId: owner.bidderId, share: owner.share })),
      );
      if (!split.ok) return text(`Error: ${split.error}`);

      const year = season ?? await resolveWritableSeasonYear();
      const seasonId = await resolveSeasonId(year);
      if (!seasonId) return text(`Error: Season ${year} not found.`);

      const writeOutcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
        );
        const [auctionRow, approvedTrade] = await Promise.all([
          tx
            .select({ teamId: teamSeasonAuctionsTable.teamId })
            .from(teamSeasonAuctionsTable)
            .where(and(eq(teamSeasonAuctionsTable.teamId, teamMatch.id), eq(teamSeasonAuctionsTable.seasonId, seasonId)))
            .limit(1),
          tx
            .select({ id: tradesTable.id })
            .from(tradesTable)
            .where(and(
              eq(tradesTable.teamId, teamMatch.id),
              eq(tradesTable.seasonId, seasonId),
              eq(tradesTable.status, "approved"),
            ))
            .limit(1),
        ]);
        if (!auctionRow[0]) return "not_auctioned" as const;
        if (approvedTrade[0]) return "approved_trade" as const;

        await tx
          .delete(teamBiddersTable)
          .where(and(eq(teamBiddersTable.teamId, teamMatch.id), eq(teamBiddersTable.seasonId, seasonId)));
        await tx.insert(teamBiddersTable).values(
          resolvedOwners.map((owner) => ({
            teamId: teamMatch.id,
            bidderId: owner.bidderId,
            seasonId,
            ownershipShare: String(split.owners.find((entry) => entry.bidderId === owner.bidderId)!.share),
          })),
        );
        await tx.insert(ownershipAdjustmentsTable).values({
          teamId: teamMatch.id,
          seasonId,
          source: "mcp_primary_ownership",
          note: note ?? "Manual primary ownership correction through MCP",
          owners: {
            owners: resolvedOwners.map((owner) => ({
              bidderId: owner.bidderId,
              bidderName: owner.bidderName,
              ownershipShare: split.owners.find((entry) => entry.bidderId === owner.bidderId)!.share,
            })),
          },
        });
        await syncSeasonPositions(tx, seasonId);
        return "updated" as const;
      });
      if (writeOutcome === "not_auctioned") {
        return text(`Error: ${teamMatch.name} is not auctioned in ${year}.`);
      }
      if (writeOutcome === "approved_trade") {
        return text("Error: This team has approved trades. Preserve that history with a trade correction instead of replacing its primary split.");
      }

      const formattedOwners = resolvedOwners
        .map((owner) => `${owner.bidderName} ${Math.round(owner.share * 10000) / 100}%`)
        .join(" / ");
      return text(`Primary ownership corrected: ${teamMatch.name} · ${year} → ${formattedOwners}. This correction is recorded separately from trades.`);
    },
  );

  // ── Trade tools ───────────────────────────────────────────────────────────

  server.tool(
    "create_trade",
    "Submit a trade between two owners for a team. New owner names are created automatically. Sales may create a short position. Every trade starts PENDING and requires admin approval before it affects standings.",
    {
      team:        z.string().describe("Full or partial team name, e.g. 'Seattle Seahawks'"),
      fromOwner:   z.string().describe("Name of owner selling the stake; a new name is registered automatically."),
      toOwner:     z.string().describe("Name of owner buying the stake; a new name is registered automatically."),
      percentage:  z.number().min(1).max(100).optional().describe("Percentage of team traded (1–100). Default 100."),
      price:       z.number().optional().describe("Trade price in dollars. If omitted, defaults to team's draft cost × percentage / 100."),
      tradeDate:   z.string().optional().describe("Trade date as YYYY-MM-DD. Defaults to today."),
      season:      z.number().optional().describe("Season year. Defaults to current active season."),
      notes:       z.string().optional().describe("Optional notes about the trade"),
    },
    async ({ team, fromOwner, toOwner, percentage = 100, price, tradeDate, season, notes }) => {
      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);

      if (normalizeName(fromOwner) === normalizeName(toOwner)) {
        return text("Error: Seller and buyer must be different owners.");
      }

      const fromResult = await resolveOrCreateBidder(fromOwner);
      if ("error" in fromResult) return text(`Error: ${fromResult.error}`);
      const toResult = await resolveOrCreateBidder(toOwner);
      if ("error" in toResult) return text(`Error: ${toResult.error}`);
      const from = fromResult.bidder;
      const to = toResult.bidder;

      const activeSeasonRows = await db
        .select({ id: seasonsTable.id, year: seasonsTable.year })
        .from(seasonsTable)
        .where(eq(seasonsTable.isActive, true))
        .limit(1);
      const defaultYear = activeSeasonRows[0]?.year ?? 2026;
      const year = season ?? defaultYear;
      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);

      if (price !== undefined && (!Number.isFinite(price) || price < 0)) {
        return text("Error: Trade price must be a non-negative number.");
      }

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${sid})`,
        );
        const validationError = await validateMcpTradeApproval(
          {
            seasonId: sid,
            teamId: t.id,
            fromBidderId: from.id,
            toBidderId: to.id,
            percentage: percentage.toString(),
          },
          tx,
        );
        if (validationError) return { kind: "invalid" as const, error: validationError };

        let effectivePrice = price;
        if (effectivePrice === undefined) {
          const auctionRows = await tx
            .select({ bidAmount: teamSeasonAuctionsTable.bidAmount })
            .from(teamSeasonAuctionsTable)
            .where(and(eq(teamSeasonAuctionsTable.teamId, t.id), eq(teamSeasonAuctionsTable.seasonId, sid)))
            .limit(1);
          effectivePrice = Math.round(
            Number(auctionRows[0]?.bidAmount ?? "0") * (percentage / 100) * 100,
          ) / 100;
        }

        const [inserted] = await tx
          .insert(tradesTable)
          .values({
            seasonId: sid,
            teamId: t.id,
            fromBidderId: from.id,
            toBidderId: to.id,
            price: effectivePrice.toFixed(2),
            percentage: percentage.toString(),
            status: "pending",
            tradeDate: tradeDate ?? todayInNewYork(),
            notes,
          })
          .returning({ id: tradesTable.id });
        return { kind: "created" as const, tradeId: inserted.id, effectivePrice };
      });
      if (outcome.kind === "invalid") return text(`Error: ${outcome.error}`);

      return text(
        `Trade #${outcome.tradeId} created: ${from.name} → ${to.name}, ${percentage}% of ${t.name} for $${outcome.effectivePrice}. Status: PENDING REVIEW. Admin must approve before it affects results.`,
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
          decisionAt: tradesTable.decisionAt,
          decisionSource: tradesTable.decisionSource,
          tradeDate: tradesTable.tradeDate,
        })
        .from(tradesTable)
        .where(eq(tradesTable.id, tradeId))
        .limit(1);

      if (!rows[0]) return text(`Trade #${tradeId} not found`);
      const r = rows[0];
      const decisionAudit = r.decisionAt
        ? ` Decision recorded ${r.decisionAt.toISOString()} via ${r.decisionSource ?? "unknown channel"}.`
        : r.status === "pending"
          ? ""
          : " Historical decision; audit details are unavailable.";
      return text(
        `Trade #${r.id}: ${r.percentage}% stake for $${r.price} on ${r.tradeDate} — Status: ${r.status.toUpperCase()}.${decisionAudit}`,
      );
    },
  );

  server.tool(
    "set_trade_status",
    "Record one irreversible approval or rejection for a pending trade. Requires the ADMIN_API_KEY plus confirmed: true. Only approved trades affect owner standings and returns.",
    {
      tradeId:  z.number().describe("Trade ID to update"),
      status:   z.enum(["approved", "rejected"]).describe("New status: approved or rejected"),
      confirmed: z.literal(true).describe("Must be true to explicitly confirm this irreversible decision"),
      adminKey: z.string().describe("Admin API key — only the pool admin knows this"),
    },
    async ({ tradeId, status, confirmed, adminKey }) => {
      const expectedKey = process.env["ADMIN_API_KEY"];
      if (!expectedKey || adminKey !== expectedKey) {
        return text("Error: Invalid admin key. Only the pool admin can approve or reject trades.");
      }
      if (confirmed !== true) {
        return text("Error: Set confirmed to true to record this irreversible trade decision.");
      }

      const outcome = await db.transaction(async (tx) => {
        const initial = await tx
          .select({ seasonId: tradesTable.seasonId })
          .from(tradesTable)
          .where(eq(tradesTable.id, tradeId))
          .limit(1);
        if (!initial[0]) return { kind: "not_found" as const };

        await tx.execute(
          sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${initial[0].seasonId})`,
        );
        const fresh = await tx
          .select()
          .from(tradesTable)
          .where(eq(tradesTable.id, tradeId))
          .limit(1);
        if (!fresh[0]) return { kind: "not_found" as const };
        if (fresh[0].status !== "pending") return { kind: "already_decided" as const };

        if (status === "approved") {
          const validationError = await validateMcpTradeApproval(fresh[0], tx, true);
          if (validationError) return { kind: "invalid" as const, error: validationError };
        }

        await tx
          .update(tradesTable)
          .set({
            status,
            decisionAt: new Date(),
            decisionSource: "commissioner_mcp",
          })
          .where(eq(tradesTable.id, tradeId));
        if (status === "approved") {
          await syncSeasonPositions(tx, fresh[0].seasonId);
        }
        return { kind: "updated" as const };
      });
      if (outcome.kind === "not_found") return text(`Trade #${tradeId} not found`);
      if (outcome.kind === "already_decided") {
        return text(`Error: Trade #${tradeId} has already been decided and cannot be changed. Record a new trade instead.`);
      }
      if (outcome.kind === "invalid") return text(`Error: Cannot approve trade: ${outcome.error}`);

      return text(
        `Trade #${tradeId} has been ${status.toUpperCase()}. ${status === "approved" ? "It now affects owner standings and returns." : "It has been rejected and will not affect results."}`,
      );
    },
  );

  // ── Period-return tools ───────────────────────────────────────────────────

  server.tool(
    "get_team_period_return",
    "Returns the calculated cumulative realized or mark-to-market return through an NFL period. The Calcutta must have payout rules configured.",
    {
      team: z.string().describe("Full or partial team name"),
      basis: z.enum(["realized", "mtm"]).default("realized"),
      period: z.number().int().min(0).max(22).optional(),
      season: z.number().optional().describe("Season year, defaulting to the active season"),
    },
    async ({ team, basis, period, season }) => {
      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);
      const calculated = (await loadCalculatedTeamReturns(sid, period)).get(t.id);
      if (!await hasConfiguredPayoutRules(sid)) {
        return text(`No payout rules are configured for ${year}; no calculated period return is available.`);
      }
      const value = calculated?.[basis];
      return text(value
        ? JSON.stringify({
            team: t.name,
            season: year,
            basis,
            throughPeriod: value.latest.sequence,
            periodLabel: value.latest.label,
            grossReturn: value.grossReturn,
            playoffStatus: value.latest.playoffStatus,
          })
        : null);
    },
  );

  server.tool(
    "set_team_period_snapshot",
    "Upserts a cumulative NFL period snapshot used to calculate returns from payout rules. Requires ADMIN_API_KEY.",
    {
      team: z.string().describe("Full or partial team name"),
      season: z.number().describe("Season year"),
      period: z.number().int().min(0).max(22).describe("NFL period: Week 0–18, then 19–22 for playoffs"),
      basis: z.enum(["realized", "mtm"]),
      wins: z.number().nonnegative().default(0),
      losses: z.number().nonnegative().default(0),
      ties: z.number().nonnegative().default(0),
      ptDiff: z.number().default(0),
      playoffBerth: z.number().min(0).max(1).default(0),
      divRound: z.number().min(0).max(1).default(0),
      confRound: z.number().min(0).max(1).default(0),
      sbBerth: z.number().min(0).max(1).default(0),
      winSuperBowl: z.number().min(0).max(1).default(0),
      playoffStatus: z.enum(["unknown", "alive", "clinched", "eliminated"]).default("unknown"),
      adminKey: z.string().describe("Admin API key"),
    },
    async ({ team, season, period, basis, adminKey, ...metrics }) => {
      if (!process.env["ADMIN_API_KEY"] || adminKey !== process.env["ADMIN_API_KEY"]) {
        return text("Error: Invalid admin key. Only the pool admin can write period snapshots.");
      }
      const t = await findTeam(team);
      if (!t) return text(`Team not found: ${team}`);
      const sid = await resolveSeasonId(season);
      if (!sid) return text(`Season ${season} not found`);
      const saved = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${sid})`);
        await ensureNflSportPeriods(tx);
        const auctioned = await tx
          .select({ teamId: teamSeasonAuctionsTable.teamId })
          .from(teamSeasonAuctionsTable)
          .where(and(eq(teamSeasonAuctionsTable.teamId, t.id), eq(teamSeasonAuctionsTable.seasonId, sid)))
          .limit(1);
        if (!auctioned[0]) return null;
        const calcutta = await getOrCreateCanonicalCalcutta(tx, { seasonId: sid, year: season });
        const entry = await getOrCreateCalcuttaEntry(tx, { calcuttaId: calcutta.id, teamId: t.id });
        const [periodRow] = await tx
          .select({
            id: sportPeriodsTable.id,
            label: sportPeriodsTable.label,
            isPlayoff: sportPeriodsTable.isPlayoff,
          })
          .from(sportPeriodsTable)
          .where(and(eq(sportPeriodsTable.sport, NFL_SPORT), eq(sportPeriodsTable.sequence, period)));
        if (!periodRow) throw new Error("NFL period was not seeded.");
        if (periodRow.isPlayoff) {
          const baseline = await tx
            .select({ id: teamPeriodSnapshotsTable.id })
            .from(teamPeriodSnapshotsTable)
            .innerJoin(
              sportPeriodsTable,
              eq(sportPeriodsTable.id, teamPeriodSnapshotsTable.periodId),
            )
            .where(
              and(
                eq(teamPeriodSnapshotsTable.entryId, entry.id),
                eq(teamPeriodSnapshotsTable.basis, basis),
                eq(sportPeriodsTable.sport, NFL_SPORT),
                eq(sportPeriodsTable.sequence, 18),
              ),
            )
            .limit(1);
          if (!baseline[0]) return "missing_regular_baseline";
        }
        const values = {
          entryId: entry.id,
          periodId: periodRow.id,
          basis,
          wins: metrics.wins.toString(),
          losses: metrics.losses.toString(),
          ties: metrics.ties.toString(),
          ptDiff: metrics.ptDiff.toString(),
          playoffBerth: metrics.playoffBerth.toString(),
          divRound: metrics.divRound.toString(),
          confRound: metrics.confRound.toString(),
          sbBerth: metrics.sbBerth.toString(),
          winSuperBowl: metrics.winSuperBowl.toString(),
          playoffStatus: metrics.playoffStatus,
          capturedAt: new Date(),
        };
        await tx.insert(teamPeriodSnapshotsTable).values(values).onConflictDoUpdate({
          target: [teamPeriodSnapshotsTable.entryId, teamPeriodSnapshotsTable.periodId, teamPeriodSnapshotsTable.basis],
          set: values,
        });
        return periodRow.label;
      });
      if (!saved) return text(`Error: ${t.name} was not auctioned in ${season}.`);
      if (saved === "missing_regular_baseline") {
        return text("Error: Save a Week 18 cumulative baseline for this team and basis before recording a playoff snapshot.");
      }
      const grossReturn = (await loadCalculatedTeamReturns(sid, period)).get(t.id)?.[basis]?.grossReturn ?? 0;
      return text(JSON.stringify({ team: t.name, season, basis, period, periodLabel: saved, grossReturn }));
    },
  );

  server.tool(
    "get_calcutta_payout_rules",
    "Lists the configured return payout rules for a season's canonical NFL Calcutta.",
    { season: z.number().optional().describe("Season year, defaulting to the active season") },
    async ({ season }) => {
      const year = season ?? await defaultSeasonYear();
      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);
      const [calcutta] = await db
        .select({ id: calcuttasTable.id })
        .from(calcuttasTable)
        .where(and(eq(calcuttasTable.seasonId, sid), eq(calcuttasTable.sport, NFL_SPORT), eq(calcuttasTable.isCanonical, true)));
      if (!calcutta) return text("[]");
      const rules = await db
        .select({
          metric: payoutRulesTable.metric,
          dollarsPerUnit: payoutRulesTable.dollarsPerUnit,
          playoffMultiplier: payoutRulesTable.playoffMultiplier,
        })
        .from(payoutRulesTable)
        .where(eq(payoutRulesTable.calcuttaId, calcutta.id));
      return text(JSON.stringify(rules.map((rule) => ({
        metric: rule.metric,
        dollarsPerUnit: Number(rule.dollarsPerUnit),
        playoffMultiplier: Number(rule.playoffMultiplier),
      }))));
    },
  );

  server.tool(
    "set_calcutta_payout_rules",
    "Replaces every payout rule for a season's canonical NFL Calcutta. Rates are dollars per cumulative metric unit; the playoff multiplier applies to changes recorded in playoff periods. Requires ADMIN_API_KEY.",
    {
      season: z.number().describe("Season year"),
      rules: z.array(z.object({
        metric: z.enum(["win", "pt_diff", "playoff_berth", "div_round", "conf_round", "sb_berth", "win_super_bowl"]),
        dollarsPerUnit: z.number(),
        playoffMultiplier: z.number().nonnegative().default(2),
      })).min(1),
      adminKey: z.string().describe("Admin API key"),
    },
    async ({ season, rules, adminKey }) => {
      if (!process.env["ADMIN_API_KEY"] || adminKey !== process.env["ADMIN_API_KEY"]) {
        return text("Error: Invalid admin key. Only the pool admin can configure payout rules.");
      }
      const sid = await resolveSeasonId(season);
      if (!sid) return text(`Season ${season} not found`);
      if (new Set(rules.map((rule) => rule.metric)).size !== rules.length) {
        return text("Error: Each payout metric may only appear once.");
      }
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${sid})`);
        await ensureNflSportPeriods(tx);
        const calcutta = await getOrCreateCanonicalCalcutta(tx, { seasonId: sid, year: season });
        await tx.delete(payoutRulesTable).where(eq(payoutRulesTable.calcuttaId, calcutta.id));
        await tx.insert(payoutRulesTable).values(rules.map((rule) => ({
          calcuttaId: calcutta.id,
          metric: rule.metric,
          dollarsPerUnit: rule.dollarsPerUnit.toString(),
          playoffMultiplier: rule.playoffMultiplier.toString(),
        })));
      });
      return text(`Saved ${rules.length} payout rule${rules.length === 1 ? "" : "s"} for ${season}.`);
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
      const seedWritten = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${sid})`,
        );
        const auctionedTeam = await tx
          .select({ teamId: teamSeasonAuctionsTable.teamId })
          .from(teamSeasonAuctionsTable)
          .where(
            and(
              eq(teamSeasonAuctionsTable.teamId, t.id),
              eq(teamSeasonAuctionsTable.seasonId, sid),
            ),
          )
          .limit(1);
        if (!auctionedTeam[0]) return false;
        await tx
          .insert(teamResultsTable)
          .values({ teamId: t.id, seasonId: sid, seed })
          .onConflictDoUpdate({
            target: [teamResultsTable.teamId, teamResultsTable.seasonId],
            set: { seed },
          });
        return true;
      });
      if (!seedWritten) return text(`Error: ${t.name} was not auctioned in ${year}.`);
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
      mtmValue:     z.number().nonnegative().describe("Mark-to-market value in dollars (e.g. 320 or 45.50)"),
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
        year = activeRows[0]?.year ?? currentYearInNewYork();
      }

      const sid = await resolveSeasonId(year);
      if (!sid) return text(`Season ${year} not found`);

      const today = snapshotDate ?? todayInNewYork();

      const writeOutcome = await writeManualMtmSnapshot({
        seasonId: sid,
        teamId: t.id,
        snapshotDate: today,
        mtmValue,
        weekNum,
      });
      if (writeOutcome.kind === "invalid_value") {
        return text("Error: MTM value must be a non-negative number.");
      }
      if (writeOutcome.kind === "not_auctioned") {
        return text(`Error: ${t.name} was not auctioned in ${year}.`);
      }
      if (writeOutcome.kind === "protected_week_zero") {
        return text(
          "Error: That team/date is the protected Kalshi Week 0 snapshot. Use Week 0 recapture instead.",
        );
      }
      const snap = writeOutcome.snapshot;

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
