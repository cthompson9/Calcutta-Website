import { eq } from "drizzle-orm";
import {
  auctionConsortiaTable,
  auctionConsortiumOwnersTable,
} from "@workspace/db";
export type AllocationInput = {
  bidderId?: number;
  consortiumId?: number;
  share: number;
};
type ExpandedAllocation = {
  bidderId: number;
  consortiumId: number;
  basisPoints: number;
  cents: number;
};
export function shareBasisPoints(share: number): number {
  if (
    !Number.isFinite(share) ||
    share <= 0 ||
    share > 1 ||
    Math.abs(share * 10000 - Math.round(share * 10000)) > 1e-7
  ) {
    throw new Error(
      "Allocation shares must be positive, use at most four decimals, and total exactly 100%.",
    );
  }
  return Math.round(share * 10000);
}
function distributeIntegerTotal<T extends { bidderId: number; weight: number }>(
  rows: T[],
  total: number,
): Array<T & { amount: number }> {
  const weightTotal = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!rows.length || weightTotal <= 0)
    throw new Error("At least one positive owner allocation is required.");
  const staged = rows.map((row) => {
    const exact = (total * row.weight) / weightTotal;
    const amount = Math.floor(exact);
    return { ...row, amount, remainder: exact - amount };
  });
  let remaining = total - staged.reduce((sum, row) => sum + row.amount, 0);
  const order = [...staged].sort(
    (a, b) => b.remainder - a.remainder || a.bidderId - b.bidderId,
  );
  for (let i = 0; i < remaining; i++) order[i % order.length].amount++;
  return staged.map((row) => {
    const { remainder: _remainder, ...result } = row;
    return result as T & { amount: number };
  });
}
export function validateAllocationInput(shares: AllocationInput[]): void {
  const seen = new Set<string>();
  let total = 0;
  for (const allocation of shares) {
    if ((allocation.bidderId == null) === (allocation.consortiumId == null))
      throw new Error(
        "Each allocation must name exactly one bidder or consortium.",
      );
    const key =
      allocation.consortiumId != null
        ? `c${allocation.consortiumId}`
        : `b${allocation.bidderId}`;
    if (seen.has(key)) throw new Error("Allocation buyers must be unique.");
    seen.add(key);
    total += shareBasisPoints(allocation.share);
  }
  if (total !== 10000)
    throw new Error(
      "Allocation shares must be unique, use at most four decimals, and total exactly 100%.",
    );
}
export async function expandSaleAllocations(
  tx: any,
  auctionId: number,
  inputs: AllocationInput[],
  totalCents: number,
): Promise<ExpandedAllocation[]> {
  validateAllocationInput(inputs);
  const consortia = await tx
    .select({
      id: auctionConsortiaTable.id,
      active: auctionConsortiaTable.active,
    })
    .from(auctionConsortiaTable)
    .where(eq(auctionConsortiaTable.auctionId, auctionId));
  const ownerRows = await tx
    .select({
      consortiumId: auctionConsortiumOwnersTable.consortiumId,
      bidderId: auctionConsortiumOwnersTable.bidderId,
      ownerShare: auctionConsortiumOwnersTable.share,
    })
    .from(auctionConsortiumOwnersTable)
    .where(eq(auctionConsortiumOwnersTable.auctionId, auctionId));
  const selected: Array<{
    bidderId: number;
    consortiumId: number;
    weight: number;
  }> = [];
  for (const input of inputs) {
    const consortium =
      input.consortiumId != null
        ? consortia.find(
            (item: { id: number; active: number }) =>
              item.id === input.consortiumId,
          )
        : undefined;
    const directOwner =
      input.bidderId == null
        ? undefined
        : ownerRows.find(
            (owner: { bidderId: number }) => owner.bidderId === input.bidderId,
          );
    const resolvedConsortium =
      consortium ??
      (directOwner
        ? consortia.find(
            (item: { id: number; active: number }) =>
              item.id === directOwner.consortiumId,
          )
        : undefined);
    if (!resolvedConsortium || resolvedConsortium.active !== 1)
      throw new Error(
        "Every buyer must belong to an active consortium in this auction.",
      );
    const inputBps = shareBasisPoints(input.share);
    if (input.bidderId != null) {
      if (!directOwner || directOwner.consortiumId !== resolvedConsortium.id)
        throw new Error(
          "Every bidder-level buyer must be an active roster owner.",
        );
      selected.push({
        bidderId: input.bidderId,
        consortiumId: resolvedConsortium.id,
        weight: inputBps,
      });
    } else {
      const owners = ownerRows.filter(
        (owner: { consortiumId: number }) =>
          owner.consortiumId === resolvedConsortium.id,
      );
      const ownerTotal = owners.reduce(
        (sum: number, owner: { ownerShare: string }) =>
          sum + Math.round(Number(owner.ownerShare) * 10000),
        0,
      );
      if (!owners.length || ownerTotal !== 10000)
        throw new Error(
          "The selected consortium does not have a complete owner roster.",
        );
      for (const owner of owners) {
        selected.push({
          bidderId: owner.bidderId,
          consortiumId: resolvedConsortium.id,
          weight: inputBps * Math.round(Number(owner.ownerShare) * 10000),
        });
      }
    }
  }
  if (
    new Set(selected.map((owner) => owner.bidderId)).size !== selected.length
  ) {
    throw new Error(
      "Expanded allocations cannot assign one bidder more than once.",
    );
  }
  const shares = distributeIntegerTotal(selected, 10000).map((row) => ({
    bidderId: row.bidderId,
    consortiumId: row.consortiumId,
    basisPoints: row.amount,
  }));
  if (shares.some((share) => share.basisPoints <= 0))
    throw new Error(
      "Every expanded owner must receive at least one basis point.",
    );
  const withCents = distributeIntegerTotal(
    shares.map((share) => ({ ...share, weight: share.basisPoints })),
    totalCents,
  ).map((row) => ({
    bidderId: row.bidderId,
    consortiumId: row.consortiumId,
    basisPoints: row.basisPoints,
    cents: row.amount,
  }));
  if (withCents.some((allocation) => allocation.cents <= 0))
    throw new Error("Every owner must receive at least one cent.");
  return withCents;
}
