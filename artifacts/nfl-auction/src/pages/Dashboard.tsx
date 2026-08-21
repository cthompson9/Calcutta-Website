import { useState } from "react";
import {
  useGetAuctionSummary,
  importDraftOrder,
  getGetAuctionSummaryQueryKey,
} from "@workspace/api-client-react";
import { formatCurrency, formatPercentage } from "@/lib/utils";
import { Trophy, TrendingUp, DollarSign, Activity, Download, Lock, Unlock, Loader2 } from "lucide-react";
import { useSeason } from "@/hooks/useSeason";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ── Admin key panel (reused from Trades pattern) ──────────────────────────────

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

  function handleUnlock() {
    if (!input.trim()) return;
    onSetKey(input.trim());
    setInput("");
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
        title="Enter admin key to pull draft results"
      >
        <Lock className="w-3 h-3" /> Admin
      </button>
      {expanded && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border p-3 w-64 space-y-2 shadow-lg">
          <p className="text-xs font-mono text-muted-foreground">
            Enter your admin key to enable draft-result imports.
          </p>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleUnlock(); }}
            placeholder="Admin key…"
            className="w-full border border-border bg-background px-2 py-1.5 text-sm font-mono"
            autoFocus
          />
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { year } = useSeason();
  const queryClient = useQueryClient();
  const { data: summary, isLoading: loadingSummary, refetch } = useGetAuctionSummary({ season: year });

  const [adminKey, setAdminKey] = useState<string | null>(
    () => sessionStorage.getItem("nfl_admin_key"),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ ok: true; msg: string } | { ok: false; msg: string } | null>(null);

  function saveAdminKey(key: string) {
    sessionStorage.setItem("nfl_admin_key", key);
    setAdminKey(key);
  }
  function clearAdminKey() {
    sessionStorage.removeItem("nfl_admin_key");
    setAdminKey(null);
  }

  async function runImport() {
    if (!adminKey) return;
    setImporting(true);
    setImportResult(null);
    try {
      const result = await importDraftOrder(
        { seasonYear: year },
        { headers: { Authorization: `Bearer ${adminKey}` } },
      );
      setImportResult({
        ok: true,
        msg: `Imported ${result.importedTeams} teams for ${result.seasonYear} from ${result.source}.`,
      });
      await refetch();
      queryClient.invalidateQueries({ queryKey: getGetAuctionSummaryQueryKey() });
    } catch (err) {
      setImportResult({
        ok: false,
        msg: err instanceof Error ? err.message : "Import failed.",
      });
    } finally {
      setImporting(false);
    }
  }

  if (loadingSummary) {
    return (
      <div className="p-4 md:p-8 space-y-8 animate-pulse">
        <div className="h-8 w-64 bg-muted mb-8" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-32 bg-muted border border-border" />)}
        </div>
        <div className="h-[400px] bg-muted border border-border" />
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="p-4 md:p-8 space-y-8 max-w-7xl mx-auto">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-2">Auction Board</h1>
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
            {year} auction standings & stats
          </p>
        </div>

        {/* Admin controls */}
        <div className="flex items-center gap-3 flex-wrap">
          <AdminPanel adminKey={adminKey} onSetKey={saveAdminKey} onClearKey={clearAdminKey} />
          {adminKey && (
            <button
              onClick={() => { setImportResult(null); setConfirmOpen(true); }}
              disabled={importing}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground font-mono font-bold uppercase tracking-widest text-xs hover:bg-primary/90 disabled:opacity-60 transition-colors h-9"
            >
              {importing
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Importing…</>
                : <><Download className="w-3.5 h-3.5" /> Pull {year} Results</>
              }
            </button>
          )}
        </div>
      </header>

      {/* Import feedback */}
      {importResult && (
        <div className={`border px-4 py-2 text-xs font-mono ${
          importResult.ok
            ? "border-green-300 bg-green-50 text-green-800"
            : "border-destructive/40 bg-destructive/5 text-destructive"
        }`}>
          {importResult.ok ? "✓ " : "✗ "}{importResult.msg}
        </div>
      )}

      {/* Headline Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-0 border border-border bg-card">
        <StatCard title="Total Pot" value={formatCurrency(summary.potSize)} icon={Trophy} className="border-b md:border-b-0 md:border-r" />
        <StatCard title="Avg Bid / Team" value={formatCurrency(summary.avgBidPerTeam)} icon={DollarSign} className="border-b md:border-b-0 md:border-r border-l" />
        <StatCard title="Teams Auctioned" value={`${summary.teamsAuctioned}/32`} icon={Activity} className="border-r md:border-r border-t md:border-t-0" />
        <StatCard title="Nominations Left" value={summary.nominationsLeft.toString()} icon={TrendingUp} className="border-t md:border-t-0" />
      </div>

      <div className="grid md:grid-cols-3 gap-8 items-start">
        {/* Leaderboard */}
        <div className="md:col-span-2 space-y-4">
          <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
            <div className="w-3 h-3 bg-primary" /> Standings
          </h2>
          <div className="border border-border bg-card overflow-hidden">
            <div className="grid grid-cols-12 bg-muted text-muted-foreground text-xs font-mono font-bold uppercase tracking-widest px-4 py-3 border-b border-border">
              <div className="col-span-1 text-center">Rk</div>
              <div className="col-span-4">Bidder</div>
              <div className="col-span-3 text-right">Total Paid</div>
              <div className="col-span-2 text-center">Teams</div>
              <div className="col-span-2 text-right">% Pot</div>
            </div>
            {summary.standings.map((standing, index) => {
              const isLeader = index === 0 && standing.totalPaid > 0;
              return (
                <div
                  key={standing.bidderId}
                  className={`grid grid-cols-12 items-center px-4 py-4 border-b border-border last:border-0 hover:bg-muted/50 transition-colors ${
                    isLeader ? "bg-gold/10" : ""
                  }`}
                >
                  <div className="col-span-1 text-center font-mono font-bold">
                    {index + 1}
                  </div>
                  <div className="col-span-4 font-bold truncate pr-2 flex items-center gap-2">
                    {isLeader && <Trophy className="w-4 h-4 text-gold shrink-0" />}
                    {standing.bidderName}
                  </div>
                  <div className="col-span-3 text-right font-mono font-bold text-lg">
                    {formatCurrency(standing.totalPaid)}
                  </div>
                  <div className="col-span-2 text-center font-mono text-muted-foreground">
                    {standing.teamCount}
                  </div>
                  <div className="col-span-2 text-right font-mono text-sm">
                    {formatPercentage(standing.percentOfPot)}
                  </div>
                </div>
              );
            })}
            {summary.standings.length === 0 && (
              <div className="p-8 text-center text-muted-foreground">
                No active bidders yet.
              </div>
            )}
          </div>
        </div>

        {/* Conference Breakdown */}
        <div className="space-y-4">
          <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
            <div className="w-3 h-3 bg-primary" /> Conference Splits
          </h2>
          <div className="flex flex-col gap-4">
            {summary.conferenceBreakdown.map((conf) => {
              const isAFC = conf.conference === "AFC";
              return (
                <div
                  key={conf.conference}
                  className={`border border-border p-5 relative overflow-hidden bg-card ${
                    isAFC ? "border-t-4 border-t-afc" : "border-t-4 border-t-nfc"
                  }`}
                >
                  <div className="flex justify-between items-end mb-6">
                    <h3 className={`text-4xl font-black ${isAFC ? "text-afc" : "text-nfc"}`}>
                      {conf.conference}
                    </h3>
                    <div className="text-right">
                      <div className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Spent</div>
                      <div className="text-xl font-mono font-bold">{formatCurrency(conf.totalSpent)}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 mt-2">
                    <div>
                      <div className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-widest">Teams</div>
                      <div className="font-mono text-lg">{conf.teamCount}/16</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-widest">Avg Bid</div>
                      <div className="font-mono text-lg">{formatCurrency(conf.avgBid)}</div>
                    </div>
                  </div>
                </div>
              );
            })}
            {summary.conferenceBreakdown.length === 0 && (
              <div className="border border-dashed border-border px-5 py-12 text-center">
                <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                  No conference auction data for {year}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="rounded-none border-border max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono uppercase tracking-widest">
              Overwrite {year} Auction Data?
            </AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-sm space-y-2 pt-1">
              <span className="block">
                This will pull live results from AuctionPro and <strong>permanently replace</strong> all
                {" "}{year} auction data — all 32 teams, prices, and primary ownership.
              </span>
              {year >= new Date().getFullYear() && (
                <span className="block text-destructive font-semibold">
                  ⚠ {year} is the live season. This cannot be undone.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="rounded-none font-mono uppercase tracking-widest">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="rounded-none font-mono uppercase tracking-widest bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={runImport}
            >
              Yes, Pull Results
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, className }: { title: string; value: string; icon: any; className?: string }) {
  return (
    <div className={`p-6 flex flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-xs font-mono font-bold uppercase tracking-widest">{title}</span>
        <Icon className="w-4 h-4 opacity-50" />
      </div>
      <div className="text-3xl md:text-4xl font-mono font-black tracking-tight">{value}</div>
    </div>
  );
}
