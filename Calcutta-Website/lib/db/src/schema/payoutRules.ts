import { check, integer, numeric, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { calcuttasTable } from "./calcuttas";

export const payoutRulesTable = pgTable(
  "payout_rules",
  {
    id: serial("id").primaryKey(),
    calcuttaId: integer("calcutta_id")
      .notNull()
      .references(() => calcuttasTable.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    dollarsPerUnit: numeric("dollars_per_unit", { precision: 12, scale: 4 }),
    playoffMultiplier: numeric("playoff_multiplier", { precision: 8, scale: 4 }),
  },
  (t) => [
    uniqueIndex("payout_rules_calcutta_metric_idx").on(t.calcuttaId, t.metric),
    check("payout_rules_metric_supported", sql`${t.metric} ~ '^[a-z][a-z0-9_]*$'`),
    check(
      "payout_rules_multiplier_non_negative",
      sql`${t.playoffMultiplier} IS NULL OR ${t.playoffMultiplier} >= 0`,
    ),
  ],
);

export const insertPayoutRuleSchema = createInsertSchema(payoutRulesTable).omit({ id: true });
export type InsertPayoutRule = z.infer<typeof insertPayoutRuleSchema>;
export type PayoutRule = typeof payoutRulesTable.$inferSelect;