/**
 * Season ownership and effective share helper.
 *
 * Computes per-bidder effective ownership for a season by starting from
 * team_bidders (primary auction owners) and then applying APPROVED trades.
 *
 * Exposed types and the single async factory `loadSeasonOwnership(seasonId)`.
 */
import { eq, and } from "drizzle-orm";
import {
  calcuttaEntriesTable,
  calcuttasTable,
  db,
  positionsTable,
  teamBiddersTable,
  tradesTable,
  biddersTable,
} from "@workspace/db";

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

/**
 * One auditable ownership component shown in Results.
 * Primary entries represent the original auction stake. Approved trades emit a
 * signed entry for both the seller and buyer so a position's origin stays clear.
 */
export interface OwnershipSegment {
  bidderId: number;
  bidderName: string;
  ownershipShare: number;
  source: "primary" | "trade";
  tradeDirection?: "acquired" | "sold";
  tradeId?: number;
  counterpartyBidderId?: number;
  counterpartyBidderName?: string;
}

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
   * primary team_bidders owners ∪ both parties to APPROVED trades.
   *
   * A seller may be a participant solely through a short position.
   */
  participantIds: Set<number>;

  /**
   * Map of bidderId → name for all participants.
   */
  bidderNames: Map<number, string>;

  /**
   * teamId → original auction stakes and approved trade legs.
   * This is display-only history; `byBidder` remains the source of effective
   * ownership and financial calculations.
   */
  ownershipSegmentsByTeam: Map<number, OwnershipSegment[]>;
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
  const legacyPrimaryRows = await db
    .select({
      teamId: teamBiddersTable.teamId,
      bidderId: teamBiddersTable.bidderId,
      ownershipShare: teamBiddersTable.ownershipShare,
    })
    .from(teamBiddersTable)
    .where(eq(teamBiddersTable.seasonId, seasonId));
  const normalizedPrimaryRows = await db
    .select({
      teamId: calcuttaEntriesTable.teamId,
      bidderId: positionsTable.bidderId,
      ownershipShare: positionsTable.ownershipShare,
    })
    .from(positionsTable)
    .innerJoin(
      calcuttaEntriesTable,
      eq(calcuttaEntriesTable.id, positionsTable.entryId),
    )
    .innerJoin(
      calcuttasTable,
      eq(calcuttasTable.id, calcuttaEntriesTable.calcuttaId),
    )
    .where(
      and(
        eq(calcuttasTable.seasonId, seasonId),
        eq(calcuttasTable.sport, "NFL"),
        eq(calcuttasTable.isCanonical, true),
        eq(positionsTable.source, "primary"),
      ),
    );
  const primaryRows =
    normalizedPrimaryRows.length > 0 ? normalizedPrimaryRows : legacyPrimaryRows;

  // 2. Approved trades
  const approvedTrades = await db
    .select({
      id: tradesTable.id,
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
  for (const trade of approvedTrades) {
    participantIds.add(trade.fromBidderId);
    participantIds.add(trade.toBidderId);
  }

  const bidderNames = new Map<number, string>();
  if (participantIds.size > 0) {
    const bidderRows = await db
      .select({ id: biddersTable.id, name: biddersTable.name })
      .from(biddersTable);
    for (const b of bidderRows) {
      if (participantIds.has(b.id)) bidderNames.set(b.id, b.name);
    }
  }

  // 5. Build source-specific ownership history for Results. This intentionally
  // does not alter effective ownership: every approved trade has both a signed
  // seller leg and a signed buyer leg.
  const ownershipSegmentsByTeam = new Map<number, OwnershipSegment[]>();
  const addOwnershipSegment = (teamId: number, segment: OwnershipSegment) => {
    if (!ownershipSegmentsByTeam.has(teamId))
      ownershipSegmentsByTeam.set(teamId, []);
    ownershipSegmentsByTeam.get(teamId)!.push(segment);
  };

  for (const row of primaryRows) {
    addOwnershipSegment(row.teamId, {
      bidderId: row.bidderId,
      bidderName: bidderNames.get(row.bidderId) ?? "Unknown",
      ownershipShare: parseFloat(row.ownershipShare),
      source: "primary",
    });
  }

  for (const trade of approvedTrades) {
    const ownershipShare = parseFloat(trade.percentage) / 100;
    const fromBidderName = bidderNames.get(trade.fromBidderId) ?? "Unknown";
    const toBidderName = bidderNames.get(trade.toBidderId) ?? "Unknown";

    addOwnershipSegment(trade.teamId, {
      bidderId: trade.fromBidderId,
      bidderName: fromBidderName,
      ownershipShare: -ownershipShare,
      source: "trade",
      tradeDirection: "sold",
      tradeId: trade.id,
      counterpartyBidderId: trade.toBidderId,
      counterpartyBidderName: toBidderName,
    });
    addOwnershipSegment(trade.teamId, {
      bidderId: trade.toBidderId,
      bidderName: toBidderName,
      ownershipShare,
      source: "trade",
      tradeDirection: "acquired",
      tradeId: trade.id,
      counterpartyBidderId: trade.fromBidderId,
      counterpartyBidderName: fromBidderName,
    });
  }

  for (const segments of ownershipSegmentsByTeam.values()) {
    segments.sort((a, b) => {
      if (a.source !== b.source) return a.source === "primary" ? -1 : 1;
      return (a.tradeId ?? 0) - (b.tradeId ?? 0);
    });
  }

  // 6. Build currentOwnersByTeam: teams → bidders with effectiveShare > 0
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

  return {
    byBidder,
    currentOwnersByTeam,
    participantIds,
    bidderNames,
    ownershipSegmentsByTeam,
  };
}
