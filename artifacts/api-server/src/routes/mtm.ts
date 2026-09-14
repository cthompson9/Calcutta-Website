import { Router, type IRouter, type Request } from "express";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";
import { and, eq, asc, desc, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  mtmSnapshotsTable,
  mtmSnapshotTable,
  mtmMarketQuoteTable,
  mtmValuationVersionTable,
  mtmCanonicalPeriodSelectionTable,
  seasonsTable,
  calcuttaEntriesTable,
  positionsTable,
  snapshotMetricsTable,
  sportPeriodsTable,
} from "@workspace/db";
import {
  CaptureWeekZeroMtmBody,
  CaptureWeekZeroMtmResponse,
  GetMtmSnapshotsQueryParams,
  UpsertMtmSnapshotBody,
  GetMtmSnapshotsResponse,
  UpsertMtmSnapshotResponse,
  GetMtmPipelineEvidenceQueryParams,
  GetMtmPipelineEvidenceResponse,
  DeleteMtmPipelineAttemptBody,
  DeleteMtmPipelineAttemptParams,
  DeleteMtmPipelineAttemptResponse,
  GetMtmValuationQueryParams,
  GetMtmValuationResponse,
} from "@workspace/api-zod";
import { loadSeasonOwnership } from "../lib/seasonOwnership";
import { captureKalshiWeekZero } from "../lib/kalshiWeekZero";
import { todayInNewYork } from "../lib/newYorkTime";
import { resolveCalcuttaId } from "../lib/calcuttaContext";
import {
  buildWeekZeroSnapshotRows,
  calculateWeekZeroValuations,
  assertCompleteWeekZeroCapture,
  WEEK_ZERO_SNAPSHOT_KEY,
  type MarketQuote,
} from "../lib/weekZeroValuation";
import {
  MTM_SEASON_LOCK_NAMESPACE,
  writeManualMtmSnapshot,
} from "../lib/manualMtm";
import { ensureNflSportPeriods, NFL_SPORT } from "../lib/calcuttaReturns";
import {
  buildMtmMetricRows,
  replaceMtmMetricRows,
} from "../lib/mtmMetrics";
import { requireAdmin } from "../middlewares/requireAdmin";
import {
  getMtmPipelineStatus,
  runMtmPipeline,
  runMtmV3Review,
  withMtmLock,
} from "../lib/mtmPipeline";
import { z } from "zod/v4";
import { getNormalizedMtmValuation } from "../lib/mtmValuation";
import { validateAndPromoteCurrentMtm } from "../lib/currentMtm";
import { runNflStandingsRefresh } from "../lib/nflStandingsRefresh";

const router: IRouter = Router();

router.get("/mtm/valuation", async (req, res): Promise<void> => {
  const parsed = GetMtmValuationQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const result = await getNormalizedMtmValuation(parsed.data);
  sendParsedJson(res, GetMtmValuationResponse, result);
});
class WeekZeroDateCollisionError extends Error {}

interface StoredWeekZeroMarketData {
  contractSetId?: string | null;
  marketStatusReasons?: string[];
  winTotalLine?: number | null;
  winTotalOverProbability?: number | null;
  rawExpectedWins?: number | null;
  expectedWins?: number | null;
  playoffProbability?: number | null;
  divisionalProbability?: number | null;
  conferenceGameProbability?: number | null;
  superBowlProbability?: number | null;
  championshipProbability?: number | null;
  regularSeasonMethod?: string | null;
  intermediateRoundMethod?: string | null;
  quotes?: MarketQuote[];
}

function parseOptionalNumber(value: string | null): number | null {
  return value == null ? null : parseFloat(value);
}

function storedMarketData(value: Record<string, unknown> | null): StoredWeekZeroMarketData {
  return (value ?? {}) as StoredWeekZeroMarketData;
}

async function resolveSeasonId(year: number): Promise<number | null> {
  const rows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, year))
    .limit(1);
  return rows[0]?.id ?? null;
}

const MtmPipelineQuery = z.object({
  season: z.coerce.number().int().min(2000).max(2200),
  calcuttaId: z.coerce.number().int().positive().optional(),
});

const MtmPipelineRecalcBody = z.object({
  season: z.number().int().min(2000).max(2200),
  calcuttaId: z.number().int().positive().optional(),
}).strict();

interface ManualRecalculationState {
  running: boolean;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  currentSnapshotId: number | null;
}

const manualRecalculationByPool = new Map<string, ManualRecalculationState>();

function manualRecalculationKey(input: { season: number; calcuttaId?: number }) {
  return `${input.season}:${input.calcuttaId ?? "default"}`;
}

const MtmV3ReviewBody = z.object({
  season: z.number().int().min(2000).max(2200),
  calcuttaId: z.number().int().positive().optional(),
}).strict();

function pipelineQuoteErrors(
  diagnostics: Record<string, unknown> | null,
  error: string | null,
): string[] {
  const structured = diagnostics?.quoteErrors;
  if (Array.isArray(structured)) {
    return structured.filter((item): item is string => typeof item === "string");
  }
  const prefix = "Kalshi quote collection was incomplete: ";
  return error?.startsWith(prefix)
    ? error.slice(prefix.length).split("; ").filter(Boolean)
    : [];
}

function pipelineQuoteTeam(team: string | null, ticker: string): string | null {
  if (team) return team;
  return /-\d{2}([A-Z]{2,3})-/.exec(ticker)?.[1] ?? null;
}

router.get("/mtm/pipeline/status", async (req, res): Promise<void> => {
  const parsed = MtmPipelineQuery.safeParse(req.query);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const status = await getMtmPipelineStatus(parsed.data.season, parsed.data.calcuttaId);
  res.json({ status });
});

router.get("/mtm/pipeline/evidence", requireAdmin, async (req, res): Promise<void> => {
  const parsed = GetMtmPipelineEvidenceQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }

  const seasonId = await resolveSeasonId(parsed.data.season);
  if (!seasonId) {
    sendParsedJson(res, ErrorResponse, { error: `Season ${parsed.data.season} not found` }, 404);
    return;
  }
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId,
    calcuttaId: parsed.data.calcuttaId,
  });
  if (!calcuttaId) {
    sendParsedJson(res, ErrorResponse, {
      error: "Calcutta must be an NFL pool in the requested season.",
    }, 404);
    return;
  }

  const attemptRows = await db
    .select()
    .from(mtmSnapshotTable)
    .where(eq(mtmSnapshotTable.poolId, calcuttaId))
    .orderBy(desc(mtmSnapshotTable.createdAt));
  const attemptIds = attemptRows.map((attempt) => attempt.id);
  const quoteCountRows = attemptIds.length === 0
    ? []
    : await db
      .select({
        snapshotId: mtmMarketQuoteTable.snapshotId,
        quoteCount: sql<number>`count(*)`,
      })
      .from(mtmMarketQuoteTable)
      .where(inArray(mtmMarketQuoteTable.snapshotId, attemptIds))
      .groupBy(mtmMarketQuoteTable.snapshotId);
  const quoteCountByAttempt = new Map(
    quoteCountRows.map((row) => [row.snapshotId, Number(row.quoteCount)]),
  );
  const currentVersionRows = await db
    .select({ sourceSnapshotId: mtmValuationVersionTable.sourceSnapshotId })
    .from(mtmValuationVersionTable)
    .where(and(
      eq(mtmValuationVersionTable.poolId, calcuttaId),
      eq(mtmValuationVersionTable.status, "current"),
    ));
  const currentSourceIds = new Set(currentVersionRows.map((row) => row.sourceSnapshotId));
  const attempts = attemptRows.map((attempt) => ({
    id: attempt.id,
    status: attempt.status as "ok" | "failed",
    trigger: attempt.trigger as "scheduled" | "manual",
    asOf: attempt.asOf.toISOString(),
    createdAt: attempt.createdAt.toISOString(),
    methodVersion: attempt.methodVersion,
    error: attempt.error,
    quoteCount: quoteCountByAttempt.get(attempt.id) ?? 0,
    deletable: !currentSourceIds.has(attempt.id),
    deleteBlockedReason: currentSourceIds.has(attempt.id)
      ? "This update is the current published MTM mark. Recalculate and promote a replacement before deleting it."
      : null,
  }));

  if (attempts.length === 0) {
    sendParsedJson(res, GetMtmPipelineEvidenceResponse, {
      attempts,
      selectedAttempt: null,
    });
    return;
  }

  const selectedId = parsed.data.attemptId ?? attempts[0]!.id;
  const selectedRow = attemptRows.find((attempt) => attempt.id === selectedId);
  if (!selectedRow) {
    sendParsedJson(res, ErrorResponse, {
      error: "MTM attempt was not found in the selected Calcutta.",
    }, 404);
    return;
  }

  const quoteRows = await db
    .select()
    .from(mtmMarketQuoteTable)
    .where(eq(mtmMarketQuoteTable.snapshotId, selectedId))
    .orderBy(
      asc(mtmMarketQuoteTable.series),
      asc(mtmMarketQuoteTable.team),
      asc(mtmMarketQuoteTable.marketTicker),
    );
  const receivedBySeries = new Map<string, { quoteCount: number; teams: Set<string> }>();
  for (const quote of quoteRows) {
    const received = receivedBySeries.get(quote.series) ?? {
      quoteCount: 0,
      teams: new Set<string>(),
    };
    received.quoteCount += 1;
    const team = pipelineQuoteTeam(quote.team, quote.marketTicker);
    if (team) received.teams.add(team);
    receivedBySeries.set(quote.series, received);
  }

  const selectedAttempt = {
    ...attempts.find((attempt) => attempt.id === selectedId)!,
    diagnostics: selectedRow.diagnostics,
    receivedMarkets: [...receivedBySeries.entries()].map(([series, received]) => ({
      series,
      quoteCount: received.quoteCount,
      teams: [...received.teams].sort(),
    })),
    failedSources: pipelineQuoteErrors(selectedRow.diagnostics, selectedRow.error),
    quotes: quoteRows.map((quote) => ({
      source: quote.source,
      series: quote.series,
      ticker: quote.marketTicker,
      team: pipelineQuoteTeam(quote.team, quote.marketTicker),
      bid: parseOptionalNumber(quote.yesBid),
      ask: parseOptionalNumber(quote.yesAsk),
      strike: parseOptionalNumber(quote.strike),
      volume: quote.volume,
      fetchedAt: quote.fetchedAt.toISOString(),
    })),
  };
  sendParsedJson(res, GetMtmPipelineEvidenceResponse, {
    attempts,
    selectedAttempt,
  });
});

router.delete("/mtm/pipeline/attempts/:attemptId", requireAdmin, async (req, res): Promise<void> => {
  const parsedParams = DeleteMtmPipelineAttemptParams.safeParse(req.params);
  const parsedBody = DeleteMtmPipelineAttemptBody.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    sendParsedJson(res, ErrorResponse, {
      error: !parsedParams.success
        ? parsedParams.error.message
        : !parsedBody.success
          ? parsedBody.error.message
          : "Invalid MTM update deletion request.",
    }, 400);
    return;
  }

  const seasonId = await resolveSeasonId(parsedBody.data.season);
  if (!seasonId) {
    sendParsedJson(res, ErrorResponse, {
      error: `Season ${parsedBody.data.season} not found`,
    }, 404);
    return;
  }
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId,
    calcuttaId: parsedBody.data.calcuttaId,
  });
  if (!calcuttaId || calcuttaId !== parsedBody.data.calcuttaId) {
    sendParsedJson(res, ErrorResponse, {
      error: "Calcutta must be an NFL pool in the requested season.",
    }, 404);
    return;
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.mtm_attempt_delete', 'on', true)`);
    const [attempt] = await tx
      .select({ id: mtmSnapshotTable.id })
      .from(mtmSnapshotTable)
      .where(and(
        eq(mtmSnapshotTable.id, parsedParams.data.attemptId),
        eq(mtmSnapshotTable.poolId, calcuttaId),
      ))
      .for("update");
    if (!attempt) return { kind: "not_found" as const };

    const currentVersions = await tx
      .select({ id: mtmValuationVersionTable.id })
      .from(mtmValuationVersionTable)
      .where(and(
        eq(mtmValuationVersionTable.sourceSnapshotId, attempt.id),
        eq(mtmValuationVersionTable.status, "current"),
      ))
      .for("update");
    if (currentVersions.length > 0) return { kind: "current" as const };

    const deletedSelections = await tx
      .delete(mtmCanonicalPeriodSelectionTable)
      .where(and(
        eq(mtmCanonicalPeriodSelectionTable.poolId, calcuttaId),
        eq(mtmCanonicalPeriodSelectionTable.snapshotId, attempt.id),
      ))
      .returning({ id: mtmCanonicalPeriodSelectionTable.id });
    const deletedVersions = await tx
      .delete(mtmValuationVersionTable)
      .where(and(
        eq(mtmValuationVersionTable.poolId, calcuttaId),
        eq(mtmValuationVersionTable.sourceSnapshotId, attempt.id),
        ne(mtmValuationVersionTable.status, "current"),
      ))
      .returning({ id: mtmValuationVersionTable.id });
    const deletedAttempts = await tx
      .delete(mtmSnapshotTable)
      .where(and(
        eq(mtmSnapshotTable.id, attempt.id),
        eq(mtmSnapshotTable.poolId, calcuttaId),
      ))
      .returning({ id: mtmSnapshotTable.id });
    if (deletedAttempts.length !== 1) {
      throw new Error("MTM update deletion did not remove exactly one update.");
    }
    return {
      kind: "deleted" as const,
      deletedAttemptId: attempt.id,
      deletedVersionCount: deletedVersions.length,
      deletedPeriodSelectionCount: deletedSelections.length,
    };
  });

  if (result.kind === "not_found") {
    sendParsedJson(res, ErrorResponse, {
      error: "MTM update was not found in the selected Calcutta.",
    }, 404);
    return;
  }
  if (result.kind === "current") {
    sendParsedJson(res, ErrorResponse, {
      error: "The current published MTM mark cannot be deleted. Recalculate and promote a replacement first.",
    }, 409);
    return;
  }
  req.log.info({
    calcuttaId,
    attemptId: result.deletedAttemptId,
    deletedVersionCount: result.deletedVersionCount,
    deletedPeriodSelectionCount: result.deletedPeriodSelectionCount,
  }, "Deleted non-current MTM update");
  sendParsedJson(res, DeleteMtmPipelineAttemptResponse, result);
});

router.get("/mtm/pipeline/recalc/status", requireAdmin, (req, res): void => {
  const parsed = MtmPipelineQuery.safeParse(req.query);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const state = manualRecalculationByPool.get(manualRecalculationKey(parsed.data));
  res.json(state ?? {
    running: false,
    startedAt: null,
    completedAt: null,
    error: null,
    currentSnapshotId: null,
  });
});

router.post("/mtm/pipeline/recalc", requireAdmin, async (req, res): Promise<void> => {
  const parsed = MtmPipelineRecalcBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const key = manualRecalculationKey(parsed.data);
  if (manualRecalculationByPool.get(key)?.running) {
    sendParsedJson(res, ErrorResponse, { error: "An MTM calculation is already running." }, 409);
    return;
  }
  const state: ManualRecalculationState = {
    running: true,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    currentSnapshotId: null,
  };
  manualRecalculationByPool.set(key, state);
  res.status(202).json(state);

  setImmediate(() => {
    void (async () => {
      try {
        const locked = await withMtmLock({
          seasonYear: parsed.data.season,
          calcuttaId: parsed.data.calcuttaId,
        }, async (lease) => {
          const current = await getMtmPipelineStatus(parsed.data.season, parsed.data.calcuttaId);
          if (current && Date.now() - Date.parse(current.asOf) < 5 * 60 * 1000) {
            throw new Error("An MTM calculation has already been requested in the last five minutes.");
          }
          await runNflStandingsRefresh({
            seasonYear: parsed.data.season,
            requestedBy: "admin_mtm_recalculation",
          });
          const result = await runMtmPipeline({
            seasonYear: parsed.data.season,
            calcuttaId: parsed.data.calcuttaId,
            trigger: "manual",
            lease,
          });
          if (result.status !== "ok" || result.currentSnapshotId == null) {
            throw new Error(result.error ?? "MTM recalculation failed.");
          }
          await lease.assertOwned();
          await validateAndPromoteCurrentMtm({
            poolId: result.poolId,
            sourceSnapshotId: result.currentSnapshotId,
            markType: "official",
            lease: {
              runId: lease.runId,
              ownerToken: lease.ownerToken,
            },
          });
          return result.currentSnapshotId;
        });
        if (!locked.acquired) {
          throw new Error("An MTM calculation is already running.");
        }
        state.currentSnapshotId = locked.value;
      } catch (error) {
        state.error = error instanceof Error
          ? error.message
          : "Full recalculation failed unexpectedly.";
      } finally {
        state.running = false;
        state.completedAt = new Date().toISOString();
      }
    })();
  });
});

/**
 * Run the v3 engine as an explicitly noncanonical review.  This endpoint
 * intentionally stores every attempt as status=failed: the existing snapshot
 * status is consumed by Live Tracker/Results and must never publish a review.
 */
router.post("/mtm/pipeline/review", requireAdmin, async (req, res): Promise<void> => {
  const parsed = MtmV3ReviewBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const locked = await withMtmLock(
    { seasonYear: parsed.data.season, calcuttaId: parsed.data.calcuttaId },
    async (lease) => {
      const result = await runMtmV3Review({
        seasonYear: parsed.data.season,
        calcuttaId: parsed.data.calcuttaId,
      });
      await lease.assertOwned();
      return result;
    },
  );
  if (!locked.acquired) {
    sendParsedJson(res, ErrorResponse, { error: "An MTM calculation is already running." }, 409);
    return;
  }
  res.status(locked.value.error ? 502 : 200).json(locked.value);
});

router.get("/mtm", async (req, res): Promise<void> => {
  const parsed = GetMtmSnapshotsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const { season } = parsed.data;
  const seasonId = await resolveSeasonId(season);
  if (!seasonId) {
    sendParsedJson(res, GetMtmSnapshotsResponse, { weeks: [], teams: [], owners: [] });
    return;
  }
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId,
    calcuttaId: parsed.data.calcuttaId,
  });
  if (!calcuttaId) {
    sendParsedJson(res, ErrorResponse, { error: "Calcutta must be an NFL pool in the requested season." }, 400);
    return;
  }
  const entryRows = await db
    .select({
      entryId: calcuttaEntriesTable.id,
      teamId: calcuttaEntriesTable.teamId,
    })
    .from(calcuttaEntriesTable)
    .where(eq(calcuttaEntriesTable.calcuttaId, calcuttaId));
  const entryIds = entryRows.map((entry) => entry.entryId);

  // Fetch only snapshots belonging to the selected Calcutta entries.
  const snapshotsRaw = await db
    .select()
    .from(mtmSnapshotsTable)
    .where(inArray(mtmSnapshotsTable.entryId, entryIds))
    .orderBy(asc(mtmSnapshotsTable.snapshotDate), asc(mtmSnapshotsTable.teamId));

  // Fetch team info
  const teams = await db.select().from(teamsTable);
  const teamMap = new Map(teams.map((t) => [t.id, t]));

  // Effective ownership (applies approved trades)
  const ownership = await loadSeasonOwnership(seasonId, calcuttaId);

  // Get unique dates sorted chronologically
  const dates = [...new Set(snapshotsRaw.map((s) => s.snapshotDate))].sort();

  // Build team series: teamId → date → mtmValue
  const teamSnapshotMap = new Map<number, Map<string, number>>();
  for (const s of snapshotsRaw) {
    if (!teamSnapshotMap.has(s.teamId)) teamSnapshotMap.set(s.teamId, new Map());
    teamSnapshotMap.get(s.teamId)!.set(s.snapshotDate, parseFloat(s.mtmValue));
  }

  const teamSeries = teams
    .filter((t) => teamSnapshotMap.has(t.id))
    .map((t) => {
      // Use effective current owners
      const currentOwners = ownership.currentOwnersByTeam.get(t.id) ?? [];
      const ownerName =
        currentOwners.length === 0
          ? "Unknown"
          : currentOwners.length === 1
            ? currentOwners[0].bidderName
            : currentOwners.map((o) => o.bidderName).join(" / ");
      return {
        teamId: t.id,
        teamName: t.name,
        conference: t.conference,
        ownerName,
        weeklyValues: dates.map((d) => teamSnapshotMap.get(t.id)?.get(d) ?? 0),
      };
    });

  // Build owner series using effective ownership (participants who have > 0 share somewhere)
  // Collect all owner names from currentOwnersByTeam entries for teams that have snapshots
  const ownerNamesSet = new Set<string>();
  for (const [teamId] of teamSnapshotMap) {
    const currentOwners = ownership.currentOwnersByTeam.get(teamId) ?? [];
    for (const o of currentOwners) ownerNamesSet.add(o.bidderName);
  }
  const ownerNames = Array.from(ownerNamesSet).sort();

  // Build a name → bidderId map for efficient lookup
  const nameToBidderId = new Map<string, number>();
  for (const [bidderId, name] of ownership.bidderNames) {
    nameToBidderId.set(name, bidderId);
  }

  const ownerSeries = ownerNames.map((ownerName) => {
    const bidderId = nameToBidderId.get(ownerName);
    const weeklyTotals = dates.map((d) => {
      let total = 0;
      for (const t of teams) {
        const currentOwners = ownership.currentOwnersByTeam.get(t.id) ?? [];
        const ownerEntry = bidderId != null
          ? currentOwners.find((o) => o.bidderId === bidderId)
          : currentOwners.find((o) => o.bidderName === ownerName);
        if (!ownerEntry) continue;
        const mtmVal = teamSnapshotMap.get(t.id)?.get(d) ?? 0;
        total += mtmVal * ownerEntry.ownershipShare;
      }
      return Math.round(total * 100) / 100;
    });
    return { bidderName: ownerName, weeklyTotals };
  });

  // Build per-date week data
  const weeks = dates.map((date) => {
    const snapsForDate = snapshotsRaw.filter((s) => s.snapshotDate === date);
    const weekNum = snapsForDate[0]?.weekNum ?? null;
    const source = snapsForDate[0]?.source ?? "manual";
    const capturedAt = snapsForDate[0]?.capturedAt?.toISOString() ?? null;
    const label =
      weekNum === 0
        ? "Week 0"
        : weekNum != null
          ? weekNum <= 18
            ? `Week ${weekNum}`
            : `Playoff Week ${weekNum - 18}`
          : date;

    const marketStatusCounts = {
      live: 0,
      stale: 0,
      incomplete: 0,
      manual: 0,
    };
    for (const snapshot of snapsForDate) {
      const status =
        snapshot.marketStatus === "live" ||
        snapshot.marketStatus === "stale" ||
        snapshot.marketStatus === "incomplete"
          ? snapshot.marketStatus
          : "manual";
      marketStatusCounts[status] += 1;
    }

    const ownerTotals = ownerNames.map((ownerName) => {
      const bidderId = nameToBidderId.get(ownerName);
      let total = 0;
      for (const s of snapsForDate) {
        const currentOwners = ownership.currentOwnersByTeam.get(s.teamId) ?? [];
        const ownerEntry = bidderId != null
          ? currentOwners.find((o) => o.bidderId === bidderId)
          : currentOwners.find((o) => o.bidderName === ownerName);
        if (!ownerEntry) continue;
        total += parseFloat(s.mtmValue) * ownerEntry.ownershipShare;
      }
      return { bidderName: ownerName, mtmTotal: Math.round(total * 100) / 100 };
    });

    const teamValues = snapsForDate.map((s) => {
      const t = teamMap.get(s.teamId);
      const marketData = storedMarketData(s.marketData);
      const currentOwners = ownership.currentOwnersByTeam.get(s.teamId) ?? [];
      const primaryOwner =
        currentOwners.length === 0
          ? "Unknown"
          : currentOwners.length === 1
            ? currentOwners[0].bidderName
            : currentOwners.map((o) => o.bidderName).join(" / ");
      return {
        teamId: s.teamId,
        teamName: t?.name ?? "Unknown",
        ownerName: primaryOwner,
        mtmValue: parseFloat(s.mtmValue),
        source: s.source,
        capturedAt: s.capturedAt?.toISOString() ?? null,
        marketStatus:
          s.marketStatus === "live" ||
          s.marketStatus === "stale" ||
          s.marketStatus === "incomplete"
            ? s.marketStatus
            : "manual",
        bankedPoints: parseOptionalNumber(s.bankedPoints),
        seasonEquityPoints: parseOptionalNumber(s.seasonEquityPoints),
        bonusEquityPoints: parseOptionalNumber(s.bonusEquityPoints),
        totalPoints: parseOptionalNumber(s.totalPoints),
        normalizedShare: parseOptionalNumber(s.normalizedShare),
        contractSetId: marketData.contractSetId ?? null,
        marketStatusReasons: marketData.marketStatusReasons ?? [],
        winTotalLine: marketData.winTotalLine ?? null,
        winTotalOverProbability: marketData.winTotalOverProbability ?? null,
        rawExpectedWins: marketData.rawExpectedWins ?? null,
        expectedWins: marketData.expectedWins ?? null,
        playoffProbability: marketData.playoffProbability ?? null,
        divisionalProbability: marketData.divisionalProbability ?? null,
        conferenceGameProbability: marketData.conferenceGameProbability ?? null,
        superBowlProbability: marketData.superBowlProbability ?? null,
        championshipProbability: marketData.championshipProbability ?? null,
        regularSeasonMethod: marketData.regularSeasonMethod ?? null,
        intermediateRoundMethod: marketData.intermediateRoundMethod ?? null,
        marketQuotes: marketData.quotes ?? [],
      };
    });

    return {
      snapshotDate: date,
      weekNum,
      label,
      source,
      capturedAt,
      potSize: Math.round(
        snapsForDate.reduce((total, snapshot) => total + parseFloat(snapshot.mtmValue), 0) *
          100,
      ) / 100,
      rawPointTotal: snapsForDate.reduce(
        (total, snapshot) => total + (parseOptionalNumber(snapshot.totalPoints) ?? 0),
        0,
      ),
      normalizedShareTotal: snapsForDate.reduce(
        (total, snapshot) => total + (parseOptionalNumber(snapshot.normalizedShare) ?? 0),
        0,
      ),
      marketStatusCounts,
      ownerTotals,
      teamValues,
    };
  });

  sendParsedJson(res, GetMtmSnapshotsResponse, { weeks, teams: teamSeries, owners: ownerSeries });
});

router.post("/mtm", requireAdmin, async (req, res): Promise<void> => {

  const parsed = UpsertMtmSnapshotBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const data = parsed.data;
  const seasonId = await resolveSeasonId(data.seasonYear);
  if (!seasonId) {
    sendParsedJson(res, ErrorResponse, { error: `Season ${data.seasonYear} not found` }, 404);
    return;
  }
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId,
    calcuttaId: data.calcuttaId,
  });
  if (!calcuttaId) {
    sendParsedJson(res, ErrorResponse, { error: "Calcutta must be an NFL pool in the requested season." }, 400);
    return;
  }
  const entry = await db
    .select({ id: calcuttaEntriesTable.id })
    .from(calcuttaEntriesTable)
    .where(and(
      eq(calcuttaEntriesTable.calcuttaId, calcuttaId),
      eq(calcuttaEntriesTable.teamId, data.teamId),
    ))
    .limit(1);
  if (!entry[0]) {
    sendParsedJson(res, ErrorResponse, { error: "Team is not an entry in the selected Calcutta." }, 400);
    return;
  }

  const today = todayInNewYork();
  const snapshotDate = data.snapshotDate ?? today;

  const manualWrite = await writeManualMtmSnapshot({
    seasonId,
    calcuttaId,
    teamId: data.teamId,
    snapshotDate,
    mtmValue: data.mtmValue,
    weekNum: data.weekNum,
  });
  if (manualWrite.kind === "invalid_value") {
    sendParsedJson(res, ErrorResponse, { error: "MTM value must be a non-negative number." }, 400);
    return;
  }
  if (manualWrite.kind === "not_auctioned") {
    sendParsedJson(res, ErrorResponse, {
      error: "Team is not auctioned in this season and cannot receive an MTM snapshot.",
    }, 400);
    return;
  }
  if (manualWrite.kind === "protected_week_zero") {
    sendParsedJson(res, ErrorResponse, {
      error:
        "That team/date is the protected Kalshi Week 0 snapshot. Use the Week 0 recapture action instead.",
    }, 409);
    return;
  }

  sendParsedJson(res, UpsertMtmSnapshotResponse, {
    ...manualWrite.snapshot,
    mtmValue: Number(manualWrite.snapshot.mtmValue),
    capturedAt: manualWrite.snapshot.capturedAt?.toISOString() ?? null,
  });
});

router.post("/mtm/week-zero/capture", requireAdmin, async (req, res): Promise<void> => {

  const parsed = CaptureWeekZeroMtmBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }

  const { seasonYear } = parsed.data;
  const seasonRows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, seasonYear))
    .limit(1);
  const seasonId = seasonRows[0]?.id;
  if (!seasonId) {
    sendParsedJson(res, ErrorResponse, { error: `Season ${seasonYear} not found` }, 404);
    return;
  }
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId,
    calcuttaId: parsed.data.calcuttaId,
  });
  if (!calcuttaId) {
    sendParsedJson(res, ErrorResponse, { error: "Calcutta must be an NFL pool in the requested season." }, 400);
    return;
  }

  const teams = await db
    .select({
      entryId: calcuttaEntriesTable.id,
      id: teamsTable.id,
      name: teamsTable.name,
      conference: teamsTable.conference,
    })
    .from(teamsTable)
    .innerJoin(
      calcuttaEntriesTable,
      eq(calcuttaEntriesTable.teamId, teamsTable.id),
    )
    .where(eq(calcuttaEntriesTable.calcuttaId, calcuttaId))
    .orderBy(asc(teamsTable.id));
  if (teams.length !== 32) {
    sendParsedJson(res, ErrorResponse, {
      error: `Week 0 requires all 32 NFL teams; found ${teams.length}.`,
    }, 400);
    return;
  }
  const entryIdByTeam = new Map(teams.map((team) => [team.id, team.entryId]));

  const capturedAt = new Date();
  const requestedSnapshotDate =
    parsed.data.snapshotDate ?? todayInNewYork(capturedAt);

  const primaryPositionRows = await db
    .select({
      entryId: positionsTable.entryId,
      costBasis: positionsTable.costBasis,
    })
    .from(positionsTable)
    .where(and(
      inArray(positionsTable.entryId, [...entryIdByTeam.values()]),
      eq(positionsTable.source, "primary"),
    ));
  const bidCostByEntry = new Map<number, number>();
  for (const position of primaryPositionRows) {
    bidCostByEntry.set(
      position.entryId,
      (bidCostByEntry.get(position.entryId) ?? 0) + Number(position.costBasis),
    );
  }
  if (bidCostByEntry.size !== 32) {
    sendParsedJson(res, ErrorResponse, {
      error: `Week 0 requires primary-position bid costs for all 32 selected entries; found ${bidCostByEntry.size}.`,
    }, 400);
    return;
  }
  const potSize = [...bidCostByEntry.values()].reduce((total, cost) => total + cost, 0);

  let calculation;
  try {
    const marketSnapshots = await captureKalshiWeekZero({
      seasonYear,
      teams,
    });
    calculation = calculateWeekZeroValuations(
      marketSnapshots,
      potSize,
      capturedAt,
    );
    // The calculator deliberately interpolates missing contracts for diagnostic
    // display. Validate the original market coverage before opening any write
    // transaction so a partial capture cannot replace prior-good rows. Complete
    // stale captures remain publishable with their warning metadata.
    assertCompleteWeekZeroCapture(calculation);
  } catch (error) {
    req.log.error(
      { error: error instanceof Error ? error.message : String(error), seasonYear },
      "Kalshi Week 0 capture failed",
    );
    sendParsedJson(res, ErrorResponse, {
      error:
        error instanceof Error
          ? error.message
          : "Kalshi Week 0 capture failed.",
    }, 502);
    return;
  }

  let snapshotDate: string;
  try {
    snapshotDate = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${MTM_SEASON_LOCK_NAMESPACE}, ${calcuttaId})`,
      );
      const existingWeekZero = await tx
        .select({ snapshotDate: mtmSnapshotsTable.snapshotDate })
        .from(mtmSnapshotsTable)
        .where(
          and(
            inArray(mtmSnapshotsTable.entryId, [...entryIdByTeam.values()]),
            eq(mtmSnapshotsTable.snapshotKey, WEEK_ZERO_SNAPSHOT_KEY),
          ),
        )
        .limit(1);
      const canonicalSnapshotDate =
        existingWeekZero[0]?.snapshotDate ?? requestedSnapshotDate;

      if (existingWeekZero.length === 0) {
        const dateCollision = await tx
          .select({ id: mtmSnapshotsTable.id })
          .from(mtmSnapshotsTable)
          .where(
            and(
              inArray(mtmSnapshotsTable.entryId, [...entryIdByTeam.values()]),
              eq(mtmSnapshotsTable.snapshotDate, canonicalSnapshotDate),
              or(
                isNull(mtmSnapshotsTable.snapshotKey),
                ne(mtmSnapshotsTable.snapshotKey, WEEK_ZERO_SNAPSHOT_KEY),
              ),
            ),
          )
          .limit(1);
        if (dateCollision.length > 0) {
          throw new WeekZeroDateCollisionError(
            "That date already contains manual MTM data. Choose another Week 0 date.",
          );
        }
      }

      await ensureNflSportPeriods(tx);
      const period = await tx
        .select({ id: sportPeriodsTable.id })
        .from(sportPeriodsTable)
        .where(
          and(
            eq(sportPeriodsTable.sport, NFL_SPORT),
            eq(sportPeriodsTable.competition, "NFL_REGULAR_SEASON"),
            eq(sportPeriodsTable.sequence, 0),
          ),
        )
        .limit(1);
      if (!period[0]) throw new Error("NFL Week 0 period was not seeded.");

      const realizedPtDiffRows = await tx
        .select({
          entryId: snapshotMetricsTable.entryId,
          value: snapshotMetricsTable.value,
        })
        .from(snapshotMetricsTable)
        .where(
          and(
            inArray(snapshotMetricsTable.entryId, [...entryIdByTeam.values()]),
            eq(snapshotMetricsTable.calcuttaId, calcuttaId),
            eq(snapshotMetricsTable.periodId, period[0].id),
            eq(snapshotMetricsTable.basis, "realized"),
            eq(snapshotMetricsTable.metric, "pt_diff"),
          ),
        );
      const realizedPtDiffByEntry = new Map(
        realizedPtDiffRows.flatMap((row) =>
          row.entryId == null ? [] : [[row.entryId, Number(row.value)] as const],
        ),
      );

      const snapshotRows = buildWeekZeroSnapshotRows(calculation, {
        seasonId,
        entryIdByTeam,
        snapshotDate: canonicalSnapshotDate,
        capturedAt,
      });
      for (const values of snapshotRows) {
        await tx
          .insert(mtmSnapshotsTable)
          .values(values)
          .onConflictDoUpdate({
            target: [
              mtmSnapshotsTable.entryId,
              mtmSnapshotsTable.snapshotKey,
            ],
            targetWhere: sql`${mtmSnapshotsTable.snapshotKey} IS NOT NULL`,
            set: values,
          });
      }
      const metricRows = buildMtmMetricRows(calculation, {
        periodId: period[0].id,
        calcuttaId,
        periodSequence: 0,
        snapshotKey: WEEK_ZERO_SNAPSHOT_KEY,
        snapshotDate: canonicalSnapshotDate,
        capturedAt,
        entryIdByTeam,
        realizedPtDiffByEntry,
      });
      await replaceMtmMetricRows(
        tx,
        {
          entryIds: [...entryIdByTeam.values()],
          calcuttaId,
          periodId: period[0].id,
        },
        metricRows,
      );
      return canonicalSnapshotDate;
    });
  } catch (error) {
    if (error instanceof WeekZeroDateCollisionError) {
      sendParsedJson(res, ErrorResponse, { error: error.message }, 409);
      return;
    }
    throw error;
  }

  req.log.info(
    {
      seasonYear,
      snapshotDate,
      teamCount: calculation.valuations.length,
      statusCounts: calculation.statusCounts,
    },
    "Captured Kalshi Week 0 valuation",
  );

  const response = CaptureWeekZeroMtmResponse.parse({
    seasonYear,
    snapshotDate,
    capturedAt: capturedAt.toISOString(),
    teamCount: calculation.valuations.length,
    contractSetId: calculation.valuations[0]?.contractSetId ?? "unknown",
    potSize: Math.round(potSize * 100) / 100,
    rawPointTotal: calculation.rawPointTotal,
    normalizedShareTotal: calculation.normalizedShareTotal,
    marketStatusCounts: {
      ...calculation.statusCounts,
      manual: 0,
    },
  });
  sendParsedJson(res, CaptureWeekZeroMtmResponse, response);
});

export default router;
