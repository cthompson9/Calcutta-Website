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
import { TEAM_ABBREVIATION_ALIASES } from "./nflEventSync";
import { allocateMtmPoolCents } from "./mtmMoney";
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
    homeTeamCode?: string;
    awayTeamCode?: string;
  }>,
): NormalizedSourceActual[] {
  const byProviderSource = new Map<string, any>(
    events.map((event) => [`${event.source}:${event.sourceEventId}`, event]),
  );
  const teamCodeToId = new Map<string, number>();
  for (const event of events) {
    if (event.homeTeamCode) teamCodeToId.set(event.homeTeamCode, event.homeTeamId);
    if (event.awayTeamCode) teamCodeToId.set(event.awayTeamCode, event.awayTeamId);
  }
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
    const sourceWeek = Number((actual as any).week);
    const sourceHomeTeamId = Number((actual as any).homeTeamId);
    const sourceAwayTeamId = Number((actual as any).awayTeamId);
    mapped.push({
      eventId: event.id,
      week: Number.isInteger(sourceWeek) ? sourceWeek : event.week,
      homeTeamId: Number.isInteger(sourceHomeTeamId)
        ? sourceHomeTeamId
        : teamCodeToId.get(String((actual as any).home ?? "")) ?? event.homeTeamId,
      awayTeamId: Number.isInteger(sourceAwayTeamId)
        ? sourceAwayTeamId
        : teamCodeToId.get(String((actual as any).away ?? "")) ?? event.awayTeamId,
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
  const teams = await executor.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable);
  const codeByTeamId = new Map<number, string>();
  for (const [code, name] of Object.entries(TEAM_ABBREVIATION_ALIASES)) {
    const team = teams.find((row: { id: number; name: string }) => row.name === name);
    if (team) codeByTeamId.set(team.id, code);
  }
  for (const event of events) {
    event.homeTeamCode = codeByTeamId.get(event.homeTeamId);
    event.awayTeamCode = codeByTeamId.get(event.awayTeamId);
  }
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
  const linkedById = new Map(allLinked.map((game) => [game.game_id, game]));
  if (version.markType === "pending_recalculation") {
    if (!pendingCanonical.length) errors.push("Pending recalculation must identify unincorporated games.");
    if (!sameActualSet([...incorporatedCanonical, ...pendingCanonical].sort(compareActuals), actualCanonical)) {
      errors.push("Pending version game linkage must exactly cover incorporated and unincorporated actuals.");
    }
    for (const sourceGame of sourceCanonical) {
      const linked = linkedById.get(sourceGame.game_id);
      if (!linked) errors.push(`Pending version lost source event ${sourceGame.game_id}.`);
      else if (!pendingCanonical.some((game) => game.game_id === sourceGame.game_id) &&
          JSON.stringify(linked) !== JSON.stringify(sourceGame)) {
        errors.push(`Incorporated source event ${sourceGame.game_id} changed without a pending replacement.`);
      }
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
      const nonProvisionalCanonical = canonicalLinkage(nonProvisional);
      for (const sourceGame of sourceCanonical) {
        if (String(sourceGame.game_id) === String(version.provisionalEventId)) continue;
        if (!nonProvisionalCanonical.some((game) => JSON.stringify(game) === JSON.stringify(sourceGame))) {
          errors.push("Provisional values must retain the complete source snapshot game set.");
          break;
        }
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
  lease?: {
    runId: string;
    ownerToken: string;
  };
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
  return db.transaction((tx) => promoteCurrentMtmInTransaction(tx, args, true), {
    isolationLevel: "serializable",
  });
}

type MtmTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function promoteCurrentMtmInTransaction(
  tx: MtmTransaction,
  args: PromoteCurrentMtmArgs,
  lock = false,
): Promise<{ versionId: number; sourceSnapshotId: number; status: "current" }> {
  if (lock) {
    await tx.execute(sql`select pg_advisory_xact_lock(${CURRENT_MTM_LOCK_NAMESPACE}, ${args.poolId})`);
  }
  if (args.lease) {
    const owned = await tx.execute<{ run_id: string }>(sql`
      select run_id
      from mtm_job_leases
      where pool_id = ${args.poolId}
        and owner_token = ${args.lease.ownerToken}
        and run_id = ${args.lease.runId}
        and lease_until > clock_timestamp()
      for update
    `);
    if (owned.rows.length === 0) {
      throw new Error("MTM lease was lost before official promotion.");
    }
  }
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
    if (pendingEvents.length !== requestedPendingIds.length) {
      throw new Error("Pending games must be canonical events for the pool season.");
    }
    const sourceActualById = new Map(sourceActuals.map((actual) => [Number(actual.eventId), actual]));
    const pendingGames: LinkageGame[] = pendingEvents.map((event) => {
      if (event.homeScore != null && event.awayScore != null) {
        return {
          eventId: event.id,
          week: event.week,
          homeTeamId: event.homeTeamId,
          awayTeamId: event.awayTeamId,
          homeScore: event.homeScore,
          awayScore: event.awayScore,
          linkageStatus: "pending" as const,
        };
      }
      const retained = sourceActualById.get(event.id);
      if (!retained) {
        throw new Error("Incomplete pending evidence must retain a finalized result from the source snapshot.");
      }
      return {
        ...retained,
        eventId: event.id,
        linkageStatus: "pending" as const,
      };
    });
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
    const replacementIds = new Set([
      ...requestedPendingIds,
      ...(args.provisionalEventId == null ? [] : [args.provisionalEventId]),
    ]);
    const incorporatedGames: LinkageGame[] = sourceActuals
      .filter((actual) => !replacementIds.has(Number(actual.eventId)))
      .map((actual) => ({
      ...actual,
      eventId: Number(actual.eventId),
      isProvisional: false,
      }));
    if (provisionalGame) incorporatedGames.push(provisionalGame);
    const actuals = args.actuals ?? [...incorporatedGames, ...pendingGames];
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
    const [existingCurrent] = await tx.select({
      id: mtmValuationVersionTable.id,
      sourceSnapshotId: mtmValuationVersionTable.sourceSnapshotId,
      markType: mtmValuationVersionTable.markType,
      actualsStateHash: mtmValuationVersionTable.actualsStateHash,
      provisionalEventId: mtmValuationVersionTable.provisionalEventId,
      provisionalOutcome: mtmValuationVersionTable.provisionalOutcome,
    }).from(mtmValuationVersionTable).where(and(
      eq(mtmValuationVersionTable.poolId, args.poolId),
      eq(mtmValuationVersionTable.status, "current"),
    )).limit(1);
    if (existingCurrent &&
        existingCurrent.sourceSnapshotId === candidateValues.sourceSnapshotId &&
        existingCurrent.markType === candidateValues.markType &&
        existingCurrent.actualsStateHash === candidateValues.actualsStateHash &&
        existingCurrent.provisionalEventId === candidateValues.provisionalEventId &&
        existingCurrent.provisionalOutcome === candidateValues.provisionalOutcome) {
      return {
        versionId: existingCurrent.id,
        sourceSnapshotId: existingCurrent.sourceSnapshotId,
        status: "current" as const,
      };
    }
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
}

export const validateAndPromoteCurrentMtmVersion = validateAndPromoteCurrentMtm;
export const mapSourceActuals = mapSourceActualsForPool;

export type NflMtmReconciliationResult = {
  poolId: number;
  status: "promoted" | "unchanged" | "skipped" | "warning";
  markType?: "official" | "provisional" | "pending_recalculation";
  versionId?: number;
  warning?: string;
};

export type NflMtmReconciliationPlan = {
  markType: "official" | "provisional" | "pending_recalculation";
  provisionalEventId?: number;
  provisionalOutcome?: Outcome;
  staleReason?: string | null;
};

export function sameCanonicalActual(left: FinalizedActual, right: FinalizedActual): boolean {
  const [a] = canonicalizeActuals([left]);
  const [b] = canonicalizeActuals([right]);
  return Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
}

export function classifyCanonicalNflFinals(args: {
  sourceActuals: FinalizedActual[];
  canonicalFinals: FinalizedActual[];
}): {
  incorporated: FinalizedActual[];
  pending: FinalizedActual[];
  incompleteSourceEventIds: Array<string | number>;
  correctedEventIds: Array<string | number>;
} {
  const sourceById = new Map(canonicalizeActuals(args.sourceActuals).map((actual) => [actual.game_id, actual]));
  const finalsById = new Map(canonicalizeActuals(args.canonicalFinals).map((actual) => [actual.game_id, actual]));
  const finalsOriginalById = new Map(args.canonicalFinals.map((actual) => [
    canonicalizeActuals([actual])[0]!.game_id,
    actual,
  ]));
  const incorporated: FinalizedActual[] = [];
  const pending: FinalizedActual[] = [];
  const correctedEventIds: Array<string | number> = [];
  for (const source of args.sourceActuals) {
    const current = finalsById.get(canonicalizeActuals([source])[0]!.game_id);
    if (!current) continue;
    if (sameCanonicalActual(source, current)) incorporated.push(source);
    else {
      pending.push(finalsOriginalById.get(current.game_id)!);
      correctedEventIds.push(current.game_id);
    }
  }
  for (const current of args.canonicalFinals) {
    const id = canonicalizeActuals([current])[0]!.game_id;
    if (!sourceById.has(id)) pending.push(current);
  }
  const incompleteSourceEventIds = [...sourceById.keys()]
    .filter((id) => !finalsById.has(id));
  return { incorporated, pending, incompleteSourceEventIds, correctedEventIds };
}

/** Pure decision boundary used by the post-commit reconciler and its tests. */
export function planNflMtmReconciliation(args: {
  postAnchorFinalEventIds: number[];
  conditionalEvidenceValid: boolean;
  provisionalOutcome?: Outcome;
}): NflMtmReconciliationPlan {
  if (args.postAnchorFinalEventIds.length === 0) {
    return { markType: "official", staleReason: null };
  }
  if (args.postAnchorFinalEventIds.length === 1 && args.conditionalEvidenceValid &&
      args.provisionalOutcome) {
    return {
      markType: "provisional",
      provisionalEventId: args.postAnchorFinalEventIds[0],
      provisionalOutcome: args.provisionalOutcome,
      staleReason: null,
    };
  }
  return {
    markType: "pending_recalculation",
    staleReason: args.postAnchorFinalEventIds.length > 1
      ? "Multiple finalized NFL games require recalculation."
      : "Conditional evidence is missing, incomplete, weak, or unreconciled.",
  };
}

/**
 * Reconcile canonical NFL finals after an actuals import has committed.  This
 * deliberately reads the event ledger rather than trusting import callers for
 * pending metadata.  It never runs a model: one new final may use the source
 * snapshot conditional; every other case retains the source/value basis and
 * publishes a pending marker.
 */
export async function reconcileNflCurrentMtm(args: {
  seasonId: number;
}): Promise<NflMtmReconciliationResult[]> {
  const pools = await db.select({ id: calcuttasTable.id }).from(calcuttasTable)
    .where(and(
      eq(calcuttasTable.seasonId, args.seasonId),
      eq(calcuttasTable.sport, "NFL"),
      eq(calcuttasTable.competitionFormat, "NFL_REGULAR_SEASON"),
      eq(calcuttasTable.isCanonical, true),
    ))
    .orderBy(calcuttasTable.id);
  const results: NflMtmReconciliationResult[] = [];
  for (const pool of pools) {
    try {
      let reconciled: NflMtmReconciliationResult | undefined;
      for (let attempt = 0; attempt < 3 && !reconciled; attempt += 1) {
        try {
          reconciled = await reconcileNflPoolCurrentMtm(pool.id, args.seasonId);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "40001" && !String(error).toLowerCase().includes("serialization")) throw error;
          if (attempt === 2) throw error;
        }
      }
      if (reconciled) results.push(reconciled);
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      console.warn("NFL MTM post-commit reconciliation warning", {
        poolId: pool.id,
        seasonId: args.seasonId,
        warning,
      });
      results.push({ poolId: pool.id, status: "warning", warning });
    }
  }
  return results;
}

type MtmBasis = {
  snapshot: any;
  sourceActuals: NormalizedSourceActual[];
};

async function inspectMtmSnapshotBasis(
  tx: MtmTransaction,
  poolId: number,
  snapshot: any,
): Promise<MtmBasis | null> {
  if (snapshot.poolId !== poolId || snapshot.status !== "ok" ||
      snapshot.methodVersion === "mtm-v3-review" || snapshot.runKind === "review") return null;
  let sourceActuals: NormalizedSourceActual[];
  try {
    sourceActuals = await mapSourceActualsForPool(tx, poolId, snapshot);
  } catch {
    return null;
  }
  const [entries, valuations] = await Promise.all([
    tx.select({ entryId: calcuttaEntriesTable.id }).from(calcuttaEntriesTable)
      .where(eq(calcuttaEntriesTable.calcuttaId, poolId)),
    tx.select().from(mtmEntryValuationTable)
      .where(eq(mtmEntryValuationTable.snapshotId, snapshot.id)),
  ]);
  const poolValue = Number((snapshot.stateJson as Record<string, any> | null)?.pot);
  const valid = entries.length === 32 && valuations.length === 32 &&
    new Set(valuations.map((row) => row.entryId)).size === 32 &&
    entries.every((entry) => valuations.some((row) => row.entryId === entry.entryId)) &&
    valuations.every((row) => Number.isFinite(Number(row.expectedPayout)) && Number(row.expectedPayout) >= 0) &&
    Number.isFinite(poolValue) &&
    Math.abs(valuations.reduce((sum, row) => sum + Number(row.expectedPayout), 0) - poolValue) <= 0.01;
  return valid ? { snapshot, sourceActuals } : null;
}

async function inspectMtmBasis(
  tx: MtmTransaction,
  poolId: number,
  version: any,
): Promise<MtmBasis | null> {
  const [snapshot] = await tx.select().from(mtmSnapshotTable)
    .where(eq(mtmSnapshotTable.id, version.sourceSnapshotId)).limit(1);
  const basis = snapshot ? await inspectMtmSnapshotBasis(tx, poolId, snapshot) : null;
  if (!basis) return null;
  const [games, conditionalRows, entries, valuations] = await Promise.all([
    tx.select().from(mtmValuationGameTable).where(eq(mtmValuationGameTable.versionId, version.id)),
    tx.select().from(mtmGameConditionalTable).where(eq(mtmGameConditionalTable.snapshotId, snapshot.id)),
    tx.select({ entryId: calcuttaEntriesTable.id }).from(calcuttaEntriesTable)
      .where(eq(calcuttaEntriesTable.calcuttaId, poolId)),
    tx.select().from(mtmEntryValuationTable).where(eq(mtmEntryValuationTable.snapshotId, snapshot.id)),
  ]);
  const actuals = games.map((game) => ({
    eventId: game.eventId, week: game.week, homeTeamId: game.homeTeamId,
    awayTeamId: game.awayTeamId, homeScore: game.homeScore, awayScore: game.awayScore,
  }));
  const validation = validateCurrentMtmVersion({
    version: {
      ...version,
      markType: version.markType as "official" | "provisional" | "pending_recalculation",
      status: version.status as "candidate" | "current" | "superseded",
      provisionalOutcome: version.provisionalOutcome as Outcome | null,
    },
    sourceSnapshot: snapshot,
    sourceActuals: basis.sourceActuals,
    actuals,
    incorporatedGames: games.filter((game) => game.linkageStatus !== "pending").map((game) => ({
      ...game, eventId: game.eventId,
      linkageStatus: game.linkageStatus as "incorporated" | "pending",
    })),
    pendingGames: games.filter((game) => game.linkageStatus === "pending").map((game) => ({
      ...game, eventId: game.eventId,
      linkageStatus: game.linkageStatus as "incorporated" | "pending",
    })),
    conditionalRows,
    officialValuations: valuations,
    expectedEntryIds: entries.map((entry) => entry.entryId),
    poolValue: Number((snapshot.stateJson as Record<string, any> | null)?.pot),
  });
  return validation.valid ? basis : null;
}

async function reconcileNflPoolCurrentMtm(
  poolId: number,
  seasonId: number,
): Promise<NflMtmReconciliationResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CURRENT_MTM_LOCK_NAMESPACE}, ${poolId})`);
    let [version] = await tx.select().from(mtmValuationVersionTable)
      .where(and(eq(mtmValuationVersionTable.poolId, poolId), eq(mtmValuationVersionTable.status, "current")))
      .orderBy(desc(mtmValuationVersionTable.id)).limit(1);
    let basis = version
      ? await inspectMtmBasis(tx, poolId, version)
      : null;
    if (version && !basis) {
      return { poolId, status: "warning", warning: "Current MTM source/value basis is invalid; no replacement was published." };
    }
    if (!basis) {
      const snapshots = await tx.select().from(mtmSnapshotTable).where(and(
        eq(mtmSnapshotTable.poolId, poolId),
        eq(mtmSnapshotTable.status, "ok"),
      )).orderBy(desc(mtmSnapshotTable.asOf), desc(mtmSnapshotTable.id));
      for (const snapshot of snapshots) {
        const candidate = await inspectMtmSnapshotBasis(tx, poolId, snapshot);
        if (candidate) {
          basis = candidate;
          break;
        }
      }
      if (!basis) return { poolId, status: "skipped", warning: "No valid complete successful source snapshot exists." };
    }
    const snapshot = basis.snapshot;
    const sourceActuals = basis.sourceActuals;
    const events = await tx.select().from(eventsTable).where(and(
      eq(eventsTable.seasonId, seasonId),
      eq(eventsTable.sport, "NFL"),
      eq(eventsTable.competition, "NFL_REGULAR_SEASON"),
      eq(eventsTable.status, "final"),
    ));
    const canonicalFinals = events
      .filter((event) => event.homeScore != null && event.awayScore != null)
      .sort((left, right) => left.id - right.id)
      .map((event) => ({
        eventId: event.id, week: event.week, homeTeamId: event.homeTeamId,
        awayTeamId: event.awayTeamId, homeScore: event.homeScore!, awayScore: event.awayScore!,
      }));
    const classified = classifyCanonicalNflFinals({ sourceActuals, canonicalFinals });
    const incompleteIds = new Set(classified.incompleteSourceEventIds.map(String));
    const incompletePending = sourceActuals.filter((actual) =>
      incompleteIds.has(String(actual.eventId)));
    const pendingGames: LinkageGame[] = [...classified.pending, ...incompletePending].map((actual) => ({
      ...actual, eventId: Number(actual.eventId), linkageStatus: "pending",
    }));
    const provisionalEvent = pendingGames.length === 1 ? pendingGames[0] : null;
    let provisionalOutcome = provisionalEvent
      ? outcomeForScores(Number(provisionalEvent.homeScore), Number(provisionalEvent.awayScore))
      : undefined;
    let conditionalEvidenceValid = false;
    if (provisionalEvent &&
        classified.correctedEventIds.length === 0 &&
        classified.incompleteSourceEventIds.length === 0) {
      const [entries] = await Promise.all([
        tx.select({ entryId: calcuttaEntriesTable.id }).from(calcuttaEntriesTable)
          .where(eq(calcuttaEntriesTable.calcuttaId, poolId)),
      ]);
      const conditionalRows = await tx.select().from(mtmGameConditionalTable).where(and(
        eq(mtmGameConditionalTable.snapshotId, snapshot.id),
        eq(mtmGameConditionalTable.eventId, Number(provisionalEvent.eventId)),
        eq(mtmGameConditionalTable.outcome, provisionalOutcome!),
      ));
      const expectedEntries = new Set(entries.map((entry) => String(entry.entryId)));
      const payoutTotal = conditionalRows.reduce((sum, row) => sum + Number(row.grossConditional), 0);
      const poolValue = Number((snapshot.stateJson as Record<string, any> | null)?.pot);
      conditionalEvidenceValid = conditionalRows.length === 32 &&
        new Set(conditionalRows.map((row) => String(row.entryId))).size === 32 &&
        expectedEntries.size === 32 && [...expectedEntries].every((id) =>
          conditionalRows.some((row) => String(row.entryId) === id)) &&
        conditionalRows.every((row) => ["good", "warning"].includes(row.qualityStatus)) &&
        conditionalRows.every((row) => {
          const payout = Number(row.grossConditional);
          const baseline = Number(row.grossBaseline);
          return Number.isFinite(payout) && payout >= 0 && Number.isFinite(baseline) && baseline >= 0;
        }) && Number.isFinite(poolValue) && Math.abs(payoutTotal - poolValue) <= 0.01;
    }
    const plan = planNflMtmReconciliation({
      postAnchorFinalEventIds: pendingGames.map((game) => Number(game.eventId)),
      conditionalEvidenceValid,
      provisionalOutcome,
    });
    const markType = plan.markType;
    if (classified.incompleteSourceEventIds.length > 0) {
      plan.staleReason = "Canonical final evidence is incomplete; recalculation is required.";
    } else if (classified.correctedEventIds.length > 0) {
      plan.staleReason = "A finalized NFL result was corrected; recalculation is required.";
    }
    provisionalOutcome = plan.provisionalOutcome;
    const actuals = markType === "provisional"
      ? [...classified.incorporated, ...pendingGames]
      : [...classified.incorporated, ...pendingGames];
    const promotion = await promoteCurrentMtmInTransaction(tx, {
      poolId, sourceSnapshotId: snapshot.id, markType,
      provisionalEventId: plan.provisionalEventId,
      provisionalOutcome, pendingGames: markType === "provisional" ? [] : pendingGames,
      actuals,
      actualsAsOf: new Date(Math.max(
        snapshot.actualAnchor?.getTime() ?? snapshot.asOf.getTime(),
        ...events.map((event) => event.updatedAt.getTime()),
      )),
      staleReason: plan.staleReason,
    });
    return {
      poolId,
      status: version && promotion.versionId === version.id ? "unchanged" : "promoted",
      markType,
      versionId: promotion.versionId,
    };
  }, { isolationLevel: "serializable" });
}

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
  poolValue?: number;
}): CurrentMtmResolution {
  if (!args.version) {
    return {
      available: false, versionId: null, sourceSnapshotId: null, markType: null,
      status: null, actualsStateHash: null, provisionalEventId: null, provisionalOutcome: null,
      actualsAsOf: null, mtmAsOf: null, teams: [], owners: [],
      incorporatedGames: [], pendingGames: [], staleReason: "No current coherent MTM version is available.",
    };
  }
  const teamValues = args.teamValues ?? [];
  const poolValue = args.poolValue ??
    teamValues.reduce((sum, team) => sum + team.expectedPayout, 0);
  const officialByEntry = allocateMtmPoolCents(
    teamValues.map((team) => ({ entryId: team.entryId, value: team.expectedPayout })),
    poolValue,
  );
  const currentByEntry = allocateMtmPoolCents(
    teamValues.map((team) => ({
      entryId: team.entryId,
      value: team.currentExpectedPayout ?? team.expectedPayout,
    })),
    poolValue,
  );
  const teams = teamValues.map((team) => ({
    entryId: team.entryId,
    teamId: team.teamId,
    teamName: team.teamName ?? null,
    officialMtm: officialByEntry.get(team.entryId)!,
    currentMtm: currentByEntry.get(team.entryId)!,
    grossExpectedPayout: currentByEntry.get(team.entryId)!,
    auctionPrice: team.auctionPrice ?? null,
    net: team.auctionPrice == null
      ? null
      : currentByEntry.get(team.entryId)! - team.auctionPrice,
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
      signedCostBasis: 0,
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
    owner.signedCostBasis += value.signedCostBasis;
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
    staleReason: args.version.staleReason ??
      (args.version.markType === "pending_recalculation"
        ? "Current MTM version is pending recalculation."
        : null),
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
  try {
    return buildCurrentMtmResolution({
      version,
      sourceSnapshotId: sourceSnapshot.id,
      teamValues,
      poolValue: Number((sourceSnapshot.stateJson as Record<string, any> | null)?.pot),
      games,
      ownership: ownerRows,
    });
  } catch (error) {
    return unavailableResolution(
      version,
      error instanceof Error ? error.message : "Published MTM values could not be reconciled to the auction pool.",
    );
  }
}