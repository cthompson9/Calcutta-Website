import type { AuctionSnapshot } from "@workspace/api-client-react";

type Allocation = AuctionSnapshot["sales"][number]["allocations"][number];

/** Present sale economics by buyer without changing the recorded member allocations. */
export function groupSaleBuyers(allocations: readonly Allocation[]) {
  const buyers = new Map<string, { key: string; name: string; share: number; cents: number }>();
  for (const allocation of allocations) {
    const key = allocation.consortiumId != null
      ? `consortium:${allocation.consortiumId}`
      : `bidder:${allocation.bidderId}`;
    const name = allocation.consortiumName?.trim() || allocation.bidderName;
    const buyer = buyers.get(key) ?? { key, name, share: 0, cents: 0 };
    buyer.share += Number(allocation.share);
    buyer.cents += allocation.cents;
    buyers.set(key, buyer);
  }
  return [...buyers.values()];
}

export function saleBuyerLabel(allocations: readonly Allocation[]): string {
  return groupSaleBuyers(allocations).map((buyer) => buyer.name).join(" / ");
}

export function summarizeSaleBuyers(sales: readonly { allocations: readonly Allocation[] }[]) {
  const totals = new Map<string, { key: string; name: string; lots: number; cents: number }>();
  for (const sale of sales) {
    for (const buyer of groupSaleBuyers(sale.allocations)) {
      const total = totals.get(buyer.key) ?? { key: buyer.key, name: buyer.name, lots: 0, cents: 0 };
      total.lots += 1;
      total.cents += buyer.cents;
      totals.set(buyer.key, total);
    }
  }
  return totals;
}