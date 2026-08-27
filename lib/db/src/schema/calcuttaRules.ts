import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { calcuttasTable } from "./calcuttas";

/** Authoritative, Calcutta-scoped configuration for the generic return engine. */
export const calcuttaRulesTable = pgTable(
  "calcutta_rules",
  {
    id: serial("id").primaryKey(),
    calcuttaId: integer("calcutta_id")
      .notNull()
      .references(() => calcuttasTable.id, { onDelete: "cascade" }),
    ruleName: text("rule_name").notNull(),
    ruleType: text("rule_type"),
    value: numeric("value", { precision: 16, scale: 6 }),
    multiplier: numeric("multiplier", { precision: 16, scale: 6 }),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("calcutta_rules_calcutta_rule_idx").on(t.calcuttaId, t.ruleName),
    check("calcutta_rules_rule_name_nonempty", sql`length(trim(${t.ruleName})) > 0`),
    check(
      "calcutta_rules_rule_type_supported",
      sql`${t.ruleType} IS NULL OR ${t.ruleType} IN ('points', 'fixed_pct', 'shared_pool')`,
    ),
    check(
      "calcutta_rules_multiplier_non_negative",
      sql`${t.multiplier} IS NULL OR ${t.multiplier} >= 0`,
    ),
  ],
);

export const insertCalcuttaRuleSchema = createInsertSchema(calcuttaRulesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCalcuttaRule = z.infer<typeof insertCalcuttaRuleSchema>;
export type CalcuttaRule = typeof calcuttaRulesTable.$inferSelect;
