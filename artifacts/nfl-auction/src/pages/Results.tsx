import { useEffect, useState, useMemo, useRef } from "react";
import {
  useGetResults,
  getGetResultsQueryKey,
  useGetResultsByOwner,
  getGetResultsByOwnerQueryKey,
  useGetBidders,
  getGetBiddersQueryKey,
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
  useGetHistoricalPools,
  useGetHistoricalPoolEntries,
  getGetHistoricalPoolEntriesQueryKey,
  useGetHistoricalPoolOwners,
  getGetHistoricalPoolOwnersQueryKey,
  useGetHistoricalPoolTrades,
  getGetHistoricalPoolTradesQueryKey,
} from "@workspace/api-client-react";
import type {
  OwnershipSegment,
  TeamResultRow,
  OwnerResultRow,
  CalcuttaComparisonResponse,
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
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  History,
  Minus,
  Search,
  Trophy,
  X,
} from "lucide-react";
import { Link } from "wouter";
import { bidderConsortiums, ownerLabelById } from "@/lib/ownerDisplay";
import { ConsortiumLabel } from "@/components/ConsortiumLabel";
import { auctionResultHref, tradeHref } from "@/lib/resultSourceLinks";
import {
  buildTradeGroups,
  sharedTradeDescription,
  sortTradeGroups,
  type TradeGroup,
} from "@/lib/tradeGroups";
import { ReleaseNotes } from "@/components/ReleaseNotes";
import { HistoricalResultsView } from "@/components/HistoricalResultsView";

type TabId = "byOwner" | "byTeam" | "historicalTrades" | "compare";

export default function Results() {
  const { year, selectedCalcutta } = useSeason();
  const isNflCalcutta = selectedCalcutta?.sport === "NFL";
  const usesLiveResults =
    isNflCalcutta && year >= 2025;
  const prefersHistoricalResults =
    selectedCalcutta != null && !usesLiveResults;
  const calcuttaId = usesLiveResults ? selectedCalcutta.id : undefined;
  const [tab, setTab] = useState<TabId>("byOwner");
  const [expandedOwner, setExpandedOwner] = useState<number | null>(null);
  const [period, setPeriod] = useState<number | undefined>(undefined);
  const [compareSeasons, setCompareSeasons] = useState<number[]>([]);
  const [compareGroupBy, setCompareGroupBy] = useState<"bidder" | "consortium">("consortium");
  const consortiumBasis = "mtm" as const;
  const teamBasis = "realized" as const;
  const viewBasis = tab === "byTeam" ? teamBasis : consortiumBasis;

  const {
    data: historicalPools,
    isLoading: loadingHistoricalPools,
  } = useGetHistoricalPools();
  const historicalPool = useMemo(
    () =>
      historicalPools?.find(
        (pool) =>
          pool.name === selectedCalcutta?.name &&
          pool.seasonYear === selectedCalcutta?.year &&
          pool.sport.toUpperCase() === selectedCalcutta?.sport.toUpperCase(),
      ) ?? null,
    [historicalPools, selectedCalcutta],
  );
  const historicalPoolId = historicalPool?.id ?? 0;
  const isHistoricalReport =
    prefersHistoricalResults && historicalPool != null;
  const { data: historicalEntries, isLoading: loadingHistoricalEntries } =
    useGetHistoricalPoolEntries(historicalPoolId, {
      query: {
        enabled: isHistoricalReport,
        queryKey: getGetHistoricalPoolEntriesQueryKey(historicalPoolId),
      },
    });
  const { data: historicalOwners, isLoading: loadingHistoricalOwners } =
    useGetHistoricalPoolOwners(historicalPoolId, {
      query: {
        enabled: isHistoricalReport,
        queryKey: getGetHistoricalPoolOwnersQueryKey(historicalPoolId),
      },
    });
  const { data: historicalTrades, isLoading: loadingHistoricalTrades } =
    useGetHistoricalPoolTrades(historicalPoolId, {
      query: {
        enabled: isHistoricalReport,
        queryKey: getGetHistoricalPoolTradesQueryKey(historicalPoolId),
      },
    });

  const { data: periods } = useGetSportPeriods({ sport: "NFL" });
  const { data: allSeasons } = useGetSeasons();
  const availabilityParams = { season: year, calcuttaId, basis: viewBasis };
  const { data: availability } = useGetResultsAvailability(
    availabilityParams,
    {
      query: {
        enabled: usesLiveResults && (tab === "byOwner" || tab === "byTeam"),
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

  useEffect(() => {
    setPeriod(undefined);
    if (prefersHistoricalResults && tab === "compare") {
      setTab("byOwner");
    } else if (!prefersHistoricalResults && tab === "historicalTrades") {
      setTab("byOwner");
    }
  }, [prefersHistoricalResults, selectedCalcutta?.id, tab]);

  const { data: teamResults, isLoading: loadingTeams } = useGetResults(
    { season: year, calcuttaId, period: selectedPeriod, basis: teamBasis },
    {
      query: {
        enabled: usesLiveResults && tab === "byTeam" && (period != null || availability !== undefined),
        queryKey: getGetResultsQueryKey({ season: year, calcuttaId, period: selectedPeriod, basis: teamBasis }),
      },
    },
  );
  const { data: ownerResults, isLoading: loadingOwners } = useGetResultsByOwner(
    {
      season: year,
      calcuttaId,
      period: selectedPeriod,
      basis: consortiumBasis,
    },
    {
      query: {
        enabled: usesLiveResults && tab === "byOwner",
        queryKey: getGetResultsByOwnerQueryKey({
          season: year,
          calcuttaId,
          period: selectedPeriod,
          basis: consortiumBasis,
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
    { season: year, calcuttaId, period: previousPeriod, basis: consortiumBasis },
    {
      query: {
        enabled: usesLiveResults && tab === "byOwner" && previousPeriod != null,
        queryKey: getGetResultsByOwnerQueryKey({
          season: year,
          calcuttaId,
          period: previousPeriod,
          basis: consortiumBasis,
        }),
      },
    },
  );
  const { data: auctionSummary } = useGetAuctionSummary(
    { season: year, calcuttaId },
    {
      query: {
        enabled: usesLiveResults && tab === "byOwner",
        queryKey: getGetAuctionSummaryQueryKey({ season: year, calcuttaId }),
      },
    },
  );
  const { data: mtmData } = useGetMtmSnapshots(
    { season: year, calcuttaId },
    {
      query: {
        enabled: usesLiveResults && tab === "byOwner",
        queryKey: getGetMtmSnapshotsQueryKey({ season: year, calcuttaId }),
      },
    },
  );
  const { data: trades } = useGetTrades(
    { season: year, calcuttaId },
    {
      query: {
        enabled: usesLiveResults && tab === "byOwner",
        queryKey: getGetTradesQueryKey({ season: year, calcuttaId }),
      },
    },
  );

  const compareParams = {
    seasons: compareSeasons.join(","),
    period,
    basis: consortiumBasis,
    groupBy: compareGroupBy,
  };
  const { data: compareResults, isLoading: loadingCompare } = useGetResultsCompare(
    compareParams,
    {
      query: {
        enabled:
          !prefersHistoricalResults &&
          tab === "compare" &&
          compareSeasons.length >= 2,
        queryKey: getGetResultsCompareQueryKey(compareParams),
      },
    },
  );

  const { data: bidders } = useGetBidders(
    { season: year, calcuttaId },
    { query: { enabled: usesLiveResults, queryKey: getGetBiddersQueryKey({ season: year, calcuttaId }) } },
  );
  const consortiumByBidderId = useMemo(() => bidderConsortiums(bidders), [bidders]);

  const isLoading = prefersHistoricalResults
    ? loadingHistoricalPools ||
      (isHistoricalReport &&
        (loadingHistoricalEntries ||
          loadingHistoricalOwners ||
          loadingHistoricalTrades))
    : tab === "byTeam"
      ? loadingTeams
      : tab === "byOwner"
        ? loadingOwners
        : loadingCompare;
  const staleMtmReasons = useMemo(() => {
    const teamReasons = (teamResults ?? [])
      .filter((row) => row.marketStatus === "stale")
      .flatMap((row) => row.marketStatusReasons);
    const ownerReasons = (ownerResults ?? [])
      .filter((row) => row.marketStatus === "stale")
      .flatMap((row) => row.marketStatusReasons);
    return [...new Set([...teamReasons, ...ownerReasons])];
  }, [teamResults, ownerResults]);

  const reportBasisLabel = prefersHistoricalResults
    ? "Final normalized historical returns"
    : tab === "byTeam"
    ? "Realized team returns + latest MTM"
    : "Latest net mark-to-market";
  const selectedPeriodLabel = prefersHistoricalResults
    ? "final imported results"
    : period == null
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
            {reportBasisLabel} · {selectedPeriodLabel} · {year} season
          </p>
        </div>
      </header>

      <div className="hidden px-4 md:block md:px-0">
        <ReleaseNotes />
      </div>

      {!prefersHistoricalResults && (
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
      )}

      {!prefersHistoricalResults && tab === "compare" && allSeasons && (
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
        {(prefersHistoricalResults
          ? (["byOwner", "byTeam", "historicalTrades"] as TabId[])
          : (["byOwner", "byTeam", "compare"] as TabId[])
        ).map((t) => (
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
            {t === "byOwner"
              ? "By Consortium"
              : t === "byTeam"
                ? "By Team"
                : t === "historicalTrades"
                  ? "Trades"
                  : "Compare"}
          </button>
        ))}
      </div>

      {!prefersHistoricalResults && tab !== "compare" && staleMtmReasons.length > 0 && (
        <div
          className="mx-4 flex items-start gap-3 border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100 md:mx-0"
          role="status"
          data-testid="stale-mtm-warning"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-mono text-xs font-bold uppercase tracking-wider">
              Stale market inputs — MTM is untrustworthy
            </p>
            <p className="mt-1 text-xs">
              {staleMtmReasons.join(" ")}
            </p>
          </div>
        </div>
      )}

      <div className="px-0 md:px-0">
        {isLoading ? (
          <LoadingSkeleton />
        ) : isHistoricalReport && historicalPool ? (
          <HistoricalResultsView
            pool={historicalPool}
            entries={historicalEntries ?? []}
            owners={historicalOwners ?? []}
            trades={historicalTrades ?? []}
            tab={
              tab === "byTeam"
                ? "byTeam"
                : tab === "historicalTrades"
                  ? "historicalTrades"
                  : "byOwner"
            }
          />
        ) : prefersHistoricalResults ? (
          <HistoricalResultsUnavailable />
        ) : tab === "byOwner" ? (
          <>
            <div className="hidden md:block">
              <DesktopResultsCommandCenter
                rows={ownerResults ?? []}
                previousRows={previousOwnerResults ?? []}
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
            />
          )
        ) : (
          <ByTeamView
            rows={teamResults ?? []}
            consortiumByBidderId={consortiumByBidderId}
            seasonYear={year}
          />
        )}
      </div>
    </div>
  );
}

function HistoricalResultsUnavailable() {
  return (
    <div className="mx-4 flex flex-col items-center justify-center rounded-none border-y border-dashed border-border bg-card/50 p-12 text-center text-muted-foreground md:mx-0 md:rounded-lg md:border">
      <History className="mb-4 h-8 w-8 opacity-40" />
      <p className="font-mono text-sm font-bold uppercase tracking-widest text-foreground">
        Historical backload unavailable
      </p>
      <p className="mt-1 max-w-xl text-sm">
        No normalized historical pool matches this Calcutta. The report will not
        fall back to another season or treat missing values as zero.
      </p>
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

function commandReturn(row: OwnerResultRow): number {
  return row.totalNetMtm;
}

function commandMarketValue(row: OwnerResultRow): number {
  return row.totalMtm;
}

function commandReturnPct(row: OwnerResultRow): number {
  return Math.abs(row.totalCost) > 0.005
    ? (commandReturn(row) / Math.abs(row.totalCost)) * 100
    : 0;
}

function signedCurrency(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatCurrency(value)}`;
}

function breakevenHeatClass(points: number | null): string {
  if (points == null) return "text-muted-foreground";
  if (points >= 0) {
    return "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900";
  }
  const gap = Math.abs(points);
  if (gap >= 1_000) {
    return "bg-rose-700 text-white ring-1 ring-rose-800 dark:bg-rose-800 dark:ring-rose-700";
  }
  if (gap >= 500) {
    return "bg-rose-400 text-rose-950 ring-1 ring-rose-500 dark:bg-rose-900 dark:text-rose-100 dark:ring-rose-800";
  }
  if (gap >= 150) {
    return "bg-rose-200 text-rose-900 ring-1 ring-rose-300 dark:bg-rose-950/70 dark:text-rose-200 dark:ring-rose-900";
  }
  return "bg-rose-100 text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900";
}

function BreakevenPoints({ points }: { points: number | null }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-11 justify-end rounded px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums",
        breakevenHeatClass(points),
      )}
      data-testid="realized-points-to-breakeven"
    >
      {points == null ? "—" : `${points >= 0 ? "+" : ""}${points.toLocaleString()}`}
    </span>
  );
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
      aria-label="MTM trend over eight weeks"
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
  seasonYear,
  summary,
  mtmData,
  trades,
  consortiumByBidderId,
}: {
  rows: OwnerResultRow[];
  previousRows: OwnerResultRow[];
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
        (a, b) => commandReturn(b) - commandReturn(a),
      ),
    [rows],
  );
  const ranks = useMemo(
    () => new Map(rankedRows.map((row, index) => [row.bidderId, index + 1])),
    [rankedRows],
  );
  const maxReturn = Math.max(
    1,
    ...rows.map((row) => Math.abs(commandReturn(row))),
  );
  const sortedRows = [...filteredRows].sort((a, b) => {
    const previousA = previousById.get(a.bidderId);
    const previousB = previousById.get(b.bidderId);
    const movementA = previousA
      ? commandReturn(a) - commandReturn(previousA)
      : 0;
    const movementB = previousB
      ? commandReturn(b) - commandReturn(previousB)
      : 0;
    const values: Record<CommandSortKey, [number, number]> = {
      return: [commandReturn(a), commandReturn(b)],
      returnPct: [commandReturnPct(a), commandReturnPct(b)],
      cost: [a.totalCost, b.totalCost],
      marketValue: [
        commandMarketValue(a),
        commandMarketValue(b),
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
        ? commandReturn(row) -
          commandReturn(previousById.get(row.bidderId)!)
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
              Live net mark-to-market standings based on the latest complete MTM mark.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4 lg:min-w-[44rem]">
            <CommandMetric label="Teams auctioned" value={String(summary?.teamsAuctioned ?? "—")} />
            <CommandMetric label="Average bid" value={summary ? formatCurrency(summary.avgBidPerTeam) : "—"} />
            <CommandMetric
              label="Leader"
              value={leader ? ownerLabelById(leader.bidderId, leader.bidderName, consortiumByBidderId) : "—"}
               subvalue={leader ? signedCurrency(commandReturn(leader)) : undefined}
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
             value={leader ? commandReturn(leader) : 0}
            consortiumByBidderId={consortiumByBidderId}
          />
          <CommandCallout
            label="Lowest net MTM"
            owner={worst}
             value={worst ? commandReturn(worst) : 0}
            consortiumByBidderId={consortiumByBidderId}
          />
          <div className="p-4">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Coverage
            </p>
            <p className="mt-1 font-mono text-sm font-bold">
               Latest complete mark
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
               Team values and signed consortium allocations share one current MTM source.
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
              <caption className="sr-only">Sortable consortium net mark-to-market standings</caption>
              <thead className="sticky-table-header border-b border-border bg-muted/30">
                <tr>
                  <th className="w-12 px-4 py-3 text-center"><span className="sr-only">Rank</span>#</th>
                  <th className="px-3 py-3 text-left"><SortButton label="Consortium" sort="return" /></th>
                  <th className="px-3 py-3 text-right"><SortButton label="Cost basis" sort="cost" /></th>
                  <th className="px-3 py-3 text-right"><SortButton label="MTM market value" sort="marketValue" /></th>
                  <th className="px-3 py-3 text-right"><SortButton label="Net MTM" sort="return" /></th>
                  <th className="px-3 py-3 text-right"><SortButton label="Net MTM %" sort="returnPct" /></th>
                  <th className="px-3 py-3 text-right"><SortButton label="MTM move" sort="movement" /></th>
                  <th className="w-10 px-3 py-3 text-right"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {sortedRows.map((row) => {
                  const rank = ranks.get(row.bidderId) ?? sortedRows.indexOf(row) + 1;
                  const previous = previousById.get(row.bidderId);
                   const movement = previous
                     ? commandReturn(row) - commandReturn(previous)
                    : null;
                   const returnValue = commandReturn(row);
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
                         {formatCurrency(commandMarketValue(row))}
                      </td>
                      <td className={cn(
                        "px-3 py-3 text-right font-mono text-sm font-bold",
                        returnValue >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                      )}>
                        {signedCurrency(returnValue)}
                      </td>
                      <td className={cn(
                        "px-3 py-3 text-right font-mono text-xs font-bold",
                         commandReturnPct(row) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                      )}>
                         {signedPercent(commandReturnPct(row))}
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
            {sortedRows.length} of {rows.length} consortiums · signed, season-scoped net MTM
          </div>
        </section>

        {selectedOwner ? (
          <DesktopOwnerDetail
            owner={selectedOwner}
            seasonYear={seasonYear}
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
  consortiumByBidderId,
}: {
  label: string;
  owner?: OwnerResultRow;
  value: number;
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
        {owner ? signedPercent(commandReturnPct(owner)) : "Awaiting data"}
      </p>
    </div>
  );
}

function DesktopOwnerDetail({
  owner,
  seasonYear,
  mtmData,
  trades,
  consortiumByBidderId,
  onClose,
  closeButtonRef,
}: {
  owner: OwnerResultRow;
  seasonYear: number;
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
  const ownerTradeGroups = useMemo(
    () =>
      buildTradeGroups(trades.filter((trade) => trade.status === "approved"))
        .filter((group) =>
          group.trades.some(
            (trade) =>
              trade.fromBidderId === owner.bidderId ||
              trade.toBidderId === owner.bidderId,
          ),
        )
        .sort(sortTradeGroups),
    [owner.bidderId, trades],
  );

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
            label="Realized, Net"
            value={signedCurrency(owner.totalNetReturn)}
            tone={owner.totalNetReturn >= 0 ? "positive" : "negative"}
          />
          <DetailMetric
            label="MTM"
            value={signedCurrency(owner.totalNetMtm)}
            tone={owner.totalNetMtm >= 0 ? "positive" : "negative"}
          />
          <DetailMetric label="MTM %" value={signedPercent(commandReturnPct(owner))} tone={commandReturnPct(owner) >= 0 ? "positive" : "negative"} />
        </div>

        <section>
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">MTM Trend</p>
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
            MTM of current positions over last eight weeks
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
                        {formatOwnershipPercent(position)}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px]">
                      <span className="text-muted-foreground">
                        Cost <strong className="text-foreground">{formatCurrency(team.cost)}</strong>
                      </span>
                      <span className="text-muted-foreground">
                        Realized gross <strong className="text-foreground">{formatCurrency(team.realizedReturn)}</strong>
                      </span>
                      <span className="text-muted-foreground">
                        Realized net <strong className={team.netReturn >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>{signedCurrency(team.netReturn)}</strong>
                      </span>
                      <span className="text-muted-foreground">
                        MTM <strong className={team.netMtm >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>{signedCurrency(team.netMtm)}</strong>
                      </span>
                      <span className="text-muted-foreground">
                        Realized pts to BE <BreakevenPoints points={team.ptsToBreakeven} />
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
          {ownerTradeGroups.length === 0 ? (
            <p className="mt-2 border border-dashed border-border p-3 text-xs text-muted-foreground">No finalized trades recorded for this portfolio.</p>
          ) : (
            <div className="mt-2 divide-y divide-border/70 border-y border-border/70">
              {ownerTradeGroups.map((group) => (
                <TradeHistorySummary
                  key={group.key}
                  group={group}
                  ownerId={owner.bidderId}
                  seasonYear={seasonYear}
                  consortiumByBidderId={consortiumByBidderId}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function TradeHistorySummary({
  group,
  ownerId,
  seasonYear,
  consortiumByBidderId,
}: {
  group: TradeGroup;
  ownerId: number;
  seasonYear: number;
  consortiumByBidderId: Map<number, string>;
}) {
  const firstTrade = group.trades[0];
  const title =
    group.trades.length > 1
      ? sharedTradeDescription(firstTrade.notes) || "Trade transaction"
      : firstTrade.teamName;
  const totalValue = group.trades.reduce((total, trade) => total + trade.price, 0);
  const teamNames = [...new Set(group.trades.map((trade) => trade.teamName))];
  const bought = firstTrade.toBidderId === ownerId;
  const fromLabel = ownerLabelById(
    firstTrade.fromBidderId,
    firstTrade.fromBidderName,
    consortiumByBidderId,
  );
  const toLabel = ownerLabelById(
    firstTrade.toBidderId,
    firstTrade.toBidderName,
    consortiumByBidderId,
  );

  return (
    <Link
      href={tradeHref(seasonYear, firstTrade.id)}
      data-trade-group={group.key}
      className="block space-y-1.5 py-2.5 transition-colors hover:bg-muted/40 focus:outline-none focus:ring-1 focus:ring-primary"
    >
      <div className="flex items-start justify-between gap-2 text-xs">
        <span className="font-bold">{title}</span>
        <span className="shrink-0 font-mono">{formatCurrency(totalValue)}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono">
        <span className="font-bold uppercase tracking-widest">{bought ? "Bought" : "Sold"}</span>
        <ConsortiumLabel className="min-w-0" label={fromLabel} />
        <span aria-hidden="true">→</span>
        <ConsortiumLabel className="min-w-0" label={toLabel} />
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
        <span>Teams: {teamNames.join(", ")}</span>
        {group.trades.length > 1 && <span>{group.trades.length} legs</span>}
      </div>
    </Link>
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

function calculateTeamExposure(team: TeamResultRow): number {
  const position = team.owners[0]?.ownershipShare ?? 0;
  if (Math.abs(position) < 0.00005) return 0;

  const exposure = position > 0 ? team.cost : -team.cost;
  return Math.round(exposure * 100) / 100;
}

/**
 * Results returns the complete set of signed owner positions, including
 * shorts, directly on each team row.
 */
function effectivePositionsForTeam(
  team: Pick<TeamResultRow, "owners">,
) {
  return team.owners;
}

const OWNER_SUMMARY_GRID =
  "grid-cols-[2rem_minmax(0,1fr)_auto_2rem] md:grid-cols-[2.5rem_minmax(14rem,22rem)_minmax(0,1fr)_4.5rem_8rem_8rem_2.5rem]";
const OWNER_TEAM_GRID =
  "grid-cols-[1fr_auto] md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_6.5rem_8rem_8rem]";

function ByOwnerView({
  rows,
  expandedOwner,
  setExpandedOwner,
  consortiumByBidderId,
  seasonYear,
}: {
  rows: OwnerResultRow[];
  expandedOwner: number | null;
  setExpandedOwner: (id: number | null) => void;
  consortiumByBidderId: Map<number, string>;
  seasonYear: number;
}) {
  if (!rows.length) return <Empty />;

  // Net MTM is the fixed, live consortium standing metric.
  const sorted = [...rows].sort((a, b) =>
    b.totalNetMtm - a.totalNetMtm,
  );

  return (
    <div className="space-y-3">
      {/* Summary header */}
      <div
        className={cn(
          "hidden md:grid bg-muted/60 text-muted-foreground text-[10px] md:text-xs font-mono font-bold uppercase tracking-widest px-4 py-3 border border-border sticky top-0 z-10 backdrop-blur rounded-t-lg",
          OWNER_SUMMARY_GRID,
        )}
      >
        <div className="text-center">#</div>
        <div>Consortium</div>
        <div className="hidden md:block" />
        <div className="text-right">Net Teams</div>
        <div className="text-right font-bold text-foreground">Net MTM</div>
        <div className="text-right">Exposure</div>
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
                  OWNER_SUMMARY_GRID,
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
                  <div>
                    <div className="text-muted-foreground uppercase tracking-widest text-[10px]">Exposure</div>
                    <div className="font-bold">{formatCurrency(calculateExposure(row))}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground uppercase tracking-widest text-[10px]">Net MTM %</div>
                    <div className="font-bold">
                      {calculateExposure(row) !== 0
                        ? ((row.totalNetMtm / Math.abs(calculateExposure(row))) * 100).toFixed(1) + "%"
                        : "—"}
                    </div>
                  </div>
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
                    <div>Type</div>
                    <div className="text-right">Net Position</div>
                    <div className="text-right">Net MTM</div>
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
          {signedCurrency(team.netMtm)} net MTM
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
      <div className="col-span-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border/50 pt-2 font-mono text-[10px] text-muted-foreground md:hidden">
        <span>Cost <strong className="text-foreground">{formatCurrency(team.cost)}</strong></span>
        <span>Realized gross <strong className="text-foreground">{formatCurrency(team.realizedReturn)}</strong></span>
        <span>Realized net <strong className={team.netReturn >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>{signedCurrency(team.netReturn)}</strong></span>
        <span>Realized pts to BE <BreakevenPoints points={team.ptsToBreakeven} /></span>
      </div>

      <div
        className={cn(
          "hidden md:block text-right font-mono text-sm font-bold",
          netPosition >= 0 ? "text-sky-700 dark:text-sky-400" : "text-rose-600 dark:text-rose-400",
        )}
      >
        {formatOwnershipPercent(netPosition, true)}
      </div>
      <div
        className={cn(
          "hidden md:block text-right font-mono text-sm",
          team.netMtm >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
        )}
      >
        {team.netMtm !== 0
          ? signedCurrency(team.netMtm)
          : "—"}
      </div>
      <div className="hidden md:block text-right font-mono text-sm text-muted-foreground">
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
  // financials (calculated per signed owner position by the API)
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
        cost: owner.cost,
        gross: owner.realizedGross,
        net: owner.net,
        mtm: owner.mtmNet,
        ptsToBreakeven: owner.ptsToBreakeven,
      });
    }
  }
  return result;
}

function ByTeamView({
  rows,
  consortiumByBidderId,
  seasonYear,
}: {
  rows: TeamResultRow[];
  consortiumByBidderId: Map<number, string>;
  seasonYear: number;
}) {
  const [splitByOwner, setSplitByOwner] = useState(true);
  const [sortKey, setSortKey] = useState<BTSortKey>("net");
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
                <SH label="Net MTM" k="mtm" />
              </th>
               <th className="px-4 md:px-5 py-3 text-right">
                  <span>Realized Pts to BE</span>
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
                     <td className="px-4 md:px-5 py-3 text-right">
                       <BreakevenPoints points={row.ptsToBreakeven} />
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
                      <td className="px-4 md:px-5 py-3 text-right">
                        <BreakevenPoints points={row.ptsToBreakeven} />
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] md:text-xs text-muted-foreground font-mono">
        {rowCount} {splitByOwner ? "owner-team rows" : "teams"} ·{" "}
         Realized columns and points to breakeven use realized snapshots; net MTM uses the latest complete mark.
      </p>
    </div>
  );
}

// ─── Compare ──────────────────────────────────────────────────────────────────

function CompareView({
  response,
}: {
  response: CalcuttaComparisonResponse | undefined;
}) {
  if (!response || !response.rows.length) return <Empty />;

  // Comparison stays a live net-MTM view.
  const sorted = [...response.rows].sort((a, b) =>
    b.aggregate.totalNetMtm - a.aggregate.totalNetMtm
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
                <div className="mt-1 text-[10px] text-primary">Net MTM</div>
              </th>
            ))}
            <th className="px-4 py-3 font-bold border-b border-border/60 text-right bg-muted/50">
              Net MTM aggregate
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
                  {cell ? <CompareCell cell={cell} /> : <span className="text-muted-foreground/40">—</span>}
                </td>
              ))}
              <td className="px-4 py-4 text-right bg-muted/10 font-bold align-top">
                <CompareAggregate aggregate={row.aggregate} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompareCell({ cell }: { cell: CalcuttaComparisonCell }) {
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
          cell.totalNetMtm >= 0
            ? "text-green-600 dark:text-green-400"
            : "text-red-600 dark:text-red-400",
        )}
      >
        {signedCurrency(cell.totalNetMtm)}
      </div>
      <div className="text-[10px] text-muted-foreground flex gap-2">
        <span title="Exposure / Cost Basis">Exp: {formatCurrency(cell.exposure)}</span>
        <span title="Net Teams">Tms: {cell.teamCount > 0 ? "+" : ""}{cell.teamCount.toFixed(2)}</span>
      </div>
    </div>
  );
}

function CompareAggregate({ aggregate }: { aggregate: CalcuttaComparisonAggregate }) {
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
          aggregate.totalNetMtm >= 0
            ? "text-green-600 dark:text-green-400"
            : "text-red-600 dark:text-red-400",
        )}
      >
        {signedCurrency(aggregate.totalNetMtm)}
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
