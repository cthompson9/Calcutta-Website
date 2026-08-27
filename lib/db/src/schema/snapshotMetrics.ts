import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
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
import { calcuttaEntriesTable } from "./calcuttaEntries";
import { sportPeriodsTable } from "./sportPeriods";

/** One auditable metric observation for an entry, period, and return basis. */
export const snapshotMetricsTable = pgTable(
  "snapshot_metrics",
  {
    id: serial("id").primaryKey(),
    calcuttaId: integer("calcutta_id")
      .notNull()
      .references(() => calcuttasTable.id, { onDelete: "cascade" }),
    entryId: integer("entry_id")
      .references(() => calcuttaEntriesTable.id, { onDelete: "cascade" }),
    periodId: integer("period_id")
      .notNull()
      .references(() => sportPeriodsTable.id, { onDelete: "cascade" }),
    basis: text("basis").notNull(),
    metric: text("metric").notNull(),
    value: numeric("value", { precision: 16, scale: 6 }).notNull(),
    source: text("source").notNull().default("manual"),
    sourceData: jsonb("source_data").$type<Record<string, unknown> | null>(),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("snapshot_metrics_calcutta_entry_period_basis_metric_idx").on(
      t.calcuttaId,
      t.entryId,
      t.periodId,
      t.basis,
      t.metric,
    ).where(sql`${t.entryId} is not null`),
    uniqueIndex("snapshot_metrics_calcutta_period_basis_metric_idx").on(
      t.calcuttaId,
      t.periodId,
      t.basis,
      t.metric,
    ).where(sql`${t.entryId} is null`),
    index("snapshot_metrics_entry_basis_idx").on(t.entryId, t.basis),
    index("snapshot_metrics_period_basis_idx").on(t.periodId, t.basis),
    check("snapshot_metrics_basis_supported", sql`${t.basis} IN ('realized', 'mtm')`),
    check("snapshot_metrics_metric_supported", sql`${t.metric} ~ '^[a-z][a-z0-9_]*$'`),
  ],
);

export const insertSnapshotMetricSchema = createInsertSchema(snapshotMetricsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSnapshotMetric = z.infer<typeof insertSnapshotMetricSchema>;
export type SnapshotMetric = typeof snapshotMetricsTable.$inferSelect;
