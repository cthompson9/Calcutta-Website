import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  integer,
  numeric,
  date,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { teamsTable } from "./teams";
import { seasonsTable } from "./seasons";
import { calcuttaEntriesTable } from "./calcuttaEntries";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const mtmSnapshotsTable = pgTable(
  "mtm_snapshots",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => calcuttaEntriesTable.id, { onDelete: "cascade" }),
    teamId: integer("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasonsTable.id, { onDelete: "cascade" }),
    // weekNum is now optional — a convenience label only, not the upsert key
    weekNum: integer("week_num"),
    // snapshotDate is the upsert key: one row per selected entry per date
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    mtmValue: numeric("mtm_value", { precision: 10, scale: 4 }).notNull().default("0"),
    snapshotKey: text("snapshot_key"),
    source: text("source").notNull().default("manual"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    marketStatus: text("market_status"),
    bankedPoints: numeric("banked_points", { precision: 12, scale: 6 }),
    seasonEquityPoints: numeric("season_equity_points", { precision: 12, scale: 6 }),
    bonusEquityPoints: numeric("bonus_equity_points", { precision: 12, scale: 6 }),
    totalPoints: numeric("total_points", { precision: 12, scale: 6 }),
    normalizedShare: numeric("normalized_share", { precision: 14, scale: 12 }),
    marketData: jsonb("market_data").$type<Record<string, unknown>>(),
  },
  (t) => [
    // One snapshot per Calcutta entry per calendar date (the primary upsert key)
    uniqueIndex("mtm_entry_date_idx").on(t.entryId, t.snapshotDate),
    // snapshot_key uniqueness only applies when a key is actually present;
    // NULL rows (manual/unlabelled snapshots) must not collide with each other.
    uniqueIndex("mtm_entry_key_idx")
      .on(t.entryId, t.snapshotKey)
      .where(sql`${t.snapshotKey} IS NOT NULL`),
    check("mtm_snapshots_value_non_negative", sql`${t.mtmValue} >= 0`),
    // Compatibility lookup plus authoritative entry-scoped lookup.
    index("mtm_snapshots_season_idx").on(t.seasonId),
    index("mtm_snapshots_entry_idx").on(t.entryId),
  ],
);

export const insertMtmSnapshotSchema = createInsertSchema(mtmSnapshotsTable).omit({ id: true });
export type InsertMtmSnapshot = z.infer<typeof insertMtmSnapshotSchema>;
export type MtmSnapshot = typeof mtmSnapshotsTable.$inferSelect;
