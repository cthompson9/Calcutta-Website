import { Router, type IRouter } from "express";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";
import { db, seasonsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateSeasonBody, CreateSeasonResponse, GetSeasonsResponse } from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireAdmin";

const router: IRouter = Router();

router.get("/seasons", async (_req, res): Promise<void> => {
  const seasons = await db.select().from(seasonsTable).orderBy(seasonsTable.year);
  sendParsedJson(res, GetSeasonsResponse, seasons);
});

router.post("/seasons", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateSeasonBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const { year, isActive, isComplete, label } = parsed.data;
  const [season] = await db
    .insert(seasonsTable)
    .values({ year, isActive: isActive ?? false, isComplete: isComplete ?? false, label })
    .returning();
  sendParsedJson(res, CreateSeasonResponse, season, 201);
});

export default router;
