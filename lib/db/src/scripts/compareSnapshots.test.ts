import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { compareSnapshots } from "./compareSnapshots";

const fixtures = resolve(
  new URL(".", import.meta.url).pathname,
  "__fixtures__",
);

async function fixture(name: string) {
  return JSON.parse(await readFile(resolve(fixtures, name), "utf8"));
}

test("flags a removed trade and reports its natural key", async () => {
  const [previous, current] = await Promise.all([
    fixture("append-only-trade-before.json"),
    fixture("append-only-trade-after.json"),
  ]);

  const report = compareSnapshots(previous, current);

  assert.equal(report.decreases.length, 1);
  assert.deepEqual(report.decreases[0], {
    table: "trades",
    previousCount: 2,
    currentCount: 1,
    removedNaturalKeys: [
      {
        entry_id: ["NFL", 2026, "Jacksonville Jaguars"],
        from_bidder_id: "Ezra Pemstein",
        to_bidder_id: "Kurt Dehut",
        percentage: "100.00",
        trade_date: "2026-08-23",
      },
    ],
  });
  assert.deepEqual(report.truncations, []);
});

test("ignores a row-count decrease outside the protected tables", async () => {
  const [previous, current] = await Promise.all([
    fixture("mutable-table-before.json"),
    fixture("mutable-table-after.json"),
  ]);

  assert.deepEqual(compareSnapshots(previous, current), {
    decreases: [],
    truncations: [],
  });
});