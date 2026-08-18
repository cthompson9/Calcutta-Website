import { Router, type IRouter } from "express";
import { eq, and, ilike, sql } from "drizzle-orm";
import { db, teamsTable, biddersTable, teamBiddersTable } from "@workspace/db";
import {
  GetTeamsQueryParams,
  GetTeamParams,
  CreateTeamBody,
  UpdateTeamBody,
  UpdateTeamParams,
  DeleteTeamParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function fetchTeamWithOwners(teamId: number) {
  const team = await db
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  if (!team[0]) return null;

  const owners = await db
    .select({
      bidderId: biddersTable.id,
      bidderName: biddersTable.name,
      ownershipShare: teamBiddersTable.ownershipShare,
    })
    .from(teamBiddersTable)
    .innerJoin(biddersTable, eq(teamBiddersTable.bidderId, biddersTable.id))
    .where(eq(teamBiddersTable.teamId, teamId));

  return {
    ...team[0],
    bidAmount: parseFloat(team[0].bidAmount),
    owners: owners.map((o) => ({
      bidderId: o.bidderId,
      bidderName: o.bidderName,
      ownershipShare: parseFloat(o.ownershipShare),
    })),
  };
}

router.get("/teams", async (req, res): Promise<void> => {
  const parsed = GetTeamsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { conference, division, search, bidderId } = parsed.data;

  let baseQuery = db
    .selectDistinct({
      id: teamsTable.id,
      name: teamsTable.name,
      conference: teamsTable.conference,
      division: teamsTable.division,
      bidAmount: teamsTable.bidAmount,
    })
    .from(teamsTable)
    .$dynamic();

  if (bidderId != null) {
    baseQuery = baseQuery.innerJoin(
      teamBiddersTable,
      and(
        eq(teamBiddersTable.teamId, teamsTable.id),
        eq(teamBiddersTable.bidderId, bidderId),
      ),
    );
  }

  const conditions = [];
  if (conference) conditions.push(eq(teamsTable.conference, conference));
  if (division) conditions.push(eq(teamsTable.division, division));
  if (search) conditions.push(ilike(teamsTable.name, `%${search}%`));
  if (conditions.length > 0) {
    baseQuery = baseQuery.where(and(...conditions));
  }

  const teams = await baseQuery.orderBy(teamsTable.conference, teamsTable.division, teamsTable.name);

  const teamIds = teams.map((t) => t.id);
  if (teamIds.length === 0) {
    res.json([]);
    return;
  }

  const allOwners = await db
    .select({
      teamId: teamBiddersTable.teamId,
      bidderId: biddersTable.id,
      bidderName: biddersTable.name,
      ownershipShare: teamBiddersTable.ownershipShare,
    })
    .from(teamBiddersTable)
    .innerJoin(biddersTable, eq(teamBiddersTable.bidderId, biddersTable.id))
    .where(sql`${teamBiddersTable.teamId} = ANY(ARRAY[${sql.join(teamIds.map(id => sql`${id}`), sql`, `)}]::int[])`);

  const ownersByTeam = new Map<number, typeof allOwners>();
  for (const o of allOwners) {
    if (!ownersByTeam.has(o.teamId)) ownersByTeam.set(o.teamId, []);
    ownersByTeam.get(o.teamId)!.push(o);
  }

  const result = teams.map((t) => ({
    ...t,
    bidAmount: parseFloat(t.bidAmount),
    owners: (ownersByTeam.get(t.id) ?? []).map((o) => ({
      bidderId: o.bidderId,
      bidderName: o.bidderName,
      ownershipShare: parseFloat(o.ownershipShare),
    })),
  }));

  res.json(result);
});

router.post("/teams", async (req, res): Promise<void> => {
  const parsed = CreateTeamBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, conference, division, bidAmount, owners } = parsed.data;

  const [team] = await db
    .insert(teamsTable)
    .values({ name, conference, division, bidAmount: String(bidAmount) })
    .returning();

  await db.insert(teamBiddersTable).values(
    owners.map((o) => ({
      teamId: team.id,
      bidderId: o.bidderId,
      ownershipShare: String(o.ownershipShare),
    })),
  );

  const full = await fetchTeamWithOwners(team.id);
  res.status(201).json(full);
});

router.get("/teams/:id", async (req, res): Promise<void> => {
  const params = GetTeamParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const full = await fetchTeamWithOwners(params.data.id);
  if (!full) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  res.json(full);
});

router.patch("/teams/:id", async (req, res): Promise<void> => {
  const params = UpdateTeamParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateTeamBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { owners, bidAmount, ...rest } = parsed.data;
  const updates: Record<string, unknown> = { ...rest };
  if (bidAmount !== undefined) updates.bidAmount = String(bidAmount);

  if (Object.keys(updates).length > 0) {
    await db.update(teamsTable).set(updates).where(eq(teamsTable.id, params.data.id));
  }

  if (owners !== undefined) {
    await db.delete(teamBiddersTable).where(eq(teamBiddersTable.teamId, params.data.id));
    await db.insert(teamBiddersTable).values(
      owners.map((o) => ({
        teamId: params.data.id,
        bidderId: o.bidderId,
        ownershipShare: String(o.ownershipShare),
      })),
    );
  }

  const full = await fetchTeamWithOwners(params.data.id);
  if (!full) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  res.json(full);
});

router.delete("/teams/:id", async (req, res): Promise<void> => {
  const params = DeleteTeamParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const deleted = await db
    .delete(teamsTable)
    .where(eq(teamsTable.id, params.data.id))
    .returning();

  if (deleted.length === 0) {
    res.status(404).json({ error: "Team not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
