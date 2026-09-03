import { sql } from "drizzle-orm";
import { db } from "./index";

/**
 * Idempotent rollout for installations created before dated memberships and
 * signed positions existed. Position synchronization is handled by the schema
 * migrations; after ownership inversion, startup must never rebuild the ledger.
 */
export async function ensureOwnerPositionRollout(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(841204, 45)`);
    await tx.execute(sql`
      update calcuttas
      set as_of_date = make_date(year, 8, 1)
      where as_of_date is null
        and year between 1 and 9999
    `);
  });
}