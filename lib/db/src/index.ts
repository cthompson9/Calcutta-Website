import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/**
 * Bounded pg Pool configuration:
 * - max: caps concurrent connections to avoid exhausting the Postgres connection limit.
 * - idleTimeoutMillis: release idle clients after 30 s so long-idle replicas don't hold slots.
 * - connectionTimeoutMillis: fail fast (10 s) if no client is available instead of queuing forever.
 * - allowExitOnIdle: let the process exit cleanly when the event loop drains (useful in CLIs/scripts).
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: true,
});

/**
 * Surface pool-level errors (e.g. idle client socket hang-up) to stderr instead of
 * crashing the process with an unhandled rejection.
 */
pool.on("error", (err) => {
  console.error("[pg pool] unexpected error on idle client", err);
});

export const db = drizzle(pool, { schema });

/**
 * Gracefully drain and close every connection in the pool.
 * Call this during SIGTERM/SIGINT handling or in test teardown.
 */
export async function closeDatabasePool(): Promise<void> {
  await pool.end();
}

export * from "./schema/index";
export * from "./ownerPositions";
export * from "./migrate";
export * from "./migrateLegacyConsortiumMemberships";
export { explicitRecordFromStoredValues } from "./regularSeasonRecord";
