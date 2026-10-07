import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db, auctionSessionsTable, auctionLotsTable, auctionConsortiaTable,
  auctionConsortiumOwnersTable, auctionSalesTable, auctionSaleAllocationsTable, auctionEventsTable,
  calcuttasTable, calcuttaEntriesTable, teamsTable, positionsTable, tradesTable, biddersTable, ownershipAdjustmentsTable, teamSeasonAuctionsTable,
  listenerSessionsTable, listenerTicketsTable, seasonsTable,
} from "@workspace/db";
import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "../lib/ownershipShares";
import { requireAdmin } from "../middlewares/requireAdmin";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";

import { snapshot, event } from "../lib/auctionState";
import { distributeIntegerTotal, expandSaleAllocations, validateAllocationInput, shareBasisPoints } from "../lib/auctionAllocations";
import { recordExactPrimaryFractions } from "../lib/exactPrimaryOwnership";
import { exactShareVector, allocateExactCents } from "../lib/exactOwnershipFractions";
import { finalizeAuctionSale } from "../lib/finalizeAuctionSale";

const router: IRouter = Router();
const id = z.coerce.number().int().positive();
const lotInput = z.object({
  externalId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  aliases: z.array(z.string().trim().min(1)).max(20).optional(),
  entryId: id,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const revision = z.object({ expectedRevision: z.number().int().nonnegative().optional() });
function normalizedLabel(value: string): string { return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"); }

function cents(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Sale price must be a positive amount.");
  const result = Math.round(value * 100);
  if (result <= 0) throw new Error("Sale price must be at least one cent.");
  return result;
}
function routeIds(req: any): { calcuttaId: number; auctionId: number } {
  return { calcuttaId: Number(req.params.calcuttaId), auctionId: Number(req.params.auctionId) };
}
async function ownsAuction(calcuttaId: number, auctionId: number): Promise<boolean> {
  const rows = await db.select({ id: auctionSessionsTable.id }).from(auctionSessionsTable).where(and(eq(auctionSessionsTable.id, auctionId), eq(auctionSessionsTable.calcuttaId, calcuttaId)));
  return rows.length > 0;
}

router.post("/calcuttas/:calcuttaId/auctions", requireAdmin, async (req, res) => {
  const parsed = z.object({}).safeParse(req.body ?? {});
  if (!parsed.success || !id.safeParse(req.params.calcuttaId).success) return sendParsedJson(res, ErrorResponse, { error: "Invalid Calcutta." }, 400);
  const calcuttaId = Number(req.params.calcuttaId);
  const [calcutta] = await db.select({ id: calcuttasTable.id, seasonId: calcuttasTable.seasonId })
    .from(calcuttasTable).where(eq(calcuttasTable.id, calcuttaId));
  if (!calcutta) return sendParsedJson(res, ErrorResponse, { error: "Calcutta not found." }, 404);
  try {
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${calcutta.seasonId})`);
  // A newly created Calcutta already has its own setup session. This fallback
  // only creates sessions for legacy pools with no session, where a completed
  // season must not be reopened.
  const [season] = await tx.select({ isComplete: seasonsTable.isComplete })
    .from(seasonsTable).where(eq(seasonsTable.id, calcutta.seasonId)).for("update");
  if (!season || season.isComplete) throw new Error("Completed seasons cannot receive a new live auction session.");
  const [historicalPrimary] = await tx.select({ id: positionsTable.id })
    .from(positionsTable)
    .innerJoin(calcuttaEntriesTable, eq(calcuttaEntriesTable.id, positionsTable.entryId))
    .where(and(eq(calcuttaEntriesTable.calcuttaId, calcuttaId), eq(positionsTable.source, "primary")))
    .limit(1);
  if (historicalPrimary) throw new Error("This Calcutta already has primary auction ownership. Live sessions are explicit-new only and cannot reinterpret historical results.");
  const [historicalResult] = await tx.select({ teamId: teamSeasonAuctionsTable.teamId })
    .from(teamSeasonAuctionsTable)
    .innerJoin(calcuttaEntriesTable, eq(calcuttaEntriesTable.teamId, teamSeasonAuctionsTable.teamId))
    .where(and(eq(calcuttaEntriesTable.calcuttaId, calcuttaId), eq(teamSeasonAuctionsTable.seasonId, calcutta.seasonId)))
    .limit(1);
  if (historicalResult) throw new Error("This Calcutta already has historical auction results and cannot start a new live session.");
    const [created] = await tx.insert(auctionSessionsTable).values({ calcuttaId }).returning();
    return created;
  });
    return res.status(201).json(await snapshot(created.id));
  } catch { return sendParsedJson(res, ErrorResponse, { error: "An auction session already exists or historical ownership/results prevent live creation." }, 409); }
});

router.get("/calcuttas/:calcuttaId/auctions/:auctionId", async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req);
  if (!(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "Auction not found for this Calcutta." }, 404);
  res.json(await snapshot(auctionId));
});
router.get("/calcuttas/:calcuttaId/auctions", async (req, res): Promise<any> => {
  const calcuttaId = Number(req.params.calcuttaId);
  if (!id.safeParse(calcuttaId).success) return sendParsedJson(res, ErrorResponse, { error: "Invalid Calcutta." }, 400);
  const [session] = await db.select({ id: auctionSessionsTable.id })
    .from(auctionSessionsTable).where(eq(auctionSessionsTable.calcuttaId, calcuttaId)).limit(1);
  if (!session) return sendParsedJson(res, ErrorResponse, { error: "Auction not found for this Calcutta." }, 404);
  res.json(await snapshot(session.id));
});

router.post("/calcuttas/:calcuttaId/auctions/:auctionId/reset", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req);
  if (!id.safeParse(calcuttaId).success || !id.safeParse(auctionId).success || !(await ownsAuction(calcuttaId, auctionId))) {
    return sendParsedJson(res, ErrorResponse, { error: "Auction not found for this Calcutta." }, 404);
  }
  const body = z.object({
    expectedRevision: z.number().int().nonnegative(),
    confirmation: z.literal(`DELETE DRAFT ${auctionId}`),
  }).safeParse(req.body);
  if (!body.success) return sendParsedJson(res, ErrorResponse, { error: `Type DELETE DRAFT ${auctionId} to confirm.` }, 400);

  try {
    await db.transaction(async (tx) => {
      const [calcutta] = await tx.select({ seasonId: calcuttasTable.seasonId })
        .from(calcuttasTable).where(eq(calcuttasTable.id, calcuttaId));
      if (!calcutta) throw new Error("Calcutta not found.");
      await tx.execute(sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${calcutta.seasonId})`);
      const [session] = await tx.select().from(auctionSessionsTable)
        .where(and(eq(auctionSessionsTable.id, auctionId), eq(auctionSessionsTable.calcuttaId, calcuttaId))).for("update");
      const [season] = await tx.select({ isComplete: seasonsTable.isComplete }).from(seasonsTable)
        .where(eq(seasonsTable.id, calcutta.seasonId)).for("update");
      if (!session || !season) throw new Error("Auction not found.");
      if (session.revision !== body.data.expectedRevision) throw new Error("Stale auction revision. Refresh before resetting.");
      if (session.status === "complete" || season.isComplete) throw new Error("Completed auctions and seasons cannot be reset.");

      const lots = await tx.select({ id: auctionLotsTable.id, entryId: auctionLotsTable.entryId })
        .from(auctionLotsTable).where(eq(auctionLotsTable.auctionId, auctionId));
      const entryIds = lots.map((lot) => lot.entryId);
      const sales = await tx.select().from(auctionSalesTable).where(eq(auctionSalesTable.auctionId, auctionId));
      if (entryIds.length) {
        const poolEntries = await tx.select({ id: calcuttaEntriesTable.id }).from(calcuttaEntriesTable)
          .where(and(eq(calcuttaEntriesTable.calcuttaId, calcuttaId), inArray(calcuttaEntriesTable.id, entryIds)));
        if (poolEntries.length !== lots.length) throw new Error("Auction contains a lot outside this Calcutta. Reset was blocked.");
        const [approvedTrade] = await tx.select({ id: tradesTable.id }).from(tradesTable)
          .where(and(inArray(tradesTable.entryId, entryIds), eq(tradesTable.status, "approved"))).limit(1);
        if (approvedTrade) throw new Error("Approved trades protect this ownership. This auction cannot be reset.");

        // Only remove ownership that exactly matches this auction's recorded sales.
        // An external correction or pre-existing primary position must never be erased.
        const primary = await tx.select().from(positionsTable)
          .where(and(inArray(positionsTable.entryId, entryIds), eq(positionsTable.source, "primary")));
        const allocations = sales.length
          ? await tx.select().from(auctionSaleAllocationsTable)
            .where(inArray(auctionSaleAllocationsTable.saleId, sales.map((sale) => sale.id)))
          : [];
        if (sales.some((sale) => !allocations.some((allocation) => allocation.saleId === sale.id))) {
          throw new Error("A recorded sale is missing its ownership allocations. Reset was blocked.");
        }
        if (sales.some((sale) => allocations.filter((row) => row.saleId === sale.id)
          .reduce((sum, row) => sum + row.cents, 0) !== sale.totalCents)) {
          throw new Error("A recorded sale has inconsistent allocation amounts. Reset was blocked.");
        }
        const entryByLot = new Map(lots.map((lot) => [lot.id, lot.entryId]));
        const expected = new Map<string, { share: number; cents: number }>();
        for (const sale of sales) {
          const entryId = entryByLot.get(sale.lotId);
          if (entryId == null) throw new Error("Sale has no matching auction lot.");
          for (const allocation of allocations.filter((row) => row.saleId === sale.id)) {
            expected.set(`${entryId}:${allocation.bidderId}`, {
              share: Math.round(Number(allocation.share) * 1_000_000),
              cents: allocation.cents,
            });
          }
        }
        if (primary.length !== expected.size || primary.some((position) => {
          const recorded = expected.get(`${position.entryId}:${position.bidderId}`);
          return !recorded || Math.round(Number(position.ownershipShare) * 1_000_000) !== recorded.share
            || Math.round(Number(position.costBasis) * 100) !== recorded.cents;
        })) throw new Error("Auction ownership no longer matches the sales. Reset was blocked to protect existing results.");

        if (primary.length) await tx.delete(positionsTable).where(and(inArray(positionsTable.entryId, entryIds), eq(positionsTable.source, "primary")));
      }
      await tx.delete(auctionSalesTable).where(eq(auctionSalesTable.auctionId, auctionId));
      await tx.delete(listenerTicketsTable).where(eq(listenerTicketsTable.auctionId, auctionId));
      await tx.delete(listenerSessionsTable).where(eq(listenerSessionsTable.auctionId, auctionId));
      await tx.update(auctionLotsTable).set({
        status: "available", nominationId: null, nominationSequence: null,
        currentBidCents: null, nominatedAt: null, updatedAt: new Date(),
      }).where(eq(auctionLotsTable.auctionId, auctionId));
      await tx.update(auctionSessionsTable).set({
        status: "setup", currentLotId: null, startedAt: null, completedAt: null,
        revision: session.revision + 1,
      }).where(eq(auctionSessionsTable.id, auctionId));
      await event(tx, auctionId, "auction_reset", { clearedSales: sales.length, clearedLots: lots.length });
    });
    res.json(await snapshot(auctionId));
  } catch (error) {
    sendParsedJson(res, ErrorResponse, { error: error instanceof Error ? error.message : "Auction reset rejected." }, 409);
  }
});

router.post("/calcuttas/:calcuttaId/auctions/:auctionId/start", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req);
  const body = z.object({ expectedRevision: z.number().int().nonnegative() }).safeParse(req.body);
  if (!body.success) return sendParsedJson(res, ErrorResponse, { error: body.error.message }, 400);
  if (!id.safeParse(calcuttaId).success || !id.safeParse(auctionId).success || !(await ownsAuction(calcuttaId, auctionId))) {
    return sendParsedJson(res, ErrorResponse, { error: "Auction not found for this Calcutta." }, 404);
  }
  try {
    await db.transaction(async (tx) => {
      const [session] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update");
      if (!session) throw new Error("Auction not found.");
      if (session.revision !== body.data.expectedRevision) throw new Error("Stale auction revision.");
      if (session.status !== "setup") throw new Error(session.status === "complete" ? "Auction is complete." : "Auction is already live.");
      const startedAt = new Date();
      await tx.update(auctionSessionsTable).set({
        status: "live",
        startedAt,
        revision: session.revision + 1,
      }).where(eq(auctionSessionsTable.id, auctionId));
      await event(tx, auctionId, "auction_started", {});
    });
    res.json(await snapshot(auctionId));
  } catch (e) {
    sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Auction start rejected." }, 409);
  }
});

router.get("/calcuttas/:calcuttaId/auctions/:auctionId/entries", async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req);
  if (!id.safeParse(calcuttaId).success || !id.safeParse(auctionId).success || !(await ownsAuction(calcuttaId, auctionId))) {
    return sendParsedJson(res, ErrorResponse, { error: "Auction not found for this Calcutta." }, 404);
  }
  const entries = await db.select({ id: calcuttaEntriesTable.id, teamName: teamsTable.name })
    .from(calcuttaEntriesTable).innerJoin(teamsTable, eq(teamsTable.id, calcuttaEntriesTable.teamId))
    .where(eq(calcuttaEntriesTable.calcuttaId, calcuttaId)).orderBy(asc(teamsTable.name));
  res.json(entries);
});

router.post("/calcuttas/:calcuttaId/auctions/:auctionId/lots/bulk", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req);
  const body = z.object({ expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(200), dryRun: z.boolean().optional(), lots: z.array(lotInput).min(1).max(500) }).safeParse(req.body);
  if (!body.success) return sendParsedJson(res, ErrorResponse, { error: body.error.message }, 400);
  if (!(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "Auction not found." }, 404);
  const ids = body.data.lots.map((x) => normalizedLabel(x.externalId));
  if (new Set(ids).size !== ids.length) return sendParsedJson(res, ErrorResponse, { error: "Duplicate external ID in batch." }, 422);
  const entryIds = body.data.lots.map((x) => x.entryId);
  if (new Set(entryIds).size !== entryIds.length) return sendParsedJson(res, ErrorResponse, { error: "Each team-backed entry may occur only once per batch." }, 422);
  const result = await db.transaction(async (tx) => {
    const [session] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update");
    if (!session || session.status === "complete") throw new Error("Auction is complete.");
    if (body.data.expectedRevision != null && body.data.expectedRevision !== session.revision) throw new Error("Stale auction revision.");
    const [replayed] = await tx.select({ id: auctionEventsTable.id }).from(auctionEventsTable).where(and(eq(auctionEventsTable.auctionId, auctionId), eq(auctionEventsTable.idempotencyKey, body.data.idempotencyKey)));
    if (replayed) return { count: 0, changed: false, revision: session.revision };
    const entries = await tx.select({ id: calcuttaEntriesTable.id }).from(calcuttaEntriesTable).where(and(eq(calcuttaEntriesTable.calcuttaId, calcuttaId), inArray(calcuttaEntriesTable.id, entryIds)));
    if (entries.length !== new Set(body.data.lots.map((x) => x.entryId)).size) throw new Error("Every lot must reference an existing team-backed Calcutta entry.");
    const existing = await tx.select().from(auctionLotsTable).where(eq(auctionLotsTable.auctionId, auctionId));
    let changed = false;
    for (const lot of body.data.lots) {
      const found = existing.find((row) => normalizedLabel(row.externalId) === normalizedLabel(lot.externalId));
      if (found) {
        if (found.status !== "available") {
          if (found.entryId !== lot.entryId) throw new Error("Nominated or sold lots cannot be replaced with a different entry.");
          continue;
        }
        if (found.entryId !== lot.entryId) throw new Error("Existing lot entry cannot be changed.");
        if (found.displayName !== lot.name || JSON.stringify(found.aliases) !== JSON.stringify(lot.aliases ?? []) || JSON.stringify(found.metadata) !== JSON.stringify(lot.metadata ?? {})) {
          changed = true;
          if (!body.data.dryRun) await tx.update(auctionLotsTable).set({ displayName: lot.name, aliases: lot.aliases ?? [], metadata: lot.metadata ?? {}, updatedAt: new Date() }).where(eq(auctionLotsTable.id, found.id));
        }
      } else {
        changed = true;
        if (!body.data.dryRun) await tx.insert(auctionLotsTable).values({ auctionId, externalId: lot.externalId, displayName: lot.name, aliases: lot.aliases ?? [], metadata: lot.metadata ?? {}, entryId: lot.entryId });
      }
    }
    if (!changed || body.data.dryRun) return { count: body.data.lots.length, changed: false, revision: session.revision };
    await tx.update(auctionSessionsTable).set({ revision: session.revision + 1 }).where(eq(auctionSessionsTable.id, auctionId));
    await event(tx, auctionId, "inventory_updated", { count: body.data.lots.length }, body.data.idempotencyKey);
    return { count: body.data.lots.length, changed: true, revision: session.revision + 1 };
  });
  res.status(201).json({ inserted: result.count, changed: result.changed, dryRun: body.data.dryRun ?? false, revision: result.revision });
});

router.patch("/calcuttas/:calcuttaId/auctions/:auctionId/lots/:lotId", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req); const lotId = Number(req.params.lotId);
  const body = z.object({ name: z.string().trim().min(1).optional(), aliases: z.array(z.string()).optional(), metadata: z.record(z.string(), z.unknown()).optional(), expectedRevision: z.number().int().nonnegative() }).safeParse(req.body);
  if (!body.success) return sendParsedJson(res, ErrorResponse, { error: body.error.message }, 400);
  if (!(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "Auction not found." }, 404);
  try { await db.transaction(async (tx) => {
    const [session] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update");
    const [lot] = await tx.select().from(auctionLotsTable).where(and(eq(auctionLotsTable.id, lotId), eq(auctionLotsTable.auctionId, auctionId)));
    if (!session || !lot) throw new Error("Lot not found.");
    if (session.status === "complete") throw new Error("Completed auctions are read-only.");
    if (session.status === "complete" || lot.status !== "available") throw new Error("Only available lots can be edited.");
    if (body.data.expectedRevision != null && body.data.expectedRevision !== session.revision) throw new Error("Stale auction revision.");
    await tx.update(auctionLotsTable).set({ displayName: body.data.name, aliases: body.data.aliases, metadata: body.data.metadata, updatedAt: new Date() }).where(eq(auctionLotsTable.id, lotId));
    await tx.update(auctionSessionsTable).set({ revision: session.revision + 1 }).where(eq(auctionSessionsTable.id, auctionId));
    await event(tx, auctionId, "lot_updated", { lotId });
  }); } catch (e) { return sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Lot update rejected." }, 409); }
  res.json(await snapshot(auctionId));
});

router.delete("/calcuttas/:calcuttaId/auctions/:auctionId/lots/:lotId", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req); const lotId = Number(req.params.lotId);
  if (!(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "Auction not found." }, 404);
  const expectedRevision = z.number().int().nonnegative().safeParse(req.body?.expectedRevision).data;
  if (expectedRevision === undefined) return sendParsedJson(res, ErrorResponse, { error: "expectedRevision is required." }, 400);
  try { await db.transaction(async (tx) => {
    const [session] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update");
    const [lot] = await tx.select().from(auctionLotsTable).where(and(eq(auctionLotsTable.id, lotId), eq(auctionLotsTable.auctionId, auctionId)));
    if (!session || !lot) throw new Error("Lot not found.");
    if (session.status === "complete") throw new Error("Completed auctions are read-only.");
    if (lot.status !== "available") throw new Error("Nominated or sold lots cannot be removed.");
    if (expectedRevision != null && expectedRevision !== session.revision) throw new Error("Stale auction revision.");
    await tx.delete(auctionLotsTable).where(eq(auctionLotsTable.id, lotId));
    await tx.update(auctionSessionsTable).set({ revision: session.revision + 1 }).where(eq(auctionSessionsTable.id, auctionId));
    await event(tx, auctionId, "lot_deleted", { lotId });
  }); res.sendStatus(204); } catch (e) { sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Lot deletion rejected." }, 409); }
});

const consortiumOwnerInput = z.object({
  bidderId: id.optional(),
  newBidderName: z.string().trim().min(1).max(200).optional(),
  share: z.number().positive().max(1),
}).refine((value) => (value.bidderId != null) !== (value.newBidderName != null), "Each owner must select an existing bidder or provide a new name.");
function validateOwners(owners: Array<{ bidderId?: number; newBidderName?: string; share: number }>, exactFractions = false): void {
  const total = exactFractions ? (exactShareVector(owners.map(owner => owner.share)), 10000)
    : owners.reduce((sum, owner) => sum + shareBasisPoints(owner.share), 0);
  const existingIds = owners.flatMap((owner) => owner.bidderId == null ? [] : [owner.bidderId]);
  const newNames = owners.flatMap((owner) => owner.newBidderName == null ? [] : [normalizedLabel(owner.newBidderName)]);
  if (total !== 10000 || new Set(existingIds).size !== existingIds.length || new Set(newNames).size !== newNames.length) {
    throw new Error("Consortium owners must be unique and their positive four-decimal shares must total exactly 100%.");
  }
}
async function resolveOwnerBidderIds(tx: any, auctionId: number, owners: Array<{ bidderId?: number; newBidderName?: string; share: number }>, excludeConsortiumId?: number) {
  const [auction] = await tx.select({ calcuttaId: auctionSessionsTable.calcuttaId }).from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId));
  const exactFractions = auction?.calcuttaId === 2061;
  validateOwners(owners, exactFractions);
  const names = owners.flatMap((owner) => owner.newBidderName == null ? [] : [owner.newBidderName]);
  if (names.length) {
    for (const normalizedName of [...new Set(names.map(normalizedLabel))].sort()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${normalizedName}))`);
    }
    const allBidders = await tx.select({ id: biddersTable.id, name: biddersTable.name }).from(biddersTable);
    const existingNames = new Set(allBidders.map((bidder: { name: string }) => normalizedLabel(bidder.name)));
    if (names.some((name) => existingNames.has(normalizedLabel(name)))) {
      throw new Error("A bidder with that normalized name already exists. Select the existing bidder explicitly.");
    }
  }
  const ids = owners.flatMap((owner) => owner.bidderId == null ? [] : [owner.bidderId]);
  if (ids.length) {
    const present = await tx.select({ id: biddersTable.id }).from(biddersTable).where(inArray(biddersTable.id, ids));
    if (present.length !== ids.length) throw new Error("Every owner must reference an existing bidder.");
  }
  const memberships = await tx.select({
    bidderId: auctionConsortiumOwnersTable.bidderId,
    consortiumId: auctionConsortiumOwnersTable.consortiumId,
  }).from(auctionConsortiumOwnersTable).where(and(
    eq(auctionConsortiumOwnersTable.auctionId, auctionId),
    ids.length ? inArray(auctionConsortiumOwnersTable.bidderId, ids) : sql`false`,
  ));
  if (memberships.some((membership: { consortiumId: number }) => membership.consortiumId !== excludeConsortiumId)) {
    throw new Error("A bidder can belong to only one consortium in an auction.");
  }
  const output: Array<{ bidderId: number; share: number }> = [];
  for (const owner of owners) {
    let bidderId = owner.bidderId;
    if (owner.newBidderName != null) {
      const [created] = await tx.insert(biddersTable).values({ name: owner.newBidderName }).returning({ id: biddersTable.id });
      bidderId = created.id;
    }
    output.push({ bidderId: bidderId!, share: exactFractions ? 0 : shareBasisPoints(owner.share) });
  }
  if (exactFractions) {
    const fractions = exactShareVector(owners.map(owner => owner.share));
    const shares = allocateExactCents(10000, output.map((owner, index) => ({ id: owner.bidderId, share: fractions[index]! })));
    for (const owner of output) owner.share = shares.get(owner.bidderId)!;
  }
  return output;
}

router.post("/calcuttas/:calcuttaId/auctions/:auctionId/consortia", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req);
  const body = z.object({
    displayName: z.string().trim().min(1).max(200),
    aliases: z.array(z.string().trim().min(1)).max(20).optional(),
    bidderId: id.optional(),
    newBidderName: z.string().trim().min(1).max(200).optional(),
    owners: z.array(consortiumOwnerInput).min(1).optional(),
    expectedRevision: z.number().int().nonnegative(),
  }).refine((value) => value.owners != null
    ? value.bidderId == null && value.newBidderName == null
    : (value.bidderId != null) !== (value.newBidderName != null),
  "Provide a roster of owners or choose one legacy bidder mapping.").safeParse(req.body);
  if (!body.success || !(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "Invalid consortium." }, 400);
  if (body.data.owners) {
    try { validateOwners(body.data.owners); }
    catch (e) { return sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Invalid owner shares." }, 422); }
  }
  try {
    const created = await db.transaction(async (tx) => {
      const [session] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update");
      if (!session || session.status === "complete" || session.revision !== body.data.expectedRevision) throw new Error("Stale or completed auction.");
      const roster = await tx.select().from(auctionConsortiaTable).where(eq(auctionConsortiaTable.auctionId, auctionId));
      const labels = [body.data.displayName, ...(body.data.aliases ?? [])].map(normalizedLabel);
      if (new Set(labels).size !== labels.length || roster.some((r) => [r.displayName, ...(r.aliases ?? [])].map(normalizedLabel).some((x) => labels.includes(x)))) {
        throw new Error("Consortium display name or alias is ambiguous.");
      }
      const ownerInputs = body.data.owners ?? [{
        bidderId: body.data.bidderId,
        newBidderName: body.data.newBidderName,
        share: 1,
      }];
      const owners = await resolveOwnerBidderIds(tx, auctionId, ownerInputs);
      const legacyBidderId = owners.length === 1 ? owners[0].bidderId : null;
      const [row] = await tx.insert(auctionConsortiaTable).values({
        auctionId, displayName: body.data.displayName, aliases: body.data.aliases ?? [], bidderId: legacyBidderId,
      }).returning();
      await tx.insert(auctionConsortiumOwnersTable).values(owners.map((owner) => ({
        auctionId, consortiumId: row.id, bidderId: owner.bidderId, share: (owner.share / 10000).toFixed(4),
      })));
      await tx.update(auctionSessionsTable).set({ revision: session.revision + 1 }).where(eq(auctionSessionsTable.id, auctionId));
      await event(tx, auctionId, "consortium_added", { consortiumId: row.id });
      return row;
    });
    const current = await snapshot(auctionId);
    res.status(201).json(current?.consortia.find((consortium) => consortium.id === created.id));
  } catch (e) { sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Consortium name is already registered for this auction." }, 409); }
});
router.patch("/calcuttas/:calcuttaId/auctions/:auctionId/consortia/:consortiumId", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req); const consortiumId = Number(req.params.consortiumId);
  const body = z.object({
    displayName: z.string().trim().min(1).max(200).optional(),
    aliases: z.array(z.string().trim().min(1)).max(20).optional(),
    bidderId: id.optional(),
    owners: z.array(consortiumOwnerInput).min(1).optional(),
    active: z.boolean().optional(),
    expectedRevision: z.number().int().nonnegative(),
  }).refine((value) => value.owners == null || value.bidderId == null, "Use either owners or the legacy bidderId field.").safeParse(req.body);
  if (!body.success || !(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "Invalid consortium." }, 400);
  if (body.data.owners) {
    try { validateOwners(body.data.owners); }
    catch (e) { return sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Invalid owner shares." }, 422); }
  }
  let row;
  try {
    row = await db.transaction(async (tx) => {
      const [session] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update");
      if (!session || session.status === "complete" || body.data.expectedRevision !== session.revision) throw new Error("Stale or completed auction.");
      const [current] = await tx.select().from(auctionConsortiaTable).where(and(eq(auctionConsortiaTable.id, consortiumId), eq(auctionConsortiaTable.auctionId, auctionId)));
      if (!current) return undefined;
      const currentOwners = await tx.select({
        bidderId: auctionConsortiumOwnersTable.bidderId,
        share: auctionConsortiumOwnersTable.share,
      }).from(auctionConsortiumOwnersTable).where(eq(auctionConsortiumOwnersTable.consortiumId, consortiumId));
      let resolvedOwners: Array<{ bidderId: number; share: number }> | undefined;
      if (body.data.owners != null) resolvedOwners = await resolveOwnerBidderIds(tx, auctionId, body.data.owners, consortiumId);
      else if (body.data.bidderId != null && body.data.bidderId !== current.bidderId) {
        resolvedOwners = await resolveOwnerBidderIds(tx, auctionId, [{ bidderId: body.data.bidderId, share: 1 }], consortiumId);
      }
      const membershipChanged = resolvedOwners != null && (
        resolvedOwners.length !== currentOwners.length
        || resolvedOwners.some((owner) => !currentOwners.some((old: { bidderId: number; share: string }) =>
          old.bidderId === owner.bidderId && Math.round(Number(old.share) * 10000) === owner.share))
      );
      if (membershipChanged) {
        const previousBidderIds = currentOwners.map((owner: { bidderId: number }) => owner.bidderId);
        const [used] = await tx.select({ id: auctionSalesTable.id }).from(auctionSalesTable)
          .innerJoin(auctionSaleAllocationsTable, eq(auctionSaleAllocationsTable.saleId, auctionSalesTable.id))
          .where(and(
            eq(auctionSalesTable.auctionId, auctionId),
            or(
              eq(auctionSaleAllocationsTable.consortiumId, consortiumId),
              previousBidderIds.length ? inArray(auctionSaleAllocationsTable.bidderId, previousBidderIds) : sql`false`,
            ),
          )).limit(1);
        if (used) throw new Error("Consortium membership cannot change after a finalized sale uses it.");
      }
      const roster = await tx.select().from(auctionConsortiaTable).where(eq(auctionConsortiaTable.auctionId, auctionId));
      const displayName = body.data.displayName ?? current.displayName;
      const aliases = body.data.aliases ?? current.aliases ?? [];
      const labels = [displayName, ...aliases].map(normalizedLabel);
      if (new Set(labels).size !== labels.length || roster.filter((r) => r.id !== consortiumId).some((r) => [r.displayName, ...(r.aliases ?? [])].map(normalizedLabel).some((x) => labels.includes(x)))) throw new Error("Consortium display name or alias is ambiguous.");
      if (resolvedOwners) {
        await tx.delete(auctionConsortiumOwnersTable).where(eq(auctionConsortiumOwnersTable.consortiumId, consortiumId));
        await tx.insert(auctionConsortiumOwnersTable).values(resolvedOwners.map((owner) => ({
          auctionId, consortiumId, bidderId: owner.bidderId, share: (owner.share / 10000).toFixed(4),
        })));
      }
      const selectedOwners = resolvedOwners ?? currentOwners.map((owner: { bidderId: number; share: string }) => ({
        bidderId: owner.bidderId, share: Math.round(Number(owner.share) * 10000),
      }));
      const legacyBidderId = selectedOwners.length === 1 ? selectedOwners[0].bidderId : null;
      const [updated] = await tx.update(auctionConsortiaTable).set({
        displayName, aliases, bidderId: legacyBidderId,
        active: body.data.active == null ? undefined : body.data.active ? 1 : 0,
      }).where(eq(auctionConsortiaTable.id, consortiumId)).returning();
      await tx.update(auctionSessionsTable).set({ revision: session.revision + 1 }).where(eq(auctionSessionsTable.id, auctionId));
      await event(tx, auctionId, "consortium_updated", { consortiumId });
      return updated;
    });
  } catch (e) { return sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Consortium update rejected." }, 409); }
  if (!row) return sendParsedJson(res, ErrorResponse, { error: "Consortium not found." }, 404);
  const current = await snapshot(auctionId);
  res.json(current?.consortia.find((consortium) => consortium.id === row.id));
});

// Calcutta XIII's completed auction can be corrected without rewriting a prior
// pool. The roster and every affected sale move in one audited transaction.
router.post("/calcuttas/:calcuttaId/auctions/:auctionId/consortia/:consortiumId/correction", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req);
  const consortiumId = Number(req.params.consortiumId);
  const body = z.object({
    displayName: z.string().trim().min(1).max(200),
    owners: z.array(consortiumOwnerInput).min(1),
    reason: z.string().trim().min(1).max(500),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().uuid(),
  }).safeParse(req.body);
  if (!body.success || !id.safeParse(consortiumId).success || !(await ownsAuction(calcuttaId, auctionId))) {
    return sendParsedJson(res, ErrorResponse, { error: "Invalid consortium correction." }, 400);
  }
  try { validateOwners(body.data.owners); }
  catch (error) { return sendParsedJson(res, ErrorResponse, { error: error instanceof Error ? error.message : "Invalid owner shares." }, 422); }
  try {
    await db.transaction(async (tx) => {
      const [calcutta] = await tx.select({ seasonId: calcuttasTable.seasonId, name: calcuttasTable.name, sport: calcuttasTable.sport })
        .from(calcuttasTable).where(eq(calcuttasTable.id, calcuttaId));
      if (!calcutta || !/^Calcutta XIII(?:\b|$)/i.test(calcutta.name) || calcutta.sport !== "MLB") {
        throw new Error("Post-auction consortium corrections are limited to Calcutta XIII.");
      }
      await tx.execute(sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${calcutta.seasonId})`);
      const [session] = await tx.select().from(auctionSessionsTable)
        .where(and(eq(auctionSessionsTable.id, auctionId), eq(auctionSessionsTable.calcuttaId, calcuttaId))).for("update");
      if (!session || session.status !== "complete" || session.revision !== body.data.expectedRevision) {
        throw new Error("This correction requires a completed auction and its current revision.");
      }
      const [replayed] = await tx.select({ id: auctionEventsTable.id }).from(auctionEventsTable)
        .where(and(eq(auctionEventsTable.auctionId, auctionId), eq(auctionEventsTable.idempotencyKey, body.data.idempotencyKey)));
      if (replayed) throw new Error("This correction was already submitted. Refresh the auction.");
      const [current] = await tx.select().from(auctionConsortiaTable)
        .where(and(eq(auctionConsortiaTable.id, consortiumId), eq(auctionConsortiaTable.auctionId, auctionId)));
      if (!current) throw new Error("Consortium not found in this auction.");
      const roster = await tx.select().from(auctionConsortiaTable).where(eq(auctionConsortiaTable.auctionId, auctionId));
      const labels = [body.data.displayName, ...(current.aliases ?? [])].map(normalizedLabel);
      if (new Set(labels).size !== labels.length || roster.some((row) =>
        row.id !== consortiumId && [row.displayName, ...(row.aliases ?? [])].map(normalizedLabel).some((label) => labels.includes(label)))) {
        throw new Error("Consortium name conflicts with an existing name or alias.");
      }
      const previousOwners = await tx.select().from(auctionConsortiumOwnersTable)
        .where(eq(auctionConsortiumOwnersTable.consortiumId, consortiumId));
      const nextOwners = await resolveOwnerBidderIds(tx, auctionId, body.data.owners, consortiumId);
      const ownerChanged = nextOwners.length !== previousOwners.length || nextOwners.some((owner) =>
        !previousOwners.some((old) => old.bidderId === owner.bidderId && shareBasisPoints(Number(old.share)) === owner.share));
      if (ownerChanged && previousOwners.length) {
        const previousIds = previousOwners.map((owner) => owner.bidderId);
        const [ambiguous] = await tx.select({ id: auctionSaleAllocationsTable.id })
          .from(auctionSaleAllocationsTable)
          .innerJoin(auctionSalesTable, eq(auctionSalesTable.id, auctionSaleAllocationsTable.saleId))
          .where(and(
            eq(auctionSalesTable.auctionId, auctionId),
            inArray(auctionSaleAllocationsTable.bidderId, previousIds),
            sql`${auctionSaleAllocationsTable.consortiumId} is distinct from ${consortiumId}`,
          )).limit(1);
        if (ambiguous) throw new Error("A prior owner has an ambiguous sale attribution; correction was blocked.");
      }
      const saleRows = await tx.select({
        saleId: auctionSalesTable.id, lotId: auctionLotsTable.id,
        entryId: auctionLotsTable.entryId, teamId: calcuttaEntriesTable.teamId,
        totalCents: auctionSalesTable.totalCents,
      }).from(auctionSaleAllocationsTable)
        .innerJoin(auctionSalesTable, eq(auctionSalesTable.id, auctionSaleAllocationsTable.saleId))
        .innerJoin(auctionLotsTable, eq(auctionLotsTable.id, auctionSalesTable.lotId))
        .innerJoin(calcuttaEntriesTable, eq(calcuttaEntriesTable.id, auctionLotsTable.entryId))
        .where(and(eq(auctionSalesTable.auctionId, auctionId), eq(auctionSaleAllocationsTable.consortiumId, consortiumId)));
      const affectedSales = [...new Map(saleRows.map((sale) => [sale.saleId, sale])).values()];
      const corrected: Array<{ saleId: number; lotId: number; before: unknown; after: unknown }> = [];
      if (ownerChanged) for (const sale of affectedSales) {
        const [approved] = await tx.select({ id: tradesTable.id }).from(tradesTable)
          .where(and(eq(tradesTable.entryId, sale.entryId), eq(tradesTable.status, "approved"))).limit(1);
        if (approved) throw new Error("An approved trade protects a sold lot. Use a correcting trade instead.");
        const allocations = await tx.select().from(auctionSaleAllocationsTable)
          .where(eq(auctionSaleAllocationsTable.saleId, sale.saleId)).for("update");
        const primary = await tx.select().from(positionsTable)
          .where(and(eq(positionsTable.entryId, sale.entryId), eq(positionsTable.source, "primary"))).for("update");
        const recorded = new Map(allocations.map((row) => [row.bidderId, row]));
        if (recorded.size !== allocations.length || primary.length !== allocations.length ||
          primary.some((position) => {
            const row = recorded.get(position.bidderId);
            return !row || Math.round(Number(position.ownershipShare) * 1_000_000) !== Math.round(Number(row.share) * 1_000_000)
              || Math.round(Number(position.costBasis) * 100) !== row.cents;
          }) || allocations.reduce((sum, row) => sum + row.cents, 0) !== sale.totalCents ||
          allocations.reduce((sum, row) => sum + Math.round(Number(row.share) * 10000), 0) !== 10000) {
          throw new Error("Recorded sale and primary ownership differ. Correction was blocked.");
        }
        const group = allocations.filter((row) => row.consortiumId === consortiumId);
        const groupCents = group.reduce((sum, row) => sum + row.cents, 0);
        const groupBps = group.reduce((sum, row) => sum + Math.round(Number(row.share) * 10000), 0);
        if (!group.length || groupCents < nextOwners.length || groupBps < nextOwners.length) {
          throw new Error("This sale cannot allocate a positive share and cent to every new owner.");
        }
        const shares = distributeIntegerTotal(nextOwners.map((owner) => ({ bidderId: owner.bidderId, weight: owner.share })), groupBps);
        const amounts = calcuttaId === 2061 ? (() => {
          const fractions = exactShareVector(nextOwners.map(owner => owner.share / 10000));
          const cents = allocateExactCents(groupCents, nextOwners.map((owner, index) => ({ id: owner.bidderId, share: fractions[index]! })));
          return nextOwners.map(owner => ({ bidderId: owner.bidderId, amount: cents.get(owner.bidderId)! }));
        })() : distributeIntegerTotal(shares.map((owner) => ({ bidderId: owner.bidderId, weight: owner.amount })), groupCents);
        const amountByBidder = new Map(amounts.map((row) => [row.bidderId, row.amount]));
        const groupNext = shares.map((owner) => ({
          bidderId: owner.bidderId, consortiumId, share: (owner.amount / 10000).toFixed(6),
          cents: amountByBidder.get(owner.bidderId)!,
        }));
        const remaining = allocations.filter((row) => row.consortiumId !== consortiumId);
        const next = [...remaining, ...groupNext];
        if (next.some((row) => row.cents <= 0 || Number(row.share) <= 0) ||
          new Set(next.map((row) => row.bidderId)).size !== next.length) {
          throw new Error("A corrected owner already has an allocation in this sale.");
        }
        const before = allocations.map((row) => ({ bidderId: row.bidderId, consortiumId: row.consortiumId, share: Number(row.share), cents: row.cents }));
        const after = next.map((row) => ({ bidderId: row.bidderId, consortiumId: row.consortiumId, share: Number(row.share), cents: row.cents }));
        await tx.delete(auctionSaleAllocationsTable).where(eq(auctionSaleAllocationsTable.saleId, sale.saleId));
        await tx.insert(auctionSaleAllocationsTable).values(next.map((row) => ({
          saleId: sale.saleId, bidderId: row.bidderId, consortiumId: row.consortiumId, share: row.share, cents: row.cents,
        })));
        await tx.delete(positionsTable).where(and(eq(positionsTable.entryId, sale.entryId), eq(positionsTable.source, "primary")));
        await tx.insert(positionsTable).values(next.map((row) => ({
          entryId: sale.entryId, bidderId: row.bidderId, ownershipShare: row.share,
          source: "primary", costBasis: (row.cents / 100).toFixed(2),
        })));
        await tx.insert(ownershipAdjustmentsTable).values({
          seasonId: calcutta.seasonId, teamId: sale.teamId, source: "auction_sale_correction",
          note: body.data.reason, owners: { before, after },
        });
        if (calcuttaId === 2061) {
          const fractions = exactShareVector(next.map(owner => Number(owner.share)));
          await recordExactPrimaryFractions(tx, calcuttaId, sale.entryId, next.map((owner, index) => ({
            bidderId: owner.bidderId, numerator: fractions[index]!.numerator.toString(), denominator: fractions[index]!.denominator.toString(),
          })), body.data.reason);
        }
        await tx.update(auctionSalesTable).set({ reason: body.data.reason, correctedAt: new Date() })
          .where(eq(auctionSalesTable.id, sale.saleId));
        corrected.push({ saleId: sale.saleId, lotId: sale.lotId, before, after });
      }
      if (ownerChanged) {
        await tx.delete(auctionConsortiumOwnersTable).where(eq(auctionConsortiumOwnersTable.consortiumId, consortiumId));
        await tx.insert(auctionConsortiumOwnersTable).values(nextOwners.map((owner) => ({
          auctionId, consortiumId, bidderId: owner.bidderId, share: (owner.share / 10000).toFixed(4),
        })));
      }
      await tx.update(auctionConsortiaTable).set({
        displayName: body.data.displayName,
        bidderId: nextOwners.length === 1 ? nextOwners[0].bidderId : null,
      }).where(eq(auctionConsortiaTable.id, consortiumId));
      await tx.update(auctionSessionsTable).set({ revision: session.revision + 1 }).where(eq(auctionSessionsTable.id, auctionId));
      await event(tx, auctionId, "consortium_corrected", {
        consortiumId, beforeName: current.displayName, afterName: body.data.displayName,
        beforeOwners: previousOwners.map((owner) => ({ bidderId: owner.bidderId, share: Number(owner.share) })),
        afterOwners: nextOwners.map((owner) => ({ bidderId: owner.bidderId, share: owner.share / 10000 })),
        correctedSales: corrected, reason: body.data.reason,
      }, body.data.idempotencyKey);
    });
    res.json(await snapshot(auctionId));
  } catch (error) {
    sendParsedJson(res, ErrorResponse, { error: error instanceof Error ? error.message : "Consortium correction rejected." }, 409);
  }
});

router.post("/calcuttas/:calcuttaId/auctions/:auctionId/nominate-next", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req);
  const body = z.object({ expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(200) }).safeParse(req.body);
  if (!body.success || !(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "Invalid auction nomination request." }, 400);
  try {
    await db.transaction(async (tx) => {
      const [session] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update");
      const [replayed] = await tx.select({ id: auctionEventsTable.id }).from(auctionEventsTable).where(and(eq(auctionEventsTable.auctionId, auctionId), eq(auctionEventsTable.idempotencyKey, body.data.idempotencyKey)));
      if (replayed) return;
      if (!session) throw new Error("Auction not found."); if (session.revision !== body.data.expectedRevision) throw new Error("Stale auction revision.");
      if (session.status === "complete") throw new Error("Auction is complete.");
      const [current] = await tx.select({ id: auctionLotsTable.id }).from(auctionLotsTable).where(and(eq(auctionLotsTable.auctionId, auctionId), eq(auctionLotsTable.status, "bidding")));
      if (current) throw new Error("Current lot must be sold before nominating the next lot.");
      const [lot] = await tx.select().from(auctionLotsTable).where(and(eq(auctionLotsTable.auctionId, auctionId), eq(auctionLotsTable.status, "available"))).orderBy(sql`random()`).limit(1).for("update");
      if (!lot) throw new Error("No available lots remain.");
      const nominationId = randomUUID(); const sequence = (await tx.select({ n: sql<number>`coalesce(max(${auctionLotsTable.nominationSequence}),0)` }).from(auctionLotsTable).where(eq(auctionLotsTable.auctionId, auctionId)))[0].n + 1;
      await tx.update(auctionLotsTable).set({ status: "bidding", nominationId, nominationSequence: sequence, nominatedAt: new Date(), currentBidCents: null }).where(eq(auctionLotsTable.id, lot.id));
      await tx.update(auctionSessionsTable).set({ status: "live", currentLotId: lot.id, revision: session.revision + 1, startedAt: session.startedAt ?? new Date() }).where(eq(auctionSessionsTable.id, auctionId));
      await event(tx, auctionId, "lot_nominated", { lotId: lot.id }, body.data.idempotencyKey, nominationId);
    });
    res.json(await snapshot(auctionId));
  } catch (e) { sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Nomination failed." }, 409); }
});

router.patch("/calcuttas/:calcuttaId/auctions/:auctionId/current-bid", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req); const body = z.object({ cents: z.number().int().positive(), expectedRevision: z.number().int().nonnegative() }).safeParse(req.body);
  if (!body.success || !(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "Invalid bid." }, 400);
  try { await db.transaction(async (tx) => {
    const [session] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update");
    if (!session || session.status === "complete" || !session.currentLotId) throw new Error("Auction is complete or no lot is bidding.");
    if (body.data.expectedRevision != null && session.revision !== body.data.expectedRevision) throw new Error("Stale auction revision.");
    await tx.update(auctionLotsTable).set({ currentBidCents: body.data.cents }).where(and(eq(auctionLotsTable.id, session.currentLotId), eq(auctionLotsTable.status, "bidding")));
    await tx.update(auctionSessionsTable).set({ revision: session.revision + 1 }).where(eq(auctionSessionsTable.id, auctionId));
    await event(tx, auctionId, "bid_updated", { lotId: session.currentLotId, cents: body.data.cents });
  }); res.json(await snapshot(auctionId)); } catch (e) { sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Bid rejected." }, 409); }
});

router.post("/calcuttas/:calcuttaId/auctions/:auctionId/lots/:lotId/sale", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req); const lotId = Number(req.params.lotId);
  const allocationInput = z.object({ bidderId: id.optional(), consortiumId: id.optional(), share: z.number().positive().max(1) })
    .refine((allocation) => (allocation.bidderId != null) !== (allocation.consortiumId != null));
  const body = z.object({ totalCents: z.number().int().positive().optional(), price: z.number().positive().optional(), allocations: z.array(allocationInput).min(1), expectedRevision: z.number().int().nonnegative(), reason: z.string().max(500).optional() }).refine((v) => v.totalCents != null || v.price != null).safeParse(req.body);
  if (!body.success || !(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "Invalid sale." }, 400);
  let total: number;
  try { total = body.data.totalCents ?? cents(body.data.price!); validateAllocationInput(body.data.allocations, calcuttaId === 2061); }
  catch (e) { return sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Invalid sale allocation." }, 422); }
  try {
    await finalizeAuctionSale(calcuttaId, auctionId, lotId, { ...body.data, totalCents: total }); res.json(await snapshot(auctionId));
  } catch (e) { sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Sale failed." }, 409); }
});

router.patch("/calcuttas/:calcuttaId/auctions/:auctionId/lots/:lotId/sale", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req); const lotId = Number(req.params.lotId);
  const correctionAllocation = z.object({ bidderId: id.optional(), consortiumId: id.optional(), share: z.number().positive().max(1) })
    .refine((allocation) => (allocation.bidderId != null) !== (allocation.consortiumId != null));
  const body = z.object({ totalCents: z.number().int().positive(), reason: z.string().trim().min(1).max(500), idempotencyKey: z.string().min(8).max(200), expectedRevision: z.number().int().nonnegative(), allocations: z.array(correctionAllocation).min(1) }).safeParse(req.body);
  if (!body.success || !(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "A correction reason and positive cents amount are required." }, 400);
  try {
    await db.transaction(async (tx) => {
      const [calcutta] = await tx.select({ seasonId: calcuttasTable.seasonId }).from(calcuttasTable).where(eq(calcuttasTable.id, calcuttaId));
      if (!calcutta) throw new Error("Calcutta not found.");
      await tx.execute(sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${calcutta.seasonId})`);
      const [session] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update");
      const [replayed] = await tx.select({ id: auctionEventsTable.id }).from(auctionEventsTable).where(and(eq(auctionEventsTable.auctionId, auctionId), eq(auctionEventsTable.idempotencyKey, body.data.idempotencyKey)));
      if (replayed) throw new Error("Duplicate sale correction idempotency key.");
      if (!session || session.status === "complete" || session.revision !== body.data.expectedRevision) throw new Error("Auction is complete or stale.");
      const [lot] = await tx.select().from(auctionLotsTable).where(and(eq(auctionLotsTable.id, lotId), eq(auctionLotsTable.auctionId, auctionId)));
      if (!session || !lot) throw new Error("Lot not found.");
      const [sale] = await tx.select({ id: auctionSalesTable.id }).from(auctionSalesTable)
        .where(and(eq(auctionSalesTable.auctionId, auctionId), eq(auctionSalesTable.lotId, lotId))).for("update");
      if (!sale || lot.status !== "sold") throw new Error("Only a recorded sale can be corrected.");
      const [trade] = await tx.select({ id: tradesTable.id }).from(tradesTable).where(and(eq(tradesTable.entryId, lot.entryId), eq(tradesTable.status, "approved"))).limit(1);
      if (trade) throw new Error("Approved trades protect this ownership; correction requires the established correcting trade workflow.");
      const primary = await tx.select().from(positionsTable).where(and(eq(positionsTable.entryId, lot.entryId), eq(positionsTable.source, "primary")));
      if (!primary.length) throw new Error("No auction-originated primary ownership exists for this lot.");
      const oldOwners = primary.map((p) => ({ bidderId: p.bidderId, share: Number(p.ownershipShare), costBasis: Number(p.costBasis) }));
      const nextOwners = await expandSaleAllocations(tx, auctionId, body.data.allocations, body.data.totalCents, calcuttaId === 2061);
      await tx.delete(auctionSaleAllocationsTable).where(eq(auctionSaleAllocationsTable.saleId, sale.id));
      await tx.insert(auctionSaleAllocationsTable).values(nextOwners.map((owner) => ({
        saleId: sale.id, bidderId: owner.bidderId, consortiumId: owner.consortiumId,
        share: (owner.basisPoints / 10000).toFixed(6), cents: owner.cents,
      })));
      await tx.delete(positionsTable).where(and(eq(positionsTable.entryId, lot.entryId), eq(positionsTable.source, "primary")));
      await tx.insert(positionsTable).values(nextOwners.map((a) => ({ entryId: lot.entryId, bidderId: a.bidderId, ownershipShare: (a.basisPoints / 10000).toFixed(6), source: "primary", costBasis: (a.cents / 100).toFixed(2) })));
      const [entry] = await tx.select({ teamId: calcuttaEntriesTable.teamId }).from(calcuttaEntriesTable).where(eq(calcuttaEntriesTable.id, lot.entryId));
      const recordedOwners = nextOwners.map((owner) => ({
        bidderId: owner.bidderId, consortiumId: owner.consortiumId,
        share: owner.basisPoints / 10000, cents: owner.cents,
      }));
      await tx.insert(ownershipAdjustmentsTable).values({ seasonId: calcutta.seasonId, teamId: entry.teamId, source: "auction_sale_correction", note: body.data.reason, owners: { before: oldOwners, after: recordedOwners } });
      if (calcuttaId === 2061) await recordExactPrimaryFractions(tx, calcuttaId, lot.entryId,
        nextOwners.map(owner => ({ bidderId: owner.bidderId, numerator: owner.numerator!, denominator: owner.denominator! })), body.data.reason);
      await tx.update(auctionSalesTable).set({ totalCents: body.data.totalCents, reason: body.data.reason, correctedAt: new Date() }).where(and(eq(auctionSalesTable.auctionId, auctionId), eq(auctionSalesTable.lotId, lotId)));
      await tx.update(auctionSessionsTable).set({ revision: session.revision + 1 }).where(eq(auctionSessionsTable.id, auctionId));
      await event(tx, auctionId, "sale_corrected", { lotId, totalCents: body.data.totalCents, reason: body.data.reason, before: oldOwners, after: recordedOwners }, body.data.idempotencyKey);
    });
    res.json(await snapshot(auctionId));
  } catch (e) { sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Sale correction rejected." }, 409); }
});

router.post("/calcuttas/:calcuttaId/auctions/:auctionId/complete", requireAdmin, async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req); if (!(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "Auction not found." }, 404);
  const body = z.object({ expectedRevision: z.number().int().nonnegative() }).safeParse(req.body);
  if (!body.success) return sendParsedJson(res, ErrorResponse, { error: body.error.message }, 400);
  try { await db.transaction(async (tx) => { const [s] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update"); const lots = await tx.select({ id: auctionLotsTable.id }).from(auctionLotsTable).where(eq(auctionLotsTable.auctionId, auctionId)); const unsoldRows = await tx.select({ id: auctionLotsTable.id }).from(auctionLotsTable).where(and(eq(auctionLotsTable.auctionId, auctionId), sql`${auctionLotsTable.status} <> 'sold'`)); if (!s || s.status === "complete" || s.revision !== body.data.expectedRevision || lots.length === 0 || unsoldRows.length) throw new Error("Stale, complete, empty, or unresolved auction."); await tx.update(auctionSessionsTable).set({ status: "complete", completedAt: new Date(), revision: s.revision + 1 }).where(eq(auctionSessionsTable.id, auctionId)); await tx.update(listenerSessionsTable).set({ revokedAt: new Date(), recording: false, pending: 0 }).where(and(eq(listenerSessionsTable.auctionId, auctionId), isNull(listenerSessionsTable.revokedAt))); await event(tx, auctionId, "auction_completed", {}); }); res.json(await snapshot(auctionId)); } catch (e) { sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Cannot complete auction." }, 409); }
});

router.get("/calcuttas/:calcuttaId/auctions/:auctionId/events", async (req, res): Promise<any> => {
  const { calcuttaId, auctionId } = routeIds(req); if (!(await ownsAuction(calcuttaId, auctionId))) return sendParsedJson(res, ErrorResponse, { error: "Auction not found." }, 404);
  const after = Number(req.query.after ?? 0); res.json(await db.select().from(auctionEventsTable).where(and(eq(auctionEventsTable.auctionId, auctionId), sql`${auctionEventsTable.sequence} > ${after}`)).orderBy(asc(auctionEventsTable.sequence)).limit(500));
});

export default router;
