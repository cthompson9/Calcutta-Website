import { Router, type IRouter, type Request } from "express";
import { eq, asc } from "drizzle-orm";
import { db, teamsTable, mtmSnapshotsTable, seasonsTable } from "@workspace/db";
import { GetMtmSnapshotsQueryParams, UpsertMtmSnapshotBody } from "@workspace/api-zod";
import { loadSeasonOwnership } from "../lib/seasonOwnership";

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

  // Effective ownership (applies approved trades)
  const ownership = await loadSeasonOwnership(seasonId);

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
      };
    });

    return { snapshotDate: date, weekNum, ownerTotals, teamValues };
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
      target: [
        mtmSnapshotsTable.teamId,
        mtmSnapshotsTable.seasonId,
        mtmSnapshotsTable.snapshotDate,
      ],
      set: {
        weekNum: data.weekNum ?? null,
        mtmValue: data.mtmValue.toString(),
      },
    })
    .returning();

  res.json(snap);
});

export default router;
