import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import {
  biddersTable,
  closeDatabasePool,
  consortiumMembershipsTable,
  consortiaTable,
  db,
  migrateLegacyConsortiumMemberships,
} from "./index";

const canRun = Boolean(process.env.DATABASE_URL);
const suffix = randomUUID();
const bidderName = `Legacy consortium migration bidder ${suffix}`;
const consortiumName = `Legacy consortium migration group ${suffix}`;
let bidderId: number | null = null;
let consortiumId: number | null = null;

after(async () => {
  if (bidderId != null) {
    await db
      .delete(consortiumMembershipsTable)
      .where(eq(consortiumMembershipsTable.bidderId, bidderId));
    await db.delete(biddersTable).where(eq(biddersTable.id, bidderId));
  }
  if (consortiumId != null) {
    await db.delete(consortiaTable).where(eq(consortiaTable.id, consortiumId));
  }
  await closeDatabasePool();
});

test(
  "copies legacy consortium assignments once and preserves the consortium name",
  { skip: !canRun },
  async () => {
    const [consortium] = await db
      .insert(consortiaTable)
      .values({ name: consortiumName })
      .returning({ id: consortiaTable.id });
    assert.ok(consortium);
    consortiumId = consortium.id;

    const [bidder] = await db
      .insert(biddersTable)
      .values({ name: bidderName, legacyConsortiumId: consortiumId })
      .returning({ id: biddersTable.id });
    assert.ok(bidder);
    bidderId = bidder.id;

    const [first, second] = await Promise.all([
      migrateLegacyConsortiumMemberships(),
      migrateLegacyConsortiumMemberships(),
    ]);
    assert.equal(
      first.insertedMemberships + second.insertedMemberships,
      1,
      "concurrent retries must create exactly one membership",
    );
    assert.equal(first.validated, true);
    assert.equal(second.validated, true);

    const memberships = await db
      .select({
        bidderId: consortiumMembershipsTable.bidderId,
        consortium: consortiaTable.name,
      })
      .from(consortiumMembershipsTable)
      .innerJoin(
        consortiaTable,
        eq(consortiaTable.id, consortiumMembershipsTable.consortiumId),
      )
      .where(
        and(
          eq(consortiumMembershipsTable.bidderId, bidderId),
          isNull(consortiumMembershipsTable.toDate),
        ),
      );
    assert.deepEqual(memberships, [{ bidderId, consortium: consortiumName }]);

    const retry = await migrateLegacyConsortiumMemberships();
    assert.equal(retry.insertedMemberships, 0);
    assert.equal(retry.existingMemberships, 1);
    assert.equal(retry.validated, true);
  },
);