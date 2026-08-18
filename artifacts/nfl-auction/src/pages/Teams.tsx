import { useState, useMemo } from "react";
import { 
  useGetTeams, 
  useGetBidders, 
  useCreateTeam, 
  useUpdateTeam, 
  useDeleteTeam,
  getGetTeamsQueryKey,
  getGetAuctionSummaryQueryKey,
  getGetBiddersQueryKey,
  Team,
  TeamConference,
  TeamDivision
} from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Plus, Trash2, FilterX } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";

export default function Teams() {
  const [search, setSearch] = useState("");
  const [confFilter, setConfFilter] = useState<"ALL" | "AFC" | "NFC">("ALL");
  const [divFilter, setDivFilter] = useState<"ALL" | "East" | "North" | "South" | "West">("ALL");

  const [sortCol, setSortCol] = useState<keyof Team | "owners">("bidAmount");
  const [sortAsc, setSortAsc] = useState(false);

  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const { data: teams, isLoading } = useGetTeams();
  const { data: bidders } = useGetBidders();

  const handleSort = (col: keyof Team | "owners") => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else {
      setSortCol(col);
      setSortAsc(col === "name" || col === "conference" || col === "division");
    }
  };

  const filteredTeams = useMemo(() => {
    if (!teams) return [];
    let result = teams.filter(t => {
      if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (confFilter !== "ALL" && t.conference !== confFilter) return false;
      if (divFilter !== "ALL" && t.division !== divFilter) return false;
      return true;
    });

    result.sort((a, b) => {
      let valA: any = a[sortCol as keyof Team];
      let valB: any = b[sortCol as keyof Team];

      if (sortCol === "owners") {
        valA = a.owners.map(o => o.bidderName).join(", ");
        valB = b.owners.map(o => o.bidderName).join(", ");
      }

      if (valA < valB) return sortAsc ? -1 : 1;
      if (valA > valB) return sortAsc ? 1 : -1;
      return 0;
    });

    return result;
  }, [teams, search, confFilter, divFilter, sortCol, sortAsc]);

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-2">Teams</h1>
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">Browse & manage auction roster</p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="uppercase font-bold tracking-wider font-mono">
          <Plus className="w-4 h-4 mr-2" /> Add Team
        </Button>
      </header>

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 border border-border bg-card">
        <div className="relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search teams..." 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-background font-mono rounded-none"
          />
        </div>
        <Select value={confFilter} onValueChange={(v: any) => setConfFilter(v)}>
          <SelectTrigger className="font-mono rounded-none">
            <SelectValue placeholder="Conference" />
          </SelectTrigger>
          <SelectContent className="rounded-none">
            <SelectItem value="ALL">All Conferences</SelectItem>
            <SelectItem value="AFC">AFC</SelectItem>
            <SelectItem value="NFC">NFC</SelectItem>
          </SelectContent>
        </Select>
        <Select value={divFilter} onValueChange={(v: any) => setDivFilter(v)}>
          <SelectTrigger className="font-mono rounded-none">
            <SelectValue placeholder="Division" />
          </SelectTrigger>
          <SelectContent className="rounded-none">
            <SelectItem value="ALL">All Divisions</SelectItem>
            <SelectItem value="East">East</SelectItem>
            <SelectItem value="North">North</SelectItem>
            <SelectItem value="South">South</SelectItem>
            <SelectItem value="West">West</SelectItem>
          </SelectContent>
        </Select>
        <Button 
          variant="outline" 
          onClick={() => { setSearch(""); setConfFilter("ALL"); setDivFilter("ALL"); }}
          className="font-mono uppercase tracking-wider rounded-none"
        >
          <FilterX className="w-4 h-4 mr-2" /> Clear
        </Button>
      </div>

      {/* Table */}
      <div className="border border-border bg-card overflow-x-auto">
        <div className="min-w-[800px]">
          <div className="grid grid-cols-12 bg-muted text-muted-foreground text-xs font-mono font-bold uppercase tracking-widest px-4 py-3 border-b border-border">
            <div className="col-span-3 cursor-pointer hover:text-foreground flex items-center" onClick={() => handleSort("name")}>
              Team {sortCol === "name" && (sortAsc ? "↑" : "↓")}
            </div>
            <div className="col-span-1 cursor-pointer hover:text-foreground text-center" onClick={() => handleSort("conference")}>
              Conf {sortCol === "conference" && (sortAsc ? "↑" : "↓")}
            </div>
            <div className="col-span-2 cursor-pointer hover:text-foreground text-center" onClick={() => handleSort("division")}>
              Div {sortCol === "division" && (sortAsc ? "↑" : "↓")}
            </div>
            <div className="col-span-2 cursor-pointer hover:text-foreground text-right" onClick={() => handleSort("bidAmount")}>
              Bid {sortCol === "bidAmount" && (sortAsc ? "↑" : "↓")}
            </div>
            <div className="col-span-4 pl-8 cursor-pointer hover:text-foreground" onClick={() => handleSort("owners")}>
              Owner(s) {sortCol === "owners" && (sortAsc ? "↑" : "↓")}
            </div>
          </div>
          
          {isLoading ? (
            <div className="p-8 text-center animate-pulse">Loading teams...</div>
          ) : filteredTeams.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground font-mono">No teams found.</div>
          ) : (
            filteredTeams.map((team) => (
              <div 
                key={team.id} 
                onClick={() => setEditingTeam(team)}
                className="grid grid-cols-12 items-center px-4 py-3 border-b border-border last:border-0 hover:bg-muted/50 transition-colors cursor-pointer"
              >
                <div className="col-span-3 font-bold truncate pr-2">
                  {team.name}
                </div>
                <div className="col-span-1 flex justify-center">
                  <span className={`px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-widest border ${
                    team.conference === "AFC" ? "text-afc border-afc/30 bg-afc/5" : "text-nfc border-nfc/30 bg-nfc/5"
                  }`}>
                    {team.conference}
                  </span>
                </div>
                <div className="col-span-2 text-center font-mono text-sm">
                  {team.division}
                </div>
                <div className="col-span-2 text-right font-mono font-bold text-lg">
                  {team.bidAmount > 0 ? formatCurrency(team.bidAmount) : "-"}
                </div>
                <div className="col-span-4 pl-8 font-mono text-sm truncate flex flex-wrap gap-1">
                  {team.owners.length === 0 && <span className="text-muted-foreground opacity-50">Unsold</span>}
                  {team.owners.length > 0 && team.owners.map(o => o.bidderName).join(" / ")}
                  {team.owners.length > 1 && (
                    <span className="text-[10px] bg-accent text-accent-foreground px-1 py-0.5 ml-2 border border-border flex-shrink-0">SPLIT</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <TeamDialog 
        open={isCreateOpen} 
        onOpenChange={setIsCreateOpen} 
        bidders={bidders || []} 
      />
      {editingTeam && (
        <TeamDialog 
          team={editingTeam} 
          open={!!editingTeam} 
          onOpenChange={(o) => !o && setEditingTeam(null)} 
          bidders={bidders || []}
        />
      )}
    </div>
  );
}

function TeamDialog({ team, open, onOpenChange, bidders }: { team?: Team, open: boolean, onOpenChange: (o: boolean) => void, bidders: any[] }) {
  const isEdit = !!team;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createMut = useCreateTeam();
  const updateMut = useUpdateTeam();
  const deleteMut = useDeleteTeam();

  const [name, setName] = useState(team?.name || "");
  const [conference, setConference] = useState<string>(team?.conference || "AFC");
  const [division, setDivision] = useState<string>(team?.division || "East");
  const [bidAmount, setBidAmount] = useState(team?.bidAmount.toString() || "0");
  
  // owners state for UI: array of { bidderId, share }
  const [owners, setOwners] = useState<Array<{bidderId: string, share: string}>>(
    team?.owners.map(o => ({ bidderId: o.bidderId.toString(), share: o.ownershipShare.toString() })) || []
  );

  const reset = () => {
    if (team) {
      setName(team.name);
      setConference(team.conference);
      setDivision(team.division);
      setBidAmount(team.bidAmount.toString());
      setOwners(team.owners.map(o => ({ bidderId: o.bidderId.toString(), share: o.ownershipShare.toString() })));
    } else {
      setName("");
      setConference("AFC");
      setDivision("East");
      setBidAmount("0");
      setOwners([]);
    }
  };

  const handleSave = () => {
    const data: any = {
      name,
      conference,
      division,
      bidAmount: Number(bidAmount) || 0,
      owners: owners.filter(o => o.bidderId).map(o => ({
        bidderId: Number(o.bidderId),
        ownershipShare: Number(o.share)
      }))
    };

    const sumShares = data.owners.reduce((sum: number, o: any) => sum + o.ownershipShare, 0);
    if (data.owners.length > 0 && Math.abs(sumShares - 1.0) > 0.001) {
      toast({ title: "Invalid Shares", description: "Ownership shares must sum to 1.0", variant: "destructive" });
      return;
    }

    if (isEdit) {
      updateMut.mutate({ id: team.id, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetTeamsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAuctionSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetBiddersQueryKey() });
          onOpenChange(false);
          toast({ title: "Team updated" });
        }
      });
    } else {
      createMut.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetTeamsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAuctionSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetBiddersQueryKey() });
          onOpenChange(false);
          reset();
          toast({ title: "Team created" });
        }
      });
    }
  };

  const handleDelete = () => {
    if (!team) return;
    if (confirm("Delete this team completely?")) {
      deleteMut.mutate({ id: team.id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetTeamsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAuctionSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetBiddersQueryKey() });
          onOpenChange(false);
          toast({ title: "Team deleted" });
        }
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if(!o) reset();
      onOpenChange(o);
    }}>
      <DialogContent className="sm:max-w-[500px] rounded-none border-border">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-widest">{isEdit ? "Edit Team" : "Add Team"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right font-mono text-xs uppercase tracking-widest">Name</Label>
            <Input className="col-span-3 font-bold rounded-none" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right font-mono text-xs uppercase tracking-widest">Conf</Label>
            <Select value={conference} onValueChange={setConference}>
              <SelectTrigger className="col-span-3 rounded-none font-mono"><SelectValue /></SelectTrigger>
              <SelectContent className="rounded-none font-mono">
                <SelectItem value="AFC">AFC</SelectItem>
                <SelectItem value="NFC">NFC</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right font-mono text-xs uppercase tracking-widest">Division</Label>
            <Select value={division} onValueChange={setDivision}>
              <SelectTrigger className="col-span-3 rounded-none font-mono"><SelectValue /></SelectTrigger>
              <SelectContent className="rounded-none font-mono">
                <SelectItem value="East">East</SelectItem>
                <SelectItem value="North">North</SelectItem>
                <SelectItem value="South">South</SelectItem>
                <SelectItem value="West">West</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right font-mono text-xs uppercase tracking-widest">Bid ($)</Label>
            <Input type="number" className="col-span-3 font-mono font-bold rounded-none" value={bidAmount} onChange={(e) => setBidAmount(e.target.value)} />
          </div>

          <div className="col-span-4 mt-4 space-y-4 border border-border p-4 bg-muted/20">
            <div className="flex justify-between items-center">
              <Label className="font-mono text-xs uppercase tracking-widest">Owners</Label>
              <Button type="button" variant="outline" size="sm" className="rounded-none h-7 text-[10px] font-mono uppercase" onClick={() => setOwners([...owners, { bidderId: "", share: "1.0" }])}>
                <Plus className="w-3 h-3 mr-1" /> Add Owner
              </Button>
            </div>
            
            {owners.map((owner, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <Select value={owner.bidderId} onValueChange={(v) => {
                  const newO = [...owners]; newO[idx].bidderId = v; setOwners(newO);
                }}>
                  <SelectTrigger className="flex-1 rounded-none font-mono text-xs"><SelectValue placeholder="Select Bidder" /></SelectTrigger>
                  <SelectContent className="rounded-none font-mono text-xs">
                    {bidders?.map(b => (
                      <SelectItem key={b.id} value={b.id.toString()}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input 
                  type="number" 
                  step="0.1" 
                  min="0" 
                  max="1" 
                  className="w-20 font-mono text-xs rounded-none" 
                  value={owner.share} 
                  onChange={(e) => {
                    const newO = [...owners]; newO[idx].share = e.target.value; setOwners(newO);
                  }}
                  placeholder="Share (1.0)"
                />
                <Button variant="ghost" size="icon" className="shrink-0 rounded-none h-9 w-9 text-destructive" onClick={() => setOwners(owners.filter((_, i) => i !== idx))}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
            {owners.length === 0 && <div className="text-xs text-muted-foreground font-mono text-center py-2">No owners yet.</div>}
          </div>
        </div>
        <DialogFooter className="gap-2">
          {isEdit && (
            <Button type="button" variant="destructive" className="rounded-none font-mono uppercase mr-auto" onClick={handleDelete} disabled={deleteMut.isPending}>
              <Trash2 className="w-4 h-4 mr-2" /> Delete
            </Button>
          )}
          <Button type="button" variant="outline" className="rounded-none font-mono uppercase" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" className="rounded-none font-mono uppercase" onClick={handleSave} disabled={createMut.isPending || updateMut.isPending}>
            {isEdit ? "Save Changes" : "Create Team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
