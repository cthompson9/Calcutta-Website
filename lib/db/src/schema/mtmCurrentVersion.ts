import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { calcuttasTable } from "./calcuttas";
import { eventsTable } from "./events";
import { mtmSnapshotTable } from "./mtmPipeline";

/**
 * A normalized publication record for the current mark.
 *
 * The official snapshot remains the immutable source of all valuation payloads.
 * This relation contains only identity, as-of, actuals linkage, and promotion
 * metadata; it deliberately does not duplicate team or owner payout values.
 */
export const mtmValuationVersionTable = pgTable(
  "mtm_valuation_version",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    poolId: integer("pool_id").notNull(),
    sourceSnapshotId: integer("source_snapshot_id").notNull(),
    actualsStateHash: text("actuals_state_hash").notNull(),
    actualsAsOf: timestamp("actuals_as_of", { withTimezone: true }).notNull(),
    mtmAsOf: timestamp("mtm_as_of", { withTimezone: true }).notNull(),
    markType: text("mark_type").notNull(),
    status: text("status").notNull().default("candidate"),
    staleReason: text("stale_reason"),
    provisionalEventId: integer("provisional_event_id"),
    provisionalOutcome: text("provisional_outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.poolId],
      foreignColumns: [calcuttasTable.id],
      name: "mtm_val_version_pool_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.sourceSnapshotId],
      foreignColumns: [mtmSnapshotTable.id],
      name: "mtm_val_version_source_snapshot_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.provisionalEventId],
      foreignColumns: [eventsTable.id],
      name: "mtm_val_version_provisional_event_fk",
    }).onDelete("restrict"),
    index("mtm_val_version_pool_created_idx").on(t.poolId, t.createdAt),
    index("mtm_val_version_source_snapshot_idx").on(t.sourceSnapshotId),
    uniqueIndex("mtm_val_version_one_current_idx")
      .on(t.poolId)
      .where(sql`${t.status} = 'current'`),
    check("mtm_val_version_mark_type_supported", sql`${t.markType} IN ('official', 'provisional', 'pending_recalculation')`),
    check("mtm_val_version_status_supported", sql`${t.status} IN ('candidate', 'current', 'superseded')`),
    check("mtm_val_version_provisional_outcome_supported", sql`${t.provisionalOutcome} IS NULL OR ${t.provisionalOutcome} IN ('home_win', 'away_win', 'tie')`),
    check(
      "mtm_val_version_provisional_pair",
      sql`(${t.provisionalEventId} IS NULL AND ${t.provisionalOutcome} IS NULL) OR (${t.provisionalEventId} IS NOT NULL AND ${t.provisionalOutcome} IS NOT NULL)`,
    ),
  ],
);

/**
 * Exact game identity/result linkage for a version.  Pending rows identify
 * finalized games that are known to the actuals ledger but not incorporated
 * into the retained official values yet.
 */
export const mtmValuationGameTable = pgTable(
  "mtm_valuation_game",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    versionId: integer("version_id").notNull(),
    eventId: integer("event_id").notNull(),
    week: integer("week").notNull(),
    homeTeamId: integer("home_team_id").notNull(),
    awayTeamId: integer("away_team_id").notNull(),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    outcome: text("outcome"),
    linkageStatus: text("linkage_status").notNull().default("incorporated"),
    isProvisional: boolean("is_provisional").notNull().default(false),
  },
  (t) => [
    foreignKey({
      columns: [t.versionId],
      foreignColumns: [mtmValuationVersionTable.id],
      name: "mtm_val_game_version_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.eventId],
      foreignColumns: [eventsTable.id],
      name: "mtm_val_game_event_fk",
    }).onDelete("restrict"),
    uniqueIndex("mtm_val_game_version_event_idx").on(t.versionId, t.eventId),
    uniqueIndex("mtm_val_game_one_provisional_idx")
      .on(t.versionId)
      .where(sql`${t.isProvisional} = true`),
    index("mtm_val_game_version_status_idx").on(t.versionId, t.linkageStatus),
    check("mtm_val_game_status_supported", sql`${t.linkageStatus} IN ('incorporated', 'pending')`),
    check("mtm_val_game_outcome_supported", sql`${t.outcome} IS NULL OR ${t.outcome} IN ('home_win', 'away_win', 'tie')`),
    check("mtm_val_game_provisional_incorporated", sql`${t.isProvisional} = false OR ${t.linkageStatus} = 'incorporated'`),
    check(
      "mtm_val_game_incorporated_result_complete",
      sql`${t.linkageStatus} = 'pending' OR (${t.homeScore} IS NOT NULL AND ${t.awayScore} IS NOT NULL AND ${t.outcome} IS NOT NULL)`,
    ),
    check("mtm_val_game_scores_pair", sql`(${t.homeScore} IS NULL AND ${t.awayScore} IS NULL) OR (${t.homeScore} IS NOT NULL AND ${t.awayScore} IS NOT NULL)`),
    check("mtm_val_game_distinct_teams", sql`${t.homeTeamId} <> ${t.awayTeamId}`),
  ],
);

export const insertMtmValuationVersionSchema = createInsertSchema(mtmValuationVersionTable).omit({
  createdAt: true,
});
export const insertMtmValuationGameSchema = createInsertSchema(mtmValuationGameTable);
export type InsertMtmValuationVersion = z.infer<typeof insertMtmValuationVersionSchema>;
export type InsertMtmValuationGame = z.infer<typeof insertMtmValuationGameSchema>;
export type MtmValuationVersion = typeof mtmValuationVersionTable.$inferSelect;
export type MtmValuationGame = typeof mtmValuationGameTable.$inferSelect;

// Descriptive aliases keep callers from having to know the historical table
// naming used by the first MTM pipeline implementation.
export const mtmCurrentVersionTable = mtmValuationVersionTable;
export const mtmCurrentGameTable = mtmValuationGameTable;