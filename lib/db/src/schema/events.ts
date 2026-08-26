import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { seasonsTable } from "./seasons";
import { teamsTable } from "./teams";

/** Provider-neutral scheduled or completed sporting event. */
export const eventsTable = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasonsTable.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("manual"),
    sourceEventId: text("source_event_id").notNull(),
    week: integer("week").notNull(),
    eventDate: date("event_date", { mode: "string" }).notNull(),
    kickoffAt: timestamp("kickoff_at", { withTimezone: true }),
    timezone: text("timezone").notNull().default("America/New_York"),
    awayTeamId: integer("away_team_id")
      .notNull()
      .references(() => teamsTable.id),
    homeTeamId: integer("home_team_id")
      .notNull()
      .references(() => teamsTable.id),
    venue: text("venue"),
    network: text("network"),
    status: text("status").notNull().default("scheduled"),
    awayScore: integer("away_score"),
    homeScore: integer("home_score"),
    sourceData: jsonb("source_data").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("events_season_source_event_idx").on(t.seasonId, t.source, t.sourceEventId),
    uniqueIndex("events_season_week_matchup_idx").on(t.seasonId, t.week, t.awayTeamId, t.homeTeamId),
    index("events_season_week_idx").on(t.seasonId, t.week),
    index("events_home_team_idx").on(t.homeTeamId),
    index("events_away_team_idx").on(t.awayTeamId),
    check("events_distinct_teams", sql`${t.homeTeamId} <> ${t.awayTeamId}`),
    check("events_week_non_negative", sql`${t.week} >= 0`),
  ],
);

export const insertEventSchema = createInsertSchema(eventsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof eventsTable.$inferSelect;
