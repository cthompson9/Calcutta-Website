import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;

let db;
let seasonsTable;
let teamsTable;
let teamResultsTable;
let app;

if (DATABASE_URL) {
  ({ db, seasonsTable, teamsTable, teamResultsTable } =
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

describe("team result records", { skip: !DATABASE_URL }, () => {
  let seasonYear;
  let seasonId;
  let teamId;
  let legacyTeamId;
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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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

    const results = await fetch(`${baseUrl}/api/results?season=${seasonYear}`);
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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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

    const results = await fetch(`${baseUrl}/api/results?season=${seasonYear}`);
    assert.equal(results.status, 200);
    const rows = await results.json();
    const legacyRow = rows.find((entry) => entry.teamId === legacyTeamId);
    assert.deepEqual(
      { wins: legacyRow.wins, losses: legacyRow.losses, ties: legacyRow.ties },
      { wins: 7, losses: 9, ties: 1 },
    );
  });
});
