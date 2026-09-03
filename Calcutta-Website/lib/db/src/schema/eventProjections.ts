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

/** Historical model output; model probabilities are distinct from market prices. */
export const eventProjectionsTable = pgTable(
  "event_projections",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id")
      .notNull()
      .references(() => eventsTable.id, { onDelete: "cascade" }),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
    modelName: text("model_name").notNull(),
    source: text("source").notNull().default("manual"),
    homeWinProbability: numeric("home_win_probability", { precision: 8, scale: 6 }),
    awayWinProbability: numeric("away_win_probability", { precision: 8, scale: 6 }),
    projectedHomeScore: numeric("projected_home_score", { precision: 7, scale: 2 }),
    projectedAwayScore: numeric("projected_away_score", { precision: 7, scale: 2 }),
    projectedPointDifferential: numeric("projected_point_differential", { precision: 7, scale: 2 }),
    sourceData: jsonb("source_data").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("event_projections_event_model_source_time_idx").on(
      t.eventId,
      t.modelName,
      t.source,
      t.snapshotAt,
    ),
    index("event_projections_event_time_idx").on(t.eventId, t.snapshotAt),
    check(
      "event_projections_home_probability_bounds",
      sql`${t.homeWinProbability} IS NULL OR (${t.homeWinProbability} >= 0 AND ${t.homeWinProbability} <= 1)`,
    ),
    check(
      "event_projections_away_probability_bounds",
      sql`${t.awayWinProbability} IS NULL OR (${t.awayWinProbability} >= 0 AND ${t.awayWinProbability} <= 1)`,
    ),
    check(
      "event_projections_probability_pair",
      sql`(${t.homeWinProbability} IS NULL AND ${t.awayWinProbability} IS NULL) OR (${t.homeWinProbability} IS NOT NULL AND ${t.awayWinProbability} IS NOT NULL AND abs((${t.homeWinProbability} + ${t.awayWinProbability}) - 1) <= 0.000001)`,
    ),
  ],
);

export const insertEventProjectionSchema = createInsertSchema(eventProjectionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertEventProjection = z.infer<typeof insertEventProjectionSchema>;
export type EventProjection = typeof eventProjectionsTable.$inferSelect;
