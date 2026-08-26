import { index, integer, jsonb, pgTable, serial, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { calcuttasTable } from "./calcuttas";
import { teamsTable } from "./teams";

export const calcuttaEntriesTable = pgTable(
  "calcutta_entries",
  {
    id: serial("id").primaryKey(),
    calcuttaId: integer("calcutta_id")
      .notNull()
      .references(() => calcuttasTable.id, { onDelete: "cascade" }),
    teamId: integer("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  },
  (t) => [
    uniqueIndex("calcutta_entries_calcutta_team_idx").on(t.calcuttaId, t.teamId),
    index("calcutta_entries_team_idx").on(t.teamId),
  ],
);

export const insertCalcuttaEntrySchema = createInsertSchema(calcuttaEntriesTable).omit({ id: true });
export type InsertCalcuttaEntry = z.infer<typeof insertCalcuttaEntrySchema>;
export type CalcuttaEntry = typeof calcuttaEntriesTable.$inferSelect;