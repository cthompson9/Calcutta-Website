import { Router, type IRouter } from "express";
import { db, seasonsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateSeasonBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/seasons", async (_req, res): Promise<void> => {
  const seasons = await db.select().from(seasonsTable).orderBy(seasonsTable.year);
  res.json(seasons);
});

router.post("/seasons", async (req, res): Promise<void> => {
  const parsed = CreateSeasonBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { year, isActive, isComplete, label } = parsed.data;
  const [season] = await db
    .insert(seasonsTable)
    .values({ year, isActive: isActive ?? false, isComplete: isComplete ?? false, label })
    .returning();
  res.status(201).json(season);
});

export default router;
