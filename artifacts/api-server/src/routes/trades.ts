import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  tradesTable,
  seasonsTable,
} from "@workspace/db";
import {
  GetTradesQueryParams,
  CreateTradeBody,
  UpdateTradeBody,
  DeleteTradeParams,
  UpdateTradeParams,
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
      tradeDate: tradesTable.tradeDate,
      notes: tradesTable.notes,
    })
    .from(tradesTable)
    .innerJoin(teamsTable, eq(tradesTable.teamId, teamsTable.id))
    .innerJoin(biddersTable, eq(tradesTable.fromBidderId, biddersTable.id))
    .where(eq(tradesTable.seasonId, seasonId))
    .orderBy(tradesTable.tradeDate);

  // Need to also fetch toBidder name separately
  const biddersAll = await db.select({ id: biddersTable.id, name: biddersTable.name }).from(biddersTable);
  const bidderNameMap = new Map(biddersAll.map((b) => [b.id, b.name]));

  const seasonInfo = await db.select({ year: seasonsTable.year }).from(seasonsTable).where(eq(seasonsTable.id, seasonId)).limit(1);

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
      tradeDate: r.tradeDate,
      notes: r.notes,
    })),
  );
});

router.post("/trades", async (req, res): Promise<void> => {
  const parsed = CreateTradeBody.safeParse(req.body);
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

  const [trade] = await db
    .insert(tradesTable)
    .values({
      seasonId,
      teamId: data.teamId,
      fromBidderId: data.fromBidderId,
      toBidderId: data.toBidderId,
      price: data.price.toString(),
      tradeDate: data.tradeDate,
      notes: data.notes,
    })
    .returning();

  // Fetch enriched row
  const enriched = await db
    .select({
      id: tradesTable.id,
      teamName: teamsTable.name,
      fromBidderName: biddersTable.name,
    })
    .from(tradesTable)
    .innerJoin(teamsTable, eq(tradesTable.teamId, teamsTable.id))
    .innerJoin(biddersTable, eq(tradesTable.fromBidderId, biddersTable.id))
    .where(eq(tradesTable.id, trade.id))
    .limit(1);

  const allBidders = await db.select({ id: biddersTable.id, name: biddersTable.name }).from(biddersTable);
  const bidderNameMap = new Map(allBidders.map((b) => [b.id, b.name]));

  res.status(201).json({
    id: trade.id,
    seasonYear: data.seasonYear,
    teamId: trade.teamId,
    teamName: enriched[0]?.teamName ?? "",
    fromBidderId: trade.fromBidderId,
    fromBidderName: enriched[0]?.fromBidderName ?? "",
    toBidderId: trade.toBidderId,
    toBidderName: bidderNameMap.get(trade.toBidderId) ?? "",
    price: parseFloat(trade.price),
    tradeDate: trade.tradeDate,
    notes: trade.notes,
  });
});

router.patch("/trades/:id", async (req, res): Promise<void> => {
  const params = UpdateTradeParams.safeParse(req.params);
  const body = UpdateTradeBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const existing = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.id, params.data.id))
    .limit(1);
  if (!existing[0]) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }

  const updates: Partial<typeof tradesTable.$inferInsert> = {};
  if (body.data.price !== undefined) updates.price = body.data.price.toString();
  if (body.data.tradeDate !== undefined) updates.tradeDate = body.data.tradeDate;
  if (body.data.notes !== undefined) updates.notes = body.data.notes;

  const [updated] = await db
    .update(tradesTable)
    .set(updates)
    .where(eq(tradesTable.id, params.data.id))
    .returning();

  res.json(updated);
});

router.delete("/trades/:id", async (req, res): Promise<void> => {
  const parsed = DeleteTradeParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const deleted = await db
    .delete(tradesTable)
    .where(eq(tradesTable.id, parsed.data.id))
    .returning();
  if (!deleted.length) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  res.status(204).send();
});

export default router;
