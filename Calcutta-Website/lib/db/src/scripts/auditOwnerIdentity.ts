import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadOwnerIdentityFile,
  validateOwnerIdentity,
} from "../ownerIdentity";

const dataDirectory = resolve(process.cwd(), "../../data");
const decisionPath = resolve(process.cwd(), "../../decisions/owner-identity.yaml");
const files = (await readdir(dataDirectory))
  .filter((file) => /^calcutta-\d\d\.json$/.test(file))
  .sort();
const documents = await Promise.all(
  files.map(async (file) =>
    JSON.parse(await readFile(resolve(dataDirectory, file), "utf8")),
  ),
);
const mapping = await loadOwnerIdentityFile(decisionPath);
const report = validateOwnerIdentity(mapping, documents);
console.log(
  JSON.stringify(
    {
      generatedFrom: "decisions/owner-identity.yaml",
      reviewedStatus: mapping.reviewStatus,
      sourceFiles: files.length,
      ...report,
      nonMerges: mapping.nonMerges,
    },
    null,
    2,
  ),
);
if (!report.passed) process.exitCode = 1;