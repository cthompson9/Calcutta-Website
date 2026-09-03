import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  adaptHistoricalBookTrades,
  calculatePreBookOwnerBooks,
  evaluateHistoricalBookPositions,
  reconcileHistoricalPools,
  scoreHistoricalPool,
} from "./historicalScoring.ts";

async function readHistoricalDocuments() {
  const root = new URL("../../../../data/", import.meta.url);
  const files = (await readdir(root))
    .filter((file) => /^calcutta-\d\d\.json$/.test(file))
    .sort();
  return Promise.all(
    files.map(async (file) =>
      JSON.parse(await readFile(new URL(file, root), "utf8")),
    ),
  );
}

test("the scorer cannot consume expected workbook values", async () => {
  const [document] = await readHistoricalDocuments();
  const entries = document.entries.map((entry, index) => ({
    id: index,
    attributes: entry.attributes,
    events: entry.events,
  }));
  const baseline = scoreHistoricalPool(document, entries);
  document.entries.forEach((entry) => {
    entry.expected.realized_return = 0;
    entry.expected.points = 0;
  });
  const rescored = scoreHistoricalPool(document, entries);
  assert.deepEqual([...rescored.points], [...baseline.points]);
  assert.deepEqual([...rescored.payouts], [...baseline.payouts]);
});

test("all eleven historical pools produce the complete Stage-1 parity report", async () => {
  const report = reconcileHistoricalPools(await readHistoricalDocuments());
  assert.equal(report.passed, true, JSON.stringify(report.pools, null, 2));
  assert.deepEqual(report.totals, {
    teams: { matched: 456, expected: 456 },
    points: { matched: 112, expected: 112 },
    owners: { matched: 82, expected: 82 },
    pots: { matched: 11, expected: 11 },
    splits: { matched: 456, expected: 456 },
    books: { matched: 4, expected: 9, knownVariances: 5 },
  });
  assert.deepEqual(report.sourceVariances, [
    {
      edition: 1,
      kind: "entry_prices_vs_pot",
      expected: 9610,
      actual: 9613,
    },
  ]);
  assert.deepEqual(
    report.knownBookVariances.map((variance) => variance.id),
    [
      "7:Tracker!B40",
      "9:1",
      "10:Tracker!B35",
      "10:Tracker!B36",
      "10:Tracker!B37",
    ],
  );
  assert.equal(report.pools.length, 11);
  assert.ok(report.pools.every((pool) => pool.mismatches.length === 0));
});

test("book variance exceptions fail closed outside the exact source allowlist", async () => {
  const documents = await readHistoricalDocuments();
  const calcuttaSeven = documents.find((document) => document.edition === 7);
  const sourceTrade = calcuttaSeven.trades.find(
    (trade) => trade.sheet_ref === "Tracker!B40",
  );
  sourceTrade.cash += 1;
  const report = reconcileHistoricalPools(documents);
  assert.equal(report.passed, false);
  assert.ok(
    report.pools
      .find((pool) => pool.edition === 7)
      .mismatches.some((mismatch) => mismatch.includes("7:Tracker!B40")),
  );
});

test("Lion King book spreads reproduce the four computable historical controls", async () => {
  const documents = await readHistoricalDocuments();
  const cases = [
    {
      edition: 3,
      long: "Sam R.",
      short: "Zach L.",
      unitAbsolute: 101.23326923076979,
      factor: 0.1,
      valueAbsolute: 10.12332692307698,
    },
    {
      edition: 5,
      long: "Sam",
      short: "Zach",
      unitAbsolute: 1342.384,
      factor: 1,
      valueAbsolute: 1342.384,
    },
    {
      edition: 6,
      long: "Sam",
      short: "Zach",
      unitAbsolute: 6158.0125,
      factor: 0.5,
      valueAbsolute: 3079.00625,
    },
    {
      edition: 8,
      long: "Samuel Rosen",
      short: "Zachary Long",
      unitAbsolute: 7686.628721541158,
      factor: 1,
      valueAbsolute: 7686.628721541158,
    },
  ];
  for (const control of cases) {
    const document = documents.find(
      (candidate) => candidate.edition === control.edition,
    );
    const entries = document.entries.map((entry, index) => ({
      ...entry,
      id: index,
    }));
    const scored = scoreHistoricalPool(document, entries);
    const books = calculatePreBookOwnerBooks(
      entries,
      scored.payouts,
      "lion_king",
    );
    assert.ok(
      Math.abs(
        Math.abs(books.get(control.long) - books.get(control.short)) -
          control.unitAbsolute,
      ) <= 0.000001,
      `Calcutta ${control.edition} unit spread`,
    );
    const sourcePositions = adaptHistoricalBookTrades(document);
    assert.equal(sourcePositions.length, 1);
    assert.equal(sourcePositions[0].factor, control.factor);
    const result = evaluateHistoricalBookPositions(
      entries,
      scored.payouts,
      sourcePositions,
    );
    assert.ok(
      Math.abs(
        Math.abs(result.evaluations[0].derivedValue) -
          control.valueAbsolute,
      ) <= 0.000001,
      `Calcutta ${control.edition} levered value`,
    );
    assert.ok(
      Math.abs(
        [...result.ownerImpacts.values()].reduce(
          (total, value) => total + value,
          0,
        ),
      ) <= 0.000001,
    );
  }
});

test("book evaluation records known historical variances and uses pre-book values for stacked instruments", async () => {
  const documents = await readHistoricalDocuments();
  const variances = [
    {
      edition: 7,
      long: "Zach",
      short: "Sam",
      factor: 3,
      booked: 14721.022305,
    },
    {
      edition: 9,
      long: "Zach",
      short: "Sam",
      factor: 0.25,
      booked: 6166.698611,
    },
    {
      edition: 10,
      long: "SR",
      short: "ZL",
      factor: 2,
      booked: 2964.963504,
    },
  ];
  for (const variance of variances) {
    const document = documents.find(
      (candidate) => candidate.edition === variance.edition,
    );
    const entries = document.entries.map((entry, index) => ({
      ...entry,
      id: index,
    }));
    const scored = scoreHistoricalPool(document, entries);
    const sourcePositions = adaptHistoricalBookTrades(document);
    const sourcePosition = sourcePositions.find(
      (position) => position.factor === variance.factor,
    );
    assert.ok(sourcePosition, `Calcutta ${variance.edition} source position`);
    assert.equal(Math.abs(sourcePosition.bookedCash), Math.abs(variance.booked));
    const result = evaluateHistoricalBookPositions(
      entries,
      scored.payouts,
      [sourcePosition],
    );
    assert.ok(
      Math.abs(
        Math.abs(result.evaluations[0].derivedValue) -
          Math.abs(variance.booked),
      ) > 0.01,
      `Calcutta ${variance.edition} must remain a known variance`,
    );
    assert.equal(result.evaluations[0].usedBookedCash, false);
  }

  const calcuttaTen = documents.find((document) => document.edition === 10);
  const entries = calcuttaTen.entries.map((entry, index) => ({
    ...entry,
    id: index,
  }));
  const scored = scoreHistoricalPool(calcuttaTen, entries);
  const stacked = evaluateHistoricalBookPositions(
    entries,
    scored.payouts,
    adaptHistoricalBookTrades(calcuttaTen),
  );
  assert.deepEqual(
    stacked.evaluations.map((evaluation) => evaluation.id),
    ["10:Tracker!B35", "10:Tracker!B36", "10:Tracker!B37"],
  );
  const expectedStackedValues = [
    5404.817518248175,
    2702.4087591240873,
    12.759124087591227,
  ];
  stacked.evaluations.forEach((evaluation, index) => {
    assert.ok(
      Math.abs(evaluation.derivedValue - expectedStackedValues[index]) <=
        0.000001,
      `${evaluation.id} must use the immutable pre-book value`,
    );
  });
  assert.ok(
    Math.abs(
      [...stacked.ownerImpacts.values()].reduce(
        (total, value) => total + value,
        0,
      ),
    ) <= 0.000001,
  );

  const calcuttaFour = documents.find((document) => document.edition === 4);
  const fourEntries = calcuttaFour.entries.map((entry, index) => ({
    ...entry,
    id: index,
  }));
  const fourScored = scoreHistoricalPool(calcuttaFour, fourEntries);
  const carried = evaluateHistoricalBookPositions(
    fourEntries,
    fourScored.payouts,
    adaptHistoricalBookTrades(calcuttaFour),
  );
  assert.equal(carried.evaluations[0].derivedValue, null);
  assert.equal(carried.evaluations[0].usedBookedCash, true);
});