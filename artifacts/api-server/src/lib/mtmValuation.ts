import { and, eq, inArray, desc, gt } from "drizzle-orm";
import {
  db,
  eventsTable,
  mtmGameConditionalTable,
  mtmSnapshotTable,
  mtmEntryValuationTable,
  mtmMarketQuoteTable,
  mtmCanonicalPeriodSelectionTable,
  calcuttaEntriesTable,
  teamsTable,
  seasonsTable,
  calcuttasTable,
} from "@workspace/db";
import { loadSeasonOwnership } from "./seasonOwnership";
import { getMtmPipelineStatus } from "./mtmPipeline";
import {
  calculateMidpointDrift,
  calculateSignedOwnerValue,
  chooseProvisionalOutcome,
  computeValuationInvariants,
  deriveGameEvSwings,
  deriveOwnerGameEvSwings,
} from "./mtmValuationHelpers";

// The durable current-version resolver is shared by internal server callers.
// Legacy consumers remain on this module's existing normalized read model
// until their migration is explicitly scheduled.
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
  const status = await getMtmPipelineStatus(args.season, args.calcuttaId);
  if (!status?.currentSnapshotId) {
    return {
      available: false,
      mark: {
        type: args.markType ?? "authoritative",
        approximate: false,
        quality: "insufficient",
        stale: true,
        staleReasons: status?.staleReasons?.length
          ? status.staleReasons
          : ["No successful MTM snapshot is available."],
        reason: "No successful MTM snapshot is available.",
      },
      teams: [], owners: [], conditionalPayouts: {}, gameEvSwings: [],
      diagnostics: status?.diagnostics ?? null,
      invariants: {
        teamGrossPoolConservation: { status: "unavailable" },
        entryNetVersusAuctionProceeds: { status: "unavailable" },
        ownerSecondaryTradeCash: { status: "unavailable" },
      },
    };
  }
  const wantsCanonical = args.markType === "canonical" || args.markType === "authoritative" || args.markType === "provisional";
  let selectedType: MtmMarkType = status.currentSelectionType ?? "latest";
  const selectedSnapshotId = status.currentSnapshotId;
  const snapshot = selectedSnapshotId == null ? undefined
    : (await db.select().from(mtmSnapshotTable).where(eq(mtmSnapshotTable.id, selectedSnapshotId)).limit(1))[0];
  if (!snapshot) throw new Error("The selected MTM snapshot disappeared.");
  const entries = await db.select({
    entryId: calcuttaEntriesTable.id, teamId: calcuttaEntriesTable.teamId, teamName: teamsTable.name,
  }).from(calcuttaEntriesTable).innerJoin(teamsTable, eq(teamsTable.id, calcuttaEntriesTable.teamId))
    .where(eq(calcuttaEntriesTable.calcuttaId, status.poolId));
  const entryIds = entries.map((entry) => entry.entryId);
  const rows = await db.select().from(mtmEntryValuationTable)
    .where(and(eq(mtmEntryValuationTable.snapshotId, snapshot.id), inArray(mtmEntryValuationTable.entryId, entryIds)));
  const seasonRow = (await db.select({ seasonId: seasonsTable.id }).from(seasonsTable)
    .innerJoin(calcuttasTable, eq(calcuttasTable.seasonId, seasonsTable.id))
    .where(eq(calcuttasTable.id, status.poolId)).limit(1))[0];
  if (!seasonRow) throw new Error("The selected MTM Calcutta has no season.");
  const ownership = await loadSeasonOwnership(seasonRow.seasonId, status.poolId);
  const entryById = new Map(entries.map((entry) => [entry.entryId, entry]));
  let teams = rows.map((row) => {
    const entry = entryById.get(row.entryId);
    const gross = Number(row.expectedPayout ?? 0);
    return {
      entryId: row.entryId, teamId: entry?.teamId ?? null, teamName: entry?.teamName ?? null,
      grossExpectedPayout: gross, auctionPrice: row.auctionPrice == null ? null : Number(row.auctionPrice),
      net: row.auctionPrice == null ? null : gross - Number(row.auctionPrice),
    };
  });
  const buildOwners = () => [...ownership.byBidder.entries()].map(([bidderId, positions]) => {
    const holdings = [...positions.entries()].map(([teamId, position]) => {
      const team = teams.find((item) => item.teamId === teamId);
       const value = calculateSignedOwnerValue(
         team?.grossExpectedPayout ?? 0,
         position.effectiveShare,
         position.originalCostBasis,
         position.tradePaid,
         position.tradeReceived,
       );
       return { teamId, signedShare: position.effectiveShare, grossExpectedPayout: value.gross, signedCostBasis: value.signedCostBasis, net: value.net };
    });
    return { bidderId, bidderName: ownership.bidderNames.get(bidderId) ?? "Unknown", holdings,
      grossExpectedPayout: holdings.reduce((n, h) => n + h.grossExpectedPayout, 0),
      signedCostBasis: holdings.reduce((n, h) => n + h.signedCostBasis, 0),
      net: holdings.reduce((n, h) => n + h.net, 0) };
   }).filter((owner) => !args.owner || owner.bidderName.toLocaleLowerCase().includes(args.owner.toLocaleLowerCase()));
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
  let provisionalSuppressionReason: string | null = null;
  if (args.markType === "provisional") {
    const quality = new Map<string, Array<{ qualityStatus: string; grossConditional: number | null }>>();
    for (const row of conditionals) {
      const key = `${row.eventId}:${row.outcome}`;
      const bucket = quality.get(key) ?? [];
      bucket.push({
        qualityStatus: row.qualityStatus,
        grossConditional: row.grossConditional == null ? null : Number(row.grossConditional),
      });
      quality.set(key, bucket);
    }
    const choice = chooseProvisionalOutcome({
      actualAnchor: snapshot.actualAnchor,
      candidates: conditionalEvents.map((event) => ({
        eventId: event.id,
        final: ["final", "completed", "post"].includes(event.status.toLowerCase()),
        completeIdentity: event.home != null && event.away != null,
        completeScore: event.homeScore != null && event.awayScore != null,
        observedAt: event.updatedAt,
        actualAnchor: snapshot.actualAnchor,
        homeScore: event.homeScore,
        awayScore: event.awayScore,
      })),
      conditionalQuality: quality,
    });
    if (choice.selected) {
      const provisionalRows = conditionals.filter((row) =>
        row.eventId === choice.eventId && row.outcome === choice.outcome
      );
      const grossByEntry = new Map(provisionalRows.map((row) => [
        row.entryId,
        row.grossConditional == null ? null : Number(row.grossConditional),
      ]));
      teams = teams.map((team) => {
        const gross = grossByEntry.get(team.entryId);
        if (gross == null) return team;
        return {
          ...team,
          grossExpectedPayout: gross,
          net: team.auctionPrice == null ? null : gross - team.auctionPrice,
        };
      });
      selectedType = "provisional";
      provisionalSuppressionReason = null;
    } else {
      provisionalSuppressionReason = `${choice.reason}; authoritative values returned.`;
    }
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
  const owners = buildOwners();
  const expectedPot = Number((snapshot.stateJson as Record<string, unknown> | null)?.pot ?? 0);
  const secondaryTradePaid = [...ownership.byBidder.values()].reduce((sum, positions) =>
    sum + [...positions.values()].reduce((inner, position) => inner + position.tradePaid, 0), 0);
  const secondaryTradeReceived = [...ownership.byBidder.values()].reduce((sum, positions) =>
    sum + [...positions.values()].reduce((inner, position) => inner + position.tradeReceived, 0), 0);
  const invariants = computeValuationInvariants({
    expectedPot,
    teams: teams.map((team) => ({ gross: team.grossExpectedPayout, auctionPrice: team.auctionPrice ?? 0 })),
    secondaryTradePaid,
    secondaryTradeReceived,
  });
  return {
    available: true,
    mark: {
      snapshotId: snapshot.id,
      type: selectedType,
      approximate: selectedType === "provisional",
      quality: snapshot.calibrationStatus ?? "insufficient",
      stale: status.stale,
      staleReasons: status.staleReasons,
      asOf: snapshot.asOf.toISOString(),
      inputHash: snapshot.inputHash,
      model: { name: snapshot.methodVersion, seed: snapshot.randomSeed },
      pathCount: snapshot.pathCount,
      selectionReason: selectedType === "canonical"
        ? "latest append-only canonical period selection"
        : selectedType === "provisional"
          ? "single final-conditioned estimate; final margin is not incorporated"
          : wantsCanonical
            ? "no canonical selection available; latest successful snapshot used"
            : "latest successful snapshot requested",
      provisionalSuppressionReason,
    },
    teams, owners, conditionalPayouts, gameEvSwings,
    diagnostics: {
      market_calibration: snapshot.diagnostics?.market_calibration ?? { status: snapshot.calibrationStatus ?? "insufficient" },
      market_drift: await assessMarketDrift(snapshot.id),
    },
    invariants,
  };
}