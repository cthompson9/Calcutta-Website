import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { seasonsTable } from "./seasons";

/**
 * Idempotency and provenance record for source-backed auction imports.
 * A repeated source hash for the same season/source is a no-op replay rather
 * than another destructive replacement of primary ownership.
 */
export const importRunsTable = pgTable(
  "import_runs",
  {
    id: serial("id").primaryKey(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasonsTable.id),
    source: text("source").notNull(),
    sourceHash: text("source_hash").notNull(),
    importedTeams: integer("imported_teams").notNull(),
    importedOwners: integer("imported_owners").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("import_runs_season_source_hash_idx").on(
      t.seasonId,
      t.source,
      t.sourceHash,
    ),
    index("import_runs_season_created_idx").on(t.seasonId, t.createdAt),
  ],
);

export type ImportRun = typeof importRunsTable.$inferSelect;