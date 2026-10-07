import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  calcuttasTable,
  auctionSessionsTable,
  auctionLotsTable,
  auctionConsortiaTable,
  auctionSalesTable,
  auctionSaleAllocationsTable,
  auctionEventsTable,
  positionsTable,
  tradesTable,
  listenerSessionsTable,
} from "@workspace/db";
import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "./ownershipShares";
import { event } from "./auctionState";

import {
  expandSaleAllocations,
  validateAllocationInput,
  type AllocationInput,
} from "./auctionAllocations";

type SaleInput = {
  totalCents: number;
  allocations: AllocationInput[];
  expectedRevision?: number;
  reason?: string;
};
type ListenerSubmission = {
  id: string;
  key: string;
  requestId: string;
  fingerprint: string;
  nominationId: string;
};
import { recordExactPrimaryFractions } from "./exactPrimaryOwnership";

// Both commissioner and listener sales use the same ownership transaction.
export async function finalizeAuctionSale(
  calcuttaId: number,
  auctionId: number,
  lotId: number,
  input: SaleInput,
  listener?: ListenerSubmission,
  database: Pick<typeof db, "transaction"> = db,
) {
  const total = input.totalCents,
    shares = input.allocations;
  if (!Number.isSafeInteger(total) || total <= 0 || total > 2147483647)
    throw new Error("Invalid sale price.");
  validateAllocationInput(shares, calcuttaId === 2061);
  return database.transaction(async (tx) => {
    const [calcutta] = await tx
      .select({ seasonId: calcuttasTable.seasonId })
      .from(calcuttasTable)
      .where(eq(calcuttasTable.id, calcuttaId));
    if (!calcutta) throw new Error("Calcutta not found.");
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${calcutta.seasonId})`,
    );
    const [session] = await tx
      .select()
      .from(auctionSessionsTable)
      .where(eq(auctionSessionsTable.id, auctionId))
      .for("update");
    if (!session || session.calcuttaId !== calcuttaId)
      throw new Error("Auction does not belong to this Calcutta.");
    if (listener) {
      const [credential] = await tx
        .select()
        .from(listenerSessionsTable)
        .where(eq(listenerSessionsTable.id, listener.id))
        .for("update");
      if (
        !credential ||
        credential.auctionId !== auctionId ||
        credential.revokedAt ||
        credential.expiresAt <= new Date()
      )
        throw new Error(
          "Listener session expired. Reconnect from the website.",
        );
      const [replay] = await tx
        .select()
        .from(auctionEventsTable)
        .where(
          and(
            eq(auctionEventsTable.auctionId, auctionId),
            eq(auctionEventsTable.idempotencyKey, listener.key),
          ),
        );
      if (replay) {
        if (
          replay.eventType !== "sale_finalized" ||
          replay.payload.fingerprint !== listener.fingerprint
        )
          throw new Error(
            "Submission ID was already used for a different result.",
          );
        return {
          saleId: Number(replay.payload.saleId),
          idempotencyKey: listener.requestId,
        };
      }
    }
    const [lot] = await tx
      .select()
      .from(auctionLotsTable)
      .where(
        and(
          eq(auctionLotsTable.id, lotId),
          eq(auctionLotsTable.auctionId, auctionId),
        ),
      )
      .for("update");
    if (
      !session ||
      session.status === "complete" ||
      !lot ||
      lot.status !== "bidding"
    )
      throw new Error("Auction is complete or lot is not currently bidding.");
    if (
      input.expectedRevision != null &&
      session.revision !== input.expectedRevision
    )
      throw new Error("Stale auction revision.");
    if (
      listener &&
      (session.status !== "live" ||
        session.currentLotId !== lotId ||
        lot.nominationId !== listener.nominationId)
    )
      throw new Error(
        "The nominated lot changed. Review this result in the website.",
      );
    const [trade] = await tx
      .select({ id: tradesTable.id })
      .from(tradesTable)
      .where(
        and(
          eq(tradesTable.entryId, lot.entryId),
          eq(tradesTable.status, "approved"),
        ),
      )
      .limit(1);
    if (trade)
      throw new Error(
        "Approved trades protect this ownership; use the established correcting trade workflow.",
      );
    const existingPrimary = await tx
      .select({ id: positionsTable.id })
      .from(positionsTable)
      .where(
        and(
          eq(positionsTable.entryId, lot.entryId),
          eq(positionsTable.source, "primary"),
        ),
      )
      .limit(1);
    if (existingPrimary[0])
      throw new Error(
        "This entry already has primary ownership. Historical ownership is immutable; use the established correction workflow.",
      );
    const allocations = await expandSaleAllocations(
      tx,
      auctionId,
      shares,
      total,
      calcuttaId === 2061,
    );
    const [sale] = await tx
      .insert(auctionSalesTable)
      .values({
        auctionId,
        lotId,
        totalCents: total,
        reason: input.reason,
        source: listener ? "listener" : "manual",
      })
      .returning();
    const allocs = allocations.map((a) => ({
      saleId: sale.id,
      bidderId: a.bidderId,
      consortiumId: a.consortiumId,
      share: (a.basisPoints / 10000).toFixed(6),
      cents: a.cents,
    }));
    if (allocs.some((a) => a.cents <= 0))
      throw new Error("Every buyer must receive at least one cent.");
    await tx.insert(auctionSaleAllocationsTable).values(allocs);
    await tx
      .delete(positionsTable)
      .where(
        and(
          eq(positionsTable.entryId, lot.entryId),
          eq(positionsTable.source, "primary"),
        ),
      );
    await tx
      .insert(positionsTable)
      .values(
        allocations.map((a) => ({
          entryId: lot.entryId,
          bidderId: a.bidderId,
          ownershipShare: (a.basisPoints / 10000).toFixed(6),
          source: "primary",
          costBasis: (a.cents / 100).toFixed(2),
        })),
      );
    if (calcuttaId === 2061) await recordExactPrimaryFractions(tx, calcuttaId, lot.entryId,
      allocations.map(owner => ({ bidderId: owner.bidderId, numerator: owner.numerator!, denominator: owner.denominator! })),
      "Exact fractional ownership recorded when the Calcutta XIII sale was finalized.");
    await tx
      .update(auctionLotsTable)
      .set({ status: "sold", currentBidCents: total })
      .where(eq(auctionLotsTable.id, lotId));
    await tx
      .update(auctionSessionsTable)
      .set({ currentLotId: null, revision: session.revision + 1 })
      .where(eq(auctionSessionsTable.id, auctionId));
    await event(
      tx,
      auctionId,
      "sale_finalized",
      {
        lotId,
        saleId: sale.id,
        totalCents: total,
        ...(listener ? { fingerprint: listener.fingerprint } : {}),
      },
      listener?.key,
      listener?.nominationId,
    );
    return { saleId: sale.id, idempotencyKey: listener?.requestId };
  });
}
