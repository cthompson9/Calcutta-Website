import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;

let db;
let seasonsTable;
let teamsTable;
let biddersTable;
let consortiaTable;
let consortiumMembershipsTable;
let teamSeasonAuctionsTable;
let teamBiddersTable;
let teamResultsTable;
let tradesTable;
let positionsTable;
let calcuttaEntriesTable;
let calcuttasTable;
let app;
let syncSeasonPositions;
let ensureOwnerPositionRollout;
let runDatabaseMigrations;

if (DATABASE_URL) {
  ({
    db,
    seasonsTable,
    teamsTable,
    biddersTable,
    consortiaTable,
    consortiumMembershipsTable,
    teamSeasonAuctionsTable,
    teamBiddersTable,
    teamResultsTable,
    tradesTable,
    positionsTable,
    calcuttaEntriesTable,
    calcuttasTable,
    syncSeasonPositions,
    ensureOwnerPositionRollout,
    runDatabaseMigrations,
  } = await import("@workspace/db"));
  ({ default: app } = await import("../app.ts"));
}

function startServer(expressApp) {
  return new Promise((resolve) => {
    const server = http.createServer(expressApp);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe("owner positions and dated consortium rollups", { skip: !DATABASE_URL }, () => {
  let seasonId;
  let seasonYear;
  let teamId;
  let sellerId;
  let buyerId;
  let server;
  let baseUrl;

  before(async () => {
    await runDatabaseMigrations();
    await ensureOwnerPositionRollout();
    seasonYear = 2800 + Math.floor(Math.random() * 100);
    const [season] = await db.insert(seasonsTable).values({
      year: seasonYear,
      isActive: false,
      isComplete: false,
      label: "Owner position integration fixture — safe to delete",
    }).returning();
    seasonId = season.id;
    const [team] = await db.select({ id: teamsTable.id }).from(teamsTable).limit(1);
    teamId = team.id;
    const [historic] = await db.insert(consortiaTable).values({
      name: `Historic consortium ${seasonYear}`,
    }).returning();
    const [current] = await db.insert(consortiaTable).values({
      name: `Current consortium ${seasonYear}`,
    }).returning();
    const [seller] = await db.insert(biddersTable).values({
      name: `Seller ${seasonYear}`,
      consortiumId: historic.id,
    }).returning();
    const [buyer] = await db.insert(biddersTable).values({
      name: `Buyer ${seasonYear}`,
    }).returning();
    sellerId = seller.id;
    buyerId = buyer.id;
    await db.insert(consortiumMembershipsTable).values([
      {
        bidderId: sellerId,
        consortiumId: historic.id,
        fromDate: `${seasonYear}-01-01`,
        toDate: `${seasonYear}-09-01`,
      },
      {
        bidderId: sellerId,
        consortiumId: current.id,
        fromDate: `${seasonYear}-09-01`,
      },
    ]);
    await db.insert(teamSeasonAuctionsTable).values({
      seasonId,
      teamId,
      bidAmount: "100.00",
    });
    await db.insert(teamBiddersTable).values({
      seasonId,
      teamId,
      bidderId: sellerId,
      ownershipShare: "1.0000",
    });
    await db.insert(teamResultsTable).values({
      seasonId,
      teamId,
      realizedReturn: "100.00",
      markToMarket: "100.00",
    });
    await db.insert(tradesTable).values({
      seasonId,
      teamId,
      fromBidderId: sellerId,
      toBidderId: buyerId,
      percentage: "50.00",
      price: "50.00",
      status: "approved",
      tradeDate: `${seasonYear}-09-15`,
    });
    await syncSeasonPositions(db, seasonId);
    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    if (seasonId) await db.delete(seasonsTable).where(eq(seasonsTable.id, seasonId));
    if (sellerId || buyerId) {
      await db
        .delete(biddersTable)
        .where(inArray(biddersTable.id, [sellerId, buyerId].filter(Boolean)));
    }
  });

  test("stores signed primary and trade positions totaling exactly 100%", async () => {
    const rows = await db
      .select({
        bidderId: positionsTable.bidderId,
        share: positionsTable.ownershipShare,
        source: positionsTable.source,
        costBasis: positionsTable.costBasis,
      })
      .from(positionsTable)
      .innerJoin(calcuttaEntriesTable, eq(calcuttaEntriesTable.id, positionsTable.entryId))
      .innerJoin(calcuttasTable, eq(calcuttasTable.id, calcuttaEntriesTable.calcuttaId))
      .where(
        and(
          eq(calcuttaEntriesTable.teamId, teamId),
          eq(calcuttasTable.seasonId, seasonId),
        ),
      );

    assert.equal(rows.filter((row) => row.source === "primary").length, 1);
    assert.equal(rows.filter((row) => row.source === "trade").length, 2);
    assert.equal(rows.reduce((total, row) => total + Number(row.share), 0), 1);
    assert.deepEqual(
      rows.map((row) => Number(row.costBasis)).sort((a, b) => a - b),
      [-50, 50, 100],
    );
  });

  test("uses historical membership by default and current roster only when requested", async () => {
    const historical = await fetch(`${baseUrl}/api/results/by-owner?season=${seasonYear}`);
    assert.equal(historical.status, 200);
    const historicalRows = await historical.json();
    const historicalSeller = historicalRows.find((row) => row.bidderId === sellerId);
    assert.equal(historicalSeller.consortium, `Historic consortium ${seasonYear}`);
    assert.equal(historicalSeller.totalRealizedReturn, 50);

    const current = await fetch(`${baseUrl}/api/results/by-owner?season=${seasonYear}&membershipView=current`);
    assert.equal(current.status, 200);
    const currentRows = await current.json();
    const currentSeller = currentRows.find((row) => row.bidderId === sellerId);
    assert.equal(currentSeller.consortium, `Current consortium ${seasonYear}`);
    assert.equal(currentSeller.totalRealizedReturn, 50);
  });

  test("loads owner results for an out-of-range synthetic season without date errors", async () => {
    const syntheticYear = 1_700_000_000 + Math.floor(Math.random() * 10_000);
    const [syntheticSeason] = await db
      .insert(seasonsTable)
      .values({
        year: syntheticYear,
        isActive: false,
        isComplete: false,
        label: "Synthetic date-range regression fixture",
      })
      .returning({ id: seasonsTable.id });
    try {
      const response = await fetch(
        `${baseUrl}/api/results/by-owner?season=${syntheticYear}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), []);
    } finally {
      await db
        .delete(seasonsTable)
        .where(eq(seasonsTable.id, syntheticSeason.id));
    }
  });

  test("backfills a legacy bidder consortium and rejects overlapping memberships", async () => {
    const [legacyGroup] = await db.insert(consortiaTable).values({
      name: `Legacy group ${seasonYear}`,
    }).returning();
    const [legacyBidder] = await db.insert(biddersTable).values({
      name: `Legacy bidder ${seasonYear}`,
      consortiumId: legacyGroup.id,
    }).returning();
    const [legacySeason] = await db.insert(seasonsTable).values({
      year: seasonYear - 1,
      isActive: false,
      isComplete: false,
      label: "Legacy membership rollout fixture",
    }).returning();
    try {
      await ensureOwnerPositionRollout();
      const membership = await db
        .select()
        .from(consortiumMembershipsTable)
        .where(eq(consortiumMembershipsTable.bidderId, legacyBidder.id));
      assert.equal(membership.length, 1);
      assert.equal(membership[0].consortiumId, legacyGroup.id);
      await assert.rejects(
        db.insert(consortiumMembershipsTable).values({
          bidderId: legacyBidder.id,
          consortiumId: legacyGroup.id,
          fromDate: `${seasonYear - 1}-07-01`,
        }),
      );
    } finally {
      await db.delete(seasonsTable).where(eq(seasonsTable.id, legacySeason.id));
      await db.delete(biddersTable).where(eq(biddersTable.id, legacyBidder.id));
    }
  });
});