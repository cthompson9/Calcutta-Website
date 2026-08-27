import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_API_KEY;

let db;
let seasonsTable;
let teamsTable;
let teamResultsTable;
let teamSeasonAuctionsTable;
let calcuttasTable;
let calcuttaEntriesTable;
let positionsTable;
let biddersTable;
let app;

if (DATABASE_URL) {
  ({ db, seasonsTable, teamsTable, teamResultsTable, teamSeasonAuctionsTable, calcuttasTable, calcuttaEntriesTable, positionsTable, biddersTable } =
    await import("@workspace/db"));
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

function stopServer(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("team result records", { skip: !DATABASE_URL || !ADMIN_KEY }, () => {
  let seasonYear;
  let seasonId;
  let teamId;
  let legacyTeamId;
  let canonicalCalcuttaId;
  let fixtureBidderId;
  let server;
  let baseUrl;

  before(async () => {
    seasonYear = 1_500_000_000 + Math.floor(Math.random() * 100_000_000);
    const [season] = await db
      .insert(seasonsTable)
      .values({
        year: seasonYear,
        isActive: false,
        isComplete: false,
        label: "Team-record integration fixture — safe to delete",
      })
      .returning();
    seasonId = season.id;

    const teams = await db
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .limit(2);
    const [team, legacyTeam] = teams;
    assert.ok(team, "an NFL team fixture must exist");
    assert.ok(legacyTeam, "a second NFL team fixture must exist");
    teamId = team.id;
    legacyTeamId = legacyTeam.id;
    await db.insert(teamSeasonAuctionsTable).values({
      seasonId,
      teamId,
      bidAmount: "1000.00",
    });
    const [calcutta] = await db.insert(calcuttasTable).values({
      seasonId,
      year: seasonYear,
      name: `${seasonYear} NFL Calcutta`,
      sport: "NFL",
      isCanonical: true,
    }).returning();
    canonicalCalcuttaId = calcutta.id;
    const entries = await db.insert(calcuttaEntriesTable).values([
      { calcuttaId: calcutta.id, teamId },
      { calcuttaId: calcutta.id, teamId: legacyTeamId },
    ]).returning();
    const [bidder] = await db.select({ id: biddersTable.id }).from(biddersTable).limit(1);
    assert.ok(bidder, "an NFL bidder fixture must exist");
    fixtureBidderId = bidder.id;
    const teamEntry = entries.find((entry) => entry.teamId === teamId);
    assert.ok(teamEntry);
    await db.insert(positionsTable).values({
      entryId: teamEntry.id,
      bidderId: bidder.id,
      ownershipShare: "1.000000",
      source: "primary",
      costBasis: "1000.00",
    });

    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) await stopServer(server);
    if (seasonId)
      await db.delete(seasonsTable).where(eq(seasonsTable.id, seasonId));
  });

  test("defaults an unplayed team to 0-0 and stores a played 0-3-0 record", async () => {
    const unplayedUpsert = await fetch(`${baseUrl}/api/results/upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        teamId,
        seasonYear,
      }),
    });

    assert.equal(unplayedUpsert.status, 200);
    const unplayedRow = await unplayedUpsert.json();
    assert.deepEqual(
      {
        wins: unplayedRow.wins,
        losses: unplayedRow.losses,
        ties: unplayedRow.ties,
      },
      { wins: 0, losses: 0, ties: 0 },
    );

    const upsert = await fetch(`${baseUrl}/api/results/upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        teamId,
        seasonYear,
        wins: 0,
        losses: 3,
        ties: 0,
      }),
    });

    assert.equal(upsert.status, 200);
    const row = await upsert.json();
    assert.deepEqual(
      { wins: row.wins, losses: row.losses, ties: row.ties },
      { wins: 0, losses: 3, ties: 0 },
    );

    const results = await fetch(
      `${baseUrl}/api/results?season=${seasonYear}&basis=realized`,
    );
    assert.equal(results.status, 200);
    const rows = await results.json();
    const storedRow = rows.find((entry) => entry.teamId === teamId);
    assert.deepEqual(
      { wins: storedRow.wins, losses: storedRow.losses, ties: storedRow.ties },
      { wins: 0, losses: 3, ties: 0 },
    );
  });

  test("rejects the legacy fractional-win format", async () => {
    const response = await fetch(`${baseUrl}/api/results/upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        teamId,
        seasonYear,
        wins: 7.5,
      }),
    });

    assert.equal(response.status, 400);
  });

  test("rejects records with more than 17 games", async () => {
    const response = await fetch(`${baseUrl}/api/results/upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        teamId,
        seasonYear,
        wins: 10,
        losses: 8,
        ties: 0,
      }),
    });

    assert.equal(response.status, 400);
  });

  test("normalizes an unbackfilled legacy half-win row in API responses", async () => {
    await db.insert(teamResultsTable).values({
      teamId: legacyTeamId,
      seasonId,
      wins: "7.5",
    });

    const results = await fetch(
      `${baseUrl}/api/results?season=${seasonYear}&basis=realized`,
    );
    assert.equal(results.status, 200);
    const rows = await results.json();
    const legacyRow = rows.find((entry) => entry.teamId === legacyTeamId);
    assert.deepEqual(
      { wins: legacyRow.wins, losses: legacyRow.losses, ties: legacyRow.ties },
      { wins: 7, losses: 9, ties: 1 },
    );
  });

  test("does not persist manual financial results in either Calcutta", async () => {
    const [alternate] = await db.insert(calcuttasTable).values({
      seasonId,
      year: seasonYear,
      name: `${seasonYear} Alternate NFL Calcutta`,
      sport: "NFL",
      isCanonical: false,
    }).returning();
    const [alternateEntry] = await db.insert(calcuttaEntriesTable).values({
      calcuttaId: alternate.id,
      teamId,
    }).returning();
    await db.insert(positionsTable).values({
      entryId: alternateEntry.id,
      bidderId: fixtureBidderId,
      ownershipShare: "1.000000",
      source: "primary",
      costBasis: "2000.00",
    });

    for (const [calcuttaId, realizedReturn, markToMarket] of [
      [canonicalCalcuttaId, 111, 123],
      [alternate.id, 222, 234],
    ]) {
      const response = await fetch(`${baseUrl}/api/results/upsert`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_KEY}`,
        },
        body: JSON.stringify({
          teamId,
          seasonYear,
          calcuttaId,
          realizedReturn,
          markToMarket,
        }),
      });
      assert.equal(response.status, 200);
    }

    const [canonicalResponse, alternateResponse] = await Promise.all([
      fetch(`${baseUrl}/api/results?season=${seasonYear}&calcuttaId=${canonicalCalcuttaId}`),
      fetch(`${baseUrl}/api/results?season=${seasonYear}&calcuttaId=${alternate.id}`),
    ]);
    assert.equal(canonicalResponse.status, 200);
    assert.equal(alternateResponse.status, 200);
    const canonicalRow = (await canonicalResponse.json()).find((row) => row.teamId === teamId);
    const alternateRow = (await alternateResponse.json()).find((row) => row.teamId === teamId);
    assert.notEqual(canonicalRow.realizedReturn, 111);
    assert.notEqual(canonicalRow.markToMarket, 123);
    assert.notEqual(alternateRow.realizedReturn, 222);
    assert.notEqual(alternateRow.markToMarket, 234);
  });
});
