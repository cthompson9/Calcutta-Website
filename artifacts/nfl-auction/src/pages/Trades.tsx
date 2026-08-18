import { useState } from "react";
import { useGetTrades, useGetTeams, useGetBidders, useCreateTrade, useDeleteTrade } from "@workspace/api-client-react";
import type { TradeRow } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { SeasonToggle } from "@/components/SeasonToggle";
import { useSeason } from "@/hooks/useSeason";
import { ArrowRight, Plus, Trash2, X } from "lucide-react";

export default function Trades() {
  const { year, setYear } = useSeason();
  const [showForm, setShowForm] = useState(false);

  const { data: trades, isLoading, refetch } = useGetTrades({ season: year });
  const { data: teams } = useGetTeams({});
  const { data: bidders } = useGetBidders({});
  const { mutate: createTrade, isPending: creating } = useCreateTrade();
  const { mutate: deleteTrade } = useDeleteTrade();

  function handleDelete(id: number) {
    if (!confirm("Delete this trade record?")) return;
    deleteTrade({ id }, { onSuccess: () => refetch() });
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl mx-auto">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-1">Trades</h1>
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
            Team trades & settlements · {year}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SeasonToggle year={year} onChange={setYear} />
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground font-mono font-bold uppercase tracking-widest text-sm hover:bg-primary/90 transition-colors h-9"
          >
            <Plus className="w-4 h-4" /> Add Trade
          </button>
        </div>
      </header>

      {/* Add trade modal */}
      {showForm && teams && bidders && (
        <TradeForm
          teams={teams}
          bidders={bidders}
          seasonYear={year}
          onCreate={(data) =>
            createTrade(
              { data },
              {
                onSuccess: () => {
                  setShowForm(false);
                  refetch();
                },
              },
            )
          }
          onClose={() => setShowForm(false)}
          creating={creating}
        />
      )}

      {isLoading ? (
        <div className="space-y-3 animate-pulse">
          {[1, 2, 3].map((i) => <div key={i} className="h-20 bg-muted border border-border" />)}
        </div>
      ) : !trades?.length ? (
        <div className="border border-dashed border-border flex flex-col items-center justify-center py-24 text-center">
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">No trades recorded for {year}</p>
          <p className="text-xs text-muted-foreground mt-2">Use the Add Trade button to log a trade or settlement</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="hidden md:grid grid-cols-12 bg-muted/60 text-muted-foreground text-xs font-mono font-bold uppercase tracking-widest px-4 py-2.5 border border-border">
            <div className="col-span-2">Date</div>
            <div className="col-span-3">Team</div>
            <div className="col-span-3">From → To</div>
            <div className="col-span-2 text-right">Price</div>
            <div className="col-span-1 text-left pl-2">Notes</div>
            <div className="col-span-1" />
          </div>
          {(trades as TradeRow[]).map((trade) => (
            <TradeCard key={trade.id} trade={trade} onDelete={handleDelete} />
          ))}
          <p className="text-xs text-muted-foreground font-mono">{trades.length} trade{trades.length !== 1 ? "s" : ""} recorded</p>
        </div>
      )}
    </div>
  );
}

function TradeCard({ trade, onDelete }: { trade: TradeRow; onDelete: (id: number) => void }) {
  return (
    <div className="border border-border bg-card grid grid-cols-6 md:grid-cols-12 items-center px-4 py-3 gap-2">
      <div className="col-span-2 font-mono text-xs text-muted-foreground">{trade.tradeDate}</div>
      <div className="col-span-2 md:col-span-3 font-medium text-sm truncate">{trade.teamName}</div>
      <div className="col-span-2 md:col-span-3 flex items-center gap-1.5 text-sm min-w-0">
        <span className="truncate font-medium">{trade.fromBidderName.split(" ")[0]}</span>
        <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
        <span className="truncate font-medium">{trade.toBidderName.split(" ")[0]}</span>
      </div>
      <div className="col-span-1 md:col-span-2 text-right font-mono font-bold text-sm">{formatCurrency(trade.price)}</div>
      <div className="hidden md:block col-span-1 text-xs text-muted-foreground truncate pl-2">{trade.notes ?? "–"}</div>
      <div className="col-span-1 flex justify-end">
        <button
          onClick={() => onDelete(trade.id)}
          className="p-1.5 text-muted-foreground hover:text-red-600 transition-colors"
          title="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function TradeForm({
  teams,
  bidders,
  seasonYear,
  onCreate,
  onClose,
  creating,
}: {
  teams: any[];
  bidders: any[];
  seasonYear: number;
  onCreate: (data: any) => void;
  onClose: () => void;
  creating: boolean;
}) {
  const [teamId, setTeamId] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [notes, setNotes] = useState("");

  function submit() {
    if (!teamId || !fromId || !toId || !price) return;
    onCreate({
      seasonYear,
      teamId: parseInt(teamId),
      fromBidderId: parseInt(fromId),
      toBidderId: parseInt(toId),
      price: parseFloat(price),
      tradeDate: date,
      notes: notes || undefined,
    });
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-border w-full max-w-md space-y-4 p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-lg uppercase tracking-tight">Record Trade</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="space-y-3">
          <Field label="Team">
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="w-full border border-border bg-background px-3 py-2 text-sm">
              <option value="">Select team…</option>
              {teams.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="From Owner">
            <select value={fromId} onChange={(e) => setFromId(e.target.value)} className="w-full border border-border bg-background px-3 py-2 text-sm">
              <option value="">Select owner…</option>
              {bidders.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="To Owner">
            <select value={toId} onChange={(e) => setToId(e.target.value)} className="w-full border border-border bg-background px-3 py-2 text-sm">
              <option value="">Select owner…</option>
              {bidders.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price ($)">
              <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" step="1" className="w-full border border-border bg-background px-3 py-2 text-sm" />
            </Field>
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border border-border bg-background px-3 py-2 text-sm" />
            </Field>
          </div>
          <Field label="Notes (optional)">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Settlement" className="w-full border border-border bg-background px-3 py-2 text-sm" />
          </Field>
        </div>

        <div className="flex gap-3 pt-2">
          <button onClick={onClose} className="flex-1 border border-border px-4 py-2 text-sm font-mono font-bold uppercase tracking-widest text-muted-foreground hover:bg-muted transition-colors">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={creating || !teamId || !fromId || !toId || !price}
            className={cn("flex-1 px-4 py-2 text-sm font-mono font-bold uppercase tracking-widest transition-colors", creating || !teamId ? "bg-muted text-muted-foreground cursor-not-allowed" : "bg-primary text-primary-foreground hover:bg-primary/90")}
          >
            {creating ? "Saving…" : "Record Trade"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground mb-1">{label}</label>
      {children}
    </div>
  );
}
