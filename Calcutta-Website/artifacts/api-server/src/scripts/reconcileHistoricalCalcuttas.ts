import { readFile, readdir } from "node:fs/promises";
import { reconcileHistoricalPools } from "../lib/historicalScoring";

const dataDirectory = new URL("../../../../data/", import.meta.url);
const files = (await readdir(dataDirectory))
  .filter((file) => /^calcutta-\d\d\.json$/.test(file))
  .sort();
const documents = await Promise.all(
  files.map(async (file) =>
    JSON.parse(await readFile(new URL(file, dataDirectory), "utf8")),
  ),
);
const report = reconcileHistoricalPools(documents);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;