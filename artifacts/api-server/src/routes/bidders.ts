import { Router, type IRouter } from "express";
import { eq, sql, and } from "drizzle-orm";
import { db, biddersTable, teamsTable, teamBiddersTable, seasonsTable } from "@workspace/db";
import {
  CreateBidderBody,
  UpdateBidderBody,
  UpdateBidderParams,
  DeleteBidderParams,
} from "@workspace/api-zod";

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

router.get("/bidders", async (_req, res): Promise<void> => {
  const activeSeasonId = await getActiveSeasonId();
  const bidders = await db.select().from(biddersTable).orderBy(biddersTable.name);

  const results = await Promise.all(
    bidders.map(async (bidder) => {
      const ownerships = await db
        .select({
          teamId: teamsTable.id,
          teamName: teamsTable.name,
          conference: teamsTable.conference,
          division: teamsTable.division,
          bidAmount: teamsTable.bidAmount,
          ownershipShare: teamBiddersTable.ownershipShare,
        })
        .from(teamBiddersTable)
        .innerJoin(teamsTable, eq(teamBiddersTable.teamId, teamsTable.id))
        .where(
          and(
            eq(teamBiddersTable.bidderId, bidder.id),
            eq(teamBiddersTable.seasonId, activeSeasonId),
          ),
        )
        .orderBy(teamsTable.conference, teamsTable.name);

      const totalPaid = ownerships.reduce(
        (sum, o) => sum + parseFloat(o.bidAmount) * parseFloat(o.ownershipShare),
        0,
      );

      return {
        id: bidder.id,
        name: bidder.name,
        teamCount: ownerships.length,
        totalPaid: Math.round(totalPaid * 100) / 100,
        teams: ownerships.map((o) => ({
          id: o.teamId,
          name: o.teamName,
          conference: o.conference,
          division: o.division,
          bidAmount: parseFloat(o.bidAmount),
          ownershipShare: parseFloat(o.ownershipShare),
        })),
      };
    }),
  );

  res.json(results);
});

router.post("/bidders", async (req, res): Promise<void> => {
  const parsed = CreateBidderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [bidder] = await db
    .insert(biddersTable)
    .values({ name: parsed.data.name })
    .returning();

  res.status(201).json(bidder);
});

router.patch("/bidders/:id", async (req, res): Promise<void> => {
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
    .set(parsed.data)
    .where(eq(biddersTable.id, params.data.id))
    .returning();

  if (!bidder) {
    res.status(404).json({ error: "Bidder not found" });
    return;
  }

  res.json(bidder);
});

router.delete("/bidders/:id", async (req, res): Promise<void> => {
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
