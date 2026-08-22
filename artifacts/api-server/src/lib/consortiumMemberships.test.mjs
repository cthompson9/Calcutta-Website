import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

const canRun = Boolean(process.env.DATABASE_URL);
let db;
let biddersTable;
let closeDatabasePool;
let consortiumMembershipsTable;
let consortiaTable;
let seasonsTable;
let eq;
let migrateLegacyConsortiumMemberships;
let loadCurrentBidderConsortiums;
let loadSeasonConsortiums;

if (canRun) {
  ({ eq } = await import("drizzle-orm"));
  ({
    biddersTable,
    closeDatabasePool,
    consortiumMembershipsTable,
    consortiaTable,
    seasonsTable,
    db,
    migrateLegacyConsortiumMemberships,
  } = await import("@workspace/db"));
  ({ loadCurrentBidderConsortiums, loadSeasonConsortiums } = await import(
    "./consortiumMemberships.ts"
  ));
}

const suffix = randomUUID();
const bidderName = `Consortium bridge history bidder ${suffix}`;
const consortiumName = `Consortium bridge history group ${suffix}`;
let bidderId;
let consortiumId;
let historicalSeasonId;
let futureSeasonId;
const historicalYear = 3000 + Math.floor(Math.random() * 5000);

after(async () => {
  if (!canRun) return;
  if (bidderId) {
    await db
      .delete(consortiumMembershipsTable)
      .where(eq(consortiumMembershipsTable.bidderId, bidderId));
    await db.delete(biddersTable).where(eq(biddersTable.id, bidderId));
  }
  if (consortiumId) {
    await db.delete(consortiaTable).where(eq(consortiaTable.id, consortiumId));
  }
  if (historicalSeasonId) {
    await db.delete(seasonsTable).where(eq(seasonsTable.id, historicalSeasonId));
  }
  if (futureSeasonId) {
    await db.delete(seasonsTable).where(eq(seasonsTable.id, futureSeasonId));
  }
  await closeDatabasePool();
});

test(
  "a dated consortium clear overrides the legacy fallback while preserving history",
  { skip: !canRun },
  async () => {
    const [consortium] = await db
      .insert(consortiaTable)
      .values({ name: consortiumName })
      .returning({ id: consortiaTable.id });
    consortiumId = consortium.id;
    const [bidder] = await db
      .insert(biddersTable)
      .values({ name: bidderName, legacyConsortiumId: consortiumId })
      .returning({ id: biddersTable.id });
    bidderId = bidder.id;
    const [historicalSeason] = await db
      .insert(seasonsTable)
      .values({
        year: historicalYear,
        label: `Consortium bridge history ${suffix}`,
        isActive: false,
        isComplete: false,
      })
      .returning({ id: seasonsTable.id });
    historicalSeasonId = historicalSeason.id;
    const [futureSeason] = await db
      .insert(seasonsTable)
      .values({
        year: historicalYear + 1,
        label: `Consortium bridge future ${suffix}`,
        isActive: false,
        isComplete: false,
      })
      .returning({ id: seasonsTable.id });
    futureSeasonId = futureSeason.id;

    assert.equal(
      (await loadCurrentBidderConsortiums([bidderId])).get(bidderId),
      consortiumName,
      "the bridge can display a legacy name before migration",
    );

    await migrateLegacyConsortiumMemberships();
    await db
      .update(consortiumMembershipsTable)
      .set({ toDate: `${historicalYear}-08-22` })
      .where(eq(consortiumMembershipsTable.bidderId, bidderId));

    assert.equal(
      (await loadCurrentBidderConsortiums([bidderId])).has(bidderId),
      false,
      "a dated clear must not be overridden by the legacy bridge value",
    );
    assert.equal(
      (await loadSeasonConsortiums(historicalSeasonId)).get(bidderId),
      consortiumName,
      "the original membership remains available at an earlier season date",
    );
    assert.equal(
      (await loadSeasonConsortiums(futureSeasonId)).has(bidderId),
      false,
      "the historical fallback must not leak past an explicit clear",
    );
  },
);