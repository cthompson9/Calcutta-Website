import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  tradesTable,
  teamSeasonAuctionsTable,
  seasonsTable,
} from "@workspace/db";
import {
  GetTradesQueryParams,
  CreateTradeBody,
  UpdateTradeBody,
  DeleteTradeParams,
  UpdateTradeParams,
} from "@workspace/api-zod";
import { z } from "zod";
import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "../lib/ownershipShares";

const router: IRouter = Router();

const MIN_TRADE_PERCENTAGE = 1;
const MAX_TRADE_PERCENTAGE = 100;

// ── Ownership-integrity validation ────────────────────────────────────────────

/**
 * Validate a proposed trade against current season state and effective ownership.
 * Returns a human-readable error string when invalid, or null when valid.
 *
 * Checks:
 *  - seller and buyer must differ
 *  - team must be auctioned in the given season (team_season_auctions row exists)
 *
 * Trades deliberately allow a seller to have no long ownership (or to sell more
 * than their current stake). Once approved, those sales create a signed short
 * position in the season ownership ledger.
 */
async function validateTradeOwnership(args: {
  seasonId: number;
  teamId: number;
  fromBidderId: number;
  toBidderId: number;
  percentage: number;
}): Promise<string | null> {
  const { seasonId, teamId, fromBidderId, toBidderId, percentage } = args;

  if (fromBidderId === toBidderId) {
    return "Seller and buyer must be different owners.";
  }

  if (
    !Number.isFinite(percentage) ||
    percentage < MIN_TRADE_PERCENTAGE ||
    percentage > MAX_TRADE_PERCENTAGE
  ) {
    return `Trade percentage must be between ${MIN_TRADE_PERCENTAGE}% and ${MAX_TRADE_PERCENTAGE}%.`;
  }

  // Team must be auctioned in this season
  const auctionRow = await db
    .select({ teamId: teamSeasonAuctionsTable.teamId })
    .from(teamSeasonAuctionsTable)
    .where(
      and(
        eq(teamSeasonAuctionsTable.teamId, teamId),
        eq(teamSeasonAuctionsTable.seasonId, seasonId),
      ),
    )
    .limit(1);
  if (!auctionRow[0]) {
    return "Team is not auctioned in this season and cannot be traded.";
  }

  return null;
}

// ── Auth helpers ────────────────────────────────────────────────────────────

function isAdminRequest(req: Request): boolean {
  const adminKey = process.env["ADMIN_API_KEY"];
  if (!adminKey) return false;
  const auth = req.headers["authorization"];
  return auth === `Bearer ${adminKey}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function resolveSeasonId(year: number): Promise<number | null> {
  const rows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, year))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function enrichTrade(tradeId: number) {
  const rows = await db
    .select({
      id: tradesTable.id,
      seasonId: tradesTable.seasonId,
      teamId: tradesTable.teamId,
      teamName: teamsTable.name,
      fromBidderId: tradesTable.fromBidderId,
      fromBidderName: biddersTable.name,
      toBidderId: tradesTable.toBidderId,
      price: tradesTable.price,
      percentage: tradesTable.percentage,
      status: tradesTable.status,
      tradeDate: tradesTable.tradeDate,
      notes: tradesTable.notes,
    })
    .from(tradesTable)
    .innerJoin(teamsTable, eq(tradesTable.teamId, teamsTable.id))
    .innerJoin(biddersTable, eq(tradesTable.fromBidderId, biddersTable.id))
    .where(eq(tradesTable.id, tradeId))
    .limit(1);

  if (!rows[0]) return null;
  const row = rows[0];

  const biddersAll = await db
    .select({ id: biddersTable.id, name: biddersTable.name })
    .from(biddersTable);
  const bidderNameMap = new Map(biddersAll.map((b) => [b.id, b.name]));

  const seasonInfo = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.id, row.seasonId))
    .limit(1);

  return {
    id: row.id,
    seasonYear: seasonInfo[0]?.year ?? 0,
    teamId: row.teamId,
    teamName: row.teamName,
    fromBidderId: row.fromBidderId,
    fromBidderName: row.fromBidderName,
    toBidderId: row.toBidderId,
    toBidderName: bidderNameMap.get(row.toBidderId) ?? "Unknown",
    price: parseFloat(row.price),
    percentage: parseFloat(row.percentage),
    status: row.status,
    tradeDate: row.tradeDate,
    notes: row.notes,
  };
}

// ── GET /trades ──────────────────────────────────────────────────────────────

router.get("/trades", async (req, res): Promise<void> => {
  const parsed = GetTradesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { season } = parsed.data;
  const seasonId = await resolveSeasonId(season);
  if (!seasonId) {
    res.json([]);
    return;
  }

  const rows = await db
    .select({
      id: tradesTable.id,
      seasonId: tradesTable.seasonId,
      teamId: tradesTable.teamId,
      teamName: teamsTable.name,
      fromBidderId: tradesTable.fromBidderId,
      fromBidderName: biddersTable.name,
      toBidderId: tradesTable.toBidderId,
      price: tradesTable.price,
      percentage: tradesTable.percentage,
      status: tradesTable.status,
      tradeDate: tradesTable.tradeDate,
      notes: tradesTable.notes,
    })
    .from(tradesTable)
    .innerJoin(teamsTable, eq(tradesTable.teamId, teamsTable.id))
    .innerJoin(biddersTable, eq(tradesTable.fromBidderId, biddersTable.id))
    .where(eq(tradesTable.seasonId, seasonId))
    .orderBy(tradesTable.tradeDate);

  const biddersAll = await db
    .select({ id: biddersTable.id, name: biddersTable.name })
    .from(biddersTable);
  const bidderNameMap = new Map(biddersAll.map((b) => [b.id, b.name]));

  const seasonInfo = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.id, seasonId))
    .limit(1);

  res.json(
    rows.map((r) => ({
      id: r.id,
      seasonYear: seasonInfo[0]?.year ?? 0,
      teamId: r.teamId,
      teamName: r.teamName,
      fromBidderId: r.fromBidderId,
      fromBidderName: r.fromBidderName,
      toBidderId: r.toBidderId,
      toBidderName: bidderNameMap.get(r.toBidderId) ?? "Unknown",
      price: parseFloat(r.price),
      percentage: parseFloat(r.percentage),
      status: r.status,
      tradeDate: r.tradeDate,
      notes: r.notes,
    })),
  );
});

// ── POST /trades — anyone can create; always starts as pending ────────────────

router.post("/trades", async (req, res): Promise<void> => {
  const parsed = CreateTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const seasonId = await resolveSeasonId(data.seasonYear);
  if (!seasonId) {
    res.status(400).json({ error: `Season ${data.seasonYear} not found` });
    return;
  }

  // Ownership-integrity validation before creating the trade
  const validationError = await validateTradeOwnership({
    seasonId,
    teamId: data.teamId,
    fromBidderId: data.fromBidderId,
    toBidderId: data.toBidderId,
    percentage: data.percentage ?? 100,
  });
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  // If no price provided, default to the season auction price × percentage / 100
  let price = data.price;
  if (price === undefined || price === null) {
    const auctionRow = await db
      .select({ bidAmount: teamSeasonAuctionsTable.bidAmount })
      .from(teamSeasonAuctionsTable)
      .where(
        and(
          eq(teamSeasonAuctionsTable.teamId, data.teamId),
          eq(teamSeasonAuctionsTable.seasonId, seasonId),
        ),
      )
      .limit(1);
    const bidAmt = parseFloat(auctionRow[0]?.bidAmount ?? "0");
    const pct = (data.percentage ?? 100) / 100;
    price = Math.round(bidAmt * pct * 100) / 100;
  }

  const [trade] = await db
    .insert(tradesTable)
    .values({
      seasonId,
      teamId: data.teamId,
      fromBidderId: data.fromBidderId,
      toBidderId: data.toBidderId,
      price: price.toString(),
      percentage: (data.percentage ?? 100).toString(),
      status: "pending", // always starts pending — admin must approve
      tradeDate: data.tradeDate,
      notes: data.notes,
    })
    .returning();

  const enriched = await enrichTrade(trade.id);
  res.status(201).json(enriched);
});

// ── PATCH /trades/:id — update price, date, notes, percentage (not status) ──

router.patch("/trades/:id", async (req: Request, res: Response): Promise<void> => {
  const params = UpdateTradeParams.safeParse(req.params);
  const body = UpdateTradeBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  if (body.data.percentage !== undefined && !isAdminRequest(req)) {
    res.status(401).json({
      error: "Changing trade ownership percentage requires the ADMIN_API_KEY bearer token.",
    });
    return;
  }

  // Serialize every trade edit with approvals and primary ownership writes.
  // This makes an approved trade immutable and avoids a pending percentage
  // changing between an approval's validation and its status transition.
  const updateResult = await db.transaction(async (tx) => {
    const initial = await tx
      .select({ seasonId: tradesTable.seasonId })
      .from(tradesTable)
      .where(eq(tradesTable.id, params.data.id))
      .limit(1);
    if (!initial[0]) return { kind: "not_found" as const };

    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${initial[0].seasonId})`,
    );
    const fresh = await tx
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.id, params.data.id))
      .limit(1);
    if (!fresh[0]) return { kind: "not_found" as const };
    if (fresh[0].status === "approved") return { kind: "approved" as const };

    if (body.data.percentage !== undefined) {
      const validationError = await validateTradeOwnership({
        seasonId: fresh[0].seasonId,
        teamId: fresh[0].teamId,
        fromBidderId: fresh[0].fromBidderId,
        toBidderId: fresh[0].toBidderId,
        percentage: body.data.percentage,
      });
      if (validationError) return { kind: "invalid" as const, error: validationError };
    }

    const updates: Partial<typeof tradesTable.$inferInsert> = {};
    if (body.data.price !== undefined) updates.price = body.data.price.toString();
    if (body.data.tradeDate !== undefined) updates.tradeDate = body.data.tradeDate;
    if (body.data.notes !== undefined) updates.notes = body.data.notes;
    if (body.data.percentage !== undefined) updates.percentage = body.data.percentage.toString();
    await tx.update(tradesTable).set(updates).where(eq(tradesTable.id, params.data.id));
    return { kind: "updated" as const };
  });

  if (updateResult.kind === "not_found") {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  if (updateResult.kind === "approved") {
    res.status(409).json({ error: "Approved trades are immutable. Record a correcting trade instead." });
    return;
  }
  if (updateResult.kind === "invalid") {
    res.status(400).json({ error: `Cannot update trade: ${updateResult.error}` });
    return;
  }

  const enriched = await enrichTrade(params.data.id);
  res.json(enriched);
});

// ── PATCH /trades/:id/status — admin only ────────────────────────────────────

const StatusUpdateSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});

router.patch("/trades/:id/status", async (req: Request, res: Response): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({
      error: "Unauthorized. This endpoint requires the ADMIN_API_KEY bearer token.",
    });
    return;
  }

  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid trade id" });
    return;
  }

  const body = StatusUpdateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Body must be { "status": "approved" | "rejected" }' });
    return;
  }

  const existing = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.id, id))
    .limit(1);
  if (!existing[0]) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  const trade = existing[0];

  if (body.data.status === "approved" && trade.status === "approved") {
    const enriched = await enrichTrade(id);
    res.json(enriched);
    return;
  }

  // Revalidate ownership while holding the same season lock used by primary
  // ownership corrections/imports. This prevents an approval from racing a
  // primary-split replacement.
  if (body.data.status === "approved") {
    const approval = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${trade.seasonId})`,
      );
      const fresh = await tx
        .select()
        .from(tradesTable)
        .where(eq(tradesTable.id, id))
        .limit(1);
      if (!fresh[0]) return { kind: "not_found" as const };
      if (fresh[0].status === "approved") return { kind: "already_approved" as const };

      const validationError = await validateTradeOwnership({
        seasonId: fresh[0].seasonId,
        teamId: fresh[0].teamId,
        fromBidderId: fresh[0].fromBidderId,
        toBidderId: fresh[0].toBidderId,
        percentage: Number(fresh[0].percentage),
      });
      if (validationError) return { kind: "invalid" as const, error: validationError };

      await tx
        .update(tradesTable)
        .set({ status: "approved" })
        .where(eq(tradesTable.id, id));
      return { kind: "approved" as const };
    });
    if (approval.kind === "not_found") {
      res.status(404).json({ error: "Trade not found" });
      return;
    }
    if (approval.kind === "invalid") {
      res.status(400).json({ error: `Cannot approve trade: ${approval.error}` });
      return;
    }

    const enriched = await enrichTrade(id);
    res.json(enriched);
    return;
  }

  await db
    .update(tradesTable)
    .set({ status: body.data.status })
    .where(eq(tradesTable.id, id));

  const enriched = await enrichTrade(id);
  res.json(enriched);
});

// ── DELETE /trades/:id ────────────────────────────────────────────────────────

router.delete("/trades/:id", async (req: Request, res: Response): Promise<void> => {
  const parsed = DeleteTradeParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const deleteResult = await db.transaction(async (tx) => {
    const initial = await tx
      .select({ seasonId: tradesTable.seasonId })
      .from(tradesTable)
      .where(eq(tradesTable.id, parsed.data.id))
      .limit(1);
    if (!initial[0]) return "not_found" as const;

    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${initial[0].seasonId})`,
    );
    const fresh = await tx
      .select({ status: tradesTable.status })
      .from(tradesTable)
      .where(eq(tradesTable.id, parsed.data.id))
      .limit(1);
    if (!fresh[0]) return "not_found" as const;
    if (fresh[0].status === "approved") return "approved" as const;

    await tx.delete(tradesTable).where(eq(tradesTable.id, parsed.data.id));
    return "deleted" as const;
  });
  if (deleteResult === "not_found") {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  if (deleteResult === "approved") {
    res.status(409).json({ error: "Approved trades cannot be deleted. Record a correcting trade instead." });
    return;
  }
  res.status(204).send();
});

export default router;
