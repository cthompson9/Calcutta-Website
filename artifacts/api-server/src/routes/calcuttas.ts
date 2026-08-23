import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, calcuttasTable, seasonsTable } from "@workspace/db";
import { GetCalcuttasResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const legacyEditionNames: Record<string, string> = {
  "NFL:2025": "Calcutta VIII",
  "NFL:2026": "Calcutta XII",
};

function selectorName(args: { name: string; sport: string; year: number }): string {
  if (args.name.startsWith("Calcutta ")) return args.name;
  return legacyEditionNames[`${args.sport}:${args.year}`] ?? args.name;
}

router.get("/calcuttas", async (_req, res): Promise<void> => {
  const calcuttas = await db
    .select({
      id: calcuttasTable.id,
      seasonId: calcuttasTable.seasonId,
      name: calcuttasTable.name,
      sport: calcuttasTable.sport,
      year: calcuttasTable.year,
      isActive: seasonsTable.isActive,
      isComplete: seasonsTable.isComplete,
    })
    .from(calcuttasTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .where(
      and(
        eq(calcuttasTable.sport, "NFL"),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
    .orderBy(
      desc(calcuttasTable.year),
      desc(calcuttasTable.createdAt),
      desc(calcuttasTable.id),
    );

  res.json(
    GetCalcuttasResponse.parse(
      calcuttas.map((calcutta) => ({
        ...calcutta,
        name: selectorName(calcutta),
      })),
    ),
  );
});

export default router;