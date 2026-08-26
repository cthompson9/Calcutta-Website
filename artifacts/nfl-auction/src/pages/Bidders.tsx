import { useState } from "react";
import { 
  useGetBidders, 
  useCreateBidder, 
  useUpdateBidder, 
  useDeleteBidder,
  getGetBiddersQueryKey,
  getGetAuctionSummaryQueryKey,
  BidderSummary
} from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Plus, Trash2, Edit2, ChevronDown, ChevronRight, User } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useSeason } from "@/hooks/useSeason";

export default function Bidders() {
  const { year, selectedCalcutta } = useSeason();
  const isNflCalcutta = selectedCalcutta?.sport === "NFL";
  const calcuttaId = isNflCalcutta ? selectedCalcutta.id : undefined;
  const bidderParams = { season: year, calcuttaId };
  const { data: bidders, isLoading } = useGetBidders(bidderParams, {
    query: { enabled: isNflCalcutta, queryKey: getGetBiddersQueryKey(bidderParams) },
  });
  const [search, setSearch] = useState("");
  
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingBidder, setEditingBidder] = useState<BidderSummary | null>(null);
  
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedIds(next);
  };

  const filteredBidders = bidders?.filter(b => 
    b.name.toLowerCase().includes(search.toLowerCase())
  ) || [];

  filteredBidders.sort((a, b) => b.totalPaid - a.totalPaid);

  return (
    <div className="p-4 md:p-8 space-y-5 md:space-y-6 max-w-5xl mx-auto">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-3 md:gap-4">
        <div>
          <h1 className="text-2xl md:text-5xl font-extrabold uppercase tracking-tighter mb-1 md:mb-2">Bidders</h1>
          <p className="text-muted-foreground font-mono text-xs md:text-sm uppercase tracking-wider md:tracking-widest">
            Review {year} participants and portfolios
          </p>
        </div>
        <Button data-testid="button-add-bidder" onClick={() => setIsCreateOpen(true)} disabled={!isNflCalcutta} className="min-h-11 uppercase font-bold tracking-wider font-mono rounded-none">
          <Plus className="w-4 h-4 mr-2" /> Add Bidder
        </Button>
      </header>

      <div className="flex gap-4 p-3 md:p-4 border border-border bg-card">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search bidders..." 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-h-11 pl-9 bg-background font-mono rounded-none"
            data-testid="input-search-bidders"
          />
        </div>
      </div>

      <div className="space-y-4">
        {isLoading ? (
          <div className="p-8 text-center animate-pulse border border-border bg-card">Loading bidders...</div>
        ) : filteredBidders.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground font-mono border border-border bg-card">No bidders found.</div>
        ) : (
          filteredBidders.map(bidder => {
            const isExpanded = expandedIds.has(bidder.id);
            return (
              <div key={bidder.id} className="border border-border bg-card" data-testid={`row-bidder-${bidder.id}`}>
                <div 
                  className="flex flex-col gap-3 p-4 cursor-pointer hover:bg-muted/30 transition-colors md:flex-row md:items-center md:justify-between"
                  onClick={() => toggleExpand(bidder.id)}
                  data-testid={`button-toggle-bidder-${bidder.id}`}
                >
                  <div className="flex min-w-0 items-center gap-3 md:gap-4">
                    <div className="w-10 h-10 bg-muted border border-border flex items-center justify-center shrink-0">
                      <User className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-bold text-lg leading-none mb-1">{bidder.name}</h3>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                          Consortium
                        </span>
                        <span
                          className={
                            bidder.consortium
                              ? "text-xs font-mono font-bold uppercase tracking-wide bg-accent text-accent-foreground px-1.5 py-0.5 border border-border"
                              : "text-xs font-mono text-muted-foreground uppercase tracking-wide"
                          }
                        >
                          {bidder.consortium ?? "Unassigned"}
                        </span>
                      </div>
                      <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
                        {bidder.teamCount} Teams
                      </div>
                    </div>
                  </div>
                  <div className="flex w-full items-center justify-between gap-3 border-t border-border pt-3 md:w-auto md:justify-end md:gap-6 md:border-0 md:pt-0">
                    <div className="text-left md:text-right">
                      <div className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-widest">Total Spent</div>
                      <div className="font-mono text-xl font-bold">{formatCurrency(bidder.totalPaid)}</div>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="rounded-none hover:bg-muted"
                      onClick={(e) => { e.stopPropagation(); setEditingBidder(bidder); }}
                      data-testid={`button-edit-bidder-${bidder.id}`}
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    <div className="w-8 flex justify-center text-muted-foreground" aria-hidden="true">
                      {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                    </div>
                  </div>
                </div>
                
                {isExpanded && (
                  <div className="border-t border-border bg-muted/10 p-4">
                    <h4 className="text-xs font-mono font-bold text-muted-foreground uppercase tracking-widest mb-3">Portfolio</h4>
                    {bidder.teams.length === 0 ? (
                      <p className="text-sm font-mono text-muted-foreground">No teams owned.</p>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {bidder.teams.map(t => (
                          <div key={t.id} className="flex justify-between items-center bg-background border border-border px-3 py-2">
                            <div>
                              <div className="font-bold text-sm">{t.name}</div>
                              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground flex gap-2">
                                <span className={t.conference === 'AFC' ? 'text-afc' : 'text-nfc'}>{t.conference}</span>
                                <span>{t.division}</span>
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-mono font-bold text-sm">{formatCurrency(t.bidAmount)}</div>
                              {t.ownershipShare < 1.0 && (
                                <div className="text-[10px] font-mono text-accent-foreground bg-accent px-1 inline-block mt-0.5 border border-border">
                                  {t.ownershipShare * 100}% SHARE
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <BidderDialog 
        open={isCreateOpen} 
        onOpenChange={setIsCreateOpen} 
        seasonYear={year}
        calcuttaId={calcuttaId}
      />
      {editingBidder && (
        <BidderDialog 
          bidder={editingBidder} 
          open={!!editingBidder} 
          onOpenChange={(o) => !o && setEditingBidder(null)} 
          seasonYear={year}
          calcuttaId={calcuttaId}
        />
      )}
    </div>
  );
}

function BidderDialog({
  bidder,
  open,
  onOpenChange,
  seasonYear,
  calcuttaId,
}: {
  bidder?: BidderSummary;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  seasonYear: number;
  calcuttaId?: number;
}) {
  const isEdit = !!bidder;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createMut = useCreateBidder();
  const updateMut = useUpdateBidder();
  const deleteMut = useDeleteBidder();

  const [name, setName] = useState(bidder?.name || "");

  const reset = () => setName(bidder?.name || "");

  const handleSave = () => {
    if (!name.trim()) return;
    if (!calcuttaId) {
      toast({ title: "NFL Calcutta required", description: "Bidder portfolio changes are available only for an NFL Calcutta.", variant: "destructive" });
      return;
    }
    
    if (isEdit) {
      updateMut.mutate({ id: bidder.id, data: { name, calcuttaId } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetBiddersQueryKey({ season: seasonYear, calcuttaId }) });
          queryClient.invalidateQueries({ queryKey: getGetAuctionSummaryQueryKey({ season: seasonYear, calcuttaId }) });
          onOpenChange(false);
          toast({ title: "Bidder updated" });
        }
      });
    } else {
      createMut.mutate({ data: { name, calcuttaId } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetBiddersQueryKey({ season: seasonYear, calcuttaId }) });
          queryClient.invalidateQueries({ queryKey: getGetAuctionSummaryQueryKey({ season: seasonYear, calcuttaId }) });
          onOpenChange(false);
          reset();
          toast({ title: "Bidder created" });
        }
      });
    }
  };

  const handleDelete = () => {
    if (!bidder) return;
    if (bidder.teamCount > 0) {
      if (!confirm(`Warning: ${bidder.name} owns ${bidder.teamCount} teams. Are you sure you want to delete them? This may cause data issues.`)) return;
    } else {
      if (!confirm("Delete this bidder?")) return;
    }

    deleteMut.mutate({ id: bidder.id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBiddersQueryKey({ season: seasonYear, calcuttaId }) });
        queryClient.invalidateQueries({ queryKey: getGetAuctionSummaryQueryKey({ season: seasonYear, calcuttaId }) });
        onOpenChange(false);
        toast({ title: "Bidder deleted" });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if(!o) reset();
      onOpenChange(o);
    }}>
      <DialogContent className="sm:max-w-[400px] rounded-none border-border">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-widest">{isEdit ? "Edit Bidder" : "Add Bidder"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right font-mono text-xs uppercase tracking-widest">Name</Label>
            <Input 
              className="col-span-3 font-bold rounded-none" 
              value={name} 
              onChange={(e) => setName(e.target.value)} 
              placeholder="e.g. John Doe"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          {isEdit && (
            <Button type="button" variant="destructive" className="rounded-none font-mono uppercase mr-auto" onClick={handleDelete} disabled={deleteMut.isPending}>
              <Trash2 className="w-4 h-4 mr-2" /> Delete
            </Button>
          )}
          <Button type="button" variant="outline" className="rounded-none font-mono uppercase" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" className="rounded-none font-mono uppercase" onClick={handleSave} disabled={createMut.isPending || updateMut.isPending || !name.trim()}>
            {isEdit ? "Save Changes" : "Create Bidder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
