import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { calcuttaEntriesTable } from "./calcuttaEntries";
import { calcuttasTable } from "./calcuttas";
import { eventsTable } from "./events";
import { mtmSnapshotTable } from "./mtmPipeline";
import { sportPeriodsTable } from "./sportPeriods";

export const MTM_CONDITIONAL_PUBLICATION_POLICY = Object.freeze({
  minimumEffectiveSampleSize: 100,
  maximumStandardError: 10,
  maximumAbsoluteReconciliationResidual: 0.01,
});

export const mtmCalibrationMetricTable = pgTable(
  "mtm_calibration_metric",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    snapshotId: integer("snapshot_id").notNull(),
    metricKey: text("metric_key").notNull(),
    marketTicker: text("market_ticker"),
    targetProbability: numeric("target_probability", { precision: 8, scale: 6 }),
    simulatedProbability: numeric("simulated_probability", { precision: 8, scale: 6 }),
    weight: numeric("weight", { precision: 12, scale: 6 }),
    residual: numeric("residual", { precision: 10, scale: 7 }),
    tolerance: numeric("tolerance", { precision: 10, scale: 7 }),
    sampleCount: integer("sample_count"),
    sampleShare: numeric("sample_share", { precision: 8, scale: 6 }),
    effectiveSampleSize: numeric("effective_sample_size", { precision: 12, scale: 4 }),
    qualityStatus: text("quality_status").notNull().default("good"),
    sampleMetadata: jsonb("sample_metadata").$type<Record<string, unknown> | null>(),
  },
  (t) => [
    foreignKey({ columns: [t.snapshotId], foreignColumns: [mtmSnapshotTable.id], name: "mtm_cal_metric_snapshot_fk" }).onDelete("cascade"),
    uniqueIndex("mtm_cal_metric_snapshot_key_idx").on(t.snapshotId, t.metricKey),
    index("mtm_cal_metric_snapshot_idx").on(t.snapshotId),
    check("mtm_cal_metric_weight_non_negative", sql`${t.weight} IS NULL OR ${t.weight} >= 0`),
    check("mtm_cal_metric_tolerance_non_negative", sql`${t.tolerance} IS NULL OR ${t.tolerance} >= 0`),
    check("mtm_cal_metric_sample_count_non_negative", sql`${t.sampleCount} IS NULL OR ${t.sampleCount} >= 0`),
    check("mtm_cal_metric_effective_size_non_negative", sql`${t.effectiveSampleSize} IS NULL OR ${t.effectiveSampleSize} >= 0`),
    check("mtm_cal_metric_target_probability_range", sql`${t.targetProbability} IS NULL OR (${t.targetProbability} >= 0 AND ${t.targetProbability} <= 1)`),
    check("mtm_cal_metric_simulated_probability_range", sql`${t.simulatedProbability} IS NULL OR (${t.simulatedProbability} >= 0 AND ${t.simulatedProbability} <= 1)`),
    check("mtm_cal_metric_sample_share_range", sql`${t.sampleShare} IS NULL OR (${t.sampleShare} >= 0 AND ${t.sampleShare} <= 1)`),
    check("mtm_cal_metric_quality_supported", sql`${t.qualityStatus} IN ('good', 'warning', 'insufficient')`),
  ],
);

export const mtmGameConditionalTable = pgTable(
  "mtm_game_conditional",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    snapshotId: integer("snapshot_id").notNull(),
    eventId: integer("event_id").notNull(),
    entryId: integer("entry_id").notNull(),
    outcome: text("outcome").notNull(),
    probability: numeric("probability", { precision: 8, scale: 6 }),
    grossBaseline: numeric("gross_baseline", { precision: 14, scale: 4 }),
    grossConditional: numeric("gross_conditional", { precision: 14, scale: 4 }),
    grossDelta: numeric("gross_delta", { precision: 14, scale: 4 }),
    sampleCount: integer("sample_count"),
    sampleShare: numeric("sample_share", { precision: 8, scale: 6 }),
    effectiveSampleSize: numeric("effective_sample_size", { precision: 12, scale: 4 }),
    standardError: numeric("standard_error", { precision: 14, scale: 6 }),
    qualityStatus: text("quality_status").notNull().default("good"),
    reconciliationResidual: numeric("reconciliation_residual", { precision: 14, scale: 6 }),
  },
  (t) => [
    foreignKey({ columns: [t.snapshotId], foreignColumns: [mtmSnapshotTable.id], name: "mtm_game_cond_snapshot_fk" }).onDelete("cascade"),
    foreignKey({ columns: [t.eventId], foreignColumns: [eventsTable.id], name: "mtm_game_cond_event_fk" }).onDelete("cascade"),
    foreignKey({ columns: [t.entryId], foreignColumns: [calcuttaEntriesTable.id], name: "mtm_game_cond_entry_fk" }).onDelete("cascade"),
    uniqueIndex("mtm_game_cond_snapshot_event_entry_outcome_idx").on(t.snapshotId, t.eventId, t.entryId, t.outcome),
    index("mtm_game_cond_snapshot_event_idx").on(t.snapshotId, t.eventId),
    check("mtm_game_cond_probability_range", sql`${t.probability} IS NULL OR (${t.probability} >= 0 AND ${t.probability} <= 1)`),
    check("mtm_game_cond_outcome_supported", sql`${t.outcome} IN ('home_win', 'away_win', 'tie')`),
    check("mtm_game_cond_gross_baseline_non_negative", sql`${t.grossBaseline} IS NULL OR ${t.grossBaseline} >= 0`),
    check("mtm_game_cond_gross_conditional_non_negative", sql`${t.grossConditional} IS NULL OR ${t.grossConditional} >= 0`),
    check("mtm_game_cond_sample_count_non_negative", sql`${t.sampleCount} IS NULL OR ${t.sampleCount} >= 0`),
    check("mtm_game_cond_effective_size_non_negative", sql`${t.effectiveSampleSize} IS NULL OR ${t.effectiveSampleSize} >= 0`),
    check("mtm_game_cond_standard_error_non_negative", sql`${t.standardError} IS NULL OR ${t.standardError} >= 0`),
    check("mtm_game_cond_quality_supported", sql`${t.qualityStatus} IN ('good', 'warning', 'insufficient')`),
    check("mtm_game_cond_sample_share_range", sql`${t.sampleShare} IS NULL OR (${t.sampleShare} >= 0 AND ${t.sampleShare} <= 1)`),
  ],
);

export const mtmCanonicalPeriodSelectionTable = pgTable(
  "mtm_canonical_period_selection",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    poolId: integer("pool_id").notNull(),
    sportPeriodId: integer("sport_period_id").notNull(),
    snapshotId: integer("snapshot_id").notNull(),
    selectedAt: timestamp("selected_at", { withTimezone: true }).notNull().defaultNow(),
    selectedBy: text("selected_by"),
    selectedReason: text("selected_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  },
  (t) => [
    foreignKey({ columns: [t.poolId], foreignColumns: [calcuttasTable.id], name: "mtm_period_sel_pool_fk" }).onDelete("cascade"),
    foreignKey({ columns: [t.sportPeriodId], foreignColumns: [sportPeriodsTable.id], name: "mtm_period_sel_period_fk" }).onDelete("cascade"),
    foreignKey({ columns: [t.snapshotId], foreignColumns: [mtmSnapshotTable.id], name: "mtm_period_sel_snapshot_fk" }).onDelete("restrict"),
    index("mtm_period_sel_latest_idx").on(t.poolId, t.sportPeriodId, t.selectedAt.desc()),
    index("mtm_period_sel_history_idx").on(t.poolId, t.sportPeriodId, t.snapshotId),
  ],
);

export const insertMtmCalibrationMetricSchema = createInsertSchema(mtmCalibrationMetricTable);
export const insertMtmGameConditionalSchema = createInsertSchema(mtmGameConditionalTable);
export const insertMtmCanonicalPeriodSelectionSchema = createInsertSchema(mtmCanonicalPeriodSelectionTable);
export type InsertMtmCalibrationMetric = z.infer<typeof insertMtmCalibrationMetricSchema>;
export type InsertMtmGameConditional = z.infer<typeof insertMtmGameConditionalSchema>;
export type InsertMtmCanonicalPeriodSelection = z.infer<typeof insertMtmCanonicalPeriodSelectionSchema>;