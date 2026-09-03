import { sql } from "drizzle-orm";
import { boolean, date, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { seasonsTable } from "./seasons";

export const calcuttasTable = pgTable(
  "calcuttas",
  {
    id: serial("id").primaryKey(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasonsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    year: integer("year").notNull(),
    sport: text("sport").notNull().default("NFL"),
    competitionFormat: text("competition_format").notNull().default("NFL_REGULAR_SEASON"),
    status: text("status").notNull().default("active"),
    isCanonical: boolean("is_canonical").notNull().default(true),
    /** Deterministic date used for historical consortium membership rollups. */
    asOfDate: date("as_of_date", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("calcuttas_name_idx").on(t.name),
    uniqueIndex("calcuttas_canonical_season_sport_idx")
      .on(t.seasonId, t.sport)
      .where(sql`${t.isCanonical} = true`),
    index("calcuttas_season_idx").on(t.seasonId),
  ],
);

export const insertCalcuttaSchema = createInsertSchema(calcuttasTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCalcutta = z.infer<typeof insertCalcuttaSchema>;
export type Calcutta = typeof calcuttasTable.$inferSelect;