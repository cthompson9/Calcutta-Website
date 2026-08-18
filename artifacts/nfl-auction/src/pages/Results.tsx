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
import { ChevronDown, ChevronRight, Trophy, Star } from "lucide-react";

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
        {isComplete ? (
          <>
            <div className="col-span-2 text-right">Cost</div>
            <div className="col-span-2 text-right">Gross</div>
            <div className="col-span-3 text-right font-bold text-foreground">Net</div>
          </>
        ) : (
          <>
            <div className="col-span-3 text-right font-bold text-foreground">MTM Return</div>
            <div className="col-span-2 text-right">Cost</div>
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
              {isComplete ? (
                <>
                  {/* Cost — leftmost */}
                  <div className="hidden md:block col-span-2 text-right font-mono text-sm text-muted-foreground">{formatCurrency(row.totalCost)}</div>
                  {/* Gross return */}
                  <div className="hidden md:block col-span-2 text-right font-mono text-sm text-muted-foreground">{formatCurrency(row.totalRealizedReturn)}</div>
                  {/* Net — primary sort key, highlighted */}
                  <div className={cn("col-span-1 md:col-span-3 text-right font-mono font-bold text-sm", row.totalNetReturn >= 0 ? "text-green-600" : "text-red-600")}>
                    {row.totalNetReturn >= 0 ? "+" : ""}{formatCurrency(row.totalNetReturn)}
                  </div>
                </>
              ) : (
                <>
                  {/* MTM Return — primary / sort key */}
                  <div className={cn("col-span-2 md:col-span-3 text-right font-mono font-bold text-sm", row.totalMtm >= 0 ? "text-green-600" : "text-red-600")}>
                    {row.totalMtm !== 0 ? (row.totalMtm >= 0 ? "+" : "") + formatCurrency(row.totalMtm) : "—"}
                  </div>
                  <div className="hidden md:block col-span-2 text-right font-mono text-sm text-muted-foreground">{formatCurrency(row.totalCost)}</div>
                </>
              )}
              <div className="col-span-1 flex justify-end text-muted-foreground">
                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </div>
            </button>

            {/* Mobile stats */}
            {isComplete && (
              <div className="md:hidden grid grid-cols-3 text-xs font-mono border-t border-border bg-muted/30 px-4 py-2">
                <div>
                  <div className="text-muted-foreground uppercase tracking-widest text-[10px]">Cost</div>
                  <div>{formatCurrency(row.totalCost)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground uppercase tracking-widest text-[10px]">Gross</div>
                  <div>{formatCurrency(row.totalRealizedReturn)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground uppercase tracking-widest text-[10px]">Net</div>
                  <div className={row.totalNetReturn >= 0 ? "text-green-600" : "text-red-600"}>
                    {row.totalNetReturn >= 0 ? "+" : ""}{formatCurrency(row.totalNetReturn)}
                  </div>
                </div>
              </div>
            )}

            {/* Expanded team list */}
            {isExpanded && (
              <div className="border-t border-border">
                <div className="hidden md:grid grid-cols-12 bg-muted/30 text-muted-foreground text-[10px] font-mono font-bold uppercase tracking-widest px-6 py-2 border-b border-border">
                  <div className="col-span-3">Team</div>
                  <div className="col-span-2 text-center">Record</div>
                  <div className="col-span-1 text-center">PD</div>
                  <div className="col-span-1 text-center">PO</div>
                  <div className="col-span-1 text-center">SB</div>
                  <div className="col-span-2 text-right">Return</div>
                  <div className="col-span-2 text-right">Net P&L</div>
                </div>
                {[...row.teams]
                  .sort((a, b) => b.markToMarket - a.markToMarket)
                  .map((t) => (
                    <TeamSubRow key={t.teamId} team={t} isComplete={isComplete} ownerId={row.bidderId} />
                  ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatRecord(wins: number): string {
  const w = Math.floor(wins);
  const ties = Math.round((wins - w) * 2); // 0.5 stored per tie
  const l = 17 - w - ties;
  return ties > 0 ? `${w}-${l}-${ties}` : `${w}-${l}`;
}

function TeamSubRow({
  team,
  isComplete,
  ownerId,
}: {
  team: TeamResultRow;
  isComplete: boolean;
  ownerId: number;
}) {
  const hasSB = team.sbBerth;
  const wonSB = team.winSuperBowl;
  const ownerEntry = team.owners.find((o) => o.bidderId === ownerId);
  const pct = ownerEntry ? Math.round(ownerEntry.ownershipShare * 100) : 100;

  return (
    <div className="grid grid-cols-6 md:grid-cols-12 items-center px-6 py-3 border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
      <div className="col-span-3 md:col-span-3 flex items-center gap-2 min-w-0">
        {wonSB && <Star className="w-3 h-3 text-yellow-500 shrink-0" />}
        {hasSB && !wonSB && <span className="text-[10px] text-muted-foreground shrink-0">SB</span>}
        <span className="font-medium text-sm truncate">{team.teamName}</span>
        <span className="hidden md:inline text-[10px] text-muted-foreground font-mono shrink-0">{team.conference}</span>
        {pct < 100 && (
          <span className="shrink-0 text-[10px] font-mono bg-muted px-1 py-0.5 text-muted-foreground">{pct}%</span>
        )}
      </div>
      {isComplete ? (
        <>
          <div className="col-span-1 md:col-span-2 text-center font-mono text-xs">{formatRecord(team.wins)}</div>
          <div className={cn("hidden md:block col-span-1 text-center font-mono text-xs", team.ptDiff >= 0 ? "text-green-600" : "text-red-500")}>
            {team.ptDiff >= 0 ? "+" : ""}{team.ptDiff}
          </div>
          <div className="hidden md:block col-span-1 text-center text-xs">{team.playoffBerth ? "✓" : "–"}</div>
          <div className="hidden md:block col-span-1 text-center text-xs">
            {team.winSuperBowl ? "🏆" : team.sbBerth ? "🔹" : "–"}
          </div>
          <div className="hidden md:block col-span-2 text-right font-mono text-sm">{formatCurrency(team.realizedReturn)}</div>
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

type ExpandedTeamRow = {
  // identity
  teamId: number;
  teamName: string;
  conference: string;
  division: string;
  seed: number | null;
  // ownership
  bidderId: number;
  ownerName: string;
  pct: number; // 1–100
  // NFL stats (team-level, not scaled)
  wins: number;
  ptDiff: number;
  playoffBerth: boolean;
  sbBerth: boolean;
  winSuperBowl: boolean;
  // financials (scaled by ownership share)
  cost: number;
  gross: number;
  net: number;
  mtm: number;
};

type BTSortKey = keyof Pick<
  ExpandedTeamRow,
  "ownerName" | "teamName" | "conference" | "division" | "seed" | "pct" |
  "wins" | "ptDiff" | "cost" | "gross" | "net" | "mtm"
>;

/**
 * Compute playoff seeds per conference.
 * Division winners (best record in each division that made playoffs) → seeds 1-4,
 * sorted by wins desc then ptDiff desc.
 * Wild cards → seeds 5-7, same sort.
 * Non-playoff teams → null.
 */
function computeSeeds(rows: TeamResultRow[]): Map<number, number | null> {
  const map = new Map<number, number | null>();
  const byRecord = (a: TeamResultRow, b: TeamResultRow) =>
    a.wins !== b.wins ? b.wins - a.wins : b.ptDiff - a.ptDiff;

  for (const conf of ["AFC", "NFC"]) {
    const confTeams = rows.filter((t) => t.conference === conf);
    const playoff = confTeams.filter((t) => t.playoffBerth);

    // Division winner = best-record team per division that made the playoffs
    const bestInDiv = new Map<string, TeamResultRow>();
    for (const t of confTeams) {
      const cur = bestInDiv.get(t.division);
      if (!cur || byRecord(t, cur) < 0) bestInDiv.set(t.division, t);
    }
    const divWinnerIds = new Set(
      [...bestInDiv.values()].filter((t) => t.playoffBerth).map((t) => t.teamId),
    );

    const divWinners = [...playoff.filter((t) => divWinnerIds.has(t.teamId))].sort(byRecord);
    const wildCards = [...playoff.filter((t) => !divWinnerIds.has(t.teamId))].sort(byRecord);

    divWinners.forEach((t, i) => map.set(t.teamId, i + 1));
    wildCards.forEach((t, i) => map.set(t.teamId, i + 5));
    confTeams.filter((t) => !t.playoffBerth).forEach((t) => map.set(t.teamId, null));
  }
  return map;
}

function expandTeams(rows: TeamResultRow[], seeds: Map<number, number | null>): ExpandedTeamRow[] {
  const result: ExpandedTeamRow[] = [];
  for (const team of rows) {
    for (const owner of team.owners) {
      const s = owner.ownershipShare;
      result.push({
        teamId: team.teamId,
        teamName: team.teamName,
        conference: team.conference,
        division: team.division,
        seed: seeds.get(team.teamId) ?? null,
        bidderId: owner.bidderId,
        ownerName: owner.bidderName,
        pct: Math.round(s * 100),
        wins: team.wins,
        ptDiff: team.ptDiff,
        playoffBerth: team.playoffBerth,
        sbBerth: team.sbBerth,
        winSuperBowl: team.winSuperBowl,
        cost: Math.round(team.cost * s * 100) / 100,
        gross: Math.round(team.realizedReturn * s * 100) / 100,
        net: Math.round(team.netReturn * s * 100) / 100,
        mtm: Math.round(team.markToMarket * s * 100) / 100,
      });
    }
  }
  return result;
}

function ByTeamView({ rows, isComplete }: { rows: TeamResultRow[]; isComplete: boolean }) {
  const [sortKey, setSortKey] = useState<BTSortKey>(isComplete ? "net" : "mtm");
  const [sortAsc, setSortAsc] = useState(false);
  const [search, setSearch] = useState("");

  if (!rows.length) return <Empty />;

  const seeds = computeSeeds(rows);
  const expanded = expandTeams(rows, seeds);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? expanded.filter(
        (r) =>
          r.teamName.toLowerCase().includes(q) ||
          r.ownerName.toLowerCase().includes(q) ||
          r.conference.toLowerCase().includes(q) ||
          r.division.toLowerCase().includes(q),
      )
    : expanded;

  const sorted = [...filtered].sort((a, b) => {
    let diff = 0;
    if (sortKey === "ownerName") diff = a.ownerName.localeCompare(b.ownerName);
    else if (sortKey === "teamName") diff = a.teamName.localeCompare(b.teamName);
    else if (sortKey === "conference") diff = a.conference.localeCompare(b.conference) || (a.division ?? "").localeCompare(b.division ?? "");
    else if (sortKey === "division") diff = a.division.localeCompare(b.division);
    else if (sortKey === "seed") {
      // nulls to bottom
      if (a.seed === null && b.seed === null) diff = 0;
      else if (a.seed === null) diff = 1;
      else if (b.seed === null) diff = -1;
      else diff = a.seed - b.seed;
    }
    else if (sortKey === "pct") diff = a.pct - b.pct;
    else if (sortKey === "wins") diff = a.wins - b.wins;
    else if (sortKey === "ptDiff") diff = a.ptDiff - b.ptDiff;
    else if (sortKey === "cost") diff = a.cost - b.cost;
    else if (sortKey === "gross") diff = a.gross - b.gross;
    else if (sortKey === "net") diff = a.net - b.net;
    else if (sortKey === "mtm") diff = a.mtm - b.mtm;
    // For seed ascending = best first (1 before 7), so flip default direction
    return sortKey === "seed" ? (sortAsc ? diff : diff) : (sortAsc ? diff : -diff);
  });

  function handleSort(key: BTSortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      // seed: default ascending (1 = best); all others: default descending
      setSortAsc(key === "seed" ? true : false);
    }
  }

  function SH({ label, k, className }: { label: string; k: BTSortKey; className?: string }) {
    const active = sortKey === k;
    return (
      <button
        onClick={() => handleSort(k)}
        className={cn(
          "font-mono font-bold uppercase tracking-widest text-xs whitespace-nowrap hover:text-foreground transition-colors",
          active ? "text-primary" : "text-muted-foreground",
          className,
        )}
      >
        {label}
        {active ? (sortAsc ? " ↑" : " ↓") : ""}
      </button>
    );
  }

  return (
    <div className="space-y-3">
      {/* Search */}
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Filter by owner, team, conference, division…"
        className="w-full md:w-80 border border-border bg-background px-3 py-1.5 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
      />

      {/* Table — horizontally scrollable */}
      <div className="border border-border bg-card overflow-x-auto">
        <table className="text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b border-border bg-muted/60">
              <th className="px-3 py-2.5 text-left sticky left-0 bg-muted/60 z-10">
                <SH label="Owner" k="ownerName" className="text-left" />
              </th>
              <th className="px-3 py-2.5 text-left"><SH label="Team" k="teamName" className="text-left" /></th>
              <th className="px-3 py-2.5 text-center"><SH label="Conf" k="conference" /></th>
              <th className="px-3 py-2.5 text-left"><SH label="Div" k="division" className="text-left" /></th>
              <th className="px-3 py-2.5 text-center"><SH label="#" k="seed" /></th>
              <th className="px-3 py-2.5 text-center"><SH label="%" k="pct" /></th>
              <th className="px-3 py-2.5 text-center"><SH label="Record" k="wins" /></th>
              <th className="px-3 py-2.5 text-right"><SH label="Net Diff" k="ptDiff" /></th>
              <th className="px-3 py-2.5 text-right"><SH label="Cost" k="cost" /></th>
              <th className="px-3 py-2.5 text-right"><SH label="Gross" k="gross" /></th>
              <th className="px-3 py-2.5 text-right font-bold text-foreground"><SH label="Net" k="net" /></th>
              <th className="px-3 py-2.5 text-right font-bold text-foreground"><SH label="MTM" k="mtm" /></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr
                key={`${row.teamId}-${row.bidderId}`}
                className={cn(
                  "border-b border-border last:border-0 hover:bg-muted/30 transition-colors",
                  row.winSuperBowl && "bg-yellow-50/40 dark:bg-yellow-900/10",
                )}
              >
                {/* Owner — sticky */}
                <td className="px-3 py-2.5 font-medium sticky left-0 bg-card z-10 border-r border-border/50">
                  {row.ownerName.split(" ")[0]}
                </td>
                {/* Team */}
                <td className="px-3 py-2.5 font-medium">
                  <div className="flex items-center gap-1.5">
                    {row.winSuperBowl && (
                      <img src="/sleigh-monkey.png" alt="🏆" className="w-4 h-4 object-contain shrink-0" />
                    )}
                    {row.teamName}
                  </div>
                </td>
                {/* Conf */}
                <td className="px-3 py-2.5 text-center">
                  <span className={cn(
                    "text-[10px] font-mono font-bold px-1.5 py-0.5",
                    row.conference === "AFC"
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                      : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
                  )}>
                    {row.conference}
                  </span>
                </td>
                {/* Div */}
                <td className="px-3 py-2.5 text-muted-foreground font-mono text-xs">{row.division}</td>
                {/* Seed */}
                <td className="px-3 py-2.5 text-center font-mono text-sm">
                  {row.seed !== null ? (
                    <span className={cn(
                      "font-bold",
                      row.seed <= 2 ? "text-yellow-600" : row.seed <= 4 ? "text-foreground" : "text-muted-foreground",
                    )}>
                      {row.seed}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>
                {/* % ownership */}
                <td className="px-3 py-2.5 text-center font-mono text-xs text-muted-foreground">
                  {row.pct}%
                </td>
                {/* Record */}
                <td className="px-3 py-2.5 text-center font-mono text-xs">{formatRecord(row.wins)}</td>
                {/* Net Diff */}
                <td className={cn("px-3 py-2.5 text-right font-mono text-xs", row.ptDiff >= 0 ? "text-green-600" : "text-red-500")}>
                  {row.ptDiff >= 0 ? "+" : ""}{row.ptDiff}
                </td>
                {/* Cost */}
                <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                  {formatCurrency(row.cost)}
                </td>
                {/* Gross */}
                <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                  {isComplete ? formatCurrency(row.gross) : "—"}
                </td>
                {/* Net */}
                <td className={cn("px-3 py-2.5 text-right font-mono font-bold text-sm", row.net >= 0 ? "text-green-600" : "text-red-600")}>
                  {isComplete ? (row.net >= 0 ? "+" : "") + formatCurrency(row.net) : "—"}
                </td>
                {/* MTM */}
                <td className={cn("px-3 py-2.5 text-right font-mono font-bold text-sm", row.mtm >= 0 ? "text-green-600" : "text-red-600")}>
                  {row.mtm !== 0 ? (row.mtm >= 0 ? "+" : "") + formatCurrency(row.mtm) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground font-mono">
        {sorted.length} rows · {isComplete ? "PO=$50 · DR=$100 · CR=$200 · SB Berth=$400 · Win SB=$800" : "financials scale to ownership %"}
      </p>
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
