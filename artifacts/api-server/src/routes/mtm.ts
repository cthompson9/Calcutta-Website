import { Router, type IRouter, type Request } from "express";
import { eq, asc } from "drizzle-orm";
import { db, teamsTable, biddersTable, teamBiddersTable, mtmSnapshotsTable, seasonsTable } from "@workspace/db";
import { GetMtmSnapshotsQueryParams, UpsertMtmSnapshotBody } from "@workspace/api-zod";

function isAdminRequest(req: Request): boolean {
  const adminKey = process.env["ADMIN_API_KEY"];
  if (!adminKey) return false;
  const auth = req.headers["authorization"];
  return auth === `Bearer ${adminKey}`;
}

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

  // Fetch all snapshots for the season ordered by date
  const snapshotsRaw = await db
    .select()
    .from(mtmSnapshotsTable)
    .where(eq(mtmSnapshotsTable.seasonId, seasonId))
    .orderBy(asc(mtmSnapshotsTable.snapshotDate), asc(mtmSnapshotsTable.teamId));

  // Fetch team info
  const teams = await db.select().from(teamsTable);
  const teamMap = new Map(teams.map((t) => [t.id, t]));

  // Fetch ownerships scoped to this season
  const ownerships = await db
    .select({
      teamId: teamBiddersTable.teamId,
      bidderId: biddersTable.id,
      bidderName: biddersTable.name,
      ownershipShare: teamBiddersTable.ownershipShare,
    })
    .from(teamBiddersTable)
    .innerJoin(biddersTable, eq(teamBiddersTable.bidderId, biddersTable.id))
    .where(eq(teamBiddersTable.seasonId, seasonId));

  const ownershipMap = new Map<number, { bidderId: number; bidderName: string; ownershipShare: number }[]>();
  for (const o of ownerships) {
    if (!ownershipMap.has(o.teamId)) ownershipMap.set(o.teamId, []);
    ownershipMap.get(o.teamId)!.push({ ...o, ownershipShare: parseFloat(o.ownershipShare) });
  }

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
      const owners = ownershipMap.get(t.id) ?? [];
      const primaryOwner = owners.length === 1 ? owners[0].bidderName : owners.map((o) => o.bidderName).join(" / ");
      return {
        teamId: t.id,
        teamName: t.name,
        conference: t.conference,
        ownerName: primaryOwner,
        weeklyValues: dates.map((d) => teamSnapshotMap.get(t.id)?.get(d) ?? 0),
      };
    });

  // Build owner series
  const ownerNames = [...new Set(ownerships.map((o) => o.bidderName))].sort();
  const ownerSeries = ownerNames.map((ownerName) => {
    const weeklyTotals = dates.map((d) => {
      let total = 0;
      for (const t of teams) {
        const owners = ownershipMap.get(t.id) ?? [];
        const ownerEntry = owners.find((o) => o.bidderName === ownerName);
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
    // weekNum from the first snapshot for this date (may be null)
    const weekNum = snapsForDate[0]?.weekNum ?? null;

    const ownerTotals = ownerNames.map((ownerName) => {
      let total = 0;
      for (const s of snapsForDate) {
        const owners = ownershipMap.get(s.teamId) ?? [];
        const ownerEntry = owners.find((o) => o.bidderName === ownerName);
        if (!ownerEntry) continue;
        total += parseFloat(s.mtmValue) * ownerEntry.ownershipShare;
      }
      return { bidderName: ownerName, mtmTotal: Math.round(total * 100) / 100 };
    });

    const teamValues = snapsForDate.map((s) => {
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

    return { snapshotDate: date, weekNum, ownerTotals, teamValues };
  });

  res.json({ weeks, teams: teamSeries, owners: ownerSeries });
});

router.post("/mtm", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "Unauthorized. This endpoint requires the ADMIN_API_KEY bearer token." });
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

  const today = new Date().toISOString().slice(0, 10);
  const snapshotDate = data.snapshotDate ?? today;

  const [snap] = await db
    .insert(mtmSnapshotsTable)
    .values({
      teamId: data.teamId,
      seasonId,
      weekNum: data.weekNum ?? null,
      snapshotDate,
      mtmValue: data.mtmValue.toString(),
    })
    .onConflictDoUpdate({
      target: [mtmSnapshotsTable.teamId, mtmSnapshotsTable.seasonId, mtmSnapshotsTable.snapshotDate],
      set: {
        weekNum: data.weekNum ?? null,
        mtmValue: data.mtmValue.toString(),
      },
    })
    .returning();

  res.json(snap);
});

export default router;
