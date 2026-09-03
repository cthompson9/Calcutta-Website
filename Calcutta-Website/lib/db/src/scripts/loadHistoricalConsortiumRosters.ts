import { resolve } from "node:path";
import {
  closeDatabasePool,
  loadHistoricalConsortiumRosters,
  runDatabaseMigrations,
} from "../index";

async function main() {
  await runDatabaseMigrations();
  const result = await loadHistoricalConsortiumRosters(
    resolve(process.cwd(), "../../decisions/historical-consortium-rosters.txt"),
  );
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });