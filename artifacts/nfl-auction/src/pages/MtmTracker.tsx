import { useEffect, useRef, useState } from "react";
import {
  useGetTeams,
  useCaptureWeekZeroMtm,
  useGetBidders,
  useGetMtmValuation,
  getGetMtmValuationQueryKey,
} from "@workspace/api-client-react";
import type {
  MtmData,
  MtmWeekData,
  MtmTeamWeekMarketStatus,
  MtmValuation,
  MtmValuationTeamsItem,
  MtmGameEvSwing,
  MtmTeamEvSwing,
  MtmOwnerTeamEvSwing,
  MtmQualityExposure,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useSeason } from "@/hooks/useSeason";
import { useMeasure } from "@/hooks/useMeasure";
import { trackEvent } from "@/lib/analytics";
import { TrendingUp, TrendingDown, Lock, Unlock, Plus, X, ChevronDown, ChevronUp, Activity, AlertTriangle, ShieldCheck, Zap, Info, ServerOff, RefreshCw, Search, ListFilter, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  bidderConsortiumsByName,
  combinedOwnerLabel,
  ownerLabel,
} from "@/lib/ownerDisplay";
import { ConsortiumLabel } from "@/components/ConsortiumLabel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { momentumBaselineNetPayout } from "@/lib/mtmMomentum";

const OWNER_COLORS = [
  "#3b82f6", // blue
  "#10b981", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // purple
  "#06b6d4", // cyan
  "#f97316", // orange
];

// ── Auth-gated MTM upsert (requires ADMIN_API_KEY as Bearer token) ─────────────

async function upsertMtmSnapshot(
  payload: { teamId: number; seasonYear: number; calcuttaId?: number; weekNum?: number; mtmValue: number; snapshotDate?: string },
  adminKey: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/mtm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) return { ok: false, error: "Invalid admin key" };
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

type PipelineOwnerValue = {
  name: string;
  share: number;
  bookValue: number;
};

const NFL_PRIMARY_COLOR_BY_TEAM: Record<string, string> = {
  "Arizona Cardinals": "#97233F",
  "Atlanta Falcons": "#A71930",
  "Baltimore Ravens": "#241773",
  "Buffalo Bills": "#00338D",
  "Carolina Panthers": "#0085CA",
  "Chicago Bears": "#0B162A",
  "Cincinnati Bengals": "#FB4F14",
  "Cleveland Browns": "#311D00",
  "Dallas Cowboys": "#003594",
  "Denver Broncos": "#FB4F14",
  "Detroit Lions": "#0076B6",
  "Green Bay Packers": "#203731",
  "Houston Texans": "#03202F",
  "Indianapolis Colts": "#002C5F",
  "Jacksonville Jaguars": "#006778",
  "Kansas City Chiefs": "#E31837",
  "Las Vegas Raiders": "#000000",
  "Los Angeles Chargers": "#0080C6",
  "Los Angeles Rams": "#003594",
  "Miami Dolphins": "#008E97",
  "Minnesota Vikings": "#4F2683",
  "New England Patriots": "#002244",
  "New Orleans Saints": "#D3BC8D",
  "New York Giants": "#0B2265",
  "New York Jets": "#125740",
  "Philadelphia Eagles": "#004C54",
  "Pittsburgh Steelers": "#FFB612",
  "San Francisco 49ers": "#AA0000",
  "Seattle Seahawks": "#002244",
  "Tampa Bay Buccaneers": "#D50A0A",
  "Tennessee Titans": "#0C2340",
  "Washington Commanders": "#5A1414",
};

const NFL_ABBREVIATION_BY_TEAM: Record<string, string> = {
  "Arizona Cardinals": "ARI",
  "Atlanta Falcons": "ATL",
  "Baltimore Ravens": "BAL",
  "Buffalo Bills": "BUF",
  "Carolina Panthers": "CAR",
  "Chicago Bears": "CHI",
  "Cincinnati Bengals": "CIN",
  "Cleveland Browns": "CLE",
  "Dallas Cowboys": "DAL",
  "Denver Broncos": "DEN",
  "Detroit Lions": "DET",
  "Green Bay Packers": "GB",
  "Houston Texans": "HOU",
  "Indianapolis Colts": "IND",
  "Jacksonville Jaguars": "JAX",
  "Kansas City Chiefs": "KC",
  "Las Vegas Raiders": "LV",
  "Los Angeles Chargers": "LAC",
  "Los Angeles Rams": "LAR",
  "Miami Dolphins": "MIA",
  "Minnesota Vikings": "MIN",
  "New England Patriots": "NE",
  "New Orleans Saints": "NO",
  "New York Giants": "NYG",
  "New York Jets": "NYJ",
  "Philadelphia Eagles": "PHI",
  "Pittsburgh Steelers": "PIT",
  "San Francisco 49ers": "SF",
  "Seattle Seahawks": "SEA",
  "Tampa Bay Buccaneers": "TB",
  "Tennessee Titans": "TEN",
  "Washington Commanders": "WAS",
};

type PipelineValuation = {
  entryId: number;
  teamId: number | null;
  teamName: string;
  expectedPoints: string;
  expectedPayout: string;
  previousExpectedPayout: string | null;
  auctionPrice: string | null;
  mtmMultiple: string | null;
  history: Array<{
    snapshotId: number;
    label: string;
    asOf: string;
    expectedPayout: number;
    auctionPrice: number | null;
    netPayout: number | null;
  }>;
  owners: PipelineOwnerValue[];
};

type PipelineStatus = {
  id: number;
  currentSnapshotId: number | null;
  asOf: string;
  currentAsOf: string | null;
  status: "ok" | "failed";
  error: string | null;
  stale: boolean;
  staleReasons: string[];
  diagnostics: Record<string, unknown> | null;
  valuations: PipelineValuation[];
};

export function visiblePipelineHistory(
  status: PipelineStatus | null,
  valuation: Pick<MtmValuation, "available" | "mark" | "teams">,
): PipelineValuation[] {
  const suppressedCurrentSnapshotId = valuation.available || valuation.teams.length > 0
    ? null
    : valuation.mark.sourceSnapshotId;

  return (status?.valuations ?? [])
    .map((item) => ({
      ...item,
      history: item.history.filter(
        (point) => point.snapshotId !== suppressedCurrentSnapshotId,
      ),
    }))
    .filter((item) => item.history.length > 0);
}

type MtmPipelineAttempt = {
  id: number;
  status: "ok" | "failed" | "running";
  trigger: "scheduled" | "manual";
  asOf: string;
  createdAt: string;
  methodVersion: string | null;
  error: string | null;
  quoteCount: number;
  deletable: boolean;
  deleteBlockedReason: string | null;
};

type ManualRecalculationStatus = {
  running: boolean;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  currentSnapshotId: number | null;
};

type MtmPipelineReceivedMarket = {
  series: string;
  quoteCount: number;
  teams: string[];
};

type MtmPipelineEvidenceQuote = {
  series: string;
  ticker: string;
  team: string | null;
  strike: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  fetchedAt: string;
};

type MtmPipelineEliminationEvidence = {
  ticker: string;
  team: string;
  outcome: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  confidenceTier: "settled_fact" | "strong_active_book" | "verified_trade" | "last_context" | "active_book";
  fittedProbability: number | null;
  intervalMiss: number | null;
  nearPublicationCeiling: boolean;
};

type MtmPipelineEvidenceResponse = {
  attempts: MtmPipelineAttempt[];
  selectedAttempt: (MtmPipelineAttempt & {
    diagnostics: Record<string, unknown> | null;
    receivedMarkets: MtmPipelineReceivedMarket[];
    failedSources: string[];
    eliminationEvidence: MtmPipelineEliminationEvidence[];
    quotes: MtmPipelineEvidenceQuote[];
  }) | null;
};

function useGetMtmPipelineEvidence(
  params: { season: number; calcuttaId?: number; attemptId?: number },
  options: {
    query: { enabled: boolean; queryKey: readonly unknown[] };
    request: { headers: Record<string, string> };
  },
) {
  return useQuery<MtmPipelineEvidenceResponse>({
    queryKey: options.query.queryKey,
    enabled: options.query.enabled,
    queryFn: () => fetchMtmPipelineEvidence(params, options.request.headers),
  });
}

async function fetchMtmPipelineEvidence(
  params: { season: number; calcuttaId?: number; attemptId?: number },
  headers: Record<string, string>,
) {
  const search = new URLSearchParams({ season: String(params.season) });
  if (params.calcuttaId != null) search.set("calcuttaId", String(params.calcuttaId));
  if (params.attemptId != null) search.set("attemptId", String(params.attemptId));
  const response = await fetch(`/api/mtm/pipeline/evidence?${search}`, { headers });
  if (!response.ok) throw new Error("Unable to load MTM evidence.");
  return response.json() as Promise<MtmPipelineEvidenceResponse>;
}

function getGetMtmPipelineEvidenceQueryKey(
  params: { season: number; calcuttaId?: number; attemptId?: number },
) {
  return ["/api/mtm/pipeline/evidence", params] as const;
}

function formatMtmTimestamp(value: string | null | undefined): string {
  if (!value) return "not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "not available"
    : date.toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function MtmQualitySummary({
  quality,
}: {
  quality?: MtmQualityExposure | null;
}) {
  if (!quality) return null;
  const statusLabel = quality.status === "estimated-degraded"
    ? "Estimated · degraded"
    : quality.status === "stale-pending"
      ? "Stale · pending recalculation"
      : quality.status === "unavailable"
        ? "Unavailable"
        : "Official";
  return (
    <div
      className="border-b border-border bg-muted/20 px-4 py-3"
      data-testid="mtm-quality-summary"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Mark quality
        </span>
        <span
          className={cn(
            "font-mono text-xs font-bold uppercase",
            quality.status === "official" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300",
          )}
          data-testid="mtm-quality-status"
        >
          {statusLabel}
        </span>
      </div>
      {quality.reasons.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
          {quality.reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
      <div className="mt-2 grid gap-x-5 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
        <span>Actuals cutoff: {formatMtmTimestamp(quality.actualsCutoff)}</span>
        <span>Evidence cutoff: {formatMtmTimestamp(quality.evidenceCutoff)}</span>
        <span>Mark timestamp: {formatMtmTimestamp(quality.markTimestamp)}</span>
        <span>Model: {quality.modelVersion ?? "not available"}</span>
        <span>Policy: {quality.policyVersion ?? "not available"}</span>
        <span>Final ESS: {quality.finalEffectiveSampleSize == null ? "not available" : quality.finalEffectiveSampleSize.toFixed(1)}</span>
        <span>Final max weight: {quality.finalMaxWeight == null ? "not available" : quality.finalMaxWeight.toFixed(3)}</span>
        <span>Precision: {quality.precision == null ? "not available" : quality.precision.toFixed(3)}</span>
      </div>
      {(quality.priorModelVersion || quality.dominantEvidence || quality.excludedEvidence.length > 0) && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-mono text-[10px] font-bold uppercase tracking-wider">
            Evidence and version details
          </summary>
          <div className="mt-2 space-y-1">
            {quality.priorModelVersion && <p>Prior model: {quality.priorModelVersion}</p>}
            {quality.dominantEvidence && (
              <p>Dominant evidence: {quality.dominantEvidence.id} (weight {quality.dominantEvidence.weight?.toFixed(3) ?? "not available"})</p>
            )}
            {quality.excludedEvidence.length > 0 && (
              <p>Excluded evidence: {quality.excludedEvidence.map((item) => `${item.id} — ${item.reason}`).join("; ")}</p>
            )}
          </div>
        </details>
      )}
      {quality.prefitDiagnostics.available && (
        <p className="mt-2 text-[10px] italic text-muted-foreground">
          {quality.prefitDiagnostics.label}
        </p>
      )}
    </div>
  );
}

export function AdminMtmDiagnostics({
  isAdmin,
  quality,
  status,
  mark,
}: {
  isAdmin: boolean;
  quality?: MtmQualityExposure | null;
  status: PipelineStatus | null;
  mark: MtmValuation["mark"];
}) {
  if (!isAdmin) return null;

  return (
    <>
      <MtmQualitySummary quality={quality} />
      <PipelineFailureNotice status={status} />
      {(mark.stale || mark.selectionReason || mark.provisionalSuppressionReason) && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {mark.stale ? "The current mark is stale." : "Mark selection notice"}
          </p>
          <ul className="mt-1 list-disc pl-6 text-xs">
            {mark.selectionReason && <li>{mark.selectionReason}</li>}
            {mark.provisionalSuppressionReason && <li>{mark.provisionalSuppressionReason}</li>}
          </ul>
        </div>
      )}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MtmTracker() {
  const { year, selectedCalcutta } = useSeason();
  const isNflCalcutta = selectedCalcutta?.sport === "NFL";
  const calcuttaId = isNflCalcutta ? selectedCalcutta.id : undefined;
  const { data: bidders } = useGetBidders({});
  const consortiumByName = bidderConsortiumsByName(bidders);
  const [adminKey, setAdminKey] = useState<string | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [manualRun, setManualRun] = useState<ManualRecalculationStatus | null>(null);

  const { data: valuation, isLoading: valuationLoading, refetch: refetchValuation } = useGetMtmValuation(
    { season: year, calcuttaId, markType: "provisional" },
    {
      query: {
        enabled: isNflCalcutta && !!calcuttaId,
        queryKey: getGetMtmValuationQueryKey({ season: year, calcuttaId, markType: "provisional" }),
      },
    },
  );

  async function loadPipelineStatus() {
    if (!isNflCalcutta) {
      setPipelineStatus(null);
      return;
    }
    setPipelineLoading(true);
    try {
      const params = new URLSearchParams({ season: String(year) });
      if (calcuttaId) params.set("calcuttaId", String(calcuttaId));
      const response = await fetch(`/api/mtm/pipeline/status?${params}`);
      if (!response.ok) throw new Error("Unable to load the in-season MTM mark.");
      const payload = await response.json() as { status: PipelineStatus | null };
      setPipelineStatus(payload.status);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load the in-season MTM mark.");
    } finally {
      setPipelineLoading(false);
    }
  }

  useEffect(() => {
    void loadPipelineStatus();
  }, [year, calcuttaId, isNflCalcutta]);

  async function recalculatePipeline() {
    if (!adminKey) return;
    setPipelineRunning(true);
    try {
      const response = await fetch("/api/mtm/pipeline/recalc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminKey}`,
        },
        body: JSON.stringify({ season: year, calcuttaId }),
      });
      const payload = await response.json().catch(() => null) as ManualRecalculationStatus | null;
      if (response.status === 401) {
        clearAdminKey();
        throw new Error("Admin key rejected. Unlock commissioner controls again.");
      }
      if (!response.ok) throw new Error(payload?.error ?? "MTM recalculation failed.");
      setManualRun(payload);
      toast.info("Recalculation started. This page will update when it finishes.");
      const params = new URLSearchParams({ season: String(year) });
      if (calcuttaId) params.set("calcuttaId", String(calcuttaId));
      const deadline = Date.now() + 20 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        const statusResponse = await fetch(`/api/mtm/pipeline/recalc/status?${params}`, {
          headers: { Authorization: `Bearer ${adminKey}` },
        });
        const run = await statusResponse.json().catch(() => null) as ManualRecalculationStatus | null;
        if (statusResponse.status === 401) {
          clearAdminKey();
          throw new Error("Admin key rejected. Unlock commissioner controls again.");
        }
        if (!statusResponse.ok) {
          throw new Error(run?.error ?? "Unable to check recalculation status.");
        }
        setManualRun(run);
        if (run?.running) continue;
        if (run?.error) throw new Error(run.error);
        trackEvent("live_tracker_recalculated", {
          outcome: "success",
          year,
        });
        toast.success("Actuals and in-season MTM mark refreshed.");
        await loadPipelineStatus();
        void refetchValuation();
        return;
      }
      throw new Error("Recalculation is still running. Refresh Analysis in a few minutes.");
    } catch (error) {
      trackEvent("live_tracker_recalculated", {
        outcome: "failed",
        year,
      });
      toast.error(error instanceof Error ? error.message : "MTM recalculation failed.");
      await loadPipelineStatus();
    } finally {
      setPipelineRunning(false);
    }
  }

  async function saveAdminKey(key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch("/api/admin/validate", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (response.status === 401) return { ok: false, error: "Invalid admin key" };
      if (!response.ok) return { ok: false, error: "Could not validate admin key" };
      setAdminKey(key);
      return { ok: true };
    } catch {
      return { ok: false, error: "Network error while validating admin key" };
    }
  }

  function clearAdminKey() {
    setAdminKey(null);
  }

  return (
    <div className="space-y-5 px-4 pb-6 pt-4 md:space-y-6 md:p-8 max-w-5xl mx-auto">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-1" data-testid="text-mtm-title">Analysis</h1>
          <p className="text-muted-foreground font-mono text-xs md:text-sm uppercase tracking-widest">
            Current team and consortium values · {year}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <AdminPanel adminKey={adminKey} onSetKey={saveAdminKey} onClearKey={clearAdminKey} />
        </div>
      </header>

      {isNflCalcutta && (
        <PipelineMarkPanel
          valuation={valuation}
          valuationLoading={valuationLoading}
          status={pipelineStatus}
          loading={pipelineLoading}
          running={pipelineRunning}
          canRecalculate={Boolean(adminKey)}
          onRecalculate={() => void recalculatePipeline()}
          consortiumByName={consortiumByName}
        />
      )}

      {isNflCalcutta && adminKey && (
        <section className="overflow-hidden border border-border bg-card">
          <div className="border-b border-border p-4">
            <h2 className="font-mono text-sm font-bold uppercase tracking-widest">
              MTM update history
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Review prior updates and permanently remove a bad non-current update from Momentum history.
            </p>
          </div>
          <MtmEvidenceInspector
            year={year}
            calcuttaId={calcuttaId}
            adminKey={adminKey}
            manualRun={manualRun}
            onDeleted={async () => {
              await loadPipelineStatus();
              await refetchValuation();
            }}
          />
        </section>
      )}

    </div>
  );
}

function PipelineMarkPanel({
  valuation,
  valuationLoading,
  status,
  loading,
  running,
  canRecalculate,
  onRecalculate,
  consortiumByName,
}: {
  valuation?: MtmValuation;
  valuationLoading: boolean;
  status: PipelineStatus | null;
  loading: boolean;
  running: boolean;
  canRecalculate: boolean;
  onRecalculate: () => void;
  consortiumByName: Map<string, string>;
}) {
  type SortKey = "team" | "owner" | "points" | "payout" | "price" | "multiple" | "momentum";
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("payout");
  const [sortAsc, setSortAsc] = useState(false);

  if (valuationLoading && !valuation) {
    return (
      <section className="border border-border bg-card p-5 text-sm font-mono text-muted-foreground">
        Loading in-season MTM status…
      </section>
    );
  }
  if (!valuation) {
    return (
      <section className="border border-dashed border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-xs font-bold uppercase tracking-widest">Latest Mark</p>
            <p className="mt-1 text-sm text-muted-foreground">No complete MTM mark has been recorded for this pool.</p>
          </div>
          <button
            type="button"
            disabled={!canRecalculate || running}
            onClick={onRecalculate}
            className="inline-flex items-center gap-2 border border-primary px-3 py-2 font-mono text-xs font-bold uppercase tracking-widest text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw className={cn("h-4 w-4", running && "animate-spin")} />
            Calculate mark
          </button>
        </div>
      </section>
    );
  }

  function ownerText(teamId: number | null | undefined) {
    const pipelineTeam = status?.valuations.find(v => v.teamId === teamId || v.entryId === teamId);
    if (!pipelineTeam) return "—";
    return (pipelineTeam.owners ?? [])
      .map((owner) => combinedOwnerLabel(owner.name, consortiumByName))
      .join(" / ");
  }

  function momentumBaseline(teamId: number | null | undefined) {
    const pipelineTeam = status?.valuations.find(v => v.teamId === teamId || v.entryId === teamId);
    return momentumBaselineNetPayout(pipelineTeam?.history ?? []);
  }

  const baseItems = valuation?.teams ?? [];

  const query = search.trim().toLowerCase();
  const filtered = baseItems.filter((team) =>
    !query ||
    (team.teamName || "").toLowerCase().includes(query) ||
    ownerText(team.teamId).toLowerCase().includes(query)
  );
  const chartValuations = visiblePipelineHistory(status, valuation).filter((item) =>
    !query ||
    item.teamName.toLowerCase().includes(query) ||
    item.owners.some((owner) =>
      combinedOwnerLabel(owner.name, consortiumByName).toLowerCase().includes(query),
    ),
  );

  const displayTeams = [...filtered].sort((a, b) => {
    const netA = a.net ?? null;
    const netB = b.net ?? null;
    const priorNetA = momentumBaseline(a.teamId);
    const priorNetB = momentumBaseline(b.teamId);
    const priceA = a.auctionPrice ?? null;
    const priceB = b.auctionPrice ?? null;
    const multipleA = priceA && priceA > 0 ? (a.grossExpectedPayout / priceA) : null;
    const multipleB = priceB && priceB > 0 ? (b.grossExpectedPayout / priceB) : null;

    const values: Record<Exclude<SortKey, "team" | "owner" | "points">, [number, number]> = {
      payout: [netA ?? -Infinity, netB ?? -Infinity],
      price: [priceA ?? -Infinity, priceB ?? -Infinity],
      multiple: [multipleA ?? -Infinity, multipleB ?? -Infinity],
      momentum: [
        netA == null || priorNetA == null ? -Infinity : netA - priorNetA,
        netB == null || priorNetB == null ? -Infinity : netB - priorNetB,
      ],
    };

    let difference = 0;
    if (sortKey === "team") {
      difference = (a.teamName || "").localeCompare(b.teamName || "");
    } else if (sortKey === "owner") {
      difference = ownerText(a.teamId).localeCompare(ownerText(b.teamId));
    } else if (sortKey === "points") {
      // Points not strictly in normalized teams, using grossExpectedPayout to sort since it correlates
      difference = a.grossExpectedPayout - b.grossExpectedPayout;
    } else {
      difference = values[sortKey as Exclude<SortKey, "team" | "owner" | "points">][0] - values[sortKey as Exclude<SortKey, "team" | "owner" | "points">][1];
    }
    return sortAsc ? difference : -difference;
  });

  const netPayouts = baseItems
    .map(t => t.net)
    .filter((value): value is number => value != null);
  const maxPayout = Math.max(0, ...netPayouts);
  const minPayout = Math.min(0, ...netPayouts);
  const payoutRange = Math.max(1, maxPayout - minPayout);

  const allMultiples = baseItems.map(t => (t.auctionPrice && t.auctionPrice > 0 ? t.grossExpectedPayout / t.auctionPrice : 1));
  const maxMultiple = Math.max(1, ...allMultiples);

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((value) => !value);
    else {
      setSortKey(key);
      setSortAsc(key === "team" || key === "owner");
    }
  }

  function SortButton({ label, value }: { label: string; value: SortKey }) {
    const active = sortKey === value;
    return (
      <button
        type="button"
        onClick={() => handleSort(value)}
        className={cn(
          "inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider hover:text-foreground",
          active ? "text-primary" : "text-muted-foreground",
        )}
      >
        {label}
        {active && <span aria-hidden="true">{sortAsc ? "↑" : "↓"}</span>}
      </button>
    );
  }

  return (
    <section className="border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="font-mono text-sm font-bold uppercase tracking-widest">
              Latest Mark
            </h2>
            {valuation.mark.approximate && (
              <span className="bg-amber-100 text-amber-800 px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase rounded-sm">
                Approximate
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            As of: {valuation.mark.asOf
              ? new Date(valuation.mark.asOf).toLocaleString("en-US", {
                  timeZone: "America/New_York",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "not available"}
          </p>
        </div>
        <button
          type="button"
          disabled={!canRecalculate || running}
          onClick={onRecalculate}
          title={canRecalculate ? "Recalculate from current evidence" : "Unlock commissioner controls to recalculate"}
          className="inline-flex items-center gap-2 border border-primary px-3 py-2 font-mono text-xs font-bold uppercase tracking-widest text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw className={cn("h-4 w-4", running && "animate-spin")} />
          {running ? "Calculating" : "Recalculate"}
        </button>
      </div>

      <AdminMtmDiagnostics
        isAdmin={canRecalculate}
        quality={valuation.quality}
        status={status}
        mark={valuation.mark}
      />

      {valuation.diagnostics?.market_drift?.recommendsRerun && canRecalculate && (
        <div className="border-b border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
          <p className="flex items-center gap-2 font-semibold">
            <Activity className="h-4 w-4 shrink-0" />
            Market drift detected
          </p>
          <p className="mt-1 text-xs">
            The underlying market probability has drifted significantly. A recalculation is recommended to update the provisional mark.
            {valuation.diagnostics.market_drift.maxDrift && ` Max drift: ${(valuation.diagnostics.market_drift.maxDrift * 100).toFixed(1)}%`}
          </p>
        </div>
      )}

      {chartValuations.length > 0 && (
        <div className="border-b border-border p-4">
          <div className="mb-3">
            <h3 className="font-mono text-xs font-bold uppercase tracking-widest">Lot values over time</h3>
          </div>
          <NetPayoutHistoryChart valuations={chartValuations} />
        </div>
      )}

      <div className="border-b border-border p-4">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="font-mono text-xs font-bold uppercase tracking-widest">By team standings</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Current expected payout, auction price, multiple, and change from the prior mark.
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Gross payout is the expected pool return; net payout is gross minus auction cost. Owner exposure keeps signed shares.
                </p>
              </div>
              <label className="relative block sm:w-72">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <span className="sr-only">Filter MTM rows</span>
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter team or consortium…"
                  className="w-full border border-border bg-background py-2 pl-8 pr-3 font-mono text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </label>
        </div>
      </div>

      {displayTeams.length > 0 ? (
        <>
          <div className="table-scroll">
          <table className="w-full min-w-[940px] text-sm">
            <caption className="sr-only">Sortable latest MTM values by team</caption>
            <thead className="sticky-table-header border-b border-border bg-muted/40 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="sticky left-0 z-20 bg-muted px-4 py-2 text-left shadow-[1px_0_0_hsl(var(--border))]"><SortButton label="Team" value="team" /></th>
                <th className="px-3 py-2 text-left"><SortButton label="Consortium" value="owner" /></th>
                <th className="px-3 py-2 text-right"><SortButton label="Gross payout" value="points" /></th>
                <th className="px-3 py-2 text-right"><SortButton label="Net payout" value="payout" /></th>
                <th className="px-3 py-2 text-right"><SortButton label="Auction price" value="price" /></th>
                <th className="px-3 py-2 text-right"><SortButton label="Multiple" value="multiple" /></th>
                <th className="px-4 py-2 text-right">
                  <span className="inline-flex items-center justify-end gap-1">
                    <SortButton label="Momentum" value="momentum" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="About Momentum"
                          className="inline-flex text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          <Info className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Change, Last 7 Days</TooltipContent>
                    </Tooltip>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {displayTeams.map((teamItem) => {
                const price = teamItem.auctionPrice ?? null;
                const payout = teamItem.net ?? null;
                const previousPayout = momentumBaseline(teamItem.teamId);
                const delta = payout == null || previousPayout == null
                  ? null
                  : payout - previousPayout;
                const roundedDelta = delta == null ? null : Math.round(delta);
                const multiple = price && price > 0 ? (teamItem.grossExpectedPayout / price) : null;
                const payoutIntensity = payout == null ? 0 : Math.abs(payout) / Math.max(1, Math.max(Math.abs(minPayout), Math.abs(maxPayout)));
                const multipleIntensity = multiple == null
                  ? 0
                  : multiple < 1
                    ? Math.min(1, 1 - multiple)
                    : Math.min(1, (multiple - 1) / Math.max(0.01, maxMultiple - 1));
                return (
                  <tr key={teamItem.entryId}>
                    <td className="sticky left-0 z-10 bg-background px-4 py-2 font-semibold shadow-[1px_0_0_hsl(var(--border))]">{teamItem.teamName}</td>
                    <td className="max-w-[18rem] px-3 py-2 text-xs text-muted-foreground">
                      {ownerText(teamItem.teamId)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(teamItem.grossExpectedPayout)}</td>
                    <td
                      className="px-3 py-2 text-right font-mono font-semibold"
                      style={{
                        backgroundColor: payout == null
                          ? undefined
                          : payout < 0
                            ? `rgba(239, 68, 68, ${0.06 + payoutIntensity * 0.36})`
                            : `rgba(16, 185, 129, ${0.06 + payoutIntensity * 0.36})`,
                      }}
                    >
                      {payout == null ? "—" : formatCurrency(payout)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{price == null ? "—" : formatCurrency(price)}</td>
                    <td
                      className="px-3 py-2 text-right font-mono font-semibold"
                      style={{
                        backgroundColor: multiple == null || Math.abs(multiple - 1) < 0.005
                          ? undefined
                          : multiple < 1
                            ? `rgba(239, 68, 68, ${0.08 + multipleIntensity * 0.42})`
                            : `rgba(16, 185, 129, ${0.08 + multipleIntensity * 0.42})`,
                      }}
                    >
                      {multiple == null ? "—" : `${multiple.toFixed(2)}×`}
                    </td>
                    <td className={cn(
                      "px-4 py-2 text-right font-mono font-semibold",
                      roundedDelta != null && roundedDelta > 0 && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                      roundedDelta != null && roundedDelta < 0 && "bg-red-500/15 text-red-700 dark:text-red-300",
                      roundedDelta === 0 && "text-muted-foreground",
                    )}>
                      {delta == null
                        ? "—"
                        : roundedDelta === 0
                          ? formatCurrency(0)
                          : `${roundedDelta! > 0 ? "+" : ""}${formatCurrency(delta)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <div className="border-t border-border px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {displayTeams.length} of {baseItems.length} teams
          </div>
        </>
      ) : (
        <div className="border-b border-border px-4 py-8 text-center font-mono text-xs text-muted-foreground">
          {query ? `No teams match “${search.trim()}”.` : "No team values are available for this mark."}
        </div>
      )}

      <UpcomingEvSwings
        games={valuation.gameEvSwings ?? []}
        consortiumByName={consortiumByName}
      />
    </section>
  );
}

export function PipelineFailureNotice({ status }: { status: PipelineStatus | null }) {
  if (status?.status !== "failed" || !status.error) return null;
  return (
    <div
      role="alert"
      className="border-b border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-900 dark:text-red-200"
      data-testid="pipeline-failure-notice"
    >
      <p className="flex items-center gap-2 font-semibold">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Latest recalculation failed
      </p>
      <p className="mt-1 break-words text-xs">{status.error}</p>
      {status.currentAsOf && (
        <p className="mt-1 text-xs opacity-80">
          Analysis is still showing the last successful mark.
        </p>
      )}
    </div>
  );
}

function signedCurrency(value: number) {
  return `${value >= 0 ? "+" : "−"}${formatCurrency(Math.abs(value))}`;
}

function ownerCurrency(value: number) {
  return `${value < 0 ? "−" : ""}${formatCurrency(Math.abs(value))}`;
}

function SwingTeamRow({ swing }: { swing: MtmTeamEvSwing }) {
  if (!swing.available) {
    return (
      <div className="border-t border-border/60 py-3 first:border-t-0" data-testid="ev-swing-team">
        <div className="flex items-center justify-between gap-3">
          <span className="font-semibold">{swing.teamName ?? "Unknown team"}</span>
          <span className="font-mono text-[10px] font-bold uppercase text-amber-700 dark:text-amber-300">
            Unavailable
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {swing.qualityStatus.replaceAll("_", " ")} conditional quality
          {swing.effectiveSampleSize == null ? "" : ` · ESS ${Math.round(swing.effectiveSampleSize)}`}
        </p>
      </div>
    );
  }
  return (
    <div className="border-t border-border/60 py-3 first:border-t-0" data-testid="ev-swing-team">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-semibold">{swing.teamName ?? "Unknown team"}</span>
        <span className="font-mono text-sm font-extrabold text-primary">
          {formatCurrency(swing.totalEvSwing ?? 0)} swing
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="border border-emerald-500/25 bg-emerald-500/10 px-2 py-1.5">
          <p className="font-mono text-[9px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">Benefit of win</p>
          <p className="mt-0.5 font-mono font-bold text-emerald-700 dark:text-emerald-300">
            {signedCurrency(swing.benefitOfWin ?? 0)}
          </p>
        </div>
        <div className="border border-red-500/25 bg-red-500/10 px-2 py-1.5 text-right">
          <p className="font-mono text-[9px] font-bold uppercase tracking-wider text-red-700 dark:text-red-300">Cost of loss</p>
          <p className="mt-0.5 font-mono font-bold text-red-700 dark:text-red-300">
            {formatCurrency(swing.costOfLoss ?? 0)}
          </p>
        </div>
      </div>
      <p className="mt-1.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
        Win EV {formatCurrency(swing.winGrossExpectedPayout ?? 0)} · Loss EV {formatCurrency(swing.lossGrossExpectedPayout ?? 0)}
      </p>
    </div>
  );
}

function OwnerSwingRow({ swing }: { swing: MtmOwnerTeamEvSwing }) {
  const isShort = swing.signedShare < 0;
  if (!swing.available) {
    return (
      <div className="flex items-center justify-between gap-3 py-2" data-testid="ev-swing-owner-holding">
        <span className="font-semibold">{swing.teamName ?? "Unknown team"}</span>
        <span className="font-mono text-[10px] font-bold uppercase text-amber-700 dark:text-amber-300">Unavailable</span>
        <span className="sr-only">
          {swing.qualityStatus.replaceAll("_", " ")} team conditional quality
          {swing.effectiveSampleSize == null ? "" : ` · ESS ${Math.round(swing.effectiveSampleSize)}`}
        </span>
      </div>
    );
  }
  return (
    <div className="py-2" data-testid="ev-swing-owner-holding">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">{swing.teamName ?? "Unknown team"}</span>
        <span className="font-mono text-sm font-extrabold text-primary">
          {ownerCurrency(swing.totalEvSwing ?? 0)} swing
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        <div className={cn(
          "border px-2 py-1.5",
          isShort
            ? "border-red-500/25 bg-red-500/10"
            : "border-emerald-500/25 bg-emerald-500/10",
        )}>
          <p className={cn(
            "font-mono text-[9px] font-bold uppercase tracking-wider",
            isShort
              ? "text-red-700 dark:text-red-300"
              : "text-emerald-700 dark:text-emerald-300",
          )}>
            {isShort ? "Cost of win" : "Benefit of win"}
          </p>
          <p className={cn(
            "mt-0.5 font-mono font-bold",
            isShort
              ? "text-red-700 dark:text-red-300"
              : "text-emerald-700 dark:text-emerald-300",
          )}>
            {formatCurrency(Math.abs(swing.benefitOfWin ?? 0))}
          </p>
        </div>
        <div className={cn(
          "border px-2 py-1.5 text-right",
          isShort
            ? "border-emerald-500/25 bg-emerald-500/10"
            : "border-red-500/25 bg-red-500/10",
        )}>
          <p className={cn(
            "font-mono text-[9px] font-bold uppercase tracking-wider",
            isShort
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-red-700 dark:text-red-300",
          )}>
            {isShort ? "Benefit of loss" : "Cost of loss"}
          </p>
          <p className={cn(
            "mt-0.5 font-mono font-bold",
            isShort
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-red-700 dark:text-red-300",
          )}>
            {formatCurrency(Math.abs(swing.costOfLoss ?? 0))}
          </p>
        </div>
      </div>
    </div>
  );
}

function sumOwnerSwingValue(left: number | null, right: number | null) {
  return left == null || right == null ? null : left + right;
}

function mergeConsortiumHolding(
  left: MtmOwnerTeamEvSwing,
  right: MtmOwnerTeamEvSwing,
): MtmOwnerTeamEvSwing {
  const available = left.available && right.available;
  return {
    ...left,
    signedShare: left.signedShare + right.signedShare,
    available,
    qualityStatus: available ? left.qualityStatus : right.qualityStatus,
    baselineOwnedExpectedPayout: sumOwnerSwingValue(
      left.baselineOwnedExpectedPayout,
      right.baselineOwnedExpectedPayout,
    ),
    winOwnedExpectedPayout: sumOwnerSwingValue(
      left.winOwnedExpectedPayout,
      right.winOwnedExpectedPayout,
    ),
    lossOwnedExpectedPayout: sumOwnerSwingValue(
      left.lossOwnedExpectedPayout,
      right.lossOwnedExpectedPayout,
    ),
    benefitOfWin: sumOwnerSwingValue(left.benefitOfWin, right.benefitOfWin),
    costOfLoss: sumOwnerSwingValue(left.costOfLoss, right.costOfLoss),
    totalEvSwing: sumOwnerSwingValue(left.totalEvSwing, right.totalEvSwing),
    effectiveSampleSize:
      left.effectiveSampleSize == null || right.effectiveSampleSize == null
        ? null
        : Math.min(left.effectiveSampleSize, right.effectiveSampleSize),
  };
}

export function UpcomingEvSwings({
  games,
  consortiumByName = new Map(),
}: {
  games: MtmGameEvSwing[];
  consortiumByName?: Map<string, string>;
}) {
  const [view, setView] = useState<"team" | "owner">("team");
  const [filter, setFilter] = useState("");
  const filterQuery = filter.trim().toLocaleLowerCase();
  const weeks = [...new Set(
    games.map((game) => game.week).filter((week): week is number => week != null),
  )].sort((a, b) => a - b).slice(0, 3);
  const weekKey = weeks.join(",");
  const [selectedWeekNumbers, setSelectedWeekNumbers] = useState<number[]>(() =>
    weeks.length ? [weeks[0]] : [],
  );
  useEffect(() => {
    setSelectedWeekNumbers((current) => {
      const retained = current.filter((week) => weeks.includes(week));
      return retained.length ? retained : weeks.length ? [weeks[0]] : [];
    });
  }, [weekKey]);
  const selectedWeeks = new Set(selectedWeekNumbers);
  const visible = games
    .filter((game) => game.week != null && selectedWeeks.has(game.week))
    .filter((game) => {
      if (!filterQuery) return true;
      if (view === "team") {
        return game.teams.some((team) =>
          (team.teamName ?? "").toLocaleLowerCase().includes(filterQuery),
        );
      }
      return game.owners.some((owner) =>
        owner.bidderName.toLocaleLowerCase().includes(filterQuery) ||
        ownerLabel(owner.bidderName, consortiumByName).toLocaleLowerCase().includes(filterQuery) ||
        owner.holdings.some((holding) =>
          (holding.teamName ?? "").toLocaleLowerCase().includes(filterQuery),
        ),
      );
    })
    .sort((a, b) =>
      (a.week ?? Infinity) - (b.week ?? Infinity) ||
      (a.teams.find((team) => team.teamId === a.awayTeamId)?.teamName ?? "").localeCompare(
        b.teams.find((team) => team.teamId === b.awayTeamId)?.teamName ?? "",
      ) ||
      (a.teams.find((team) => team.teamId === a.homeTeamId)?.teamName ?? "").localeCompare(
        b.teams.find((team) => team.teamId === b.homeTeamId)?.teamName ?? "",
      ) ||
      a.eventId - b.eventId
    );
  const ownerGroupMap = new Map<string, {
    bidderName: string;
    rows: Array<{
      week: number;
      eventId: number;
      holding: MtmOwnerTeamEvSwing;
    }>;
  }>();
  for (const game of visible) {
    if (game.week == null) continue;
    for (const owner of game.owners) {
      const consortiumName = ownerLabel(owner.bidderName, consortiumByName);
      const rows = owner.holdings
        .filter((holding) =>
          !filterQuery ||
          owner.bidderName.toLocaleLowerCase().includes(filterQuery) ||
          consortiumName.toLocaleLowerCase().includes(filterQuery) ||
          (holding.teamName ?? "").toLocaleLowerCase().includes(filterQuery),
        )
        .map((holding) => ({ week: game.week as number, eventId: game.eventId, holding }));
      if (!rows.length) continue;
      const group = ownerGroupMap.get(consortiumName) ?? {
        bidderName: consortiumName,
        rows: [],
      };
      for (const row of rows) {
        const existing = group.rows.find(
          (candidate) =>
            candidate.eventId === row.eventId &&
            candidate.holding.teamId === row.holding.teamId,
        );
        if (existing) {
          existing.holding = mergeConsortiumHolding(existing.holding, row.holding);
        } else {
          group.rows.push(row);
        }
      }
      ownerGroupMap.set(consortiumName, group);
    }
  }
  const ownerGroups = [...ownerGroupMap.values()]
    .sort((a, b) => a.bidderName.localeCompare(b.bidderName))
    .map((group) => ({
      ...group,
      rows: group.rows.sort((a, b) =>
        a.week - b.week ||
        Math.abs(b.holding.totalEvSwing ?? Number.NEGATIVE_INFINITY) -
          Math.abs(a.holding.totalEvSwing ?? Number.NEGATIVE_INFINITY) ||
        (a.holding.teamName ?? "").localeCompare(b.holding.teamName ?? "") ||
        a.eventId - b.eventId
      ),
    }));
  if (!games.length) return null;
  return (
    <section className="border-b border-border bg-muted/20 px-4 py-4" data-testid="upcoming-ev-swings">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-widest">
            <Zap className="h-3.5 w-3.5 text-primary" />
            Upcoming game EV swings
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Benefit of a win plus cost of a loss
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex border border-border bg-background p-0.5" aria-label="Exposure view">
            <button type="button" onClick={() => setView("team")} aria-pressed={view === "team"} className={cn("px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider", view === "team" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>By Team</button>
            <button type="button" onClick={() => setView("owner")} aria-pressed={view === "owner"} className={cn("px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider", view === "owner" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>By Owner</button>
          </div>
          <div className="flex items-center gap-1" aria-label="Filter by week">
            {weeks.map((week) => {
              const selected = selectedWeeks.has(week);
              return (
                <button
                  key={week}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setSelectedWeekNumbers((current) =>
                      current.includes(week)
                        ? current.filter((value) => value !== week)
                        : [...current, week].sort((a, b) => a - b),
                    );
                  }}
                  className={cn(
                    "border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  Week {week}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <label className="relative mt-3 block sm:max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <span className="sr-only">Filter {view === "team" ? "teams" : "consortiums and teams"}</span>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={view === "team" ? "Filter teams…" : "Filter consortiums or teams…"}
          className="w-full border border-border bg-background py-2 pl-8 pr-3 font-mono text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary"
        />
      </label>
      <div className="mt-4 space-y-5">
        {!visible.length && (
          <p className="border border-dashed border-border bg-background p-4 text-xs text-muted-foreground">
            No {view === "team" ? "teams" : "consortiums or teams"} match this filter.
          </p>
        )}
        {view === "owner" ? ownerGroups.map((group) => (
          <details
            key={group.bidderName}
            open
            className="border border-border bg-background"
            data-testid="ev-swing-owner-group"
          >
            <summary className="cursor-pointer select-none border-b border-border bg-muted/40 px-3 py-2 font-mono text-[11px] font-extrabold uppercase tracking-wider text-primary">
              {group.bidderName}
            </summary>
            <div className="divide-y divide-border px-3">
              {group.rows.map(({ week, eventId, holding }) => (
                <article
                  key={`${holding.teamId ?? "unknown"}-${eventId}`}
                  className="grid grid-cols-[auto_1fr] items-center gap-x-3"
                  data-testid="ev-swing-owner"
                >
                  <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                    Week {week}
                  </span>
                  <OwnerSwingRow swing={holding} />
                </article>
              ))}
            </div>
          </details>
        )) : selectedWeekNumbers.map((week) => (
          <div
            key={week}
            role="group"
            aria-labelledby={`ev-swing-week-${week}-heading`}
            data-testid={`ev-swing-week-${week}`}
          >
            <h4
              id={`ev-swing-week-${week}-heading`}
              className="mb-2 font-mono text-[10px] font-extrabold uppercase tracking-[0.18em] text-primary"
            >
              Week {week}
            </h4>
            <div className="grid gap-3 md:grid-cols-2">
              {visible.filter((game) => game.week === week).map((game) => {
                const away = game.teams.find((team) => team.teamId === game.awayTeamId);
                const home = game.teams.find((team) => team.teamId === game.homeTeamId);
                const gameHeadingId = `ev-swing-week-${week}-game-${game.eventId}-heading`;
                return (
                  <article
                    key={game.eventId}
                    aria-labelledby={gameHeadingId}
                    className="border border-border bg-background px-3"
                    data-testid="ev-swing-game"
                  >
                    <h5
                      id={gameHeadingId}
                      className="border-b border-border py-2 font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground"
                    >
                      {away?.teamName ?? "Away"} @ {home?.teamName ?? "Home"}
                    </h5>
                    {[away, home]
                      .filter((team): team is MtmTeamEvSwing => Boolean(
                        team &&
                        (!filterQuery ||
                          (team.teamName ?? "").toLocaleLowerCase().includes(filterQuery)),
                      ))
                      .map((team) => (
                        <SwingTeamRow key={team.teamId ?? team.teamName} swing={team} />
                      ))}
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function moneyCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  if (abs >= 1000) {
    const k = abs / 1000;
    return `${sign}$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return abs === 0 ? "0" : `${sign}$${Math.round(abs)}`;
}

export function moneySigned(value: number): string {
  const abs = Math.abs(Math.round(value));
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${abs.toLocaleString("en-US")}`;
}

type ScaleMode = "even" | "compressed";
type RangeMode = "season" | "last3weeks";

function Segmented<T extends string>({ label, value, options, onChange }: { label: string, value: T, options: { value: T, label: string }[], onChange: (value: T) => void }) {
  return (
    <div className="flex items-center gap-2">
      {label && <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>}
      <div role="group" aria-label={label} className="flex border border-border bg-card">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={cn(
              "px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors duration-150 ease-out",
              value === option.value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function NetPayoutHistoryChart({
  valuations,
}: {
  valuations: PipelineValuation[];
}) {
  const { ref, width, height } = useMeasure<HTMLDivElement>();
  const [scaleMode, setScaleMode] = useState<ScaleMode>("even");
  const [range, setRange] = useState<RangeMode>("season");
  
  const [pinned, setPinned] = useState<number[]>([]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [crosshair, setCrosshair] = useState<number | null>(null);
  const pointerState = useRef<{
    isDown: boolean;
    startX: number;
    startY: number;
    hasMoved: boolean;
    activeEntryId: number | null;
  } | null>(null);

  const points = valuations.flatMap((valuation) =>
    (valuation.history ?? [])
      .filter((point) => point.netPayout != null)
      .map((point) => ({ ...point, valuation, timestamp: Date.parse(point.asOf) }))
      .filter((point) => Number.isFinite(point.timestamp))
  );

  const allTimestamps = Array.from(new Set(points.map((p) => p.timestamp))).sort((a, b) => a - b);
  const maxOverallTimestamp = allTimestamps.length > 0 ? allTimestamps[allTimestamps.length - 1] : 0;
  
  const minTimestampBound = range === "last3weeks" ? maxOverallTimestamp - 21 * 24 * 60 * 60 * 1000 : 0;
  const filteredTimestamps = allTimestamps.filter((t) => t >= minTimestampBound);
  const minTimestamp = filteredTimestamps.length > 0 ? filteredTimestamps[0] : 0;
  const maxTimestamp = filteredTimestamps.length > 0 ? filteredTimestamps[filteredTimestamps.length - 1] : 0;
  const timestampRange = Math.max(1, maxTimestamp - minTimestamp);

  const filteredPoints = points.filter((p) => p.timestamp >= minTimestampBound);

  const prices = valuations
    .map((v) => v.auctionPrice == null ? null : Number(v.auctionPrice))
    .filter((price): price is number => price != null);
  const minPrice = Math.min(...prices, 0);
  const maxPrice = Math.max(...prices, 1);
  const priceRange = Math.max(1, maxPrice - minPrice);

  function radius(price: string | number | null) {
    if (price == null) return 3.5;
    const numPrice = Number(price);
    const normalized = Math.max(0, Math.min(1, (numPrice - minPrice) / priceRange));
    return 3.5 + Math.sqrt(normalized) * 7.5;
  }

  function transform(value: number, mode: ScaleMode): number {
    if (mode === "even") return value;
    return Math.sign(value) * Math.log1p(Math.abs(value) / 300);
  }

  const values = filteredPoints.map((point) => point.netPayout as number);
  const rawMin = values.length ? Math.min(0, ...values) : 0;
  const rawMax = values.length ? Math.max(0, ...values) : 0;
  const rawSpan = rawMax - rawMin || 1;
  
  const minVal = rawMin - rawSpan * 0.06;
  const maxVal = rawMax + rawSpan * 0.06;

  const tMin = transform(minVal, scaleMode);
  const tMax = transform(maxVal, scaleMode);
  const tSpan = tMax - tMin || 1;

  const isNarrow = width < 600;
  const PAD = { top: 24, right: isNarrow ? 40 : 64, bottom: isNarrow ? 32 : 44, left: isNarrow ? 48 : 82 };
  const innerW = Math.max(width - PAD.left - PAD.right, 10);
  const bottomY = Math.max(height - PAD.bottom, 40);

  function xPos(timestamp: number) {
    if (maxTimestamp === minTimestamp) return PAD.left + innerW / 2;
    return PAD.left + ((timestamp - minTimestamp) / timestampRange) * innerW;
  }

  function yPos(value: number) {
    const tVal = transform(value, scaleMode);
    return bottomY - ((tVal - tMin) / tSpan) * (bottomY - PAD.top);
  }

  const TICK_CANDIDATES = [0, 250, 500, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 15000, 20000];
  const ticks: number[] = [];
  for (const candidate of TICK_CANDIDATES) {
    if (candidate === 0) {
      ticks.push(0);
      continue;
    }
    if (candidate <= maxVal) ticks.push(candidate);
    if (-candidate >= minVal) ticks.push(-candidate);
  }

  const sortedTicks = ticks.sort((a, b) => b - a);
  const keptTicks: number[] = [];
  for (const tick of sortedTicks) {
    const y = yPos(tick);
    if (tick !== 0 && keptTicks.some((k) => Math.abs(yPos(k) - y) < 26)) continue;
    keptTicks.push(tick);
  }

  const tickByLabel = new Map<string, number>();
  for (const point of [...filteredPoints].sort((a, b) => a.timestamp - b.timestamp)) {
    if (!tickByLabel.has(point.label)) tickByLabel.set(point.label, point.timestamp);
  }
  const timeTicks = [...tickByLabel.entries()];

  const pinnedSet = new Set(pinned);
  const emphasized = valuations.filter((v) => pinnedSet.has(v.entryId) || v.entryId === hovered);
  const background = valuations.filter((v) => !pinnedSet.has(v.entryId) && v.entryId !== hovered);

  function colorFor(valuation: PipelineValuation) {
    return NFL_PRIMARY_COLOR_BY_TEAM[valuation.teamName] ?? "hsl(var(--primary))";
  }

  const updatePointer = (e: React.PointerEvent<SVGSVGElement>) => {
    if (filteredTimestamps.length === 0) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Nearest timestamp
    const ratio = (px - PAD.left) / Math.max(innerW, 1);
    const targetTimestamp = minTimestamp + ratio * timestampRange;
    let closestTs = filteredTimestamps[0];
    let minTsDist = Math.abs(targetTimestamp - closestTs);
    for (const ts of filteredTimestamps) {
      const dist = Math.abs(targetTimestamp - ts);
      if (dist < minTsDist) {
        minTsDist = dist;
        closestTs = ts;
      }
    }
    setCrosshair(closestTs);

    // Nearest line within 30px
    let bestId: number | null = null;
    let bestLineDist = 30; // threshold
    for (const v of valuations) {
      const point = (v.history ?? []).find(p => Date.parse(p.asOf) === closestTs);
      if (point && point.netPayout != null) {
        const lineY = yPos(point.netPayout);
        const dist = Math.abs(py - lineY);
        if (dist < bestLineDist) {
          bestLineDist = dist;
          bestId = v.entryId;
        }
      }
    }
    setHovered(bestId);
    if (pointerState.current) pointerState.current.activeEntryId = bestId;
    return bestId;
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // Only capture if not a multi-touch gesture
    if (e.isPrimary) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    pointerState.current = {
      isDown: true,
      startX: e.clientX,
      startY: e.clientY,
      hasMoved: false,
      activeEntryId: null,
    };
    updatePointer(e);
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (pointerState.current?.isDown) {
      const dx = e.clientX - pointerState.current.startX;
      const dy = e.clientY - pointerState.current.startY;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        pointerState.current.hasMoved = true;
      }
    }
    updatePointer(e);
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.isPrimary && e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
    const interaction = pointerState.current;
    if (interaction && !interaction.hasMoved && interaction.activeEntryId !== null) {
      togglePin(interaction.activeEntryId);
    }
    pointerState.current = null;
  };

  const handlePointerCancel = () => {
    pointerState.current = null;
  };

  const handleKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (filteredTimestamps.length === 0) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const currentIdx = crosshair !== null ? filteredTimestamps.indexOf(crosshair) : filteredTimestamps.length - 1;
      let nextIdx = currentIdx;
      if (e.key === "ArrowLeft") nextIdx = Math.max(0, currentIdx - 1);
      if (e.key === "ArrowRight") nextIdx = Math.min(filteredTimestamps.length - 1, currentIdx + 1);
      setCrosshair(filteredTimestamps[nextIdx]);

      // Re-evaluate hovered line at new crosshair if we had one
      if (hovered !== null) {
        const v = valuations.find(val => val.entryId === hovered);
        if (v && !(v.history ?? []).some(p => Date.parse(p.asOf) === filteredTimestamps[nextIdx] && p.netPayout != null)) {
          setHovered(null);
        }
      }
    } else if (e.key === "Escape") {
      setCrosshair(null);
      setHovered(null);
      e.currentTarget.blur();
    }
  };

  const togglePin = (id: number) => {
    setPinned((current) => current.includes(id) ? current.filter((p) => p !== id) : [...current, id]);
  };

  const removePin = (id: number) => {
    setPinned((current) => current.filter((p) => p !== id));
  };

  const pathFor = (valuation: PipelineValuation) => {
    const history = (valuation.history ?? [])
      .filter((point) => point.netPayout != null && Number.isFinite(Date.parse(point.asOf)))
      .map((point) => ({ ...point, timestamp: Date.parse(point.asOf) }))
      .filter((point) => point.timestamp >= minTimestampBound)
      .sort((a, b) => a.timestamp - b.timestamp);
    
    if (history.length === 0) return "";
    
    return history
      .map((point, i) => `${i === 0 ? "M" : "L"}${xPos(point.timestamp).toFixed(1)},${yPos(point.netPayout as number).toFixed(1)}`)
      .join(" ");
  };

  // Label Dodging
  const labelPositions = emphasized.map((v) => {
    const history = (v.history ?? [])
      .filter((p) => p.netPayout != null && Date.parse(p.asOf) >= minTimestampBound)
      .sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
    const lastPoint = history[history.length - 1];
    const targetY = lastPoint ? yPos(lastPoint.netPayout as number) : 0;
    return { v, lastPoint, targetY, renderY: targetY };
  }).filter(l => l.lastPoint != null);

  labelPositions.sort((a, b) => a.targetY - b.targetY);

  const labelMinY = PAD.top + 5;
  const labelMaxY = bottomY - 5;
  const labelHeight = labelPositions.length > 1
    ? Math.min(13, (labelMaxY - labelMinY) / (labelPositions.length - 1))
    : 13;
  if (labelPositions[0]) {
    labelPositions[0].renderY = Math.max(labelMinY, labelPositions[0].targetY);
  }
  for (let i = 1; i < labelPositions.length; i++) {
    labelPositions[i].renderY = Math.max(
      labelPositions[i].targetY,
      labelPositions[i - 1].renderY + labelHeight,
    );
  }
  const finalLabel = labelPositions.at(-1);
  if (finalLabel && finalLabel.renderY > labelMaxY) {
    const shift = finalLabel.renderY - labelMaxY;
    for (const label of labelPositions) {
      label.renderY -= shift;
    }
  }

  // Crosshair dots rendering
  const crosshairDots = emphasized.map(v => {
    if (crosshair === null) return null;
    const pt = (v.history ?? []).find(p => p.netPayout != null && Date.parse(p.asOf) === crosshair);
    if (!pt) return null;
    return { v, pt };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  // Readout corner logic
  const isRightHalf = crosshair !== null && xPos(crosshair) > PAD.left + innerW / 2;

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
        <Segmented
          label="Time Range"
          value={range}
          options={[
            { value: "season", label: "Season" },
            { value: "last3weeks", label: "Last 3 Weeks" }
          ]}
          onChange={(value) => setRange(value as RangeMode)}
        />
        <Segmented
          label="Axis Scale"
          value={scaleMode}
          options={[
            { value: "even", label: "Even" },
            { value: "compressed", label: "Compressed" }
          ]}
          onChange={(value) => setScaleMode(value as ScaleMode)}
        />
      </div>

      {pinned.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Selected teams">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Selected
          </span>
          {valuations.filter((valuation) => pinnedSet.has(valuation.entryId)).map((valuation) => {
          const teamColor = colorFor(valuation);
          return (
            <button
              key={valuation.entryId}
              type="button"
              aria-label={`Remove ${valuation.teamName}`}
              onClick={() => removePin(valuation.entryId)}
              className="inline-flex items-center gap-1.5 border border-foreground/30 bg-muted px-2 py-1 font-mono text-[10px] text-foreground transition-colors hover:border-foreground/50"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: teamColor }}
              />
              {valuation.teamName}
              <span aria-hidden="true" className="ml-0.5 text-muted-foreground">×</span>
            </button>
          );
          })}
          <button
            type="button"
            onClick={() => setPinned([])}
            className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      <div ref={ref} className="relative h-[300px] w-full sm:h-[380px] lg:h-[460px] border border-border bg-background/40">
        {width > 0 && height > 0 && (
          <svg
            data-testid="net-payout-chart"
            width={width}
            height={height}
            role="img"
            aria-label="Net payout history by team over time"
            tabIndex={0}
            className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset touch-pan-y"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={(event) => {
              if (event.pointerType !== "touch" && !pointerState.current?.isDown) {
                setCrosshair(null);
                setHovered(null);
              }
            }}
            onKeyDown={handleKeyDown}
          >
            {keptTicks.map((tick) => {
              const y = yPos(tick);
              const isZero = tick === 0;
              return (
                <g key={tick}>
                  <line
                    x1={PAD.left}
                    x2={width - PAD.right}
                    y1={y}
                    y2={y}
                    stroke={isZero ? "currentColor" : "hsl(var(--border))"}
                    strokeWidth={isZero ? 1.5 : 1}
                    strokeDasharray={isZero ? "0" : "2 4"}
                    opacity={isZero ? 0.45 : 1}
                  />
                  <text
                    x={PAD.left - (isNarrow ? 6 : 10)}
                    y={y + 3.5}
                    textAnchor="end"
                    className="font-mono"
                    fontSize={isNarrow ? 9 : 10}
                    fill={isZero ? "currentColor" : "hsl(var(--muted-foreground))"}
                  >
                    {isZero ? "Breakeven" : moneyCompact(tick)}
                  </text>
                </g>
              );
            })}

            {timeTicks.map(([label, timestamp], i) => {
              const textDivisor = isNarrow ? 20 : 10;
              const showText = timeTicks.length <= (isNarrow ? 7 : 14) || i % Math.ceil(timeTicks.length / textDivisor) === 0 || i === timeTicks.length - 1;
              return (
                <g key={`${label}-${timestamp}`}>
                  <line
                    x1={xPos(timestamp)}
                    y1={PAD.top}
                    x2={xPos(timestamp)}
                    y2={height - PAD.bottom}
                    stroke="currentColor"
                    strokeOpacity={0.07}
                  />
                  {showText && (
                    <text
                      x={xPos(timestamp)}
                      y={height - 14}
                      textAnchor="middle"
                      fontSize={isNarrow ? 9 : 10}
                      fontWeight={crosshair === timestamp ? 700 : 400}
                      fill="currentColor"
                      fillOpacity={crosshair === timestamp ? 1 : 0.68}
                      className="font-mono"
                    >
                      {label}
                    </text>
                  )}
                </g>
              );
            })}

            {crosshair !== null && (
              <line
                data-testid="net-payout-crosshair"
                x1={xPos(crosshair)}
                x2={xPos(crosshair)}
                y1={PAD.top - 6}
                y2={bottomY}
                stroke="currentColor"
                strokeWidth={1}
                opacity={0.2}
              />
            )}

            {/* Render unselected lines with flat color blended against background */}
            {background.map((v) => {
              const path = pathFor(v);
              if (!path) return null;
              const teamColor = colorFor(v);
              return (
                <path
                  key={v.entryId}
                  data-testid={`net-payout-background-path-${v.entryId}`}
                  d={path}
                  fill="none"
                  stroke={`color-mix(in srgb, ${teamColor} 24%, hsl(var(--background)))`}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              );
            })}

            {/* Render selected/hovered lines */}
            {emphasized.map((v) => {
              const path = pathFor(v);
              if (!path) return null;
              const color = colorFor(v);
              const history = (v.history ?? [])
                .filter((p) => p.netPayout != null && Date.parse(p.asOf) >= minTimestampBound)
                .sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
              if (history.length === 0) return null;
              const lastPoint = history[history.length - 1];

              return (
                <g key={v.entryId}>
                  <path
                    data-testid={`net-payout-path-${v.entryId}`}
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle
                    cx={xPos(Date.parse(lastPoint.asOf))}
                    cy={yPos(lastPoint.netPayout as number)}
                    r={radius(lastPoint.auctionPrice)}
                    fill={color}
                    fillOpacity={0.18}
                    stroke={color}
                    strokeWidth={1.5}
                  />
                </g>
              );
            })}

            {/* Crosshair dots for active lines at hovered timestamp */}
            {crosshairDots.map(({ v, pt }) => {
              const color = colorFor(v);
              return (
                <circle
                  key={`crosshair-dot-${v.entryId}`}
                  cx={xPos(crosshair!)}
                  cy={yPos(pt.netPayout as number)}
                  r={4}
                  fill={color}
                  stroke="hsl(var(--background))"
                  strokeWidth={1.5}
                />
              );
            })}

            {/* Render dodged labels */}
            {labelPositions.map((pos) => {
              const { v, lastPoint, targetY, renderY } = pos;
              const color = colorFor(v);
              const endX = xPos(Date.parse(lastPoint.asOf));
              const r = radius(lastPoint.auctionPrice);

              return (
                <g key={`label-${v.entryId}`}>
                  {Math.abs(targetY - renderY) > 2 && (
                    <path
                      d={`M ${endX + r + 1} ${targetY} C ${endX + r + 6} ${targetY}, ${endX + r + 4} ${renderY}, ${width - PAD.right + 6} ${renderY}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={0.5}
                      opacity={0.5}
                    />
                  )}
                  <text
                    x={width - PAD.right + 8}
                    y={renderY + 3.5}
                    className="font-mono"
                    fontSize={isNarrow ? 9 : 10}
                    fill={color}
                  >
                    {NFL_ABBREVIATION_BY_TEAM[v.teamName] ?? v.teamName}
                  </text>
                </g>
              );
            })}
          </svg>
        )}

        {crosshair !== null && emphasized.length > 0 && (
          <div
            data-testid="net-payout-readout"
            className="pointer-events-none absolute top-4 rounded-sm border border-border bg-card/95 px-3 py-2 shadow-sm"
            style={{
              [isRightHalf ? 'left' : 'right']: isRightHalf ? PAD.left + 12 : PAD.right + 12,
              zIndex: 10,
            }}
          >
            <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              {new Date(crosshair).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </p>
            <ul className="mt-1.5 space-y-1">
              {[...emphasized]
                .map((v) => {
                  const point = (v.history ?? [])
                    .filter((p) => p.netPayout != null && Date.parse(p.asOf) <= crosshair + 60000)
                    .sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf))[0];
                  return { v, point };
                })
                .filter((item) => item.point != null)
                .sort((a, b) => (b.point.netPayout as number) - (a.point.netPayout as number))
                .slice(0, 8)
                .map(({ v, point }) => {
                   const val = point.netPayout as number;
                   return (
                    <li key={v.entryId} className="flex items-baseline gap-4 whitespace-nowrap text-xs">
                      <span className="font-mono w-24 truncate text-foreground font-bold">{v.teamName}</span>
                      <span
                        className={cn("ml-auto font-mono tabular-nums font-bold", val >= 0 ? "text-emerald-600 dark:text-emerald-500" : "text-amber-700 dark:text-amber-500")}
                      >
                        {moneySigned(val)}
                      </span>
                    </li>
                  )
                })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}



// ── Admin auth panel ──────────────────────────────────────────────────────────

function AdminPanel({
  adminKey,
  onSetKey,
  onClearKey,
}: {
  adminKey: string | null;
  onSetKey: (k: string) => Promise<{ ok: boolean; error?: string }>;
  onClearKey: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [validating, setValidating] = useState(false);

  async function handleUnlock() {
    if (!input.trim()) return;
    setError("");
    setValidating(true);
    const result = await onSetKey(input.trim());
    setValidating(false);
    if (!result.ok) {
      setError(result.error ?? "Invalid admin key");
      return;
    }
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
        title="Enter admin key to record MTM values"
      >
        <Lock className="w-3 h-3" /> Admin
      </button>
      {expanded && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border p-3 w-64 space-y-2 shadow-lg">
          <p className="text-xs font-mono text-muted-foreground">
            Enter your admin key to record weekly MTM values.
          </p>
          <input
            type="password"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleUnlock();
            }}
            placeholder="Admin key…"
            className="w-full border border-border bg-background px-2 py-1.5 text-sm font-mono"
            autoFocus
          />
          {error && <p role="alert" className="text-xs text-destructive font-mono">{error}</p>}
          <button
            onClick={() => void handleUnlock()}
            disabled={!input.trim() || validating}
            className="w-full bg-primary text-primary-foreground text-xs font-mono font-bold uppercase tracking-widest py-1.5 hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {validating ? "Validating…" : "Unlock"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── MTM data-entry form ───────────────────────────────────────────────────────

type EntryRow = { teamId: string; mtmValue: string; snapshotDate: string };

function MtmEntryForm({
  year,
  calcuttaId,
  adminKey,
  onSuccess,
}: {
  year: number;
  calcuttaId?: number;
  adminKey: string;
  onSuccess: () => void;
}) {
  const { data: teams } = useGetTeams({ season: year, calcuttaId });

  const [entries, setEntries] = useState<EntryRow[]>([
    { teamId: "", mtmValue: "", snapshotDate: "" },
  ]);
  const [pending, setPending] = useState(false);

  const [bulkMode, setBulkMode] = useState<"rows" | "csv" | "kalshi">("rows");
  const [csvText, setCsvText] = useState("");
  const [csvError, setCsvError] = useState("");
  const [captureError, setCaptureError] = useState("");

  const captureWeekZero = useCaptureWeekZeroMtm({
    request: { headers: { Authorization: `Bearer ${adminKey}` } }
  });

  function addRow() {
    setEntries((prev) => [...prev, { teamId: "", mtmValue: "", snapshotDate: "" }]);
  }

  function removeRow(i: number) {
    setEntries((prev) => prev.filter((_, j) => j !== i));
  }

  function updateRow(i: number, key: keyof EntryRow, value: string) {
    setEntries((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  }

  async function handleSingleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const valid = entries.filter((r) => r.teamId && r.mtmValue !== "");
    if (!valid.length) return;

    setPending(true);
    let done = 0;
    let failed = 0;
    let authFailed = false;

    for (const r of valid) {
      const result = await upsertMtmSnapshot(
        {
          teamId: parseInt(r.teamId),
          seasonYear: year,
          calcuttaId,
          mtmValue: parseFloat(r.mtmValue),
          snapshotDate: r.snapshotDate || undefined,
        },
        adminKey,
      );
      if (result.ok) {
        done++;
      } else {
        failed++;
        if (result.error === "Invalid admin key") authFailed = true;
      }
    }

    setPending(false);
    if (authFailed) {
      toast.error("Invalid admin key — check your credentials");
    } else if (done > 0) {
      toast.success(`Saved ${done} MTM snapshot${done !== 1 ? "s" : ""}`);
      if (!failed) onSuccess();
    }
    if (failed && !authFailed) {
      toast.error(`${failed} snapshot${failed !== 1 ? "s" : ""} failed to save`);
    }
  }

  async function handleCsvImport() {
    setCsvError("");
    const lines = csvText
      .trim()
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));

    const parsed: Array<{
      teamId: number;
      mtmValue: number;
      snapshotDate?: string;
    }> = [];

    for (const line of lines) {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length < 2) {
        setCsvError(`Bad line: "${line}" — expected: teamId, mtmValue[, YYYY-MM-DD]`);
        return;
      }
      const teamId = parseInt(parts[0] ?? "");
      const mtmValue = parseFloat(parts[1] ?? "");
      if (isNaN(teamId) || isNaN(mtmValue)) {
        setCsvError(`Bad values in: "${line}"`);
        return;
      }
      parsed.push({ teamId, mtmValue, snapshotDate: parts[2] || undefined });
    }

    if (!parsed.length) {
      setCsvError("No valid rows found");
      return;
    }

    setPending(true);
    let done = 0;
    let failed = 0;
    let authFailed = false;

    for (const r of parsed) {
      const result = await upsertMtmSnapshot({ ...r, seasonYear: year, calcuttaId }, adminKey);
      if (result.ok) {
        done++;
      } else {
        failed++;
        if (result.error === "Invalid admin key") authFailed = true;
      }
    }

    setPending(false);
    if (authFailed) {
      toast.error("Invalid admin key — check your credentials");
    } else if (done > 0) {
      toast.success(`Imported ${done} MTM snapshot${done !== 1 ? "s" : ""}`);
      if (!failed) { setCsvText(""); onSuccess(); }
    }
    if (failed && !authFailed) {
      toast.error(`${failed} row${failed !== 1 ? "s" : ""} failed`);
    }
  }

  async function handleKalshiCapture() {
    setCaptureError("");
    try {
      const res = await captureWeekZero.mutateAsync({ data: { seasonYear: year, calcuttaId } });
      toast.success(`Captured ${res.teamCount} teams. Total Pot: ${formatCurrency(res.potSize)}`);
      onSuccess();
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to capture Kalshi data";
      setCaptureError(message);
      toast.error(message);
    }
  }

  const validRowCount = entries.filter(
    (r) => r.teamId && r.mtmValue !== "",
  ).length;

  return (
    <div className="space-y-4">
      {/* Mode tabs */}
      <div className="flex gap-0 border-b border-border">
        {(["rows", "csv", "kalshi"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setBulkMode(m)}
            className={cn(
              "px-4 py-2 text-xs font-mono font-bold uppercase tracking-widest border-b-2 -mb-px transition-colors",
              m === bulkMode
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {m === "rows" ? "Row Entry" : m === "csv" ? "CSV Import" : "Kalshi Capture"}
          </button>
        ))}
      </div>

      {bulkMode === "rows" ? (
        /* ── Row entry mode ── */
        <form onSubmit={(e) => void handleSingleSubmit(e)} className="space-y-3">
          <div className="grid grid-cols-[1fr_130px_120px_32px] gap-2 items-center">
            <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">Team</span>
            <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">Date</span>
            <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">MTM Value ($)</span>
            <span />
          </div>

          {entries.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_130px_120px_32px] gap-2 items-center">
              <select
                value={row.teamId}
                onChange={(e) => updateRow(i, "teamId", e.target.value)}
                className="border border-border bg-background px-2 py-1.5 text-sm font-mono w-full"
                required
              >
                <option value="">— Team —</option>
                {(teams ?? [])
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>

              <input
                type="date"
                value={row.snapshotDate}
                onChange={(e) => updateRow(i, "snapshotDate", e.target.value)}
                className="border border-border bg-background px-2 py-1.5 text-sm font-mono w-full"
              />

              <input
                type="number"
                step="0.01"
                value={row.mtmValue}
                onChange={(e) => updateRow(i, "mtmValue", e.target.value)}
                placeholder="e.g. 250.00"
                className="border border-border bg-background px-2 py-1.5 text-sm font-mono w-full"
                required
              />

              {entries.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="text-muted-foreground hover:text-destructive transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={addRow}
              className="text-xs font-mono text-primary hover:underline flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add row
            </button>
            <button
              type="submit"
              disabled={pending || validRowCount === 0}
              className="ml-auto bg-primary text-primary-foreground text-xs font-mono font-bold uppercase tracking-widest px-5 py-2 hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {pending
                ? "Saving…"
                : `Save ${validRowCount || ""} Snapshot${validRowCount !== 1 ? "s" : ""}`}
            </button>
          </div>
        </form>
      ) : bulkMode === "csv" ? (
        /* ── CSV import mode ── */
        <div className="space-y-3">
          <p className="text-xs font-mono text-muted-foreground">
            One row per line:{" "}
            <code className="bg-muted px-1">teamId, mtmValue[, YYYY-MM-DD]</code>
            <br />
            Date defaults to today if omitted. Same date = overwrite. Lines starting with{" "}
            <code className="bg-muted px-1">#</code> are ignored. Team IDs shown on the Teams page.
          </p>
          <textarea
            value={csvText}
            onChange={(e) => {
              setCsvText(e.target.value);
              setCsvError("");
            }}
            rows={8}
            placeholder={
              "# teamId, mtmValue, date (date optional — defaults to today)\n1, 320.00, 2026-09-15\n2, -45.50\n3, 110.00, 2026-09-15"
            }
            className="w-full border border-border bg-background px-3 py-2 text-sm font-mono resize-y"
          />
          {csvError && <p className="text-xs text-destructive font-mono">{csvError}</p>}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleCsvImport()}
              disabled={pending || !csvText.trim()}
              className="bg-primary text-primary-foreground text-xs font-mono font-bold uppercase tracking-widest px-5 py-2 hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {pending ? "Importing…" : "Import CSV"}
            </button>
          </div>
        </div>
      ) : (
        /* ── Kalshi Capture mode ── */
        <div className="space-y-3">
          <div className="p-4 border border-blue-500/20 bg-blue-500/5 text-sm font-mono flex items-start gap-3">
            <Zap className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold uppercase tracking-widest text-blue-600 mb-1">Week 0 Kalshi Capture</p>
              <p className="text-muted-foreground leading-relaxed">
                Fetches real-time market data from Kalshi to establish a fair value baseline (Week 0) for the {year} season.
                The first capture fixes the Week 0 date. Capturing again safely refreshes that same snapshot without adding a duplicate week.
              </p>
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleKalshiCapture}
              disabled={captureWeekZero.isPending}
              className="bg-blue-600 text-white text-xs font-mono font-bold uppercase tracking-widest px-5 py-2 hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {captureWeekZero.isPending ? "Capturing Market Data…" : "Capture Week 0"}
            </button>
          </div>
          {captureError && (
            <div
              role="alert"
              className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs font-mono text-destructive"
            >
              {captureError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({
  year,
  isAdmin,
  onEnterData,
}: {
  year: number;
  isAdmin: boolean;
  onEnterData: () => void;
}) {
  return (
    <div className="border border-dashed border-border flex flex-col items-center justify-center py-24 text-center">
      <TrendingUp className="w-12 h-12 text-muted-foreground/30 mb-4" />
      <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
        No MTM data for {year} yet
      </p>
      <p className="text-xs text-muted-foreground mt-2 max-w-sm">
        Weekly mark-to-market snapshots will appear here once data is entered or captured from the market.
      </p>
      {isAdmin ? (
        <button
          onClick={onEnterData}
          className="mt-6 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-xs font-mono font-bold uppercase tracking-widest hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Enter First Snapshot
        </button>
      ) : (
        <code className="mt-4 text-xs bg-muted px-3 py-2 font-mono text-muted-foreground">
          POST /api/mtm {"{ teamId, seasonYear, mtmValue[, snapshotDate] }"}
        </code>
      )}
    </div>
  );
}

// ── Main chart + table ────────────────────────────────────────────────────────

function MtmContent({
  data,
  consortiumByName,
}: {
  data: MtmData;
  consortiumByName: Map<string, string>;
}) {
  const hasOwners = data.owners.length > 0;
  const kalshiWeeks = data.weeks.filter(w => w.weekNum === 0 || w.source === 'kalshi' || w.label === 'Week 0');
  const hasKalshi = kalshiWeeks.length > 0;

  const defaultView = hasOwners ? "owner" : "team";
  const [view, setView] = useState<"owner" | "team" | "week0">(defaultView);
  const activeView =
    view === "owner" && !hasOwners
      ? "team"
      : view === "week0" && !hasKalshi
        ? defaultView
        : view;

  // Use the explicit Week 0 label; format later snapshots as "Sep 15".
  const dates = data.weeks.map((w) => w.snapshotDate);
  const weekLabels = data.weeks.map((week) => {
    if (week.weekNum === 0) return week.label;
    const dt = new Date(week.snapshotDate + "T12:00:00"); // noon to avoid TZ edge cases
    return dt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  });

  // Chart dimensions
  const W = 700;
  const H = 280;
  const PAD = { top: 20, right: 20, bottom: 32, left: 64 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  // Determine y-range
  const allVals =
    activeView === "owner" && hasOwners
      ? data.owners.flatMap((o) => o.weeklyTotals)
      : data.teams.flatMap((t) => t.weeklyValues);

  const minVal = allVals.length ? Math.min(...allVals, 0) : 0;
  const maxVal = allVals.length ? Math.max(...allVals, 0) : 100;
  const range = maxVal - minVal || 1;

  function xPos(i: number) {
    return PAD.left + (i / Math.max(dates.length - 1, 1)) * chartW;
  }
  function yPos(v: number) {
    return PAD.top + chartH - ((v - minVal) / range) * chartH;
  }

  const series =
    activeView === "owner" && hasOwners
      ? data.owners.map((o, i) => ({
          key: o.bidderName,
          name: ownerLabel(o.bidderName, consortiumByName),
          values: o.weeklyTotals,
          color: OWNER_COLORS[i % OWNER_COLORS.length] as string,
        }))
      : data.teams.map((t, i) => ({
          key: t.teamName,
          name: t.teamName,
          values: t.weeklyValues,
          color: OWNER_COLORS[i % OWNER_COLORS.length] as string,
        }));

  function toPath(values: number[]) {
    return values
      .map(
        (v, i) => `${i === 0 ? "M" : "L"}${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`,
      )
      .join(" ");
  }

  const zeroY = yPos(0);

  return (
    <div className="space-y-6">
      {/* View toggle */}
      <div className="flex border-b border-border overflow-x-auto">
        {hasOwners && (
          <button
            onClick={() => setView("owner")}
            className={cn(
              "px-5 py-2.5 text-sm font-mono font-bold uppercase tracking-widest transition-colors border-b-2 -mb-px whitespace-nowrap",
              activeView === "owner"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            By Consortium
          </button>
        )}
        <button
          onClick={() => setView("team")}
          className={cn(
            "px-5 py-2.5 text-sm font-mono font-bold uppercase tracking-widest transition-colors border-b-2 -mb-px whitespace-nowrap",
            activeView === "team"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          By Team
        </button>
        {hasKalshi && (
          <button
            onClick={() => setView("week0")}
            className={cn(
              "px-5 py-2.5 text-sm font-mono font-bold uppercase tracking-widest transition-colors border-b-2 -mb-px whitespace-nowrap flex items-center gap-2",
              activeView === "week0"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-muted-foreground hover:text-blue-600",
            )}
          >
            <Activity className="w-4 h-4" /> Week 0 Audit
          </button>
        )}
      </div>

      {activeView === "week0" && hasKalshi ? (
        <Week0AuditView
          week={kalshiWeeks[kalshiWeeks.length - 1]!}
          consortiumByName={consortiumByName}
        />
      ) : (
        <>
          {/* SVG Line Chart */}
          <div className="border border-border bg-card p-4 overflow-x-auto">
            <svg
              width="100%"
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="xMinYMin meet"
              className="font-mono"
            >
              {/* Zero line */}
              <line
                x1={PAD.left}
                y1={zeroY}
                x2={W - PAD.right}
                y2={zeroY}
                stroke="currentColor"
                strokeOpacity={0.15}
                strokeWidth={1}
                strokeDasharray="4,4"
              />

              {/* Y axis ticks */}
              {[-2, -1, 0, 1, 2].map((mult) => {
                const v = (mult / 2) * range + minVal;
                const y = yPos(v);
                return (
                  <g key={mult}>
                    <line
                      x1={PAD.left - 4}
                      y1={y}
                      x2={PAD.left}
                      y2={y}
                      stroke="currentColor"
                      strokeOpacity={0.3}
                    />
                    <text
                      x={PAD.left - 8}
                      y={y + 4}
                      textAnchor="end"
                      fontSize={9}
                      fill="currentColor"
                      fillOpacity={0.5}
                    >
                      {v >= 0 ? "+" : ""}
                      {(v / 1000).toFixed(1)}k
                    </text>
                  </g>
                );
              })}

              {/* X axis labels */}
              {weekLabels.map((label, i) => (
                <text
                  key={i}
                  x={xPos(i)}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize={9}
                  fill="currentColor"
                  fillOpacity={0.5}
                >
                  {label}
                </text>
              ))}

              {/* Series lines */}
              {series.map((s) => (
                <path
                  key={s.key}
                  d={toPath(s.values)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              ))}

              {/* Series dots at last week */}
              {series.map((s) => {
                const lastIdx = s.values.length - 1;
                const lastVal = s.values[lastIdx] ?? 0;
                return (
                  <circle
                    key={s.key}
                    cx={xPos(lastIdx)}
                    cy={yPos(lastVal)}
                    r={4}
                    fill={s.color}
                  />
                );
              })}
            </svg>

            {/* Legend */}
            <div className="flex flex-wrap gap-4 mt-4 px-2">
              {series.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5">
                  <div className="w-3 h-0.5" style={{ backgroundColor: s.color }} />
                  <ConsortiumLabel
                    label={s.name}
                    className="text-xs text-muted-foreground font-mono"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Weekly breakdown table */}
          {data.weeks.length > 0 && activeView === "owner" && (
            <div className="table-scroll border border-border bg-card">
              <div className="px-4 pt-4 pb-2">
                <h3 className="font-bold text-sm uppercase tracking-tight">
                  Weekly Breakdown — By Consortium
                </h3>
              </div>
              <table className="w-full min-w-[640px] text-sm">
                <thead className="sticky-table-header">
                  <tr className="border-b border-border bg-muted/60">
                    <th className="px-4 py-2 text-left text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                      Consortium
                    </th>
                    {data.weeks.map((w) => (
                      <th
                        key={w.snapshotDate}
                        className="px-3 py-2 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground"
                      >
                        {new Date(w.snapshotDate + "T12:00:00").toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.owners.map((owner, oi) => (
                    <tr
                      key={owner.bidderName}
                      className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-sm">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: OWNER_COLORS[oi % OWNER_COLORS.length] }}
                          />
                          <ConsortiumLabel
                            label={ownerLabel(owner.bidderName, consortiumByName)}
                            className="text-sm"
                          />
                        </div>
                      </td>
                      {owner.weeklyTotals.map((v, wi) => {
                        const prev = wi > 0 ? (owner.weeklyTotals[wi - 1] ?? v) : v;
                        const delta = v - prev;
                        return (
                          <td
                            key={wi}
                            className={cn(
                              "px-3 py-3 text-right font-mono text-xs",
                              v >= 0 ? "text-green-600" : "text-red-600",
                            )}
                          >
                            {v >= 0 ? "+" : ""}
                            {formatCurrency(v)}
                            {wi > 0 && delta !== 0 && (
                              <span
                                className={cn(
                                  "ml-1",
                                  delta > 0 ? "text-green-400" : "text-red-400",
                                )}
                              >
                                {delta > 0 ? (
                                  <TrendingUp className="inline w-2.5 h-2.5" />
                                ) : (
                                  <TrendingDown className="inline w-2.5 h-2.5" />
                                )}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Week 0 Audit View ────────────────────────────────────────────────────────

function Week0AuditView({
  week,
  consortiumByName,
}: {
  week: MtmWeekData;
  consortiumByName: Map<string, string>;
}) {
  const sortedTeams = [...week.teamValues].sort((a, b) => b.mtmValue - a.mtmValue);
  const methodologyTeam = sortedTeams.find(
    (team) => team.regularSeasonMethod || team.intermediateRoundMethod,
  );

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="border border-border bg-card p-4">
          <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground mb-1">Total Market Value</p>
          <p className="text-2xl font-bold">{formatCurrency(week.potSize)}</p>
        </div>
        <div className="border border-border bg-card p-4">
          <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground mb-1">Points Accounted</p>
          <p className="text-2xl font-bold">{week.rawPointTotal.toFixed(1)}</p>
          <p className="text-[10px] font-mono text-muted-foreground mt-1">
            Shares {(week.normalizedShareTotal * 100).toFixed(4)}%
          </p>
        </div>
        <div className="border border-border bg-card p-4">
          <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground mb-1">Captured</p>
          <p className="text-lg font-mono pt-1">
            {week.capturedAt ? new Date(week.capturedAt).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : week.snapshotDate}
          </p>
          <p className="text-[10px] font-mono text-muted-foreground mt-1 uppercase">
            Source: {week.source}
            {methodologyTeam?.contractSetId
              ? ` · ${methodologyTeam.contractSetId}`
              : ""}
          </p>
        </div>
        <div className="border border-border bg-card p-4">
          <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground mb-1">Market Quality</p>
          <div className="flex items-center gap-2 text-sm font-mono mt-2">
            {week.marketStatusCounts.live > 0 && <span className="text-emerald-600 flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5"/> {week.marketStatusCounts.live}</span>}
            {week.marketStatusCounts.stale > 0 && <span className="text-amber-600 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5"/> {week.marketStatusCounts.stale}</span>}
            {week.marketStatusCounts.incomplete > 0 && <span className="text-red-600 flex items-center gap-1"><ServerOff className="w-3.5 h-3.5"/> {week.marketStatusCounts.incomplete}</span>}
            {week.marketStatusCounts.manual > 0 && <span className="text-blue-600 flex items-center gap-1"><Info className="w-3.5 h-3.5"/> {week.marketStatusCounts.manual}</span>}
          </div>
        </div>
      </div>

      {methodologyTeam && (
        <div className="border border-border bg-muted/30 px-4 py-3 space-y-1.5">
          <p className="text-xs font-mono font-bold uppercase tracking-widest">
            Valuation method
          </p>
          {methodologyTeam.regularSeasonMethod && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {methodologyTeam.regularSeasonMethod}
            </p>
          )}
          {methodologyTeam.intermediateRoundMethod && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {methodologyTeam.intermediateRoundMethod}
            </p>
          )}
        </div>
      )}

      {/* Audit Table */}
      <div className="table-scroll border border-border bg-card">
        <table className="w-full min-w-[1280px] text-sm">
          <thead className="sticky-table-header">
            <tr className="border-b border-border bg-muted/60">
              <th className="px-4 py-3 text-left text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground sticky left-0 bg-muted/95 backdrop-blur">
                Team
              </th>
              <th className="px-3 py-3 text-center text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Status
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Fair Value
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Share %
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Win Mkt
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                E Wins
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Playoff
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Div
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Conf
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                SB
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Win
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Base
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Season Eq
              </th>
              <th className="px-3 py-3 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Bonus Eq
              </th>
              <th className="px-4 py-3 text-left text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Consortium
              </th>
              <th className="px-4 py-3 text-left text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Quotes
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sortedTeams.map((t) => (
              <tr key={t.teamId} className="hover:bg-muted/30 transition-colors group">
                <td className="px-4 py-3 font-medium whitespace-nowrap sticky left-0 bg-card group-hover:bg-muted/30 transition-colors">
                  {t.teamName}
                </td>
                <td className="px-3 py-3 text-center">
                  <MarketStatusBadge
                    status={t.marketStatus}
                    reasons={t.marketStatusReasons}
                  />
                  {t.marketStatusReasons.length > 0 && (
                    <p className="mt-1 max-w-36 text-left font-mono text-[9px] leading-tight text-muted-foreground">
                      {t.marketStatusReasons.join(" ")}
                    </p>
                  )}
                </td>
                <td className="px-3 py-3 text-right font-mono font-bold">
                  {formatCurrency(t.mtmValue)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {t.normalizedShare != null ? (t.normalizedShare * 100).toFixed(2) + "%" : "—"}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs whitespace-nowrap">
                  {t.winTotalLine != null ? (
                    <>
                      O {t.winTotalLine.toFixed(1)}
                      <span className="block text-muted-foreground">
                        {formatProbability(t.winTotalOverProbability)}
                      </span>
                    </>
                  ) : "—"}
                </td>
                <td className="px-3 py-3 text-right font-mono">
                  {t.expectedWins != null ? t.expectedWins.toFixed(2) : "—"}
                </td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {formatProbability(t.playoffProbability)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {formatProbability(t.divisionalProbability)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {formatProbability(t.conferenceGameProbability)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {formatProbability(t.superBowlProbability)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {formatProbability(t.championshipProbability)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {t.bankedPoints != null ? t.bankedPoints.toFixed(0) : "—"}
                </td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {t.seasonEquityPoints != null ? t.seasonEquityPoints.toFixed(2) : "—"}
                </td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {t.bonusEquityPoints != null ? t.bonusEquityPoints.toFixed(2) : "—"}
                </td>
                <td className="px-4 py-3 text-left text-muted-foreground text-xs whitespace-nowrap">
                  {t.ownerName ? (
                    <ConsortiumLabel
                      label={combinedOwnerLabel(t.ownerName, consortiumByName)}
                    />
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3 text-left text-xs">
                  <details>
                    <summary className="cursor-pointer font-mono text-primary hover:underline whitespace-nowrap">
                      {keyMarketQuotes(t).length} contracts
                    </summary>
                    <div className="mt-2 min-w-72 space-y-2 font-mono text-[10px]">
                      {keyMarketQuotes(t).map((quote) => (
                        <div key={quote.ticker} className="border-l-2 border-border pl-2">
                          <p className="font-bold">{quote.ticker}</p>
                          <p className="text-muted-foreground">
                            bid {formatQuoteValue(quote.bid)} · ask {formatQuoteValue(quote.ask)} ·
                            depth {formatQuoteValue(quote.bidDepth)}/{formatQuoteValue(quote.askDepth)} · {quote.quality}
                          </p>
                        </div>
                      ))}
                    </div>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatProbability(value: number | null | undefined) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatQuoteValue(value: number | null) {
  return value == null ? "—" : value.toFixed(2);
}

function keyMarketQuotes(team: MtmWeekData["teamValues"][number]) {
  return team.marketQuotes.filter(
    (quote) =>
      quote.kind !== "win_threshold" ||
      (team.winTotalLine != null && quote.line === team.winTotalLine),
  );
}

function MarketStatusBadge({
  status,
  reasons,
}: {
  status: MtmTeamWeekMarketStatus;
  reasons: string[];
}) {
  const config = {
    live: {
      label: "Live",
      title: "Tight spread and sufficient top-of-book depth",
      className: "border-emerald-600/40 bg-emerald-500/10 text-emerald-700",
      icon: ShieldCheck,
    },
    stale: {
      label: "Stale",
      title: "One or more key contracts has a wide spread or low depth",
      className: "border-amber-600/40 bg-amber-500/10 text-amber-700",
      icon: AlertTriangle,
    },
    incomplete: {
      label: "Incomplete",
      title: "One or more required Kalshi contracts is unavailable",
      className: "border-red-600/40 bg-red-500/10 text-red-700",
      icon: ServerOff,
    },
    manual: {
      label: "Manual",
      title: "This value was entered manually",
      className: "border-blue-600/40 bg-blue-500/10 text-blue-700",
      icon: Info,
    },
  }[status];
  const Icon = config.icon;
  return (
    <span
      title={reasons.length > 0 ? reasons.join(" ") : config.title}
      className={cn(
        "inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        config.className,
      )}
    >
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}

function isWinTotalSeries(series: string, ticker?: string) {
  const value = `${series} ${ticker ?? ""}`.toLowerCase();
  return value.includes("win") || value.includes("total");
}

function formatEvidenceQuote(value: number | null) {
  return value == null ? "—" : value.toFixed(2);
}

function formatEvidencePercent(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

const EVIDENCE_TIER_LABELS: Record<MtmPipelineEliminationEvidence["confidenceTier"], string> = {
  settled_fact: "Settled fact",
  strong_active_book: "Strong active book",
  verified_trade: "Verified trade",
  last_context: "Last context",
  active_book: "Active book",
};

export function MtmEvidenceInspector({
  year,
  calcuttaId,
  adminKey,
  manualRun,
  onDeleted,
}: {
  year: number;
  calcuttaId?: number;
  adminKey: string;
  manualRun?: ManualRecalculationStatus | null;
  onDeleted: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [attemptId, setAttemptId] = useState<number | undefined>(undefined);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setAttemptId(undefined);
  }, [year, calcuttaId]);

  const { data, isLoading, error, isRefetching, refetch } = useGetMtmPipelineEvidence(
    { season: year, calcuttaId, attemptId },
    {
      query: {
        enabled: Boolean(adminKey),
        queryKey: getGetMtmPipelineEvidenceQueryKey({ season: year, calcuttaId, attemptId }),
      },
      request: {
        headers: { Authorization: `Bearer ${adminKey}` },
      },
    }
  );

  useEffect(() => {
    if (manualRun?.completedAt) void refetch();
  }, [manualRun?.completedAt, refetch]);

  if (isLoading && !data) {
    return (
      <div className="p-8 text-center text-sm font-mono text-muted-foreground animate-pulse">
        Loading evidence ledger...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center text-sm font-mono text-red-600 bg-red-500/10">
        Failed to load evidence. Please check your admin key or try again.
      </div>
    );
  }

  if (!data) return null;

  const attempts = data.attempts || [];
  const attempt = data.selectedAttempt;
  const runHasAttempt = manualRun?.startedAt
    ? attempts.some((item) => Date.parse(item.createdAt) >= Date.parse(manualRun.startedAt!))
    : false;
  const showManualRun = Boolean(
    manualRun?.startedAt && (manualRun.running || !runHasAttempt),
  );

  async function deleteAttempt() {
    if (!attempt || !calcuttaId || deleteConfirmation !== `DELETE ${attempt.id}`) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/mtm/pipeline/attempts/${attempt.id}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminKey}`,
        },
        body: JSON.stringify({
          season: year,
          calcuttaId,
          confirmed: true,
        }),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Unable to delete the MTM update.");
      }
      trackEvent("mtm_update_deleted", {
        attemptId: attempt.id,
        status: attempt.status,
        year,
      });
      toast.success(`MTM update #${attempt.id} was deleted.`);
      setAttemptId(undefined);
      setDeleteConfirmOpen(false);
      setDeleteConfirmation("");
      const defaultParams = { season: year, calcuttaId, attemptId: undefined };
      const defaultQueryKey = getGetMtmPipelineEvidenceQueryKey(defaultParams);
      queryClient.removeQueries({ queryKey: defaultQueryKey, exact: true });
      try {
        await Promise.all([
          queryClient.fetchQuery({
            queryKey: defaultQueryKey,
            queryFn: () => fetchMtmPipelineEvidence(
              defaultParams,
              { Authorization: `Bearer ${adminKey}` },
            ),
          }),
          onDeleted(),
        ]);
      } catch {
        toast.error("The MTM update was deleted, but refreshed tracker data could not be loaded. Try refreshing the page.");
      }
    } catch (deleteError) {
      toast.error(deleteError instanceof Error ? deleteError.message : "Unable to delete the MTM update.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col md:flex-row h-[600px] bg-card text-card-foreground">
      {/* Sidebar */}
      <div className="w-full md:w-80 border-r border-border flex flex-col h-full bg-muted/10">
         <div className="p-3 border-b border-border bg-muted/40 flex items-center justify-between">
            <span className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">Audit Trail</span>
            {isRefetching && <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground" />}
         </div>
         <div className="overflow-y-auto flex-1 p-2 space-y-1">
            {showManualRun && manualRun?.startedAt && (
              <div className="w-full p-3 border border-amber-500/40 bg-amber-500/10 text-sm rounded-sm">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono font-semibold text-xs tracking-tight">
                    {new Date(manualRun.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                  <span className={cn(
                    "px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase tracking-wider rounded-sm",
                    manualRun.running
                      ? "bg-amber-500/20 text-amber-800 dark:text-amber-300"
                      : "bg-red-500/15 text-red-700 dark:text-red-400",
                  )}>
                    {manualRun.running ? "Pending" : "Failed"}
                  </span>
                </div>
                <div className="text-[10px] font-mono text-muted-foreground flex justify-between items-center">
                  <span className="uppercase">Manual</span>
                  <span>{manualRun.running ? "In progress" : "No update recorded"}</span>
                </div>
                {!manualRun.running && manualRun.error && (
                  <p className="mt-2 text-[10px] text-red-700 dark:text-red-300">
                    {manualRun.error}
                  </p>
                )}
              </div>
            )}
           {attempts.length === 0 ? (
             <div className="p-4 text-center text-xs font-mono text-muted-foreground">No attempts found</div>
            ) : (
              attempts.map((a: MtmPipelineAttempt) => {
               const isSelected = attemptId ? attemptId === a.id : attempt?.id === a.id;
               return (
                 <button
                   key={a.id}
                    onClick={() => {
                      trackEvent("mtm_evidence_attempt_opened", {
                        status: a.status,
                        trigger: a.trigger,
                        year,
                      });
                      setAttemptId(a.id);
                    }}
                   className={cn(
                     "w-full text-left p-3 border transition-colors text-sm rounded-sm",
                      isSelected
                        ? "border-indigo-500/50 bg-indigo-500/10 shadow-sm"
                       : "border-transparent hover:border-border hover:bg-muted/50"
                   )}
                 >
                   <div className="flex items-center justify-between mb-1.5">
                     <span className="font-mono font-semibold text-xs tracking-tight">
                       {new Date(a.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                     </span>
                      <span className={cn(
                        "px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase tracking-wider rounded-sm",
                        a.status === "ok"
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                          : a.status === "running"
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                            : "bg-red-500/15 text-red-700 dark:text-red-400",
                      )}>
                       {a.status}
                     </span>
                   </div>
                   <div className="text-[10px] font-mono text-muted-foreground flex justify-between items-center">
                      <span className="uppercase">{a.trigger}</span>
                      <span>{a.quoteCount} quotes</span>
                   </div>
                 </button>
               );
             })
           )}
         </div>
       </div>

      {/* Main */}
      <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
        {!attempt ? (
           <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground space-y-3">
              <Search className="w-8 h-8 opacity-20" />
              <span className="font-mono text-xs uppercase tracking-widest opacity-60">Select an attempt to view evidence</span>
           </div>
        ) : (
           <div className="flex-1 overflow-y-auto">
                  <div className="p-5 border-b border-border bg-muted/5">
                 <div className="flex items-start justify-between">
                   <div>
                     <h3 className="font-mono text-lg font-bold tracking-tight text-foreground flex items-center gap-2">
                       Attempt #{attempt.id}
                       {attempt.methodVersion && (
                         <span className="text-xs font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm">v{attempt.methodVersion}</span>
                       )}
                     </h3>
                     <p className="text-xs font-mono text-muted-foreground mt-2">
                       Recorded <span className="text-foreground">{new Date(attempt.createdAt).toLocaleString()}</span>
                     </p>
                     <p className="text-xs font-mono text-muted-foreground mt-1">
                       Target As-Of <span className="text-foreground">{attempt.asOf ? new Date(attempt.asOf).toLocaleString() : "Latest"}</span>
                     </p>
                   </div>
                    <div className="flex flex-col items-end gap-2">
                       <div className={cn(
                         "px-3 py-1 font-mono text-xs font-bold uppercase tracking-widest border rounded-sm",
                         attempt.status === "ok"
                           ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                           : attempt.status === "running"
                             ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                             : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
                       )}>
                         {attempt.status === "ok" ? "Success" : attempt.status === "running" ? "Running" : "Failed"}
                      </div>
                      <button
                        type="button"
                        disabled={!attempt.deletable}
                        title={attempt.deleteBlockedReason ?? "Delete this non-current MTM update"}
                        onClick={() => {
                          setDeleteConfirmation("");
                          setDeleteConfirmOpen(true);
                        }}
                        className="inline-flex items-center gap-1.5 border border-red-500/40 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-red-700 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete update
                      </button>
                   </div>
                 </div>
                  {attempt.deleteBlockedReason && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {attempt.deleteBlockedReason}
                    </p>
                  )}
               </div>

                {deleteConfirmOpen && (
                  <div className="border-b border-red-500/30 bg-red-500/5 p-5">
                    <h4 className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-widest text-red-800 dark:text-red-300">
                      <AlertTriangle className="h-4 w-4" />
                      Permanently delete update #{attempt.id}?
                    </h4>
                    <p className="mt-2 text-xs text-muted-foreground">
                      This removes the update and its derived history points for this Calcutta. Momentum and the over-time graph will be recalculated from the remaining updates. This cannot be undone.
                    </p>
                    <label className="mt-4 block">
                      <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Type DELETE {attempt.id} to confirm
                      </span>
                      <input
                        value={deleteConfirmation}
                        onChange={(event) => setDeleteConfirmation(event.target.value)}
                        className="mt-1.5 w-full border border-red-500/40 bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-1 focus:ring-red-500"
                        autoComplete="off"
                      />
                    </label>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={deleting || deleteConfirmation !== `DELETE ${attempt.id}`}
                        onClick={() => void deleteAttempt()}
                        className="inline-flex items-center gap-2 bg-red-700 px-3 py-2 font-mono text-xs font-bold uppercase tracking-wider text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 className="h-4 w-4" />
                        {deleting ? "Deleting…" : "Delete permanently"}
                      </button>
                      <button
                        type="button"
                        disabled={deleting}
                        onClick={() => {
                          setDeleteConfirmOpen(false);
                          setDeleteConfirmation("");
                        }}
                        className="border border-border px-3 py-2 font-mono text-xs font-bold uppercase tracking-wider hover:bg-muted"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

              <div className="p-5 space-y-8">
                {attempt.error && (
                  <div className="border border-red-500/30 bg-red-500/5 p-4 rounded-sm">
                    <h4 className="font-mono text-[10px] font-bold uppercase tracking-widest text-red-800 dark:text-red-400 mb-2 flex items-center gap-1.5">
                      <AlertTriangle className="w-3 h-3" /> Exception
                    </h4>
                    <p className="font-mono text-xs text-red-900 dark:text-red-300 whitespace-pre-wrap break-words">{attempt.error}</p>
                  </div>
                 )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {attempt.receivedMarkets && attempt.receivedMarkets.length > 0 && (
                    <div>
                      <h4 className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5">
                        <Activity className="w-3 h-3" /> Received Markets
                      </h4>
                      <div className="grid grid-cols-1 gap-2">
                          {attempt.receivedMarkets.map((market: MtmPipelineReceivedMarket) => (
                             <div key={market.series} className="border border-border/60 p-3 bg-muted/10 rounded-sm flex items-center justify-between">
                                <div className="text-xs font-mono font-bold truncate pr-3" title={market.series}>{market.series}</div>
                               <div className="text-[10px] text-muted-foreground font-mono flex items-center gap-3 shrink-0">
                                  <span><strong className="text-foreground">{market.teams.length}</strong> teams</span>
                                  <span><strong className="text-foreground">{market.quoteCount}</strong> quotes</span>
                               </div>
                            </div>
                         ))}
                      </div>
                    </div>
                   )}

                  {attempt.failedSources && attempt.failedSources.length > 0 && (
                    <div>
                      <h4 className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5">
                        <ServerOff className="w-3 h-3" /> Failed Sources
                      </h4>
                      <div className="flex gap-2 flex-wrap">
                        {attempt.failedSources.map((s: string) => (
                           <span key={s} className="border border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-400 text-xs px-2.5 py-1 font-mono rounded-sm">{s}</span>
                        ))}
                      </div>
                    </div>
                  )}
                 </div>

                 {attempt.eliminationEvidence && attempt.eliminationEvidence.length > 0 && (
                   <div>
                     <div className="mb-3">
                       <h4 className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                         <Activity className="h-3 w-3" /> Elimination contract influence
                       </h4>
                       <p className="mt-1 text-xs text-muted-foreground">
                         Persisted publication diagnostics. Amber rows are strong active-book misses near the publication ceiling.
                       </p>
                     </div>
                     <div className="overflow-hidden rounded-sm border border-border bg-card">
                       <div className="max-h-[400px] overflow-auto">
                         <table className="w-full whitespace-nowrap text-left text-xs">
                           <thead className="sticky top-0 z-10 bg-muted/50 font-mono text-[10px] uppercase tracking-wider text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
                             <tr>
                               <th className="px-3 py-2 font-semibold">Team</th>
                               <th className="px-3 py-2 font-semibold">Outcome</th>
                               <th className="px-3 py-2 font-semibold">Confidence</th>
                               <th className="px-3 py-2 text-right font-semibold">Bid</th>
                               <th className="px-3 py-2 text-right font-semibold">Ask</th>
                               <th className="px-3 py-2 text-right font-semibold">Last</th>
                               <th className="px-3 py-2 text-right font-semibold">Fitted</th>
                               <th className="px-3 py-2 text-right font-semibold">Interval miss</th>
                             </tr>
                           </thead>
                           <tbody className="divide-y divide-border/60 font-mono text-[11px]">
                             {attempt.eliminationEvidence.map((row) => (
                               <tr
                                 key={row.ticker}
                                 className={cn(
                                   row.confidenceTier === "settled_fact" && "bg-emerald-500/10",
                                   row.nearPublicationCeiling && "bg-amber-500/15",
                                 )}
                               >
                                 <td className="px-3 py-2 font-semibold" title={row.ticker}>{row.team}</td>
                                 <td className="px-3 py-2">{row.outcome.replaceAll("_", " ")}</td>
                                 <td className="px-3 py-2">
                                   <span className={cn(
                                     "rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                                     row.confidenceTier === "settled_fact"
                                       ? "bg-emerald-500/20 text-emerald-800 dark:text-emerald-300"
                                       : row.nearPublicationCeiling
                                         ? "bg-amber-500/25 text-amber-900 dark:text-amber-200"
                                         : "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
                                   )}>
                                     {EVIDENCE_TIER_LABELS[row.confidenceTier]}
                                   </span>
                                 </td>
                                 <td className="px-3 py-2 text-right">{formatEvidenceQuote(row.bid)}</td>
                                 <td className="px-3 py-2 text-right">{formatEvidenceQuote(row.ask)}</td>
                                 <td className="px-3 py-2 text-right">{formatEvidenceQuote(row.last)}</td>
                                 <td className="px-3 py-2 text-right">{formatEvidencePercent(row.fittedProbability)}</td>
                                 <td className={cn("px-3 py-2 text-right font-semibold", row.nearPublicationCeiling && "text-amber-800 dark:text-amber-300")}>
                                   {formatEvidencePercent(row.intervalMiss)}
                                 </td>
                               </tr>
                             ))}
                           </tbody>
                         </table>
                       </div>
                     </div>
                   </div>
                 )}

                <div>
                    <h4 className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5">
                      <ListFilter className="w-3 h-3" /> Raw Quotes ({attempt.quotes.length})
                    </h4>
                    {attempt.quotes.length === 0 ? (
                      <div className="border border-dashed border-border p-5 text-center font-mono text-xs text-muted-foreground">
                        No raw Kalshi quotes were received for this attempt.
                      </div>
                    ) : (
                      <div className="border border-border rounded-sm overflow-hidden bg-card">
                       <div className="overflow-x-auto max-h-[400px]">
                         <table className="w-full text-left text-xs whitespace-nowrap">
                            <thead className="bg-muted/50 font-mono text-[10px] uppercase tracking-wider text-muted-foreground sticky top-0 z-10 shadow-[0_1px_0_hsl(var(--border))]">
                               <tr>
                                 <th className="px-3 py-2 font-semibold">Series Type</th>
                                 <th className="px-3 py-2 font-semibold">Team</th>
                                 <th className="px-3 py-2 font-semibold">Ticker</th>
                                 <th className="px-3 py-2 font-semibold text-right">Strike</th>
                                 <th className="px-3 py-2 font-semibold text-right">Bid</th>
                                 <th className="px-3 py-2 font-semibold text-right">Ask</th>
                                 <th className="px-3 py-2 font-semibold text-right">Vol</th>
                                 <th className="px-3 py-2 font-semibold">Fetched (ET)</th>
                               </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60 font-mono text-[11px]">
                               {attempt.quotes.map((quote: MtmPipelineEvidenceQuote) => {
                                  const isWinTotal = isWinTotalSeries(quote.series, quote.ticker);
                                  return (
                                  <tr key={quote.ticker} className="hover:bg-muted/30 transition-colors">
                                     <td className="px-3 py-2">
                                        <span className={cn("px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest rounded-sm", isWinTotal ? "text-blue-700 bg-blue-500/10 dark:text-blue-400" : "text-amber-700 bg-amber-500/10 dark:text-amber-400")}>
                                           {isWinTotal ? "WIN TOTAL" : "ELIM"}
                                        </span>
                                     </td>
                                     <td className="px-3 py-2 font-semibold">{quote.team ?? "—"}</td>
                                     <td className="px-3 py-2 text-muted-foreground">{quote.ticker}</td>
                                     <td className="px-3 py-2 text-right">{formatEvidenceQuote(quote.strike)}</td>
                                     <td className="px-3 py-2 text-right">{formatEvidenceQuote(quote.bid)}</td>
                                     <td className="px-3 py-2 text-right">{formatEvidenceQuote(quote.ask)}</td>
                                     <td className="px-3 py-2 text-right text-muted-foreground">{quote.volume ?? "—"}</td>
                                     <td className="px-3 py-2 text-muted-foreground">
                                       {new Date(quote.fetchedAt).toLocaleString("en-US", {
                                         timeZone: "America/New_York",
                                         month: "short",
                                         day: "numeric",
                                         hour: "numeric",
                                         minute: "2-digit",
                                       })}
                                     </td>
                                  </tr>
                               )})}
                            </tbody>
                         </table>
                       </div>
                    </div>
                    )}
                  </div>

                {attempt.diagnostics && Object.keys(attempt.diagnostics).length > 0 && (
                  <div>
                    <h4 className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5">
                      <Info className="w-3 h-3" /> Diagnostics
                    </h4>
                    <div className="border border-border rounded-sm bg-muted/20">
                      <pre className="p-4 text-[10px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap break-words">
                         {JSON.stringify(attempt.diagnostics, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
           </div>
        )}
      </div>
    </div>
  );
}
