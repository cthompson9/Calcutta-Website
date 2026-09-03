import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;

let app;
let db;
let runDatabaseMigrations;

if (DATABASE_URL) {
  ({ db, runDatabaseMigrations } = await import("@workspace/db"));
  ({ default: app } = await import("../app.ts"));
}

function startServer(expressApp) {
  return new Promise((resolve) => {
    const server = http.createServer(expressApp);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

async function getJson(baseUrl, path, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return body;
}

describe("normalized historical read endpoints", { skip: !DATABASE_URL }, () => {
  let server;
  let baseUrl;
  let historyLoaded = false;

  before(async () => {
    await runDatabaseMigrations();
    const result = await db.execute(sql`
      select count(*)::int as count
      from normalized_import_runs
    `);
    historyLoaded = result.rows[0].count === 11;
    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  test("serves all reconciled pools and canonical owner roll-ups without the live Calcutta XII model", async (context) => {
    if (!historyLoaded) {
      context.skip("the eleven historical source files are not loaded in this database");
      return;
    }

    const pools = await getJson(baseUrl, "/api/v2/pools");
    const crossPoolOwners = await getJson(baseUrl, "/api/v2/owners");
    assert.equal(pools.length, 11);
    assert.equal(crossPoolOwners.length, 82);
    assert.deepEqual(
      pools.map((pool) => pool.editionNumber),
      [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    );
    assert.equal(pools.filter((pool) => pool.potSizeAvailable).length, 11);
    assert.ok(!pools.some((pool) => pool.editionNumber === 12));

    const reports = await Promise.all(
      pools.map(async (pool) => ({
        pool,
        entries: await getJson(baseUrl, `/api/v2/pool/${pool.id}/entries`),
        owners: await getJson(baseUrl, `/api/v2/pool/${pool.id}/owners`),
        trades: await getJson(baseUrl, `/api/v2/pool/${pool.id}/trades`),
      })),
    );
    const entries = reports.flatMap((report) => report.entries);
    const owners = reports.flatMap((report) => report.owners);

    assert.equal(entries.length, 456);
    assert.equal(entries.filter((entry) => entry.pointsAvailable).length, 112);
    assert.equal(entries.filter((entry) => entry.payoutAvailable).length, 456);
    assert.equal(owners.length, 84);
    assert.equal(owners.filter((owner) => owner.payoutAvailable).length, 82);
    assert.equal(
      entries.filter((entry) => {
        const primaryShare = entry.ownership
          .filter((owner) => owner.source === "primary")
          .reduce((total, owner) => total + owner.share, 0);
        return Math.abs(primaryShare - 1) <= 0.000001;
      }).length,
      456,
    );

    const identityNames = new Map();
    for (const owner of owners) {
      const existingName = identityNames.get(owner.ownerId);
      if (existingName) assert.equal(owner.ownerName, existingName);
      identityNames.set(owner.ownerId, owner.ownerName);
    }
    for (const report of reports) {
      for (const entry of report.entries) {
        for (const ownership of entry.ownership) {
          assert.equal(
            identityNames.get(ownership.ownerId),
            ownership.ownerName,
            `${entry.label} owner identity`,
          );
        }
      }
      for (const trade of report.trades) {
        if (trade.fromOwnerId != null) {
          assert.equal(
            identityNames.get(trade.fromOwnerId),
            trade.fromOwnerName,
            `${trade.sheetRef} from-owner identity`,
          );
        }
        if (trade.toOwnerId != null) {
          assert.equal(
            identityNames.get(trade.toOwnerId),
            trade.toOwnerName,
            `${trade.sheetRef} to-owner identity`,
          );
        }
      }
    }

    const editionThree = reports.find((report) => report.pool.editionNumber === 3);
    assert.equal(editionThree.entries.length, 32);
    assert.equal(editionThree.owners.length, 6);
    assert.ok(editionThree.entries.every((entry) => entry.tracking !== undefined));

    const editionTen = reports.find((report) => report.pool.editionNumber === 10);
    for (const tradeOnlyName of ["Ed Zhang", "Greg"]) {
      const owner = editionTen.owners.find(
        (candidate) => candidate.ownerName === tradeOnlyName,
      );
      assert.ok(owner, `${tradeOnlyName} trade-only owner row`);
      assert.equal(owner.lotCount, 0);
      assert.equal(owner.cost, null);
      assert.equal(owner.costAvailable, false);
      assert.equal(owner.payout, null);
      assert.equal(owner.payoutAvailable, false);
    }

    const [expectedEntries, expectedOwners] = await Promise.all([
      db.execute(sql`
        select
          e.id,
          x.points,
          x.realized_return as payout
        from normalized_entries e
        join normalized_expected_entry_results x on x.entry_id = e.id
      `),
      db.execute(sql`
        select c.id as "poolId", o.id as "ownerId", v.cost, v.payout
        from v_owner_results v
        join normalized_calcuttas c
          on c.edition_number = v.ed
         and c.name = v.calcutta
        join normalized_owners o on o.display_name = v.owner
        union all
        select
          x.calcutta_id as "poolId",
          x.owner_id as "ownerId",
          x.cost,
          x.realized as payout
        from normalized_expected_owner_results x
        where (x.cost is not null or x.realized is not null)
          and not exists (
            select 1
            from normalized_positions p
            join normalized_entries e on e.id = p.entry_id
            where e.calcutta_id = x.calcutta_id
              and p.owner_id = x.owner_id
              and p.source = 'primary'
          )
      `),
    ]);
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    for (const expected of expectedEntries.rows) {
      const actual = entriesById.get(expected.id);
      assert.ok(actual, `entry ${expected.id}`);
      assert.equal(actual.points, expected.points == null ? null : Number(expected.points));
      assert.equal(actual.payout, expected.payout == null ? null : Number(expected.payout));
    }
    const ownersByPoolAndId = new Map(
      reports.flatMap((report) =>
        report.owners.map((owner) => [
          `${report.pool.id}:${owner.ownerId}`,
          owner,
        ]),
      ),
    );
    for (const owner of crossPoolOwners) {
      const perPoolOwner = ownersByPoolAndId.get(
        `${owner.poolId}:${owner.ownerId}`,
      );
      assert.ok(perPoolOwner, `cross-pool owner ${owner.ownerId} in pool ${owner.poolId}`);
      assert.equal(owner.ownerName, perPoolOwner.ownerName);
      assert.equal(owner.lotCount, perPoolOwner.lotCount);
      assert.equal(owner.cost, perPoolOwner.cost);
      assert.equal(owner.payout, perPoolOwner.payout);
      assert.ok(owner.editionNumber <= 11);
    }
    assert.equal(expectedOwners.rows.length, 82);
    for (const expected of expectedOwners.rows) {
      const actual = ownersByPoolAndId.get(
        `${expected.poolId}:${expected.ownerId}`,
      );
      assert.ok(actual, `owner ${expected.ownerId} in pool ${expected.poolId}`);
      if (expected.cost == null) {
        assert.equal(actual.cost, null);
      } else {
        assert.equal(actual.cost, Number(expected.cost));
      }
      if (expected.payout == null) {
        assert.equal(actual.payout, null);
      } else {
        assert.equal(actual.payout, Number(expected.payout));
      }
    }
  });

  test("matches every historical Calcutta option to a normalized historical pool", async (context) => {
    if (!historyLoaded) {
      context.skip("the eleven historical source files are not loaded in this database");
      return;
    }

    const [calcuttas, pools] = await Promise.all([
      getJson(baseUrl, "/api/calcuttas"),
      getJson(baseUrl, "/api/v2/pools"),
    ]);
    const historicalOptions = calcuttas.filter(
      (calcutta) =>
        !(calcutta.sport.toUpperCase() === "NFL" && calcutta.year >= 2025),
    );
    const poolKeys = new Set(
      pools.map(
        (pool) =>
          `${pool.name}\u0000${pool.sport.toUpperCase()}\u0000${pool.seasonYear}`,
      ),
    );
    const unmatched = historicalOptions.filter(
      (calcutta) =>
        !poolKeys.has(
          `${calcutta.name}\u0000${calcutta.sport.toUpperCase()}\u0000${calcutta.year}`,
        ),
    );

    assert.ok(
      historicalOptions.some((calcutta) => calcutta.sport.toUpperCase() === "NFL"),
      "historical Calcutta options must include an NFL pool",
    );
    assert.ok(
      historicalOptions.some((calcutta) => calcutta.sport.toUpperCase() !== "NFL"),
      "historical Calcutta options must include a non-NFL pool",
    );
    assert.deepEqual(
      unmatched.map(({ name, sport, year }) => ({ name, sport, year })),
      [],
      "every historical Calcutta option must exactly match a normalized pool by name, sport, and year",
    );
  });

  test("keeps known source and booked-trade variances visible", async (context) => {
    if (!historyLoaded) {
      context.skip("the eleven historical source files are not loaded in this database");
      return;
    }

    const pools = await getJson(baseUrl, "/api/v2/pools");
    const editionOne = pools.find((pool) => pool.editionNumber === 1);
    const editionSeven = pools.find((pool) => pool.editionNumber === 7);

    const editionOneEntries = await getJson(
      baseUrl,
      `/api/v2/pool/${editionOne.id}/entries`,
    );
    assert.equal(editionOne.potSize, 9610);
    assert.equal(editionOne.entryPriceTotal, 9613);
    assert.equal(editionOne.entryPriceTotalAvailable, true);
    assert.equal(editionOne.entryPricePotDifference, 3);
    assert.equal(editionOne.entryPricePotDifferenceAvailable, true);
    assert.equal(editionOne.entryPricePotVarianceStatus, "known_variance");
    assert.equal(
      editionOneEntries.reduce((total, entry) => total + entry.price, 0),
      9613,
    );

    const editionSevenTrades = await getJson(
      baseUrl,
      `/api/v2/pool/${editionSeven.id}/trades`,
    );
    const bookedVariance = editionSevenTrades.find(
      (trade) => trade.sheetRef === "Tracker!B40",
    );
    assert.ok(bookedVariance);
    assert.equal(bookedVariance.scope, "synthetic_book");
    assert.equal(bookedVariance.basis, "lion_king");
    assert.equal(bookedVariance.factor, 3);
    assert.equal(bookedVariance.cash, 14721.022305);
    assert.equal(bookedVariance.cashAvailable, true);
    assert.equal(bookedVariance.knownBookVariance, true);
    assert.equal(bookedVariance.derivedCash, 16027.02602230483);
    assert.equal(bookedVariance.derivedCashAvailable, true);
    assert.equal(
      bookedVariance.absoluteCashDifference,
      16027.02602230483 - 14721.022305,
    );
    assert.equal(bookedVariance.absoluteCashDifferenceAvailable, true);

    const knownVarianceRefs = [];
    for (const edition of [7, 9, 10]) {
      const pool = pools.find((candidate) => candidate.editionNumber === edition);
      const trades = await getJson(
        baseUrl,
        `/api/v2/pool/${pool.id}/trades`,
      );
      knownVarianceRefs.push(
        ...trades
          .filter((trade) => trade.knownBookVariance)
          .map((trade) => `${edition}:${trade.sheetRef}`),
      );
    }
    assert.deepEqual(knownVarianceRefs, [
      "7:Tracker!B40",
      "9:1",
      "10:Tracker!B35",
      "10:Tracker!B36",
      "10:Tracker!B37",
    ]);
  });

  test("returns validated errors for invalid and missing pool ids", async () => {
    assert.deepEqual(
      await getJson(baseUrl, "/api/v2/pool/not-a-number/entries", 400),
      { error: "Historical pool id must be a positive integer." },
    );
    assert.deepEqual(
      await getJson(baseUrl, "/api/v2/pool/999999999/owners", 404),
      { error: "Historical pool not found." },
    );
  });

  test("excludes normalized Calcutta XII from every historical read", async () => {
    const existing = await db.execute(sql`
      select id from normalized_calcuttas where edition_number = 12
    `);
    let poolId = Number(existing.rows[0]?.id ?? 0);
    let inserted = false;
    if (!poolId) {
      const result = await db.execute(sql`
        insert into normalized_calcuttas(
          edition_number,
          name,
          sport,
          format_key,
          season_year,
          normalization,
          status
        )
        select
          12,
          '__historical_boundary_test__',
          sport,
          format_key,
          2026,
          '{}'::jsonb,
          'live'
        from normalized_calcuttas
        where edition_number = 11
        returning id
      `);
      poolId = Number(result.rows[0]?.id ?? 0);
      inserted = true;
    }
    assert.ok(poolId);

    try {
      const pools = await getJson(baseUrl, "/api/v2/pools");
      const crossPoolOwners = await getJson(baseUrl, "/api/v2/owners");
      assert.ok(!pools.some((pool) => pool.editionNumber >= 12));
      assert.ok(!crossPoolOwners.some((owner) => owner.editionNumber >= 12));
      await getJson(baseUrl, `/api/v2/pool/${poolId}/entries`, 404);
      await getJson(baseUrl, `/api/v2/pool/${poolId}/owners`, 404);
      await getJson(baseUrl, `/api/v2/pool/${poolId}/trades`, 404);
    } finally {
      if (inserted) {
        await db.execute(sql`
          delete from normalized_calcuttas where id = ${poolId}
        `);
      }
    }
  });
});