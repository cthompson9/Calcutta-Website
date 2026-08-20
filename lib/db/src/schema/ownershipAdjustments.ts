import { jsonb, pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { teamsTable } from "./teams";
import { seasonsTable } from "./seasons";

/**
 * Append-only provenance for direct corrections to primary auction ownership.
 * Trades remain in their separate approval workflow and are never rewritten.
 */
export const ownershipAdjustmentsTable = pgTable("ownership_adjustments", {
  id: serial("id").primaryKey(),
  seasonId: integer("season_id")
    .notNull()
    .references(() => seasonsTable.id, { onDelete: "cascade" }),
  teamId: integer("team_id")
    .notNull()
    .references(() => teamsTable.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  note: text("note"),
  owners: jsonb("owners").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertOwnershipAdjustmentSchema = createInsertSchema(ownershipAdjustmentsTable)
  .omit({ id: true, createdAt: true });
export type InsertOwnershipAdjustment = z.infer<typeof insertOwnershipAdjustmentSchema>;
export type OwnershipAdjustment = typeof ownershipAdjustmentsTable.$inferSelect;