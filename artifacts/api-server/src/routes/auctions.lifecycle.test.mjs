import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { and, eq } from "drizzle-orm";

const canRun = Boolean(process.env.DATABASE_URL);
let app, db, runDatabaseMigrations;
let seasonsTable, calcuttasTable, teamsTable, calcuttaEntriesTable;
let auctionSessionsTable, auctionLotsTable, auctionEventsTable;

if (canRun) {
  ({
    db, runDatabaseMigrations, seasonsTable, calcuttasTable, teamsTable, calcuttaEntriesTable,
    auctionSessionsTable, auctionLotsTable, auctionEventsTable,
  } = await import("@workspace/db"));
  ({ default: app } = await import("../app.ts"));
}

function startServer(expressApp) {
  return new Promise((resolve) => {
    const server = http.createServer(expressApp);
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

describe("auction start lifecycle", { skip: !canRun }, () => {
  let server, baseUrl, season, calcutta, entry, auction, team;
  const savedAdminKey = process.env.ADMIN_API_KEY;

  before(async () => {
    await runDatabaseMigrations();
    const fixture = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    [season] = await db.insert(seasonsTable).values({
      year: 9000 + (Date.now() % 500),
      label: `auction lifecycle ${fixture}`,
      isActive: false,
      isComplete: false,
    }).returning();
    [calcutta] = await db.insert(calcuttasTable).values({
      seasonId: season.id, year: season.year, name: `auction lifecycle ${fixture}`, sport: "NFL", isCanonical: false,
    }).returning();
    [team] = await db.insert(teamsTable).values({
      name: `auction lifecycle ${fixture}`, sport: "NFL", conference: "NFL", division: "Participants",
    }).returning();
    [entry] = await db.insert(calcuttaEntriesTable).values({ calcuttaId: calcutta.id, teamId: team.id }).returning();
    [auction] = await db.insert(auctionSessionsTable).values({ calcuttaId: calcutta.id }).returning();
    await db.insert(auctionLotsTable).values({
      auctionId: auction.id,
      externalId: `lifecycle-${entry.id}`,
      displayName: team.name,
      entryId: entry.id,
    });
    process.env.ADMIN_API_KEY = "auction-lifecycle-test";
    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (season) await db.delete(seasonsTable).where(eq(seasonsTable.id, season.id));
    if (team) await db.delete(teamsTable).where(eq(teamsTable.id, team.id));
    if (savedAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = savedAdminKey;
  });

  test("starts setup atomically without nominating a lot and rejects replay/stale starts", async () => {
    const url = `${baseUrl}/api/calcuttas/${calcutta.id}/auctions/${auction.id}/start`;
    const unauthorized = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 0 }),
    });
    assert.equal(unauthorized.status, 401);

    const started = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer auction-lifecycle-test", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    assert.equal(started.status, 200);
    const snapshot = await started.json();
    assert.equal(snapshot.status, "live");
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.currentLotId, null);
    assert.ok(snapshot.startedAt);
    assert.equal(snapshot.lots[0].status, "available");
    const events = await db.select().from(auctionEventsTable).where(and(
      eq(auctionEventsTable.auctionId, auction.id),
      eq(auctionEventsTable.eventType, "auction_started"),
    ));
    assert.equal(events.length, 1);

    const stale = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer auction-lifecycle-test", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /stale/i);

    const alreadyLive = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer auction-lifecycle-test", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    assert.equal(alreadyLive.status, 409);
    assert.match((await alreadyLive.json()).error, /already live/i);

    await db.update(auctionSessionsTable).set({ status: "complete" }).where(eq(auctionSessionsTable.id, auction.id));
    const completed = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer auction-lifecycle-test", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    assert.equal(completed.status, 409);
    assert.match((await completed.json()).error, /complete/i);
  });

  test("does not create a session for a completed pool without a session", async () => {
    await db.update(seasonsTable).set({ isComplete: true }).where(eq(seasonsTable.id, season.id));
    const [completedPool] = await db.insert(calcuttasTable).values({
      seasonId: season.id, year: season.year, name: `${calcutta.name} completed no-session`, sport: "MLB", isCanonical: false,
    }).returning();
    const response = await fetch(`${baseUrl}/api/calcuttas/${completedPool.id}/auctions`, {
      method: "POST",
      headers: { Authorization: "Bearer auction-lifecycle-test", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 409);
    const sessions = await db.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.calcuttaId, completedPool.id));
    assert.equal(sessions.length, 0);
  });
});