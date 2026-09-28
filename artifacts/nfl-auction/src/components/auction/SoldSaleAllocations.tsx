import type { AuctionSnapshot } from "@workspace/api-client-react";

type Allocations = AuctionSnapshot["sales"][number]["allocations"];

export function SoldSaleAllocations({ allocations }: { allocations: Allocations }) {
  return (
    <div className="space-y-1">
      {allocations.map((allocation, index) => (
        <div key={`${allocation.bidderId}-${index}`} className="text-sm font-sans">
          <span className="font-bold">{allocation.bidderName}</span>
          <span className="text-muted-foreground ml-2 font-mono text-xs">
            {(Number(allocation.share) * 100).toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );
}