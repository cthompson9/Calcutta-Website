import { useState } from "react";
import {
  useGetResults,
  useGetResultsByOwner,
} from "@workspace/api-client-react";
import type {
  TeamResultRow,
  OwnerResultRow,
} from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { SeasonToggle } from "@/components/SeasonToggle";
import { useSeason } from "@/hooks/useSeason";
import { ChevronDown, ChevronRight, Star } from "lucide-react";

type TabId = "byTeam" | "byOwner";

export default function Results() {
  const { year, setYear } = useSeason();
  const [tab, setTab] = useState<TabId>("byOwner");
  const [expandedOwner, setExpandedOwner] = useState<number | null>(null);

  const { data: teamResults, isLoading: loadingTeams } = useGetResults({ season: year });
  const { data: ownerResults, isLoading: loadingOwners } = useGetResultsByOwner({ season: year });

  const isLoading = loadingTeams || loadingOwners;
  const isComplete = year === 2025;

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-1">
            Calcutta Returns
          </h1>
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
            {isComplete ? "Final results · 2025 season" : "Upcoming season · 2026"}
          </p>
        </div>
        <SeasonToggle year={year} onChange={setYear} />
      </header>

      {/* Tabs */}
      <div className="flex border-b border-border">
        {(["byOwner", "byTeam"] as TabId[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-5 py-2.5 text-sm font-mono font-bold uppercase tracking-widest transition-colors border-b-2 -mb-px",
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t === "byOwner" ? "By Owner" : "By Team"}
          </button>
        ))}
      </div>

      {isLoading ? (
        <LoadingSkeleton />
      ) : tab === "byOwner" ? (
        <ByOwnerView
          rows={ownerResults ?? []}
          isComplete={isComplete}
          expandedOwner={expandedOwner}
          setExpandedOwner={setExpandedOwner}
        />
      ) : (
        <ByTeamView rows={teamResults ?? []} isComplete={isComplete} />
      )}
    </div>
  );
}

// ─── By Owner ────────────────────────────────────────────────────────────────

function ByOwnerView({
  rows,
  isComplete,
  expandedOwner,
  setExpandedOwner,
}: {
  rows: OwnerResultRow[];
  isComplete: boolean;
  expandedOwner: number | null;
  setExpandedOwner: (id: number | null) => void;
}) {
  if (!rows.length) return <Empty />;

  // Always sort by MTM net return — that's the live standing metric
  const sorted = [...rows].sort((a, b) =>
    isComplete ? b.totalNetReturn - a.totalNetReturn : b.totalMtm - a.totalMtm,
  );

  return (
    <div className="space-y-3">
      {/* Summary header */}
      <div className="hidden md:grid grid-cols-12 bg-muted/60 text-muted-foreground text-xs font-mono font-bold uppercase tracking-widest px-4 py-3 border border-border">
        <div className="col-span-1 text-center">#</div>
        <div className="col-span-3">Owner</div>
        <div className="col-span-1 text-center">Teams</div>
        <div className="col-span-2 text-right">Cost</div>
        {isComplete ? (
          <>
            <div className="col-span-2 text-right">Return</div>
            <div className="col-span-2 text-right">Net P&amp;L</div>
            <div className="col-span-1 text-right">MTM</div>
          </>
        ) : (
          <>
            <div className="col-span-4 text-right">MTM Return</div>
            <div className="col-span-1" />
          </>
        )}
      </div>

      {sorted.map((row, idx) => {
        const isExpanded = expandedOwner === row.bidderId;
        const isLeader = idx === 0;
        const isWinner = isLeader && isComplete && row.totalNetReturn > 0;
        return (
          <div key={row.bidderId} className="border border-border bg-card overflow-hidden">
            {/* Owner row */}
            <button
              onClick={() => setExpandedOwner(isExpanded ? null : row.bidderId)}
              className={cn(
                "w-full grid grid-cols-6 md:grid-cols-12 items-center px-4 py-4 hover:bg-muted/40 transition-colors text-left",
                isWinner && "bg-yellow-50 dark:bg-yellow-900/10"
              )}
            >
              <div className="col-span-1 flex items-center gap-1 font-mono font-bold text-lg">
                {isLeader && (
                  <img src="/sleigh-monkey.png" alt="leader" className="w-6 h-6 object-contain shrink-0" />
                )}
                <span>{idx + 1}</span>
              </div>
              <div className="col-span-2 md:col-span-3 font-bold truncate">{row.bidderName}</div>
              <div className="col-span-1 text-center text-muted-foreground font-mono">{row.teamCount}</div>
              <div className="col-span-1 md:col-span-2 text-right font-mono text-sm">{formatCurrency(row.totalCost)}</div>
              {isComplete ? (
                <>
                  <div className="hidden md:block col-span-2 text-right font-mono text-sm">{formatCurrency(row.totalRealizedReturn)}</div>
                  <div className={cn("hidden md:block col-span-2 text-right font-mono font-bold text-sm", row.totalNetReturn >= 0 ? "text-green-600" : "text-red-600")}>
                    {row.totalNetReturn >= 0 ? "+" : ""}{formatCurrency(row.totalNetReturn)}
                  </div>
                  <div className={cn("hidden md:block col-span-1 text-right font-mono text-xs", row.totalMtm >= 0 ? "text-green-600" : "text-red-500")}>
                    {row.totalMtm >= 0 ? "+" : ""}{formatCurrency(row.totalMtm)}
                  </div>
                </>
              ) : (
                <div className={cn("hidden md:block col-span-4 text-right font-mono font-bold text-sm", row.totalMtm >= 0 ? "text-green-600" : "text-red-600")}>
                  {row.totalMtm !== 0 ? (row.totalMtm >= 0 ? "+" : "") + formatCurrency(row.totalMtm) : "—"}
                </div>
              )}
              <div className="col-span-1 flex justify-end text-muted-foreground">
                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </div>
            </button>

            {/* Mobile stats */}
            {isComplete && (
              <div className="md:hidden grid grid-cols-3 text-xs font-mono border-t border-border bg-muted/30 px-4 py-2">
                <div>
                  <div className="text-muted-foreground uppercase tracking-widest text-[10px]">Return</div>
                  <div>{formatCurrency(row.totalRealizedReturn)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground uppercase tracking-widest text-[10px]">Net P&L</div>
                  <div className={row.totalNetReturn >= 0 ? "text-green-600" : "text-red-600"}>
                    {row.totalNetReturn >= 0 ? "+" : ""}{formatCurrency(row.totalNetReturn)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground uppercase tracking-widest text-[10px]">MTM</div>
                  <div className={row.totalMtm >= 0 ? "text-green-600" : "text-red-500"}>
                    {row.totalMtm >= 0 ? "+" : ""}{formatCurrency(row.totalMtm)}
                  </div>
                </div>
              </div>
            )}

            {/* Expanded team list */}
            {isExpanded && (
              <div className="border-t border-border">
                <div className="hidden md:grid grid-cols-12 bg-muted/30 text-muted-foreground text-[10px] font-mono font-bold uppercase tracking-widest px-6 py-2 border-b border-border">
                  <div className="col-span-4">Team</div>
                  <div className="col-span-1 text-center">W</div>
                  <div className="col-span-1 text-center">PD</div>
                  <div className="col-span-1 text-center">PO</div>
                  <div className="col-span-1 text-center">SB</div>
                  <div className="col-span-2 text-right">Return</div>
                  <div className="col-span-2 text-right">Net P&L</div>
                </div>
                {row.teams.map((t) => (
                  <TeamSubRow key={t.teamId} team={t} isComplete={isComplete} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TeamSubRow({ team, isComplete }: { team: TeamResultRow; isComplete: boolean }) {
  const hasSB = team.sbBerth;
  const wonSB = team.winSuperBowl;
  return (
    <div className="grid grid-cols-6 md:grid-cols-12 items-center px-6 py-3 border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
      <div className="col-span-3 md:col-span-4 flex items-center gap-2">
        {wonSB && <Star className="w-3 h-3 text-yellow-500 shrink-0" />}
        {hasSB && !wonSB && <span className="text-[10px] text-muted-foreground">SB</span>}
        <span className="font-medium text-sm truncate">{team.teamName}</span>
        <span className="hidden md:inline text-[10px] text-muted-foreground font-mono">{team.conference}</span>
      </div>
      {isComplete ? (
        <>
          <div className="col-span-1 text-center font-mono text-sm">{team.wins}</div>
          <div className={cn("hidden md:block col-span-1 text-center font-mono text-xs", team.ptDiff >= 0 ? "text-green-600" : "text-red-500")}>
            {team.ptDiff >= 0 ? "+" : ""}{team.ptDiff}
          </div>
          <div className="col-span-1 text-center text-xs">{team.playoffBerth ? "✓" : "–"}</div>
          <div className="col-span-1 text-center text-xs">
            {team.winSuperBowl ? "🏆" : team.sbBerth ? "🔹" : "–"}
          </div>
          <div className="col-span-2 text-right font-mono text-sm">{formatCurrency(team.realizedReturn)}</div>
          <div className={cn("col-span-2 text-right font-mono font-bold text-sm", team.netReturn >= 0 ? "text-green-600" : "text-red-600")}>
            {team.netReturn >= 0 ? "+" : ""}{formatCurrency(team.netReturn)}
          </div>
        </>
      ) : (
        <>
          <div className="col-span-2 text-right font-mono text-sm text-muted-foreground">{formatCurrency(team.cost)}</div>
          <div className="col-span-1 text-right font-mono text-xs text-muted-foreground">
            {team.owners.map((o) => o.bidderName).join(" / ")}
          </div>
        </>
      )}
    </div>
  );
}

// ─── By Team ─────────────────────────────────────────────────────────────────

type SortKey = "name" | "cost" | "wins" | "ptDiff" | "realizedReturn" | "netReturn" | "markToMarket";

function ByTeamView({ rows, isComplete }: { rows: TeamResultRow[]; isComplete: boolean }) {
  const [sortKey, setSortKey] = useState<SortKey>(isComplete ? "netReturn" : "cost");
  const [sortAsc, setSortAsc] = useState(false);
  const [conference, setConference] = useState<"ALL" | "AFC" | "NFC">("ALL");

  const filtered = rows.filter((r) => conference === "ALL" || r.conference === conference);

  const sorted = [...filtered].sort((a, b) => {
    let diff = 0;
    if (sortKey === "name") diff = a.teamName.localeCompare(b.teamName);
    else if (sortKey === "cost") diff = a.cost - b.cost;
    else if (sortKey === "wins") diff = a.wins - b.wins;
    else if (sortKey === "ptDiff") diff = a.ptDiff - b.ptDiff;
    else if (sortKey === "realizedReturn") diff = a.realizedReturn - b.realizedReturn;
    else if (sortKey === "netReturn") diff = a.netReturn - b.netReturn;
    else if (sortKey === "markToMarket") diff = a.markToMarket - b.markToMarket;
    return sortAsc ? diff : -diff;
  });

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  }

  function SortHeader({ label, k }: { label: string; k: SortKey }) {
    const active = sortKey === k;
    return (
      <button
        onClick={() => handleSort(k)}
        className={cn("font-mono font-bold uppercase tracking-widest text-xs text-right hover:text-foreground transition-colors", active ? "text-primary" : "text-muted-foreground")}
      >
        {label}{active ? (sortAsc ? " ↑" : " ↓") : ""}
      </button>
    );
  }

  if (!rows.length) return <Empty />;

  return (
    <div className="space-y-4">
      {/* Conference filter */}
      <div className="flex gap-0 border border-border bg-card overflow-hidden w-fit">
        {(["ALL", "AFC", "NFC"] as const).map((c) => (
          <button
            key={c}
            onClick={() => setConference(c)}
            className={cn(
              "px-4 py-1.5 text-xs font-mono font-bold uppercase tracking-widest transition-colors border-r border-border last:border-r-0",
              conference === c ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/60">
              <th className="px-4 py-3 text-left">
                <button onClick={() => handleSort("name")} className={cn("font-mono font-bold uppercase tracking-widest text-xs hover:text-foreground transition-colors", sortKey === "name" ? "text-primary" : "text-muted-foreground")}>
                  Team{sortKey === "name" ? (sortAsc ? " ↑" : " ↓") : ""}
                </button>
              </th>
              <th className="px-3 py-3 text-left hidden lg:table-cell">
                <span className="font-mono font-bold uppercase tracking-widest text-xs text-muted-foreground">Div</span>
              </th>
              <th className="px-3 py-3 text-left">
                <span className="font-mono font-bold uppercase tracking-widest text-xs text-muted-foreground">Owner(s)</span>
              </th>
              <th className="px-3 py-3 text-right">
                <SortHeader label="Cost" k="cost" />
              </th>
              {isComplete && (
                <>
                  <th className="px-3 py-3 text-right hidden md:table-cell"><SortHeader label="W" k="wins" /></th>
                  <th className="px-3 py-3 text-right hidden md:table-cell"><SortHeader label="PD" k="ptDiff" /></th>
                  <th className="px-3 py-3 text-center hidden lg:table-cell">
                    <span className="font-mono font-bold uppercase tracking-widest text-xs text-muted-foreground">PO/DR/CR/SB/WC</span>
                  </th>
                  <th className="px-3 py-3 text-right hidden md:table-cell"><SortHeader label="Return" k="realizedReturn" /></th>
                  <th className="px-3 py-3 text-right"><SortHeader label="Net P&L" k="netReturn" /></th>
                  <th className="px-3 py-3 text-right hidden lg:table-cell"><SortHeader label="MTM" k="markToMarket" /></th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.teamId}
                className={cn(
                  "border-b border-border last:border-0 hover:bg-muted/30 transition-colors",
                  row.winSuperBowl && "bg-yellow-50/50 dark:bg-yellow-900/10",
                )}
              >
                <td className="px-4 py-3 font-medium">
                  <div className="flex items-center gap-1.5">
                    {row.winSuperBowl && <Trophy className="w-3 h-3 text-yellow-500 shrink-0" />}
                    {row.teamName}
                    <span className={cn("hidden md:inline text-[10px] font-mono px-1 py-0.5 rounded-sm", row.conference === "AFC" ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300")}>
                      {row.conference}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-3 text-muted-foreground font-mono text-xs hidden lg:table-cell">{row.division}</td>
                <td className="px-3 py-3 text-sm text-muted-foreground max-w-[140px] truncate">
                  {row.owners.map((o) => o.bidderName.split(" ")[0]).join(" / ")}
                </td>
                <td className="px-3 py-3 text-right font-mono text-sm">{formatCurrency(row.cost)}</td>
                {isComplete && (
                  <>
                    <td className="px-3 py-3 text-right font-mono text-sm hidden md:table-cell">{row.wins}</td>
                    <td className={cn("px-3 py-3 text-right font-mono text-xs hidden md:table-cell", row.ptDiff >= 0 ? "text-green-600" : "text-red-500")}>
                      {row.ptDiff >= 0 ? "+" : ""}{row.ptDiff}
                    </td>
                    <td className="px-3 py-3 text-center font-mono text-xs hidden lg:table-cell">
                      <PlayoffBar row={row} />
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-sm hidden md:table-cell">{formatCurrency(row.realizedReturn)}</td>
                    <td className={cn("px-3 py-3 text-right font-mono font-bold text-sm", row.netReturn >= 0 ? "text-green-600" : "text-red-600")}>
                      {row.netReturn >= 0 ? "+" : ""}{formatCurrency(row.netReturn)}
                    </td>
                    <td className={cn("px-3 py-3 text-right font-mono text-xs hidden lg:table-cell", row.markToMarket >= 0 ? "text-green-600" : "text-red-500")}>
                      {row.markToMarket >= 0 ? "+" : ""}{formatCurrency(row.markToMarket)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground font-mono">
        {sorted.length} teams · PO=$50 · DR=$100 · CR=$200 · SB Berth=$400 · Win SB=$800
      </p>
    </div>
  );
}

function PlayoffBar({ row }: { row: TeamResultRow }) {
  const rounds = [
    { label: "PO", active: row.playoffBerth },
    { label: "DR", active: row.divRound },
    { label: "CR", active: row.confRound },
    { label: "SB", active: row.sbBerth },
    { label: "WC", active: row.winSuperBowl },
  ];
  return (
    <div className="flex items-center gap-0.5">
      {rounds.map((r) => (
        <span
          key={r.label}
          className={cn("px-1 py-0.5 rounded-sm text-[10px] font-mono", r.active ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 font-bold" : "bg-muted text-muted-foreground")}
        >
          {r.label}
        </span>
      ))}
    </div>
  );
}

function Empty() {
  return (
    <div className="border border-dashed border-border rounded-none flex flex-col items-center justify-center py-24 text-center">
      <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">No results for this season yet</p>
      <p className="text-xs text-muted-foreground mt-2">Results will appear here once the season data is entered</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="h-16 bg-muted border border-border" />
      ))}
    </div>
  );
}
