import { Router, type IRouter, type Request } from "express";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import {
  GetPayoutRulesQueryParams,
  GetSportPeriodsQueryParams,
  InitializeWeekZeroPointsBody,
  InitializeWeekZeroPointsResponse,
  ReplacePayoutRulesBody,
  UpsertTeamPeriodSnapshotBody,
  UpsertTeamPeriodSnapshotResponse,
} from "@workspace/api-zod";
import {
  calcuttaEntriesTable,
  calcuttaRulesTable,
  calcuttasTable,
  db,
  nflGamesTable,
  payoutRulesTable,
  positionsTable,
  seasonsTable,
  sportPeriodsTable,
  teamPeriodSnapshotsTable,
  teamSeasonAuctionsTable,
  teamResultsTable,
} from "@workspace/db";
import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "../lib/ownershipShares";
import {
  NFL_PERIOD_TEMPLATE,
  NFL_MARQUEE_MULTIPLIER,
  NFL_SPORT,
  aggregateNflRegularSeasonGames,
  auditStoredEntryReturnDiscrepancies,
  compareHistoricalPayoutParity,
  ensureCompetitionSportPeriods,
  ensureNflSportPeriods,
  hasCompleteNormalizedSnapshot,
  initializeNflWeekZeroSnapshots,
  loadCalculatedTeamReturnsForCalcutta,
  normalizeNflGame,
  type NormalizedSnapshotWrite,
  upsertNormalizedSnapshotMetrics,
} from "../lib/calcuttaReturns";
import { resolveCalcuttaId } from "../lib/calcuttaContext";
import {
  configureCompetitionScoringAdapter,
  getCompetitionScoringAdapter,
  validateCompetitionScoringRules,
} from "../lib/competitionScoring";

const router: IRouter = Router();

async function rebuildNflRealizedSnapshots(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  seasonId: number,
  periodSequence: number,
): Promise<number> {
  const entries = await tx
    .selectDistinct({
      entryId: calcuttaEntriesTable.id,
      teamId: calcuttaEntriesTable.teamId,
      calcuttaId: calcuttaEntriesTable.calcuttaId,
    })
    .from(calcuttaEntriesTable)
    .innerJoin(calcuttasTable, eq(calcuttasTable.id, calcuttaEntriesTable.calcuttaId))
    .innerJoin(positionsTable, and(
      eq(positionsTable.entryId, calcuttaEntriesTable.id),
      eq(positionsTable.source, "primary"),
    ))
    .where(and(
      eq(calcuttasTable.seasonId, seasonId),
      eq(calcuttasTable.sport, NFL_SPORT),
    ));
  const entriesByCalcutta = new Map<number, typeof entries>();
  for (const entry of entries) {
    const poolEntries = entriesByCalcutta.get(entry.calcuttaId) ?? [];
    poolEntries.push(entry);
    entriesByCalcutta.set(entry.calcuttaId, poolEntries);
  }

  let snapshotsWritten = 0;
  for (const [calcuttaId, poolEntries] of entriesByCalcutta) {
    await initializeNflWeekZeroSnapshots(tx, { calcuttaId });
    const priorPeriods = await tx
      .select({ sequence: sportPeriodsTable.sequence })
      .from(teamPeriodSnapshotsTable)
      .innerJoin(calcuttaEntriesTable, eq(calcuttaEntriesTable.id, teamPeriodSnapshotsTable.entryId))
      .innerJoin(sportPeriodsTable, eq(sportPeriodsTable.id, teamPeriodSnapshotsTable.periodId))
      .where(and(
        eq(calcuttaEntriesTable.calcuttaId, calcuttaId),
        eq(teamPeriodSnapshotsTable.basis, "realized"),
        eq(sportPeriodsTable.sport, NFL_SPORT),
        eq(sportPeriodsTable.competition, "NFL_REGULAR_SEASON"),
        gte(sportPeriodsTable.sequence, periodSequence),
        lte(sportPeriodsTable.sequence, 18),
      ));
    const sequences = [...new Set([
      periodSequence,
      ...priorPeriods.map((row) => row.sequence),
    ])].sort((a, b) => a - b);

    for (const sequence of sequences) {
      const rows = await tx.select().from(nflGamesTable).where(and(
        eq(nflGamesTable.seasonId, seasonId),
        eq(nflGamesTable.round, "regular"),
        eq(nflGamesTable.status, "final"),
        lte(nflGamesTable.periodSequence, sequence),
      ));
      const aggregate = aggregateNflRegularSeasonGames(rows.map((row) => ({
        seasonId: row.seasonId, source: row.source, sourceGameId: row.sourceGameId,
        periodSequence: row.periodSequence, round: row.round, homeTeamId: row.homeTeamId,
        awayTeamId: row.awayTeamId, homeScore: row.homeScore, awayScore: row.awayScore,
        actualKickoffAt: row.actualKickoffAt, status: row.status, sourceData: row.sourceData,
      })));
      const period = await tx.select({ id: sportPeriodsTable.id }).from(sportPeriodsTable)
        .where(and(
          eq(sportPeriodsTable.sport, NFL_SPORT),
          eq(sportPeriodsTable.competition, "NFL_REGULAR_SEASON"),
          eq(sportPeriodsTable.sequence, sequence),
        )).limit(1);
      if (!period[0]) throw new Error("NFL period was not seeded.");
      for (const entry of poolEntries) {
        const stats = aggregate.get(entry.teamId) ?? {
          wins: 0, losses: 0, ties: 0, ordinaryWins: 0, marqueeWins: 0,
          ordinaryTies: 0, marqueeTies: 0, ordinaryPtDiff: 0, marqueePtDiff: 0,
        };
        const snapshot = {
          entryId: entry.entryId, periodId: period[0].id, basis: "realized" as const,
          wins: String(stats.wins), losses: String(stats.losses), ties: String(stats.ties),
          ptDiff: String(stats.ordinaryPtDiff + NFL_MARQUEE_MULTIPLIER * stats.marqueePtDiff),
          ordinaryWins: String(stats.ordinaryWins), marqueeWins: String(stats.marqueeWins),
          ordinaryTies: String(stats.ordinaryTies), marqueeTies: String(stats.marqueeTies),
          ordinaryPtDiff: String(stats.ordinaryPtDiff), marqueePtDiff: String(stats.marqueePtDiff),
          playoffBerth: "0", divRound: "0", confRound: "0", sbBerth: "0", winSuperBowl: "0",
          playoffStatus: "unknown" as const, capturedAt: new Date(),
        };
        await tx.insert(teamPeriodSnapshotsTable).values(snapshot).onConflictDoUpdate({
          target: [teamPeriodSnapshotsTable.entryId, teamPeriodSnapshotsTable.periodId, teamPeriodSnapshotsTable.basis],
          set: snapshot,
        });
        await upsertNormalizedSnapshotMetrics(tx, {
          calcuttaId,
          entryId: entry.entryId,
          periodId: period[0].id,
          basis: "realized",
          snapshot: {
            wins: stats.wins,
            losses: stats.losses,
            ties: stats.ties,
            ptDiff: stats.ordinaryPtDiff +
              NFL_MARQUEE_MULTIPLIER * stats.marqueePtDiff,
            ordinaryWins: stats.ordinaryWins,
            marqueeWins: stats.marqueeWins,
            ordinaryTies: stats.ordinaryTies,
            marqueeTies: stats.marqueeTies,
            ordinaryPtDiff: stats.ordinaryPtDiff,
            marqueePtDiff: stats.marqueePtDiff,
            playoffBerth: 0,
            divRound: 0,
            confRound: 0,
            sbBerth: 0,
            winSuperBowl: 0,
            playoffStatus: "unknown",
          },
          source: "nfl_games",
          sourceData: { throughWeek: sequence },
          snapshotAt: snapshot.capturedAt,
        });
        snapshotsWritten += 1;
      }
    }
  }
  return snapshotsWritten;
}

function isAdminRequest(req: Request): boolean {
  const adminKey = process.env["ADMIN_API_KEY"];
  return Boolean(adminKey && req.headers.authorization === `Bearer ${adminKey}`);
}

async function resolveSeason(year: number) {
  const rows = await db
    .select({ id: seasonsTable.id, year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, year))
    .limit(1);
  return rows[0] ?? null;
}

async function resolveScoringCalcutta(
  seasonId: number,
  requestedCalcuttaId?: number | null,
) {
  const calcuttaId = requestedCalcuttaId == null
    ? await resolveCalcuttaId(db, { seasonId })
    : requestedCalcuttaId;
  if (!calcuttaId) return null;
  const rows = await db
    .select({
      id: calcuttasTable.id,
      sport: calcuttasTable.sport,
      competitionFormat: calcuttasTable.competitionFormat,
    })
    .from(calcuttasTable)
    .where(and(
      eq(calcuttasTable.id, calcuttaId),
      eq(calcuttasTable.seasonId, seasonId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

router.get("/periods", async (req, res): Promise<void> => {
  const parsed = GetSportPeriodsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const sport = parsed.data.sport;
  const competition = sport === "CFB"
    ? "CFB_REGULAR_SEASON"
    : "NFL_REGULAR_SEASON";
  const periods = await db
    .select({
      sequence: sportPeriodsTable.sequence,
      label: sportPeriodsTable.label,
      isPlayoff: sportPeriodsTable.isPlayoff,
    })
    .from(sportPeriodsTable)
    .where(and(
      eq(sportPeriodsTable.sport, sport),
      eq(sportPeriodsTable.competition, competition),
    ))
    .orderBy(sportPeriodsTable.sequence);

  // The NFL template is deterministic and lets a newly created pool render its
  // period picker before the first commissioner write seeds the shared rows.
  res.json(
    periods.length > 0
      ? periods
      : sport === NFL_SPORT
        ? NFL_PERIOD_TEMPLATE
        : [],
  );
});

router.get("/payout-rules", async (req, res): Promise<void> => {
  const parsed = GetPayoutRulesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const season = await resolveSeason(parsed.data.season);
  if (!season) {
    res.json([]);
    return;
  }
  const calcutta = await resolveScoringCalcutta(
    season.id,
    parsed.data.calcuttaId,
  );
  if (!calcutta) {
    if (parsed.data.calcuttaId != null) {
      res.status(400).json({ error: "Calcutta must belong to the requested season." });
    } else res.json([]);
    return;
  }
  const rules = await db
    .select({
      metric: payoutRulesTable.metric,
      dollarsPerUnit: payoutRulesTable.dollarsPerUnit,
      playoffMultiplier: payoutRulesTable.playoffMultiplier,
    })
    .from(payoutRulesTable)
    .where(eq(payoutRulesTable.calcuttaId, calcutta.id));
  res.json(
    rules.map((rule) => ({
      metric: rule.metric,
      dollarsPerUnit: rule.dollarsPerUnit == null ? null : Number(rule.dollarsPerUnit),
      playoffMultiplier: rule.playoffMultiplier == null ? null : Number(rule.playoffMultiplier),
    })),
  );
});

router.put("/payout-rules", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = ReplacePayoutRulesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const duplicateMetric = new Set<string>();
  for (const rule of parsed.data.rules) {
    if (duplicateMetric.has(rule.metric)) {
      res.status(400).json({ error: `Payout rule "${rule.metric}" was supplied more than once.` });
      return;
    }
    duplicateMetric.add(rule.metric);
  }
  const season = await resolveSeason(parsed.data.seasonYear);
  if (!season) {
    res.status(404).json({ error: `Season ${parsed.data.seasonYear} not found` });
    return;
  }
  const calcutta = await resolveScoringCalcutta(
    season.id,
    parsed.data.calcuttaId,
  );
  if (!calcutta) {
    res.status(400).json({ error: "Calcutta must belong to the requested season." });
    return;
  }
  const baseAdapter = getCompetitionScoringAdapter(
    calcutta.sport,
    calcutta.competitionFormat,
  );
  if (!baseAdapter) {
    res.status(400).json({ error: "This competition does not have a scoring adapter." });
    return;
  }
  const configuredAdapter = configureCompetitionScoringAdapter(baseAdapter, [
    {
      ruleName: "starting_points",
      value: parsed.data.startingPoints ?? baseAdapter.startingPoints,
    },
    {
      ruleName: "normalization_denominator",
      value: parsed.data.normalizationDenominator ??
        baseAdapter.normalizationDenominator,
    },
  ]);
  const rubric = validateCompetitionScoringRules(
    configuredAdapter,
    parsed.data.rules,
  );
  if (!rubric.ok) {
    res.status(400).json({ error: rubric.error });
    return;
  }

  const saved = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${season.id})`,
    );
    await ensureCompetitionSportPeriods(configuredAdapter, tx);
    await tx
      .delete(payoutRulesTable)
      .where(eq(payoutRulesTable.calcuttaId, calcutta.id));
    await tx.insert(payoutRulesTable).values(
      parsed.data.rules.map((rule) => ({
        calcuttaId: calcutta.id,
        metric: rule.metric,
        dollarsPerUnit: rule.dollarsPerUnit.toString(),
        playoffMultiplier: rule.playoffMultiplier.toString(),
      })),
    );
    if (
      parsed.data.startingPoints != null &&
      parsed.data.normalizationDenominator != null
    ) {
      for (const setting of [
        {
          ruleName: "starting_points",
          value: parsed.data.startingPoints,
          description: "Competition starting points.",
        },
        {
          ruleName: "normalization_denominator",
          value: parsed.data.normalizationDenominator,
          description: "Competition points normalization denominator.",
        },
      ]) {
        const row = {
          calcuttaId: calcutta.id,
          ruleName: setting.ruleName,
          value: setting.value.toString(),
          unit: "points",
          description: setting.description,
          active: true,
        };
        await tx.insert(calcuttaRulesTable).values(row).onConflictDoUpdate({
          target: [calcuttaRulesTable.calcuttaId, calcuttaRulesTable.ruleName],
          set: row,
        });
      }
    }
    return parsed.data.rules.map((rule) => ({
      metric: rule.metric,
      dollarsPerUnit: rule.dollarsPerUnit,
      playoffMultiplier: rule.playoffMultiplier,
    }));
  });
  res.json(saved);
});

router.post("/period-snapshots/week-zero", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = InitializeWeekZeroPointsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const season = await resolveSeason(parsed.data.seasonYear);
  if (!season) {
    res.status(404).json({ error: `Season ${parsed.data.seasonYear} not found` });
    return;
  }
  const resolvedCalcuttaId = await resolveCalcuttaId(db, {
    seasonId: season.id,
    calcuttaId: parsed.data.calcuttaId,
  });
  if (!resolvedCalcuttaId) {
    res.status(400).json({ error: "Calcutta must be an NFL pool in the requested season." });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${season.id})`,
    );
    return initializeNflWeekZeroSnapshots(tx, {
      calcuttaId: resolvedCalcuttaId,
    });
  });
  if (outcome.kind === "no_auctioned_teams") {
    res.status(400).json({
      error: "Week 0 requires at least one auctioned NFL team in this Calcutta.",
    });
    return;
  }

  const response = InitializeWeekZeroPointsResponse.parse({
    seasonYear: season.year,
    periodSequence: 0,
    periodLabel: "Week 0",
    teamCount: outcome.teamCount,
    realizedSnapshotsWritten: outcome.realizedSnapshotsWritten,
    mtmSnapshotsWritten: outcome.mtmSnapshotsWritten,
    snapshotsWritten: outcome.snapshotsWritten,
    alreadyInitialized: outcome.alreadyInitialized,
  });
  res.json(response);
});

router.post("/period-snapshots", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = UpsertTeamPeriodSnapshotBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const season = await resolveSeason(data.seasonYear);
  if (!season) {
    res.status(404).json({ error: `Season ${data.seasonYear} not found` });
    return;
  }
  const resolvedCalcuttaId = await resolveCalcuttaId(db, {
    seasonId: season.id,
    calcuttaId: data.calcuttaId,
  });
  if (!resolvedCalcuttaId) {
    res.status(400).json({ error: "Calcutta must be an NFL pool in the requested season." });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${season.id})`,
    );
    await ensureNflSportPeriods(tx);
    const auctioned = await tx
      .select({ teamId: calcuttaEntriesTable.teamId, entryId: calcuttaEntriesTable.id })
      .from(calcuttaEntriesTable)
      .innerJoin(positionsTable, and(
        eq(positionsTable.entryId, calcuttaEntriesTable.id),
        eq(positionsTable.source, "primary"),
      ))
      .where(and(
        eq(calcuttaEntriesTable.calcuttaId, resolvedCalcuttaId),
        eq(calcuttaEntriesTable.teamId, data.teamId),
      ))
      .limit(1);
    if (!auctioned[0]) return { kind: "not_auctioned" as const };

    const entry = { id: auctioned[0].entryId };
    const period = await tx
      .select({
        id: sportPeriodsTable.id,
        label: sportPeriodsTable.label,
        isPlayoff: sportPeriodsTable.isPlayoff,
      })
      .from(sportPeriodsTable)
      .where(
        and(
          eq(sportPeriodsTable.sport, NFL_SPORT),
          eq(sportPeriodsTable.competition, "NFL_REGULAR_SEASON"),
          eq(sportPeriodsTable.sequence, data.periodSequence),
        ),
      )
      .limit(1);
    if (!period[0]) return { kind: "period_not_found" as const };
    if (period[0].isPlayoff) {
      const hasBaseline = await hasCompleteNormalizedSnapshot(tx, {
        calcuttaId: resolvedCalcuttaId,
        entryId: entry.id,
        basis: data.basis,
        periodSequence: 18,
      });
      if (!hasBaseline) return { kind: "missing_regular_baseline" as const };
    }
    if (data.basis === "realized" && data.periodSequence <= 18) {
      const ledgerGame = await tx
        .select({ id: nflGamesTable.id })
        .from(nflGamesTable)
        .where(eq(nflGamesTable.seasonId, season.id))
        .limit(1);
      if (ledgerGame[0]) return { kind: "game_ledger_authoritative" as const };
    }

    const wins = data.wins ?? 0;
    const ties = data.ties ?? 0;
    const ptDiff = data.ptDiff ?? 0;
    const marqueeWins = data.marqueeWins ?? 0;
    const marqueeTies = data.marqueeTies ?? 0;
    const marqueePtDiff = data.marqueePtDiff ?? 0;
    const snapshot: NormalizedSnapshotWrite = {
      wins,
      losses: data.losses ?? 0,
      ties,
      ptDiff,
      ordinaryWins: data.ordinaryWins ?? Math.max(0, wins - marqueeWins),
      marqueeWins,
      ordinaryTies: data.ordinaryTies ?? Math.max(0, ties - marqueeTies),
      marqueeTies,
      ordinaryPtDiff: data.ordinaryPtDiff ??
        (data.marqueePtDiff == null
          ? ptDiff
          : ptDiff - NFL_MARQUEE_MULTIPLIER * marqueePtDiff),
      marqueePtDiff,
      playoffBerth: data.playoffBerth ?? 0,
      divRound: data.divRound ?? 0,
      confRound: data.confRound ?? 0,
      sbBerth: data.sbBerth ?? 0,
      winSuperBowl: data.winSuperBowl ?? 0,
      playoffStatus: data.playoffStatus ?? "unknown",
    };
    const capturedAt = new Date();
    const values = {
      entryId: entry.id,
      periodId: period[0].id,
      basis: data.basis,
      wins: snapshot.wins.toString(),
      losses: snapshot.losses.toString(),
      ties: snapshot.ties.toString(),
      ptDiff: snapshot.ptDiff.toString(),
      ordinaryWins: snapshot.ordinaryWins.toString(),
      marqueeWins: snapshot.marqueeWins.toString(),
      ordinaryTies: snapshot.ordinaryTies.toString(),
      marqueeTies: snapshot.marqueeTies.toString(),
      ordinaryPtDiff: snapshot.ordinaryPtDiff.toString(),
      marqueePtDiff: snapshot.marqueePtDiff.toString(),
      playoffBerth: snapshot.playoffBerth.toString(),
      divRound: snapshot.divRound.toString(),
      confRound: snapshot.confRound.toString(),
      sbBerth: snapshot.sbBerth.toString(),
      winSuperBowl: snapshot.winSuperBowl.toString(),
      playoffStatus: snapshot.playoffStatus,
      capturedAt,
    };
    await tx
      .insert(teamPeriodSnapshotsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [
          teamPeriodSnapshotsTable.entryId,
          teamPeriodSnapshotsTable.periodId,
          teamPeriodSnapshotsTable.basis,
        ],
        set: values,
      });
    await upsertNormalizedSnapshotMetrics(tx, {
      calcuttaId: resolvedCalcuttaId,
      entryId: entry.id,
      periodId: period[0].id,
      basis: data.basis,
      snapshot,
      source: "manual",
      snapshotAt: capturedAt,
    });
    return {
      kind: "saved" as const,
      periodLabel: period[0].label,
      isPlayoff: period[0].isPlayoff,
    };
  });

  if (outcome.kind === "not_auctioned") {
    res.status(400).json({
      error: "Team is not auctioned in this season and cannot receive a period snapshot.",
    });
    return;
  }
  if (outcome.kind === "period_not_found") {
    res.status(400).json({ error: "The requested NFL period does not exist." });
    return;
  }
  if (outcome.kind === "missing_regular_baseline") {
    res.status(400).json({
      error: "Save a Week 18 cumulative baseline for this team and basis before recording a playoff snapshot.",
    });
    return;
  }
  if (outcome.kind === "game_ledger_authoritative") {
    res.status(409).json({
      error: "Realized regular-season snapshots are derived from the NFL game ledger. Update the final game instead.",
    });
    return;
  }

  const calculated = await loadCalculatedTeamReturnsForCalcutta(
    resolvedCalcuttaId,
    data.periodSequence,
  );
  const grossReturn = calculated.get(data.teamId)?.[data.basis]?.grossReturn ?? 0;
  const response = UpsertTeamPeriodSnapshotResponse.parse({
    teamId: data.teamId,
    seasonYear: data.seasonYear,
    periodSequence: data.periodSequence,
    periodLabel: outcome.periodLabel,
    isPlayoff: outcome.isPlayoff,
    basis: data.basis,
    wins: data.wins ?? 0,
    losses: data.losses ?? 0,
    ties: data.ties ?? 0,
    ptDiff: data.ptDiff ?? 0,
    ordinaryWins: data.ordinaryWins ?? 0,
    marqueeWins: data.marqueeWins ?? 0,
    ordinaryTies: data.ordinaryTies ?? 0,
    marqueeTies: data.marqueeTies ?? 0,
    ordinaryPtDiff: data.ordinaryPtDiff ?? 0,
    marqueePtDiff: data.marqueePtDiff ?? 0,
    playoffBerth: data.playoffBerth ?? 0,
    divRound: data.divRound ?? 0,
    confRound: data.confRound ?? 0,
    sbBerth: data.sbBerth ?? 0,
    winSuperBowl: data.winSuperBowl ?? 0,
    playoffStatus: data.playoffStatus ?? "unknown",
    grossReturn,
  });
  res.json(response);
});

router.get("/nfl-games", async (req, res): Promise<void> => {
  const seasonYear = Number(req.query.season);
  if (!Number.isInteger(seasonYear)) {
    res.status(400).json({ error: "season must be an integer NFL season year." });
    return;
  }
  const season = await resolveSeason(seasonYear);
  if (!season) {
    res.json([]);
    return;
  }
  const games = await db
    .select()
    .from(nflGamesTable)
    .where(eq(nflGamesTable.seasonId, season.id))
    .orderBy(asc(nflGamesTable.periodSequence), asc(nflGamesTable.actualKickoffAt));
  res.json(games);
});

/**
 * Upserts a final regular-season game and rebuilds the selected period's
 * realized snapshots from the full game ledger. It intentionally does not
 * touch team_results or final postseason flags.
 */
router.post("/nfl-games", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const input = req.body as Record<string, unknown>;
  const seasonYear = Number(input.seasonYear);
  const periodSequence = Number(input.periodSequence);
  if (!Number.isInteger(seasonYear) || !Number.isInteger(periodSequence) || periodSequence < 1 || periodSequence > 18) {
    res.status(400).json({ error: "seasonYear and regular-season periodSequence (1–18) are required." });
    return;
  }
  const season = await resolveSeason(seasonYear);
  if (!season) {
    res.status(404).json({ error: `Season ${seasonYear} not found` });
    return;
  }
  let game;
  try {
    game = normalizeNflGame({
      seasonId: season.id,
      source: typeof input.source === "string" ? input.source : "manual",
      sourceGameId: typeof input.sourceGameId === "string" ? input.sourceGameId : "",
      periodSequence,
      round: "regular",
      homeTeamId: Number(input.homeTeamId),
      awayTeamId: Number(input.awayTeamId),
      homeScore: Number(input.homeScore),
      awayScore: Number(input.awayScore),
      actualKickoffAt: typeof input.actualKickoffAt === "string" ? input.actualKickoffAt : "",
      status: "final",
      sourceData: input.sourceData && typeof input.sourceData === "object"
        ? input.sourceData as Record<string, unknown>
        : null,
    });
    if (!game.sourceGameId) throw new Error("NFL game sourceGameId is required.");
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid NFL game." });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${season.id})`);
    await ensureNflSportPeriods(tx);
    const values = { ...game, sourceData: game.sourceData ?? null, updatedAt: new Date() };
    await tx.insert(nflGamesTable).values(values).onConflictDoUpdate({
      target: [nflGamesTable.seasonId, nflGamesTable.source, nflGamesTable.sourceGameId],
      set: values,
    });
    const snapshotsWritten = await rebuildNflRealizedSnapshots(
      tx,
      season.id,
      periodSequence,
    );
    return { game, snapshotsWritten };
  });
  res.status(201).json(outcome);
});

router.get("/payout-diagnostics", async (req, res): Promise<void> => {
  const seasonYear = Number(req.query.season);
  if (!Number.isInteger(seasonYear)) {
    res.status(400).json({ error: "season must be an integer NFL season year." });
    return;
  }
  const season = await resolveSeason(seasonYear);
  if (!season) {
    res.status(404).json({ error: `Season ${seasonYear} not found` });
    return;
  }
  const [auctioned, legacy] = await Promise.all([
    db.select({ teamId: teamSeasonAuctionsTable.teamId })
      .from(teamSeasonAuctionsTable)
      .where(eq(teamSeasonAuctionsTable.seasonId, season.id)),
    db.select({ teamId: teamResultsTable.teamId, realizedReturn: teamResultsTable.realizedReturn })
      .from(teamResultsTable)
      .where(eq(teamResultsTable.seasonId, season.id)),
  ]);
  const calcutta = await db.select({ id: calcuttasTable.id }).from(calcuttasTable).where(and(
    eq(calcuttasTable.seasonId, season.id), eq(calcuttasTable.sport, NFL_SPORT), eq(calcuttasTable.isCanonical, true),
  )).limit(1);
  const calculated = calcutta[0]
    ? await loadCalculatedTeamReturnsForCalcutta(calcutta[0].id, undefined, false)
    : new Map();
  res.json(compareHistoricalPayoutParity(
    auctioned.length,
    legacy.map((row) => ({ teamId: row.teamId, grossReturn: Number(row.realizedReturn) })),
    calculated,
  ));
});

// Comparison-only migration diagnostic for deprecated entry economics. This is
// intentionally admin-protected because it exposes reconciliation details.
router.get("/entry-return-diagnostics", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const seasonYear = Number(req.query.season);
  const requestedCalcuttaId = req.query.calcuttaId == null
    ? undefined
    : Number(req.query.calcuttaId);
  if (!Number.isInteger(seasonYear)) {
    res.status(400).json({ error: "season must be an integer season year." });
    return;
  }
  if (
    requestedCalcuttaId != null &&
    (!Number.isInteger(requestedCalcuttaId) || requestedCalcuttaId <= 0)
  ) {
    res.status(400).json({ error: "calcuttaId must be a positive integer." });
    return;
  }
  const season = await resolveSeason(seasonYear);
  if (!season) {
    res.status(404).json({ error: `Season ${seasonYear} not found` });
    return;
  }
  const calcutta = await resolveScoringCalcutta(season.id, requestedCalcuttaId);
  if (!calcutta) {
    res.status(400).json({ error: "Calcutta must belong to the requested season." });
    return;
  }
  res.json(await auditStoredEntryReturnDiscrepancies(calcutta.id));
});

export default router;