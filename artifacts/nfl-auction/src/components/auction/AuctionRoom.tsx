import { useQueryClient } from "@tanstack/react-query";
import { type AuctionSnapshot, useGetBidders } from "@workspace/api-client-react";
import { formatCurrency, cn } from "@/lib/utils";
import { Loader2, AlertCircle, Users, DollarSign, List, Play, CheckCircle2, Gavel, Activity } from "lucide-react";
import { SaleEditor } from "./SaleEditor";
import { LotInventory } from "./LotInventory";
import { ManageRosterDialog } from "./AdminDialogs";
import { ListenerConnect, ListenerTranscript } from "./ListenerConnect";
import { createAuction, nominateNext, completeAuctionSession } from "./admin-actions";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

interface AuctionRoomProps {
  calcuttaId: number;
  year: number;
  adminKey: string | null;
  historicalSummaryRefetch: () => void;
  activeAuction: AuctionSnapshot | null | undefined;
  hasHistoricalResults: boolean;
  isLoading: boolean;
  error: any;
}

export function AuctionRoom({ calcuttaId, year, adminKey, historicalSummaryRefetch, activeAuction, hasHistoricalResults, isLoading, error }: AuctionRoomProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isPending, setIsPending] = useState(false);
  const [showRoster, setShowRoster] = useState(false);

  const { data: bidders } = useGetBidders();

  if (isLoading) {
    return (
      <div className="p-8 flex justify-center items-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-destructive/20 bg-destructive/5 p-4 rounded-md flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h3 className="font-mono text-sm font-bold uppercase tracking-widest text-destructive">Connection Error</h3>
          <p className="text-sm text-muted-foreground font-mono">
            Unable to reach the live auction server. {error instanceof Error ? error.message : "Retrying..."}
          </p>
        </div>
      </div>
    );
  }

  const handleCreate = async () => {
    if (!adminKey) return;
    setIsPending(true);
    try {
      await createAuction(calcuttaId, adminKey);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
      toast({ title: "Auction session started" });
    } catch (err: any) {
      toast({ title: "Failed to start", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  if (!activeAuction) {
    if (adminKey) {
      return (
        <div className="border border-border bg-card p-8 text-center rounded-md space-y-4">
          <Gavel className="w-12 h-12 mx-auto text-primary opacity-50" />
          <h2 className="text-xl font-bold uppercase tracking-tight">No Active Auction</h2>
          <p className="text-muted-foreground text-sm font-mono">
            {hasHistoricalResults
              ? "This Calcutta already has historical auction results. Its original sales remain read-only."
              : "You have admin access. You can start a new live auction session."}
          </p>
          <button
            onClick={handleCreate}
            disabled={isPending || hasHistoricalResults}
            className="bg-primary text-primary-foreground font-mono text-sm font-bold uppercase tracking-widest px-6 py-3 hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
          >
            {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Start Auction Session
          </button>
        </div>
      );
    }
    return null;
  }

  const { id: auctionId, status, metrics, lots, consortia, sales } = activeAuction;
  
  // The lot on the block is the one currently bidding, OR the last nominated lot.
  const biddingLot = lots.find(l => l.status === "bidding");
  const nominatedLots = lots.filter(l => l.nominationSequence != null).sort((a, b) => b.nominationSequence! - a.nominationSequence!);
  const onTheBlock = biddingLot || nominatedLots[0];
  
  const availableLots = lots.filter(l => l.status === "available").length;
  const allSold = lots.every(l => l.status === "sold");

  const handleNominate = async () => {
    if (!adminKey) return;
    setIsPending(true);
    try {
      await nominateNext(calcuttaId, auctionId, activeAuction.revision, adminKey);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
    } catch (err: any) {
      toast({ title: "Failed to nominate", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  const handleComplete = async () => {
    if (!adminKey) return;
    if (!confirm("Are you sure you want to complete this auction?")) return;
    setIsPending(true);
    try {
      await completeAuctionSession(calcuttaId, auctionId, adminKey, activeAuction.revision);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
      historicalSummaryRefetch();
      toast({ title: "Auction completed" });
    } catch (err: any) {
      toast({ title: "Failed to complete", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-0 border border-border bg-card rounded-md overflow-hidden shadow-sm">
        <div className="p-6 flex flex-col gap-2 border-b md:border-b-0 md:border-r border-border">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-mono font-bold uppercase tracking-widest">Status</span>
            <AlertCircle className="w-4 h-4 opacity-50" />
          </div>
          <div className="text-2xl md:text-3xl font-mono font-black tracking-tight flex items-center gap-2 uppercase">
            {status === "live" ? (
              <>
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
                </span>
                LIVE
              </>
            ) : (
              status
            )}
          </div>
        </div>
        <div className="p-6 flex flex-col gap-2 border-b md:border-b-0 md:border-r border-border">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-mono font-bold uppercase tracking-widest">Total Pot</span>
            <DollarSign className="w-4 h-4 opacity-50" />
          </div>
          <div className="text-3xl md:text-4xl font-mono font-black tracking-tight text-primary">
            {formatCurrency(metrics.poolSizeCents / 100)}
          </div>
          <span className="text-xs text-muted-foreground">Final sales{lots.some((lot) => lot.status === "bidding" && lot.currentBidCents != null) ? " + current provisional bid" : ""}</span>
        </div>
        <div className="p-6 flex flex-col gap-2 border-b md:border-b-0 md:border-r border-border">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-mono font-bold uppercase tracking-widest">Avg Sale</span>
            <Activity className="w-4 h-4 opacity-50" />
          </div>
          <div className="text-3xl md:text-4xl font-mono font-black tracking-tight">
            {metrics.averageSaleCents != null ? formatCurrency(metrics.averageSaleCents / 100) : "—"}
          </div>
        </div>
        <div className="p-6 flex flex-col gap-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-mono font-bold uppercase tracking-widest">Lots Sold</span>
            <List className="w-4 h-4 opacity-50" />
          </div>
          <div className="text-3xl md:text-4xl font-mono font-black tracking-tight">
            {metrics.lotsSold} <span className="text-muted-foreground text-lg">/ {lots.length}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left Column: On the Block & Workflow */}
        <div className="lg:col-span-2 space-y-6">
          <div className="border border-border bg-card rounded-md overflow-hidden">
            <div className="bg-muted px-4 py-3 border-b border-border flex justify-between items-center">
              <h3 className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">On The Block</h3>
              {onTheBlock?.nominationSequence != null && (
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Nomination #{onTheBlock.nominationSequence}
                </span>
              )}
            </div>
            <div className="p-8">
              {onTheBlock ? (
                <div className="space-y-8">
                  <div className="text-center space-y-2">
                    <h2 className="text-4xl md:text-5xl font-black uppercase tracking-tighter text-primary">
                      {onTheBlock.displayName}
                    </h2>
                    {onTheBlock.status === "sold" && (
                      <div className="inline-flex items-center justify-center gap-2 bg-green-50 text-green-700 border border-green-200 px-3 py-1 mt-2">
                        <CheckCircle2 className="w-4 h-4" />
                        <span className="font-mono text-xs font-bold uppercase tracking-widest">Sold</span>
                      </div>
                    )}
                  </div>
                  
                  {onTheBlock.status === "bidding" ? (
                    adminKey ? (
                      <SaleEditor 
                        key={onTheBlock.id}
                        calcuttaId={calcuttaId}
                        auctionId={auctionId}
                        lot={onTheBlock}
                        revision={activeAuction.revision}
                        consortia={consortia}
                        adminKey={adminKey}
                        onSaleComplete={historicalSummaryRefetch}
                      />
                    ) : (
                      <div className="bg-primary/5 border border-primary/20 p-6 text-center rounded-sm">
                        <p className="font-mono text-sm uppercase tracking-widest text-primary font-bold animate-pulse mb-2">
                          Bidding in progress...
                        </p>
                        {onTheBlock.currentBidCents != null && onTheBlock.currentBidCents > 0 && (
                          <p className="font-mono text-2xl font-black tracking-tight">
                            {formatCurrency(onTheBlock.currentBidCents / 100)}
                          </p>
                        )}
                      </div>
                    )
                  ) : (
                    // It's sold. Display who bought it and for how much.
                    <div className="border border-border p-6 bg-muted/30 text-center space-y-4">
                      {(() => {
                        const sale = sales.find(s => s.lotId === onTheBlock.id);
                        if (!sale) return <p>Sale data not found.</p>;
                        return (
                          <>
                            <div className="font-mono text-3xl font-black tracking-tight">
                              {formatCurrency(sale.totalCents / 100)}
                            </div>
                            <div className="space-y-1">
                              {((sale as any).allocations || []).map((alloc: any, i: number) => (
                                <div key={i} className="text-sm font-sans">
                                  <span className="font-bold">{alloc.consortiumName || alloc.bidderName}</span>
                                  <span className="text-muted-foreground ml-2 font-mono text-xs">{(alloc.share * 100).toFixed(2)}%</span>
                                </div>
                              ))}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {adminKey && onTheBlock.status === "sold" && !allSold && (
                    <div className="pt-4 border-t border-border flex justify-center">
                      <button
                        onClick={handleNominate}
                        disabled={isPending}
                        className="bg-primary text-primary-foreground font-mono text-sm font-bold uppercase tracking-widest px-8 py-4 hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-2 shadow-sm"
                      >
                        {isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
                        Nominate Next Lot
                      </button>
                    </div>
                  )}

                  {adminKey && allSold && status !== "complete" && (
                    <div className="pt-4 border-t border-border flex justify-center">
                      <button
                        onClick={handleComplete}
                        disabled={isPending}
                        className="bg-green-600 text-white font-mono text-sm font-bold uppercase tracking-widest px-8 py-4 hover:bg-green-700 disabled:opacity-50 transition-colors inline-flex items-center gap-2 shadow-sm"
                      >
                        {isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                        Complete Auction
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-12 space-y-4">
                  <Gavel className="w-16 h-16 mx-auto text-muted-foreground opacity-20" />
                  <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
                    No lot currently on the block
                  </p>
                  
                  {adminKey && availableLots > 0 && (
                    <button
                      onClick={handleNominate}
                      disabled={isPending}
                      className="mt-4 bg-primary text-primary-foreground font-mono text-sm font-bold uppercase tracking-widest px-6 py-3 hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
                    >
                      {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                      Nominate First Lot
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          
          <div className="border border-border bg-card rounded-md overflow-hidden">
             <div className="bg-muted px-4 py-3 border-b border-border flex justify-between items-center">
              <h3 className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">Transcript</h3>
            </div>
             <ListenerTranscript auctionId={auctionId} />
          </div>
        </div>

        {/* Right Column: Consortia */}
        <div className="space-y-6">
          <div className="border border-border bg-card rounded-md overflow-hidden">
            <div className="bg-muted px-4 py-3 border-b border-border">
              <h3 className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                <Users className="w-3.5 h-3.5" /> Consortia Roster
              </h3>
            </div>
            <div className="p-0">
              {consortia.length > 0 ? (
                <ul className="divide-y divide-border">
                  {consortia.map(c => (
                    <li key={c.id} className="p-3 text-sm flex flex-col gap-1">
                      <div className="flex justify-between items-start">
                        <span className="font-bold">{c.displayName}</span>
                        {!c.active && (
                          <span className="text-[10px] font-mono uppercase tracking-widest bg-muted px-1.5 py-0.5 rounded-sm text-muted-foreground">
                            Inactive
                          </span>
                        )}
                      </div>
                      {c.aliases && c.aliases.length > 0 && (
                        <span className="font-mono text-muted-foreground text-xs line-clamp-1" title={c.aliases.join(", ")}>
                          {c.aliases.join(", ")}
                        </span>
                      )}
                      {!c.bidderId && (
                        <span className="text-xs text-destructive flex items-center gap-1 mt-1">
                          <AlertCircle className="w-3 h-3" /> Unmapped
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="p-4 text-sm text-muted-foreground text-center italic">No consortia registered.</p>
              )}
            </div>
            {adminKey && status !== "complete" && (
              <div className="p-3 border-t border-border bg-muted/50">
                <button
                  className="w-full py-2 text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground hover:bg-muted transition-colors border border-dashed border-border"
                  onClick={() => setShowRoster(true)}
                >
                  Manage Roster
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Full Inventory */}
      <LotInventory 
        lots={lots} 
        sales={sales} 
        calcuttaId={calcuttaId}
        auctionId={auctionId}
        adminKey={adminKey}
        revision={activeAuction.revision}
        status={status}
        consortia={consortia}
        historicalSummaryRefetch={historicalSummaryRefetch}
      />

      {adminKey && (
        <ManageRosterDialog
          open={showRoster}
          onOpenChange={setShowRoster}
          calcuttaId={calcuttaId}
          auctionId={auctionId}
          consortia={consortia}
          bidders={bidders || []}
          adminKey={adminKey}
          revision={activeAuction.revision}
        />
      )}
      {adminKey && status === "live" && (
        <ListenerConnect key={auctionId} auctionId={auctionId} adminKey={adminKey} />
      )}
    </div>
  );
}
