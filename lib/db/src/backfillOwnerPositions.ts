import { db } from "./index";
import { runDatabaseMigrations } from "./migrate";
import { ensureOwnerPositionRollout } from "./ownerPositions";

async function main() {
  await runDatabaseMigrations();
  await ensureOwnerPositionRollout();
  process.stdout.write("Backfilled dated consortium memberships and normalized Calcutta positions.\n");
  await db.$client.end();
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await db.$client.end();
  process.exitCode = 1;
});