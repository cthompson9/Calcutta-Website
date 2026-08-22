import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Historical records from the pre-Publish migration runner. Keep this schema
 * definition during the transition so development schema syncs do not discard
 * the existing migration audit trail.
 */
export const appSchemaMigrationsTable = pgTable("app_schema_migrations", {
  version: text("version").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});