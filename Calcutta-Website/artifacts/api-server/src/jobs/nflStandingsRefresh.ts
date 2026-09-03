import {
  closeDatabasePool,
  ensureOwnerPositionRollout,
  runDatabaseMigrations,
} from "@workspace/db";
import { runNflStandingsRefresh } from "../lib/nflStandingsRefresh";

async function main(): Promise<void> {
  await runDatabaseMigrations();
  await ensureOwnerPositionRollout();
  const result = await runNflStandingsRefresh({
    requestedBy: "scheduled_deployment",
    requestId: process.env["REPLIT_DEPLOYMENT_ID"],
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