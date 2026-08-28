import { Router, type IRouter, type Request } from "express";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";
import { eq, and, ilike, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  teamsTable,
  biddersTable,
  tradesTable,
  ownershipAdjustmentsTable,
  positionsTable,
  calcuttaEntriesTable,
} from "@workspace/db";
import {
  GetTeamsQueryParams,
  GetTeamParams,
  CreateTeamBody,
  UpdateTeamBody,
  UpdateTeamParams,
  DeleteTeamParams,
  GetTeamsResponse,
  GetTeamResponse,
  CreateTeamResponse,
  UpdateTeamResponse,
} from "@workspace/api-zod";
import { loadSeasonOwnership } from "../lib/seasonOwnership";
import {
  OWNERSHIP_SEASON_LOCK_NAMESPACE,
  validatePrimaryOwnership,
} from "../lib/ownershipShares";
import {
  getOrCreateCalcuttaEntry,
  resolveCalcuttaId,
  resolveDefaultSeasonYearForSport,
  resolveSeasonIdForSport,
} from "../lib/calcuttaContext";
import { requireAdmin } from "../middlewares/requireAdmin";

const router: IRouter = Router();
const TeamContextQuery = z.object({
  season: z.coerce.number().int().min(2000).max(2200).optional(),
  calcuttaId: z.coerce.number().int().positive().optional(),
  sport: z.enum(["NFL", "CFB"]).default("NFL"),
});

async function getActiveSeasonId(sport: string): Promise<number> {
  const year = await resolveDefaultSeasonYearForSport(db, {
    sport,
    state: "active",
    newestFirst: true,
  });
  if (year == null) throw new Error(`No active ${sport} season found`);
  const seasonId = await resolveSeasonIdForSport(db, { year, sport });
  if (seasonId == null) throw new Error(`No active ${sport} season found`);
  return seasonId;
}

async function resolveSeasonId(year: number, sport: string): Promise<number | null> {
  return resolveSeasonIdForSport(db, { year, sport });
}

function primaryCostByTeam(ownership: Awaited<ReturnType<typeof loadSeasonOwnership>>) {
  const costs = new Map<number, number>();
  for (const teamMap of ownership.byBidder.values()) {
    for (const [teamId, entry] of teamMap) {
      costs.set(teamId, (costs.get(teamId) ?? 0) + entry.primaryCostBasis);
    }
  }
  return costs;
}

/** Fetch a single team with effective owners for the given season. */
async function fetchTeamWithOwners(
  teamId: number,
  seasonId: number,
  sport: string,
  calcuttaId?: number,
) {
  const team = await db
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  if (!team[0]) return null;

  const selectedCalcuttaId = await resolveCalcuttaId(db, { seasonId, sport, calcuttaId });
  if (!selectedCalcuttaId) return null;
  const entry = await db
    .select({ id: calcuttaEntriesTable.id })
    .from(calcuttaEntriesTable)
    .where(and(
      eq(calcuttaEntriesTable.calcuttaId, selectedCalcuttaId),
      eq(calcuttaEntriesTable.teamId, teamId),
    ))
    .limit(1);
  if (!entry[0]) return null;
  const ownership = await loadSeasonOwnership(seasonId, selectedCalcuttaId);
  const bidAmount = primaryCostByTeam(ownership).get(teamId) ?? 0;

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
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const {
    conference,
    division,
    search,
    bidderId,
    season: seasonYear,
    sport = "NFL",
    calcuttaId: requestedCalcuttaId,
  } = parsed.data;

  // Resolve season
  let seasonId: number | null = null;
  if (seasonYear != null) {
    const resolved = await resolveSeasonId(seasonYear, sport);
    if (!resolved) {
      // Unknown season → empty list, no active-season fallback
      sendParsedJson(res, GetTeamsResponse, []);
      return;
    }
    seasonId = resolved;
  }

  // A team belongs to the selected Calcutta only when it has a ledger entry.
  const ownershipSeasonId = seasonId ?? (await getActiveSeasonId(sport));
  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId: ownershipSeasonId,
    sport,
    calcuttaId: requestedCalcuttaId,
  });
  if (!calcuttaId) {
    sendParsedJson(res, GetTeamsResponse, []);
    return;
  }

  let baseQuery = db
    .selectDistinct({
      id: teamsTable.id,
      name: teamsTable.name,
      conference: teamsTable.conference,
      division: teamsTable.division,
    })
    .from(teamsTable)
    .$dynamic();

  baseQuery = baseQuery.innerJoin(
    calcuttaEntriesTable,
    and(
      eq(calcuttaEntriesTable.teamId, teamsTable.id),
      eq(calcuttaEntriesTable.calcuttaId, calcuttaId),
    ),
  );

  const conditions = [];
  if (conference) conditions.push(eq(teamsTable.conference, conference));
  if (division) conditions.push(eq(teamsTable.division, division));
  if (search) conditions.push(ilike(teamsTable.name, `%${search}%`));
  if (conditions.length > 0) {
    baseQuery = baseQuery.where(and(...conditions));
  }

  let teams = await baseQuery.orderBy(teamsTable.conference, teamsTable.division, teamsTable.name);

  if (teams.length === 0) {
    sendParsedJson(res, GetTeamsResponse, []);
    return;
  }

  const ownership = await loadSeasonOwnership(ownershipSeasonId, calcuttaId);

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
      sendParsedJson(res, GetTeamsResponse, []);
      return;
    }
  }

  const primaryCosts = primaryCostByTeam(ownership);

  const result = teams.map((t) => ({
    id: t.id,
    name: t.name,
    conference: t.conference,
    division: t.division,
    bidAmount: primaryCosts.get(t.id) ?? 0,
    owners: (ownership.currentOwnersByTeam.get(t.id) ?? []).map((o) => ({
      bidderId: o.bidderId,
      bidderName: o.bidderName,
      ownershipShare: o.ownershipShare,
    })),
  }));

  sendParsedJson(res, GetTeamsResponse, result);
});

router.post("/teams", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateTeamBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }

  const {
    name,
    conference,
    division,
    bidAmount,
    owners,
    season: seasonYear,
    sport = "NFL",
    calcuttaId: requestedCalcuttaId,
  } = parsed.data;

  const split = validatePrimaryOwnership(
    owners.map((owner) => ({
      bidderId: owner.bidderId,
      share: owner.ownershipShare,
    })),
  );
  if (!split.ok) {
    sendParsedJson(res, ErrorResponse, { error: split.error }, 400);
    return;
  }

  let seasonId: number;
  if (seasonYear != null) {
    const resolved = await resolveSeasonId(seasonYear, sport);
    if (!resolved) {
      sendParsedJson(res, ErrorResponse, { error: `Season ${seasonYear} not found` }, 400);
      return;
    }
    seasonId = resolved;
  } else {
    seasonId = await getActiveSeasonId(sport);
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    const calcuttaId = await resolveCalcuttaId(tx, {
      seasonId,
      sport,
      calcuttaId: requestedCalcuttaId,
    });
    if (!calcuttaId) return { kind: "calcutta_not_found" as const };
    const matchedBidders = await tx
      .select({ id: biddersTable.id })
      .from(biddersTable)
      .where(inArray(biddersTable.id, split.owners.map((owner) => owner.bidderId)));
    if (matchedBidders.length !== split.owners.length) {
      return { kind: "unknown_owner" as const };
    }

    const [team] = await tx
      .insert(teamsTable)
      .values({ name, conference, division })
      .returning({ id: teamsTable.id });
    const entryId = await getOrCreateCalcuttaEntry(tx, calcuttaId, team.id);
    await tx.insert(positionsTable).values(
      split.owners.map((owner) => ({
        entryId,
        bidderId: owner.bidderId,
        ownershipShare: owner.share.toFixed(6),
        source: "primary",
        costBasis: (bidAmount * owner.share).toFixed(2),
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
    return { kind: "created" as const, teamId: team.id, calcuttaId };
  });

  if (outcome.kind === "unknown_owner") {
    sendParsedJson(res, ErrorResponse, { error: "Every primary owner must be an existing bidder." }, 400);
    return;
  }
  if (outcome.kind === "calcutta_not_found") {
    sendParsedJson(res, ErrorResponse, { error: "Calcutta not found for this season." }, 400);
    return;
  }

  const full = await fetchTeamWithOwners(outcome.teamId, seasonId, sport, outcome.calcuttaId);
  sendParsedJson(res, CreateTeamResponse, full, 201);
});

router.get("/teams/:id", async (req, res): Promise<void> => {
  const params = GetTeamParams.safeParse(req.params);
  if (!params.success) {
    sendParsedJson(res, ErrorResponse, { error: params.error.message }, 400);
    return;
  }

  const query = TeamContextQuery.safeParse(req.query);
  if (!query.success) {
    sendParsedJson(res, ErrorResponse, { error: query.error.message }, 400);
    return;
  }
  const sport = query.data.sport ?? "NFL";
  const seasonId = query.data.season == null
    ? await getActiveSeasonId(sport)
    : await resolveSeasonId(query.data.season, sport);
  if (seasonId == null) {
    sendParsedJson(res, ErrorResponse, { error: "Team not found" }, 404);
    return;
  }
  const full = await fetchTeamWithOwners(
    params.data.id,
    seasonId,
    sport,
    query.data.calcuttaId,
  );
  if (!full) {
    sendParsedJson(res, ErrorResponse, { error: "Team not found" }, 404);
    return;
  }
  sendParsedJson(res, GetTeamResponse, full);
});

router.patch("/teams/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateTeamParams.safeParse(req.params);
  if (!params.success) {
    sendParsedJson(res, ErrorResponse, { error: params.error.message }, 400);
    return;
  }

  const parsed = UpdateTeamBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }

  const updateData = parsed.data;
  const {
    owners,
    bidAmount,
    season: seasonYear,
    sport = "NFL",
    calcuttaId: requestedCalcuttaId,
    ...rest
  } = updateData;
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
    sendParsedJson(res, ErrorResponse, { error: split.error }, 400);
    return;
  }

  let seasonId: number;
  if (seasonYear != null) {
    const resolved = await resolveSeasonId(seasonYear, sport);
    if (!resolved) {
      sendParsedJson(res, ErrorResponse, { error: `Season ${seasonYear} not found` }, 400);
      return;
    }
    seasonId = resolved;
  } else {
    seasonId = await getActiveSeasonId(sport);
  }

  const updateResult = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    const calcuttaId = await resolveCalcuttaId(tx, {
      seasonId,
      sport,
      calcuttaId: requestedCalcuttaId,
    });
    if (!calcuttaId) return { kind: "calcutta_not_found" as const };
    const existingTeam = await tx
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(eq(teamsTable.id, params.data.id))
      .limit(1);
    if (!existingTeam[0]) return { kind: "not_found" as const };
    const existingEntry = await tx
      .select({ id: calcuttaEntriesTable.id })
      .from(calcuttaEntriesTable)
      .where(and(
        eq(calcuttaEntriesTable.calcuttaId, calcuttaId),
        eq(calcuttaEntriesTable.teamId, params.data.id),
      ))
      .limit(1);
    if (!existingEntry[0]) return { kind: "not_found" as const };
    const entryId = existingEntry[0].id;
    if (Object.keys(rest).length > 0) {
      const otherEntries = await tx
        .select({ id: calcuttaEntriesTable.id })
        .from(calcuttaEntriesTable)
        .where(and(
          eq(calcuttaEntriesTable.teamId, params.data.id),
          ne(calcuttaEntriesTable.calcuttaId, calcuttaId),
        ))
        .limit(1);
      if (otherEntries[0]) return { kind: "shared_team_metadata" as const };
    }

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
              eq(tradesTable.entryId, entryId),
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
      if (!split) {
        await tx
          .update(positionsTable)
          .set({
            costBasis: sql`${positionsTable.ownershipShare} * ${String(bidAmount)}`,
          })
          .where(and(
            eq(positionsTable.entryId, entryId),
            eq(positionsTable.source, "primary"),
          ));
      }
    }
    if (split) {
      const existingPrimaryRows = await tx
        .select({ costBasis: positionsTable.costBasis })
        .from(positionsTable)
        .where(and(
          eq(positionsTable.entryId, entryId),
          eq(positionsTable.source, "primary"),
        ));
      if (bidAmount === undefined && existingPrimaryRows.length === 0) {
        return { kind: "primary_cost_not_found" as const };
      }
      const existingBidAmount = bidAmount ?? existingPrimaryRows.reduce(
        (sum, row) => sum + Number(row.costBasis),
        0,
      );
      await tx.delete(positionsTable).where(
        and(eq(positionsTable.entryId, entryId), eq(positionsTable.source, "primary")),
      );
      await tx.insert(positionsTable).values(
        split.owners.map((owner) => ({
          entryId,
          bidderId: owner.bidderId,
          ownershipShare: owner.share.toFixed(6),
          source: "primary",
          costBasis: (existingBidAmount * owner.share).toFixed(2),
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
    return { kind: "updated" as const, calcuttaId };
  });

  if (updateResult.kind === "not_found") {
    sendParsedJson(res, ErrorResponse, { error: "Team not found" }, 404);
    return;
  }
  if (updateResult.kind === "unknown_owner") {
    sendParsedJson(res, ErrorResponse, { error: "Every primary owner must be an existing bidder." }, 400);
    return;
  }
  if (updateResult.kind === "calcutta_not_found") {
    sendParsedJson(res, ErrorResponse, { error: "Calcutta not found for this season." }, 400);
    return;
  }
  if (updateResult.kind === "approved_trade") {
    sendParsedJson(res, ErrorResponse, {
      error:
        "This team has approved trades. Preserve that history with a correcting trade instead of replacing primary ownership.",
    }, 409);
    return;
  }
  if (updateResult.kind === "primary_cost_not_found") {
    sendParsedJson(res, ErrorResponse, {
      error:
        "The selected Calcutta entry has no primary cost basis. Provide bidAmount when creating its primary ownership split.",
    }, 400);
    return;
  }
  if (updateResult.kind === "shared_team_metadata") {
    sendParsedJson(res, ErrorResponse, {
      error: "This team is shared by multiple Calcuttas. Update pool ownership only; shared team metadata cannot be changed from one pool.",
    }, 409);
    return;
  }

  const full = await fetchTeamWithOwners(
    params.data.id,
    seasonId,
    sport,
    updateResult.calcuttaId,
  );
  if (!full) {
    sendParsedJson(res, ErrorResponse, { error: "Team not found" }, 404);
    return;
  }
  sendParsedJson(res, UpdateTeamResponse, full);
});

router.delete("/teams/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteTeamParams.safeParse(req.params);
  if (!params.success) {
    sendParsedJson(res, ErrorResponse, { error: params.error.message }, 400);
    return;
  }

  const query = TeamContextQuery.safeParse(req.query);
  if (!query.success) {
    sendParsedJson(res, ErrorResponse, { error: query.error.message }, 400);
    return;
  }
  const sport = query.data.sport;
  const seasonId = query.data.season == null
    ? await getActiveSeasonId(sport)
    : await resolveSeasonId(query.data.season, sport);
  if (seasonId == null) {
    sendParsedJson(res, ErrorResponse, { error: "Team not found" }, 404);
    return;
  }

  const calcuttaId = await resolveCalcuttaId(db, {
    seasonId,
    sport,
    calcuttaId: query.data.calcuttaId,
  });
  if (calcuttaId == null) {
    sendParsedJson(res, ErrorResponse, { error: "Team not found" }, 404);
    return;
  }

  const [selectedEntry, otherEntry] = await Promise.all([
    db
      .select({ id: calcuttaEntriesTable.id })
      .from(calcuttaEntriesTable)
      .where(and(
        eq(calcuttaEntriesTable.calcuttaId, calcuttaId),
        eq(calcuttaEntriesTable.teamId, params.data.id),
      ))
      .limit(1),
    db
      .select({ id: calcuttaEntriesTable.id })
      .from(calcuttaEntriesTable)
      .where(and(
        eq(calcuttaEntriesTable.teamId, params.data.id),
        ne(calcuttaEntriesTable.calcuttaId, calcuttaId),
      ))
      .limit(1),
  ]);
  if (!selectedEntry[0]) {
    sendParsedJson(res, ErrorResponse, { error: "Team not found" }, 404);
    return;
  }
  if (otherEntry[0]) {
    sendParsedJson(res, ErrorResponse, {
      error: "This team is shared by multiple Calcuttas and cannot be deleted from only one pool.",
    }, 409);
    return;
  }

  const deleted = await db
    .delete(teamsTable)
    .where(eq(teamsTable.id, params.data.id))
    .returning();

  if (deleted.length === 0) {
    sendParsedJson(res, ErrorResponse, { error: "Team not found" }, 404);
    return;
  }

  res.sendStatus(204);
});

export default router;
