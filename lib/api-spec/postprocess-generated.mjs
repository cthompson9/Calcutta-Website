import { readFile, writeFile } from "node:fs/promises";

// Orval emits operation parameter schemas in generated/api.ts and also emits
// identically named TypeScript parameter aliases under generated/types. The
// barrel intentionally exports both, so give the aliases a stable suffix
// after every generation rather than hand-editing generated output.
for (const name of ["getAuctionEventsParams"]) {
  const path = new URL(`../api-zod/src/generated/types/${name}.ts`, import.meta.url);
  const source = await readFile(path, "utf8");
  const exported = name.replace(/^./, (c) => c.toUpperCase());
  await writeFile(path, source.replaceAll(`export type ${exported}`, `export type ${exported}Type`));
}