import { useState } from "react";
import { type AuctionConsortium, type BidderSummary, type AuctionLot, getGetBiddersQueryKey } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { editConsortium, addConsortium, addLotBulk, editLot, deleteLot } from "./admin-actions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Edit2, Trash2, X } from "lucide-react";

export function ManageRosterDialog({ open, onOpenChange, calcuttaId, auctionId, consortia, bidders, adminKey, revision }: { open: boolean, onOpenChange: (open: boolean) => void, calcuttaId: number, auctionId: number, consortia: AuctionConsortium[], bidders: BidderSummary[], adminKey: string, revision: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isPending, setIsPending] = useState(false);

  const [newName, setNewName] = useState("");
  const [newAliases, setNewAliases] = useState("");
  const [newBidderId, setNewBidderId] = useState("");
  const [newBidderName, setNewBidderName] = useState("");

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName || !newBidderId || (newBidderId === "__new" && !newBidderName.trim())) return;
    setIsPending(true);
    try {
      await addConsortium(calcuttaId, auctionId, newName,
        newBidderId === "__new" ? null : parseInt(newBidderId, 10),
        newBidderId === "__new" ? newBidderName.trim() : null, adminKey, revision);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
      setNewName("");
      setNewAliases("");
      setNewBidderId("");
      setNewBidderName("");
      queryClient.invalidateQueries({ queryKey: getGetBiddersQueryKey() });
      toast({ title: "Consortium added" });
    } catch (err: any) {
      toast({ title: "Failed to add", description: err.message, variant: "destructive" });
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

  const handleRename = async (c: AuctionConsortium) => {
    const newNamePrompt = prompt("Enter new name:", c.displayName);
    if (!newNamePrompt || newNamePrompt === c.displayName) return;
    setIsPending(true);
    try {
      await editConsortium(calcuttaId, auctionId, c.id, { displayName: newNamePrompt }, adminKey, revision);
      queryClient.invalidateQueries({ queryKey: ["active-auction", calcuttaId] });
      toast({ title: "Name updated" });
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
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-widest text-lg">Manage Roster</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <div className="border border-border p-4 bg-muted/30">
            <h4 className="font-mono text-xs font-bold uppercase tracking-widest mb-4">Add New Consortium</h4>
            <form onSubmit={handleAdd} className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <label className="text-xs font-mono text-muted-foreground">Name</label>
                <input type="text" value={newName} onChange={e => setNewName(e.target.value)} className="w-full bg-background border border-border px-3 py-2 text-sm" placeholder="Consortium Name" />
              </div>
              <div className="flex-1 space-y-1">
                <label className="text-xs font-mono text-muted-foreground">Bidder Mapping</label>
                <select value={newBidderId} onChange={e => setNewBidderId(e.target.value)} className="w-full bg-background border border-border px-3 py-2 text-sm">
                  <option value="" disabled>Select Bidder...</option>
                  {bidders.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  <option value="__new">Create a new bidder…</option>
                </select>
                {newBidderId === "__new" && (
                  <input aria-label="New bidder name" type="text" value={newBidderName}
                    onChange={e => setNewBidderName(e.target.value)}
                    className="w-full bg-background border border-border px-3 py-2 text-sm"
                    placeholder="New bidder name" />
                )}
              </div>
              <button disabled={isPending || !newName || !newBidderId || (newBidderId === "__new" && !newBidderName.trim())} type="submit" className="bg-primary text-primary-foreground font-mono text-xs font-bold uppercase tracking-widest px-4 py-2 hover:bg-primary/90 disabled:opacity-50 h-9 shrink-0">
                {isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Add
              </button>
            </form>
          </div>

          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-widest mb-2">Existing Roster</h4>
            <table className="w-full text-sm text-left">
              <thead className="bg-muted text-xs font-mono uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Aliases</th>
                  <th className="px-3 py-2">Mapped Bidder</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {consortia.map(c => (
                  <tr key={c.id} className={c.active === 0 ? "opacity-50" : ""}>
                    <td className="px-3 py-2 font-bold">
                      {c.displayName}
                      <button onClick={() => handleRename(c)} disabled={isPending} className="ml-2 text-[10px] text-primary hover:underline">Rename</button>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {c.aliases?.join(", ") || "—"}
                      <button onClick={() => handleEditAliases(c)} disabled={isPending} className="ml-2 text-[10px] text-primary hover:underline font-sans">Edit</button>
                    </td>
                    <td className="px-3 py-2">
                      {bidders.find(b => b.id === c.bidderId)?.name || <span className="text-destructive">Unmapped</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
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
