import { useState, useMemo } from "react";
import { type AuctionLot, type AuctionConsortium } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X, SplitSquareHorizontal, Edit3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { recordSale, correctCurrentBid } from "./admin-actions";
import { useToast } from "@/hooks/use-toast";

interface SaleEditorProps {
  calcuttaId: number;
  auctionId: number;
  lot: AuctionLot;
  revision: number;
  consortia: AuctionConsortium[];
  adminKey: string;
  onSaleComplete: () => void;
}

export function SaleEditor({ calcuttaId, auctionId, lot, revision, consortia, adminKey, onSaleComplete }: SaleEditorProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [price, setPrice] = useState("");
  const [allocations, setAllocations] = useState<Array<{ consortiumId: string; share: string }>>([
    { consortiumId: "", share: "100" }
  ]);
  const [isPending, setIsPending] = useState(false);
  const [isCorrectingBid, setIsCorrectingBid] = useState(false);

  const activeRoster = consortia.filter(c => c.active === 1 && c.bidderId != null);

  const totalShare = useMemo(() => {
    return allocations.reduce((sum, a) => sum + (parseFloat(a.share) || 0), 0);
  }, [allocations]);

  const isValid = useMemo(() => {
    if (!price || isNaN(parseFloat(price)) || parseFloat(price) <= 0) return false;
    if (allocations.length === 0) return false;
    if (allocations.some(a => !a.consortiumId || isNaN(parseFloat(a.share)) || parseFloat(a.share) <= 0)) return false;
    if (Math.abs(totalShare - 100) > 0.01) return false;
    return true;
  }, [price, allocations, totalShare]);

  const handleAddSplit = () => {
    setAllocations([...allocations, { consortiumId: "", share: "" }]);
  };

  const handleRemoveSplit = (index: number) => {
    setAllocations(allocations.filter((_, i) => i !== index));
  };

  const handleEqualSplit = () => {
    if (allocations.length === 0) return;
    const split = (100 / allocations.length).toFixed(2);
    setAllocations(allocations.map((a, i) => {
      if (i === allocations.length - 1) {
        // adjust last one to exactly 100
        const rem = 100 - (parseFloat(split) * (allocations.length - 1));
        return { ...a, share: rem.toFixed(2) };
      }
      return { ...a, share: split };
    }));
  };

  const handleCorrectBid = async () => {
    const newPrice = prompt("Enter corrected provisional bid ($):", price || (lot.currentBidCents ? (lot.currentBidCents / 100).toString() : ""));
    if (!newPrice) return;
    const parsed = parseFloat(newPrice);
    if (isNaN(parsed) || parsed < 0) return;
    
    setIsCorrectingBid(true);
    try {
      await correctCurrentBid(calcuttaId, auctionId, lot.id, parsed, adminKey, revision);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
      onSaleComplete();
      toast({ title: "Bid corrected" });
    } catch (err: any) {
      toast({ title: "Failed to correct bid", description: err.message, variant: "destructive" });
    } finally {
      setIsCorrectingBid(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setIsPending(true);
    try {
      const apiAllocations = allocations.map(a => {
        const c = activeRoster.find(r => r.id.toString() === a.consortiumId);
        return {
          bidderId: c!.bidderId!,
          share: parseFloat(a.share) / 100
        };
      });

      await recordSale(calcuttaId, auctionId, lot.id, parseFloat(price), apiAllocations, revision, adminKey);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
      onSaleComplete();
      setPrice("");
      setAllocations([{ consortiumId: "", share: "100" }]);
    } catch (err: any) {
      toast({ title: "Sale failed", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="border border-primary/20 bg-primary/5 p-6 space-y-6">
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Winning Bid ($)
            </label>
            <button
              type="button"
              onClick={handleCorrectBid}
              disabled={isCorrectingBid}
              className="text-[10px] flex items-center gap-1 font-mono font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
            >
              {isCorrectingBid ? <Loader2 className="w-3 h-3 animate-spin" /> : <Edit3 className="w-3 h-3" />} Correct Live Bid
            </button>
          </div>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono">$</span>
            <input
              type="number"
              min="1"
              step="1"
              value={price}
              onChange={e => setPrice(e.target.value)}
              className="w-full bg-background border border-border pl-8 pr-4 py-3 font-mono text-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              placeholder="0"
              autoFocus
            />
          </div>
          {lot.currentBidCents != null && lot.currentBidCents > 0 && !price && (
            <p className="mt-1 text-xs font-mono text-muted-foreground">
              Live provisional bid: ${(lot.currentBidCents / 100).toFixed(2)}
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="block font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Buyer Allocation
            </label>
            {allocations.length > 1 && (
              <button
                type="button"
                onClick={handleEqualSplit}
                className="text-[10px] flex items-center gap-1 font-mono font-bold uppercase tracking-widest text-primary hover:text-primary/80 transition-colors"
              >
                <SplitSquareHorizontal className="w-3 h-3" /> Equal Split
              </button>
            )}
          </div>
          
          <div className="space-y-2">
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
                    className="w-full bg-background border border-border px-3 py-2 text-sm font-sans focus:outline-none focus:ring-2 focus:ring-primary transition-all"
                  >
                    <option value="" disabled>Select Consortium...</option>
                    {activeRoster.map(c => (
                      <option key={c.id} value={c.id}>{c.displayName}</option>
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
                      "w-full bg-background border border-border pr-6 pl-2 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-primary transition-all",
                      Math.abs(totalShare - 100) > 0.01 && "border-destructive/50 focus:ring-destructive"
                    )}
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-xs">%</span>
                </div>
                {allocations.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveSplit(index)}
                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={handleAddSplit}
              className="text-[10px] flex items-center gap-1 font-mono font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="w-3 h-3" /> Add Split
            </button>
            <div className={cn(
              "font-mono text-xs font-bold",
              Math.abs(totalShare - 100) > 0.01 ? "text-destructive" : "text-green-600"
            )}>
              Total: {totalShare.toFixed(2)}%
            </div>
          </div>
        </div>
      </div>

      <button
        type="submit"
        disabled={!isValid || isPending}
        className="w-full bg-primary text-primary-foreground font-mono text-sm font-bold uppercase tracking-widest py-3 hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
      >
        {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        Record Sale
      </button>
    </form>
  );
}
