import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db, auctionSessionsTable, auctionLotsTable, auctionConsortiaTable,
  auctionConsortiumOwnersTable, auctionSalesTable, auctionSaleAllocationsTable, auctionEventsTable,
  calcuttasTable, calcuttaEntriesTable, teamsTable, positionsTable, tradesTable, biddersTable, ownershipAdjustmentsTable, teamSeasonAuctionsTable,
  listenerSessionsTable, seasonsTable,
} from "@workspace/db";
import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "../lib/ownershipShares";
import { requireAdmin } from "../middlewares/requireAdmin";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";

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
type AllocationInput = { bidderId?: number; consortiumId?: number; share: number };
type ExpandedAllocation = { bidderId: number; consortiumId: number; basisPoints: number; cents: number };
function shareBasisPoints(share: number): number {
  if (!Number.isFinite(share) || share <= 0 || share > 1 || Math.abs(share * 10000 - Math.round(share * 10000)) > 1e-7) {
    throw new Error("Allocation shares must be positive, use at most four decimals, and total exactly 100%.");
  }
  return Math.round(share * 10000);
}
function distributeIntegerTotal<T extends { bidderId: number; weight: number }>(rows: T[], total: number): Array<T & { amount: number }> {
  const weightTotal = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!rows.length || weightTotal <= 0) throw new Error("At least one positive owner allocation is required.");
  const staged = rows.map((row) => {
    const exact = total * row.weight / weightTotal;
    const amount = Math.floor(exact);
    return { ...row, amount, remainder: exact - amount };
  });
  let remaining = total - staged.reduce((sum, row) => sum + row.amount, 0);
  const order = [...staged].sort((a, b) => b.remainder - a.remainder || a.bidderId - b.bidderId);
  for (let i = 0; i < remaining; i++) order[i % order.length].amount++;
  return staged.map((row) => {
    const { remainder: _remainder, ...result } = row;
    return result as T & { amount: number };
  });
}
function validateAllocationInput(shares: AllocationInput[]): void {
  const seen = new Set<string>();
  let total = 0;
  for (const allocation of shares) {
    if ((allocation.bidderId == null) === (allocation.consortiumId == null)) throw new Error("Each allocation must name exactly one bidder or consortium.");
    const key = allocation.consortiumId != null ? `c${allocation.consortiumId}` : `b${allocation.bidderId}`;
    if (seen.has(key)) throw new Error("Allocation buyers must be unique.");
    seen.add(key);
    total += shareBasisPoints(allocation.share);
  }
  if (total !== 10000) throw new Error("Allocation shares must be unique, use at most four decimals, and total exactly 100%.");
}
async function expandSaleAllocations(tx: any, auctionId: number, inputs: AllocationInput[], totalCents: number): Promise<ExpandedAllocation[]> {
  validateAllocationInput(inputs);
  const consortia = await tx.select({
    id: auctionConsortiaTable.id,
    active: auctionConsortiaTable.active,
  }).from(auctionConsortiaTable).where(eq(auctionConsortiaTable.auctionId, auctionId));
  const ownerRows = await tx.select({
    consortiumId: auctionConsortiumOwnersTable.consortiumId,
    bidderId: auctionConsortiumOwnersTable.bidderId,
    ownerShare: auctionConsortiumOwnersTable.share,
  }).from(auctionConsortiumOwnersTable).where(eq(auctionConsortiumOwnersTable.auctionId, auctionId));
  const selected: Array<{ bidderId: number; consortiumId: number; weight: number }> = [];
  for (const input of inputs) {
    const consortium = input.consortiumId != null
      ? consortia.find((item: { id: number; active: number }) => item.id === input.consortiumId)
      : undefined;
    const directOwner = input.bidderId == null ? undefined : ownerRows.find((owner: { bidderId: number }) => owner.bidderId === input.bidderId);
    const resolvedConsortium = consortium ?? (directOwner ? consortia.find((item: { id: number; active: number }) => item.id === directOwner.consortiumId) : undefined);
    if (!resolvedConsortium || resolvedConsortium.active !== 1) throw new Error("Every buyer must belong to an active consortium in this auction.");
    const inputBps = shareBasisPoints(input.share);
    if (input.bidderId != null) {
      if (!directOwner || directOwner.consortiumId !== resolvedConsortium.id) throw new Error("Every bidder-level buyer must be an active roster owner.");
      selected.push({ bidderId: input.bidderId, consortiumId: resolvedConsortium.id, weight: inputBps });
    } else {
      const owners = ownerRows.filter((owner: { consortiumId: number }) => owner.consortiumId === resolvedConsortium.id);
      const ownerTotal = owners.reduce((sum: number, owner: { ownerShare: string }) => sum + Math.round(Number(owner.ownerShare) * 10000), 0);
      if (!owners.length || ownerTotal !== 10000) throw new Error("The selected consortium does not have a complete owner roster.");
      for (const owner of owners) {
        selected.push({
          bidderId: owner.bidderId,
          consortiumId: resolvedConsortium.id,
          weight: inputBps * Math.round(Number(owner.ownerShare) * 10000),
        });
      }
    }
  }
  if (new Set(selected.map((owner) => owner.bidderId)).size !== selected.length) {
    throw new Error("Expanded allocations cannot assign one bidder more than once.");
  }
  const shares = distributeIntegerTotal(selected, 10000).map((row) => ({
    bidderId: row.bidderId, consortiumId: row.consortiumId, basisPoints: row.amount,
  }));
  if (shares.some((share) => share.basisPoints <= 0)) throw new Error("Every expanded owner must receive at least one basis point.");
  const withCents = distributeIntegerTotal(shares.map((share) => ({ ...share, weight: share.basisPoints })), totalCents)
    .map((row) => ({ bidderId: row.bidderId, consortiumId: row.consortiumId, basisPoints: row.basisPoints, cents: row.amount }));
  if (withCents.some((allocation) => allocation.cents <= 0)) throw new Error("Every owner must receive at least one cent.");
  return withCents;
}
async function snapshot(auctionId: number) {
  const [session] = await db.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId));
  if (!session) return null;
  const lots = await db.select().from(auctionLotsTable).where(eq(auctionLotsTable.auctionId, auctionId)).orderBy(asc(auctionLotsTable.nominationSequence), asc(auctionLotsTable.id));
  const consortia = await db.select().from(auctionConsortiaTable).where(eq(auctionConsortiaTable.auctionId, auctionId));
  const sales = await db.select().from(auctionSalesTable).where(eq(auctionSalesTable.auctionId, auctionId));
  const allocations = await db.select({
    saleId: auctionSaleAllocationsTable.saleId,
    bidderId: auctionSaleAllocationsTable.bidderId,
    share: auctionSaleAllocationsTable.share,
    cents: auctionSaleAllocationsTable.cents,
    bidderName: biddersTable.name,
    consortiumName: auctionConsortiaTable.displayName,
    consortiumId: auctionSaleAllocationsTable.consortiumId,
  }).from(auctionSaleAllocationsTable)
    .innerJoin(biddersTable, eq(biddersTable.id, auctionSaleAllocationsTable.bidderId))
    .leftJoin(auctionConsortiaTable, eq(auctionConsortiaTable.id, auctionSaleAllocationsTable.consortiumId))
    .innerJoin(auctionSalesTable, eq(auctionSalesTable.id, auctionSaleAllocationsTable.saleId))
    .where(eq(auctionSalesTable.auctionId, auctionId));
  const ownerRows = await db.select({
    consortiumId: auctionConsortiumOwnersTable.consortiumId,
    bidderId: auctionConsortiumOwnersTable.bidderId,
    bidderName: biddersTable.name,
    share: auctionConsortiumOwnersTable.share,
  }).from(auctionConsortiumOwnersTable).innerJoin(biddersTable, eq(biddersTable.id, auctionConsortiumOwnersTable.bidderId))
    .where(eq(auctionConsortiumOwnersTable.auctionId, auctionId))
    .orderBy(asc(auctionConsortiumOwnersTable.id));
  const consortiaWithOwners = consortia.map((consortium) => ({
    ...consortium,
    owners: ownerRows.filter((owner) => owner.consortiumId === consortium.id).map(({ consortiumId: _id, ...owner }) => ({
      ...owner, share: Number(owner.share),
    })),
  }));
  const finalized = sales.reduce((sum, sale) => sum + sale.totalCents, 0);
  const live = lots.find((lot) => lot.status === "bidding")?.currentBidCents ?? 0;
  return { ...session, lots, consortia: consortiaWithOwners, sales: sales.map((sale) => ({ ...sale, allocations: allocations.filter((allocation) => allocation.saleId === sale.id) })), metrics: { poolSizeCents: finalized + live, lotsSold: sales.length, totalLots: lots.length, averageSaleCents: sales.length ? Math.round(finalized / sales.length) : null } };
}
async function event(tx: any, auctionId: number, type: string, payload: Record<string, unknown>, key?: string, nominationId?: string) {
  const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${auctionEventsTable.sequence}),0)` }).from(auctionEventsTable).where(eq(auctionEventsTable.auctionId, auctionId));
  await tx.insert(auctionEventsTable).values({ auctionId, sequence: Number(max) + 1, eventType: type, payload, idempotencyKey: key, nominationId });
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
function validateOwners(owners: Array<{ bidderId?: number; newBidderName?: string; share: number }>): void {
  const total = owners.reduce((sum, owner) => sum + shareBasisPoints(owner.share), 0);
  const existingIds = owners.flatMap((owner) => owner.bidderId == null ? [] : [owner.bidderId]);
  const newNames = owners.flatMap((owner) => owner.newBidderName == null ? [] : [normalizedLabel(owner.newBidderName)]);
  if (total !== 10000 || new Set(existingIds).size !== existingIds.length || new Set(newNames).size !== newNames.length) {
    throw new Error("Consortium owners must be unique and their positive four-decimal shares must total exactly 100%.");
  }
}
async function resolveOwnerBidderIds(tx: any, auctionId: number, owners: Array<{ bidderId?: number; newBidderName?: string; share: number }>, excludeConsortiumId?: number) {
  validateOwners(owners);
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
    output.push({ bidderId: bidderId!, share: shareBasisPoints(owner.share) });
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
  try { total = body.data.totalCents ?? cents(body.data.price!); validateAllocationInput(body.data.allocations); }
  catch (e) { return sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Invalid sale allocation." }, 422); }
  try {
    await db.transaction(async (tx) => {
      const [calcutta] = await tx.select({ seasonId: calcuttasTable.seasonId }).from(calcuttasTable).where(eq(calcuttasTable.id, calcuttaId));
      if (!calcutta) throw new Error("Calcutta not found.");
      await tx.execute(sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${calcutta.seasonId})`);
      const [session] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update");
      const [lot] = await tx.select().from(auctionLotsTable).where(and(eq(auctionLotsTable.id, lotId), eq(auctionLotsTable.auctionId, auctionId))).for("update");
      if (!session || session.status === "complete" || !lot || lot.status !== "bidding") throw new Error("Auction is complete or lot is not currently bidding.");
      if (body.data.expectedRevision != null && session.revision !== body.data.expectedRevision) throw new Error("Stale auction revision.");
      const [trade] = await tx.select({ id: tradesTable.id }).from(tradesTable).where(and(eq(tradesTable.entryId, lot.entryId), eq(tradesTable.status, "approved"))).limit(1);
      if (trade) throw new Error("Approved trades protect this ownership; use the established correcting trade workflow.");
      const existingPrimary = await tx.select({ id: positionsTable.id }).from(positionsTable).where(and(eq(positionsTable.entryId, lot.entryId), eq(positionsTable.source, "primary"))).limit(1);
      if (existingPrimary[0]) throw new Error("This entry already has primary ownership. Historical ownership is immutable; use the established correction workflow.");
      const allocations = await expandSaleAllocations(tx, auctionId, body.data.allocations, total);
      const [sale] = await tx.insert(auctionSalesTable).values({ auctionId, lotId, totalCents: total, reason: body.data.reason }).returning();
      const allocs = allocations.map((a) => ({
        saleId: sale.id, bidderId: a.bidderId, consortiumId: a.consortiumId,
        share: (a.basisPoints / 10000).toFixed(6), cents: a.cents,
      }));
      await tx.insert(auctionSaleAllocationsTable).values(allocs);
      await tx.delete(positionsTable).where(and(eq(positionsTable.entryId, lot.entryId), eq(positionsTable.source, "primary")));
      await tx.insert(positionsTable).values(allocations.map((a) => ({ entryId: lot.entryId, bidderId: a.bidderId, ownershipShare: (a.basisPoints / 10000).toFixed(6), source: "primary", costBasis: (a.cents / 100).toFixed(2) })));
      await tx.update(auctionLotsTable).set({ status: "sold", currentBidCents: total }).where(eq(auctionLotsTable.id, lotId));
      await tx.update(auctionSessionsTable).set({ revision: session.revision + 1 }).where(eq(auctionSessionsTable.id, auctionId)); await event(tx, auctionId, "sale_finalized", { lotId, saleId: sale.id, totalCents: total });
    }); res.json(await snapshot(auctionId));
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
      const nextOwners = await expandSaleAllocations(tx, auctionId, body.data.allocations, body.data.totalCents);
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