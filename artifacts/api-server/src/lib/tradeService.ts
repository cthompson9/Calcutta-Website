import { and, eq } from "drizzle-orm";
import {
  calcuttaEntriesTable,
  db,
  positionsTable,
  tradesTable,
} from "@workspace/db";
import { resolveCalcuttaId } from "./calcuttaContext";
import { validatePrimaryOwnership } from "./ownershipShares";

export const MIN_TRADE_PERCENTAGE = 1;
export const MAX_TRADE_PERCENTAGE = 100;

type TradeReader = Pick<typeof db, "select">;
type TradeWriter = Pick<typeof db, "select" | "insert">;

export async function validateTradeOwnership(
  args: {
    entryId: number;
    fromBidderId: number;
    toBidderId: number;
    percentage: number;
  },
  query: TradeReader = db,
  requireCompletePrimaryOwnership = false,
): Promise<string | null> {
  if (args.fromBidderId === args.toBidderId) {
    return "Seller and buyer must be different owners.";
  }
  if (
    !Number.isFinite(args.percentage) ||
    args.percentage < MIN_TRADE_PERCENTAGE ||
    args.percentage > MAX_TRADE_PERCENTAGE
  ) {
    return `Trade percentage must be between ${MIN_TRADE_PERCENTAGE}% and ${MAX_TRADE_PERCENTAGE}%.`;
  }

  const primaryOwners = await query
    .select({
      bidderId: positionsTable.bidderId,
      ownershipShare: positionsTable.ownershipShare,
    })
    .from(positionsTable)
    .where(and(
      eq(positionsTable.entryId, args.entryId),
      eq(positionsTable.source, "primary"),
    ));
  if (!primaryOwners.length) {
    return "Team has no primary positions in the selected Calcutta and cannot be traded.";
  }
  if (requireCompletePrimaryOwnership) {
    const split = validatePrimaryOwnership(primaryOwners.map((owner) => ({
      bidderId: owner.bidderId,
      share: Number(owner.ownershipShare),
    })));
    if (!split.ok) {
      return `The team's original auction ownership is incomplete or invalid: ${split.error}`;
    }
  }
  return null;
}

/**
 * Creates a pending trade against an existing Calcutta entry. This deliberately
 * performs no identity creation: callers must resolve season, team, and bidders
 * before entering the locked transaction.
 */
export async function createPendingTrade(
  writer: TradeWriter,
  args: {
    seasonId: number;
    calcuttaId?: number;
    teamId: number;
    fromBidderId: number;
    toBidderId: number;
    percentage?: number;
    price?: number;
    tradeDate: string;
    notes?: string;
  },
): Promise<
  | { ok: true; tradeId: number; price: number }
  | { ok: false; error: string }
> {
  const percentage = args.percentage ?? 100;
  if (args.price !== undefined && (!Number.isFinite(args.price) || args.price < 0)) {
    return { ok: false, error: "Trade price must be a non-negative number." };
  }
  const calcuttaId = await resolveCalcuttaId(writer, {
    seasonId: args.seasonId,
    calcuttaId: args.calcuttaId,
  });
  if (!calcuttaId) return { ok: false, error: "Calcutta not found for this season." };
  const entry = await writer
    .select({ id: calcuttaEntriesTable.id })
    .from(calcuttaEntriesTable)
    .where(and(
      eq(calcuttaEntriesTable.calcuttaId, calcuttaId),
      eq(calcuttaEntriesTable.teamId, args.teamId),
    ))
    .limit(1);
  if (!entry[0]) return { ok: false, error: "Team is not an entry in the selected Calcutta." };

  const error = await validateTradeOwnership({
    entryId: entry[0].id,
    fromBidderId: args.fromBidderId,
    toBidderId: args.toBidderId,
    percentage,
  }, writer);
  if (error) return { ok: false, error };
  let price = args.price;
  if (price === undefined) {
    const primaryRows = await writer
      .select({ costBasis: positionsTable.costBasis })
      .from(positionsTable)
      .where(and(eq(positionsTable.entryId, entry[0].id), eq(positionsTable.source, "primary")));
    price = Math.round(
      primaryRows.reduce((sum, row) => sum + Number(row.costBasis), 0) * percentage,
    ) / 100;
  }
  const [trade] = await writer.insert(tradesTable).values({
    seasonId: args.seasonId,
    teamId: args.teamId,
    entryId: entry[0].id,
    fromBidderId: args.fromBidderId,
    toBidderId: args.toBidderId,
    price: price.toFixed(2),
    percentage: percentage.toString(),
    status: "pending",
    tradeDate: args.tradeDate,
    notes: args.notes,
  }).returning({ id: tradesTable.id });
  return { ok: true, tradeId: trade.id, price };
}