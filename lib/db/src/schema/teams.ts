import { pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const teamsTable = pgTable("teams", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  sport: text("sport").notNull().default("NFL"),
  conference: text("conference").notNull(), // AFC | NFC for NFL; sport-neutral grouping otherwise
  division: text("division").notNull(),     // East | North | South | West for NFL
}, (t) => [
  uniqueIndex("teams_sport_name_idx").on(t.sport, t.name),
]);

export const insertTeamSchema = createInsertSchema(teamsTable).omit({ id: true });
export type InsertTeam = z.infer<typeof insertTeamSchema>;
export type Team = typeof teamsTable.$inferSelect;
