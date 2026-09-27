import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { and, eq } from "drizzle-orm";

const canRun = Boolean(process.env.DATABASE_URL);
let app, db, runDatabaseMigrations;
let seasonsTable, calcuttasTable, teamsTable, calcuttaEntriesTable, biddersTable, positionsTable;
let auctionSessionsTable, auctionLotsTable, auctionEventsTable, auctionConsortiaTable, auctionSalesTable, auctionSaleAllocationsTable;

if (canRun) {
  ({
    db, runDatabaseMigrations, seasonsTable, calcuttasTable, teamsTable, calcuttaEntriesTable, biddersTable, positionsTable,
    auctionSessionsTable, auctionLotsTable, auctionEventsTable, auctionConsortiaTable, auctionSalesTable, auctionSaleAllocationsTable,
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
  let server, baseUrl, season, calcutta, entry, auction, team, resetBidder;
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
    if (resetBidder) await db.delete(biddersTable).where(eq(biddersTable.id, resetBidder.id));
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

  test("reset requires exact confirmation and clears only an unfinished run", async () => {
    const [draft] = await db.insert(calcuttasTable).values({
      seasonId: season.id, year: season.year, name: `Reset fixture ${Date.now()}`, sport: "NFL", isCanonical: false,
    }).returning();
    const [draftEntry] = await db.insert(calcuttaEntriesTable).values({ calcuttaId: draft.id, teamId: team.id }).returning();
    const [draftAuction] = await db.insert(auctionSessionsTable).values({
      calcuttaId: draft.id, status: "live", revision: 2, startedAt: new Date(),
    }).returning();
    const [draftLot] = await db.insert(auctionLotsTable).values({
      auctionId: draftAuction.id, entryId: draftEntry.id, externalId: `reset-${draftEntry.id}`,
      displayName: team.name, status: "sold", nominationSequence: 1, currentBidCents: 1200,
    }).returning();
    [resetBidder] = await db.insert(biddersTable).values({ name: `Reset owner ${Date.now()}` }).returning();
    const [roster] = await db.insert(auctionConsortiaTable).values({
      auctionId: draftAuction.id, bidderId: resetBidder.id, displayName: "Test roster",
    }).returning();
    const [sale] = await db.insert(auctionSalesTable).values({
      auctionId: draftAuction.id, lotId: draftLot.id, totalCents: 1200,
    }).returning();
    await db.insert(auctionSaleAllocationsTable).values({
      saleId: sale.id, consortiumId: roster.id, bidderId: resetBidder.id, share: "1.000000", cents: 1200,
    });
    await db.insert(positionsTable).values({
      entryId: draftEntry.id, bidderId: resetBidder.id, ownershipShare: "1.000000", costBasis: "12.00", source: "primary",
    });
    const url = `${baseUrl}/api/calcuttas/${draft.id}/auctions/${draftAuction.id}/reset`;
    const send = (body, authorized = true) => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: "Bearer auction-lifecycle-test" } : {}) },
      body: JSON.stringify(body),
    });
    const confirmation = `DELETE DRAFT ${draftAuction.id}`;
    assert.equal((await send({ expectedRevision: 2, confirmation }, false)).status, 401);
    assert.equal((await send({ expectedRevision: 2, confirmation: `${confirmation} ` })).status, 400);
    // A current revision is required even when the confirmation is correct.
    assert.equal((await send({ expectedRevision: 1, confirmation })).status, 409);
    await db.update(positionsTable).set({ costBasis: "13.00" }).where(eq(positionsTable.entryId, draftEntry.id));
    assert.equal((await send({ expectedRevision: 2, confirmation })).status, 409);
    assert.equal((await db.select().from(auctionSalesTable).where(eq(auctionSalesTable.id, sale.id))).length, 1);
    await db.update(positionsTable).set({ costBasis: "12.00" }).where(eq(positionsTable.entryId, draftEntry.id));
    const reset = await send({ expectedRevision: 2, confirmation });
    assert.equal(reset.status, 200);
    const snapshot = await reset.json();
    assert.equal(snapshot.id, draftAuction.id);
    assert.equal(snapshot.status, "setup");
    assert.equal(snapshot.revision, 3);
    assert.equal(snapshot.startedAt, null);
    assert.equal(snapshot.currentLotId, null);
    assert.equal(snapshot.sales.length, 0);
    assert.equal(snapshot.lots[0].id, draftLot.id);
    assert.equal(snapshot.lots[0].status, "available");
    assert.equal(snapshot.lots[0].nominationSequence, null);
    assert.equal(snapshot.lots[0].currentBidCents, null);
    assert.equal(snapshot.consortia[0].id, roster.id);
    assert.equal((await db.select().from(positionsTable).where(eq(positionsTable.entryId, draftEntry.id))).length, 0);
    assert.equal((await db.select().from(auctionEventsTable).where(and(
      eq(auctionEventsTable.auctionId, draftAuction.id), eq(auctionEventsTable.eventType, "auction_reset"),
    ))).length, 1);
    assert.equal((await send({ expectedRevision: 2, confirmation })).status, 409);

    const restarted = await fetch(`${baseUrl}/api/calcuttas/${draft.id}/auctions/${draftAuction.id}/start`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer auction-lifecycle-test" },
      body: JSON.stringify({ expectedRevision: 3 }),
    });
    assert.equal(restarted.status, 200);
    await db.update(auctionSessionsTable).set({ status: "complete" }).where(eq(auctionSessionsTable.id, draftAuction.id));
    assert.equal((await send({ expectedRevision: 4, confirmation })).status, 409);
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