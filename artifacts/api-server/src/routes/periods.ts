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
  calcuttasTable,
  db,
  nflGamesTable,
  payoutRulesTable,
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
  compareHistoricalPayoutParity,
  ensureNflSportPeriods,
  getOrCreateCalcuttaEntry,
  getOrCreateCanonicalCalcutta,
  initializeNflWeekZeroSnapshots,
  loadCalculatedTeamReturns,
  loadCalculatedTeamReturnsForCalcutta,
  normalizeNflGame,
  validateNflPayoutRules,
  type ReturnMetric,
} from "../lib/calcuttaReturns";

const router: IRouter = Router();

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

router.get("/periods", async (req, res): Promise<void> => {
  const parsed = GetSportPeriodsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const sport = parsed.data.sport;
  const periods = await db
    .select({
      sequence: sportPeriodsTable.sequence,
      label: sportPeriodsTable.label,
      isPlayoff: sportPeriodsTable.isPlayoff,
    })
    .from(sportPeriodsTable)
    .where(eq(sportPeriodsTable.sport, sport))
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
  const calcutta = await db
    .select({ id: calcuttasTable.id })
    .from(calcuttasTable)
    .where(
      and(
        eq(calcuttasTable.seasonId, season.id),
        eq(calcuttasTable.sport, NFL_SPORT),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
    .limit(1);
  if (!calcutta[0]) {
    res.json([]);
    return;
  }
  const rules = await db
    .select({
      metric: payoutRulesTable.metric,
      dollarsPerUnit: payoutRulesTable.dollarsPerUnit,
      playoffMultiplier: payoutRulesTable.playoffMultiplier,
    })
    .from(payoutRulesTable)
    .where(eq(payoutRulesTable.calcuttaId, calcutta[0].id));
  res.json(
    rules.map((rule) => ({
      metric: rule.metric,
      dollarsPerUnit: Number(rule.dollarsPerUnit),
      playoffMultiplier: Number(rule.playoffMultiplier),
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
  const rubric = validateNflPayoutRules(parsed.data.rules);
  if (!rubric.ok) {
    res.status(400).json({ error: rubric.error });
    return;
  }
  const season = await resolveSeason(parsed.data.seasonYear);
  if (!season) {
    res.status(404).json({ error: `Season ${parsed.data.seasonYear} not found` });
    return;
  }

  const saved = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${season.id})`,
    );
    await ensureNflSportPeriods(tx);
    const calcutta = await getOrCreateCanonicalCalcutta(tx, {
      seasonId: season.id,
      year: season.year,
    });
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

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${season.id})`,
    );
    return initializeNflWeekZeroSnapshots(tx, {
      seasonId: season.id,
      year: season.year,
    });
  });
  if (outcome.kind === "no_auctioned_teams") {
    res.status(400).json({
      error: "Week 0 requires at least one auctioned NFL team in this season.",
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

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${season.id})`,
    );
    await ensureNflSportPeriods(tx);
    const auctioned = await tx
      .select({ teamId: teamSeasonAuctionsTable.teamId })
      .from(teamSeasonAuctionsTable)
      .where(
        and(
          eq(teamSeasonAuctionsTable.teamId, data.teamId),
          eq(teamSeasonAuctionsTable.seasonId, season.id),
        ),
      )
      .limit(1);
    if (!auctioned[0]) return { kind: "not_auctioned" as const };

    const calcutta = await getOrCreateCanonicalCalcutta(tx, {
      seasonId: season.id,
      year: season.year,
    });
    const entry = await getOrCreateCalcuttaEntry(tx, {
      calcuttaId: calcutta.id,
      teamId: data.teamId,
    });
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
          eq(sportPeriodsTable.sequence, data.periodSequence),
        ),
      )
      .limit(1);
    if (!period[0]) return { kind: "period_not_found" as const };
    if (period[0].isPlayoff) {
      const baseline = await tx
        .select({ id: teamPeriodSnapshotsTable.id })
        .from(teamPeriodSnapshotsTable)
        .innerJoin(
          sportPeriodsTable,
          eq(sportPeriodsTable.id, teamPeriodSnapshotsTable.periodId),
        )
        .where(
          and(
            eq(teamPeriodSnapshotsTable.entryId, entry.id),
            eq(teamPeriodSnapshotsTable.basis, data.basis),
            eq(sportPeriodsTable.sport, NFL_SPORT),
            eq(sportPeriodsTable.sequence, 18),
          ),
        )
        .limit(1);
      if (!baseline[0]) return { kind: "missing_regular_baseline" as const };
    }
    if (data.basis === "realized" && data.periodSequence <= 18) {
      const ledgerGame = await tx
        .select({ id: nflGamesTable.id })
        .from(nflGamesTable)
        .where(eq(nflGamesTable.seasonId, season.id))
        .limit(1);
      if (ledgerGame[0]) return { kind: "game_ledger_authoritative" as const };
    }

    const values = {
      entryId: entry.id,
      periodId: period[0].id,
      basis: data.basis,
      wins: (data.wins ?? 0).toString(),
      losses: (data.losses ?? 0).toString(),
      ties: (data.ties ?? 0).toString(),
      ptDiff: (data.ptDiff ?? 0).toString(),
      ordinaryWins: (data.ordinaryWins ?? 0).toString(),
      marqueeWins: (data.marqueeWins ?? 0).toString(),
      ordinaryTies: (data.ordinaryTies ?? 0).toString(),
      marqueeTies: (data.marqueeTies ?? 0).toString(),
      ordinaryPtDiff: (data.ordinaryPtDiff ?? 0).toString(),
      marqueePtDiff: (data.marqueePtDiff ?? 0).toString(),
      playoffBerth: (data.playoffBerth ?? 0).toString(),
      divRound: (data.divRound ?? 0).toString(),
      confRound: (data.confRound ?? 0).toString(),
      sbBerth: (data.sbBerth ?? 0).toString(),
      winSuperBowl: (data.winSuperBowl ?? 0).toString(),
      playoffStatus: data.playoffStatus ?? "unknown",
      capturedAt: new Date(),
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

  const calculated = await loadCalculatedTeamReturns(season.id, data.periodSequence);
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
    const auctioned = await tx.select({ teamId: teamSeasonAuctionsTable.teamId })
      .from(teamSeasonAuctionsTable).where(eq(teamSeasonAuctionsTable.seasonId, season.id));
    const calcutta = await getOrCreateCanonicalCalcutta(tx, { seasonId: season.id, year: season.year });
    const priorPeriods = await tx
      .select({ sequence: sportPeriodsTable.sequence })
      .from(teamPeriodSnapshotsTable)
      .innerJoin(calcuttaEntriesTable, eq(calcuttaEntriesTable.id, teamPeriodSnapshotsTable.entryId))
      .innerJoin(sportPeriodsTable, eq(sportPeriodsTable.id, teamPeriodSnapshotsTable.periodId))
      .where(and(
        eq(calcuttaEntriesTable.calcuttaId, calcutta.id),
        eq(teamPeriodSnapshotsTable.basis, "realized"),
        eq(sportPeriodsTable.sport, NFL_SPORT),
        gte(sportPeriodsTable.sequence, periodSequence),
        lte(sportPeriodsTable.sequence, 18),
      ));
    const sequences = [...new Set([periodSequence, ...priorPeriods.map((row) => row.sequence)])].sort((a, b) => a - b);
    for (const sequence of sequences) {
      const rows = await tx.select().from(nflGamesTable).where(and(
        eq(nflGamesTable.seasonId, season.id), eq(nflGamesTable.round, "regular"),
        eq(nflGamesTable.status, "final"), lte(nflGamesTable.periodSequence, sequence),
      ));
      const aggregate = aggregateNflRegularSeasonGames(rows.map((row) => ({
        seasonId: row.seasonId, source: row.source, sourceGameId: row.sourceGameId,
        periodSequence: row.periodSequence, round: row.round, homeTeamId: row.homeTeamId,
        awayTeamId: row.awayTeamId, homeScore: row.homeScore, awayScore: row.awayScore,
        actualKickoffAt: row.actualKickoffAt, status: row.status, sourceData: row.sourceData,
      })));
      const period = await tx.select({ id: sportPeriodsTable.id }).from(sportPeriodsTable)
        .where(and(eq(sportPeriodsTable.sport, NFL_SPORT), eq(sportPeriodsTable.sequence, sequence))).limit(1);
      if (!period[0]) throw new Error("NFL period was not seeded.");
      for (const { teamId } of auctioned) {
        const entry = await getOrCreateCalcuttaEntry(tx, { calcuttaId: calcutta.id, teamId });
        const stats = aggregate.get(teamId) ?? {
          wins: 0, losses: 0, ties: 0, ordinaryWins: 0, marqueeWins: 0,
          ordinaryTies: 0, marqueeTies: 0, ordinaryPtDiff: 0, marqueePtDiff: 0,
        };
        const snapshot = {
          entryId: entry.id, periodId: period[0].id, basis: "realized" as const,
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
      }
    }
    return { game, snapshotsWritten: auctioned.length * sequences.length };
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

export default router;