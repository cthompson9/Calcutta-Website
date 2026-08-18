import { pgTable, serial, integer, boolean, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const seasonsTable = pgTable("seasons", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull().unique(),
  isActive: boolean("is_active").notNull().default(false),
  isComplete: boolean("is_complete").notNull().default(false),
  label: text("label").notNull(), // e.g. "2025 Season"
});

export const insertSeasonSchema = createInsertSchema(seasonsTable).omit({ id: true });
export type InsertSeason = z.infer<typeof insertSeasonSchema>;
export type Season = typeof seasonsTable.$inferSelect;
