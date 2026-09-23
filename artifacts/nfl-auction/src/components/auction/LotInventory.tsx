import { type AuctionLot, type AuctionSale, type AuctionConsortium } from "@workspace/api-client-react";
import { cn, formatCurrency } from "@/lib/utils";
import { Check, Clock, AlertTriangle } from "lucide-react";
import { useState } from "react";
import { ManageInventoryDialog } from "./AdminDialogs";
import { SaleCorrectionDialog } from "./SaleCorrectionDialog";
import { useQueryClient } from "@tanstack/react-query";

export function LotInventory({ 
  lots, 
  sales, 
  calcuttaId, 
  auctionId, 
  adminKey, 
  revision,
  status,
  consortia,
  historicalSummaryRefetch
}: { 
  lots: AuctionLot[], 
  sales: AuctionSale[],
  calcuttaId?: number,
  auctionId?: number,
  adminKey?: string | null,
  revision?: number,
  status?: string,
  consortia?: AuctionConsortium[],
  historicalSummaryRefetch?: () => void
}) {
  const [showInventory, setShowInventory] = useState(false);
  const [correctionLot, setCorrectionLot] = useState<AuctionLot | null>(null);
  const [correctionSale, setCorrectionSale] = useState<AuctionSale | null>(null);

  const sortedLots = [...lots].sort((a, b) => {
    if (a.status === "sold" && b.status === "sold") {
      return (a.nominationSequence || 0) - (b.nominationSequence || 0);
    }
    if (a.status === "sold") return -1;
    if (b.status === "sold") return 1;
    return a.entryId - b.entryId;
  });

  return (
    <div className="border border-border bg-card rounded-md overflow-hidden">
      <div className="bg-muted px-4 py-3 border-b border-border flex justify-between items-center sticky top-0 z-10">
        <h3 className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-4">
          Inventory
          {adminKey && status !== "complete" && (
            <button 
              onClick={() => setShowInventory(true)}
              className="text-[10px] text-primary hover:underline"
            >
              Manage Lots
            </button>
          )}
        </h3>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {lots.length} Lots
        </span>
      </div>
      
      {lots.length === 0 ? (
        <div className="p-8 text-center text-muted-foreground text-sm">
          <p>No lots available in inventory.</p>
          <p className="mt-2 text-xs font-mono">
            Lots must be imported by an admin to begin the auction.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-px bg-border">
          {sortedLots.map((lot) => {
            const sale = sales.find(s => s.lotId === lot.id);
            const price = sale ? sale.totalCents : lot.currentBidCents;

            return (
              <div 
                key={lot.id} 
                className={cn(
                  "p-4 flex flex-col justify-between bg-card transition-colors",
                  lot.status === "sold" && "opacity-60 bg-muted/30 hover:opacity-100",
                  lot.status === "bidding" && "bg-primary/5 ring-1 ring-inset ring-primary/20",
                  lot.status === "available" && "hover:bg-muted/50"
                )}
              >
                <div className="space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {lot.nominationSequence != null ? `Seq #${lot.nominationSequence}` : `Entry #${lot.entryId}`}
                    </span>
                    {lot.status === "sold" && <Check className="w-3.5 h-3.5 text-green-600" />}
                    {lot.status === "bidding" && (
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                      </span>
                    )}
                    {lot.status === "available" && <Clock className="w-3.5 h-3.5 text-muted-foreground/40" />}
                  </div>
                  <h4 className="font-bold truncate" title={lot.displayName}>
                    {lot.displayName}
                  </h4>
                </div>
                
                <div className="mt-4 pt-3 border-t border-border/50 flex justify-between items-center">
                  <span className={cn(
                    "font-mono text-[10px] uppercase tracking-widest font-bold",
                    lot.status === "sold" ? "text-green-600" :
                    lot.status === "bidding" ? "text-primary" : "text-muted-foreground"
                  )}>
                    {lot.status}
                  </span>
                  {(lot.status === "sold" || lot.status === "bidding") && price != null && price > 0 && (
                    <div className="flex items-center gap-2">
                      {adminKey && lot.status === "sold" && status !== "complete" && sale && (
                        <button 
                          onClick={() => { setCorrectionLot(lot); setCorrectionSale(sale); }}
                          className="text-destructive hover:bg-destructive/10 p-1 rounded-sm transition-colors"
                          title="Correct Sale"
                        >
                          <AlertTriangle className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <span className="font-mono text-sm font-bold">
                        {formatCurrency(price / 100)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {adminKey && calcuttaId && auctionId && revision != null && (
        <>
          <ManageInventoryDialog
            open={showInventory}
            onOpenChange={setShowInventory}
            calcuttaId={calcuttaId}
            auctionId={auctionId}
            lots={lots}
            adminKey={adminKey}
            revision={revision}
          />
          {consortia && historicalSummaryRefetch && (
            <SaleCorrectionDialog
              key={`${correctionLot?.id ?? "none"}-${correctionSale?.totalCents ?? 0}-${!!correctionLot}`}
              open={!!correctionLot && !!correctionSale}
              onOpenChange={(o) => { if (!o) { setCorrectionLot(null); setCorrectionSale(null); } }}
              calcuttaId={calcuttaId}
              auctionId={auctionId}
              lot={correctionLot}
              sale={correctionSale}
              consortia={consortia}
              adminKey={adminKey}
              revision={revision}
              onSaleComplete={historicalSummaryRefetch}
            />
          )}
        </>
      )}
    </div>
  );
}
