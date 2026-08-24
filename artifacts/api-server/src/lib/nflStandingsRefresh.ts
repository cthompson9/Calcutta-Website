import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, seasonsTable } from "@workspace/db";
import { currentYearInNewYork } from "./newYorkTime";
import { applyNflStandingsImport } from "./nflStandingsImport";

export async function resolveNflStandingsRefreshSeasonYear(): Promise<number> {
  const active = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.isActive, true))
    .orderBy(desc(seasonsTable.year))
    .limit(1);
  if (active[0]) return active[0].year;

  const currentYear = currentYearInNewYork();
  const current = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, currentYear))
    .limit(1);
  if (current[0]) return current[0].year;

  throw new Error(
    `No active season or ${currentYear} season is configured for the NFL standings refresh.`,
  );
}

export async function runNflStandingsRefresh(input: {
  requestedBy: string;
  requestId?: string;
}): Promise<Awaited<ReturnType<typeof applyNflStandingsImport>>> {
  const seasonYear = await resolveNflStandingsRefreshSeasonYear();
  return applyNflStandingsImport({
    seasonYear,
    requestedBy: input.requestedBy,
    requestId: input.requestId ?? randomUUID(),
  });
}