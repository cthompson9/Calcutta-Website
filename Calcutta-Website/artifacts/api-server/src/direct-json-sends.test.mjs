import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceRoot = path.resolve(import.meta.dirname);

function collectTypeScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? collectTypeScriptFiles(entryPath)
      : entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

test("API handlers do not send JSON directly", () => {
  const files = [
    path.join(sourceRoot, "app.ts"),
    ...collectTypeScriptFiles(path.join(sourceRoot, "routes")),
  ];
  const violations = files.flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    return [...source.matchAll(/\b(?:res|response)\s*(?:\.\s*status\s*\([^)]*\))?\s*\.\s*json\s*\(/g)]
      .map((match) => `${path.relative(sourceRoot, file)}:${match.index}`);
  });
  assert.deepEqual(violations, []);
});