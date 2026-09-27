import { useState } from "react";
import { type AuctionConsortium, type AuctionSale, type BidderSummary, type AuctionLot, getGetBiddersQueryKey } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { editConsortium, addConsortium, addLotBulk, deleteLot, type ConsortiumOwnerInput } from "./admin-actions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2, X } from "lucide-react";

type Owner = { bidderId?: number; newBidderName: string; percent: string };
type RosterConsortium = AuctionConsortium & { owners?: { bidderId: number; bidderName: string; share: number }[] };
export function equalOwnerShares(owners: Owner[]): Owner[] {
  if (!owners.length) return owners;
  const each = Math.floor(10000 / owners.length);
  return owners.map((owner, index) => ({ ...owner, percent: ((index === owners.length - 1 ? 10000 - each * (owners.length - 1) : each) / 100).toFixed(2) }));
}

export function ManageRosterDialog({ open, onOpenChange, calcuttaId, auctionId, consortia, sales, bidders, biddersLoading, biddersError, retryBidders, adminKey, revision }: { open: boolean, onOpenChange: (open: boolean) => void, calcuttaId: number, auctionId: number, consortia: AuctionConsortium[], sales: AuctionSale[], bidders: BidderSummary[], biddersLoading: boolean, biddersError: boolean, retryBidders: () => void, adminKey: string, revision: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isPending, setIsPending] = useState(false);

  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [owners, setOwners] = useState<Owner[]>([{ newBidderName: "", percent: "100.00" }]);

  const reset = () => { setEditingId(null); setName(""); setOwners([{ newBidderName: "", percent: "100.00" }]); };
  const edit = (c: RosterConsortium) => {
    setEditingId(c.id);
    setName(c.displayName);
    setOwners(c.owners?.length
      ? c.owners.map(o => ({ bidderId: o.bidderId, newBidderName: "", percent: (o.share * 100).toFixed(2) }))
      : [{ newBidderName: "", percent: "100.00" }]);
  };
  const usedByOther = new Set((consortia as RosterConsortium[]).filter(c => c.id !== editingId).flatMap(c => (c.owners || []).map(o => o.bidderId)));
  const soldConsortiumIds = new Set(sales.flatMap(sale => sale.allocations.map(allocation =>
    allocation.consortiumId ?? consortia.find(c => c.bidderId === allocation.bidderId)?.id
  )).filter((id): id is number => id != null));
  const namesByOther = new Set((consortia as RosterConsortium[]).filter(c => c.id !== editingId).flatMap(c => (c.owners || []).map(o => o.bidderName.trim().toLocaleLowerCase())));
  const duplicate = owners.some((o, i) => {
    const normalized = (o.bidderId ? bidders.find(b => b.id === o.bidderId)?.name : o.newBidderName)?.trim().toLocaleLowerCase();
    return (!!o.bidderId && usedByOther.has(o.bidderId)) || (!!normalized && namesByOther.has(normalized)) ||
      (!!normalized && (bidders.some(b => b.name.trim().toLocaleLowerCase() === normalized && b.id !== o.bidderId) ||
        owners.some((other, j) => i !== j && (other.bidderId ? bidders.find(b => b.id === other.bidderId)?.name : other.newBidderName)?.trim().toLocaleLowerCase() === normalized)));
  });
  const total = owners.reduce((sum, o) => sum + (Number(o.percent) || 0), 0);
  const valid = !biddersLoading && !biddersError && !!name.trim() && owners.length > 0 && !duplicate &&
    owners.every(o => (o.bidderId != null || !!o.newBidderName.trim()) && /^\d+(\.\d{1,2})?$/.test(o.percent) && Number(o.percent) > 0) &&
    owners.reduce((sum, o) => sum + Math.round(Number(o.percent) * 100), 0) === 10000;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setIsPending(true);
    try {
      const payload: ConsortiumOwnerInput[] = owners.map(o => o.bidderId != null
        ? { bidderId: o.bidderId, share: Math.round(Number(o.percent) * 100) / 10000 }
        : { newBidderName: o.newBidderName.trim(), share: Math.round(Number(o.percent) * 100) / 10000 });
      if (editingId != null) await editConsortium(calcuttaId, auctionId, editingId, { displayName: name.trim(), owners: payload }, adminKey, revision);
      else await addConsortium(calcuttaId, auctionId, name.trim(), payload, adminKey, revision);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] }),
        queryClient.invalidateQueries({ queryKey: getGetBiddersQueryKey() }),
      ]);
      reset();
      toast({ title: editingId != null ? "Consortium updated" : "Consortium added" });
    } catch (err: any) {
      toast({ title: "Failed to save consortium", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  const handleToggleActive = async (c: AuctionConsortium) => {
    setIsPending(true);
    try {
      await editConsortium(calcuttaId, auctionId, c.id, { active: c.active === 1 ? false : true }, adminKey, revision);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
    } catch (err: any) {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  const handleEditAliases = async (c: AuctionConsortium) => {
    const newAliasesPrompt = prompt("Enter aliases (comma separated):", c.aliases?.join(", ") || "");
    if (newAliasesPrompt == null) return;
    setIsPending(true);
    try {
      await editConsortium(calcuttaId, auctionId, c.id, { aliases: newAliasesPrompt.split(",").map(a => a.trim()).filter(a => a.length > 0) }, adminKey, revision);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
      toast({ title: "Aliases updated" });
    } catch (err: any) {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-widest text-lg">Manage Roster</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <div className="border border-border p-4 bg-muted/30">
            <h4 className="font-mono text-xs font-bold uppercase tracking-widest mb-4">{editingId != null ? "Edit Consortium" : "Add New Consortium"}</h4>
            {biddersLoading && <p role="status" className="text-sm text-muted-foreground">Loading owner directory…</p>}
            {biddersError && <div role="alert" className="mb-4 border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">Could not load owner directory. Changes cannot be saved until it loads. <button type="button" onClick={retryBidders} className="underline font-bold">Retry</button></div>}
            {!biddersLoading && !biddersError && <form onSubmit={handleAdd} className="space-y-4">
              <label className="block space-y-1 text-xs font-mono text-muted-foreground">Consortium name
                <input aria-label="Consortium name" type="text" value={name} onChange={e => setName(e.target.value)} className="w-full bg-background border border-border px-3 py-2 text-sm text-foreground" placeholder="Consortium name" />
              </label>
              <div className="flex justify-between items-center">
                <span className="font-mono text-xs uppercase tracking-widest">Owners & shares</span>
                <button type="button" onClick={() => setOwners(equalOwnerShares(owners))} className="text-xs text-primary hover:underline">Equal Split</button>
              </div>
              {owners.map((owner, index) => (
                <div key={index} className="flex flex-wrap sm:flex-nowrap gap-2 items-start">
                  <div className="flex-1 min-w-[150px] space-y-2">
                    <select aria-label={`Owner ${index + 1}`} value={owner.bidderId != null ? String(owner.bidderId) : owner.newBidderName !== "" ? "__new" : ""} onChange={e => setOwners(current => current.map((o, i) => i === index ? { bidderId: e.target.value && e.target.value !== "__new" ? Number(e.target.value) : undefined, newBidderName: "", percent: o.percent } : o))} className="w-full bg-background border border-border px-3 py-2 text-sm">
                      <option value="">Select owner…</option>
                      {bidders.map(b => <option key={b.id} value={b.id} disabled={usedByOther.has(b.id) || owners.some((o, i) => i !== index && o.bidderId === b.id)}>{b.name}</option>)}
                      <option value="__new">Create new owner…</option>
                    </select>
                    {owner.bidderId == null && <input aria-label={`New owner ${index + 1} name`} value={owner.newBidderName} onChange={e => setOwners(current => current.map((o, i) => i === index ? { ...o, newBidderName: e.target.value } : o))} placeholder="Or enter new owner name" className="w-full bg-background border border-border px-3 py-2 text-sm" />}
                  </div>
                  <label className="flex items-center gap-1 text-sm font-mono"><input aria-label={`Owner ${index + 1} percent`} type="number" min="0.01" max="100" step="0.01" value={owner.percent} onChange={e => setOwners(current => current.map((o, i) => i === index ? { ...o, percent: e.target.value } : o))} className="w-20 bg-background border border-border px-2 py-2 text-right" />%</label>
                  <button type="button" aria-label={`Remove owner ${index + 1}`} disabled={owners.length === 1} onClick={() => setOwners(equalOwnerShares(owners.filter((_, i) => i !== index)))} className="p-2 text-muted-foreground hover:text-destructive disabled:opacity-40"><X className="w-4 h-4" /></button>
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => setOwners(equalOwnerShares([...owners, { newBidderName: "", percent: "" }]))} className="inline-flex items-center gap-1 text-xs text-primary font-mono uppercase"><Plus className="w-3 h-3" /> Add owner</button>
                <span className={`text-xs font-mono ${Math.abs(total - 100) > 0.001 ? "text-destructive" : "text-foreground"}`}>Total {total.toFixed(2)}% / 100%</span>
              </div>
              {duplicate && <p role="alert" className="text-xs text-destructive">An owner is already listed here or in another consortium. Choose a different owner.</p>}
              <div className="flex gap-2 justify-end">
                {editingId != null && <button type="button" onClick={reset} className="border border-border px-4 py-2 text-xs font-mono uppercase">Cancel</button>}
                <button disabled={isPending || !valid} type="submit" className="bg-primary text-primary-foreground font-mono text-xs font-bold uppercase tracking-widest px-4 py-2 hover:bg-primary/90 disabled:opacity-50">
                  {isPending ? "Saving…" : editingId != null ? "Save Changes" : "Add Consortium"}
                </button>
              </div>
            </form>
            }
          </div>

          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-widest mb-2">Existing Roster</h4>
            <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] text-sm text-left">
              <thead className="bg-muted text-xs font-mono uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Aliases</th>
                   <th className="px-3 py-2">Owners / Shares</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {consortia.map(c => (
                  <tr key={c.id} className={c.active === 0 ? "opacity-50" : ""}>
                    <td className="px-3 py-2 font-bold">
                      {c.displayName}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {c.aliases?.join(", ") || "—"}
                      <button onClick={() => handleEditAliases(c)} disabled={isPending} className="ml-2 text-[10px] text-primary hover:underline font-sans">Edit</button>
                    </td>
                    <td className="px-3 py-2">
                       {((c as RosterConsortium).owners || []).map(o => <div key={o.bidderId} className="text-xs whitespace-nowrap">{o.bidderName} <span className="font-mono text-muted-foreground">{(o.share * 100).toFixed(2)}%</span></div>)}
                    </td>
                    <td className="px-3 py-2 text-right">
                       <button onClick={() => edit(c as RosterConsortium)} disabled={isPending || biddersLoading || biddersError || soldConsortiumIds.has(c.id)} title={soldConsortiumIds.has(c.id) ? "Owner shares are locked after a recorded sale. Use an audited sale correction to change ownership." : undefined} className="mr-3 text-[10px] font-mono uppercase tracking-widest text-primary hover:underline disabled:opacity-50 disabled:no-underline">{soldConsortiumIds.has(c.id) ? "Ownership locked" : "Edit owners"}</button>
                      <button onClick={() => handleToggleActive(c)} disabled={isPending} className="text-[10px] font-mono uppercase tracking-widest text-primary hover:underline">
                        {c.active === 1 ? "Deactivate" : "Activate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ManageInventoryDialog({ open, onOpenChange, calcuttaId, auctionId, lots, adminKey, revision }: { open: boolean, onOpenChange: (open: boolean) => void, calcuttaId: number, auctionId: number, lots: AuctionLot[], adminKey: string, revision: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isPending, setIsPending] = useState(false);

  const [externalId, setExternalId] = useState("");
  const [name, setName] = useState("");
  const [entryId, setEntryId] = useState("");
  const { data: eligibleEntries = [], isLoading: entriesLoading } = useQuery<Array<{ id: number; teamName: string }>>({
    queryKey: ["auction-eligible-entries", calcuttaId, auctionId],
    enabled: open,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/entries`, { signal });
      if (!response.ok) throw new Error("Could not load eligible Calcutta entries.");
      return response.json();
    },
  });
  const unusedEntries = eligibleEntries.filter((entry) => !lots.some((lot) => lot.entryId === entry.id));

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!externalId || !name || !entryId) return;
    setIsPending(true);
    try {
      await addLotBulk(calcuttaId, auctionId, [{ externalId, name, entryId: parseInt(entryId, 10) }], adminKey, revision);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
      setExternalId("");
      setName("");
      setEntryId("");
      toast({ title: "Lot added" });
    } catch (err: any) {
      toast({ title: "Failed to add", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  const handleDelete = async (lotId: number) => {
    if (!confirm("Delete this lot?")) return;
    setIsPending(true);
    try {
      await deleteLot(calcuttaId, auctionId, lotId, adminKey, revision);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
      toast({ title: "Lot deleted" });
    } catch (err: any) {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-widest text-lg">Manage Inventory</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Add team-backed entries from this Calcutta. Nomination and sales remain locked until inventory is loaded.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <div className="border border-border p-4 bg-muted/30">
            <h4 className="font-mono text-xs font-bold uppercase tracking-widest mb-4">Add Single Lot</h4>
            <form onSubmit={handleAdd} className="flex items-end gap-2">
              <div className="w-1/4 space-y-1">
                <label className="text-xs font-mono text-muted-foreground">External ID</label>
                <input type="text" value={externalId} onChange={e => setExternalId(e.target.value)} className="w-full bg-background border border-border px-3 py-2 text-sm" placeholder="buf" />
              </div>
              <div className="flex-1 space-y-1">
                <label className="text-xs font-mono text-muted-foreground">Name</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} className="w-full bg-background border border-border px-3 py-2 text-sm" placeholder="Buffalo Bills" />
              </div>
              <div className="w-1/4 space-y-1">
                <label htmlFor="auction-entry-select" className="text-xs font-mono text-muted-foreground">Team entry</label>
                <select
                  id="auction-entry-select"
                  value={entryId}
                  onChange={e => {
                    const selected = unusedEntries.find((entry) => String(entry.id) === e.target.value);
                    setEntryId(e.target.value);
                    if (selected) {
                      setName(selected.teamName);
                      setExternalId(`entry-${selected.id}`);
                    }
                  }}
                  className="w-full bg-background border border-border px-3 py-2 text-sm"
                >
                  <option value="">Select team…</option>
                  {unusedEntries.map((entry) => <option key={entry.id} value={entry.id}>{entry.teamName}</option>)}
                </select>
              </div>
              <button disabled={isPending || !externalId || !name || !entryId} type="submit" className="bg-primary text-primary-foreground font-mono text-xs font-bold uppercase tracking-widest px-4 py-2 hover:bg-primary/90 disabled:opacity-50 h-9 shrink-0">
                {isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Add
              </button>
            </form>
            {!entriesLoading && unusedEntries.length === 0 && (
              <p className="mt-3 text-xs text-muted-foreground">No unused team-backed entries are available in this Calcutta.</p>
            )}
          </div>

          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-widest mb-2">Existing Lots</h4>
            <table className="w-full text-sm text-left">
              <thead className="bg-muted text-xs font-mono uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Entry ID</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lots.map(l => (
                  <tr key={l.id}>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.externalId}</td>
                    <td className="px-3 py-2 font-bold">{l.displayName}</td>
                    <td className="px-3 py-2 font-mono">{l.entryId}</td>
                    <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest">{l.status}</td>
                    <td className="px-3 py-2 text-right">
                      {l.status === "available" && (
                        <button onClick={() => handleDelete(l.id)} disabled={isPending} className="text-destructive hover:bg-destructive/10 p-1 rounded-sm transition-colors">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
