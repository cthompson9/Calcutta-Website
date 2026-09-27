import { useEffect, useState } from "react";
import { type AuctionLot, type AuctionSale, type AuctionConsortium } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { correctSale } from "./admin-actions";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Loader2, AlertTriangle, Plus, X, SplitSquareHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

type SaleMember = { consortiumId?: number | null; bidderId?: number | null; share: number | string };
export function groupedSaleAllocations(allocations: SaleMember[], consortia: AuctionConsortium[]) {
  const grouped = new Map<string, number>();
  for (const member of allocations) {
    const share = Number(member.share);
    if (!Number.isFinite(share)) throw new Error("Sale allocation has an invalid ownership share.");
    const consortiumId = member.consortiumId ?? consortia.find(c =>
      (c as typeof c & { owners?: { bidderId: number }[] }).owners?.some(o => o.bidderId === member.bidderId) || (c as typeof c & { bidderId?: number | null }).bidderId === member.bidderId
    )?.id;
    const key = consortiumId == null ? "" : String(consortiumId);
    grouped.set(key, (grouped.get(key) || 0) + share);
  }
  return [...grouped].map(([consortiumId, share]) => ({ consortiumId, share: (Math.round(share * 10000) / 100).toFixed(2) }));
}

export function SaleCorrectionDialog({
  open,
  onOpenChange,
  calcuttaId,
  auctionId,
  lot,
  sale,
  consortia,
  adminKey,
  revision,
  onSaleComplete
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calcuttaId: number;
  auctionId: number;
  lot: AuctionLot | null;
  sale: AuctionSale | null;
  consortia: AuctionConsortium[];
  adminKey: string;
  revision: number;
  onSaleComplete: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isPending, setIsPending] = useState(false);

  // Default to the sale's current allocations or just 100%
  const activeRoster = consortia.filter(c => c.active === 1 && (c as typeof c & { owners?: unknown[] }).owners?.length);
  const [price, setPrice] = useState("");
  const [allocations, setAllocations] = useState<Array<{ consortiumId: string; share: string }>>([{ consortiumId: "", share: "100" }]);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open || !sale) return;
    setPrice((sale.totalCents / 100).toString());
    const members = (sale as AuctionSale & { allocations?: SaleMember[] }).allocations || [];
    setAllocations(members.length ? groupedSaleAllocations(members, consortia) : [{ consortiumId: "", share: "100" }]);
    setReason("");
    // Only reinitialize when opening a different sale, not on background snapshot refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sale?.lotId]);

  const totalShare = allocations.reduce((sum, a) => sum + (parseFloat(a.share) || 0), 0);
  const isValid = !!price && parseFloat(price) > 0 && allocations.length > 0 && allocations.every(a => a.consortiumId && activeRoster.some(c => String(c.id) === a.consortiumId) && parseFloat(a.share) > 0) && new Set(allocations.map(a => a.consortiumId)).size === allocations.length && Math.abs(totalShare - 100) < 0.001 && reason.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || !lot) return;

    setIsPending(true);
    try {
      const apiAllocations = allocations.map(a => {
        const c = activeRoster.find(r => r.id.toString() === a.consortiumId);
        return {
          consortiumId: c!.id,
          share: parseFloat(a.share) / 100
        };
      });

      await correctSale(calcuttaId, auctionId, lot.id, parseFloat(price), apiAllocations, reason, adminKey, revision);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
      onSaleComplete();
      toast({ title: "Sale corrected" });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Failed to correct sale", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  if (!lot || !sale) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-widest text-lg flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-destructive" />
            Correct Sale: {lot.displayName}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6 pt-4">
          <div className="space-y-4">
            <div>
              <label className="block font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
                Corrected Price ($)
              </label>
              <input
                type="number"
                min="1"
                step="1"
                value={price}
                onChange={e => setPrice(e.target.value)}
                className="w-full bg-background border border-border px-3 py-2 font-mono"
              />
            </div>
            
            <div className="space-y-2">
              <label className="block font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">
                Corrected Allocations
              </label>
              {allocations.map((allocation, index) => (
                <div key={index} className="flex items-center gap-2">
                  <div className="flex-1">
                    <select
                      value={allocation.consortiumId}
                      onChange={e => {
                        const newAllocations = [...allocations];
                        newAllocations[index].consortiumId = e.target.value;
                        setAllocations(newAllocations);
                      }}
                      className="w-full bg-background border border-border px-3 py-2 text-sm font-sans"
                    >
                      <option value="" disabled>Select Consortium...</option>
                       {activeRoster.map(c => (
                         <option key={c.id} value={c.id} disabled={allocations.some((a, i) => i !== index && a.consortiumId === String(c.id))}>{c.displayName} — {(c as typeof c & { owners: { bidderName: string; share: number }[] }).owners.map(o => `${o.bidderName} ${(o.share * 100).toFixed(2)}%`).join(", ")}</option>
                      ))}
                    </select>
                  </div>
                  <div className="relative w-24">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={allocation.share}
                      onChange={e => {
                        const newAllocations = [...allocations];
                        newAllocations[index].share = e.target.value;
                        setAllocations(newAllocations);
                      }}
                      className={cn(
                        "w-full bg-background border border-border pr-6 pl-2 py-2 text-sm font-mono text-right",
                        Math.abs(totalShare - 100) > 0.01 && "border-destructive/50"
                      )}
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-xs">%</span>
                  </div>
                  {allocations.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setAllocations(allocations.filter((_, i) => i !== index))}
                      className="p-2 text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
              <div className="flex items-center justify-between pt-1">
                <button type="button" onClick={() => {
                  const each = Math.floor(10000 / allocations.length);
                  setAllocations(allocations.map((a, i) => ({ ...a, share: ((i === allocations.length - 1 ? 10000 - each * (allocations.length - 1) : each) / 100).toFixed(2) })));
                }} className="text-[10px] flex items-center gap-1 font-mono uppercase text-primary"><SplitSquareHorizontal className="w-3 h-3" /> Equal Split</button>
                <button
                  type="button"
                  onClick={() => setAllocations([...allocations, { consortiumId: "", share: "" }])}
                  className="text-[10px] flex items-center gap-1 font-mono font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground"
                >
                  <Plus className="w-3 h-3" /> Add Split
                </button>
                <div className={cn("font-mono text-xs font-bold", Math.abs(totalShare - 100) > 0.01 ? "text-destructive" : "text-green-600")}>
                  Total: {totalShare.toFixed(2)}%
                </div>
              </div>
              {new Set(allocations.map(a => a.consortiumId).filter(Boolean)).size !== allocations.filter(a => a.consortiumId).length && <p role="alert" className="text-xs text-destructive">Each consortium may be selected only once.</p>}
            </div>

            <div>
              <label className="block font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
                Reason for Correction
              </label>
              <input
                type="text"
                value={reason}
                onChange={e => setReason(e.target.value)}
                className="w-full bg-background border border-border px-3 py-2 text-sm"
                placeholder="e.g., Typo during live bidding"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={!isValid || isPending}
            className="w-full bg-destructive text-destructive-foreground font-mono text-sm font-bold uppercase tracking-widest py-3 hover:bg-destructive/90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Confirm Correction
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
