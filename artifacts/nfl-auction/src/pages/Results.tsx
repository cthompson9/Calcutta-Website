import { useState } from "react";
import {
  useGetResults,
  useGetResultsByOwner,
  useGetBidders,
  useGetSportPeriods,
} from "@workspace/api-client-react";
import type {
  OwnershipSegment,
  TeamResultRow,
  OwnerResultRow,
} from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useSeason } from "@/hooks/useSeason";
import { ChevronDown, Trophy, Star } from "lucide-react";
import { bidderConsortiums, ownerLabelById } from "@/lib/ownerDisplay";
import { ConsortiumLabel } from "@/components/ConsortiumLabel";

type TabId = "byTeam" | "byOwner";

export default function Results() {
  const { year, selectedSeason } = useSeason();
  const [tab, setTab] = useState<TabId>("byOwner");
  const [expandedOwner, setExpandedOwner] = useState<number | null>(null);
  const [period, setPeriod] = useState<number | undefined>(undefined);
  const [basis, setBasis] = useState<"realized" | "mtm">("mtm");
  const { data: periods } = useGetSportPeriods({ sport: "NFL" });

  const { data: teamResults, isLoading: loadingTeams } = useGetResults({
    season: year,
    period,
    basis,
  });
  const { data: ownerResults, isLoading: loadingOwners } = useGetResultsByOwner(
    { season: year, period, basis },
  );
  const { data: bidders } = useGetBidders({});
  const consortiumByBidderId = bidderConsortiums(bidders);

  const isLoading = loadingTeams || loadingOwners;
  const isComplete = basis === "realized";
  const selectedPeriodLabel = period == null
    ? "latest available period"
    : periods?.find((item) => item.sequence === period)?.label ?? `Period ${period}`;

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <header>
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-1">
            Calcutta Returns
          </h1>
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
            {basis === "mtm" ? "Mark-to-market" : "Realized returns"} · {selectedPeriodLabel} · {year} season
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
          Through period
          <select
            value={period ?? ""}
            onChange={(event) => setPeriod(event.target.value === "" ? undefined : Number(event.target.value))}
            className="rounded border border-input bg-background px-2 py-1.5 text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">Latest available</option>
            {(periods ?? []).map((item) => (
              <option key={item.sequence} value={item.sequence}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex rounded-md border border-input p-0.5">
          {(["mtm", "realized"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setBasis(value)}
              className={cn(
                "rounded px-3 py-1.5 text-xs font-mono font-bold uppercase tracking-widest",
                basis === value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value === "mtm" ? "Mark to market" : "Realized"}
            </button>
          ))}
        </div>
      </div>

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
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "byOwner" ? "By Consortium" : "By Team"}
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
          consortiumByBidderId={consortiumByBidderId}
        />
      ) : (
        <ByTeamView
          rows={teamResults ?? []}
          isComplete={isComplete}
          consortiumByBidderId={consortiumByBidderId}
        />
      )}
    </div>
  );
}

// ─── By Owner ────────────────────────────────────────────────────────────────

/**
 * Exposure treats long and short team positions as separate risk amounts.
 * `team.cost` is signed by the trade ledger: long positions are positive and
 * short positions are negative, so a short cost is subtracted from exposure.
 */
function calculateExposure(row: OwnerResultRow): number {
  const exposure = row.teams.reduce((total, team) => {
    const position = team.owners.find(
      (owner) => owner.bidderId === row.bidderId,
    )?.ownershipShare ?? 0;

    // A fully closed position can retain a cash-only cost basis, but it has no
    // remaining team exposure.
    if (Math.abs(position) < 0.00005) return total;

    const longCost = position > 0 ? team.cost : 0;
    const shortCost = position < 0 ? team.cost : 0;
    return total + longCost - shortCost;
  }, 0);

  return Math.round(exposure * 100) / 100;
}

function calculateTeamExposure(team: TeamResultRow): number {
  const position = team.owners[0]?.ownershipShare ?? 0;
  if (Math.abs(position) < 0.00005) return 0;

  const exposure = position > 0 ? team.cost : -team.cost;
  return Math.round(exposure * 100) / 100;
}

const OWNER_SUMMARY_GRID =
  "grid-cols-[2.5rem_minmax(0,1fr)_4.5rem_7rem_2.5rem] md:grid-cols-[2.5rem_minmax(14rem,22rem)_minmax(0,1fr)_4.5rem_8rem_8rem_2.5rem]";
const OWNER_SUMMARY_COMPLETE_GRID =
  "grid-cols-[2.5rem_minmax(0,1fr)_4.5rem_7rem_2.5rem] md:grid-cols-[2.5rem_minmax(14rem,22rem)_minmax(0,1fr)_4.5rem_8rem_8rem_8rem_2.5rem]";
const OWNER_TEAM_GRID =
  "grid-cols-[minmax(0,1fr)_minmax(7rem,auto)] md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_8rem_8rem]";

function ByOwnerView({
  rows,
  isComplete,
  expandedOwner,
  setExpandedOwner,
  consortiumByBidderId,
}: {
  rows: OwnerResultRow[];
  isComplete: boolean;
  expandedOwner: number | null;
  setExpandedOwner: (id: number | null) => void;
  consortiumByBidderId: Map<number, string>;
}) {
  if (!rows.length) return <Empty />;

  // Always sort by MTM net return — that's the live standing metric
  const sorted = [...rows].sort((a, b) =>
    isComplete ? b.totalNetReturn - a.totalNetReturn : b.totalMtm - a.totalMtm,
  );

  return (
    <div className="space-y-3">
      {/* Summary header */}
      <div
        className={cn(
          "hidden md:grid bg-muted/60 text-muted-foreground text-xs font-mono font-bold uppercase tracking-widest px-4 py-3 border border-border",
          isComplete ? OWNER_SUMMARY_COMPLETE_GRID : OWNER_SUMMARY_GRID,
        )}
      >
        <div className="text-left">#</div>
        <div>Consortium</div>
        <div className="hidden md:block" />
        <div className="text-right">Teams</div>
        {isComplete ? (
          <>
            <div className="text-right">Exposure</div>
            <div className="text-right">Gross</div>
            <div className="text-right font-bold text-foreground">Net</div>
          </>
        ) : (
          <>
            <div className="text-right font-bold text-foreground">MTM Return</div>
            <div className="text-right">Exposure</div>
          </>
        )}
        <div />
      </div>

      {sorted.map((row, idx) => {
        const isExpanded = expandedOwner === row.bidderId;
        const isLeader = idx === 0;
        const isWinner = isLeader && isComplete && row.totalNetReturn > 0;
        return (
          <div
            key={row.bidderId}
            className="border border-border bg-card overflow-hidden"
          >
            {/* Owner row */}
            <button
              type="button"
              onClick={() => setExpandedOwner(isExpanded ? null : row.bidderId)}
              aria-expanded={isExpanded}
              className={cn(
                "w-full grid items-center px-4 py-4 hover:bg-muted/40 transition-colors text-left",
                isComplete ? OWNER_SUMMARY_COMPLETE_GRID : OWNER_SUMMARY_GRID,
                isWinner && "bg-yellow-50 dark:bg-yellow-900/10",
              )}
            >
              <div className="flex items-center gap-1 font-mono font-bold text-lg">
                <span>{idx + 1}</span>
                {isLeader && (
                  <img
                    src="/sleigh-monkey.png"
                    alt="leader"
                    className="w-6 h-6 object-contain shrink-0"
                  />
                )}
              </div>
              <div className="min-w-0 font-bold">
                <ConsortiumLabel
                  label={
                    row.consortium ??
                    ownerLabelById(
                      row.bidderId,
                      row.bidderName,
                      consortiumByBidderId,
                    )
                  }
                />
              </div>
              <div className="hidden md:block" />
              <div className="text-right text-muted-foreground font-mono">
                {row.teamCount.toFixed(2)}
              </div>
              {isComplete ? (
                <>
                  {/* Exposure — net long cost minus signed short cost */}
                  <div className="hidden md:block text-right font-mono text-sm text-muted-foreground">
                    {formatCurrency(calculateExposure(row))}
                  </div>
                  {/* Gross return */}
                  <div className="hidden md:block text-right font-mono text-sm text-muted-foreground">
                    {formatCurrency(row.totalRealizedReturn)}
                  </div>
                  {/* Net — primary sort key, highlighted */}
                  <div
                    className={cn(
                      "text-right font-mono font-bold text-sm",
                      row.totalNetReturn >= 0
                        ? "text-green-600"
                        : "text-red-600",
                    )}
                  >
                    {row.totalNetReturn >= 0 ? "+" : ""}
                    {formatCurrency(row.totalNetReturn)}
                  </div>
                </>
              ) : (
                <>
                  {/* MTM Return — primary / sort key */}
                  <div
                    className={cn(
                      "text-right font-mono font-bold text-sm",
                      row.totalMtm >= 0 ? "text-green-600" : "text-red-600",
                    )}
                  >
                    {row.totalMtm !== 0
                      ? (row.totalMtm >= 0 ? "+" : "") +
                        formatCurrency(row.totalMtm)
                      : "—"}
                  </div>
                  <div className="hidden md:block text-right font-mono text-sm text-muted-foreground">
                    {formatCurrency(calculateExposure(row))}
                  </div>
                </>
              )}
              <div className="flex justify-end text-muted-foreground">
                <span className="inline-flex h-6 w-6 items-center justify-center border border-border bg-background transition-colors group-hover:border-foreground/40">
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      !isExpanded && "-rotate-90",
                    )}
                  />
                </span>
              </div>
            </button>

            {/* Mobile stats */}
            {isComplete && (
              <div className="md:hidden grid grid-cols-3 text-xs font-mono border-t border-border bg-muted/30 px-4 py-2">
                <div>
                  <div className="text-muted-foreground uppercase tracking-widest text-[10px]">
                      Exposure
                  </div>
                    <div>{formatCurrency(calculateExposure(row))}</div>
                </div>
                <div>
                  <div className="text-muted-foreground uppercase tracking-widest text-[10px]">
                    Gross
                  </div>
                  <div>{formatCurrency(row.totalRealizedReturn)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground uppercase tracking-widest text-[10px]">
                    Net
                  </div>
                  <div
                    className={
                      row.totalNetReturn >= 0
                        ? "text-green-600"
                        : "text-red-600"
                    }
                  >
                    {row.totalNetReturn >= 0 ? "+" : ""}
                    {formatCurrency(row.totalNetReturn)}
                  </div>
                </div>
              </div>
            )}

            {/* Expanded team list */}
            {isExpanded && (
              <div className="border-t border-border">
                <div
                  className={cn(
                    "hidden md:grid bg-muted/30 text-muted-foreground text-[10px] font-mono font-bold uppercase tracking-widest px-6 py-2 border-b border-border",
                    OWNER_TEAM_GRID,
                  )}
                >
                  <div>Team</div>
                  <div>Type</div>
                  <div className="text-right">MTM Return</div>
                  <div className="text-right">Exposure</div>
                </div>
                {[...row.teams]
                  .sort((a, b) => b.markToMarket - a.markToMarket)
                  .map((t) => (
                    <TeamSubRow
                      key={t.teamId}
                      team={t}
                      ownerId={row.bidderId}
                      consortiumByBidderId={consortiumByBidderId}
                    />
                  ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatRecord(wins: number, losses: number, ties: number): string {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function formatOwnershipPercent(share: number, showPlus = false): string {
  const percentage = Math.round(share * 10_000) / 100;
  const sign = showPlus && percentage > 0 ? "+" : "";
  return `${sign}${percentage}%`;
}

function OwnershipBreakdown({
  segments,
  owners,
  consortiumByBidderId,
  showOwner = true,
  compact = false,
}: {
  segments: OwnershipSegment[];
  owners: Array<{
    bidderId: number;
    bidderName: string;
    ownershipShare: number;
  }>;
  consortiumByBidderId: Map<number, string>;
  showOwner?: boolean;
  compact?: boolean;
}) {
  const displaySegments: OwnershipSegment[] =
    segments.length > 0
      ? segments
      : owners.map((owner) => ({ ...owner, source: "primary" }));

  return (
    <div className="space-y-1 whitespace-normal">
      {displaySegments.map((segment, index) => {
        const owner = ownerLabelById(
          segment.bidderId,
          segment.bidderName,
          consortiumByBidderId,
        );
        const counterparty = segment.counterpartyBidderId
          ? ownerLabelById(
              segment.counterpartyBidderId,
              segment.counterpartyBidderName ?? "Unknown",
              consortiumByBidderId,
            )
          : null;
        const isTrade = segment.source === "trade";
        const isAcquisition = segment.tradeDirection === "acquired";
        const sourceLabel = !isTrade
          ? "Primary"
          : compact
            ? "Trade"
            : isAcquisition
              ? `Trade in${counterparty ? ` from ${counterparty}` : ""}`
              : `Trade out${counterparty ? ` to ${counterparty}` : ""}`;

        return (
          <div
            key={`${segment.source}-${segment.tradeId ?? "primary"}-${segment.bidderId}-${index}`}
            className={cn(
              "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border px-2 py-1 text-[11px] font-mono leading-tight",
              !isTrade && "border-border bg-muted/50 text-muted-foreground",
              isTrade &&
                isAcquisition &&
                "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100",
              isTrade &&
                !isAcquisition &&
                "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100",
            )}
          >
            <ConsortiumLabel
              className="min-w-0"
              label={showOwner ? `${sourceLabel} · ${owner}` : sourceLabel}
            />
            <span className="shrink-0 font-bold">
              {formatOwnershipPercent(segment.ownershipShare, isTrade)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TeamSubRow({
  team,
  ownerId,
  consortiumByBidderId,
}: {
  team: TeamResultRow;
  ownerId: number;
  consortiumByBidderId: Map<number, string>;
}) {
  const ownerSegments = team.ownershipSegments.filter(
    (segment) => segment.bidderId === ownerId,
  );
  const ownerEntries = team.owners.filter((owner) => owner.bidderId === ownerId);

  return (
    <div
      className={cn(
        "grid items-center px-6 py-3 border-b border-border last:border-0 hover:bg-muted/20 transition-colors",
        OWNER_TEAM_GRID,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{team.teamName}</span>
          <span className="hidden md:inline text-[10px] text-muted-foreground font-mono shrink-0">
            {team.conference}
          </span>
        </div>
      </div>
      <div className="min-w-0 font-mono text-xs">
        <span className="mr-2 text-[10px] uppercase tracking-widest text-muted-foreground md:hidden">
          Type
        </span>
        <OwnershipBreakdown
          segments={ownerSegments}
          owners={ownerEntries}
          consortiumByBidderId={consortiumByBidderId}
          showOwner={false}
          compact
        />
      </div>
      <div
        className={cn(
          "text-right font-mono text-sm",
          team.markToMarket >= 0 ? "text-green-600" : "text-red-600",
        )}
      >
        <span className="mr-2 text-[10px] uppercase tracking-widest text-muted-foreground md:hidden">
          MTM Return
        </span>
        {team.markToMarket !== 0
          ? (team.markToMarket >= 0 ? "+" : "") +
            formatCurrency(team.markToMarket)
          : "—"}
      </div>
      <div className="text-right font-mono text-sm text-muted-foreground">
        <span className="mr-2 text-[10px] uppercase tracking-widest md:hidden">
          Exposure
        </span>
        {formatCurrency(calculateTeamExposure(team))}
      </div>
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
  ownershipSegments: OwnershipSegment[];
  owners: Array<{
    bidderId: number;
    bidderName: string;
    ownershipShare: number;
  }>;
  // NFL stats (team-level, not scaled)
  wins: number;
  losses: number;
  ties: number;
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

type BTSortKey =
  | "team"
  | "conf"
  | "div"
  | "seed"
  | "owner"
  | "pct"
  | "record"
  | "pd"
  | "cost"
  | "gross"
  | "net"
  | "mtm";

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
      [...bestInDiv.values()]
        .filter((t) => t.playoffBerth)
        .map((t) => t.teamId),
    );

    const divWinners = [
      ...playoff.filter((t) => divWinnerIds.has(t.teamId)),
    ].sort(byRecord);
    const wildCards = [
      ...playoff.filter((t) => !divWinnerIds.has(t.teamId)),
    ].sort(byRecord);

    divWinners.forEach((t, i) => map.set(t.teamId, i + 1));
    wildCards.forEach((t, i) => map.set(t.teamId, i + 5));
    confTeams
      .filter((t) => !t.playoffBerth)
      .forEach((t) => map.set(t.teamId, null));
  }
  return map;
}

function expandTeams(
  rows: TeamResultRow[],
  seeds: Map<number, number | null>,
  consortiumByBidderId: Map<number, string>,
): ExpandedTeamRow[] {
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
        ownerName: ownerLabelById(
          owner.bidderId,
          owner.bidderName,
          consortiumByBidderId,
        ),
        pct: Math.round(s * 100),
        ownershipSegments: team.ownershipSegments.filter(
          (segment) => segment.bidderId === owner.bidderId,
        ),
        owners: [owner],
        wins: team.wins,
        losses: team.losses,
        ties: team.ties,
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

function ByTeamView({
  rows,
  isComplete,
  consortiumByBidderId,
}: {
  rows: TeamResultRow[];
  isComplete: boolean;
  consortiumByBidderId: Map<number, string>;
}) {
  const [splitByOwner, setSplitByOwner] = useState(false);
  const [sortKey, setSortKey] = useState<BTSortKey>(isComplete ? "net" : "mtm");
  const [sortAsc, setSortAsc] = useState(false);
  const [search, setSearch] = useState("");

  if (!rows.length) return <Empty />;

  // Prefer API-stored seeds; fall back to client-computed when all null.
  const computedSeeds = computeSeeds(rows);
  const getSeed = (row: TeamResultRow): number | null =>
    row.seed ?? computedSeeds.get(row.teamId) ?? null;

  function handleSort(key: BTSortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key === "seed");
    }
  }

  function SH({
    label,
    k,
    align = "right",
  }: {
    label: string;
    k: BTSortKey;
    align?: "left" | "center" | "right";
  }) {
    const active = sortKey === k;
    return (
      <button
        onClick={() => handleSort(k)}
        className={cn(
          "font-mono font-bold uppercase tracking-widest text-xs whitespace-nowrap hover:text-foreground transition-colors w-full",
          active ? "text-primary" : "text-muted-foreground",
          align === "left"
            ? "text-left"
            : align === "center"
              ? "text-center"
              : "text-right",
        )}
      >
        {label}
        {active ? (sortAsc ? " ↑" : " ↓") : ""}
      </button>
    );
  }

  function SeedCell({ seed }: { seed: number | null }) {
    if (seed == null)
      return <span className="text-muted-foreground/40">—</span>;
    return (
      <span
        className={cn(
          "font-bold font-mono text-sm",
          seed <= 2
            ? "text-yellow-600"
            : seed <= 4
              ? "text-foreground"
              : "text-muted-foreground",
        )}
      >
        {seed}
      </span>
    );
  }

  function ConfBadge({ conf }: { conf: string }) {
    return (
      <span
        className={cn(
          "text-[10px] font-mono font-bold px-1.5 py-0.5",
          conf === "AFC"
            ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
            : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
        )}
      >
        {conf}
      </span>
    );
  }

  // ── Filter ─────────────────────────────────────────────────────────────────
  const q = search.trim().toLowerCase();
  const baseFiltered = q
    ? rows.filter(
        (r) =>
          r.teamName.toLowerCase().includes(q) ||
          r.conference.toLowerCase().includes(q) ||
          r.division.toLowerCase().includes(q) ||
          r.owners.some(
            (o) =>
              o.bidderName.toLowerCase().includes(q) ||
              ownerLabelById(
                o.bidderId,
                o.bidderName,
                consortiumByBidderId,
              )
                .toLowerCase()
                .includes(q),
          ) ||
          r.ownershipSegments.some(
            (segment) =>
              segment.bidderName.toLowerCase().includes(q) ||
              ownerLabelById(
                segment.bidderId,
                segment.bidderName,
                consortiumByBidderId,
              )
                .toLowerCase()
                .includes(q) ||
              (segment.counterpartyBidderName ?? "").toLowerCase().includes(q) ||
              (segment.counterpartyBidderId
                ? ownerLabelById(
                    segment.counterpartyBidderId,
                    segment.counterpartyBidderName ?? "Unknown",
                    consortiumByBidderId,
                  ).toLowerCase()
                : ""
              ).includes(q),
          ),
      )
    : rows;

  // ── Seed sort helper (nulls always to bottom regardless of direction) ───────
  function seedCmp(a: number | null, b: number | null, asc: boolean): number {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return asc ? a - b : b - a;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEAM MODE — one row per team, owners listed inline
  // ══════════════════════════════════════════════════════════════════════════
  const teamSorted = [...baseFiltered].sort((a, b) => {
    const sa = getSeed(a),
      sb = getSeed(b);
    let diff = 0;
    switch (sortKey) {
      case "team":
        diff = a.teamName.localeCompare(b.teamName);
        break;
      case "conf":
        diff = a.conference.localeCompare(b.conference);
        break;
      case "div":
        diff = a.division.localeCompare(b.division);
        break;
      case "seed":
        return seedCmp(sa, sb, sortAsc);
      case "owner":
        diff = ownerLabelById(
          a.owners[0]?.bidderId ?? 0,
          a.owners[0]?.bidderName ?? "",
          consortiumByBidderId,
        ).localeCompare(
          ownerLabelById(
            b.owners[0]?.bidderId ?? 0,
            b.owners[0]?.bidderName ?? "",
            consortiumByBidderId,
          ),
        );
        break;
      case "record":
        diff = a.wins + a.ties * 0.5 - (b.wins + b.ties * 0.5);
        break;
      case "pd":
        diff = a.ptDiff - b.ptDiff;
        break;
      case "cost":
        diff = a.cost - b.cost;
        break;
      case "gross":
        diff = a.realizedReturn - b.realizedReturn;
        break;
      case "net":
        diff = a.netReturn - b.netReturn;
        break;
      case "mtm":
        diff = a.markToMarket - b.markToMarket;
        break;
      default:
        break;
    }
    return sortAsc ? diff : -diff;
  });

  // ══════════════════════════════════════════════════════════════════════════
  // OWNER MODE — one row per owner-team (expanded)
  // ══════════════════════════════════════════════════════════════════════════
  const expandedSeeds = new Map(
    baseFiltered.map((r) => [
      r.teamId,
      r.seed ?? computedSeeds.get(r.teamId) ?? null,
    ]),
  );
  const expanded = expandTeams(
    baseFiltered,
    expandedSeeds,
    consortiumByBidderId,
  );

  const ownerSorted = [...expanded].sort((a, b) => {
    let diff = 0;
    switch (sortKey) {
      case "team":
        diff = a.teamName.localeCompare(b.teamName);
        break;
      case "conf":
        diff = a.conference.localeCompare(b.conference);
        break;
      case "div":
        diff = a.division.localeCompare(b.division);
        break;
      case "seed":
        return seedCmp(a.seed, b.seed, sortAsc);
      case "owner":
        diff = a.ownerName.localeCompare(b.ownerName);
        break;
      case "pct":
        diff = a.pct - b.pct;
        break;
      case "record":
        diff = a.wins + a.ties * 0.5 - (b.wins + b.ties * 0.5);
        break;
      case "pd":
        diff = a.ptDiff - b.ptDiff;
        break;
      case "cost":
        diff = a.cost - b.cost;
        break;
      case "gross":
        diff = a.gross - b.gross;
        break;
      case "net":
        diff = a.net - b.net;
        break;
      case "mtm":
        diff = a.mtm - b.mtm;
        break;
      default:
        break;
    }
    return sortAsc ? diff : -diff;
  });

  const rowCount = splitByOwner ? ownerSorted.length : teamSorted.length;

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by team, consortium, conference, division…"
          className="w-full min-w-0 md:w-[28rem] md:flex-none border border-border bg-background px-3 py-1.5 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          onClick={() => setSplitByOwner((v) => !v)}
          className={cn(
            "border px-3 py-1.5 text-xs font-mono font-bold uppercase tracking-widest transition-colors",
            splitByOwner
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          Split by Consortium
        </button>
      </div>

      {/* Table */}
      <div className="border border-border bg-card overflow-x-auto">
        <table className="text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b border-border bg-muted/60">
              {/* Team — always leftmost sticky */}
              <th className="px-3 py-2.5 text-left sticky left-0 bg-muted/60 z-10 min-w-[160px]">
                <SH label="Team" k="team" align="left" />
              </th>
              <th className="px-3 py-2.5 text-center">
                <SH label="Conf" k="conf" align="center" />
              </th>
              <th className="px-3 py-2.5 text-left">
                <SH label="Div" k="div" align="left" />
              </th>
              <th className="px-3 py-2.5 text-center">
                <SH label="Playoff Seed" k="seed" align="center" />
              </th>
              <th className="px-3 py-2.5 text-left">
                <SH
                   label={splitByOwner ? "Consortium" : "Consortium(s)"}
                  k="owner"
                  align="left"
                />
              </th>
              {splitByOwner && (
                <th className="px-3 py-2.5 text-center">
                  <SH label="%" k="pct" align="center" />
                </th>
              )}
              <th className="px-3 py-2.5 text-center">
                <SH label="Record" k="record" align="center" />
              </th>
              <th className="px-3 py-2.5 text-right">
                <SH label="Net Diff" k="pd" />
              </th>
              <th className="px-3 py-2.5 text-right">
                <SH label="Cost" k="cost" />
              </th>
              <th className="px-3 py-2.5 text-right">
                <SH label="Gross" k="gross" />
              </th>
              <th className="px-3 py-2.5 text-right">
                <SH label="Net" k="net" />
              </th>
              <th className="px-3 py-2.5 text-right">
                <SH label="MTM" k="mtm" />
              </th>
            </tr>
          </thead>
          <tbody>
            {splitByOwner
              ? ownerSorted.map((row) => (
                  <tr
                    key={`${row.teamId}-${row.bidderId}`}
                    className={cn(
                      "border-b border-border last:border-0 hover:bg-muted/30 transition-colors",
                      row.winSuperBowl &&
                        "bg-yellow-50/40 dark:bg-yellow-900/10",
                    )}
                  >
                    <td className="px-3 py-2.5 font-medium sticky left-0 bg-card z-10 border-r border-border/50">
                      <div className="flex items-center gap-1.5">
                        {row.winSuperBowl && (
                          <img
                            src="/sleigh-monkey.png"
                            alt=""
                            className="w-4 h-4 object-contain shrink-0"
                          />
                        )}
                        {row.teamName}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <ConfBadge conf={row.conference} />
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground font-mono text-xs">
                      {row.division}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <SeedCell seed={row.seed} />
                    </td>
                    <td className="px-3 py-2.5 text-sm min-w-[220px]">
                      <OwnershipBreakdown
                        segments={row.ownershipSegments}
                        owners={row.owners}
                        consortiumByBidderId={consortiumByBidderId}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-center font-mono text-xs text-muted-foreground">
                      {row.pct}%
                    </td>
                    <td className="px-3 py-2.5 text-center font-mono text-xs">
                      {formatRecord(row.wins, row.losses, row.ties)}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2.5 text-right font-mono text-xs",
                        row.ptDiff >= 0 ? "text-green-600" : "text-red-500",
                      )}
                    >
                      {row.ptDiff >= 0 ? "+" : ""}
                      {row.ptDiff}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                      {formatCurrency(row.cost)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                      {isComplete ? formatCurrency(row.gross) : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2.5 text-right font-mono font-bold text-sm",
                        row.net >= 0 ? "text-green-600" : "text-red-600",
                      )}
                    >
                      {isComplete
                        ? (row.net >= 0 ? "+" : "") + formatCurrency(row.net)
                        : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2.5 text-right font-mono font-bold text-sm",
                        row.mtm >= 0 ? "text-green-600" : "text-red-600",
                      )}
                    >
                      {row.mtm !== 0
                        ? (row.mtm >= 0 ? "+" : "") + formatCurrency(row.mtm)
                        : "—"}
                    </td>
                  </tr>
                ))
              : teamSorted.map((row) => {
                  const seed = getSeed(row);
                  return (
                    <tr
                      key={row.teamId}
                      className={cn(
                        "border-b border-border last:border-0 hover:bg-muted/30 transition-colors",
                        row.winSuperBowl &&
                          "bg-yellow-50/40 dark:bg-yellow-900/10",
                      )}
                    >
                      {/* Team — sticky */}
                      <td className="px-3 py-2.5 font-medium sticky left-0 bg-card z-10 border-r border-border/50">
                        <div className="flex items-center gap-1.5">
                          {row.winSuperBowl && (
                            <img
                              src="/sleigh-monkey.png"
                              alt=""
                              className="w-4 h-4 object-contain shrink-0"
                            />
                          )}
                          {row.teamName}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <ConfBadge conf={row.conference} />
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground font-mono text-xs">
                        {row.division}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <SeedCell seed={seed} />
                      </td>
                      <td className="px-3 py-2.5 text-sm min-w-[260px]">
                        <OwnershipBreakdown
                          segments={row.ownershipSegments}
                          owners={row.owners}
                          consortiumByBidderId={consortiumByBidderId}
                        />
                      </td>
                      <td className="px-3 py-2.5 text-center font-mono text-xs">
                        {formatRecord(row.wins, row.losses, row.ties)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2.5 text-right font-mono text-xs",
                          row.ptDiff >= 0 ? "text-green-600" : "text-red-500",
                        )}
                      >
                        {row.ptDiff >= 0 ? "+" : ""}
                        {row.ptDiff}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                        {formatCurrency(row.cost)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                        {isComplete ? formatCurrency(row.realizedReturn) : "—"}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2.5 text-right font-mono font-bold text-sm",
                          row.netReturn >= 0
                            ? "text-green-600"
                            : "text-red-600",
                        )}
                      >
                        {isComplete
                          ? (row.netReturn >= 0 ? "+" : "") +
                            formatCurrency(row.netReturn)
                          : "—"}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2.5 text-right font-mono font-bold text-sm",
                          row.markToMarket >= 0
                            ? "text-green-600"
                            : "text-red-600",
                        )}
                      >
                        {row.markToMarket !== 0
                          ? (row.markToMarket >= 0 ? "+" : "") +
                            formatCurrency(row.markToMarket)
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground font-mono">
        {rowCount} {splitByOwner ? "owner-team rows" : "teams"} ·{" "}
        Return values follow this Calcutta's configured payout rules.
      </p>
    </div>
  );
}

function Empty() {
  return (
    <div className="border border-dashed border-border rounded-none flex flex-col items-center justify-center py-24 text-center">
      <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
        No results for this season yet
      </p>
      <p className="text-xs text-muted-foreground mt-2">
        Results will appear here once the season data is entered
      </p>
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
