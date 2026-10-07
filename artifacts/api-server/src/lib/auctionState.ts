import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  auctionSessionsTable,
  auctionLotsTable,
  auctionConsortiaTable,
  auctionConsortiumOwnersTable,
  auctionSalesTable,
  auctionSaleAllocationsTable,
  auctionEventsTable,
  biddersTable,
  positionsTable,
} from "@workspace/db";
import { loadExactPrimaryFractions } from "./exactPrimaryOwnership";
import { exactShareVector, fractionNumber } from "./exactOwnershipFractions";
export async function snapshot(
  auctionId: number,
  executor: Pick<typeof db, "select"> = db,
) {
  const [session] = await executor
    .select()
    .from(auctionSessionsTable)
    .where(eq(auctionSessionsTable.id, auctionId));
  if (!session) return null;
  const lots = await executor
    .select()
    .from(auctionLotsTable)
    .where(eq(auctionLotsTable.auctionId, auctionId))
    .orderBy(
      asc(auctionLotsTable.nominationSequence),
      asc(auctionLotsTable.id),
    );
  const consortia = await executor
    .select()
    .from(auctionConsortiaTable)
    .where(eq(auctionConsortiaTable.auctionId, auctionId));
  const sales = await executor
    .select()
    .from(auctionSalesTable)
    .where(eq(auctionSalesTable.auctionId, auctionId));
  const allocations = await executor
    .select({
      saleId: auctionSaleAllocationsTable.saleId,
      bidderId: auctionSaleAllocationsTable.bidderId,
      share: auctionSaleAllocationsTable.share,
      cents: auctionSaleAllocationsTable.cents,
      bidderName: biddersTable.name,
      consortiumName: auctionConsortiaTable.displayName,
      consortiumId: auctionSaleAllocationsTable.consortiumId,
    })
    .from(auctionSaleAllocationsTable)
    .innerJoin(
      biddersTable,
      eq(biddersTable.id, auctionSaleAllocationsTable.bidderId),
    )
    .leftJoin(
      auctionConsortiaTable,
      eq(auctionConsortiaTable.id, auctionSaleAllocationsTable.consortiumId),
    )
    .innerJoin(
      auctionSalesTable,
      eq(auctionSalesTable.id, auctionSaleAllocationsTable.saleId),
    )
    .where(eq(auctionSalesTable.auctionId, auctionId));
  const ownerRows = await executor
    .select({
      consortiumId: auctionConsortiumOwnersTable.consortiumId,
      bidderId: auctionConsortiumOwnersTable.bidderId,
      bidderName: biddersTable.name,
      share: auctionConsortiumOwnersTable.share,
    })
    .from(auctionConsortiumOwnersTable)
    .innerJoin(
      biddersTable,
      eq(biddersTable.id, auctionConsortiumOwnersTable.bidderId),
    )
    .where(eq(auctionConsortiumOwnersTable.auctionId, auctionId))
    .orderBy(asc(auctionConsortiumOwnersTable.id));
  const primaryRows = session.calcuttaId === 2061 && lots.length
    ? await executor.select().from(positionsTable).where(inArray(positionsTable.entryId, lots.map(lot => lot.entryId))) : [];
  const exactPrimary = await loadExactPrimaryFractions(executor, session.calcuttaId, primaryRows);
  const consortiaWithOwners = consortia.map((consortium) => ({
    ...consortium,
    owners: ownerRows
      .filter((owner) => owner.consortiumId === consortium.id)
      .map(({ consortiumId: _id, ...owner }) => ({
        ...owner,
        share: Number(owner.share),
      })),
  }));
  if (session.calcuttaId === 2061) for (const consortium of consortiaWithOwners) {
    const fractions = exactShareVector(consortium.owners.map(owner => owner.share));
    consortium.owners.forEach((owner, index) => { owner.share = fractionNumber(fractions[index]!); });
  }
  const finalized = sales.reduce((sum, sale) => sum + sale.totalCents, 0);
  const live =
    lots.find((lot) => lot.status === "bidding")?.currentBidCents ?? 0;
  return {
    ...session,
    lots,
    consortia: consortiaWithOwners,
    sales: sales.map((sale) => ({
      ...sale,
      allocations: allocations.filter(
        (allocation) => allocation.saleId === sale.id,
      ).map(allocation => {
        const entryId = lots.find(lot => lot.id === sale.lotId)?.entryId;
        const exact = exactPrimary.get(`${entryId}:${allocation.bidderId}`);
        return exact ? { ...allocation, share: fractionNumber(exact) } : allocation;
      }),
    })),
    metrics: {
      poolSizeCents: finalized + live,
      lotsSold: sales.length,
      totalLots: lots.length,
      averageSaleCents: sales.length
        ? Math.round(finalized / sales.length)
        : null,
    },
  };
}
export async function event(
  tx: any,
  auctionId: number,
  type: string,
  payload: Record<string, unknown>,
  key?: string,
  nominationId?: string,
) {
  const [{ max }] = await tx
    .select({
      max: sql<number>`coalesce(max(${auctionEventsTable.sequence}),0)`,
    })
    .from(auctionEventsTable)
    .where(eq(auctionEventsTable.auctionId, auctionId));
  await tx
    .insert(auctionEventsTable)
    .values({
      auctionId,
      sequence: Number(max) + 1,
      eventType: type,
      payload,
      idempotencyKey: key,
      nominationId,
    });
}
