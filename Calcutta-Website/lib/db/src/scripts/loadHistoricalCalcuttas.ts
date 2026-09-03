import { resolve } from "node:path";
import {
  closeDatabasePool,
  loadAllHistoricalCalcuttas,
  runDatabaseMigrations,
} from "../index";

const dataDirectory = resolve(process.cwd(), "../../data");
try {
  await runDatabaseMigrations();
  const results = await loadAllHistoricalCalcuttas(dataDirectory);
  console.log(
    JSON.stringify(
      {
        loaded: results.filter((result) => result.loaded).length,
        unchanged: results.filter((result) => !result.loaded).length,
        pools: results,
      },
      null,
      2,
    ),
  );
} finally {
  await closeDatabasePool();
}