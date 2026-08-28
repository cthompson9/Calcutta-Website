import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, calcuttasTable, seasonsTable } from "@workspace/db";
import { GetCalcuttasResponse } from "@workspace/api-zod";
import { sendParsedJson } from "../lib/sendParsedJson";

const router: IRouter = Router();

const legacyEditionNames: Record<string, string> = {
  "NCAAM:2022": "Calcutta I",
  "NCAAM:2023": "Calcutta II",
  "NFL:2023": "Calcutta III",
  "NCAAM:2024": "Calcutta IV",
  "NFL:2024": "Calcutta V",
  "NCAAM:2025": "Calcutta VI",
  "NBA:2025": "Calcutta VII",
  "NFL:2025": "Calcutta VIII",
  "NCAAM:2026": "Calcutta IX",
  "NBA:2026": "Calcutta X",
  "Soccer:2026": "Calcutta XI",
  "NFL:2026": "Calcutta XII",
};

function selectorName(args: { name: string; sport: string; year: number }): string {
  if (args.name.startsWith("Calcutta ")) return args.name;
  return legacyEditionNames[`${args.sport}:${args.year}`] ?? args.name;
}

const editionOrder = [
  "Calcutta I",
  "Calcutta II",
  "Calcutta III",
  "Calcutta IV",
  "Calcutta V",
  "Calcutta VI",
  "Calcutta VII",
  "Calcutta VIII",
  "Calcutta IX",
  "Calcutta X",
  "Calcutta XI",
  "Calcutta XII",
];

function selectorOrder(name: string): number {
  const order = editionOrder.indexOf(name);
  return order >= 0 ? order + 1 : 0;
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
      isCanonical: calcuttasTable.isCanonical,
    })
    .from(calcuttasTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .orderBy(
      desc(calcuttasTable.year),
      desc(calcuttasTable.createdAt),
      desc(calcuttasTable.id),
    );

  const options = calcuttas
    .map((calcutta) => ({
        ...calcutta,
        name: selectorName(calcutta),
      }))
    .sort(
      (left, right) =>
        selectorOrder(right.name) - selectorOrder(left.name) ||
        right.year - left.year ||
        right.id - left.id,
    );

  sendParsedJson(res, GetCalcuttasResponse, options);
});

export default router;