import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";

const canRun = Boolean(process.env.DATABASE_URL);
let app, db, runDatabaseMigrations;
let seasonsTable, calcuttasTable, teamsTable, calcuttaEntriesTable, biddersTable;
let auctionSessionsTable, auctionLotsTable, auctionConsortiaTable, auctionSalesTable, auctionSaleAllocationsTable, positionsTable;

if (canRun) {
  ({
    db, runDatabaseMigrations, seasonsTable, calcuttasTable, teamsTable, calcuttaEntriesTable, biddersTable,
    auctionSessionsTable, auctionLotsTable, auctionConsortiaTable, auctionSalesTable, auctionSaleAllocationsTable, positionsTable,
  } = await import("@workspace/db"));
  ({ default: app } = await import("../app.ts"));
}

function startServer(expressApp) {
  return new Promise((resolve) => {
    const server = http.createServer(expressApp);
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

describe("auction consortium multi-owner roster", { skip: !canRun }, () => {
  let server, baseUrl, season, calcutta, auction, entries = [], lots = [], teams = [];
  const savedAdminKey = process.env.ADMIN_API_KEY;
  const auth = { Authorization: "Bearer auction-consortium-test", "Content-Type": "application/json" };
  async function post(path, body) {
    return fetch(`${baseUrl}/api${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  }
  async function patch(path, body) {
    return fetch(`${baseUrl}/api${path}`, { method: "PATCH", headers: auth, body: JSON.stringify(body) });
  }

  before(async () => {
    await runDatabaseMigrations();
    const fixture = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    [season] = await db.insert(seasonsTable).values({
      year: 9000 + (Date.now() % 500), label: `auction consortium ${fixture}`, isActive: false, isComplete: false,
    }).returning();
    [calcutta] = await db.insert(calcuttasTable).values({
      seasonId: season.id, year: season.year, name: `auction consortium ${fixture}`, sport: "NFL", isCanonical: false,
    }).returning();
    for (let i = 0; i < 3; i++) {
      const [entryTeam] = await db.insert(teamsTable).values({
        name: `auction consortium ${fixture} ${i}`, sport: "NFL", conference: "NFL", division: "Participants",
      }).returning();
      teams.push(entryTeam);
      const [entry] = await db.insert(calcuttaEntriesTable).values({ calcuttaId: calcutta.id, teamId: entryTeam.id }).returning();
      entries.push(entry);
    }
    [auction] = await db.insert(auctionSessionsTable).values({ calcuttaId: calcutta.id }).returning();
    for (let i = 0; i < entries.length; i++) {
      const [lot] = await db.insert(auctionLotsTable).values({
        auctionId: auction.id, externalId: `consortium-${entries[i].id}`, displayName: `Lot ${i + 1}`,
        entryId: entries[i].id, status: "bidding",
      }).returning();
      lots.push(lot);
    }
    process.env.ADMIN_API_KEY = "auction-consortium-test";
    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (season) await db.delete(seasonsTable).where(eq(seasonsTable.id, season.id));
    for (const entryTeam of teams) await db.delete(teamsTable).where(eq(teamsTable.id, entryTeam.id));
    if (savedAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = savedAdminKey;
  });

  test("creates equal and unequal rosters, expands sales/corrections, and preserves the legacy path", async () => {
    const base = `/calcuttas/${calcutta.id}/auctions/${auction.id}`;
    const [unmappedLegacy] = await db.insert(auctionConsortiaTable).values({
      auctionId: auction.id, displayName: "Legacy consortium without bidder mapping", bidderId: null,
    }).returning();
    const unmappedSnapshotResponse = await fetch(`${baseUrl}/api${base}`);
    assert.equal(unmappedSnapshotResponse.status, 200);
    const unmappedSnapshot = await unmappedSnapshotResponse.json();
    const unmappedConsortium = unmappedSnapshot.consortia.find((consortium) => consortium.id === unmappedLegacy.id);
    assert.ok(unmappedConsortium);
    assert.deepEqual(unmappedConsortium.owners, []);

    const invalidShares = await post(`${base}/consortia`, {
      displayName: "Invalid", expectedRevision: 0,
      owners: [{ newBidderName: `Invalid ${Date.now()}`, share: 0.4 }, { newBidderName: `Other ${Date.now()}`, share: 0.4 }],
    });
    assert.equal(invalidShares.status, 422);

    const equalResponse = await post(`${base}/consortia`, {
      displayName: "Equal owners", expectedRevision: 0,
      owners: [
        { newBidderName: ` Equal Owner A ${Date.now()} `, share: 0.5 },
        { newBidderName: `Equal Owner B ${Date.now()}`, share: 0.5 },
      ],
    });
    assert.equal(equalResponse.status, 201);
    const equal = await equalResponse.json();
    assert.deepEqual(equal.owners.map((owner) => owner.share), [0.5, 0.5]);
    assert.equal(equal.bidderId, null);

    const firstOwner = equal.owners[0];
    const duplicateName = await post(`${base}/consortia`, {
      displayName: "Name duplicate", expectedRevision: 1,
      owners: [{ newBidderName: firstOwner.bidderName.toUpperCase(), share: 1 }],
    });
    assert.equal(duplicateName.status, 409);
    const duplicateIdentity = await post(`${base}/consortia`, {
      displayName: "Identity duplicate", expectedRevision: 1,
      owners: [{ bidderId: firstOwner.bidderId, share: 1 }],
    });
    assert.equal(duplicateIdentity.status, 409);

    const unequalResponse = await post(`${base}/consortia`, {
      displayName: "Unequal owners", expectedRevision: 1,
      owners: [
        { newBidderName: `Unequal Owner A ${Date.now()}`, share: 0.6 },
        { newBidderName: `Unequal Owner B ${Date.now()}`, share: 0.4 },
      ],
    });
    assert.equal(unequalResponse.status, 201);
    const unequal = await unequalResponse.json();
    assert.deepEqual(unequal.owners.map((owner) => owner.share), [0.6, 0.4]);

    const invalidSaleShares = await post(`${base}/lots/${lots[0].id}/sale`, {
      totalCents: 10001, expectedRevision: 2, allocations: [
        { consortiumId: equal.id, share: 0.4 }, { consortiumId: unequal.id, share: 0.5 },
      ],
    });
    assert.equal(invalidSaleShares.status, 422);

    const sale = await post(`${base}/lots/${lots[0].id}/sale`, {
      totalCents: 10001, expectedRevision: 2, allocations: [
        { consortiumId: equal.id, share: 0.5 },
        { consortiumId: unequal.id, share: 0.5 },
      ],
    });
    assert.equal(sale.status, 200);
    const sold = await sale.json();
    const saleRow = sold.sales.find((item) => item.lotId === lots[0].id);
    assert.equal(saleRow.allocations.reduce((sum, allocation) => sum + allocation.cents, 0), 10001);
    assert.equal(saleRow.allocations.reduce((sum, allocation) => sum + Number(allocation.share), 0), 1);
    assert.deepEqual(saleRow.allocations.map((allocation) => allocation.consortiumId).sort((a, b) => a - b), [
      equal.id, equal.id, unequal.id, unequal.id,
    ].sort((a, b) => a - b));
    assert.deepEqual(saleRow.allocations.map((allocation) => Math.round(Number(allocation.share) * 10000)).sort((a, b) => a - b), [2000, 2500, 2500, 3000]);

    const correction = await patch(`${base}/lots/${lots[0].id}/sale`, {
      totalCents: 10003, expectedRevision: 3, reason: "Corrected split", idempotencyKey: `correction-${Date.now()}`,
      allocations: [{ consortiumId: equal.id, share: 1 }],
    });
    assert.equal(correction.status, 200);
    const corrected = await correction.json();
    const correctedSale = corrected.sales.find((item) => item.lotId === lots[0].id);
    assert.deepEqual(correctedSale.allocations.map((allocation) => allocation.consortiumId), [equal.id, equal.id]);
    assert.equal(correctedSale.allocations.reduce((sum, allocation) => sum + allocation.cents, 0), 10003);
    assert.deepEqual(correctedSale.allocations.map((allocation) => Math.round(Number(allocation.share) * 10000)).sort((a, b) => a - b), [5000, 5000]);

    const lockedEdit = await patch(`${base}/consortia/${equal.id}`, {
      expectedRevision: 4, owners: [{ bidderId: firstOwner.bidderId, share: 1 }],
    });
    assert.equal(lockedEdit.status, 409);

    const unequalSale = await post(`${base}/lots/${lots[1].id}/sale`, {
      totalCents: 10000, expectedRevision: 4,
      allocations: [{ consortiumId: unequal.id, share: 1 }],
    });
    assert.equal(unequalSale.status, 200);
    const unequalSnapshot = await unequalSale.json();
    const unequalAllocations = unequalSnapshot.sales.find((item) => item.lotId === lots[1].id).allocations;
    assert.deepEqual(unequalAllocations.map((allocation) => Math.round(Number(allocation.share) * 10000)).sort((a, b) => a - b), [4000, 6000]);

    const legacyBidderName = `Legacy owner ${Date.now()}`;
    const [legacyBidder] = await db.insert(biddersTable).values({ name: legacyBidderName }).returning();
    const legacyConsortiumResponse = await post(`${base}/consortia`, {
      displayName: "Legacy single owner", expectedRevision: 5, bidderId: legacyBidder.id,
    });
    assert.equal(legacyConsortiumResponse.status, 201);
    const legacyConsortium = await legacyConsortiumResponse.json();
    assert.equal(legacyConsortium.owners.length, 1);
    assert.equal(legacyConsortium.bidderId, legacyConsortium.owners[0].bidderId);
    const legacySale = await post(`${base}/lots/${lots[2].id}/sale`, {
      totalCents: 9999, expectedRevision: 6, allocations: [{ bidderId: legacyConsortium.bidderId, share: 1 }],
    });
    assert.equal(legacySale.status, 200);
    const legacySnapshot = await legacySale.json();
    const legacyAllocations = legacySnapshot.sales.find((item) => item.lotId === lots[2].id).allocations;
    assert.equal(legacyAllocations.length, 1);
    assert.equal(legacyAllocations[0].consortiumId, legacyConsortium.id);
    assert.equal(legacyAllocations[0].cents, 9999);
    assert.equal((await db.select().from(auctionConsortiaTable).where(eq(auctionConsortiaTable.id, legacyConsortium.id))).length, 1);
    assert.equal((await db.select().from(auctionSalesTable).where(eq(auctionSalesTable.lotId, lots[2].id))).length, 1);
    assert.ok((await db.select().from(positionsTable).where(eq(positionsTable.entryId, entries[2].id))).length);
  });
});