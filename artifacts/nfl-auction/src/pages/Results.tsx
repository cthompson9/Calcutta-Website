import { useEffect, useState, useMemo, useRef } from "react";
import {
  useGetResults,
  getGetResultsQueryKey,
  useGetResultsByOwner,
  getGetResultsByOwnerQueryKey,
  useGetBidders,
  useGetSportPeriods,
  useGetSeasons,
  useGetResultsCompare,
  getGetResultsCompareQueryKey,
  useGetResultsAvailability,
  getGetResultsAvailabilityQueryKey,
  useGetAuctionSummary,
  getGetAuctionSummaryQueryKey,
  useGetMtmSnapshots,
  getGetMtmSnapshotsQueryKey,
  useGetTrades,
  getGetTradesQueryKey,
  useInitializeWeekZeroPoints,
} from "@workspace/api-client-react";
import type {
  OwnershipSegment,
  TeamResultRow,
  OwnerResultRow,
  CalcuttaComparisonResponse,
  CalcuttaComparisonRow,
  CalcuttaComparisonCell,
  CalcuttaComparisonAggregate,
  AuctionSummary,
  MtmData,
  TradeRow,
} from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useSeason } from "@/hooks/useSeason";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  ExternalLink,
  History,
  Minus,
  Search,
  Trophy,
  X,
  Loader2,
  Lock,
  Unlock,
} from "lucide-react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { bidderConsortiums, ownerLabelById } from "@/lib/ownerDisplay";
import { ConsortiumLabel } from "@/components/ConsortiumLabel";
import { auctionResultHref, tradeHref } from "@/lib/resultSourceLinks";
import { ReleaseNotes } from "@/components/ReleaseNotes";

type TabId = "byOwner" | "byTeam" | "compare";

export default function Results() {
  const { year } = useSeason();
  const [tab, setTab] = useState<TabId>("byOwner");
  const [expandedOwner, setExpandedOwner] = useState<number | null>(null);
  const [period, setPeriod] = useState<number | undefined>(undefined);
  const [compareSeasons, setCompareSeasons] = useState<number[]>([]);
  const [compareGroupBy, setCompareGroupBy] = useState<"bidder" | "consortium">("consortium");
  const teamBasis = "realized" as const;
  const portfolioBasis = "mtm" as const;
  const basis = tab === "byTeam" ? teamBasis : portfolioBasis;

  const { data: periods } = useGetSportPeriods({ sport: "NFL" });
  const { data: allSeasons } = useGetSeasons();
  const availabilityParams = { season: year, basis };
  const { data: availability } = useGetResultsAvailability(
    availabilityParams,
    {
      query: {
        enabled: tab === "byOwner" || tab === "byTeam",
        queryKey: getGetResultsAvailabilityQueryKey(availabilityParams),
      },
    },
  );
  const selectedPeriod = period ?? availability?.latestPeriod ?? undefined;

  useEffect(() => {
    if (allSeasons && compareSeasons.length === 0) {
      const recent = [...allSeasons]
        .filter((s) => s.isActive || s.isComplete)
        .sort((a, b) => b.year - a.year)
        .slice(0, 2)
        .map((s) => s.year);
      if (recent.length > 0) {
        setCompareSeasons(recent);
      }
    }
  }, [allSeasons, compareSeasons.length]);

  const { data: teamResults, isLoading: loadingTeams } = useGetResults(
    { season: year, period: selectedPeriod, basis: teamBasis },
    {
      query: {
        enabled: tab === "byTeam" && (period != null || availability !== undefined),
        queryKey: getGetResultsQueryKey({ season: year, period: selectedPeriod, basis: teamBasis }),
      },
    },
  );
  const { data: ownerResults, isLoading: loadingOwners } = useGetResultsByOwner(
    {
      season: year,
      period: selectedPeriod,
      basis: portfolioBasis,
    },
    {
      query: {
        enabled: tab === "byOwner",
        queryKey: getGetResultsByOwnerQueryKey({
          season: year,
          period: selectedPeriod,
          basis: portfolioBasis,
        }),
      },
    },
  );
  const previousPeriod =
    period != null
      ? period > 0
        ? period - 1
        : undefined
      : availability?.previousPeriod ?? undefined;
  const { data: previousOwnerResults } = useGetResultsByOwner(
    { season: year, period: previousPeriod, basis: portfolioBasis },
    {
      query: {
        enabled: tab === "byOwner" && previousPeriod != null,
        queryKey: getGetResultsByOwnerQueryKey({
          season: year,
          period: previousPeriod,
          basis: portfolioBasis,
        }),
      },
    },
  );
  const { data: auctionSummary } = useGetAuctionSummary(
    { season: year },
    {
      query: {
        enabled: tab === "byOwner",
        queryKey: getGetAuctionSummaryQueryKey({ season: year }),
      },
    },
  );
  const { data: mtmData } = useGetMtmSnapshots(
    { season: year },
    {
      query: {
        enabled: tab === "byOwner",
        queryKey: getGetMtmSnapshotsQueryKey({ season: year }),
      },
    },
  );
  const { data: trades } = useGetTrades(
    { season: year },
    {
      query: {
        enabled: tab === "byOwner",
        queryKey: getGetTradesQueryKey({ season: year }),
      },
    },
  );

  const compareParams = {
    seasons: compareSeasons.join(","),
    period,
    basis: portfolioBasis,
    groupBy: compareGroupBy,
  };
  const { data: compareResults, isLoading: loadingCompare } = useGetResultsCompare(
    compareParams,
    { query: { enabled: tab === "compare" && compareSeasons.length >= 2, queryKey: getGetResultsCompareQueryKey(compareParams) } }
  );

  const { data: bidders } = useGetBidders({ season: year });
  const consortiumByBidderId = useMemo(() => bidderConsortiums(bidders), [bidders]);

  const isLoading =
    tab === "byTeam"
      ? loadingTeams
      : tab === "byOwner"
        ? loadingOwners
        : loadingCompare;

  // Consortium and comparison views are always live net-MTM reports. By Team
  // receives realized snapshots so its mixed financial columns stay stable.
  const isComplete = false;
  const selectedPeriodLabel = period == null
    ? "latest available period"
    : periods?.find((item) => item.sequence === period)?.label ?? `Period ${period}`;

  return (
    <div className="md:p-8 space-y-4 md:space-y-6 max-w-[1400px] mx-auto pb-6">
      {/* Header */}
      <header className="flex flex-col gap-3 px-4 pt-4 md:flex-row md:items-end md:justify-between md:px-0 md:pt-0">
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-1" data-testid="text-report-title">
            Calcutta Returns
          </h1>
          <p className="text-muted-foreground font-mono text-xs md:text-sm uppercase tracking-widest" data-testid="text-report-subtitle">
            {tab === "byTeam" ? "Realized + net MTM" : "Net MTM"} · {selectedPeriodLabel} · {year} season
          </p>
        </div>
        <WeekZeroPointsControl year={year} />
      </header>

      <div className="hidden px-4 md:block md:px-0">
        <ReleaseNotes />
      </div>

      <div className="px-4 md:px-0">
        <div className="flex flex-col gap-4 rounded-none md:rounded-lg border-y md:border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between -mx-4 md:mx-0 shadow-sm">
          <label className="flex flex-col sm:flex-row sm:items-center gap-1.5 text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
            <span className="text-[10px]">Through period</span>
            <div className="relative">
              <select
                data-testid="select-period"
                value={period ?? ""}
                onChange={(event) => setPeriod(event.target.value === "" ? undefined : Number(event.target.value))}
                className="w-full sm:w-auto appearance-none rounded-sm border border-border/60 bg-muted/30 px-3 py-1.5 pr-8 text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary text-xs"
              >
                <option value="">Latest available</option>
                {(periods ?? []).map((item) => (
                  <option key={item.sequence} value={item.sequence}>
                    {item.label}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-muted-foreground">
                <ChevronDown className="h-4 w-4" />
              </div>
            </div>
          </label>
          {tab === "compare" && (
            <div className="flex rounded-md border border-border/60 p-0.5 bg-muted/50">
              {(["consortium", "bidder"] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => setCompareGroupBy(value)}
                  className={cn(
                    "flex-1 sm:flex-none rounded-sm px-3 py-1.5 text-[10px] md:text-xs font-mono font-bold uppercase tracking-widest transition-colors",
                    compareGroupBy === value
                      ? "bg-background text-foreground shadow-sm border border-border/50"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value === "consortium" ? "By Consortium" : "By Bidder"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {tab === "compare" && allSeasons && (
        <div className="px-4 md:px-0">
          <div className="flex flex-wrap items-center gap-1.5 rounded-none md:rounded-lg border-y md:border border-border bg-card p-3 -mx-4 md:mx-0 shadow-sm">
            <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground mr-2">
              Compare Seasons
            </span>
            {allSeasons.map((s) => {
              const isSelected = compareSeasons.includes(s.year);
              const disabled = !isSelected && compareSeasons.length >= 6;
              return (
                <button
                  key={s.id}
                  disabled={disabled}
                  onClick={() => {
                    setCompareSeasons((prev) =>
                      isSelected
                        ? prev.filter((y) => y !== s.year)
                        : [...prev, s.year].sort((a, b) => b - a)
                    );
                  }}
                  className={cn(
                    "rounded px-3 py-1.5 text-xs font-mono font-bold transition-colors border",
                    isSelected
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted text-muted-foreground border-border/50 hover:bg-muted/80",
                    disabled && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {s.year}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-border overflow-x-auto no-scrollbar mx-4 md:mx-0">
        {(["byOwner", "byTeam", "compare"] as TabId[]).map((t) => (
          <button
            key={t}
            data-testid={`tab-${t}`}
            onClick={() => setTab(t)}
            className={cn(
              "whitespace-nowrap px-4 md:px-5 py-3 text-[11px] md:text-sm font-mono font-bold uppercase tracking-widest transition-colors border-b-2 -mb-px",
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "byOwner" ? "By Consortium" : t === "byTeam" ? "By Team" : "Compare"}
          </button>
        ))}
      </div>

      <div className="px-0 md:px-0">
        {isLoading ? (
          <LoadingSkeleton />
        ) : tab === "byOwner" ? (
          <>
            <div className="hidden md:block">
              <DesktopResultsCommandCenter
                rows={ownerResults ?? []}
                previousRows={previousOwnerResults ?? []}
                isComplete={isComplete}
                seasonYear={year}
                summary={auctionSummary}
                mtmData={mtmData}
                trades={trades}
                consortiumByBidderId={consortiumByBidderId}
              />
            </div>
            <div className="md:hidden">
              <ByOwnerView
                rows={ownerResults ?? []}
                isComplete={isComplete}
                expandedOwner={expandedOwner}
                setExpandedOwner={setExpandedOwner}
                consortiumByBidderId={consortiumByBidderId}
                seasonYear={year}
              />
            </div>
          </>
        ) : tab === "compare" ? (
          compareSeasons.length < 2 ? (
            <div className="flex flex-col items-center justify-center rounded-none md:rounded-lg border-y md:border border-dashed border-border bg-card/50 p-12 text-center text-muted-foreground mx-4 md:mx-0">
              <Trophy className="h-8 w-8 mb-4 opacity-50" />
              <p className="font-mono text-sm uppercase tracking-widest font-bold">Select seasons to compare</p>
              <p className="mt-1 text-sm">Choose at least two seasons from the list above to view a comparison.</p>
            </div>
          ) : (
            <CompareView
              response={compareResults}
              isComplete={isComplete}
            />
          )
        ) : (
          <ByTeamView
            rows={teamResults ?? []}
            isComplete={isComplete}
            consortiumByBidderId={consortiumByBidderId}
            seasonYear={year}
          />
        )}
      </div>
    </div>
  );
}

function WeekZeroPointsControl({ year }: { year: number }) {
  const queryClient = useQueryClient();
  const [adminKey, setAdminKey] = useState<string | null>(
    () => sessionStorage.getItem("nfl_admin_key"),
  );
  const [showKeyEntry, setShowKeyEntry] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const initializeWeekZero = useInitializeWeekZeroPoints({
    request: {
      headers: adminKey ? { Authorization: `Bearer ${adminKey}` } : {},
    },
  });

  function saveAdminKey() {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    sessionStorage.setItem("nfl_admin_key", trimmed);
    setAdminKey(trimmed);
    setKeyInput("");
    setShowKeyEntry(false);
  }

  function clearAdminKey() {
    sessionStorage.removeItem("nfl_admin_key");
    setAdminKey(null);
  }

  async function initialize() {
    if (!adminKey) return;
    try {
      const result = await initializeWeekZero.mutateAsync({
        data: { seasonYear: year },
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getGetResultsAvailabilityQueryKey(),
        }),
        queryClient.invalidateQueries({ queryKey: getGetResultsQueryKey() }),
        queryClient.invalidateQueries({
          queryKey: getGetResultsByOwnerQueryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: getGetResultsCompareQueryKey(),
        }),
      ]);
      toast.success(
        result.alreadyInitialized
          ? `Week 0 is already initialized for ${year}.`
          : `Initialized Week 0 for ${result.teamCount} teams.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to initialize Week 0.",
      );
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {adminKey ? (
        <>
          <button
            type="button"
            onClick={clearAdminKey}
            className="flex items-center gap-1.5 border border-green-600 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-green-700 transition-colors hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-950/30"
            title="Commissioner access is active — click to lock"
          >
            <Unlock className="h-3 w-3" /> Commissioner
          </button>
          <button
            type="button"
            data-testid="button-initialize-week-zero"
            onClick={() => void initialize()}
            disabled={initializeWeekZero.isPending}
            className="flex items-center gap-1.5 bg-primary px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {initializeWeekZero.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            {initializeWeekZero.isPending ? "Initializing…" : "Initialize Week 0"}
          </button>
        </>
      ) : (
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowKeyEntry((visible) => !visible)}
            className="flex items-center gap-1.5 border border-border px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Enter a commissioner key to initialize the Week 0 baseline"
          >
            <Lock className="h-3 w-3" /> Commissioner
          </button>
          {showKeyEntry ? (
            <div className="absolute right-0 top-full z-50 mt-1 w-64 space-y-2 border border-border bg-background p-3 shadow-lg">
              <p className="font-mono text-[10px] text-muted-foreground">
                Enter the commissioner key to initialize the protected Week 0 baseline.
              </p>
              <input
                type="password"
                value={keyInput}
                onChange={(event) => setKeyInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveAdminKey();
                }}
                placeholder="Commissioner key…"
                className="w-full border border-border bg-background px-2 py-1.5 font-mono text-sm"
                autoFocus
              />
              <button
                type="button"
                onClick={saveAdminKey}
                disabled={!keyInput.trim()}
                className="w-full bg-primary py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-primary-foreground disabled:opacity-50"
              >
                Unlock
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ─── Desktop command center ───────────────────────────────────────────────────

type CommandSortKey =
  | "return"
  | "returnPct"
  | "cost"
  | "marketValue"
  | "teams"
  | "movement";

function commandReturn(row: OwnerResultRow, isComplete: boolean): number {
  return row.totalNetMtm;
}

function commandMarketValue(row: OwnerResultRow, isComplete: boolean): number {
  return row.totalMtm;
}

function commandReturnPct(row: OwnerResultRow, isComplete: boolean): number {
  return Math.abs(row.totalCost) > 0.005
    ? (row.totalNetMtm / Math.abs(row.totalCost)) * 100
    : 0;
}

function signedCurrency(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatCurrency(value)}`;
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function RelativeReturnBar({
  value,
  max,
}: {
  value: number;
  max: number;
}) {
  const width = max > 0 ? Math.max(4, Math.min(100, (Math.abs(value) / max) * 100)) : 0;
  return (
    <div
      className="flex h-1.5 w-20 items-center justify-end bg-muted/70"
      aria-hidden="true"
    >
      <div
        className={cn(
          "h-full transition-all",
          value >= 0 ? "bg-emerald-500" : "bg-rose-500",
        )}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function TrendSparkline({ values }: { values: Array<number | null> }) {
  const validValues = values.filter((value): value is number => value != null);
  if (validValues.length < 2) {
    return (
      <div className="flex h-16 items-center justify-center border border-dashed border-border/70 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
        No complete weekly snapshot data
      </div>
    );
  }

  const min = Math.min(...validValues);
  const max = Math.max(...validValues);
  const span = max - min || 1;
  const pointAt = (value: number, index: number) => {
      const x = (index / (values.length - 1)) * 220;
      const y = 54 - ((value - min) / span) * 44;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    };
  const lineSegments: string[] = [];
  let currentSegment: string[] = [];
  values.forEach((value, index) => {
    if (value == null) {
      if (currentSegment.length > 1) lineSegments.push(currentSegment.join(" "));
      currentSegment = [];
      return;
    }
    currentSegment.push(pointAt(value, index));
  });
  if (currentSegment.length > 1) lineSegments.push(currentSegment.join(" "));
  const firstValue = validValues[0]!;
  const lastValue = validValues[validValues.length - 1]!;

  return (
    <svg
      viewBox="0 0 220 64"
      className="h-16 w-full overflow-visible"
      role="img"
      aria-label="Eight week mark-to-market trend"
    >
      <line x1="0" y1="54" x2="220" y2="54" stroke="currentColor" opacity="0.15" />
      {lineSegments.map((points, index) => (
        <polyline
          key={`${points}-${index}`}
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          className={lastValue >= firstValue ? "text-emerald-500" : "text-rose-500"}
        />
      ))}
      {values.map((value, index) => {
        if (value == null) return null;
        const x = (index / (values.length - 1)) * 220;
        const y = 54 - ((value - min) / span) * 44;
        return <circle key={`${value}-${index}`} cx={x} cy={y} r="2.5" className="fill-current" />;
      })}
    </svg>
  );
}

function DesktopResultsCommandCenter({
  rows,
  previousRows,
  isComplete,
  seasonYear,
  summary,
  mtmData,
  trades,
  consortiumByBidderId,
}: {
  rows: OwnerResultRow[];
  previousRows: OwnerResultRow[];
  isComplete: boolean;
  seasonYear: number;
  summary?: AuctionSummary;
  mtmData?: MtmData;
  trades?: TradeRow[];
  consortiumByBidderId: Map<number, string>;
}) {
  const [sortKey, setSortKey] = useState<CommandSortKey>("return");
  const [sortAsc, setSortAsc] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedOwnerId, setSelectedOwnerId] = useState<number | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRowRef = useRef<HTMLTableRowElement | null>(null);

  const previousById = useMemo(
    () => new Map(previousRows.map((row) => [row.bidderId, row])),
    [previousRows],
  );
  const query = search.trim().toLowerCase();
  const filteredRows = query
    ? rows.filter((row) =>
        [
          row.bidderName,
          row.consortium ?? "",
          ownerLabelById(row.bidderId, row.bidderName, consortiumByBidderId),
        ].some((value) => value.toLowerCase().includes(query)),
      )
    : rows;
  const rankedRows = useMemo(
    () =>
      [...rows].sort(
        (a, b) => commandReturn(b, isComplete) - commandReturn(a, isComplete),
      ),
    [rows, isComplete],
  );
  const ranks = useMemo(
    () => new Map(rankedRows.map((row, index) => [row.bidderId, index + 1])),
    [rankedRows],
  );
  const maxReturn = Math.max(
    1,
    ...rows.map((row) => Math.abs(commandReturn(row, isComplete))),
  );
  const sortedRows = [...filteredRows].sort((a, b) => {
    const previousA = previousById.get(a.bidderId);
    const previousB = previousById.get(b.bidderId);
    const movementA = previousA
      ? commandReturn(a, isComplete) - commandReturn(previousA, isComplete)
      : 0;
    const movementB = previousB
      ? commandReturn(b, isComplete) - commandReturn(previousB, isComplete)
      : 0;
    const values: Record<CommandSortKey, [number, number]> = {
      return: [commandReturn(a, isComplete), commandReturn(b, isComplete)],
      returnPct: [commandReturnPct(a, isComplete), commandReturnPct(b, isComplete)],
      cost: [a.totalCost, b.totalCost],
      marketValue: [
        commandMarketValue(a, isComplete),
        commandMarketValue(b, isComplete),
      ],
      teams: [a.teamCount, b.teamCount],
      movement: [movementA, movementB],
    };
    const difference = values[sortKey][0] - values[sortKey][1];
    return sortAsc ? difference : -difference;
  });
  const leader = rankedRows[0];
  const worst = rankedRows[rankedRows.length - 1];
  const biggestMover = [...rows]
    .map((row) => ({
      row,
      movement: previousById.has(row.bidderId)
        ? commandReturn(row, isComplete) -
          commandReturn(previousById.get(row.bidderId)!, isComplete)
        : 0,
    }))
    .sort((a, b) => Math.abs(b.movement) - Math.abs(a.movement))[0];
  const selectedOwner = rows.find((row) => row.bidderId === selectedOwnerId) ?? null;

  useEffect(() => {
    if (selectedOwner) closeButtonRef.current?.focus();
  }, [selectedOwner]);

  function handleSort(key: CommandSortKey) {
    if (sortKey === key) setSortAsc((value) => !value);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  function openOwner(
    ownerId: number,
    row: HTMLTableRowElement,
  ) {
    openerRowRef.current = row;
    setSelectedOwnerId(ownerId);
  }

  function closeOwner() {
    setSelectedOwnerId(null);
    window.requestAnimationFrame(() => openerRowRef.current?.focus());
  }

  function SortButton({
    label,
    sort,
  }: {
    label: string;
    sort: CommandSortKey;
  }) {
    const active = sortKey === sort;
    return (
      <button
        type="button"
        onClick={() => handleSort(sort)}
        className={cn(
          "inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:text-foreground",
          active ? "text-primary" : "text-muted-foreground",
        )}
      >
        {label}
        {active && <span aria-hidden="true">{sortAsc ? "↑" : "↓"}</span>}
      </button>
    );
  }

  if (!rows.length) return <Empty />;

  return (
    <div className="space-y-5">
      <section className="border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-6 border-b border-border p-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-primary">
              Results command center · {seasonYear}
            </p>
            <div className="mt-2 flex items-end gap-3">
              <h2 className="font-mono text-5xl font-bold tracking-tighter text-foreground">
                {summary ? formatCurrency(summary.potSize) : "—"}
              </h2>
              <span className="pb-1 font-mono text-xs uppercase tracking-widest text-muted-foreground">
                total pot
              </span>
            </div>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              {isComplete
                ? "Realized standings from the completed payout ledger."
                : "Live mark-to-market standings based on the latest available snapshots."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4 lg:min-w-[44rem]">
            <CommandMetric label="Teams auctioned" value={String(summary?.teamsAuctioned ?? "—")} />
            <CommandMetric label="Average bid" value={summary ? formatCurrency(summary.avgBidPerTeam) : "—"} />
            <CommandMetric
              label="Leader"
              value={leader ? ownerLabelById(leader.bidderId, leader.bidderName, consortiumByBidderId) : "—"}
              subvalue={leader ? signedCurrency(commandReturn(leader, isComplete)) : undefined}
            />
            <CommandMetric
              label="Biggest mover"
              value={
                biggestMover
                  ? ownerLabelById(
                      biggestMover.row.bidderId,
                      biggestMover.row.bidderName,
                      consortiumByBidderId,
                    )
                  : "—"
              }
              subvalue={biggestMover ? signedCurrency(biggestMover.movement) : undefined}
            />
          </div>
        </div>
        <div className="grid gap-0 divide-y border-t border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <CommandCallout
            label="Top net MTM"
            owner={leader}
            value={leader ? commandReturn(leader, isComplete) : 0}
            isComplete={isComplete}
            consortiumByBidderId={consortiumByBidderId}
          />
          <CommandCallout
            label="Worst net MTM"
            owner={worst}
            value={worst ? commandReturn(worst, isComplete) : 0}
            isComplete={isComplete}
            consortiumByBidderId={consortiumByBidderId}
          />
          <div className="p-4">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Coverage
            </p>
            <p className="mt-1 font-mono text-sm font-bold">
              {isComplete ? "Realized ledger" : "MTM snapshots"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {isComplete
                ? "Payout rules and approved trades applied."
                : "Values may remain unavailable until a snapshot is captured."}
            </p>
          </div>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="min-w-0 border border-border bg-card shadow-sm">
          <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
                Live standings
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Select a row to inspect positions, trend, and trade history.
              </p>
            </div>
            <label className="relative block sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Filter standings</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter consortiums…"
                className="w-full border border-border/70 bg-background py-2 pl-8 pr-3 font-mono text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </label>
          </div>
          <div className="table-scroll">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <caption className="sr-only">Sortable consortium returns standings</caption>
              <thead className="sticky-table-header border-b border-border bg-muted/30">
                <tr>
                  <th className="w-12 px-4 py-3 text-center"><span className="sr-only">Rank</span>#</th>
                  <th className="px-3 py-3 text-left"><SortButton label="Consortium" sort="return" /></th>
                  <th className="px-3 py-3 text-right"><SortButton label="Cost basis" sort="cost" /></th>
                <th className="px-3 py-3 text-right"><SortButton label="MTM gross" sort="marketValue" /></th>
                <th className="px-3 py-3 text-right"><SortButton label="Net MTM" sort="return" /></th>
                <th className="px-3 py-3 text-right"><SortButton label="MTM %" sort="returnPct" /></th>
                  <th className="px-3 py-3 text-right"><SortButton label="Move" sort="movement" /></th>
                  <th className="w-10 px-3 py-3 text-right"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {sortedRows.map((row) => {
                  const rank = ranks.get(row.bidderId) ?? sortedRows.indexOf(row) + 1;
                  const previous = previousById.get(row.bidderId);
                  const movement = previous
                    ? commandReturn(row, isComplete) -
                      commandReturn(previous, isComplete)
                    : null;
                  const returnValue = commandReturn(row, isComplete);
                  const ownerName = ownerLabelById(
                    row.bidderId,
                    row.bidderName,
                    consortiumByBidderId,
                  );
                  return (
                    <tr
                      key={row.bidderId}
                      tabIndex={0}
                      role="button"
                      aria-selected={selectedOwnerId === row.bidderId}
                      data-testid={`results-owner-row-${row.bidderId}`}
                      onClick={(event) => openOwner(row.bidderId, event.currentTarget)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openOwner(row.bidderId, event.currentTarget);
                        }
                      }}
                      className={cn(
                        "cursor-pointer outline-none transition-colors hover:bg-primary/5 focus:bg-primary/5 focus:ring-2 focus:ring-inset focus:ring-primary",
                        selectedOwnerId === row.bidderId && "bg-primary/5",
                      )}
                    >
                      <td className="px-4 py-3 text-center">
                        <span
                          className={cn(
                            "inline-flex h-7 w-7 items-center justify-center rounded-full font-mono text-xs font-bold",
                            rank === 1 && "bg-amber-400 text-amber-950",
                            rank === 2 && "bg-slate-300 text-slate-800",
                            rank === 3 && "bg-orange-300 text-orange-950",
                            rank > 3 && "border border-border text-muted-foreground",
                          )}
                        >
                          {rank}
                        </span>
                      </td>
                      <td className="max-w-[15rem] px-3 py-3">
                        <div className="truncate font-bold" title={ownerName}>{ownerName}</div>
                        <div className="mt-1 flex items-center gap-2">
                          <RelativeReturnBar value={returnValue} max={maxReturn} />
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {row.teamCount.toFixed(2)} teams
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-muted-foreground">
                        {formatCurrency(row.totalCost)}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs">
                        {formatCurrency(commandMarketValue(row, isComplete))}
                      </td>
                      <td className={cn(
                        "px-3 py-3 text-right font-mono text-sm font-bold",
                        returnValue >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                      )}>
                        {signedCurrency(returnValue)}
                      </td>
                      <td className={cn(
                        "px-3 py-3 text-right font-mono text-xs font-bold",
                        commandReturnPct(row, isComplete) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                      )}>
                        {signedPercent(commandReturnPct(row, isComplete))}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs">
                        {movement == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : movement === 0 ? (
                          <span className="inline-flex items-center gap-1 text-muted-foreground"><Minus className="h-3 w-3" />—</span>
                        ) : (
                          <span className={cn("inline-flex items-center gap-1 font-bold", movement > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                            {movement > 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                            {signedCurrency(movement)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right text-muted-foreground">
                        <span aria-hidden="true">›</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {sortedRows.length} of {rows.length} consortiums · values are signed and season-scoped
          </div>
        </section>

        {selectedOwner ? (
          <DesktopOwnerDetail
            owner={selectedOwner}
            seasonYear={seasonYear}
            isComplete={isComplete}
            mtmData={mtmData}
            trades={trades ?? []}
            consortiumByBidderId={consortiumByBidderId}
            onClose={closeOwner}
            closeButtonRef={closeButtonRef}
          />
        ) : (
          <aside className="hidden border border-dashed border-border bg-card/50 p-6 xl:block">
            <History className="h-5 w-5 text-primary" aria-hidden="true" />
            <p className="mt-4 font-mono text-xs font-bold uppercase tracking-widest">
              Detail panel
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Choose any consortium in the standings to open its positions, eight-week trend, and approved trade history.
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}

function CommandMetric({
  label,
  value,
  subvalue,
}: {
  label: string;
  value: string;
  subvalue?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-mono text-sm font-bold">{value}</p>
      {subvalue && <p className="mt-0.5 font-mono text-[11px] text-primary">{subvalue}</p>}
    </div>
  );
}

function CommandCallout({
  label,
  owner,
  value,
  isComplete,
  consortiumByBidderId,
}: {
  label: string;
  owner?: OwnerResultRow;
  value: number;
  isComplete: boolean;
  consortiumByBidderId: Map<number, string>;
}) {
  return (
    <div className="p-4">
      <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <p className="truncate text-sm font-bold">
          {owner ? ownerLabelById(owner.bidderId, owner.bidderName, consortiumByBidderId) : "—"}
        </p>
        <p className={cn(
          "shrink-0 font-mono text-sm font-bold",
          value >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
        )}>
          {owner ? signedCurrency(value) : "—"}
        </p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {owner ? signedPercent(commandReturnPct(owner, isComplete)) : "Awaiting data"}
      </p>
    </div>
  );
}

function DesktopOwnerDetail({
  owner,
  seasonYear,
  isComplete,
  mtmData,
  trades,
  consortiumByBidderId,
  onClose,
  closeButtonRef,
}: {
  owner: OwnerResultRow;
  seasonYear: number;
  isComplete: boolean;
  mtmData?: MtmData;
  trades: TradeRow[];
  consortiumByBidderId: Map<number, string>;
  onClose: () => void;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const ownerName = ownerLabelById(owner.bidderId, owner.bidderName, consortiumByBidderId);
  const series = mtmData?.owners.find((item) => item.bidderName === owner.bidderName);
  const currentPositionTeamIds = owner.teams
    .filter((team) => {
      const position = effectivePositionsForTeam(team).find(
        (entry) => entry.bidderId === owner.bidderId,
      )?.ownershipShare ?? 0;
      return Math.abs(position) >= 0.00005;
    })
    .map((team) => team.teamId);
  const trendWeeks = mtmData?.weeks.slice(-8) ?? [];
  const trendStartIndex = (mtmData?.weeks.length ?? 0) - trendWeeks.length;
  const trendValues = trendWeeks.map((week, index) => {
    const hasEveryPosition = currentPositionTeamIds.every((teamId) =>
      week.teamValues.some((team) => team.teamId === teamId),
    );
    return hasEveryPosition
      ? series?.weeklyTotals[trendStartIndex + index] ?? null
      : null;
  });
  const ownerTrades = trades
    .filter((trade) => trade.fromBidderId === owner.bidderId || trade.toBidderId === owner.bidderId)
    .sort((a, b) => b.tradeDate.localeCompare(a.tradeDate))
    .slice(0, 6);

  return (
    <aside
      className="border border-primary/30 bg-card shadow-sm xl:sticky xl:top-6 xl:self-start"
      role="region"
      aria-labelledby="results-detail-title"
      data-testid="results-detail-panel"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border bg-primary/5 p-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-primary">Selected portfolio</p>
          <h3 id="results-detail-title" className="mt-1 truncate text-lg font-bold">{ownerName}</h3>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{owner.teamCount.toFixed(2)} net teams</p>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close portfolio details"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-5 p-4">
        <div className="grid grid-cols-2 gap-3">
          <DetailMetric label="Cost basis" value={formatCurrency(owner.totalCost)} />
          <DetailMetric
            label="Net MTM"
            value={signedCurrency(commandReturn(owner, isComplete))}
            tone={commandReturn(owner, isComplete) >= 0 ? "positive" : "negative"}
          />
          <DetailMetric label="MTM gross" value={formatCurrency(commandMarketValue(owner, isComplete))} />
          <DetailMetric label="MTM %" value={signedPercent(commandReturnPct(owner, isComplete))} tone={commandReturnPct(owner, isComplete) >= 0 ? "positive" : "negative"} />
        </div>

        <section>
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Eight-week revaluation</p>
            <span className="font-mono text-[10px] text-muted-foreground">Current portfolio</span>
          </div>
          <div className="mt-2 border border-border/70 p-2 text-primary">
            <TrendSparkline values={trendValues} />
          </div>
          {trendWeeks.length > 0 && (
            <div className="mt-1 flex justify-between font-mono text-[9px] text-muted-foreground">
              <span>{trendWeeks[0]?.label}</span>
              <span>{trendWeeks[trendWeeks.length - 1]?.label}</span>
            </div>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            Revalues today&apos;s positions at each snapshot; incomplete weeks are left as gaps rather than shown as zero.
          </p>
        </section>

        <section>
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Positions</p>
            <span className="font-mono text-[10px] text-muted-foreground">{owner.teams.length} teams</span>
          </div>
          <div className="mt-2 divide-y divide-border/70 border-y border-border/70">
            {[...owner.teams]
              .sort((a, b) => b.markToMarket - a.markToMarket)
              .map((team) => {
                const position = team.owners.find((entry) => entry.bidderId === owner.bidderId)?.ownershipShare ?? 0;
                return (
                  <div key={team.teamId} className="py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-bold">{team.teamName}</span>
                      <span className={cn("shrink-0 font-mono text-xs font-bold", position >= 0 ? "text-sky-700 dark:text-sky-400" : "text-rose-600 dark:text-rose-400")}>
                        {formatOwnershipPercent(position, true)}
                      </span>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px]">
                      <span className="text-muted-foreground">Cost {formatCurrency(team.cost)}</span>
                      <span className="text-muted-foreground">Gross {formatCurrency(team.realizedReturn)}</span>
                      <span className={team.netReturn >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                        Net {signedCurrency(Number(team.netReturn))}
                      </span>
                      <span className={team.netMtm >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                        MTM {signedCurrency(Number(team.netMtm))}
                      </span>
                      <span className="col-span-2 text-muted-foreground">
                        Realized breakeven {team.ptsToBreakeven == null ? "—" : `${team.ptsToBreakeven.toLocaleString()} pts`}
                      </span>
                    </div>
                    <div className="mt-1 flex gap-3 font-mono text-[10px]">
                      <Link
                        href={auctionResultHref(seasonYear, team.teamId)}
                        className="inline-flex items-center gap-1 text-primary hover:underline focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        Auction <ExternalLink className="h-2.5 w-2.5" />
                      </Link>
                      {team.ownershipSegments.some((segment) => segment.source === "trade" && segment.tradeId != null) && (
                        <span className="text-muted-foreground">Trade source linked in ownership</span>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Trade history</p>
            <History className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </div>
          {ownerTrades.length === 0 ? (
            <p className="mt-2 border border-dashed border-border p-3 text-xs text-muted-foreground">No trades recorded for this portfolio.</p>
          ) : (
            <div className="mt-2 divide-y divide-border/70 border-y border-border/70">
              {ownerTrades.map((trade) => {
                const acquired = trade.toBidderId === owner.bidderId;
                return (
                  <Link
                    key={trade.id}
                    href={tradeHref(seasonYear, trade.id)}
                    className="block py-2.5 transition-colors hover:bg-muted/40 focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-bold">{acquired ? "Acquired" : "Sold"} · {trade.teamName}</span>
                      <span className={cn("font-mono text-[10px] uppercase", trade.status === "approved" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>{trade.status}</span>
                    </div>
                    <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
                      <span>{trade.tradeDate} · {trade.percentage.toFixed(0)}%</span>
                      <span>{formatCurrency(trade.price)}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function DetailMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}) {
  return (
    <div className="border border-border/70 bg-muted/20 p-2.5">
      <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={cn(
        "mt-1 font-mono text-sm font-bold",
        tone === "positive" && "text-emerald-600 dark:text-emerald-400",
        tone === "negative" && "text-rose-600 dark:text-rose-400",
      )}>{value}</p>
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

type SignedTeamPosition = {
  bidderId: number;
  bidderName: string;
  ownershipShare: number;
};

/**
 * The team endpoint's `owners` field intentionally contains only current,
 * positive owners. Results also carries the complete signed transaction
 * history, which lets the report expose leveraged longs and shorts alongside
 * those owners without redefining who is a current owner.
 */
function effectivePositionsForTeam(
  team: Pick<TeamResultRow, "owners" | "ownershipSegments">,
): SignedTeamPosition[] {
  if (!team.ownershipSegments.length) {
    return team.owners;
  }

  const byBidder = new Map<number, SignedTeamPosition>();
  for (const segment of team.ownershipSegments) {
    const position = byBidder.get(segment.bidderId) ?? {
      bidderId: segment.bidderId,
      bidderName: segment.bidderName,
      ownershipShare: 0,
    };
    position.ownershipShare += segment.ownershipShare;
    byBidder.set(segment.bidderId, position);
  }

  return [...byBidder.values()]
    .filter((position) => Math.abs(position.ownershipShare) >= 0.00005)
    .sort((a, b) => b.ownershipShare - a.ownershipShare);
}

const OWNER_SUMMARY_GRID =
  "grid-cols-[2rem_minmax(0,1fr)_auto_2rem] md:grid-cols-[2.5rem_minmax(14rem,22rem)_minmax(0,1fr)_4.5rem_8rem_8rem_2.5rem]";
const OWNER_SUMMARY_COMPLETE_GRID =
  "grid-cols-[2rem_minmax(0,1fr)_auto_2rem] md:grid-cols-[2.5rem_minmax(14rem,22rem)_minmax(0,1fr)_4.5rem_8rem_8rem_8rem_2.5rem]";
const OWNER_TEAM_GRID =
  "grid-cols-[1fr_auto] md:grid-cols-[minmax(10rem,1.2fr)_minmax(0,1fr)_6rem_6rem_6rem_6rem_6rem_6rem]";

function ByOwnerView({
  rows,
  isComplete,
  expandedOwner,
  setExpandedOwner,
  consortiumByBidderId,
  seasonYear,
}: {
  rows: OwnerResultRow[];
  isComplete: boolean;
  expandedOwner: number | null;
  setExpandedOwner: (id: number | null) => void;
  consortiumByBidderId: Map<number, string>;
  seasonYear: number;
}) {
  if (!rows.length) return <Empty />;

  // Always sort by MTM net return — that's the live standing metric
  const sorted = [...rows].sort((a, b) => b.totalNetMtm - a.totalNetMtm);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1 border-y md:border border-sky-200 bg-sky-50 px-4 py-3 text-xs dark:border-sky-900 dark:bg-sky-950/30 sm:flex-row sm:items-center sm:justify-between mx-0">
        <span className="font-mono font-bold uppercase tracking-widest text-sky-900 dark:text-sky-100">
          Signed position ledger
        </span>
        <span className="text-sky-800 dark:text-sky-200">
          Leveraged longs and negative shorts are both included; every team nets to 100% ownership.
        </span>
      </div>

      {/* Summary header */}
      <div
        className={cn(
          "hidden md:grid bg-muted/60 text-muted-foreground text-[10px] md:text-xs font-mono font-bold uppercase tracking-widest px-4 py-3 border border-border sticky top-0 z-10 backdrop-blur rounded-t-lg",
          isComplete ? OWNER_SUMMARY_COMPLETE_GRID : OWNER_SUMMARY_GRID,
        )}
      >
        <div className="text-center">#</div>
        <div>Consortium</div>
        <div className="hidden md:block" />
        <div className="text-right">Net Teams</div>
        {isComplete ? (
          <>
            <div className="text-right">Exposure</div>
            <div className="text-right">Gross</div>
            <div className="text-right font-bold text-foreground">Net</div>
          </>
        ) : (
          <>
            <div className="text-right font-bold text-foreground">Net MTM</div>
            <div className="text-right">Exposure</div>
          </>
        )}
        <div />
      </div>

      <div className="flex flex-col gap-0 md:gap-3">
        {sorted.map((row, idx) => {
          const isExpanded = expandedOwner === row.bidderId;
          const isLeader = idx === 0;
          const isWinner = isLeader && row.totalNetMtm > 0;
          return (
            <div
              key={row.bidderId}
              className="border-b border-border bg-card overflow-hidden last:border-b-0 md:border md:rounded-lg shadow-sm"
            >
              {/* Owner row */}
              <button
                type="button"
                data-testid={`button-expand-owner-${row.bidderId}`}
                onClick={() => setExpandedOwner(isExpanded ? null : row.bidderId)}
                aria-expanded={isExpanded}
                className={cn(
                  "w-full grid items-center px-4 py-4 md:px-4 md:py-4 hover:bg-muted/40 transition-colors text-left",
                  isComplete ? OWNER_SUMMARY_COMPLETE_GRID : OWNER_SUMMARY_GRID,
                  isWinner && "bg-yellow-50 dark:bg-yellow-900/10",
                )}
              >
                <div className="flex items-center justify-center font-mono font-bold text-base md:text-lg">
                  <span>{idx + 1}</span>
                </div>

                {/* Name & Subtext */}
                <div className="min-w-0 pr-2 flex flex-col justify-center">
                  <div className="font-bold truncate text-sm md:text-base flex items-center gap-1.5">
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
                    {isLeader && (
                      <img src="/sleigh-monkey.png" alt="leader" className="w-4 h-4 object-contain shrink-0" />
                    )}
                  </div>
                  <div className="md:hidden text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-0.5">
                    {row.teamCount > 0 ? "+" : ""}{row.teamCount.toFixed(2)} Teams
                  </div>
                </div>

                <div className="hidden md:block" />
                <div className="hidden md:block text-right text-muted-foreground font-mono self-center">
                  {row.teamCount > 0 ? "+" : ""}
                  {row.teamCount.toFixed(2)}
                </div>

                {isComplete ? (
                  <>
                    <div className="hidden md:block text-right font-mono text-sm text-muted-foreground self-center">
                      {formatCurrency(calculateExposure(row))}
                    </div>
                    <div className="hidden md:block text-right font-mono text-sm text-muted-foreground self-center">
                      {formatCurrency(row.totalRealizedReturn)}
                    </div>
                    <div
                      className={cn(
                        "text-right font-mono font-bold text-sm md:text-base self-center",
                        row.totalNetReturn >= 0
                          ? "text-green-600 dark:text-green-400"
                          : "text-red-600 dark:text-red-400",
                      )}
                    >
                      {row.totalNetReturn >= 0 ? "+" : ""}
                      {formatCurrency(row.totalNetReturn)}
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      className={cn(
                        "text-right font-mono font-bold text-sm md:text-base self-center",
                        row.totalNetMtm >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
                      )}
                    >
                      {row.totalNetMtm !== 0
                        ? (row.totalNetMtm >= 0 ? "+" : "") +
                          formatCurrency(row.totalNetMtm)
                        : "—"}
                    </div>
                    <div className="hidden md:block text-right font-mono text-sm text-muted-foreground self-center">
                      {formatCurrency(calculateExposure(row))}
                    </div>
                  </>
                )}

                <div className="flex justify-end items-center text-muted-foreground">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors group-hover:bg-muted">
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 transition-transform",
                        !isExpanded && "-rotate-90",
                      )}
                    />
                  </span>
                </div>
              </button>

              {/* Mobile stats */}
              {isExpanded && (
                <div className="md:hidden grid grid-cols-2 text-xs font-mono border-t border-border bg-muted/30 px-4 py-3 gap-y-3">
                  {isComplete ? (
                    <>
                      <div>
                        <div className="text-muted-foreground uppercase tracking-widest text-[10px]">Exposure</div>
                        <div className="font-bold">{formatCurrency(calculateExposure(row))}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground uppercase tracking-widest text-[10px]">Gross</div>
                        <div className="font-bold">{formatCurrency(row.totalRealizedReturn)}</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <div className="text-muted-foreground uppercase tracking-widest text-[10px]">Exposure</div>
                        <div className="font-bold">{formatCurrency(calculateExposure(row))}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground uppercase tracking-widest text-[10px]">MTM ROI</div>
                        <div className="font-bold">
                          {calculateExposure(row) !== 0
                            ? ((row.totalNetMtm / Math.abs(calculateExposure(row))) * 100).toFixed(1) + "%"
                            : "—"}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Expanded team list */}
              {isExpanded && (
                <div className="border-t border-border">
                  <div
                    className={cn(
                      "hidden md:grid bg-muted/50 text-muted-foreground text-[10px] font-mono font-bold uppercase tracking-widest px-6 py-2 border-b border-border",
                      OWNER_TEAM_GRID,
                    )}
                  >
                    <div>Team</div>
                    <div>Ownership</div>
                    <div className="text-right">Net Position</div>
                    <div className="text-right">Cost</div>
                    <div className="text-right">Gross</div>
                    <div className="text-right">Net</div>
                    <div className="text-right">Net MTM</div>
                    <div className="text-right">Pts to BE</div>
                  </div>
                  {[...row.teams]
                    .sort((a, b) => b.markToMarket - a.markToMarket)
                    .map((t) => (
                      <TeamSubRow
                        key={t.teamId}
                        team={t}
                        ownerId={row.bidderId}
                        consortiumByBidderId={consortiumByBidderId}
                        seasonYear={seasonYear}
                      />
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
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
  teamId,
  teamName,
  seasonYear,
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
  teamId: number;
  teamName: string;
  seasonYear: number;
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
        const hasTradeSource = isTrade && segment.tradeId != null;
        const href = hasTradeSource
          ? tradeHref(seasonYear, segment.tradeId!)
          : auctionResultHref(seasonYear, teamId);
        const sourceDescription =
          hasTradeSource
            ? `View trade #${segment.tradeId} for ${teamName}`
            : isTrade
              ? `Trade source unavailable; view original auction result for ${teamName}`
            : `View original auction result for ${teamName}`;

        return (
          <Link
            key={`${segment.source}-${segment.tradeId ?? "primary"}-${segment.bidderId}-${index}`}
            href={href}
            aria-label={sourceDescription}
            title={sourceDescription}
            className={cn(
              "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border px-2 py-1 text-[11px] font-mono leading-tight transition-colors hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset rounded-sm",
              !isTrade && "border-border/50 bg-muted/30 text-muted-foreground",
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
          </Link>
        );
      })}
    </div>
  );
}

function TeamSubRow({
  team,
  ownerId,
  consortiumByBidderId,
  seasonYear,
}: {
  team: TeamResultRow;
  ownerId: number;
  consortiumByBidderId: Map<number, string>;
  seasonYear: number;
}) {
  const ownerSegments = team.ownershipSegments.filter(
    (segment) => segment.bidderId === ownerId,
  );
  const ownerEntries = team.owners.filter((owner) => owner.bidderId === ownerId);
  const netPosition = ownerEntries[0]?.ownershipShare ?? 0;

  return (
    <div
      className={cn(
        "grid items-center px-4 md:px-6 py-3 border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors gap-y-1",
        OWNER_TEAM_GRID,
      )}
    >
      <div className="min-w-0 pr-2">
        <div className="flex flex-col md:flex-row md:items-center gap-0 md:gap-2">
          <span className="font-bold text-sm md:font-medium">{team.teamName}</span>
          <span className="text-[10px] text-muted-foreground font-mono shrink-0 uppercase tracking-widest">
            {team.conference}
          </span>
        </div>
      </div>

      {/* Mobile right-aligned stack */}
      <div className="text-right md:hidden">
        <div className={cn("font-mono text-sm font-bold", netPosition >= 0 ? "text-sky-700 dark:text-sky-400" : "text-rose-600 dark:text-rose-400")}>
          {formatOwnershipPercent(netPosition, true)}
        </div>
        <div className={cn("font-mono text-xs mt-0.5", team.netMtm >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
          {signedCurrency(Number(team.netMtm))}
        </div>
      </div>

      <div className="min-w-0 font-mono text-[10px] md:text-xs col-span-2 md:col-span-1 mt-1 md:mt-0">
        <OwnershipBreakdown
          segments={ownerSegments}
          owners={ownerEntries}
          teamId={team.teamId}
          teamName={team.teamName}
          seasonYear={seasonYear}
          consortiumByBidderId={consortiumByBidderId}
          showOwner={false}
          compact
        />
      </div>
      <div className="col-span-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border/40 pt-2 text-[10px] font-mono md:hidden">
        <span className="text-muted-foreground">Cost <strong className="text-foreground">{formatCurrency(team.cost)}</strong></span>
        <span className="text-muted-foreground">Gross <strong className="text-foreground">{formatCurrency(team.realizedReturn)}</strong></span>
        <span className="text-muted-foreground">Net <strong className={team.netReturn >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>{signedCurrency(Number(team.netReturn))}</strong></span>
        <span className="text-muted-foreground">Breakeven <strong className="text-foreground">{team.ptsToBreakeven == null ? "—" : `${team.ptsToBreakeven.toLocaleString()} pts`}</strong></span>
      </div>

      <div
        className={cn(
          "hidden md:block text-right font-mono text-sm font-bold",
          netPosition >= 0 ? "text-sky-700 dark:text-sky-400" : "text-rose-600 dark:text-rose-400",
        )}
      >
        {formatOwnershipPercent(netPosition, true)}
      </div>
      <div className="hidden md:block text-right font-mono text-sm text-muted-foreground">
        {formatCurrency(team.cost)}
      </div>
      <div className="hidden md:block text-right font-mono text-sm text-muted-foreground">
        {formatCurrency(team.realizedReturn)}
      </div>
      <div className={cn("hidden md:block text-right font-mono text-sm", team.netReturn >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
        {signedCurrency(Number(team.netReturn))}
      </div>
      <div className={cn("hidden md:block text-right font-mono text-sm", team.netMtm >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
        {signedCurrency(Number(team.netMtm))}
      </div>
      <div className="hidden md:block text-right font-mono text-sm text-muted-foreground">
        {team.ptsToBreakeven == null ? "—" : `${team.ptsToBreakeven.toLocaleString()} pts`}
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
  ownershipShare: number;
  pct: number;
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
  ptsToBreakeven: number | null;
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
    for (const owner of effectivePositionsForTeam(team)) {
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
        ownershipShare: s,
        pct: s * 100,
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
        mtm: Math.round(team.netMtm * s * 100) / 100,
        ptsToBreakeven: team.ptsToBreakeven,
      });
    }
  }
  return result;
}

function ByTeamView({
  rows,
  isComplete,
  consortiumByBidderId,
  seasonYear,
}: {
  rows: TeamResultRow[];
  isComplete: boolean;
  consortiumByBidderId: Map<number, string>;
  seasonYear: number;
}) {
  const [splitByOwner, setSplitByOwner] = useState(true);
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
          "font-mono font-bold uppercase tracking-widest text-[10px] md:text-xs whitespace-nowrap hover:text-foreground transition-colors w-full",
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
            ? "text-yellow-600 dark:text-yellow-500"
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
          "text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-sm",
          conf === "AFC"
            ? "bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900"
            : "bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
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
        diff = a.netMtm - b.netMtm;
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
    <div className="space-y-3 px-4 md:px-0">
      {/* Controls */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by team, consortium, conference, division…"
          className="w-full min-w-0 md:w-[28rem] md:flex-none rounded-md border border-border/60 bg-card px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary shadow-sm"
        />
        <button
          onClick={() => setSplitByOwner((v) => !v)}
          className={cn(
            "rounded-md border px-4 py-2 text-xs font-mono font-bold uppercase tracking-widest transition-colors text-center shadow-sm",
            splitByOwner
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border/60 bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          Split by Consortium
        </button>
      </div>
      {/* Table */}
      <div className="table-scroll border-y md:border border-border bg-card -mx-4 md:mx-0 md:rounded-lg shadow-sm">
        <table className="text-sm whitespace-nowrap w-full">
          <thead className="sticky-table-header">
            <tr className="border-b border-border/60 bg-muted/30">
              {/* Team — always leftmost sticky */}
              <th className="px-4 md:px-5 py-3 text-left sticky left-0 bg-muted/95 backdrop-blur z-10 min-w-[160px] border-r border-border/50">
                <SH label="Team" k="team" align="left" />
              </th>
              <th className="px-3 py-3 text-center">
                <SH label="Conf" k="conf" align="center" />
              </th>
              <th className="px-3 py-3 text-left">
                <SH label="Div" k="div" align="left" />
              </th>
              <th className="px-3 py-3 text-center">
                <SH label="Playoff Seed" k="seed" align="center" />
              </th>
              <th className="px-4 py-3 text-left">
                <SH
                   label={splitByOwner ? "Consortium" : "Consortium(s)"}
                  k="owner"
                  align="left"
                />
              </th>
              {splitByOwner && (
                <th className="px-3 py-3 text-center">
                  <SH label="Net Position" k="pct" align="center" />
                </th>
              )}
              <th className="px-3 py-3 text-center">
                <SH label="Record" k="record" align="center" />
              </th>
              <th className="px-4 py-3 text-right">
                <SH label="Net Diff" k="pd" />
              </th>
              <th className="px-4 py-3 text-right">
                <SH label="Cost" k="cost" />
              </th>
              <th className="px-4 py-3 text-right">
                <SH label="Realized Gross" k="gross" />
              </th>
              <th className="px-4 py-3 text-right">
                <SH label="Realized Net" k="net" />
              </th>
              <th className="px-4 md:px-5 py-3 text-right">
                <SH label="MTM" k="mtm" />
              </th>
               <th className="px-4 md:px-5 py-3 text-right">
                 <span>Pts to BE</span>
               </th>
            </tr>
          </thead>
          <tbody>
            {splitByOwner
              ? ownerSorted.map((row) => (
                  <tr
                    key={`${row.teamId}-${row.bidderId}`}
                    className={cn(
                      "border-b border-border/60 last:border-0 hover:bg-muted/30 transition-colors",
                      row.winSuperBowl &&
                        "bg-yellow-50/40 dark:bg-yellow-900/10",
                    )}
                  >
                    <td className="px-4 md:px-5 py-3 font-medium sticky left-0 bg-card z-10 border-r border-border/50">
                      <div className="flex items-center gap-2">
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
                    <td className="px-3 py-3 text-center">
                      <ConfBadge conf={row.conference} />
                    </td>
                    <td className="px-3 py-3 text-muted-foreground font-mono text-xs">
                      {row.division}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <SeedCell seed={row.seed} />
                    </td>
                    <td className="px-4 py-3 text-sm min-w-[220px]">
                      <OwnershipBreakdown
                        segments={row.ownershipSegments}
                        owners={row.owners}
                        teamId={row.teamId}
                        teamName={row.teamName}
                        seasonYear={seasonYear}
                        consortiumByBidderId={consortiumByBidderId}
                      />
                    </td>
                    <td
                      className={cn(
                        "px-3 py-3 text-center font-mono text-xs font-bold",
                        row.ownershipShare >= 0
                          ? "text-sky-700 dark:text-sky-400"
                          : "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {formatOwnershipPercent(row.ownershipShare, true)}
                    </td>
                    <td className="px-3 py-3 text-center font-mono text-xs">
                      {formatRecord(row.wins, row.losses, row.ties)}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right font-mono text-xs",
                        row.ptDiff >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400",
                      )}
                    >
                      {row.ptDiff >= 0 ? "+" : ""}
                      {row.ptDiff}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm text-muted-foreground">
                      {formatCurrency(row.cost)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm text-muted-foreground">
                      {formatCurrency(row.gross)}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right font-mono font-bold text-sm",
                        row.net >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
                      )}
                    >
                      {(row.net >= 0 ? "+" : "") + formatCurrency(row.net)}
                    </td>
                    <td
                      className={cn(
                        "px-4 md:px-5 py-3 text-right font-mono font-bold text-sm",
                        row.mtm >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
                      )}
                    >
                      {row.mtm !== 0
                        ? (row.mtm >= 0 ? "+" : "") + formatCurrency(row.mtm)
                        : "—"}
                    </td>
                     <td className="px-4 md:px-5 py-3 text-right font-mono text-sm text-muted-foreground">
                       {row.ptsToBreakeven != null
                         ? row.ptsToBreakeven.toLocaleString()
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
                        "border-b border-border/60 last:border-0 hover:bg-muted/30 transition-colors",
                        row.winSuperBowl &&
                          "bg-yellow-50/40 dark:bg-yellow-900/10",
                      )}
                    >
                      {/* Team — sticky */}
                      <td className="px-4 md:px-5 py-3 font-medium sticky left-0 bg-card z-10 border-r border-border/50">
                        <div className="flex items-center gap-2">
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
                      <td className="px-3 py-3 text-center">
                        <ConfBadge conf={row.conference} />
                      </td>
                      <td className="px-3 py-3 text-muted-foreground font-mono text-xs">
                        {row.division}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <SeedCell seed={seed} />
                      </td>
                      <td className="px-4 py-3 text-sm min-w-[260px]">
                        <OwnershipBreakdown
                          segments={row.ownershipSegments}
                          owners={row.owners}
                          teamId={row.teamId}
                          teamName={row.teamName}
                          seasonYear={seasonYear}
                          consortiumByBidderId={consortiumByBidderId}
                        />
                      </td>
                      <td className="px-3 py-3 text-center font-mono text-xs">
                        {formatRecord(row.wins, row.losses, row.ties)}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-3 text-right font-mono text-xs",
                          row.ptDiff >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400",
                        )}
                      >
                        {row.ptDiff >= 0 ? "+" : ""}
                        {row.ptDiff}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-sm text-muted-foreground">
                        {formatCurrency(row.cost)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-sm text-muted-foreground">
                        {formatCurrency(row.realizedReturn)}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-3 text-right font-mono font-bold text-sm",
                          row.netReturn >= 0
                            ? "text-green-600 dark:text-green-400"
                            : "text-red-600 dark:text-red-400",
                        )}
                      >
                        {(row.netReturn >= 0 ? "+" : "") +
                          formatCurrency(row.netReturn)}
                      </td>
                      <td
                        className={cn(
                          "px-4 md:px-5 py-3 text-right font-mono font-bold text-sm",
                          row.netMtm >= 0
                            ? "text-green-600 dark:text-green-400"
                            : "text-red-600 dark:text-red-400",
                        )}
                      >
                        {row.netMtm !== 0
                          ? (row.netMtm >= 0 ? "+" : "") +
                            formatCurrency(row.netMtm)
                          : "—"}
                      </td>
                      <td className="px-4 md:px-5 py-3 text-right font-mono text-sm text-muted-foreground">
                        {row.ptsToBreakeven != null
                          ? row.ptsToBreakeven.toLocaleString()
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] md:text-xs text-muted-foreground font-mono">
        {rowCount} {splitByOwner ? "owner-team rows" : "teams"} ·{" "}
        Return values follow this Calcutta's configured payout rules.
      </p>
    </div>
  );
}

// ─── Compare ──────────────────────────────────────────────────────────────────

function CompareView({
  response,
  isComplete,
}: {
  response: CalcuttaComparisonResponse | undefined;
  isComplete: boolean;
}) {
  if (!response || !response.rows.length) return <Empty />;

  // Comparison is deliberately live: all rows rank by cost-adjusted MTM.
  const sorted = [...response.rows].sort(
    (a, b) => b.aggregate.totalNetMtm - a.aggregate.totalNetMtm,
  );

  return (
    <div className="table-scroll border-y md:border border-border md:rounded-lg bg-card shadow-sm -mx-4 md:mx-0">
      <table className="w-full text-left text-sm font-mono whitespace-nowrap border-collapse min-w-max">
        <thead className="sticky-table-header bg-muted/30 text-muted-foreground text-[10px] md:text-xs uppercase tracking-widest">
          <tr>
            <th className="px-4 py-3 font-bold border-b border-border/60 sticky left-0 z-20 bg-muted/95 backdrop-blur border-r">
              {response.groupBy === "consortium" ? "Consortium" : "Bidder"}
            </th>
            {response.calcuttas.map((c) => (
              <th key={c.id} className="px-4 py-3 font-bold border-b border-border/60 border-r text-right">
                <div className="text-foreground">{c.year}</div>
                <div className="text-[10px] text-muted-foreground font-normal normal-case tracking-normal">{c.label}</div>
              </th>
            ))}
            <th className="px-4 py-3 font-bold border-b border-border/60 text-right bg-muted/50">
              Aggregate
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {sorted.map((row) => (
            <tr key={row.id} className="group hover:bg-muted/30 transition-colors">
              <td className="px-4 py-4 font-bold sticky left-0 z-10 bg-card group-hover:bg-muted/80 transition-colors border-r border-border/50">
                <ConsortiumLabel label={row.name} />
              </td>
              {row.calcuttas.map((cell, idx) => (
                <td key={idx} className="px-4 py-4 border-r border-border/50 text-right align-top">
                  {cell ? <CompareCell cell={cell} isComplete={isComplete} /> : <span className="text-muted-foreground/40">—</span>}
                </td>
              ))}
              <td className="px-4 py-4 text-right bg-muted/10 font-bold align-top">
                <CompareAggregate aggregate={row.aggregate} isComplete={isComplete} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompareCell({ cell, isComplete }: { cell: CalcuttaComparisonCell; isComplete: boolean }) {
  if (!cell.snapshotAvailable) {
    return (
      <div
        className="flex flex-col items-end text-right text-xs italic text-muted-foreground/70"
        title="This Calcutta does not have a complete snapshot for the selected reporting period."
      >
        <span>
          {cell.snapshotTeamCount > 0
            ? `Partial snapshots (${cell.snapshotTeamCount}/${cell.teamCount})`
            : "No snapshot"}
        </span>
        <span className="text-[10px]">{cell.periodLabel ?? "Unknown period"}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className={cn(
          "font-bold text-sm",
          isComplete
            ? cell.totalNetReturn >= 0
              ? "text-green-600 dark:text-green-400"
              : "text-red-600 dark:text-red-400"
            : cell.totalNetMtm >= 0
              ? "text-green-600 dark:text-green-400"
              : "text-red-600 dark:text-red-400",
        )}
      >
        {isComplete
          ? (cell.totalNetReturn >= 0 ? "+" : "") + formatCurrency(cell.totalNetReturn)
          : signedCurrency(cell.totalNetMtm)}
      </div>
      <div className="text-[10px] text-muted-foreground flex gap-2">
        <span title="Exposure / Cost Basis">Exp: {formatCurrency(cell.exposure)}</span>
        <span title="Net Teams">Tms: {cell.teamCount > 0 ? "+" : ""}{cell.teamCount.toFixed(2)}</span>
      </div>
    </div>
  );
}

function CompareAggregate({ aggregate, isComplete }: { aggregate: CalcuttaComparisonAggregate; isComplete: boolean }) {
  if (!aggregate.snapshotAvailable) {
    return (
      <div
        className="flex flex-col items-end text-right text-xs italic text-muted-foreground/70"
        title="One or more Calcutta positions do not have complete snapshots for the selected reporting period."
      >
        <span>Partial snapshots</span>
        <span className="text-[10px]">
          {aggregate.snapshotTeamCount}/{aggregate.teamCount} positions covered
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className={cn(
          "font-bold text-sm",
          isComplete
            ? aggregate.totalNetReturn >= 0
              ? "text-green-600 dark:text-green-400"
              : "text-red-600 dark:text-red-400"
            : aggregate.totalNetMtm >= 0
              ? "text-green-600 dark:text-green-400"
              : "text-red-600 dark:text-red-400",
        )}
      >
        {isComplete
          ? (aggregate.totalNetReturn >= 0 ? "+" : "") + formatCurrency(aggregate.totalNetReturn)
          : signedCurrency(aggregate.totalNetMtm)}
      </div>
      <div className="text-[10px] text-muted-foreground flex gap-2">
        <span title="Total Exposure">Exp: {formatCurrency(aggregate.exposure)}</span>
        <span title="Total Teams">Tms: {aggregate.teamCount.toFixed(2)}</span>
      </div>
    </div>
  );
}

// ─── Loading / Empty ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse px-4 md:px-0">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-16 bg-muted/50 rounded-md border border-border" />
      ))}
    </div>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center justify-center rounded-none md:rounded-lg border-y md:border border-dashed border-border/60 bg-card/50 p-12 text-center text-muted-foreground mx-4 md:mx-0">
      <Trophy className="h-8 w-8 mb-4 opacity-30" />
      <p className="font-mono text-sm uppercase tracking-widest font-bold text-foreground">No results available</p>
      <p className="mt-1 text-sm">Results will appear here once the season starts.</p>
    </div>
  );
}
