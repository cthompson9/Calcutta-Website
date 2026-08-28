import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  biddersTable,
  teamsTable,
  seasonsTable,
} from "@workspace/db";
import {
  GetBiddersQueryParams,
  CreateBidderBody,
  UpdateBidderBody,
  UpdateBidderParams,
  DeleteBidderParams,
  GetBiddersResponse,
  CreateBidderResponse,
  UpdateBidderResponse,
} from "@workspace/api-zod";
import { loadSeasonOwnership } from "../lib/seasonOwnership";
import { loadCurrentBidderConsortiums } from "../lib/consortiumMemberships";
import { resolveCalcuttaId } from "../lib/calcuttaContext";
import { requireAdmin } from "../middlewares/requireAdmin";

const router: IRouter = Router();

async function resolveSeasonId(year: number): Promise<number | null> {
  const rows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, year))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function getBidderResponse(id: number) {
  const rows = await db
    .select({
      id: biddersTable.id,
      name: biddersTable.name,
    })
    .from(biddersTable)
    .where(eq(biddersTable.id, id))
    .limit(1);
  if (!rows[0]) return null;
  const consortiumByBidder = await loadCurrentBidderConsortiums([id]);
  return {
    ...rows[0],
    consortium: consortiumByBidder.get(id) ?? null,
  };
}

router.get("/bidders", async (req, res): Promise<void> => {
  const parsed = GetBiddersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { season: seasonYear } = parsed.data as typeof parsed.data & { calcuttaId?: number };

  if (seasonYear != null) {
    // ── Season-filtered: only return season participants ───────────────────
    const seasonId = await resolveSeasonId(seasonYear);
    if (!seasonId) {
      res.json([]);
      return;
    }

    const calcuttaId = await resolveCalcuttaId(db, {
      seasonId,
      calcuttaId: (parsed.data as typeof parsed.data & { calcuttaId?: number }).calcuttaId,
    });
    if (!calcuttaId) {
      res.json([]);
      return;
    }
    const ownership = await loadSeasonOwnership(seasonId, calcuttaId);

    if (ownership.participantIds.size === 0) {
      res.json([]);
      return;
    }

    // Fetch all team info needed for the response
    const allTeams = await db.select().from(teamsTable);
    const teamInfoMap = new Map(allTeams.map((t) => [t.id, t]));
    const primaryCostByTeam = new Map<number, number>();
    for (const teamMap of ownership.byBidder.values()) {
      for (const [teamId, entry] of teamMap) {
        primaryCostByTeam.set(
          teamId,
          (primaryCostByTeam.get(teamId) ?? 0) + entry.primaryCostBasis,
        );
      }
    }

    // Fetch bidder name rows for all participants
    const participantIdArr = Array.from(ownership.participantIds);
    const consortiumByBidder =
      await loadCurrentBidderConsortiums(participantIdArr);
    const bidderRows = await db
      .select({
        id: biddersTable.id,
        name: biddersTable.name,
      })
      .from(biddersTable)
      .where(inArray(biddersTable.id, participantIdArr))
      .orderBy(biddersTable.name);

    const results = bidderRows.map((bidder) => {
      const teamMap = ownership.byBidder.get(bidder.id);

      // Compute total paid: original cost + trade buys - trade sells (economic cost)
      let totalPaid = 0;
      const teamsList: Array<{
        id: number;
        name: string;
        conference: string;
        division: string;
        bidAmount: number;
        ownershipShare: number;
      }> = [];

      if (teamMap) {
        for (const [teamId, entry] of teamMap) {
          totalPaid += entry.originalCostBasis + entry.tradePaid - entry.tradeReceived;

          // Include team in list if they have current effective ownership
          if (entry.effectiveShare > 0.00005) {
            const teamInfo = teamInfoMap.get(teamId);
            if (teamInfo) {
              teamsList.push({
                id: teamId,
                name: teamInfo.name,
                conference: teamInfo.conference,
                division: teamInfo.division,
                bidAmount: primaryCostByTeam.get(teamId) ?? 0,
                ownershipShare: entry.effectiveShare,
              });
            }
          }
        }
      }

      // Sort teams by conference then name
      teamsList.sort((a, b) =>
        a.conference.localeCompare(b.conference) || a.name.localeCompare(b.name),
      );

      // teamCount = sum of effective fractional shares
      const teamCount = teamsList.reduce((sum, t) => sum + t.ownershipShare, 0);

      return {
        id: bidder.id,
        name: bidder.name,
        consortium: consortiumByBidder.get(bidder.id) ?? null,
        teamCount: Math.round(teamCount * 10) / 10,
        totalPaid: Math.round(totalPaid * 100) / 100,
        teams: teamsList,
      };
    });

    res.json(GetBiddersResponse.parse(results));
    return;
  }

  // ── No season: global identity directory ─────────────────────────────────
  // Return ALL bidders with zero/empty financial fields.
  // Used for selecting new secondary buyers before a season is underway.
  const bidders = await db
    .select({
      id: biddersTable.id,
      name: biddersTable.name,
    })
    .from(biddersTable)
    .orderBy(biddersTable.name);
  const consortiumByBidder = await loadCurrentBidderConsortiums();

  const results = bidders.map((bidder) => ({
    id: bidder.id,
    name: bidder.name,
    consortium: consortiumByBidder.get(bidder.id) ?? null,
    teamCount: 0,
    totalPaid: 0,
    teams: [] as Array<{
      id: number;
      name: string;
      conference: string;
      division: string;
      bidAmount: number;
      ownershipShare: number;
    }>,
  }));

  res.json(GetBiddersResponse.parse(results));
});

router.post("/bidders", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateBidderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [bidder] = await db
    .insert(biddersTable)
    .values({ name: parsed.data.name })
    .returning();

  res.status(201).json(CreateBidderResponse.parse(await getBidderResponse(bidder.id)));
});

router.patch("/bidders/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateBidderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateBidderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [bidder] = await db
    .update(biddersTable)
    .set({ name: parsed.data.name })
    .where(eq(biddersTable.id, params.data.id))
    .returning();

  if (!bidder) {
    res.status(404).json({ error: "Bidder not found" });
    return;
  }

  res.json(UpdateBidderResponse.parse(await getBidderResponse(bidder.id)));
});

router.delete("/bidders/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteBidderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const deleted = await db
    .delete(biddersTable)
    .where(eq(biddersTable.id, params.data.id))
    .returning();

  if (deleted.length === 0) {
    res.status(404).json({ error: "Bidder not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
