import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

const enabled = Boolean(process.env.DATABASE_URL);
let db, seasonsTable, calcuttasTable, teamsTable, calcuttaEntriesTable, biddersTable;
let auctionSessionsTable, auctionLotsTable, auctionConsortiaTable, auctionConsortiumOwnersTable;
let auctionSalesTable, auctionSaleAllocationsTable, positionsTable, auctionEventsTable, ownershipAdjustmentsTable;
let app;
if (enabled) {
  ({
    db, seasonsTable, calcuttasTable, teamsTable, calcuttaEntriesTable, biddersTable,
    auctionSessionsTable, auctionLotsTable, auctionConsortiaTable, auctionConsortiumOwnersTable,
    auctionSalesTable, auctionSaleAllocationsTable, positionsTable, auctionEventsTable, ownershipAdjustmentsTable,
  } = await import("@workspace/db"));
  ({ default: app } = await import("../app.ts"));
}

test("XIII post-auction correction atomically reallocates sold lots and retains provenance", { skip: !enabled }, async () => {
  const oldKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "post-auction-test";
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const teams = [];
  let season, server;
  const bidders = [];
  try {
    [season] = await db.insert(seasonsTable).values({
      year: 8000 + Math.floor(Math.random() * 1000), label: `XIII correction ${unique}`,
      isActive: false, isComplete: false,
    }).returning();
    const [calcutta] = await db.insert(calcuttasTable).values({
      seasonId: season.id, year: season.year, name: `Calcutta XIII correction ${unique}`,
      sport: "MLB", competitionFormat: "MLB_POSTSEASON", isCanonical: false,
    }).returning();
    const [auction] = await db.insert(auctionSessionsTable).values({
      calcuttaId: calcutta.id, status: "complete", revision: 7,
    }).returning();
    for (const name of ["Kurt", "Joey", "Other"]) {
      const [bidder] = await db.insert(biddersTable).values({ name: `XIII test ${unique} ${name}` }).returning();
      bidders.push(bidder);
    }
    const [group] = await db.insert(auctionConsortiaTable).values({
      auctionId: auction.id, displayName: "Kurt & Joey",
    }).returning();
    const [otherGroup] = await db.insert(auctionConsortiaTable).values({
      auctionId: auction.id, displayName: "Other", bidderId: bidders[2].id,
    }).returning();
    await db.insert(auctionConsortiumOwnersTable).values([
      { auctionId: auction.id, consortiumId: group.id, bidderId: bidders[0].id, share: "0.8500" },
      { auctionId: auction.id, consortiumId: group.id, bidderId: bidders[1].id, share: "0.1500" },
      { auctionId: auction.id, consortiumId: otherGroup.id, bidderId: bidders[2].id, share: "1.0000" },
    ]);
    for (let i = 0; i < 3; i++) {
      const [team] = await db.insert(teamsTable).values({
        name: `XIII test ${unique} ${i}`, sport: "MLB", conference: "MLB", division: "Participants",
      }).returning();
      teams.push(team);
      const [entry] = await db.insert(calcuttaEntriesTable).values({ calcuttaId: calcutta.id, teamId: team.id }).returning();
      const [lot] = await db.insert(auctionLotsTable).values({
        auctionId: auction.id, entryId: entry.id, externalId: `test-${i}-${unique}`,
        displayName: `Test lot ${i}`, status: "sold",
      }).returning();
      const totalCents = i === 0 ? 270000 : 100000;
      const [sale] = await db.insert(auctionSalesTable).values({ auctionId: auction.id, lotId: lot.id, totalCents }).returning();
      const rows = i === 0
        ? [
            { bidderId: bidders[0].id, consortiumId: group.id, share: "0.283300", cents: 76491 },
            { bidderId: bidders[1].id, consortiumId: group.id, share: "0.050000", cents: 13500 },
            { bidderId: bidders[2].id, consortiumId: otherGroup.id, share: "0.666700", cents: 180009 },
          ]
        : [
            { bidderId: bidders[0].id, consortiumId: group.id, share: "0.850000", cents: 85000 },
            { bidderId: bidders[1].id, consortiumId: group.id, share: "0.150000", cents: 15000 },
          ];
      await db.insert(auctionSaleAllocationsTable).values(rows.map((row) => ({ ...row, saleId: sale.id })));
      await db.insert(positionsTable).values(rows.map((row) => ({
        entryId: entry.id, bidderId: row.bidderId, source: "primary",
        ownershipShare: row.share, costBasis: (row.cents / 100).toFixed(2),
      })));
    }
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/calcuttas/${calcutta.id}/auctions/${auction.id}/consortia/${group.id}/correction`;
    const request = (expectedRevision, key, owners = [{ bidderId: bidders[0].id, share: 1 }]) => fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer post-auction-test", "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision, idempotencyKey: key, displayName: "NoJoeyjoji",
        owners, reason: "Correct post-auction consortium ownership",
      }),
    });
    const unauthorized = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    await db.update(auctionSessionsTable).set({ status: "live" }).where(eq(auctionSessionsTable.id, auction.id));
    const premature = await request(7, crypto.randomUUID());
    assert.equal(premature.status, 409);
    await db.update(auctionSessionsTable).set({ status: "complete" }).where(eq(auctionSessionsTable.id, auction.id));
    const stale = await request(6, crypto.randomUUID());
    assert.equal(stale.status, 409);
    const response = await request(7, crypto.randomUUID());
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const corrected = JSON.parse(responseText);
    assert.equal(corrected.status, "complete");
    assert.equal(corrected.revision, 8);
    assert.deepEqual(corrected.consortia.find((c) => c.id === group.id).owners.map((o) => [o.bidderId, o.share]), [[bidders[0].id, 1]]);
    assert.equal(corrected.consortia.find((c) => c.id === group.id).displayName, "NoJoeyjoji");
    assert.equal(corrected.sales.length, 3);
    for (const sale of corrected.sales) {
      assert.equal(sale.allocations.some((a) => a.bidderId === bidders[1].id), false);
      assert.equal(sale.allocations.reduce((sum, a) => sum + a.cents, 0), sale.totalCents);
      assert.equal(Math.round(sale.allocations.reduce((sum, a) => sum + Number(a.share), 0) * 10000), 10000);
    }
    assert.equal(corrected.sales.find((sale) => sale.totalCents === 270000).allocations.find((a) => a.bidderId === bidders[0].id).cents, 89991);
    assert.equal(corrected.sales.find((sale) => sale.totalCents === 270000).allocations.find((a) => a.bidderId === bidders[2].id).cents, 180009);
    assert.equal((await db.select().from(positionsTable).where(eq(positionsTable.bidderId, bidders[1].id))).length, 0);
    assert.equal((await db.select().from(ownershipAdjustmentsTable).where(eq(ownershipAdjustmentsTable.seasonId, season.id))).length, 3);
    const events = await db.select().from(auctionEventsTable).where(eq(auctionEventsTable.auctionId, auction.id));
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "consortium_corrected");
    assert.equal(events[0].payload.correctedSales.length, 3);
    const originalOwners = [
      { bidderId: bidders[0].id, share: 0.85 },
      { bidderId: bidders[1].id, share: 0.15 },
    ];
    const [kurtAllocation] = await db.select().from(auctionSaleAllocationsTable)
      .where(eq(auctionSaleAllocationsTable.bidderId, bidders[0].id));
    await db.update(auctionSaleAllocationsTable).set({ consortiumId: null })
      .where(eq(auctionSaleAllocationsTable.id, kurtAllocation.id));
    assert.equal((await request(8, crypto.randomUUID(), originalOwners)).status, 409);
    await db.update(auctionSaleAllocationsTable).set({ consortiumId: group.id })
      .where(eq(auctionSaleAllocationsTable.id, kurtAllocation.id));
    const [kurtPosition] = await db.select().from(positionsTable).where(eq(positionsTable.bidderId, bidders[0].id));
    await db.update(positionsTable).set({
      costBasis: (Number(kurtPosition.costBasis) + 0.01).toFixed(2),
    }).where(eq(positionsTable.id, kurtPosition.id));
    assert.equal((await request(8, crypto.randomUUID(), originalOwners)).status, 409);
    assert.equal((await db.select().from(auctionEventsTable).where(eq(auctionEventsTable.auctionId, auction.id))).length, 1);
    const [prior] = await db.insert(calcuttasTable).values({
      seasonId: season.id, year: season.year, name: `Calcutta XII correction ${unique}`,
      sport: "MLB", isCanonical: false,
    }).returning();
    const [priorAuction] = await db.insert(auctionSessionsTable).values({
      calcuttaId: prior.id, status: "complete", revision: 0,
    }).returning();
    const [priorGroup] = await db.insert(auctionConsortiaTable).values({
      auctionId: priorAuction.id, displayName: "Prior", bidderId: bidders[2].id,
    }).returning();
    const priorRequest = await fetch(`http://127.0.0.1:${server.address().port}/api/calcuttas/${prior.id}/auctions/${priorAuction.id}/consortia/${priorGroup.id}/correction`, {
      method: "POST",
      headers: { Authorization: "Bearer post-auction-test", "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Changed", owners: [{ bidderId: bidders[2].id, share: 1 }], reason: "Must not change prior pools", expectedRevision: 0, idempotencyKey: crypto.randomUUID() }),
    });
    assert.equal(priorRequest.status, 409);
    assert.equal((await db.select().from(auctionConsortiaTable).where(eq(auctionConsortiaTable.id, priorGroup.id)))[0].displayName, "Prior");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (season) await db.delete(seasonsTable).where(eq(seasonsTable.id, season.id));
    for (const team of teams) await db.delete(teamsTable).where(eq(teamsTable.id, team.id));
    for (const bidder of bidders) await db.delete(biddersTable).where(eq(biddersTable.id, bidder.id));
    if (oldKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = oldKey;
  }
});