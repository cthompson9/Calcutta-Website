import { index, integer, jsonb, numeric, pgTable, serial, uniqueIndex } from "drizzle-orm/pg-core";
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
    // Manual result economics are pool-entry scoped; team_results remains
    // limited to objective season-level NFL facts.
    realizedReturn: numeric("realized_return", { precision: 10, scale: 4 }).default("0"),
    realizedMultiple: numeric("realized_multiple", { precision: 10, scale: 7 }).default("0"),
    netReturn: numeric("net_return", { precision: 10, scale: 4 }).default("0"),
    netPctReturn: numeric("net_pct_return", { precision: 10, scale: 7 }).default("0"),
    markToMarket: numeric("mark_to_market", { precision: 10, scale: 4 }).default("0"),
  },
  (t) => [
    uniqueIndex("calcutta_entries_calcutta_team_idx").on(t.calcuttaId, t.teamId),
    index("calcutta_entries_team_idx").on(t.teamId),
  ],
);

export const insertCalcuttaEntrySchema = createInsertSchema(calcuttaEntriesTable).omit({ id: true });
export type InsertCalcuttaEntry = z.infer<typeof insertCalcuttaEntrySchema>;
export type CalcuttaEntry = typeof calcuttaEntriesTable.$inferSelect;