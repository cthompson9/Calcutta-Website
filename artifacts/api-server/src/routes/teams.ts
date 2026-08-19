import { Router, type IRouter } from "express";
import { eq, and, ilike, sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  teamBiddersTable,
  teamSeasonAuctionsTable,
  seasonsTable,
} from "@workspace/db";
import {
  GetTeamsQueryParams,
  GetTeamParams,
  CreateTeamBody,
  UpdateTeamBody,
  UpdateTeamParams,
  DeleteTeamParams,
} from "@workspace/api-zod";
import { loadSeasonOwnership } from "../lib/seasonOwnership";

const router: IRouter = Router();

async function getActiveSeasonId(): Promise<number> {
  const rows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.isActive, true))
    .limit(1);
  if (!rows[0]) throw new Error("No active season found");
  return rows[0].id;
}

async function resolveSeasonId(year: number): Promise<number | null> {
  const rows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, year))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function getSeasonBidAmount(teamId: number, seasonId: number): Promise<number> {
  const rows = await db
    .select({ bidAmount: teamSeasonAuctionsTable.bidAmount })
    .from(teamSeasonAuctionsTable)
    .where(
      and(
        eq(teamSeasonAuctionsTable.teamId, teamId),
        eq(teamSeasonAuctionsTable.seasonId, seasonId),
      ),
    )
    .limit(1);
  return parseFloat(rows[0]?.bidAmount ?? "0");
}

/** Fetch a single team with effective owners for the given season. */
async function fetchTeamWithOwners(teamId: number, seasonId: number) {
  const team = await db
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  if (!team[0]) return null;

  const ownership = await loadSeasonOwnership(seasonId);
  const bidAmount = await getSeasonBidAmount(teamId, seasonId);

  const currentOwners = ownership.currentOwnersByTeam.get(teamId) ?? [];

  return {
    id: team[0].id,
    name: team[0].name,
    conference: team[0].conference,
    division: team[0].division,
    bidAmount,
    owners: currentOwners.map((o) => ({
      bidderId: o.bidderId,
      bidderName: o.bidderName,
      ownershipShare: o.ownershipShare,
    })),
  };
}

router.get("/teams", async (req, res): Promise<void> => {
  const parsed = GetTeamsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { conference, division, search, bidderId, season: seasonYear } = parsed.data;

  // Resolve season
  let seasonId: number | null = null;
  if (seasonYear != null) {
    const resolved = await resolveSeasonId(seasonYear);
    if (!resolved) {
      // Unknown season → empty list, no active-season fallback
      res.json([]);
      return;
    }
    seasonId = resolved;
  }

  // Build base team query.
  // When a season is provided, join team_season_auctions to filter to auctioned teams.
  // Without season: no filter, return all teams.
  let baseQuery = db
    .selectDistinct({
      id: teamsTable.id,
      name: teamsTable.name,
      conference: teamsTable.conference,
      division: teamsTable.division,
    })
    .from(teamsTable)
    .$dynamic();

  if (seasonId != null) {
    // Use team_season_auctions presence — a team is "in the season" if it was auctioned
    baseQuery = baseQuery.innerJoin(
      teamSeasonAuctionsTable,
      and(
        eq(teamSeasonAuctionsTable.teamId, teamsTable.id),
        eq(teamSeasonAuctionsTable.seasonId, seasonId),
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

  let teams = await baseQuery.orderBy(teamsTable.conference, teamsTable.division, teamsTable.name);

  if (teams.length === 0) {
    res.json([]);
    return;
  }

  // Determine effective season for ownership lookups
  const ownershipSeasonId = seasonId ?? (await getActiveSeasonId());
  const ownership = await loadSeasonOwnership(ownershipSeasonId);

  // If bidderId filter is set, apply it using effective ownership
  if (bidderId != null) {
    const bidderTeamMap = ownership.byBidder.get(bidderId);
    const teamsWithEffectiveOwnership = new Set<number>();
    if (bidderTeamMap) {
      for (const [teamId, entry] of bidderTeamMap) {
        if (entry.effectiveShare > 0.00005) teamsWithEffectiveOwnership.add(teamId);
      }
    }
    teams = teams.filter((t) => teamsWithEffectiveOwnership.has(t.id));
    if (teams.length === 0) {
      res.json([]);
      return;
    }
  }

  const teamIds = teams.map((t) => t.id);

  // Fetch season auction prices
  const auctionRows = await db
    .select({
      teamId: teamSeasonAuctionsTable.teamId,
      bidAmount: teamSeasonAuctionsTable.bidAmount,
    })
    .from(teamSeasonAuctionsTable)
    .where(
      and(
        sql`${teamSeasonAuctionsTable.teamId} = ANY(ARRAY[${sql.join(teamIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
        eq(teamSeasonAuctionsTable.seasonId, ownershipSeasonId),
      ),
    );
  const auctionPriceMap = new Map(auctionRows.map((a) => [a.teamId, parseFloat(a.bidAmount)]));

  const result = teams.map((t) => ({
    id: t.id,
    name: t.name,
    conference: t.conference,
    division: t.division,
    bidAmount: auctionPriceMap.get(t.id) ?? 0,
    owners: (ownership.currentOwnersByTeam.get(t.id) ?? []).map((o) => ({
      bidderId: o.bidderId,
      bidderName: o.bidderName,
      ownershipShare: o.ownershipShare,
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

  const { name, conference, division, bidAmount, owners, season: seasonYear } = parsed.data;

  // Insert into teams table — legacy bidAmount initialized to 0 (deprecated)
  const [team] = await db
    .insert(teamsTable)
    .values({ name, conference, division, bidAmount: "0" })
    .returning();

  // Resolve season
  let seasonId: number;
  if (seasonYear != null) {
    const resolved = await resolveSeasonId(seasonYear);
    if (!resolved) {
      res.status(400).json({ error: `Season ${seasonYear} not found` });
      return;
    }
    seasonId = resolved;
  } else {
    seasonId = await getActiveSeasonId();
  }

  // Write season auction price into team_season_auctions
  await db
    .insert(teamSeasonAuctionsTable)
    .values({ teamId: team.id, seasonId, bidAmount: String(bidAmount) })
    .onConflictDoUpdate({
      target: [teamSeasonAuctionsTable.teamId, teamSeasonAuctionsTable.seasonId],
      set: { bidAmount: String(bidAmount) },
    });

  await db.insert(teamBiddersTable).values(
    owners.map((o) => ({
      teamId: team.id,
      bidderId: o.bidderId,
      seasonId,
      ownershipShare: String(o.ownershipShare),
    })),
  );

  const full = await fetchTeamWithOwners(team.id, seasonId);
  res.status(201).json(full);
});

router.get("/teams/:id", async (req, res): Promise<void> => {
  const params = GetTeamParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const seasonId = await getActiveSeasonId();
  const full = await fetchTeamWithOwners(params.data.id, seasonId);
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

  const { owners, bidAmount, season: seasonYear, ...rest } = parsed.data;

  // Resolve season
  let seasonId: number;
  if (seasonYear != null) {
    const resolved = await resolveSeasonId(seasonYear);
    if (!resolved) {
      res.status(400).json({ error: `Season ${seasonYear} not found` });
      return;
    }
    seasonId = resolved;
  } else {
    seasonId = await getActiveSeasonId();
  }

  // Update non-financial static fields on the teams table (name, conference, division)
  // Do NOT write bidAmount back to the legacy column
  const updates: Record<string, unknown> = { ...rest };
  if (Object.keys(updates).length > 0) {
    await db.update(teamsTable).set(updates).where(eq(teamsTable.id, params.data.id));
  }

  // Update season auction price only in team_season_auctions
  if (bidAmount !== undefined) {
    await db
      .insert(teamSeasonAuctionsTable)
      .values({ teamId: params.data.id, seasonId, bidAmount: String(bidAmount) })
      .onConflictDoUpdate({
        target: [teamSeasonAuctionsTable.teamId, teamSeasonAuctionsTable.seasonId],
        set: { bidAmount: String(bidAmount) },
      });
  }

  if (owners !== undefined) {
    // Delete only this season's rows — preserves prior-season history
    await db
      .delete(teamBiddersTable)
      .where(
        and(
          eq(teamBiddersTable.teamId, params.data.id),
          eq(teamBiddersTable.seasonId, seasonId),
        ),
      );
    await db.insert(teamBiddersTable).values(
      owners.map((o) => ({
        teamId: params.data.id,
        bidderId: o.bidderId,
        seasonId,
        ownershipShare: String(o.ownershipShare),
      })),
    );
  }

  const full = await fetchTeamWithOwners(params.data.id, seasonId);
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
