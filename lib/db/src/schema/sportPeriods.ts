import { boolean, check, integer, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const sportPeriodsTable = pgTable(
  "sport_periods",
  {
    id: serial("id").primaryKey(),
    sport: text("sport").notNull(),
    sequence: integer("sequence").notNull(),
    label: text("label").notNull(),
    isPlayoff: boolean("is_playoff").notNull().default(false),
  },
  (t) => [
    uniqueIndex("sport_periods_sport_sequence_idx").on(t.sport, t.sequence),
    check("sport_periods_sequence_non_negative", sql`${t.sequence} >= 0`),
  ],
);

export const insertSportPeriodSchema = createInsertSchema(sportPeriodsTable).omit({ id: true });
export type InsertSportPeriod = z.infer<typeof insertSportPeriodSchema>;
export type SportPeriod = typeof sportPeriodsTable.$inferSelect;