import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, teamsTable, biddersTable, teamBiddersTable, mtmSnapshotsTable, seasonsTable } from "@workspace/db";
import { GetMtmSnapshotsQueryParams, UpsertMtmSnapshotBody } from "@workspace/api-zod";

const router: IRouter = Router();

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

  // Fetch all snapshots for the season
  const snapshotsRaw = await db
    .select()
    .from(mtmSnapshotsTable)
    .where(eq(mtmSnapshotsTable.seasonId, seasonId))
    .orderBy(mtmSnapshotsTable.weekNum, mtmSnapshotsTable.teamId);

  // Fetch team info
  const teams = await db.select().from(teamsTable);
  const teamMap = new Map(teams.map((t) => [t.id, t]));

  // Fetch ownerships
  const ownerships = await db
    .select({
      teamId: teamBiddersTable.teamId,
      bidderId: biddersTable.id,
      bidderName: biddersTable.name,
      ownershipShare: teamBiddersTable.ownershipShare,
    })
    .from(teamBiddersTable)
    .innerJoin(biddersTable, eq(teamBiddersTable.bidderId, biddersTable.id));

  const ownershipMap = new Map<number, { bidderId: number; bidderName: string; ownershipShare: number }[]>();
  for (const o of ownerships) {
    if (!ownershipMap.has(o.teamId)) ownershipMap.set(o.teamId, []);
    ownershipMap.get(o.teamId)!.push({ ...o, ownershipShare: parseFloat(o.ownershipShare) });
  }

  // Get unique weeks sorted
  const weekNums = [...new Set(snapshotsRaw.map((s) => s.weekNum))].sort((a, b) => a - b);

  // Build team series
  const teamSnapshotMap = new Map<number, Map<number, number>>(); // teamId → weekNum → mtmValue
  for (const s of snapshotsRaw) {
    if (!teamSnapshotMap.has(s.teamId)) teamSnapshotMap.set(s.teamId, new Map());
    teamSnapshotMap.get(s.teamId)!.set(s.weekNum, parseFloat(s.mtmValue));
  }

  const teamSeries = teams
    .filter((t) => teamSnapshotMap.has(t.id))
    .map((t) => {
      const owners = ownershipMap.get(t.id) ?? [];
      const primaryOwner = owners.length === 1 ? owners[0].bidderName : owners.map((o) => o.bidderName).join(" / ");
      return {
        teamId: t.id,
        teamName: t.name,
        conference: t.conference,
        ownerName: primaryOwner,
        weeklyValues: weekNums.map((w) => teamSnapshotMap.get(t.id)?.get(w) ?? 0),
      };
    });

  // Build owner series
  const ownerNames = [...new Set(ownerships.map((o) => o.bidderName))].sort();
  const ownerSeries = ownerNames.map((ownerName) => {
    const weeklyTotals = weekNums.map((w) => {
      let total = 0;
      for (const t of teams) {
        const owners = ownershipMap.get(t.id) ?? [];
        const ownerEntry = owners.find((o) => o.bidderName === ownerName);
        if (!ownerEntry) continue;
        const mtmVal = teamSnapshotMap.get(t.id)?.get(w) ?? 0;
        total += mtmVal * ownerEntry.ownershipShare;
      }
      return Math.round(total * 100) / 100;
    });
    return { bidderName: ownerName, weeklyTotals };
  });

  // Build week-level data
  const weeks = weekNums.map((w) => {
    const snapsForWeek = snapshotsRaw.filter((s) => s.weekNum === w);
    const snapshotDate = snapsForWeek[0]?.snapshotDate ?? null;

    const ownerTotals = ownerNames.map((ownerName) => {
      let total = 0;
      for (const s of snapsForWeek) {
        const owners = ownershipMap.get(s.teamId) ?? [];
        const ownerEntry = owners.find((o) => o.bidderName === ownerName);
        if (!ownerEntry) continue;
        total += parseFloat(s.mtmValue) * ownerEntry.ownershipShare;
      }
      return { bidderName: ownerName, mtmTotal: Math.round(total * 100) / 100 };
    });

    const teamValues = snapsForWeek.map((s) => {
      const t = teamMap.get(s.teamId);
      const owners = ownershipMap.get(s.teamId) ?? [];
      const primaryOwner = owners.length === 1 ? owners[0].bidderName : owners.map((o) => o.bidderName).join(" / ");
      return {
        teamId: s.teamId,
        teamName: t?.name ?? "Unknown",
        ownerName: primaryOwner,
        mtmValue: parseFloat(s.mtmValue),
      };
    });

    return { weekNum: w, snapshotDate, ownerTotals, teamValues };
  });

  res.json({ weeks, teams: teamSeries, owners: ownerSeries });
});

router.post("/mtm", async (req, res): Promise<void> => {
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

  const [snap] = await db
    .insert(mtmSnapshotsTable)
    .values({
      teamId: data.teamId,
      seasonId,
      weekNum: data.weekNum,
      snapshotDate: data.snapshotDate,
      mtmValue: data.mtmValue.toString(),
    })
    .onConflictDoUpdate({
      target: [mtmSnapshotsTable.teamId, mtmSnapshotsTable.seasonId, mtmSnapshotsTable.weekNum],
      set: {
        snapshotDate: data.snapshotDate,
        mtmValue: data.mtmValue.toString(),
      },
    })
    .returning();

  res.json(snap);
});

export default router;
