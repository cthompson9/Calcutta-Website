import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;

function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test(
  "historical V2 endpoints expose only reconciled normalized pools with honest coverage",
  { skip: !DATABASE_URL },
  async (context) => {
    const [{ db }, { default: app }] = await Promise.all([
      import("@workspace/db"),
      import("../app.ts"),
    ]);
    const loaded = await db.execute(sql`
      select count(*)::int as count
        from normalized_import_runs
    `);
    if (Number(loaded.rows[0]?.count ?? 0) !== 11) {
      context.skip("the eleven historical source files are not loaded in this database");
      return;
    }

    const { server, baseUrl } = await startServer(app);
    try {
      const poolsResponse = await fetch(`${baseUrl}/api/v2/pools`);
      assert.equal(poolsResponse.status, 200);
      const pools = await poolsResponse.json();
      assert.deepEqual(
        pools.map((pool) => pool.edition_number),
        [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      );
      assert.equal(pools.length, 11);
      assert.ok(pools.every((pool) =>
        typeof pool.pot_size_available === "boolean" &&
        pool.edition_number <= 11
      ));

      let entryCount = 0;
      let pointCoverage = 0;
      let payoutCoverage = 0;
      let ownerCount = 0;
      let tradeCount = 0;
      let trackingCount = 0;

      for (const pool of pools) {
        const [entriesResponse, ownersResponse, tradesResponse] = await Promise.all([
          fetch(`${baseUrl}/api/v2/pool/${pool.id}/entries`),
          fetch(`${baseUrl}/api/v2/pool/${pool.id}/owners`),
          fetch(`${baseUrl}/api/v2/pool/${pool.id}/trades`),
        ]);
        assert.equal(entriesResponse.status, 200);
        assert.equal(ownersResponse.status, 200);
        assert.equal(tradesResponse.status, 200);
        const [entries, owners, trades] = await Promise.all([
          entriesResponse.json(),
          ownersResponse.json(),
          tradesResponse.json(),
        ]);
        entryCount += entries.length;
        ownerCount += owners.length;
        tradeCount += trades.length;
        pointCoverage += entries.filter((entry) => entry.points_available).length;
        payoutCoverage += entries.filter((entry) => entry.payout_available).length;
        trackingCount += entries.filter((entry) => entry.tracking != null).length;

        assert.ok(entries.every((entry) =>
          entry.price_available === (entry.price != null) &&
          entry.points_available === (entry.points != null) &&
          entry.payout_available === (entry.payout != null) &&
          Array.isArray(entry.teams) &&
          Array.isArray(entry.ownership)
        ));
        assert.ok(owners.every((owner) =>
          owner.cost_available === (owner.cost != null) &&
          owner.payout_available === (owner.payout != null)
        ));
        assert.ok(trades.every((trade) =>
          trade.cash_available === (trade.cash != null)
        ));
      }

      assert.equal(entryCount, 456);
      assert.equal(pointCoverage, 112);
      assert.equal(payoutCoverage, 456);
      assert.equal(ownerCount, 80);
      assert.equal(tradeCount, 118);
      assert.ok(trackingCount > 0);

      const invalid = await fetch(`${baseUrl}/api/v2/pool/not-a-number/entries`);
      assert.equal(invalid.status, 400);
      const outsideHistory = await fetch(`${baseUrl}/api/v2/pool/2147483647/entries`);
      assert.equal(outsideHistory.status, 404);
    } finally {
      await closeServer(server);
    }
  },
);