import { useState, useEffect } from "react";
import {
  useGetTrades,
  useGetTeams,
  useGetBidders,
  useCreateTrade,
  useDeleteTrade,
} from "@workspace/api-client-react";
import type { TradeRow } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { todayInNewYork } from "@/lib/newYorkTime";
import { useSeason } from "@/hooks/useSeason";
import { ArrowRight, Plus, Trash2, X, Lock, Unlock, Check, Ban } from "lucide-react";

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; cls: string }> = {
    pending:  { label: "PENDING REVIEW", cls: "bg-amber-100 text-amber-800 border-amber-300" },
    approved: { label: "APPROVED",       cls: "bg-green-100 text-green-800 border-green-300" },
    rejected: { label: "REJECTED",       cls: "bg-red-100 text-red-800 border-red-300" },
  };
  const { label, cls } = config[status] ?? config.pending;
  return (
    <span className={cn("inline-block border px-2 py-0.5 text-[10px] font-mono font-bold tracking-widest", cls)}>
      {label}
    </span>
  );
}

// ── API call to set trade status (needs ADMIN_API_KEY as Bearer) ──────────────

async function setTradeStatus(
  id: number,
  status: "approved" | "rejected",
  adminKey: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/trades/${id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminKey}`,
      },
      body: JSON.stringify({ status }),
    });
    if (res.status === 401) return { ok: false, error: "Invalid admin key" };
    if (!res.ok) return { ok: false, error: await res.text() };
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

// ── Trade card ───────────────────────────────────────────────────────────────

function TradeCard({
  trade,
  onDelete,
  adminKey,
  onStatusChange,
}: {
  trade: TradeRow;
  onDelete: (id: number) => void;
  adminKey: string | null;
  onStatusChange: () => void;
}) {
  const [acting, setActing] = useState(false);
  const [adminError, setAdminError] = useState("");

  async function handleStatus(status: "approved" | "rejected") {
    if (!adminKey) return;
    setActing(true);
    setAdminError("");
    const result = await setTradeStatus(trade.id, status, adminKey);
    setActing(false);
    if (!result.ok) {
      setAdminError(result.error ?? "Error");
    } else {
      onStatusChange();
    }
  }

  const showPct = trade.percentage !== 100;

  return (
    <div
      className={cn(
        "border border-border p-4 space-y-3",
        trade.status === "pending" && "border-amber-200 bg-amber-50/30",
        trade.status === "rejected" && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Left: team + parties */}
        <div className="space-y-1 flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-bold text-sm truncate">{trade.teamName}</span>
            {showPct && (
              <span className="bg-muted border border-border px-1.5 py-0 text-[10px] font-mono text-muted-foreground">
                {trade.percentage}%
              </span>
            )}
            <StatusBadge status={trade.status} />
          </div>
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground font-mono">
            <span>{trade.fromBidderName}</span>
            <ArrowRight className="w-3 h-3" />
            <span>{trade.toBidderName}</span>
          </div>
        </div>

        {/* Right: price + date + delete */}
        <div className="text-right shrink-0 space-y-1">
          <div className="font-mono font-bold text-sm">{formatCurrency(trade.price)}</div>
          <div className="text-xs text-muted-foreground font-mono">{trade.tradeDate}</div>
          <button
            onClick={() => onDelete(trade.id)}
            className="text-muted-foreground hover:text-destructive transition-colors"
            title="Delete trade"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {trade.notes && (
        <p className="text-xs text-muted-foreground font-mono border-t border-border pt-2">{trade.notes}</p>
      )}

      {/* Admin approve/reject — only for pending trades when admin key is entered */}
      {adminKey && trade.status === "pending" && (
        <div className="border-t border-border pt-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-widest">Admin:</span>
          <button
            onClick={() => handleStatus("approved")}
            disabled={acting}
            className="flex items-center gap-1.5 px-3 py-1 bg-green-600 text-white text-xs font-mono font-bold uppercase tracking-wider hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            <Check className="w-3 h-3" /> Approve
          </button>
          <button
            onClick={() => handleStatus("rejected")}
            disabled={acting}
            className="flex items-center gap-1.5 px-3 py-1 bg-red-600 text-white text-xs font-mono font-bold uppercase tracking-wider hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            <Ban className="w-3 h-3" /> Reject
          </button>
          {adminError && <span className="text-xs text-destructive font-mono">{adminError}</span>}
        </div>
      )}
    </div>
  );
}

// ── Add trade form ────────────────────────────────────────────────────────────

function TradeForm({
  teams,
  fromBidders,
  toBidders,
  seasonYear,
  onCreate,
  onClose,
  creating,
}: {
  teams: any[];
  fromBidders: any[];
  toBidders: any[];
  seasonYear: number;
  onCreate: (data: any) => void;
  onClose: () => void;
  creating: boolean;
}) {
  const [teamId, setTeamId]   = useState("");
  const [fromId, setFromId]   = useState("");
  const [toId, setToId]       = useState("");
  const [percentage, setPct]  = useState("100");
  const [useDraftCost, setUseDraftCost] = useState(false);
  const [price, setPrice]     = useState("");
  const [date, setDate]       = useState(() => todayInNewYork());
  const [notes, setNotes]     = useState("");

  const selectedTeam = teams.find((t: any) => String(t.id) === teamId);
  const eligibleFromBidders = selectedTeam
    ? fromBidders.filter((bidder: any) =>
        bidder.teams?.some(
          (team: any) =>
            String(team.id) === teamId &&
            Number(team.ownershipShare ?? 0) > 0,
        ),
      )
    : fromBidders;

  // Auto-fill price when team, percentage, or useDraftCost changes
  useEffect(() => {
    if (!useDraftCost || !selectedTeam) return;
    const pct = parseFloat(percentage) || 100;
    const draftCost = parseFloat(selectedTeam.bidAmount ?? "0");
    const computed = Math.round((draftCost * pct) / 100 * 100) / 100;
    setPrice(computed.toString());
  }, [useDraftCost, teamId, percentage, selectedTeam]);

  function submit() {
    if (!teamId || !fromId || !toId) return;
    onCreate({
      seasonYear,
      teamId: parseInt(teamId),
      fromBidderId: parseInt(fromId),
      toBidderId: parseInt(toId),
      percentage: parseFloat(percentage) || 100,
      price: price ? parseFloat(price) : undefined,
      tradeDate: date,
      notes: notes || undefined,
    });
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-background border border-border w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-mono font-bold uppercase tracking-widest text-sm">Record Trade</h2>
          <button onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        <div className="space-y-3">
          <Field label="Team">
            <select
              value={teamId}
              onChange={(e) => {
                setTeamId(e.target.value);
                setFromId("");
                setUseDraftCost(false);
                setPrice("");
              }}
              className="w-full border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">Select team…</option>
              {teams.map((t: any) => (
                <option key={t.id} value={t.id}>{t.name} ({formatCurrency(parseFloat(t.bidAmount ?? "0"))})</option>
              ))}
            </select>
          </Field>

          <Field label="From Owner">
            <select value={fromId} onChange={(e) => setFromId(e.target.value)} className="w-full border border-border bg-background px-3 py-2 text-sm">
              <option value="">Select owner…</option>
              {eligibleFromBidders.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>

          <Field label="To Owner">
            <select value={toId} onChange={(e) => setToId(e.target.value)} className="w-full border border-border bg-background px-3 py-2 text-sm">
              <option value="">Select owner…</option>
              {toBidders.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>

          {/* Percentage */}
          <Field label={`% of team traded: ${percentage}%`}>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="1"
                max="100"
                step="5"
                value={percentage}
                onChange={(e) => setPct(e.target.value)}
                className="flex-1 accent-primary"
              />
              <input
                type="number"
                min="1"
                max="100"
                value={percentage}
                onChange={(e) => setPct(e.target.value)}
                className="w-16 border border-border bg-background px-2 py-1 text-sm text-right"
              />
            </div>
          </Field>

          {/* Price with "use draft cost" option */}
          <Field label="Price ($)">
            <input
              type="number"
              value={price}
              onChange={(e) => { setPrice(e.target.value); setUseDraftCost(false); }}
              placeholder={
                selectedTeam
                  ? `Default: ${formatCurrency(Math.round(parseFloat(selectedTeam.bidAmount ?? "0") * (parseFloat(percentage) || 100) / 100))}`
                  : "Defaults to draft cost × %"
              }
              step="1"
              className="w-full border border-border bg-background px-3 py-2 text-sm"
            />
            {selectedTeam && (
              <label className="flex items-center gap-2 mt-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useDraftCost}
                  onChange={(e) => setUseDraftCost(e.target.checked)}
                  className="accent-primary"
                />
                <span className="text-xs text-muted-foreground font-mono">
                  Use original draft cost ({formatCurrency(parseFloat(selectedTeam.bidAmount ?? "0"))}) × {percentage}%
                </span>
              </label>
            )}
          </Field>

          <Field label="Date">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full border border-border bg-background px-3 py-2 text-sm"
            />
          </Field>

          <Field label="Notes (optional)">
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Settlement, partial buyout…"
              className="w-full border border-border bg-background px-3 py-2 text-sm"
            />
          </Field>

          <p className="text-xs text-amber-700 font-mono bg-amber-50 border border-amber-200 px-3 py-2">
            ⏳ Trade will be submitted as <strong>PENDING REVIEW</strong>. Admin must approve before it affects results.
          </p>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            className="flex-1 border border-border px-4 py-2 text-sm font-mono font-bold uppercase tracking-widest text-muted-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={creating || !teamId || !fromId || !toId}
            className={cn(
              "flex-1 px-4 py-2 text-sm font-mono font-bold uppercase tracking-widest transition-colors",
              creating || !teamId || !fromId || !toId
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {creating ? "Saving…" : "Submit Trade"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Admin key panel ───────────────────────────────────────────────────────────

function AdminPanel({
  adminKey,
  onSetKey,
  onClearKey,
}: {
  adminKey: string | null;
  onSetKey: (k: string) => void;
  onClearKey: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  function handleUnlock() {
    if (!input.trim()) return;
    onSetKey(input.trim());
    setInput("");
    setError("");
    setExpanded(false);
  }

  if (adminKey) {
    return (
      <button
        onClick={onClearKey}
        className="flex items-center gap-1.5 px-3 py-1.5 border border-green-600 text-green-700 text-xs font-mono font-bold uppercase tracking-widest hover:bg-green-50 transition-colors"
        title="Admin mode active — click to lock"
      >
        <Unlock className="w-3 h-3" /> Admin Active
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1.5 border border-border text-muted-foreground text-xs font-mono font-bold uppercase tracking-widest hover:bg-muted transition-colors"
        title="Enter admin key to approve/reject trades"
      >
        <Lock className="w-3 h-3" /> Admin
      </button>
      {expanded && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border p-3 w-64 space-y-2 shadow-lg">
          <p className="text-xs font-mono text-muted-foreground">Enter your admin key to approve or reject pending trades.</p>
          <input
            type="password"
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleUnlock(); }}
            placeholder="Admin key…"
            className="w-full border border-border bg-background px-2 py-1.5 text-sm font-mono"
            autoFocus
          />
          {error && <p className="text-xs text-destructive font-mono">{error}</p>}
          <button
            onClick={handleUnlock}
            disabled={!input.trim()}
            className="w-full bg-primary text-primary-foreground text-xs font-mono font-bold uppercase tracking-widest py-1.5 hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            Unlock
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Trades() {
  const { year } = useSeason();
  const [showForm, setShowForm]     = useState(false);
  const [adminKey, setAdminKey]     = useState<string | null>(
    () => sessionStorage.getItem("nfl_admin_key"),
  );

  const { data: trades, isLoading, refetch } = useGetTrades({ season: year });
  const { data: teams } = useGetTeams({ season: year });
  const { data: seasonBidders } = useGetBidders({ season: year });
  const { data: bidderDirectory } = useGetBidders({});
  const { mutate: createTrade, isPending: creating } = useCreateTrade();
  const { mutate: deleteTrade } = useDeleteTrade();

  function saveAdminKey(key: string) {
    sessionStorage.setItem("nfl_admin_key", key);
    setAdminKey(key);
  }

  function clearAdminKey() {
    sessionStorage.removeItem("nfl_admin_key");
    setAdminKey(null);
  }

  function handleDelete(id: number) {
    if (!confirm("Delete this trade record?")) return;
    deleteTrade({ id }, { onSuccess: () => refetch() });
  }

  const pending  = (trades as TradeRow[] | undefined)?.filter((t) => t.status === "pending")  ?? [];
  const approved = (trades as TradeRow[] | undefined)?.filter((t) => t.status === "approved") ?? [];
  const rejected = (trades as TradeRow[] | undefined)?.filter((t) => t.status === "rejected") ?? [];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl mx-auto">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-1">Trades</h1>
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
            Team trades & settlements · {year}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <AdminPanel adminKey={adminKey} onSetKey={saveAdminKey} onClearKey={clearAdminKey} />
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground font-mono font-bold uppercase tracking-widest text-sm hover:bg-primary/90 transition-colors h-9"
          >
            <Plus className="w-4 h-4" /> Add Trade
          </button>
        </div>
      </header>

      {adminKey && (
        <div className="border border-green-300 bg-green-50 px-4 py-2 text-xs font-mono text-green-800">
          🔓 Admin mode active — Approve / Reject buttons are visible on pending trades.
        </div>
      )}

      {showForm && teams && seasonBidders && bidderDirectory && (
        <TradeForm
          teams={teams}
          fromBidders={seasonBidders}
          toBidders={bidderDirectory}
          seasonYear={year}
          onCreate={(data) =>
            createTrade({ data }, {
              onSuccess: () => { setShowForm(false); refetch(); },
            })
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
          <p className="text-xs text-muted-foreground mt-2">Use Add Trade to log a trade — it will start as Pending Review</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Pending */}
          {pending.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs font-mono font-bold uppercase tracking-widest text-amber-700 border-b border-amber-200 pb-1">
                ⏳ Pending Review ({pending.length})
              </h2>
              <div className="space-y-2">
                {pending.map((t) => (
                  <TradeCard key={t.id} trade={t} onDelete={handleDelete} adminKey={adminKey} onStatusChange={refetch} />
                ))}
              </div>
            </section>
          )}

          {/* Approved */}
          {approved.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs font-mono font-bold uppercase tracking-widest text-green-700 border-b border-green-200 pb-1">
                ✓ Approved ({approved.length})
              </h2>
              <div className="space-y-2">
                {approved.map((t) => (
                  <TradeCard key={t.id} trade={t} onDelete={handleDelete} adminKey={adminKey} onStatusChange={refetch} />
                ))}
              </div>
            </section>
          )}

          {/* Rejected */}
          {rejected.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground border-b border-border pb-1">
                ✗ Rejected ({rejected.length})
              </h2>
              <div className="space-y-2">
                {rejected.map((t) => (
                  <TradeCard key={t.id} trade={t} onDelete={handleDelete} adminKey={adminKey} onStatusChange={refetch} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
