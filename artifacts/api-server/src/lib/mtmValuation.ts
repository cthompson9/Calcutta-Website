import { and, eq, inArray, desc, gt } from "drizzle-orm";
import {
  db,
  eventsTable,
  mtmGameConditionalTable,
  mtmSnapshotTable,
  mtmEntryValuationTable,
  mtmMarketQuoteTable,
  calcuttaEntriesTable,
  teamsTable,
} from "@workspace/db";
import { loadSeasonOwnership } from "./seasonOwnership";
import { resolveCalcuttaId } from "./calcuttaContext";
import { resolveSeasonIdForSport } from "./calcuttaContext";
import {
  calculateMidpointDrift,
  computeValuationInvariants,
  deriveGameEvSwings,
  deriveOwnerGameEvSwings,
} from "./mtmValuationHelpers";
import { resolveCurrentMtm } from "./currentMtm";

// The durable current-version resolver is shared by all displayed valuation
// consumers. Raw snapshots remain evidence-only read paths.
export {
  resolveCurrentMtm,
  buildCurrentMtmResolution,
  validateCurrentMtmVersion,
  assertValidCurrentMtmVersion,
  validateAndPromoteCurrentMtm,
  validateAndPromoteCurrentMtmVersion,
  mapSourceActualsForPool,
  mapSourceActuals,
  normalizeSourceActuals,
  reconcileNflCurrentMtm,
  planNflMtmReconciliation,
} from "./currentMtm";

export type MtmMarkType = "authoritative" | "latest" | "canonical" | "provisional";

export async function assessMarketDrift(snapshotId: number, threshold = 0.05) {
  const selected = (await db.select({ snapshotId: mtmSnapshotTable.id, poolId: mtmSnapshotTable.poolId, inputHash: mtmSnapshotTable.inputHash, createdAt: mtmSnapshotTable.createdAt })
    .from(mtmSnapshotTable).where(eq(mtmSnapshotTable.id, snapshotId)).limit(1))[0];
  if (!selected) return { available: false, reason: "Snapshot not found.", threshold, comparedTickerCount: 0, maxDrift: null, weightedDrift: null, recommendsRerun: false };
  const laterSnapshots = await db.select({ id: mtmSnapshotTable.id, createdAt: mtmSnapshotTable.createdAt, inputHash: mtmSnapshotTable.inputHash })
    .from(mtmSnapshotTable).where(and(
      eq(mtmSnapshotTable.poolId, selected.poolId),
      eq(mtmSnapshotTable.status, "ok"),
      gt(mtmSnapshotTable.createdAt, selected.createdAt),
    ));
  const later = laterSnapshots.filter((row) => row.inputHash !== selected.inputHash).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!later) return { available: false, reason: "No later distinct successful quote capture is available.", threshold, comparedTickerCount: 0, maxDrift: null, weightedDrift: null, recommendsRerun: false };
  const [before, after] = await Promise.all([
    db.select().from(mtmMarketQuoteTable).where(eq(mtmMarketQuoteTable.snapshotId, snapshotId)),
    db.select().from(mtmMarketQuoteTable).where(eq(mtmMarketQuoteTable.snapshotId, later.id)),
  ]);
  const result = calculateMidpointDrift(before.map((q) => ({ ticker: q.marketTicker, bid: q.yesBid == null ? null : Number(q.yesBid), ask: q.yesAsk == null ? null : Number(q.yesAsk), volume: q.volume })), after.map((q) => ({ ticker: q.marketTicker, bid: q.yesBid == null ? null : Number(q.yesBid), ask: q.yesAsk == null ? null : Number(q.yesAsk), volume: q.volume })), threshold);
  return { ...result, laterSnapshotId: later.id, reason: result.available ? null : "No comparable quote intersection is available." };
}

/**
 * Normalized valuation read model. This is intentionally shared by HTTP and
 * MCP callers; it never starts a simulation or mutates a mark.
 */
export async function getNormalizedMtmValuation(args: {
  season: number;
  calcuttaId?: number;
  markType?: MtmMarkType;
  owner?: string;
}) {
  const seasonId = await resolveSeasonIdForSport(db, { year: args.season, sport: "NFL" });
  const poolId = seasonId == null
    ? null
    : await resolveCalcuttaId(db, { seasonId, sport: "NFL", calcuttaId: args.calcuttaId });
  const resolution = poolId == null
    ? {
        available: false,
        versionId: null,
        sourceSnapshotId: null,
        status: null,
        actualsStateHash: null,
        markType: null,
        provisionalEventId: null,
        provisionalOutcome: null,
        actualsAsOf: null,
        mtmAsOf: null,
        teams: [],
        owners: [],
        incorporatedGames: [],
        pendingGames: [],
        staleReason: "No NFL Calcutta is available for the requested season.",
      }
    : await resolveCurrentMtm(poolId);
  const unavailableMark = {
    versionId: resolution.versionId,
    sourceSnapshotId: resolution.sourceSnapshotId,
    status: resolution.status,
    type: resolution.markType ?? args.markType ?? "authoritative",
    approximate: resolution.markType === "provisional",
    quality: "insufficient" as const,
    stale: true,
    staleReasons: [resolution.staleReason ?? "No current coherent MTM version is available."],
    reason: resolution.staleReason ?? "No current coherent MTM version is available.",
    actualsStateHash: resolution.actualsStateHash,
    provisionalEventId: resolution.provisionalEventId,
    provisionalOutcome: resolution.provisionalOutcome,
    actualsAsOf: resolution.actualsAsOf,
    mtmAsOf: resolution.mtmAsOf,
  };
  if (!resolution.available || resolution.sourceSnapshotId == null) {
    return {
      available: false,
      mark: unavailableMark,
      versionId: resolution.versionId,
      sourceSnapshotId: resolution.sourceSnapshotId,
      markType: resolution.markType,
      provisionalEventId: resolution.provisionalEventId,
      provisionalOutcome: resolution.provisionalOutcome,
      actualsAsOf: resolution.actualsAsOf,
      mtmAsOf: resolution.mtmAsOf,
      incorporatedGames: resolution.incorporatedGames,
      pendingGames: resolution.pendingGames,
      staleReason: resolution.staleReason,
      teams: [], owners: [], conditionalPayouts: {}, gameEvSwings: [],
      diagnostics: null,
      invariants: {
        teamGrossPoolConservation: { status: "unavailable" },
        entryNetVersusAuctionProceeds: { status: "unavailable" },
        ownerSecondaryTradeCash: { status: "unavailable" },
      },
    };
  }
  const snapshot = (await db.select().from(mtmSnapshotTable)
    .where(eq(mtmSnapshotTable.id, resolution.sourceSnapshotId)).limit(1))[0];
  if (!snapshot) {
    const mark = { ...unavailableMark, reason: "Current MTM source snapshot is missing.",
      staleReasons: ["Current MTM source snapshot is missing."] };
    return {
      available: false, mark, teams: [], owners: [], conditionalPayouts: {}, gameEvSwings: [],
      versionId: resolution.versionId,
      sourceSnapshotId: resolution.sourceSnapshotId,
      markType: resolution.markType,
      provisionalEventId: resolution.provisionalEventId,
      provisionalOutcome: resolution.provisionalOutcome,
      actualsAsOf: resolution.actualsAsOf,
      mtmAsOf: resolution.mtmAsOf,
      incorporatedGames: resolution.incorporatedGames,
      pendingGames: resolution.pendingGames,
      staleReason: resolution.staleReason,
      diagnostics: null,
      invariants: {
        teamGrossPoolConservation: { status: "unavailable" },
        entryNetVersusAuctionProceeds: { status: "unavailable" },
        ownerSecondaryTradeCash: { status: "unavailable" },
      },
    };
  }
  const selectedSnapshotId = snapshot.id;
  const currentStaleReason = resolution.staleReason ??
    (resolution.markType === "pending_recalculation"
      ? "Current MTM version is pending recalculation."
      : null);
  const entries = await db.select({
    entryId: calcuttaEntriesTable.id, teamId: calcuttaEntriesTable.teamId, teamName: teamsTable.name,
  }).from(calcuttaEntriesTable).innerJoin(teamsTable, eq(teamsTable.id, calcuttaEntriesTable.teamId))
    .where(eq(calcuttaEntriesTable.calcuttaId, poolId!));
  const ownership = await loadSeasonOwnership(seasonId!, poolId!);
  const entryById = new Map(entries.map((entry) => [entry.entryId, entry]));
  // The durable resolver is the sole authority for current team and owner
  // values. In particular, do not rebuild provisional values from live events.
  const teams = resolution.teams.map((team: Record<string, any>) => ({
    entryId: team.entryId,
    teamId: team.teamId,
    teamName: team.teamName,
    grossExpectedPayout: Number(team.currentMtm ?? team.grossExpectedPayout),
    auctionPrice: team.auctionPrice == null ? null : Number(team.auctionPrice),
    net: team.net == null ? null : Number(team.net),
  }));
  const owners = resolution.owners
    .filter((owner: Record<string, any>) => !args.owner || String(owner.bidderName).toLocaleLowerCase().includes(args.owner.toLocaleLowerCase()));
  const conditionals = await db.select().from(mtmGameConditionalTable)
    .where(eq(mtmGameConditionalTable.snapshotId, snapshot.id));
  const conditionalEventIds = [...new Set(conditionals.map((row) => row.eventId))];
  const conditionalEvents = conditionalEventIds.length
    ? await db.select({
        id: eventsTable.id,
        week: eventsTable.week,
        home: eventsTable.homeTeamId,
        away: eventsTable.awayTeamId,
        status: eventsTable.status,
        homeScore: eventsTable.homeScore,
        awayScore: eventsTable.awayScore,
        updatedAt: eventsTable.updatedAt,
      })
      .from(eventsTable).where(inArray(eventsTable.id, conditionalEventIds))
    : [];
  const eventById = new Map(conditionalEvents.map((event) => [event.id, event]));
  const conditionalPayouts: Record<string, any> = {};
  for (const row of conditionals) {
    const event = eventById.get(row.eventId);
    const key = String(row.eventId);
    const item = conditionalPayouts[key] ?? { event_id: row.eventId, home: event?.home ?? null, away: event?.away ?? null, week: event?.week ?? null, outcomes: {} };
    const outcome = item.outcomes[row.outcome] ?? { teams: [], owners: [] };
    outcome.teams.push({
      entry_id: row.entryId,
      team_id: entryById.get(row.entryId)?.teamId ?? null,
      gross_baseline: row.grossBaseline == null ? null : Number(row.grossBaseline),
      gross_expected_payout: row.grossConditional == null ? null : Number(row.grossConditional),
      gross_delta: row.grossDelta == null ? null : Number(row.grossDelta),
      probability: row.probability == null ? null : Number(row.probability),
      sample_count: row.sampleCount,
      sample_share: row.sampleShare == null ? null : Number(row.sampleShare),
      effective_sample_size: row.effectiveSampleSize == null ? null : Number(row.effectiveSampleSize),
      standard_error: row.standardError == null ? null : Number(row.standardError),
      quality_status: row.qualityStatus,
      reconciliation_residual: row.reconciliationResidual == null ? null : Number(row.reconciliationResidual),
    });
    item.outcomes[row.outcome] = outcome;
    conditionalPayouts[key] = item;
  }
  for (const event of Object.values(conditionalPayouts)) {
    for (const outcome of Object.values(event.outcomes) as any[]) {
      const grossByTeam = new Map(outcome.teams.map((team: any) => [team.team_id, team.gross_expected_payout]));
      outcome.owners = [...ownership.byBidder.entries()].map(([bidderId, positions]) => ({
        bidderId,
        bidderName: ownership.bidderNames.get(bidderId) ?? "Unknown",
        grossExpectedPayout: [...positions.entries()].reduce((sum, [teamId, position]) =>
          sum + Number(grossByTeam.get(teamId) ?? 0) * position.effectiveShare, 0),
      }));
    }
  }
  const gameEvSwings = deriveOwnerGameEvSwings(
    deriveGameEvSwings(
      Object.values(conditionalPayouts),
      new Map(entries.map((entry) => [entry.teamId, entry.teamName])),
    ),
    [...ownership.byBidder.entries()].map(([bidderId, positions]) => ({
      bidderId,
      bidderName: ownership.bidderNames.get(bidderId) ?? "Unknown",
      positions,
    })),
  );
  const expectedPot = Number((snapshot.stateJson as Record<string, unknown> | null)?.pot ?? 0);
  const secondaryTradePaid = [...ownership.byBidder.values()].reduce((sum, positions) =>
    sum + [...positions.values()].reduce((inner, position) => inner + position.tradePaid, 0), 0);
  const secondaryTradeReceived = [...ownership.byBidder.values()].reduce((sum, positions) =>
    sum + [...positions.values()].reduce((inner, position) => inner + position.tradeReceived, 0), 0);
  const invariants = computeValuationInvariants({
    expectedPot,
    teams: teams.map((team: { grossExpectedPayout: number; auctionPrice: number | null }) => ({ gross: team.grossExpectedPayout, auctionPrice: team.auctionPrice ?? 0 })),
    secondaryTradePaid,
    secondaryTradeReceived,
  });
  return {
    available: true,
    mark: {
       snapshotId: snapshot.id,
       versionId: resolution.versionId,
       sourceSnapshotId: resolution.sourceSnapshotId,
       status: resolution.status,
       type: resolution.markType ?? "official",
       approximate: resolution.markType === "provisional",
      quality: snapshot.calibrationStatus ?? "insufficient",
       stale: resolution.markType === "pending_recalculation" || Boolean(currentStaleReason),
       staleReasons: currentStaleReason ? [currentStaleReason] : [],
       asOf: resolution.mtmAsOf,
       actualsAsOf: resolution.actualsAsOf,
       mtmAsOf: resolution.mtmAsOf,
       actualsStateHash: resolution.actualsStateHash,
       provisionalEventId: resolution.provisionalEventId,
       provisionalOutcome: resolution.provisionalOutcome,
      inputHash: snapshot.inputHash,
      model: { name: snapshot.methodVersion, seed: snapshot.randomSeed },
      pathCount: snapshot.pathCount,
       selectionReason: "promoted coherent current MTM version",
       provisionalSuppressionReason: null,
    },
     versionId: resolution.versionId,
     sourceSnapshotId: resolution.sourceSnapshotId,
     markType: resolution.markType,
     provisionalEventId: resolution.provisionalEventId,
     provisionalOutcome: resolution.provisionalOutcome,
     actualsAsOf: resolution.actualsAsOf,
     mtmAsOf: resolution.mtmAsOf,
     incorporatedGames: resolution.incorporatedGames,
     pendingGames: resolution.pendingGames,
      staleReason: currentStaleReason,
    teams, owners, conditionalPayouts, gameEvSwings,
    diagnostics: {
      market_calibration: snapshot.diagnostics?.market_calibration ?? { status: snapshot.calibrationStatus ?? "insufficient" },
       market_drift: await assessMarketDrift(snapshot.id),
    },
    invariants,
  };
}