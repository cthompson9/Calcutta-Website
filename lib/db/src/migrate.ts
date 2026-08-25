import { sql } from "drizzle-orm";
import { db } from "./index";
import {
  nflStandingsStatusMigration,
  nflPayoutsMigration,
  tradeVoidingMigration,
  ownerPositionsMigration,
  refreshJobStatesMigration,
  refreshJobStatusSignatureMigration,
  mcpOAuthMigration,
} from "./migrations";

const migrations = [
  ownerPositionsMigration,
  nflStandingsStatusMigration,
  refreshJobStatesMigration,
  refreshJobStatusSignatureMigration,
  nflPayoutsMigration,
  tradeVoidingMigration,
  mcpOAuthMigration,
] as const;

/**
 * Applies database changes required by the running API before any feature
 * backfill touches new relations. Safe to call on every startup.
 */
export async function runDatabaseMigrations(): Promise<void> {
  await db.execute(sql`
    create table if not exists app_schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  for (const migration of migrations) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(841204, 46)`);
      const applied = await tx.execute(
        sql`select version from app_schema_migrations where version = ${migration.version}`,
      );
      if (applied.rows.length > 0) return;
      await tx.execute(sql.raw(migration.sql));
      await tx.execute(
        sql`insert into app_schema_migrations (version) values (${migration.version})`,
      );
    });
  }
}
