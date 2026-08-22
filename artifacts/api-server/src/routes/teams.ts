import { Router, type IRouter, type Request } from "express";
import { eq, and, ilike, inArray, sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  teamBiddersTable,
  teamSeasonAuctionsTable,
  seasonsTable,
  tradesTable,
  ownershipAdjustmentsTable,
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
import {
  OWNERSHIP_SEASON_LOCK_NAMESPACE,
  validatePrimaryOwnership,
} from "../lib/ownershipShares";

const router: IRouter = Router();

function isAdminRequest(req: Request): boolean {
  const adminKey = process.env["ADMIN_API_KEY"];
  return Boolean(adminKey && req.headers.authorization === `Bearer ${adminKey}`);
}

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
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "ADMIN_API_KEY bearer token is required." });
    return;
  }
  const parsed = CreateTeamBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, conference, division, bidAmount, owners, season: seasonYear } = parsed.data;

  const split = validatePrimaryOwnership(
    owners.map((owner) => ({
      bidderId: owner.bidderId,
      share: owner.ownershipShare,
    })),
  );
  if (!split.ok) {
    res.status(400).json({ error: split.error });
    return;
  }

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

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    const matchedBidders = await tx
      .select({ id: biddersTable.id })
      .from(biddersTable)
      .where(inArray(biddersTable.id, split.owners.map((owner) => owner.bidderId)));
    if (matchedBidders.length !== split.owners.length) {
      return { kind: "unknown_owner" as const };
    }

    // Insert into teams table — legacy bidAmount remains unused at runtime.
    const [team] = await tx
      .insert(teamsTable)
      .values({ name, conference, division, bidAmount: "0" })
      .returning({ id: teamsTable.id });
    await tx.insert(teamSeasonAuctionsTable).values({
      teamId: team.id,
      seasonId,
      bidAmount: String(bidAmount),
    });
    await tx.insert(teamBiddersTable).values(
      split.owners.map((owner) => ({
        teamId: team.id,
        bidderId: owner.bidderId,
        seasonId,
        ownershipShare: String(owner.share),
      })),
    );
    await tx.insert(ownershipAdjustmentsTable).values({
      teamId: team.id,
      seasonId,
      source: "team_create",
      note: "Initial primary ownership recorded with team creation",
      owners: {
        bidAmount,
        owners: split.owners.map((owner) => ({
          bidderId: owner.bidderId,
          ownershipShare: owner.share,
        })),
      },
    });
    return { kind: "created" as const, teamId: team.id };
  });

  if (outcome.kind === "unknown_owner") {
    res.status(400).json({ error: "Every primary owner must be an existing bidder." });
    return;
  }

  const full = await fetchTeamWithOwners(outcome.teamId, seasonId);
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
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "ADMIN_API_KEY bearer token is required." });
    return;
  }
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
  const split =
    owners === undefined
      ? null
      : validatePrimaryOwnership(
          owners.map((owner) => ({
            bidderId: owner.bidderId,
            share: owner.ownershipShare,
          })),
        );
  if (split && !split.ok) {
    res.status(400).json({ error: split.error });
    return;
  }

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

  const updateResult = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    const existingTeam = await tx
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(eq(teamsTable.id, params.data.id))
      .limit(1);
    if (!existingTeam[0]) return { kind: "not_found" as const };

    if (split) {
      const [matchedBidders, approvedTrade] = await Promise.all([
        tx
          .select({ id: biddersTable.id })
          .from(biddersTable)
          .where(inArray(biddersTable.id, split.owners.map((owner) => owner.bidderId))),
        tx
          .select({ id: tradesTable.id })
          .from(tradesTable)
          .where(
            and(
              eq(tradesTable.teamId, params.data.id),
              eq(tradesTable.seasonId, seasonId),
              eq(tradesTable.status, "approved"),
            ),
          )
          .limit(1),
      ]);
      if (matchedBidders.length !== split.owners.length) {
        return { kind: "unknown_owner" as const };
      }
      if (approvedTrade[0]) return { kind: "approved_trade" as const };
    }

    // Do not write bidAmount back to the legacy teams table.
    const updates: Record<string, unknown> = { ...rest };
    if (Object.keys(updates).length > 0) {
      await tx.update(teamsTable).set(updates).where(eq(teamsTable.id, params.data.id));
    }
    if (bidAmount !== undefined) {
      await tx
        .insert(teamSeasonAuctionsTable)
        .values({ teamId: params.data.id, seasonId, bidAmount: String(bidAmount) })
        .onConflictDoUpdate({
          target: [teamSeasonAuctionsTable.teamId, teamSeasonAuctionsTable.seasonId],
          set: { bidAmount: String(bidAmount) },
        });
    }
    if (split) {
      await tx
        .delete(teamBiddersTable)
        .where(
          and(
            eq(teamBiddersTable.teamId, params.data.id),
            eq(teamBiddersTable.seasonId, seasonId),
          ),
        );
      await tx.insert(teamBiddersTable).values(
        split.owners.map((owner) => ({
          teamId: params.data.id,
          bidderId: owner.bidderId,
          seasonId,
          ownershipShare: String(owner.share),
        })),
      );
      await tx.insert(ownershipAdjustmentsTable).values({
        teamId: params.data.id,
        seasonId,
        source: "team_primary_ownership",
        note: "Primary ownership replaced through the team editor",
        owners: {
          owners: split.owners.map((owner) => ({
            bidderId: owner.bidderId,
            ownershipShare: owner.share,
          })),
        },
      });
    }
    return { kind: "updated" as const };
  });

  if (updateResult.kind === "not_found") {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  if (updateResult.kind === "unknown_owner") {
    res.status(400).json({ error: "Every primary owner must be an existing bidder." });
    return;
  }
  if (updateResult.kind === "approved_trade") {
    res.status(409).json({
      error:
        "This team has approved trades. Preserve that history with a correcting trade instead of replacing primary ownership.",
    });
    return;
  }

  const full = await fetchTeamWithOwners(params.data.id, seasonId);
  if (!full) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  res.json(full);
});

router.delete("/teams/:id", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "ADMIN_API_KEY bearer token is required." });
    return;
  }
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
