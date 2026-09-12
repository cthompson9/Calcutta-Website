import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  calcuttaEntriesTable,
  calcuttasTable,
  db,
  eventsTable,
  mtmEntryValuationTable,
  mtmGameConditionalTable,
  mtmSnapshotTable,
  mtmValuationGameTable,
  mtmValuationVersionTable,
  seasonsTable,
  teamsTable,
} from "@workspace/db";
import { loadSeasonOwnership } from "./seasonOwnership";
import {
  calculateSignedOwnerValue,
  canonicalizeActuals,
  hashActualsState,
  type CanonicalActual,
  type FinalizedActual,
} from "./mtmValuationHelpers";

export {
  canonicalizeActuals,
  canonicalActualsJson,
  hashActualsState,
  canonicalizeActualsState,
  computeActualsStateHash,
} from "./mtmValuationHelpers";

type Outcome = "home_win" | "away_win" | "tie";
type LinkageGame = FinalizedActual & {
  eventId: number | string;
  linkageStatus?: "incorporated" | "pending";
  isProvisional?: boolean;
};
const CURRENT_MTM_LOCK_NAMESPACE = 9_881;

export type CurrentMtmValidationArgs = {
  version: {
    poolId: number;
    sourceSnapshotId: number;
    actualsStateHash: string;
    markType: "official" | "provisional" | "pending_recalculation";
    status: "candidate" | "current" | "superseded";
    provisionalEventId?: number | null;
    provisionalOutcome?: Outcome | null;
    staleReason?: string | null;
  };
  sourceSnapshot: Record<string, any>;
  /** Actuals after provider/source identifiers have been resolved to DB IDs. */
  sourceActuals?: FinalizedActual[];
  actuals?: FinalizedActual[];
  incorporatedGames: LinkageGame[];
  pendingGames?: LinkageGame[];
  conditionalRows?: Array<Record<string, any>>;
  officialValuations?: Array<Record<string, any>>;
  expectedPoolId?: number;
  poolValue?: number | null;
  expectedEntryIds?: number[];
};

function sourceActuals(snapshot: Record<string, any>): FinalizedActual[] {
  return (
    snapshot.finalizedGames ??
    snapshot.actuals ??
    snapshot.inputProvenance?.realized_results ??
    snapshot.stateJson?.completed_results ??
    []
  );
}

function sourceConditionals(snapshot: Record<string, any>): Array<Record<string, any>> {
  return snapshot.conditionalRows ?? snapshot.conditionals ?? snapshot.conditional_payouts ?? [];
}

export type NormalizedSourceActual = FinalizedActual & {
  eventId: number;
  week: number;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number;
  awayScore: number;
};

export function normalizeSourceActuals(
  snapshot: Record<string, any>,
  events: Array<{
    id: number;
    source: string;
    sourceEventId: string;
    week: number;
    homeTeamId: number;
    awayTeamId: number;
  }>,
): NormalizedSourceActual[] {
  const byProviderSource = new Map<string, any>(
    events.map((event) => [`${event.source}:${event.sourceEventId}`, event]),
  );
  const mapped: NormalizedSourceActual[] = [];
  for (const actual of sourceActuals(snapshot)) {
    const provider = String((actual as any).provider ?? (actual as any).source ?? "");
    const sourceId = String((actual as any).source_id ?? (actual as any).sourceEventId ?? "");
    const event = byProviderSource.get(`${provider}:${sourceId}`);
    if (!event) throw new Error(`Persisted actual ${provider}:${sourceId} has no canonical pool event.`);
    const homeScore = Number((actual as any).home_score ?? (actual as any).homeScore);
    const awayScore = Number((actual as any).away_score ?? (actual as any).awayScore);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
      throw new Error(`Persisted actual ${provider}:${sourceId} has an invalid score.`);
    }
    mapped.push({
      eventId: event.id,
      week: event.week,
      homeTeamId: event.homeTeamId,
      awayTeamId: event.awayTeamId,
      homeScore,
      awayScore,
    });
  }
  if (new Set(mapped.map((actual) => actual.eventId)).size !== mapped.length) {
    throw new Error("Persisted actuals contain duplicate canonical events.");
  }
  return mapped;
}

/**
 * Resolve persisted provider actuals to canonical events/team IDs. Provider
 * source IDs are used only for this lookup and never enter the economic hash.
 */
export async function mapSourceActualsForPool(
  executor: any,
  poolId: number,
  snapshot: Record<string, any>,
): Promise<NormalizedSourceActual[]> {
  if (snapshot.poolId !== poolId) throw new Error("Source snapshot and pool do not match.");
  const [pool] = await executor.select({ seasonId: calcuttasTable.seasonId })
    .from(calcuttasTable)
    .where(eq(calcuttasTable.id, poolId))
    .limit(1);
  if (!pool) throw new Error("MTM pool was not found.");
  const events = await executor.select({
    id: eventsTable.id,
    source: eventsTable.source,
    sourceEventId: eventsTable.sourceEventId,
    week: eventsTable.week,
    homeTeamId: eventsTable.homeTeamId,
    awayTeamId: eventsTable.awayTeamId,
  }).from(eventsTable).where(and(
    eq(eventsTable.seasonId, pool.seasonId),
    eq(eventsTable.sport, "NFL"),
    eq(eventsTable.competition, "NFL_REGULAR_SEASON"),
  ));
  return normalizeSourceActuals(snapshot, events);
}

function sourceActualsAsOf(snapshot: Record<string, any>, fallback: Date): Date {
  const dates = sourceActuals(snapshot)
    .map((actual: any) => actual.fetched_at ?? actual.fetchedAt)
    .filter((value: unknown): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  const anchor = snapshot.actualAnchor ? new Date(snapshot.actualAnchor).getTime() : 0;
  return new Date(Math.max(anchor, ...dates, fallback.getTime()));
}

function rowNumber(row: Record<string, any>, ...keys: string[]): number | null {
  for (const key of keys) {
    if (row[key] !== null && row[key] !== undefined && row[key] !== "") {
      const value = Number(row[key]);
      return Number.isFinite(value) ? value : Number.NaN;
    }
  }
  return null;
}

function rowText(row: Record<string, any>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (row[key] !== null && row[key] !== undefined && row[key] !== "") return String(row[key]);
  }
  return null;
}

function canonicalLinkage(games: LinkageGame[]): CanonicalActual[] {
  return canonicalizeActuals(games.map((game) => ({
    ...game,
    eventId: game.eventId ?? game.event_id ?? game.gameId ?? game.game_id,
  })));
}

function sameActualSet(left: CanonicalActual[], right: CanonicalActual[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((game, index) => JSON.stringify(game) === JSON.stringify(right[index]));
}

/**
 * Validate a proposed normalized publication before it is promoted.  This is
 * intentionally pure: callers can validate a transaction's in-memory rows
 * before inserting them, and tests do not need a database.
 */
export function validateCurrentMtmVersion(args: CurrentMtmValidationArgs): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const { version, sourceSnapshot } = args;
  if (args.expectedPoolId != null && version.poolId !== args.expectedPoolId) {
    errors.push("Version pool does not match the requested pool.");
  }
  if (sourceSnapshot.poolId !== version.poolId) errors.push("Source snapshot and version pool must match.");
  if (sourceSnapshot.status !== "ok") errors.push("Source snapshot must be successful.");
  if (sourceSnapshot.methodVersion === "mtm-v3-review" || sourceSnapshot.runKind === "review") {
    errors.push("Review-only source snapshots cannot support a current MTM version.");
  }
  if (!["official", "provisional", "pending_recalculation"].includes(version.markType)) {
    errors.push("Unsupported MTM mark type.");
  }
  if (!["candidate", "current", "superseded"].includes(version.status)) errors.push("Unsupported MTM version status.");

  let sourceCanonical: CanonicalActual[];
  let actualCanonical: CanonicalActual[];
  try {
    sourceCanonical = canonicalizeActuals(args.sourceActuals ?? sourceActuals(sourceSnapshot));
    actualCanonical = canonicalizeActuals(args.actuals ?? sourceActuals(sourceSnapshot));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    sourceCanonical = [];
    actualCanonical = [];
  }
  let incorporatedCanonical: CanonicalActual[] = [];
  let pendingCanonical: CanonicalActual[] = [];
  try {
    incorporatedCanonical = canonicalLinkage(args.incorporatedGames);
    pendingCanonical = canonicalLinkage(args.pendingGames ?? []);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    if (hashActualsState(args.actuals ?? sourceActuals(sourceSnapshot)) !== version.actualsStateHash) {
      errors.push("Version actuals state hash does not match the incorporated actuals state.");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const allLinked = [...incorporatedCanonical, ...pendingCanonical];
  const linkedIds = new Set(allLinked.map((game) => game.game_id));
  if (linkedIds.size !== allLinked.length) errors.push("Version game linkage contains duplicate game identities.");
  if (version.markType === "pending_recalculation") {
    if (!pendingCanonical.length) errors.push("Pending recalculation must identify unincorporated games.");
    if (!sameActualSet([...incorporatedCanonical, ...pendingCanonical].sort(compareActuals), actualCanonical)) {
      errors.push("Pending version game linkage must exactly cover incorporated and unincorporated actuals.");
    }
    if (!version.staleReason) errors.push("Pending recalculation must include a stale reason.");
  } else if (pendingCanonical.length || !sameActualSet(incorporatedCanonical, actualCanonical)) {
    errors.push("Official/provisional game linkage must exactly cover the actuals state.");
  }
  if (version.markType === "official" && !sameActualSet(sourceCanonical, actualCanonical)) {
    errors.push("Official values must remain anchored to the source snapshot actuals.");
  }
  if (version.markType === "provisional") {
    const nonProvisional = args.incorporatedGames
      .filter((game) => !game.isProvisional);
    try {
      if (!sameActualSet(canonicalLinkage(nonProvisional), sourceCanonical)) {
        errors.push("Provisional values must retain the complete source snapshot game set.");
      }
    } catch {
      // The detailed canonicalization error was already reported above.
    }
  }

  const provisionalRows = args.incorporatedGames.filter((game) => game.isProvisional);
  const provisionalEventId = version.provisionalEventId == null ? null : String(version.provisionalEventId);
  if (provisionalRows.length > 1) errors.push("At most one provisional game may be incorporated.");
  if (version.markType === "official" && (provisionalRows.length || provisionalEventId != null)) {
    errors.push("Official versions cannot contain a provisional outcome.");
  }
  if (version.markType === "provisional" && provisionalRows.length !== 1) {
    errors.push("Provisional versions require exactly one provisional game.");
  }
  if (provisionalRows.length === 1) {
    const row = provisionalRows[0]!;
    if (provisionalEventId != null && String(row.eventId) !== provisionalEventId) {
      errors.push("Version provisional event does not match its game linkage.");
    }
    if (!version.provisionalOutcome) errors.push("Provisional outcome is required.");
    const homeScore = Number((row as any).homeScore ?? (row as any).home_score);
    const awayScore = Number((row as any).awayScore ?? (row as any).away_score);
    if (Number.isFinite(homeScore) && Number.isFinite(awayScore) &&
        version.provisionalOutcome &&
        outcomeForScores(homeScore, awayScore) !== version.provisionalOutcome) {
      errors.push("Version provisional outcome does not match the finalized score.");
    }
  }

  const conditionalRows = args.conditionalRows ?? sourceConditionals(sourceSnapshot);
  const conditionalEventIds = new Set(conditionalRows.map((row) => String(row.eventId ?? row.event_id)));
  if (provisionalRows.length === 1 && !conditionalEventIds.has(String(provisionalRows[0]!.eventId))) {
    errors.push("Provisional event must exist in the source snapshot conditional rows.");
  }
  if (version.provisionalEventId != null && !conditionalEventIds.has(String(version.provisionalEventId))) {
    errors.push("Version provisional event must exist in the source snapshot conditional rows.");
  }

  const selectedEvent = provisionalRows[0]?.eventId ?? version.provisionalEventId;
  const selectedOutcome = version.provisionalOutcome;
  if (selectedEvent != null && selectedOutcome) {
    const selectedRows = conditionalRows.filter((row) =>
      String(row.eventId ?? row.event_id) === String(selectedEvent) &&
      String(row.outcome) === selectedOutcome,
    );
    const entryIds = new Set(selectedRows.map((row) => String(row.entryId ?? row.entry_id)));
    const expectedEntries = args.expectedEntryIds ?? [];
    if (selectedRows.length !== 32 || entryIds.size !== 32 ||
        (expectedEntries.length > 0 && (
          expectedEntries.length !== 32 ||
          expectedEntries.some((id) => !entryIds.has(String(id)))
        ))) {
      errors.push("Provisional conditional outcome must have complete 32-entry coverage.");
    }
    let conditionalTotal = 0;
    for (const row of selectedRows) {
      const payout = rowNumber(row, "grossConditional", "gross_conditional");
      const baseline = rowNumber(row, "grossBaseline", "gross_baseline");
      if (payout == null || !Number.isFinite(payout) || payout < 0 ||
          baseline == null || !Number.isFinite(baseline) || baseline < 0) {
        errors.push("Conditional payouts must be finite and nonnegative.");
      } else {
        conditionalTotal += payout;
      }
      const quality = rowText(row, "qualityStatus", "quality_status");
      if (!["good", "warning"].includes(quality ?? "")) {
        errors.push("Conditional rows must have acceptable quality.");
      }
    }
    const poolValue = args.poolValue ?? Number(sourceSnapshot.stateJson?.pot);
    if (Number.isFinite(poolValue) && poolValue > 0 && Math.abs(conditionalTotal - poolValue) > 0.01) {
      errors.push("Conditional payouts do not reconcile to the auction pool.");
    }
  }
  if (!args.officialValuations) {
    errors.push("Official valuation rows are required.");
  } else {
    const valuationEntryIds = args.officialValuations.map((row) =>
      String(row.entryId ?? row.entry_id),
    );
    const uniqueEntryIds = new Set(valuationEntryIds);
    const expectedEntries = args.expectedEntryIds ?? [];
    const completeEntrySet = expectedEntries.length > 0
      ? expectedEntries.length === 32 &&
        uniqueEntryIds.size === 32 &&
        expectedEntries.every((id) => uniqueEntryIds.has(String(id)))
      : uniqueEntryIds.size === 32 && args.officialValuations.length === 32;
    if (!completeEntrySet || args.officialValuations.length !== 32) {
      errors.push("Official valuations must contain exactly the pool's 32 entries.");
    }
    let invalidOfficialPayout = false;
    const total = args.officialValuations.reduce((sum, row) => {
      const payout = rowNumber(row, "expectedPayout", "expected_payout", "grossExpectedPayout", "gross_expected_payout");
      if (payout == null || !Number.isFinite(payout) || payout < 0) {
        invalidOfficialPayout = true;
        return Number.NaN;
      }
      return sum + payout;
    }, 0);
    if (invalidOfficialPayout) errors.push("Official payouts must be finite and nonnegative.");
    if (!Number.isFinite(args.poolValue) || args.poolValue == null || args.poolValue < 0 ||
        !Number.isFinite(total) || Math.abs(total - args.poolValue) > 0.01) {
      errors.push("Official team MTM values do not reconcile to the auction pool.");
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function compareActuals(left: CanonicalActual, right: CanonicalActual): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

export function assertValidCurrentMtmVersion(args: CurrentMtmValidationArgs): void {
  const result = validateCurrentMtmVersion(args);
  if (!result.valid) throw new Error(`Invalid current MTM version: ${result.errors.join("; ")}`);
}

export type PromoteCurrentMtmArgs = {
  poolId: number;
  sourceSnapshotId: number;
  markType: "official" | "provisional" | "pending_recalculation";
  provisionalEventId?: number;
  provisionalOutcome?: Outcome;
  pendingGames?: LinkageGame[];
  actuals?: FinalizedActual[];
  actualsAsOf?: Date;
  mtmAsOf?: Date;
  staleReason?: string | null;
};

function outcomeForScores(homeScore: number, awayScore: number): Outcome {
  return homeScore > awayScore ? "home_win" : awayScore > homeScore ? "away_win" : "tie";
}

function linkageRow(game: LinkageGame, versionId: number, isProvisional = false) {
  const homeScore = Number((game as any).homeScore ?? (game as any).home_score);
  const awayScore = Number((game as any).awayScore ?? (game as any).away_score);
  const hasScore = Number.isFinite(homeScore) && Number.isFinite(awayScore);
  return {
    versionId,
    eventId: Number(game.eventId),
    week: Number(game.week),
    homeTeamId: Number((game as any).homeTeamId ?? (game as any).home_team_id),
    awayTeamId: Number((game as any).awayTeamId ?? (game as any).away_team_id),
    homeScore: hasScore ? homeScore : null,
    awayScore: hasScore ? awayScore : null,
    outcome: hasScore ? outcomeForScores(homeScore, awayScore) : null,
    linkageStatus: game.linkageStatus ?? (isProvisional ? "incorporated" : "incorporated"),
    isProvisional,
  };
}

/**
 * Validate, insert, and promote a current version as one transaction. A
 * candidate is never visible after a validation failure because all candidate
 * and linkage writes occur under the same transaction as the advisory lock.
 */
export async function validateAndPromoteCurrentMtm(
  args: PromoteCurrentMtmArgs,
): Promise<{ versionId: number; sourceSnapshotId: number; status: "current" }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CURRENT_MTM_LOCK_NAMESPACE}, ${args.poolId})`);
    const [sourceSnapshot] = await tx.select().from(mtmSnapshotTable)
      .where(eq(mtmSnapshotTable.id, args.sourceSnapshotId)).limit(1);
    if (!sourceSnapshot) throw new Error("Source MTM snapshot was not found.");
    if (sourceSnapshot.poolId !== args.poolId) throw new Error("Source snapshot and pool do not match.");
    if (sourceSnapshot.status !== "ok" || sourceSnapshot.methodVersion === "mtm-v3-review") {
      throw new Error("Current MTM requires a successful non-review source snapshot.");
    }
    const sourceActuals = await mapSourceActualsForPool(tx, args.poolId, sourceSnapshot);
    const [entries, valuations, conditionalRows, poolRows] = await Promise.all([
      tx.select({
        entryId: calcuttaEntriesTable.id,
        teamId: calcuttaEntriesTable.teamId,
      }).from(calcuttaEntriesTable).where(eq(calcuttaEntriesTable.calcuttaId, args.poolId)),
      tx.select().from(mtmEntryValuationTable).where(eq(mtmEntryValuationTable.snapshotId, args.sourceSnapshotId)),
      tx.select().from(mtmGameConditionalTable).where(eq(mtmGameConditionalTable.snapshotId, args.sourceSnapshotId)),
      tx.select({ seasonId: calcuttasTable.seasonId }).from(calcuttasTable)
        .where(eq(calcuttasTable.id, args.poolId)).limit(1),
    ]);
    const poolValue = Number((sourceSnapshot.stateJson as Record<string, any> | null)?.pot);
    const expectedEntryIds = entries.map((entry) => entry.entryId);
    if (expectedEntryIds.length !== 32) throw new Error("Current MTM requires exactly 32 pool entries.");
    const requestedPendingGames = args.pendingGames ?? [];
    const requestedPendingIds = requestedPendingGames.map((game) => Number(game.eventId));
    if (requestedPendingIds.some((id) => !Number.isInteger(id)) ||
        new Set(requestedPendingIds).size !== requestedPendingIds.length) {
      throw new Error("Pending games must identify distinct canonical events.");
    }
    const pendingEvents = requestedPendingIds.length
      ? await tx.select().from(eventsTable).where(and(
        inArray(eventsTable.id, requestedPendingIds),
        eq(eventsTable.seasonId, poolRows[0]!.seasonId),
        eq(eventsTable.sport, "NFL"),
        eq(eventsTable.competition, "NFL_REGULAR_SEASON"),
      ))
      : [];
    if (pendingEvents.length !== requestedPendingIds.length ||
        pendingEvents.some((event) => event.homeScore == null || event.awayScore == null)) {
      throw new Error("Pending games must be finalized canonical events for the pool season.");
    }
    const pendingGames: LinkageGame[] = pendingEvents.map((event) => ({
      eventId: event.id,
      week: event.week,
      homeTeamId: event.homeTeamId,
      awayTeamId: event.awayTeamId,
      homeScore: event.homeScore!,
      awayScore: event.awayScore!,
      linkageStatus: "pending",
    }));
    let provisionalGame: LinkageGame | null = null;
    if (args.provisionalEventId != null) {
      const [event] = await tx.select().from(eventsTable)
        .where(eq(eventsTable.id, args.provisionalEventId)).limit(1);
      if (!event || event.homeScore == null || event.awayScore == null) {
        throw new Error("Provisional event must have a complete canonical result.");
      }
      provisionalGame = {
        eventId: event.id,
        week: event.week,
        homeTeamId: event.homeTeamId,
        awayTeamId: event.awayTeamId,
        homeScore: event.homeScore,
        awayScore: event.awayScore,
        isProvisional: true,
      };
    }
    const incorporatedGames: LinkageGame[] = sourceActuals.map((actual) => ({
      ...actual,
      eventId: Number(actual.eventId),
      isProvisional: false,
    }));
    if (provisionalGame) incorporatedGames.push(provisionalGame);
    const actuals = args.actuals ?? [
      ...sourceActuals,
      ...pendingGames,
      ...(provisionalGame ? [provisionalGame] : []),
    ];
    const sourceDate = sourceSnapshot.asOf instanceof Date ? sourceSnapshot.asOf : new Date(sourceSnapshot.asOf);
    const candidateValues = {
      poolId: args.poolId,
      sourceSnapshotId: args.sourceSnapshotId,
      actualsStateHash: hashActualsState(actuals),
      actualsAsOf: args.actualsAsOf ?? sourceActualsAsOf(sourceSnapshot, sourceDate),
      mtmAsOf: args.mtmAsOf ?? sourceDate,
      markType: args.markType,
      status: "candidate" as const,
      staleReason: args.staleReason ?? (args.markType === "pending_recalculation" ? "Unincorporated finalized games require recalculation." : null),
      provisionalEventId: args.provisionalEventId ?? null,
      provisionalOutcome: args.provisionalOutcome ?? null,
    };
    const [candidate] = await tx.insert(mtmValuationVersionTable).values(candidateValues)
      .returning({ id: mtmValuationVersionTable.id });
    if (!candidate) throw new Error("Failed to create MTM candidate.");
    const rows = [
      ...incorporatedGames.map((game) => linkageRow(game, candidate.id, game.isProvisional === true)),
      ...pendingGames.map((game) => linkageRow({ ...game, linkageStatus: "pending" }, candidate.id)),
    ];
    if (rows.length) await tx.insert(mtmValuationGameTable).values(rows);
    const validation = validateCurrentMtmVersion({
      version: candidateValues,
      sourceSnapshot,
      sourceActuals,
      actuals,
      incorporatedGames,
      pendingGames,
      conditionalRows,
      officialValuations: valuations,
      expectedEntryIds,
      poolValue,
    });
    if (!validation.valid) throw new Error(`Current MTM validation failed: ${validation.errors.join("; ")}`);
    await tx.update(mtmValuationVersionTable)
      .set({ status: "superseded" })
      .where(and(eq(mtmValuationVersionTable.poolId, args.poolId), eq(mtmValuationVersionTable.status, "current")));
    await tx.update(mtmValuationVersionTable)
      .set({ status: "current" })
      .where(eq(mtmValuationVersionTable.id, candidate.id));
    return { versionId: candidate.id, sourceSnapshotId: args.sourceSnapshotId, status: "current" as const };
  }, { isolationLevel: "serializable" });
}

export const validateAndPromoteCurrentMtmVersion = validateAndPromoteCurrentMtm;
export const mapSourceActuals = mapSourceActualsForPool;

export type CurrentMtmResolution = {
  available: boolean;
  versionId: number | null;
  sourceSnapshotId: number | null;
  status: "candidate" | "current" | "superseded" | null;
  actualsStateHash: string | null;
  markType: "official" | "provisional" | "pending_recalculation" | null;
  provisionalEventId: number | null;
  provisionalOutcome: Outcome | null;
  actualsAsOf: string | null;
  mtmAsOf: string | null;
  teams: Array<Record<string, any>>;
  owners: Array<Record<string, any>>;
  incorporatedGames: Array<Record<string, any>>;
  pendingGames: Array<Record<string, any>>;
  staleReason: string | null;
};

function unavailableResolution(version: any | null, staleReason: string): CurrentMtmResolution {
  return {
    available: false,
    versionId: version?.id ?? null,
    sourceSnapshotId: version?.sourceSnapshotId ?? null,
    status: version?.status ?? null,
    actualsStateHash: version?.actualsStateHash ?? null,
    markType: version?.markType ?? null,
    provisionalEventId: version?.provisionalEventId ?? null,
    provisionalOutcome: version?.provisionalOutcome ?? null,
    actualsAsOf: version?.actualsAsOf ? new Date(version.actualsAsOf).toISOString() : null,
    mtmAsOf: version?.mtmAsOf ? new Date(version.mtmAsOf).toISOString() : null,
    teams: [], owners: [], incorporatedGames: [], pendingGames: [], staleReason,
  };
}

/**
 * Shared pure read-model assembly used by the database resolver and focused
 * reconciliation tests.
 */
export function buildCurrentMtmResolution(args: {
  version: any | null;
  sourceSnapshotId?: number | null;
  teamValues?: Array<{
    entryId: number;
    teamId: number;
    teamName?: string | null;
    expectedPayout: number;
    currentExpectedPayout?: number;
    auctionPrice?: number | null;
  }>;
  games?: Array<Record<string, any>>;
  ownership?: Array<{
    bidderId: number;
    bidderName: string;
    teamId: number;
    effectiveShare: number;
    originalCostBasis: number;
    tradePaid: number;
    tradeReceived: number;
  }>;
}): CurrentMtmResolution {
  if (!args.version) {
    return {
      available: false, versionId: null, sourceSnapshotId: null, markType: null,
      status: null, actualsStateHash: null, provisionalEventId: null, provisionalOutcome: null,
      actualsAsOf: null, mtmAsOf: null, teams: [], owners: [],
      incorporatedGames: [], pendingGames: [], staleReason: "No current MTM version is available.",
    };
  }
  const teams = (args.teamValues ?? []).map((team) => ({
    entryId: team.entryId,
    teamId: team.teamId,
    teamName: team.teamName ?? null,
    officialMtm: team.expectedPayout,
    currentMtm: team.currentExpectedPayout ?? team.expectedPayout,
    grossExpectedPayout: team.currentExpectedPayout ?? team.expectedPayout,
    auctionPrice: team.auctionPrice ?? null,
    net: team.auctionPrice == null
      ? null
      : (team.currentExpectedPayout ?? team.expectedPayout) - team.auctionPrice,
  }));
  const ownersById = new Map<number, Record<string, any>>();
  for (const position of args.ownership ?? []) {
    const team = teams.find((item) => item.teamId === position.teamId);
    if (!team) continue;
    const owner = ownersById.get(position.bidderId) ?? {
      bidderId: position.bidderId,
      bidderName: position.bidderName,
      holdings: [],
      grossExpectedPayout: 0,
      net: 0,
    };
    const value = calculateSignedOwnerValue(
      team.currentMtm,
      position.effectiveShare,
      position.originalCostBasis,
      position.tradePaid,
      position.tradeReceived,
    );
    owner.holdings.push({
      teamId: position.teamId,
      signedShare: position.effectiveShare,
      grossExpectedPayout: value.gross,
      signedCostBasis: value.signedCostBasis,
      net: value.net,
    });
    owner.grossExpectedPayout += value.gross;
    owner.net += value.net;
    ownersById.set(position.bidderId, owner);
  }
  return {
    available: true,
    versionId: args.version.id,
    sourceSnapshotId: args.sourceSnapshotId ?? args.version.sourceSnapshotId,
    status: args.version.status,
    actualsStateHash: args.version.actualsStateHash,
    markType: args.version.markType,
    provisionalEventId: args.version.provisionalEventId ?? null,
    provisionalOutcome: args.version.provisionalOutcome ?? null,
    actualsAsOf: new Date(args.version.actualsAsOf).toISOString(),
    mtmAsOf: new Date(args.version.mtmAsOf).toISOString(),
    teams,
    owners: [...ownersById.values()],
    incorporatedGames: (args.games ?? []).filter((game) => game.linkageStatus !== "pending"),
    pendingGames: (args.games ?? []).filter((game) => game.linkageStatus === "pending"),
    staleReason: args.version.staleReason ?? null,
  };
}

/** Resolve the durable current version for a pool without running MTM. */
export async function resolveCurrentMtm(poolId: number): Promise<CurrentMtmResolution> {
  const [version] = await db.select().from(mtmValuationVersionTable)
    .where(and(eq(mtmValuationVersionTable.poolId, poolId), eq(mtmValuationVersionTable.status, "current")))
    .orderBy(desc(mtmValuationVersionTable.createdAt), desc(mtmValuationVersionTable.id))
    .limit(1);
  if (!version) return buildCurrentMtmResolution({ version: null });
  const [snapshot, entries, games, conditionalRows, poolRows] = await Promise.all([
    db.select().from(mtmSnapshotTable).where(eq(mtmSnapshotTable.id, version.sourceSnapshotId)).limit(1),
    db.select({
      entryId: calcuttaEntriesTable.id,
      teamId: calcuttaEntriesTable.teamId,
      teamName: teamsTable.name,
    }).from(calcuttaEntriesTable)
      .innerJoin(teamsTable, eq(teamsTable.id, calcuttaEntriesTable.teamId))
      .where(eq(calcuttaEntriesTable.calcuttaId, poolId)),
    db.select().from(mtmValuationGameTable).where(eq(mtmValuationGameTable.versionId, version.id)),
    version.markType === "provisional" && version.provisionalEventId != null && version.provisionalOutcome != null
      ? db.select().from(mtmGameConditionalTable).where(and(
        eq(mtmGameConditionalTable.snapshotId, version.sourceSnapshotId),
        eq(mtmGameConditionalTable.eventId, version.provisionalEventId),
        eq(mtmGameConditionalTable.outcome, version.provisionalOutcome),
      ))
      : Promise.resolve([]),
    db.select({ seasonId: calcuttasTable.seasonId }).from(calcuttasTable).where(eq(calcuttasTable.id, poolId)).limit(1),
  ]);
  const sourceSnapshot = snapshot[0];
  if (!sourceSnapshot) return unavailableResolution(version, "Current MTM source snapshot is missing.");
  if (sourceSnapshot.poolId !== poolId || sourceSnapshot.status !== "ok" ||
      sourceSnapshot.methodVersion === "mtm-v3-review") {
    return unavailableResolution(version, "Current MTM source snapshot is invalid or review-only.");
  }
  let normalizedSourceActuals: NormalizedSourceActual[];
  try {
    normalizedSourceActuals = await mapSourceActualsForPool(db, poolId, sourceSnapshot);
  } catch (error) {
    return unavailableResolution(version, error instanceof Error ? error.message : String(error));
  }
  const normalizedGames: LinkageGame[] = games.map((game) => ({
    eventId: game.eventId,
    week: game.week,
    homeTeamId: game.homeTeamId,
    awayTeamId: game.awayTeamId,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
    linkageStatus: game.linkageStatus as "incorporated" | "pending",
    isProvisional: game.isProvisional,
  }));
  const actuals = normalizedGames.map((game) => ({
    eventId: game.eventId,
    week: game.week,
    homeTeamId: game.homeTeamId,
    awayTeamId: game.awayTeamId,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
  }));
  const validation = validateCurrentMtmVersion({
    version: {
      ...version,
      markType: version.markType as "official" | "provisional" | "pending_recalculation",
      status: version.status as "candidate" | "current" | "superseded",
      provisionalOutcome: version.provisionalOutcome as Outcome | null,
    },
    sourceSnapshot,
    sourceActuals: normalizedSourceActuals,
    actuals,
    incorporatedGames: normalizedGames.filter((game) => game.linkageStatus !== "pending"),
    pendingGames: normalizedGames.filter((game) => game.linkageStatus === "pending"),
    conditionalRows,
    // Official values are always read from the immutable source snapshot.
    officialValuations: await db.select().from(mtmEntryValuationTable)
      .where(eq(mtmEntryValuationTable.snapshotId, version.sourceSnapshotId)),
    expectedEntryIds: entries.map((entry) => entry.entryId),
    poolValue: Number((sourceSnapshot.stateJson as Record<string, any> | null)?.pot),
  });
  if (!validation.valid) return unavailableResolution(version, validation.errors.join("; "));
  const entryIds = entries.map((entry) => entry.entryId);
  const valuations = entryIds.length
    ? await db.select().from(mtmEntryValuationTable)
      .where(and(eq(mtmEntryValuationTable.snapshotId, version.sourceSnapshotId), inArray(mtmEntryValuationTable.entryId, entryIds)))
    : [];
  const valuationByEntry = new Map(valuations.map((row) => [row.entryId, row]));
  const conditionalByEntry = new Map(conditionalRows.map((row) => [
    row.entryId,
    row.grossConditional == null ? null : Number(row.grossConditional),
  ]));
  const teamValues = entries.flatMap((entry) => {
    const row = valuationByEntry.get(entry.entryId);
    return row?.expectedPayout == null ? [] : [{
      entryId: entry.entryId,
      teamId: entry.teamId,
      teamName: entry.teamName,
      expectedPayout: Number(row.expectedPayout),
      currentExpectedPayout: conditionalByEntry.get(entry.entryId) ?? undefined,
      auctionPrice: row.auctionPrice == null ? null : Number(row.auctionPrice),
    }];
  });
  const seasonId = poolRows[0]?.seasonId;
  const ownership = seasonId == null ? undefined : await loadSeasonOwnership(seasonId, poolId);
  const ownerRows = ownership
    ? [...ownership.byBidder.entries()].flatMap(([bidderId, positions]) =>
      [...positions.entries()].map(([teamId, position]) => ({
        bidderId,
        bidderName: ownership.bidderNames.get(bidderId) ?? "Unknown",
        teamId,
        effectiveShare: position.effectiveShare,
        originalCostBasis: position.originalCostBasis,
        tradePaid: position.tradePaid,
        tradeReceived: position.tradeReceived,
      })))
    : [];
  return buildCurrentMtmResolution({
    version,
    sourceSnapshotId: sourceSnapshot.id,
    teamValues,
    games,
    ownership: ownerRows,
  });
}