import type { TradeRow } from "@workspace/api-client-react";

export type TradeGroup = {
  key: string;
  trades: TradeRow[];
};

export function sharedTradeDescription(notes: string | null | undefined): string {
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

export function buildTradeGroups(trades: TradeRow[]): TradeGroup[] {
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

export function sortTradeGroups(a: TradeGroup, b: TradeGroup): number {
  const aStatus = a.trades[0]?.status ?? "pending";
  const bStatus = b.trades[0]?.status ?? "pending";
  const statusOrder: Record<string, number> = {
    pending: 0,
    approved: 1,
    voided: 2,
    rejected: 3,
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