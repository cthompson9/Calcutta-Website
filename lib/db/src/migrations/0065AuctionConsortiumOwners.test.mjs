import assert from "node:assert/strict";
import { describe, test } from "node:test";

// The caller must confirm the connection is the development database before opting in.
// Managed development databases may have opaque names with no "dev" suffix.
const safeDevDatabase = process.env.AUCTION_MIGRATION_ROLLBACK_TEST === "1"
  && process.env.NODE_ENV !== "production"
  && Boolean(process.env.DATABASE_URL);

let db, sql, migration, tables;
if (safeDevDatabase) {
  ({ db } = await import("../index.ts"));
  ({ sql } = await import("drizzle-orm"));
  ({ auctionConsortiumOwnersMigration: migration } = await import("./index.ts"));
  tables = await import("../schema/index.ts");
}

describe("0065 auction consortium owners migration", { skip: !safeDevDatabase }, () => {
  test("backfills a legacy sold allocation without changing its sale or position, then rolls back", async () => {
    const rollback = new Error("rollback migration verification");
    await assert.rejects(
      db.transaction(async (tx) => {
        const fixture = `0065 rollback ${Date.now()} ${Math.random().toString(36).slice(2)}`;
        const [season] = await tx.insert(tables.seasonsTable).values({
          year: 9000 + (Date.now() % 500), label: fixture, isActive: false, isComplete: false,
        }).returning();
        const [calcutta] = await tx.insert(tables.calcuttasTable).values({
          seasonId: season.id, year: season.year, name: fixture, sport: "NFL", isCanonical: false,
        }).returning();
        const [team] = await tx.insert(tables.teamsTable).values({
          name: fixture, sport: "NFL", conference: "NFL", division: "Participants",
        }).returning();
        const [entry] = await tx.insert(tables.calcuttaEntriesTable).values({
          calcuttaId: calcutta.id, teamId: team.id,
        }).returning();
        const [auction] = await tx.insert(tables.auctionSessionsTable).values({ calcuttaId: calcutta.id }).returning();
        const [lot] = await tx.insert(tables.auctionLotsTable).values({
          auctionId: auction.id, externalId: fixture, displayName: fixture, entryId: entry.id, status: "sold",
        }).returning();
        const [bidder] = await tx.insert(tables.biddersTable).values({ name: fixture }).returning();
        const [consortium] = await tx.insert(tables.auctionConsortiaTable).values({
          auctionId: auction.id, displayName: fixture, bidderId: bidder.id,
        }).returning();
        const [sale] = await tx.insert(tables.auctionSalesTable).values({
          auctionId: auction.id, lotId: lot.id, totalCents: 12345,
        }).returning();
        const [allocation] = await tx.insert(tables.auctionSaleAllocationsTable).values({
          saleId: sale.id, bidderId: bidder.id, consortiumId: null, share: "1", cents: 12345,
        }).returning();
        const [position] = await tx.insert(tables.positionsTable).values({
          entryId: entry.id, bidderId: bidder.id, ownershipShare: "1", source: "primary", costBasis: "123.45",
        }).returning();

        await tx.execute(sql.raw(migration.sql));
        const [backfilledAllocation] = await tx.select().from(tables.auctionSaleAllocationsTable)
          .where(sql`${tables.auctionSaleAllocationsTable.id} = ${allocation.id}`);
        assert.equal(backfilledAllocation.consortiumId, consortium.id);
        const [backfilledOwner] = await tx.select().from(tables.auctionConsortiumOwnersTable)
          .where(sql`${tables.auctionConsortiumOwnersTable.consortiumId} = ${consortium.id}`);
        assert.equal(backfilledOwner.bidderId, bidder.id);
        const [saleAfter] = await tx.select().from(tables.auctionSalesTable)
          .where(sql`${tables.auctionSalesTable.id} = ${sale.id}`);
        assert.deepEqual(saleAfter, sale);
        const [positionAfter] = await tx.select().from(tables.positionsTable)
          .where(sql`${tables.positionsTable.id} = ${position.id}`);
        assert.deepEqual(positionAfter, position);
        throw rollback;
      }),
      /rollback migration verification/,
    );
  });
});