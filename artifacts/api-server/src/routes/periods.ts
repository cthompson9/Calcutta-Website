import { Router, type IRouter, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  GetPayoutRulesQueryParams,
  GetSportPeriodsQueryParams,
  ReplacePayoutRulesBody,
  UpsertTeamPeriodSnapshotBody,
  UpsertTeamPeriodSnapshotResponse,
} from "@workspace/api-zod";
import {
  calcuttasTable,
  db,
  payoutRulesTable,
  seasonsTable,
  sportPeriodsTable,
  teamPeriodSnapshotsTable,
  teamSeasonAuctionsTable,
} from "@workspace/db";
import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "../lib/ownershipShares";
import {
  NFL_PERIOD_TEMPLATE,
  NFL_SPORT,
  ensureNflSportPeriods,
  getOrCreateCalcuttaEntry,
  getOrCreateCanonicalCalcutta,
  loadCalculatedTeamReturns,
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

    const values = {
      entryId: entry.id,
      periodId: period[0].id,
      basis: data.basis,
      wins: (data.wins ?? 0).toString(),
      losses: (data.losses ?? 0).toString(),
      ties: (data.ties ?? 0).toString(),
      ptDiff: (data.ptDiff ?? 0).toString(),
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

export default router;