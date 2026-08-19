/**
 * Season ownership and effective share helper.
 *
 * Computes per-bidder effective ownership for a season by starting from
 * team_bidders (primary auction owners) and then applying APPROVED trades.
 *
 * Exposed types and the single async factory `loadSeasonOwnership(seasonId)`.
 */
import { eq, and } from "drizzle-orm";
import { db, teamBiddersTable, tradesTable, biddersTable } from "@workspace/db";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OwnerEntry {
  /** Fraction held at auction time (from team_bidders). */
  originalShare: number;
  /** Current fraction after all approved trades (can be 0 if fully sold). */
  effectiveShare: number;
  /** Cash paid to acquire shares via trades (as toBidder). */
  tradePaid: number;
  /** Cash received from selling shares via trades (as fromBidder). */
  tradeReceived: number;
}

/** Per-team map of bidderId → OwnerEntry. */
export type TeamOwnerMap = Map<number, OwnerEntry>;

/** Bidder as they appear in the resolved ownership data. */
export interface BidderInfo {
  id: number;
  name: string;
}

export interface SeasonOwnership {
  /**
   * bidderId → teamId → OwnerEntry.
   * Contains every bidder that has any economic interest in any team this season.
   */
  byBidder: Map<number, TeamOwnerMap>;

  /**
   * teamId → array of bidders with effectiveShare > 0 (current owners).
   * Sorted by effectiveShare descending.
   */
  currentOwnersByTeam: Map<
    number,
    Array<{ bidderId: number; bidderName: string; ownershipShare: number }>
  >;

  /**
   * Set of bidder IDs that are season participants:
   * primary team_bidders owners ∪ APPROVED trade toBidders.
   */
  participantIds: Set<number>;

  /**
   * Map of bidderId → name for all participants.
   */
  bidderNames: Map<number, string>;
}

// ── Internal helper ───────────────────────────────────────────────────────────

function getOrCreateEntry(
  byBidder: Map<number, TeamOwnerMap>,
  bidderId: number,
  teamId: number,
): OwnerEntry {
  if (!byBidder.has(bidderId)) byBidder.set(bidderId, new Map());
  const teamMap = byBidder.get(bidderId)!;
  if (!teamMap.has(teamId)) {
    teamMap.set(teamId, {
      originalShare: 0,
      effectiveShare: 0,
      tradePaid: 0,
      tradeReceived: 0,
    });
  }
  return teamMap.get(teamId)!;
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Load and compute all season ownership data for a given seasonId.
 *
 * Steps:
 *  1. Fetch all team_bidders rows for the season (primary auction owners).
 *  2. Fetch all APPROVED trades for the season.
 *  3. Apply trades to derive effectiveShare, tradePaid, tradeReceived.
 *  4. Fetch bidder names for all participants.
 *  5. Build currentOwnersByTeam (effectiveShare > 0 per team).
 */
export async function loadSeasonOwnership(seasonId: number): Promise<SeasonOwnership> {
  // 1. Primary ownership from team_bidders
  const primaryRows = await db
    .select({
      teamId: teamBiddersTable.teamId,
      bidderId: teamBiddersTable.bidderId,
      ownershipShare: teamBiddersTable.ownershipShare,
    })
    .from(teamBiddersTable)
    .where(eq(teamBiddersTable.seasonId, seasonId));

  // 2. Approved trades
  const approvedTrades = await db
    .select({
      teamId: tradesTable.teamId,
      fromBidderId: tradesTable.fromBidderId,
      toBidderId: tradesTable.toBidderId,
      percentage: tradesTable.percentage,
      price: tradesTable.price,
    })
    .from(tradesTable)
    .where(and(eq(tradesTable.seasonId, seasonId), eq(tradesTable.status, "approved")));

  // 3. Build byBidder map
  const byBidder: Map<number, TeamOwnerMap> = new Map();

  // Seed from primary ownership
  for (const row of primaryRows) {
    const share = parseFloat(row.ownershipShare);
    const entry = getOrCreateEntry(byBidder, row.bidderId, row.teamId);
    entry.originalShare += share;
    entry.effectiveShare += share;
  }

  // Apply approved trades
  for (const trade of approvedTrades) {
    const tradeShare = parseFloat(trade.percentage) / 100;
    const tradePrice = parseFloat(trade.price);

    // fromBidder loses share and receives cash
    const fromEntry = getOrCreateEntry(byBidder, trade.fromBidderId, trade.teamId);
    fromEntry.effectiveShare -= tradeShare;
    fromEntry.tradeReceived += tradePrice;

    // toBidder gains share and pays cash
    const toEntry = getOrCreateEntry(byBidder, trade.toBidderId, trade.teamId);
    toEntry.effectiveShare += tradeShare;
    toEntry.tradePaid += tradePrice;
  }

  // 4. Collect participant IDs and fetch names
  const participantIds = new Set<number>();
  for (const row of primaryRows) participantIds.add(row.bidderId);
  for (const trade of approvedTrades) participantIds.add(trade.toBidderId);

  const bidderNames = new Map<number, string>();
  if (participantIds.size > 0) {
    // Collect all bidder IDs referenced in byBidder (includes fromBidders with residual interest)
    const allReferencedIds = new Set(participantIds);
    for (const trade of approvedTrades) allReferencedIds.add(trade.fromBidderId);

    const bidderRows = await db
      .select({ id: biddersTable.id, name: biddersTable.name })
      .from(biddersTable);
    for (const b of bidderRows) {
      if (allReferencedIds.has(b.id)) bidderNames.set(b.id, b.name);
    }
  }

  // 5. Build currentOwnersByTeam: teams → bidders with effectiveShare > 0
  const currentOwnersByTeam = new Map<
    number,
    Array<{ bidderId: number; bidderName: string; ownershipShare: number }>
  >();

  for (const [bidderId, teamMap] of byBidder) {
    for (const [teamId, entry] of teamMap) {
      if (entry.effectiveShare <= 0.00005) continue;
      if (!currentOwnersByTeam.has(teamId)) currentOwnersByTeam.set(teamId, []);
      currentOwnersByTeam.get(teamId)!.push({
        bidderId,
        bidderName: bidderNames.get(bidderId) ?? "Unknown",
        ownershipShare: entry.effectiveShare,
      });
    }
  }

  // Sort each team's owners by share descending
  for (const owners of currentOwnersByTeam.values()) {
    owners.sort((a, b) => b.ownershipShare - a.ownershipShare);
  }

  return { byBidder, currentOwnersByTeam, participantIds, bidderNames };
}
