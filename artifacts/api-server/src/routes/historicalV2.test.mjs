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
    const [{ db }, { default: app }, { loadCalcuttaConsortiums }] = await Promise.all([
      import("@workspace/db"),
      import("../app.ts"),
      import("../lib/consortiumMemberships.ts"),
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
        pools.map((pool) => pool.editionNumber),
        [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      );
      assert.equal(pools.length, 11);
      assert.ok(pools.every((pool) =>
        typeof pool.potSizeAvailable === "boolean" &&
        pool.editionNumber <= 11
      ));

      let entryCount = 0;
      let pointCoverage = 0;
      let payoutCoverage = 0;
      let ownerCount = 0;
      let tradeCount = 0;
      let trackingCount = 0;
      const ownersByEdition = new Map();

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
        ownersByEdition.set(pool.editionNumber, owners);
        entryCount += entries.length;
        ownerCount += owners.length;
        tradeCount += trades.length;
        pointCoverage += entries.filter((entry) => entry.pointsAvailable).length;
        payoutCoverage += entries.filter((entry) => entry.payoutAvailable).length;
        trackingCount += entries.filter((entry) => entry.tracking != null).length;

        assert.ok(entries.every((entry) =>
          entry.priceAvailable === (entry.price != null) &&
          entry.pointsAvailable === (entry.points != null) &&
          entry.payoutAvailable === (entry.payout != null) &&
          Array.isArray(entry.teams) &&
          Array.isArray(entry.ownership)
        ));
        assert.ok(entries.flatMap((entry) => entry.ownership).every((owner) =>
          ["mapped", "unassigned", "not_supplied"].includes(owner.rosterStatus) &&
          Object.hasOwn(owner, "consortium") &&
          Object.hasOwn(owner, "rosterSourceOwnerLabel")
        ));
        assert.ok(owners.every((owner) =>
          owner.costAvailable === (owner.cost != null) &&
          owner.payoutAvailable === (owner.payout != null) &&
          ["mapped", "unassigned", "not_supplied"].includes(owner.rosterStatus)
        ));
        assert.ok(trades.every((trade) =>
          trade.cashAvailable === (trade.cash != null)
        ));
      }

      assert.equal(entryCount, 456);
      assert.equal(pointCoverage, 112);
      assert.equal(payoutCoverage, 456);
      assert.equal(ownerCount, 84);
      assert.equal(tradeCount, 118);
      assert.ok(trackingCount > 0);

      assert.deepEqual(
        {
          consortium: ownersByEdition.get(1).find(
            (owner) => owner.ownerName === "Craig Thompson",
          ).consortium,
          status: ownersByEdition.get(1).find(
            (owner) => owner.ownerName === "Craig Thompson",
          ).rosterStatus,
        },
        { consortium: "Craig T.", status: "mapped" },
      );
      assert.deepEqual(
        {
          consortium: ownersByEdition.get(1).find(
            (owner) => owner.ownerName === "Cameron H.",
          ).consortium,
          status: ownersByEdition.get(1).find(
            (owner) => owner.ownerName === "Cameron H.",
          ).rosterStatus,
        },
        { consortium: null, status: "unassigned" },
      );
      assert.deepEqual(
        {
          consortium: ownersByEdition.get(10).find(
            (owner) => owner.ownerName === "KD [ed10]",
          ).consortium,
          source: ownersByEdition.get(10).find(
            (owner) => owner.ownerName === "KD [ed10]",
          ).rosterSourceOwnerLabel,
        },
        {
          consortium: "Kurt D. / Joey A.",
          source: "Kevin/Daniel?",
        },
      );
      assert.deepEqual(
        {
          consortium: ownersByEdition.get(11).find(
            (owner) => owner.ownerName === "Ezra Pemstein",
          ).consortium,
          status: ownersByEdition.get(11).find(
            (owner) => owner.ownerName === "Ezra Pemstein",
          ).rosterStatus,
        },
        { consortium: null, status: "unassigned" },
      );

      const calcuttaRows = await db.execute(sql`
        select id, year, sport
        from calcuttas
        where (year = 2025 and sport = 'NFL')
           or (year = 2026 and sport = 'NFL')
        order by year
      `);
      const historicalCalcuttaId = Number(calcuttaRows.rows[0].id);
      const liveCalcuttaId = Number(calcuttaRows.rows[1].id);
      const bidderRows = await db.execute(sql`
        select id, name from bidders where name in ('Craig Thompson', 'Zachary Long')
      `);
      const bidderIds = new Map(
        bidderRows.rows.map((row) => [row.name, Number(row.id)]),
      );
      const [historicalRoster, historicalCurrentRoster, liveHistoricalRoster, liveCurrentRoster] =
        await Promise.all([
          loadCalcuttaConsortiums(historicalCalcuttaId, "historical"),
          loadCalcuttaConsortiums(historicalCalcuttaId, "current"),
          loadCalcuttaConsortiums(liveCalcuttaId, "historical"),
          loadCalcuttaConsortiums(liveCalcuttaId, "current"),
        ]);
      assert.equal(
        historicalRoster.get(bidderIds.get("Craig Thompson")),
        "Craig T.",
      );
      assert.equal(
        historicalRoster.get(bidderIds.get("Zachary Long")),
        "Zach L. / Greg K.",
      );
      assert.notEqual(
        historicalRoster.get(bidderIds.get("Craig Thompson")),
        historicalCurrentRoster.get(bidderIds.get("Craig Thompson")),
      );
      assert.equal(
        liveHistoricalRoster.get(bidderIds.get("Craig Thompson")),
        liveCurrentRoster.get(bidderIds.get("Craig Thompson")),
      );

      const invalid = await fetch(`${baseUrl}/api/v2/pool/not-a-number/entries`);
      assert.equal(invalid.status, 400);
      const outsideHistory = await fetch(`${baseUrl}/api/v2/pool/2147483647/entries`);
      assert.equal(outsideHistory.status, 404);
    } finally {
      await closeServer(server);
    }
  },
);