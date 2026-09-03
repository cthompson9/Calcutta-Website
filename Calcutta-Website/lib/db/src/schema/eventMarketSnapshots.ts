import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { eventsTable } from "./events";

/** Historical sportsbook/market observation; rows are immutable snapshots. */
export const eventMarketSnapshotsTable = pgTable(
  "event_market_snapshots",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id")
      .notNull()
      .references(() => eventsTable.id, { onDelete: "cascade" }),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    spread: numeric("spread", { precision: 7, scale: 2 }),
    homeMoneyline: integer("home_moneyline"),
    awayMoneyline: integer("away_moneyline"),
    homeImpliedProbability: numeric("home_implied_probability", { precision: 8, scale: 6 }),
    awayImpliedProbability: numeric("away_implied_probability", { precision: 8, scale: 6 }),
    total: numeric("total", { precision: 7, scale: 2 }),
    sourceData: jsonb("source_data").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("event_market_snapshots_event_source_time_idx").on(t.eventId, t.source, t.snapshotAt),
    index("event_market_snapshots_event_time_idx").on(t.eventId, t.snapshotAt),
    check(
      "event_market_snapshots_home_probability_bounds",
      sql`${t.homeImpliedProbability} IS NULL OR (${t.homeImpliedProbability} >= 0 AND ${t.homeImpliedProbability} <= 1)`,
    ),
    check(
      "event_market_snapshots_away_probability_bounds",
      sql`${t.awayImpliedProbability} IS NULL OR (${t.awayImpliedProbability} >= 0 AND ${t.awayImpliedProbability} <= 1)`,
    ),
  ],
);

export const insertEventMarketSnapshotSchema = createInsertSchema(eventMarketSnapshotsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertEventMarketSnapshot = z.infer<typeof insertEventMarketSnapshotSchema>;
export type EventMarketSnapshot = typeof eventMarketSnapshotsTable.$inferSelect;
