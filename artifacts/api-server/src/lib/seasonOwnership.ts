/**
 * Season ownership and effective share helper.
 *
 * Computes per-bidder effective ownership for a season by starting from
 * team_bidders (primary auction owners) and then applying APPROVED trades.
 *
 * Exposed types and the single async factory `loadSeasonOwnership(seasonId)`.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  calcuttaEntriesTable,
  calcuttasTable,
  db,
  positionsTable,
  seasonsTable,
  teamResultsTable,
  teamsTable,
  tradesTable,
  biddersTable,
} from "@workspace/db";
import {
  NFL_PERIOD_TEMPLATE,
  hasConfiguredPayoutRulesForCalcutta,
  loadCalculatedTeamReturnsForCalcutta,
} from "./calcuttaReturns";
import {
  loadCalcuttaConsortiums,
  type MembershipView,
} from "./consortiumMemberships";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OwnerEntry {
  /** Fraction held at auction time (from primary position rows). */
  originalShare: number;
  /** Original auction cost recorded on this bidder's primary ledger positions. */
  originalCostBasis: number;
  /** Alias for the primary-position cost basis, retained for position-oriented callers. */
  primaryCostBasis: number;
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

export type ComparisonGroup = "bidder" | "consortium";

export type CalcuttaComparisonCell = {
  calcuttaId: number;
  seasonId: number;
  year: number;
  label: string;
  asOfDate: string | null;
  consortium: string | null;
  teamCount: number;
  snapshotTeamCount: number;
  signedShare: number;
  exposure: number;
  totalCost: number;
  totalRealizedReturn: number;
  totalNetReturn: number;
  totalMtm: number;
  totalNetMtm: number;
  netPctReturn: number;
  snapshotAvailable: boolean;
  throughPeriod: number | null;
  periodLabel: string | null;
};

export type CalcuttaComparisonRow = {
  id: string;
  name: string;
  bidderId: number | null;
  bidderName: string | null;
  consortium: string | null;
  calcuttas: Array<CalcuttaComparisonCell | null>;
  aggregate: {
    teamCount: number;
    snapshotTeamCount: number;
    missingSnapshotCount: number;
    snapshotAvailable: boolean;
    signedShare: number;
    exposure: number;
    totalCost: number;
    totalRealizedReturn: number;
    totalNetReturn: number;
    totalMtm: number;
    totalNetMtm: number;
    netPctReturn: number;
  };
};

export type CrossCalcuttaRollup = {
  groupBy: ComparisonGroup;
  calcuttas: Array<{
    id: number;
    seasonId: number;
    year: number;
    label: string;
    asOfDate: string | null;
  }>;
  rows: CalcuttaComparisonRow[];
};

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
      originalCostBasis: 0,
      primaryCostBasis: 0,
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
 *  1. Fetch every signed position in the selected Calcutta ledger.
 *  2. Derive original ownership from primary rows and current ownership from
 *     the signed sum of all rows (including trade legs).
 *  3. Derive trade cash and display history from those same ledger rows.
 *  4. Fetch bidder names for all participants.
 *  5. Build currentOwnersByTeam (effectiveShare > 0 per team).
 */
export async function loadSeasonOwnership(
  seasonId: number,
  calcuttaId?: number,
): Promise<SeasonOwnership> {
  // Positions are the ownership ledger.  The season-only form is retained only
  // as a canonical-NFL selection compatibility shim, never as a legacy read.
  const positionRows = await db
    .select({
      teamId: calcuttaEntriesTable.teamId,
      bidderId: positionsTable.bidderId,
      ownershipShare: positionsTable.ownershipShare,
      costBasis: positionsTable.costBasis,
      source: positionsTable.source,
      tradeId: positionsTable.tradeId,
      tradeFromBidderId: tradesTable.fromBidderId,
      tradeToBidderId: tradesTable.toBidderId,
    })
    .from(positionsTable)
    .innerJoin(
      calcuttaEntriesTable,
      eq(calcuttaEntriesTable.id, positionsTable.entryId),
    )
    .leftJoin(tradesTable, eq(tradesTable.id, positionsTable.tradeId))
    .innerJoin(
      calcuttasTable,
      eq(calcuttasTable.id, calcuttaEntriesTable.calcuttaId),
    )
    .where(
      and(
        eq(calcuttasTable.seasonId, seasonId),
        eq(calcuttasTable.sport, "NFL"),
        calcuttaId == null
          ? eq(calcuttasTable.isCanonical, true)
          : eq(calcuttasTable.id, calcuttaId),
      ),
    );
  const primaryRows = positionRows.filter((row) => row.source === "primary");

  // 3. Build byBidder map
  const byBidder: Map<number, TeamOwnerMap> = new Map();

  // All signed rows determine effective ownership. Primary rows alone retain
  // the immutable auction split; trade cash comes from signed cost basis.
  for (const row of positionRows) {
    const share = parseFloat(row.ownershipShare);
    const entry = getOrCreateEntry(byBidder, row.bidderId, row.teamId);
    entry.effectiveShare += share;
    if (row.source === "primary") {
      entry.originalShare += share;
      const cost = Number(row.costBasis);
      entry.originalCostBasis += cost;
      entry.primaryCostBasis += cost;
    }
    if (row.source === "trade") {
      const cost = Number(row.costBasis);
      if (cost > 0) entry.tradePaid += cost;
      if (cost < 0) entry.tradeReceived -= cost;
    }
  }

  // 4. Collect participant IDs and fetch names
  const participantIds = new Set<number>();
  for (const row of positionRows) participantIds.add(row.bidderId);

  const bidderNames = new Map<number, string>();
  if (participantIds.size > 0) {
    const bidderRows = await db
      .select({ id: biddersTable.id, name: biddersTable.name })
      .from(biddersTable);
    for (const b of bidderRows) {
      if (participantIds.has(b.id)) bidderNames.set(b.id, b.name);
    }
  }

  // 5. Build source-specific ownership history directly from ledger rows.
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

  for (const row of positionRows.filter((position) => position.source === "trade")) {
    const sold = Number(row.ownershipShare) < 0;
    const counterpartyBidderId = sold ? row.tradeToBidderId : row.tradeFromBidderId;
    addOwnershipSegment(row.teamId, {
      bidderId: row.bidderId,
      bidderName: bidderNames.get(row.bidderId) ?? "Unknown",
      ownershipShare: Number(row.ownershipShare),
      source: "trade",
      tradeDirection: sold ? "sold" : "acquired",
      tradeId: row.tradeId ?? undefined,
      counterpartyBidderId: counterpartyBidderId ?? undefined,
      counterpartyBidderName: counterpartyBidderId == null
        ? undefined
        : bidderNames.get(counterpartyBidderId) ?? "Unknown",
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

const roundMoney = (value: number) => Math.round(value * 100) / 100;
const roundShare = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/**
 * Aggregates normalized, signed position entries across selected canonical
 * Calcuttas. Each cell keeps its own payout rules, period snapshots, and dated
 * consortium roster, so changing a bidder's present-day group never rewrites
 * a historical pool comparison.
 */
export async function loadCrossCalcuttaRollup(args: {
  years: number[];
  period?: number;
  basis?: "realized" | "mtm";
  membershipView?: MembershipView;
  groupBy?: ComparisonGroup;
}): Promise<CrossCalcuttaRollup> {
  const years = [...new Set(args.years)].sort((a, b) => a - b);
  const membershipView = args.membershipView ?? "historical";
  const groupBy = args.groupBy ?? "bidder";
  const calcuttas = await db
    .select({
      id: calcuttasTable.id,
      seasonId: calcuttasTable.seasonId,
      year: calcuttasTable.year,
      label: seasonsTable.label,
      asOfDate: calcuttasTable.asOfDate,
    })
    .from(calcuttasTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .where(
      and(
        inArray(calcuttasTable.year, years),
        eq(calcuttasTable.sport, "NFL"),
        eq(calcuttasTable.isCanonical, true),
      ),
    );
  calcuttas.sort((a, b) => a.year - b.year);

  const empty: CrossCalcuttaRollup = { groupBy, calcuttas, rows: [] };
  if (!calcuttas.length) return empty;

  const [positionRows, memberships, calculatedByCalcutta, payoutRulesByCalcutta] =
    await Promise.all([
      db
        .select({
          calcuttaId: calcuttasTable.id,
          seasonId: calcuttasTable.seasonId,
          teamId: calcuttaEntriesTable.teamId,
          teamName: teamsTable.name,
          bidderId: positionsTable.bidderId,
          bidderName: biddersTable.name,
          ownershipShare: positionsTable.ownershipShare,
          costBasis: positionsTable.costBasis,
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
        .innerJoin(teamsTable, eq(teamsTable.id, calcuttaEntriesTable.teamId))
        .innerJoin(biddersTable, eq(biddersTable.id, positionsTable.bidderId))
        .where(inArray(calcuttasTable.id, calcuttas.map((calcutta) => calcutta.id))),
      Promise.all(
        calcuttas.map(async (calcutta) => [
          calcutta.id,
          await loadCalcuttaConsortiums(calcutta.id, membershipView),
        ] as const),
      ),
      Promise.all(
        calcuttas.map(async (calcutta) => [
          calcutta.id,
          await loadCalculatedTeamReturnsForCalcutta(calcutta.id, args.period),
        ] as const),
      ),
      Promise.all(
        calcuttas.map(async (calcutta) => [
          calcutta.id,
          await hasConfiguredPayoutRulesForCalcutta(calcutta.id),
        ] as const),
      ),
    ]);

  const consortiumByCalcutta = new Map(memberships);
  const calculatedMapByCalcutta = new Map(calculatedByCalcutta);
  const payoutRulesConfiguredByCalcutta = new Map(payoutRulesByCalcutta);
  const selectedBasis = args.basis ?? "realized";
  const coverageTargetByCalcutta = new Map(
    calcuttas.map((calcutta) => {
      if (args.period != null) return [calcutta.id, args.period] as const;
      const latestSequences = [...(calculatedMapByCalcutta.get(calcutta.id) ?? new Map()).values()]
        .map((returns) => returns[selectedBasis]?.latest.sequence)
        .filter((sequence): sequence is number => sequence != null);
      return [
        calcutta.id,
        latestSequences.length ? Math.max(...latestSequences) : null,
      ] as const;
    }),
  );

  type Position = {
    calcuttaId: number;
    seasonId: number;
    teamId: number;
    teamName: string;
    bidderId: number;
    bidderName: string;
    signedShare: number;
    costBasis: number;
  };
  const positionsByTeamBidder = new Map<string, Position>();
  for (const row of positionRows) {
    const key = `${row.calcuttaId}:${row.teamId}:${row.bidderId}`;
    const position = positionsByTeamBidder.get(key) ?? {
      calcuttaId: row.calcuttaId,
      seasonId: row.seasonId,
      teamId: row.teamId,
      teamName: row.teamName,
      bidderId: row.bidderId,
      bidderName: row.bidderName,
      signedShare: 0,
      costBasis: 0,
    };
    position.signedShare += Number(row.ownershipShare);
    position.costBasis += Number(row.costBasis);
    positionsByTeamBidder.set(key, position);
  }

  type MutableCell = CalcuttaComparisonCell;
  type MutableRow = Omit<CalcuttaComparisonRow, "calcuttas" | "aggregate"> & {
    cells: Map<number, MutableCell>;
  };
  const rows = new Map<string, MutableRow>();
  const addPosition = (position: Position) => {
    if (
      Math.abs(position.signedShare) < 0.00005 &&
      Math.abs(position.costBasis) < 0.005
    ) {
      return;
    }
    const consortium =
      consortiumByCalcutta.get(position.calcuttaId)?.get(position.bidderId) ?? null;
    const rowIdentity =
      groupBy === "bidder"
        ? {
            id: `bidder:${position.bidderId}`,
            name: position.bidderName,
            bidderId: position.bidderId,
            bidderName: position.bidderName,
            consortium: null,
          }
        : {
            id: `consortium:${consortium ?? "unassigned"}`,
            name: consortium ?? "Unassigned",
            bidderId: null,
            bidderName: null,
            consortium,
          };
    const row = rows.get(rowIdentity.id) ?? { ...rowIdentity, cells: new Map() };
    rows.set(rowIdentity.id, row);

    const calcutta = calcuttas.find((item) => item.id === position.calcuttaId)!;
    const calculated = calculatedMapByCalcutta.get(position.calcuttaId)?.get(position.teamId);
    const payoutRulesConfigured =
      payoutRulesConfiguredByCalcutta.get(position.calcuttaId) ?? false;
    const realized = calculated?.realized?.grossReturn;
    const mtm = calculated?.mtm?.grossReturn;
    const selected = calculated?.[selectedBasis];
    const coverageTarget = coverageTargetByCalcutta.get(position.calcuttaId) ?? null;
    const snapshotAvailable =
      payoutRulesConfigured &&
      coverageTarget != null &&
      selected?.latest.sequence === coverageTarget;
    // Never blend stale calculated values into a selected-period comparison.
    // Cost and exposure remain visible, while the cell/aggregate coverage flags
    // make the missing return explicit to clients.
    const realizedValue =
      payoutRulesConfigured && !snapshotAvailable
        ? 0
        : realized ?? 0;
    const mtmValue =
      payoutRulesConfigured && !snapshotAvailable
        ? 0
        : mtm ?? 0;
    const coveragePeriod = NFL_PERIOD_TEMPLATE.find(
      (period) => period.sequence === coverageTarget,
    );

    const cell = row.cells.get(position.calcuttaId) ?? {
      calcuttaId: calcutta.id,
      seasonId: calcutta.seasonId,
      year: calcutta.year,
      label: calcutta.label,
      asOfDate: calcutta.asOfDate,
      consortium,
      teamCount: 0,
      snapshotTeamCount: 0,
      signedShare: 0,
      exposure: 0,
      totalCost: 0,
      totalRealizedReturn: 0,
      totalNetReturn: 0,
      totalMtm: 0,
      totalNetMtm: 0,
      netPctReturn: 0,
      snapshotAvailable: true,
      throughPeriod: coverageTarget,
      periodLabel: coveragePeriod?.label ?? null,
    };
    cell.teamCount += 1;
    if (snapshotAvailable) cell.snapshotTeamCount += 1;
    cell.signedShare += position.signedShare;
    cell.exposure += Math.abs(position.costBasis);
    cell.totalCost += position.costBasis;
    cell.totalRealizedReturn += realizedValue * position.signedShare;
    cell.totalMtm += mtmValue * position.signedShare;
    cell.totalNetReturn = cell.totalRealizedReturn - cell.totalCost;
    cell.totalNetMtm = cell.totalMtm - cell.totalCost;
    cell.snapshotAvailable = cell.snapshotAvailable && snapshotAvailable;
    row.cells.set(position.calcuttaId, cell);
  };
  for (const position of positionsByTeamBidder.values()) addPosition(position);

  const rowsResult = [...rows.values()]
    .map((row) => {
      const cells = calcuttas.map((calcutta) => {
        const cell = row.cells.get(calcutta.id);
        if (!cell) return null;
        const totalCost = roundMoney(cell.totalCost);
        const totalNetReturn = roundMoney(cell.totalNetReturn);
        return {
          ...cell,
          teamCount: Math.round(cell.teamCount),
          signedShare: roundShare(cell.signedShare),
          exposure: roundMoney(cell.exposure),
          totalCost,
          totalRealizedReturn: roundMoney(cell.totalRealizedReturn),
          totalNetReturn,
          totalMtm: roundMoney(cell.totalMtm),
          totalNetMtm: roundMoney(cell.totalNetMtm),
          netPctReturn:
            totalCost > 0 ? Math.round((totalNetReturn / totalCost) * 10_000) / 100 : 0,
        };
      });
      const present = cells.filter((cell): cell is CalcuttaComparisonCell => Boolean(cell));
      const aggregateCost = present.reduce((total, cell) => total + cell.totalCost, 0);
      const aggregateReturn = present.reduce(
        (total, cell) => total + cell.totalRealizedReturn,
        0,
      );
      const aggregateNet = aggregateReturn - aggregateCost;
      const teamCount = present.reduce((total, cell) => total + cell.teamCount, 0);
      const snapshotTeamCount = present.reduce(
        (total, cell) => total + cell.snapshotTeamCount,
        0,
      );
      return {
        id: row.id,
        name: row.name,
        bidderId: row.bidderId,
        bidderName: row.bidderName,
        consortium: row.consortium,
        calcuttas: cells,
        aggregate: {
          teamCount,
          snapshotTeamCount,
          missingSnapshotCount: teamCount - snapshotTeamCount,
          snapshotAvailable: teamCount === snapshotTeamCount,
          signedShare: roundShare(present.reduce((total, cell) => total + cell.signedShare, 0)),
          exposure: roundMoney(present.reduce((total, cell) => total + cell.exposure, 0)),
          totalCost: roundMoney(aggregateCost),
          totalRealizedReturn: roundMoney(aggregateReturn),
          totalNetReturn: roundMoney(aggregateNet),
          totalMtm: roundMoney(present.reduce((total, cell) => total + cell.totalMtm, 0)),
          totalNetMtm: roundMoney(present.reduce((total, cell) => total + cell.totalNetMtm, 0)),
          netPctReturn:
            aggregateCost > 0
              ? Math.round((aggregateNet / aggregateCost) * 10_000) / 100
              : 0,
        },
      };
    })
    .sort((a, b) => b.aggregate.totalNetMtm - a.aggregate.totalNetMtm);

  return { groupBy, calcuttas, rows: rowsResult };
}
