import { useState, useEffect, useMemo, useRef } from "react";
import {
  useGetTrades,
  useGetTeams,
  useGetBidders,
  useCreateTrade,
  useDeleteTrade,
} from "@workspace/api-client-react";
import type { TradeInput, TradeRow } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { todayInNewYork } from "@/lib/newYorkTime";
import { useSeason } from "@/hooks/useSeason";
import { useBacklinkBackShortcut } from "@/hooks/useBacklinkBackShortcut";
import { useLocation } from "wouter";
import { parseResultSourceTarget } from "@/lib/resultSourceLinks";
import {
  ArrowRight,
  Plus,
  Trash2,
  X,
  Lock,
  Unlock,
  Check,
  Ban,
  Search,
  ChevronDown,
} from "lucide-react";
import { bidderConsortiums, ownerLabelById } from "@/lib/ownerDisplay";
import { ConsortiumLabel } from "@/components/ConsortiumLabel";

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
      body: JSON.stringify({ status, confirmed: true }),
    });
    if (res.status === 401) return { ok: false, error: "Invalid admin key" };
    if (!res.ok) return { ok: false, error: await res.text() };
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

function decisionAuditLabel(trade: TradeRow): string | null {
  if (trade.status === "pending") return null;
  if (!trade.decisionAt) return "Historical decision · audit details unavailable";

  const channel =
    trade.decisionSource === "commissioner_mcp"
      ? "Commissioner MCP"
      : trade.decisionSource === "commissioner_api"
        ? "Commissioner app"
        : "Commissioner channel";
  const timestamp = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(trade.decisionAt));
  return `Decision recorded ${timestamp} · ${channel}`;
}

type TradeGroup = {
  key: string;
  trades: TradeRow[];
};

function sharedTradeDescription(notes: string | null | undefined): string {
  const description = (notes ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
  const withoutLeadingLeg = description.replace(
    /^leg\s+\d+\s+(?:of|\/)\s*\d+\s*:\s*/i,
    "",
  );
  const withoutTrailingLeg = withoutLeadingLeg.replace(
    /\s*[.;,]?\s*leg\s+\d+\s*(?:\/|of)\s*\d+(?:\s*[-–—:]\s*[^.]*)?\.?\s*$/i,
    "",
  );
  const sharedLead = withoutTrailingLeg.match(/^(.+?\bleg\b[^.]*\.)\s+.+$/i);
  return sharedLead?.[1] ?? withoutTrailingLeg;
}

function normalizeTradeDescription(notes: string | null | undefined): string {
  return sharedTradeDescription(notes).toLowerCase();
}

function tradeGroupKey(trade: TradeRow): string {
  const description = normalizeTradeDescription(trade.notes);
  const counterparties = [trade.fromBidderId, trade.toBidderId].sort((a, b) => a - b);
  return [
    description,
    trade.tradeDate,
    trade.status,
    counterparties[0],
    counterparties[1],
  ].join("|");
}

function teamNamesInDescription(trades: TradeRow[], description: string): boolean {
  const uniqueTeams = [...new Set(trades.map((trade) => trade.teamName))];
  return uniqueTeams.length > 1 && uniqueTeams.every((teamName) => {
    const normalizedName = teamName.normalize("NFKC").toLowerCase();
    const nickname = normalizedName.split(/\s+/).at(-1) ?? normalizedName;
    return description.includes(normalizedName) || description.includes(nickname);
  });
}

function hasExplicitLegLabel(notes: string | null | undefined): boolean {
  const rawNotes = (notes ?? "").normalize("NFKC").replace(/\s+/g, " ");
  return /\bleg\s+\d+\s*(?:of|\/)\s*\d+\b/i.test(rawNotes);
}

function hasTransactionSignal(trades: TradeRow[]): boolean {
  const description = normalizeTradeDescription(trades[0]?.notes);
  if (!description) return false;

  return (
    trades.every((trade) => hasExplicitLegLabel(trade.notes)) ||
    /\bcrossbook\b/.test(description) ||
    teamNamesInDescription(trades, description)
  );
}

function buildTradeGroups(trades: TradeRow[]): TradeGroup[] {
  const groups = new Map<string, TradeRow[]>();
  for (const trade of trades) {
    const existing = groups.get(tradeGroupKey(trade));
    if (existing) {
      existing.push(trade);
    } else {
      groups.set(tradeGroupKey(trade), [trade]);
    }
  }

  return [...groups.entries()].flatMap(([key, groupedTrades]) => {
    if (groupedTrades.length > 1 && hasTransactionSignal(groupedTrades)) {
      return [{
        key,
        trades: [...groupedTrades].sort((a, b) => b.id - a.id),
      }];
    }

    return groupedTrades.map((trade) => ({
      key: `${key}|${trade.id}`,
      trades: [trade],
    }));
  });
}

function latestDecisionTime(group: TradeGroup): number {
  return Math.max(
    ...group.trades.map((trade) => {
      if (!trade.decisionAt) return 0;
      const timestamp = Date.parse(trade.decisionAt);
      return Number.isFinite(timestamp) ? timestamp : 0;
    }),
  );
}

function latestTradeDate(group: TradeGroup): string {
  return group.trades.reduce(
    (latest, trade) => (trade.tradeDate > latest ? trade.tradeDate : latest),
    "",
  );
}

function sortTradeGroups(a: TradeGroup, b: TradeGroup): number {
  const aStatus = a.trades[0]?.status ?? "pending";
  const bStatus = b.trades[0]?.status ?? "pending";
  const statusOrder: Record<string, number> = {
    pending: 0,
    approved: 1,
    rejected: 2,
  };

  if (aStatus !== bStatus) {
    return (statusOrder[aStatus] ?? 99) - (statusOrder[bStatus] ?? 99);
  }

  if (aStatus === "approved") {
    const approvalOrder = latestDecisionTime(b) - latestDecisionTime(a);
    if (approvalOrder !== 0) return approvalOrder;
  } else if (aStatus === "rejected") {
    const decisionOrder = latestDecisionTime(b) - latestDecisionTime(a);
    if (decisionOrder !== 0) return decisionOrder;
  }

  const dateOrder = latestTradeDate(b).localeCompare(latestTradeDate(a));
  if (dateOrder !== 0) return dateOrder;

  const aMaxId = Math.max(...a.trades.map((trade) => trade.id));
  const bMaxId = Math.max(...b.trades.map((trade) => trade.id));
  return bMaxId - aMaxId;
}

function tradeOwnerLabel(
  bidderId: number,
  bidderName: string,
  consortiumByBidderId: Map<number, string>,
): string {
  return ownerLabelById(bidderId, bidderName, consortiumByBidderId);
}

function TradeActions({
  trade,
  onDelete,
  adminKey,
  onStatusChange,
  showDelete = true,
}: {
  trade: TradeRow;
  onDelete: (id: number) => void;
  adminKey: string | null;
  onStatusChange: () => void;
  showDelete?: boolean;
}) {
  const [acting, setActing] = useState(false);
  const [adminError, setAdminError] = useState("");

  async function handleStatus(status: "approved" | "rejected") {
    if (!adminKey) return;
    const decision = status === "approved" ? "approve" : "reject";
    const confirmed = window.confirm(
      `${decision[0].toUpperCase()}${decision.slice(1)} ${trade.teamName} (${trade.percentage}% from ${trade.fromBidderName} to ${trade.toBidderName})?\n\nThis decision is permanent. Choose OK to record it.`,
    );
    if (!confirmed) return;

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

  return (
    <>
      {showDelete && (
        <button
          onClick={() => onDelete(trade.id)}
          className="text-muted-foreground hover:text-destructive transition-colors"
          title="Delete trade"
          aria-label={`Delete trade ${trade.id}`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}

      {adminKey && trade.status === "pending" && (
        <div className="border-t border-border pt-2 flex items-center gap-2 flex-wrap basis-full">
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
    </>
  );
}

// ── Trade card ───────────────────────────────────────────────────────────────

function TradeCard({
  trade,
  onDelete,
  adminKey,
  onStatusChange,
  consortiumByBidderId,
  isHighlighted = false,
}: {
  trade: TradeRow;
  onDelete: (id: number) => void;
  adminKey: string | null;
  onStatusChange: () => void;
  consortiumByBidderId: Map<number, string>;
  isHighlighted?: boolean;
}) {
  const showPct = trade.percentage !== 100;

  return (
    <div
      id={`trade-${trade.id}`}
      tabIndex={-1}
      className={cn(
        "scroll-mt-6 border border-border p-4 space-y-3 focus:outline-none",
        trade.status === "pending" && "border-amber-200 bg-amber-50/30",
        trade.status === "rejected" && "opacity-60",
        isHighlighted && "ring-2 ring-primary ring-offset-2 bg-primary/10",
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
            <ConsortiumLabel
              className="flex-1 min-w-0"
              label={ownerLabelById(
                trade.fromBidderId,
                trade.fromBidderName,
                consortiumByBidderId,
              )}
            />
            <ArrowRight className="w-3 h-3" />
            <ConsortiumLabel
              className="flex-1 min-w-0"
              label={ownerLabelById(
                trade.toBidderId,
                trade.toBidderName,
                consortiumByBidderId,
              )}
            />
          </div>
        </div>

        {/* Right: price + date + delete */}
        <div className="text-right shrink-0 space-y-1">
          <div className="font-mono font-bold text-sm">{formatCurrency(trade.price)}</div>
          <div className="text-xs text-muted-foreground font-mono">{trade.tradeDate}</div>
          <TradeActions
            trade={trade}
            onDelete={onDelete}
            adminKey={null}
            onStatusChange={onStatusChange}
          />
        </div>
      </div>

      {trade.notes && (
        <p className="text-xs text-muted-foreground font-mono border-t border-border pt-2">{trade.notes}</p>
      )}
      {decisionAuditLabel(trade) && (
        <p className="text-[11px] text-muted-foreground font-mono border-t border-border pt-2">
          {decisionAuditLabel(trade)}
        </p>
      )}

      {/* Admin approve/reject — only for pending trades when admin key is entered */}
      {adminKey && trade.status === "pending" && (
        <TradeActions
          trade={trade}
          onDelete={() => {}}
          adminKey={adminKey}
          onStatusChange={onStatusChange}
          showDelete={false}
        />
      )}
    </div>
  );
}

function TradeLeg({
  trade,
  onDelete,
  adminKey,
  onStatusChange,
  consortiumByBidderId,
  isHighlighted = false,
}: {
  trade: TradeRow;
  onDelete: (id: number) => void;
  adminKey: string | null;
  onStatusChange: () => void;
  consortiumByBidderId: Map<number, string>;
  isHighlighted?: boolean;
}) {
  return (
    <div
      id={`trade-${trade.id}`}
      tabIndex={-1}
      className={cn(
        "scroll-mt-6 border-t border-border px-4 py-3 space-y-2 focus:outline-none",
        isHighlighted && "ring-2 ring-primary ring-inset bg-primary/10",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-bold text-sm">{trade.teamName}</span>
            <span className="bg-muted border border-border px-1.5 py-0 text-[10px] font-mono text-muted-foreground">
              {trade.percentage}%
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground font-mono">
            <span className="sr-only">Direction: </span>
            <ConsortiumLabel
              className="min-w-0"
              label={tradeOwnerLabel(
                trade.fromBidderId,
                trade.fromBidderName,
                consortiumByBidderId,
              )}
            />
            <ArrowRight className="w-3 h-3 shrink-0" aria-hidden="true" />
            <ConsortiumLabel
              className="min-w-0"
              label={tradeOwnerLabel(
                trade.toBidderId,
                trade.toBidderName,
                consortiumByBidderId,
              )}
            />
          </div>
        </div>
        <div className="text-right shrink-0 space-y-1">
          <div className="font-mono font-bold text-sm">{formatCurrency(trade.price)}</div>
          <TradeActions
            trade={trade}
            onDelete={onDelete}
            adminKey={null}
            onStatusChange={onStatusChange}
          />
        </div>
      </div>

      {trade.decisionAt && decisionAuditLabel(trade) && (
        <p className="text-[11px] text-muted-foreground font-mono border-t border-border pt-2">
          {decisionAuditLabel(trade)}
        </p>
      )}

      {adminKey && trade.status === "pending" && (
        <TradeActions
          trade={trade}
          onDelete={() => {}}
          adminKey={adminKey}
          onStatusChange={onStatusChange}
          showDelete={false}
        />
      )}
    </div>
  );
}

function TradeGroupCard({
  group,
  expanded,
  onToggle,
  onDelete,
  adminKey,
  onStatusChange,
  consortiumByBidderId,
  highlightedTradeId,
}: {
  group: TradeGroup;
  expanded: boolean;
  onToggle: () => void;
  onDelete: (id: number) => void;
  adminKey: string | null;
  onStatusChange: () => void;
  consortiumByBidderId: Map<number, string>;
  highlightedTradeId: number | null;
}) {
  const firstTrade = group.trades[0];
  const description = sharedTradeDescription(firstTrade.notes) || "Trade transaction";
  const totalValue = group.trades.reduce((total, trade) => total + trade.price, 0);
  const teamNames = [...new Set(group.trades.map((trade) => trade.teamName))];
  const fromLabel = tradeOwnerLabel(
    firstTrade.fromBidderId,
    firstTrade.fromBidderName,
    consortiumByBidderId,
  );
  const toLabel = tradeOwnerLabel(
    firstTrade.toBidderId,
    firstTrade.toBidderName,
    consortiumByBidderId,
  );
  const groupId = `trade-group-${group.trades.map((trade) => trade.id).sort((a, b) => a - b).join("-")}`;
  const latestDecisionTrade = [...group.trades].sort((a, b) => {
    const aTime = a.decisionAt ? Date.parse(a.decisionAt) : 0;
    const bTime = b.decisionAt ? Date.parse(b.decisionAt) : 0;
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  })[0];

  return (
    <div
      className={cn(
        "border border-border overflow-hidden",
        firstTrade.status === "pending" && "border-amber-200 bg-amber-50/30",
        firstTrade.status === "rejected" && "opacity-60",
      )}
      data-trade-group={group.key}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={groupId}
        className="w-full text-left p-4 space-y-3 hover:bg-muted/30 transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono font-bold text-sm">{description}</span>
              <StatusBadge status={firstTrade.status} />
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
                {group.trades.length} legs
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground font-mono">
              <ConsortiumLabel className="min-w-0" label={fromLabel} />
              <ArrowRight className="w-3 h-3 shrink-0" aria-hidden="true" />
              <ConsortiumLabel className="min-w-0" label={toLabel} />
            </div>
          </div>
          <div className="flex items-start gap-3 shrink-0">
            <div className="text-right space-y-1">
              <div className="font-mono font-bold text-sm">{formatCurrency(totalValue)}</div>
              <div className="text-xs text-muted-foreground font-mono">{firstTrade.tradeDate}</div>
            </div>
            <ChevronDown
              className={cn(
                "w-4 h-4 mt-1 text-muted-foreground transition-transform",
                !expanded && "-rotate-90",
              )}
              aria-hidden="true"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground font-mono">
          <span>Teams: {teamNames.join(", ")}</span>
          <span>Aggregate: {formatCurrency(totalValue)}</span>
        </div>
        {decisionAuditLabel(latestDecisionTrade) && (
          <p className="text-[11px] text-muted-foreground font-mono border-t border-border pt-2">
            {decisionAuditLabel(latestDecisionTrade)}
          </p>
        )}
      </button>

      <div
        id={groupId}
        role="group"
        aria-label={`${description} trade legs`}
        hidden={!expanded}
      >
          {group.trades.map((trade) => (
            <TradeLeg
              key={trade.id}
              trade={trade}
              onDelete={onDelete}
              adminKey={adminKey}
              onStatusChange={onStatusChange}
              consortiumByBidderId={consortiumByBidderId}
              isHighlighted={highlightedTradeId === trade.id}
            />
          ))}
      </div>
    </div>
  );
}

function TradeGroupPresentation({
  group,
  expanded,
  onToggle,
  onDelete,
  adminKey,
  onStatusChange,
  consortiumByBidderId,
  highlightedTradeId,
}: {
  group: TradeGroup;
  expanded: boolean;
  onToggle: () => void;
  onDelete: (id: number) => void;
  adminKey: string | null;
  onStatusChange: () => void;
  consortiumByBidderId: Map<number, string>;
  highlightedTradeId: number | null;
}) {
  if (group.trades.length === 1) {
    const trade = group.trades[0];
    return (
      <TradeCard
        trade={trade}
        onDelete={onDelete}
        adminKey={adminKey}
        onStatusChange={onStatusChange}
        consortiumByBidderId={consortiumByBidderId}
        isHighlighted={highlightedTradeId === trade.id}
      />
    );
  }

  return (
    <TradeGroupCard
      group={group}
      expanded={expanded}
      onToggle={onToggle}
      onDelete={onDelete}
      adminKey={adminKey}
      onStatusChange={onStatusChange}
      consortiumByBidderId={consortiumByBidderId}
      highlightedTradeId={highlightedTradeId}
    />
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
  submitError,
}: {
  teams: any[];
  fromBidders: any[];
  toBidders: any[];
  seasonYear: number;
  onCreate: (data: TradeInput) => void;
  onClose: () => void;
  creating: boolean;
  submitError?: string;
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
  // Synthetic trades intentionally allow a seller with no current positive
  // ownership. The commissioner decides whether the proposed sale is valid.
  const eligibleFromBidders = fromBidders;

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
          <h2 className="font-mono font-bold uppercase tracking-widest text-sm">Submit Trade for Review</h2>
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

          <Field label="Seller / Short Seller">
            <select value={fromId} onChange={(e) => setFromId(e.target.value)} className="w-full border border-border bg-background px-3 py-2 text-sm">
              <option value="">Select seller…</option>
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
            ⏳ This will be submitted as <strong>PENDING REVIEW</strong>. Any bidder can be selected as the seller, including one with no current stake, for a synthetic or short sale. A commissioner must approve it before it affects results.
          </p>
          {submitError && (
            <p role="alert" className="text-xs text-destructive font-mono border border-destructive/30 bg-destructive/5 px-3 py-2">
              {submitError}
            </p>
          )}
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
          <p className="text-xs font-mono text-muted-foreground">
            Enter your admin key to approve or reject pending trades. It is kept only until this page reloads.
          </p>
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
  const { year, setYear } = useSeason();
  const [location] = useLocation();
  const sourceTarget = parseResultSourceTarget(
    typeof window === "undefined" ? location : window.location.href,
  );
  useBacklinkBackShortcut(sourceTarget.tradeId != null);
  const [showForm, setShowForm]     = useState(false);
  const [submissionError, setSubmissionError] = useState("");
  const [adminKey, setAdminKey]     = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const sourceExpandedTradeId = useRef<number | null>(null);

  const { data: trades, isLoading, refetch } = useGetTrades({ season: year });
  const { data: teams } = useGetTeams({ season: year });
  const { data: bidderDirectory } = useGetBidders({});
  const consortiumByBidderId = bidderConsortiums(bidderDirectory);
  const { mutate: createTrade, isPending: creating } = useCreateTrade();
  const { mutate: deleteTrade } = useDeleteTrade();

  function saveAdminKey(key: string) {
    setAdminKey(key);
  }

  function clearAdminKey() {
    setAdminKey(null);
  }

  function handleDelete(id: number) {
    if (!confirm("Delete this trade record?")) return;
    deleteTrade({ id }, { onSuccess: () => refetch() });
  }

  const [search, setSearch] = useState("");
  const allTrades = (trades as TradeRow[] | undefined) ?? [];
  const query = search.trim().toLowerCase();
  const allGroups = useMemo(() => buildTradeGroups(allTrades), [allTrades]);
  const matchesSearch = (trade: TradeRow) =>
    [
      trade.teamName,
      trade.fromBidderName,
      trade.toBidderName,
      ownerLabelById(
        trade.fromBidderId,
        trade.fromBidderName,
        consortiumByBidderId,
      ),
      ownerLabelById(
        trade.toBidderId,
        trade.toBidderName,
        consortiumByBidderId,
      ),
      trade.status,
      trade.tradeDate,
      trade.percentage.toString(),
      trade.price.toString(),
      trade.notes ?? "",
    ].some((value) => value.toLowerCase().includes(query));
  const filteredTrades = query
    ? allTrades.filter(matchesSearch)
    : allTrades;
  const visibleGroups = useMemo(
    () =>
      allGroups
        .filter((group) => !query || group.trades.some(matchesSearch))
        .sort(sortTradeGroups),
    [allGroups, query, consortiumByBidderId],
  );
  const pending = visibleGroups.filter((group) => group.trades[0]?.status === "pending");
  const approved = visibleGroups.filter((group) => group.trades[0]?.status === "approved");
  const rejected = visibleGroups.filter((group) => group.trades[0]?.status === "rejected");
  const targetGroup = sourceTarget.tradeId == null
    ? null
    : allGroups.find((group) =>
        group.trades.some((trade) => trade.id === sourceTarget.tradeId),
      ) ?? null;

  useEffect(() => {
    if (sourceTarget.seasonYear != null && sourceTarget.seasonYear !== year) {
      setYear(sourceTarget.seasonYear);
    }
  }, [setYear, sourceTarget.seasonYear, year]);

  useEffect(() => {
    if (sourceTarget.tradeId == null) {
      sourceExpandedTradeId.current = null;
      return;
    }

    if (
      sourceTarget.seasonYear != null && sourceTarget.seasonYear !== year ||
      isLoading ||
      !targetGroup ||
      targetGroup.trades.length < 2 ||
      sourceExpandedTradeId.current === sourceTarget.tradeId
    ) {
      return;
    }

    sourceExpandedTradeId.current = sourceTarget.tradeId;
    setExpandedGroups((current) => {
      if (current.has(targetGroup.key)) return current;
      const next = new Set(current);
      next.add(targetGroup.key);
      return next;
    });
  }, [
    isLoading,
    sourceTarget.seasonYear,
    sourceTarget.tradeId,
    targetGroup,
    year,
  ]);

  useEffect(() => {
    if (
      sourceTarget.tradeId == null ||
      sourceTarget.seasonYear != null && sourceTarget.seasonYear !== year ||
      isLoading ||
      !targetGroup ||
      targetGroup.trades.length >= 2 && !expandedGroups.has(targetGroup.key)
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const leg = document.getElementById(`trade-${sourceTarget.tradeId}`);
      if (!leg) return;
      leg.scrollIntoView({ behavior: "smooth", block: "center" });
      leg.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    expandedGroups,
    isLoading,
    location,
    sourceTarget.seasonYear,
    sourceTarget.tradeId,
    targetGroup,
    year,
  ]);

  return (
    <div className="space-y-5 px-4 pb-6 pt-4 md:space-y-6 md:p-8 max-w-4xl mx-auto">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-1" data-testid="text-trades-title">Trades</h1>
          <p className="text-muted-foreground font-mono text-xs md:text-sm uppercase tracking-widest">
            Team trades & settlements · {year}
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto sm:gap-3 flex-wrap">
          <AdminPanel adminKey={adminKey} onSetKey={saveAdminKey} onClearKey={clearAdminKey} />
          <button
            data-testid="button-submit-trade"
            onClick={() => { setSubmissionError(""); setShowForm(true); }}
            className="flex flex-1 items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground font-mono font-bold uppercase tracking-widest text-xs hover:bg-primary/90 transition-colors h-10 sm:flex-none"
          >
            <Plus className="w-4 h-4" /> Submit Trade
          </button>
        </div>
      </header>

      {sourceTarget.tradeId != null && (
        <div className="border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-mono text-muted-foreground">
          Back to Results: <kbd className="border border-border bg-background px-1.5 py-0.5 text-foreground">Ctrl + [</kbd>
        </div>
      )}

      {adminKey && (
        <div className="border border-green-300 bg-green-50 px-4 py-2 text-xs font-mono text-green-800">
          Admin mode is active for this page only — every approval or rejection requires confirmation.
        </div>
      )}

      {showForm && teams && bidderDirectory && (
        <TradeForm
          teams={teams}
          fromBidders={bidderDirectory}
          toBidders={bidderDirectory}
          seasonYear={year}
          onCreate={(data) =>
            createTrade({ data }, {
              onSuccess: () => {
                setSubmissionError("");
                setShowForm(false);
                refetch();
              },
              onError: (error) => {
                const apiError = error as {
                  data?: { error?: string };
                  message?: string;
                };
                setSubmissionError(
                  apiError.data?.error ??
                    apiError.message ??
                    "Could not submit this trade. Please check the details and try again.",
                );
              },
            })
          }
          onClose={() => { setSubmissionError(""); setShowForm(false); }}
          creating={creating}
          submitError={submissionError}
        />
      )}

      {!isLoading && allTrades.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              data-testid="input-trade-filter"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by team, bidder, consortium, status…"
              aria-label="Filter trades"
              className="w-full border border-border bg-background pl-9 pr-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          {query && (
            <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
              {filteredTrades.length} of {allTrades.length} trades
            </span>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3 animate-pulse">
          {[1, 2, 3].map((i) => <div key={i} className="h-20 bg-muted border border-border" />)}
        </div>
      ) : !allTrades.length ? (
        <div className="border border-dashed border-border flex flex-col items-center justify-center py-24 text-center">
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">No trades recorded for {year}</p>
          <p className="text-xs text-muted-foreground mt-2">Use Submit Trade to propose a trade — it will start as Pending Review</p>
        </div>
      ) : !filteredTrades.length ? (
        <div className="border border-dashed border-border flex flex-col items-center justify-center py-24 text-center">
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
            No trades match “{search}”
          </p>
          <button
            type="button"
            onClick={() => setSearch("")}
            className="mt-3 text-xs font-mono uppercase tracking-widest text-primary hover:underline"
          >
            Clear filter
          </button>
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
                {pending.map((group) => (
                  <TradeGroupPresentation
                    key={group.key}
                    group={group}
                    expanded={expandedGroups.has(group.key)}
                    onToggle={() =>
                      setExpandedGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                    onDelete={handleDelete}
                    adminKey={adminKey}
                    onStatusChange={refetch}
                    consortiumByBidderId={consortiumByBidderId}
                    highlightedTradeId={sourceTarget.tradeId}
                  />
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
                {approved.map((group) => (
                  <TradeGroupPresentation
                    key={group.key}
                    group={group}
                    expanded={expandedGroups.has(group.key)}
                    onToggle={() =>
                      setExpandedGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                    onDelete={handleDelete}
                    adminKey={adminKey}
                    onStatusChange={refetch}
                    consortiumByBidderId={consortiumByBidderId}
                    highlightedTradeId={sourceTarget.tradeId}
                  />
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
                {rejected.map((group) => (
                  <TradeGroupPresentation
                    key={group.key}
                    group={group}
                    expanded={expandedGroups.has(group.key)}
                    onToggle={() =>
                      setExpandedGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                    onDelete={handleDelete}
                    adminKey={adminKey}
                    onStatusChange={refetch}
                    consortiumByBidderId={consortiumByBidderId}
                    highlightedTradeId={sourceTarget.tradeId}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
