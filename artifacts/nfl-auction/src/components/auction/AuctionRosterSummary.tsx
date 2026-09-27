import type { AuctionSnapshot } from "@workspace/api-client-react";

const formatCost = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** The auction roster is a draft membership list, not a valuation or an unsold ownership position. */
export function AuctionRosterSummary({ auction, error }: {
  auction: AuctionSnapshot | null | undefined;
  error?: Error | null;
}) {
  if (error) {
    return (
      <section role="alert" className="border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Could not load the auction roster. Refresh the page to try again.
      </section>
    );
  }
  if (!auction?.consortia.length) return null;

  return (
    <section className="border border-border bg-card" aria-label="Auction roster" data-testid="auction-roster-summary">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="font-mono text-sm font-bold uppercase tracking-widest">Auction roster</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {auction.status === "complete"
              ? "Recorded consortium memberships for this auction."
              : "Consortia and owners are registered here before sales. Unsold lots have no owner, cost, or valuation."}
          </p>
        </div>
        <span className="border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {auction.status === "complete" ? "Complete" : "Auction in progress"}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {auction.consortia.map((consortium) => {
          const allocations = auction.sales.flatMap((sale) => sale.allocations
            .filter((allocation) => allocation.consortiumId === consortium.id)
            .map((allocation) => ({ lotId: sale.lotId, cents: allocation.cents })));
          const soldLots = new Set(allocations.map((allocation) => allocation.lotId)).size;
          const costCents = allocations.reduce((total, allocation) => total + allocation.cents, 0);
          return (
            <li key={consortium.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{consortium.displayName}</span>
                  {consortium.active === 0 && <span className="font-mono text-[10px] uppercase text-muted-foreground">Inactive</span>}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {consortium.owners.length
                    ? consortium.owners.map((owner) => `${owner.bidderName} ${(owner.share * 100).toFixed(2)}%`).join(" · ")
                    : "No owners registered yet"}
                </p>
              </div>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {soldLots ? `${soldLots} sold ${soldLots === 1 ? "lot" : "lots"} · ${formatCost.format(costCents / 100)} cost` : "No sold lots"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}