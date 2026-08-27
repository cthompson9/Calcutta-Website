import { Router, type IRouter, type Request } from "express";
import { and, eq, asc, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  mtmSnapshotsTable,
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
} from "@workspace/api-zod";
import { loadSeasonOwnership } from "../lib/seasonOwnership";
import { captureKalshiWeekZero } from "../lib/kalshiWeekZero";
import { todayInNewYork } from "../lib/newYorkTime";
import { resolveCalcuttaId } from "../lib/calcuttaContext";
import {
  buildWeekZeroSnapshotRows,
  calculateWeekZeroValuations,
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

function isAdminRequest(req: Request): boolean {
  const adminKey = process.env["ADMIN_API_KEY"];
  if (!adminKey) return false;
  const auth = req.headers["authorization"];
  return auth === `Bearer ${adminKey}`;
}

const router: IRouter = Router();
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

router.get("/mtm", async (req, res): Promise<void> => {
  const parsed = GetMtmSnapshotsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { season } = parsed.data;
  const seasonId = await resolveSeasonId(season);
  if (!seasonId) {
    res.json({ weeks: [], teams: [], owners: [] });
    return;
  }
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId,
    calcuttaId: parsed.data.calcuttaId,
  });
  if (!calcuttaId) {
    res.status(400).json({ error: "Calcutta must be an NFL pool in the requested season." });
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

  res.json({ weeks, teams: teamSeries, owners: ownerSeries });
});

router.post("/mtm", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({
      error: "Unauthorized. This endpoint requires the ADMIN_API_KEY bearer token.",
    });
    return;
  }

  const parsed = UpsertMtmSnapshotBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const seasonId = await resolveSeasonId(data.seasonYear);
  if (!seasonId) {
    res.status(404).json({ error: `Season ${data.seasonYear} not found` });
    return;
  }
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId,
    calcuttaId: data.calcuttaId,
  });
  if (!calcuttaId) {
    res.status(400).json({ error: "Calcutta must be an NFL pool in the requested season." });
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
    res.status(400).json({ error: "Team is not an entry in the selected Calcutta." });
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
    res.status(400).json({ error: "MTM value must be a non-negative number." });
    return;
  }
  if (manualWrite.kind === "not_auctioned") {
    res.status(400).json({
      error: "Team is not auctioned in this season and cannot receive an MTM snapshot.",
    });
    return;
  }
  if (manualWrite.kind === "protected_week_zero") {
    res.status(409).json({
      error:
        "That team/date is the protected Kalshi Week 0 snapshot. Use the Week 0 recapture action instead.",
    });
    return;
  }

  res.json(manualWrite.snapshot);
});

router.post("/mtm/week-zero/capture", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({
      error: "Unauthorized. This endpoint requires the ADMIN_API_KEY bearer token.",
    });
    return;
  }

  const parsed = CaptureWeekZeroMtmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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
    res.status(404).json({ error: `Season ${seasonYear} not found` });
    return;
  }
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId,
    calcuttaId: parsed.data.calcuttaId,
  });
  if (!calcuttaId) {
    res.status(400).json({ error: "Calcutta must be an NFL pool in the requested season." });
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
    res.status(400).json({
      error: `Week 0 requires all 32 NFL teams; found ${teams.length}.`,
    });
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
    res.status(400).json({
      error: `Week 0 requires primary-position bid costs for all 32 selected entries; found ${bidCostByEntry.size}.`,
    });
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
  } catch (error) {
    req.log.error(
      { error: error instanceof Error ? error.message : String(error), seasonYear },
      "Kalshi Week 0 capture failed",
    );
    res.status(502).json({
      error:
        error instanceof Error
          ? error.message
          : "Kalshi Week 0 capture failed.",
    });
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
            eq(snapshotMetricsTable.periodId, period[0].id),
            eq(snapshotMetricsTable.basis, "realized"),
            eq(snapshotMetricsTable.metric, "pt_diff"),
          ),
        );
      const realizedPtDiffByEntry = new Map(
        realizedPtDiffRows.map((row) => [row.entryId, Number(row.value)]),
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
          periodId: period[0].id,
        },
        metricRows,
      );
      return canonicalSnapshotDate;
    });
  } catch (error) {
    if (error instanceof WeekZeroDateCollisionError) {
      res.status(409).json({ error: error.message });
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
  res.json(response);
});

export default router;
