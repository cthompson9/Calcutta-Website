import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  closeDatabasePool,
  db,
  ensureOwnerPositionRollout,
  runDatabaseMigrations,
  seasonsTable,
} from "@workspace/db";
import { currentYearInNewYork } from "../lib/newYorkTime";
import { applyNflStandingsImport } from "../lib/nflStandingsImport";

async function resolveRefreshSeasonYear(): Promise<number> {
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

async function main(): Promise<void> {
  await runDatabaseMigrations();
  await ensureOwnerPositionRollout();
  const seasonYear = await resolveRefreshSeasonYear();
  const result = await applyNflStandingsImport({
    seasonYear,
    requestedBy: "scheduled_deployment",
    requestId: process.env["REPLIT_DEPLOYMENT_ID"] ?? randomUUID(),
  });
  console.log(JSON.stringify(result));
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDatabasePool();
}