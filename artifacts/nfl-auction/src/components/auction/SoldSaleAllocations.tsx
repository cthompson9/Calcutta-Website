import type { AuctionSnapshot } from "@workspace/api-client-react";
import { groupSaleBuyers } from "@/lib/auctionSaleBuyers";

type Allocations = AuctionSnapshot["sales"][number]["allocations"];

export function SoldSaleAllocations({ allocations }: { allocations: Allocations }) {
  return (
    <div className="space-y-1">
      {groupSaleBuyers(allocations).map((buyer) => (
        <div key={buyer.key} className="text-sm font-sans">
          <span className="font-bold">{buyer.name}</span>
          <span className="text-muted-foreground ml-2 font-mono text-xs">
            {(buyer.share * 100).toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );
}