import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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
import { eventsTable } from "./events";

/**
 * Additive, engine-facing MTM ledger.  These tables intentionally do not
 * replace mtm_snapshots: the legacy UI and manual/Week 0 paths remain
 * available while the frozen Python engine is rolled out.
 */
export const mtmSnapshotTable = pgTable(
  "mtm_snapshot",
  {
    id: serial("id").primaryKey(),
    poolId: integer("pool_id")
      .notNull()
      .references(() => calcuttasTable.id, { onDelete: "cascade" }),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    asOfHour: timestamp("as_of_hour", { withTimezone: true }).notNull(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    methodVersion: text("method_version").notNull(),
    error: text("error"),
    diagnostics: jsonb("diagnostics").$type<Record<string, unknown> | null>(),
    stateJson: jsonb("state_json").$type<Record<string, unknown> | null>(),
    inputProvenance: jsonb("input_provenance").$type<Record<string, unknown> | null>(),
    pathCount: integer("path_count"),
    randomSeed: integer("random_seed"),
    inputHash: text("input_hash"),
    marketAnchor: timestamp("market_anchor", { withTimezone: true }),
    actualAnchor: timestamp("actual_anchor", { withTimezone: true }),
    calibrationStatus: text("calibration_status"),
    runKind: text("run_kind"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mtm_snapshot_pool_as_of_hour_idx").on(t.poolId, t.asOfHour),
    index("mtm_snapshot_pool_created_idx").on(t.poolId, t.createdAt),
    check("mtm_snapshot_trigger_supported", sql`${t.trigger} IN ('scheduled', 'manual')`),
    check("mtm_snapshot_status_supported", sql`${t.status} IN ('ok', 'failed')`),
    check("mtm_snapshot_path_count_non_negative", sql`${t.pathCount} IS NULL OR ${t.pathCount} >= 0`),
    check("mtm_snapshot_random_seed_non_negative", sql`${t.randomSeed} IS NULL OR ${t.randomSeed} >= 0`),
    check("mtm_snapshot_calibration_status_supported", sql`${t.calibrationStatus} IS NULL OR ${t.calibrationStatus} IN ('good', 'warning', 'insufficient', 'not_run')`),
    check("mtm_snapshot_run_kind_supported", sql`${t.runKind} IS NULL OR ${t.runKind} IN ('week_0', 'scheduled', 'manual', 'postgame', 'backfill')`),
  ],
);

export const mtmMarketQuoteTable = pgTable(
  "mtm_market_quote",
  {
    snapshotId: integer("snapshot_id")
      .notNull(),
    source: text("source").notNull().default("kalshi"),
    sourceUrl: text("source_url"),
    series: text("series").notNull(),
    marketTicker: text("market_ticker").notNull(),
    team: text("team"),
    strike: numeric("strike", { precision: 6, scale: 2 }),
    yesBid: numeric("yes_bid", { precision: 5, scale: 4 }),
    yesAsk: numeric("yes_ask", { precision: 5, scale: 4 }),
    lastPrice: numeric("last_price", { precision: 12, scale: 10 }),
    referencePrice: numeric("reference_price", { precision: 12, scale: 10 }),
    selectionMethod: text("selection_method"),
    selectionReason: jsonb("selection_reason").$type<Record<string, unknown> | null>(),
    referenceAcceptedAt: timestamp("reference_accepted_at", { withTimezone: true }),
    referenceSourceSnapshotId: integer("reference_source_snapshot_id"),
    referenceSourceTicker: text("reference_source_ticker"),
    referencePolicyVersion: text("reference_policy_version"),
    fetchOutcome: text("fetch_outcome"),
    volume: integer("volume"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    rawQuote: jsonb("raw_quote").$type<Record<string, unknown> | null>(),
    /**
     * The fields below are additive evidence metadata.  The original quote
     * columns remain the compatibility path used by the first MTM pipeline;
     * nullable fields deliberately preserve "unknown" as NULL rather than
     * inventing a value for older observations.
     */
    observationId: text("observation_id"),
    provider: text("provider"),
    contract: text("contract"),
    settlementPredicate: text("settlement_predicate"),
    family: text("family"),
    eventId: integer("event_id"),
    sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    normalizedYesBid: numeric("normalized_yes_bid", { precision: 5, scale: 4 }),
    normalizedYesAsk: numeric("normalized_yes_ask", { precision: 5, scale: 4 }),
    depth: jsonb("depth").$type<Record<string, unknown> | null>(),
    status: text("status"),
    outcome: text("outcome"),
    materialEvent: jsonb("material_event").$type<Record<string, unknown> | null>(),
    stateVersion: text("state_version"),
    qualityReport: jsonb("quality_report").$type<Record<string, unknown> | null>(),
    qualityPolicyVersion: text("quality_policy_version"),
    acceptedLower: numeric("accepted_lower", { precision: 5, scale: 4 }),
    acceptedUpper: numeric("accepted_upper", { precision: 5, scale: 4 }),
    tradeEstimate: numeric("trade_estimate", { precision: 5, scale: 4 }),
    tradeUncertainty: numeric("trade_uncertainty", { precision: 5, scale: 4 }),
    fallbackIdentity: text("fallback_identity"),
    fallbackAge: numeric("fallback_age", { precision: 14, scale: 3 }),
    evidenceGroup: jsonb("evidence_group").$type<Record<string, unknown> | null>(),
    completenessManifest: jsonb("completeness_manifest").$type<Record<string, unknown> | null>(),
    rawMetadata: jsonb("raw_metadata").$type<Record<string, unknown> | null>(),
  },
  (t) => [
    uniqueIndex("mtm_market_quote_snapshot_ticker_idx").on(t.snapshotId, t.marketTicker),
    uniqueIndex("mtm_market_quote_snapshot_observation_idx")
      .on(t.snapshotId, t.observationId)
      .where(sql`${t.observationId} IS NOT NULL`),
    index("mtm_market_quote_snapshot_idx").on(t.snapshotId),
    index("mtm_market_quote_event_idx").on(t.eventId),
    index("mtm_market_quote_provider_contract_idx").on(t.provider, t.contract),
    foreignKey({
      columns: [t.snapshotId],
      foreignColumns: [mtmSnapshotTable.id],
      name: "mtm_quote_snapshot_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.eventId],
      foreignColumns: [eventsTable.id],
      name: "mtm_quote_event_fk",
    }).onDelete("set null"),
    check(
      "mtm_market_quote_yes_bid_bounds",
      sql`${t.yesBid} IS NULL OR (${t.yesBid} >= 0 AND ${t.yesBid} <= 1)`,
    ),
    check(
      "mtm_market_quote_yes_ask_bounds",
      sql`${t.yesAsk} IS NULL OR (${t.yesAsk} >= 0 AND ${t.yesAsk} <= 1)`,
    ),
    check(
      "mtm_market_quote_normalized_bid_bounds",
      sql`${t.normalizedYesBid} IS NULL OR (${t.normalizedYesBid} >= 0 AND ${t.normalizedYesBid} <= 1)`,
    ),
    check(
      "mtm_market_quote_normalized_ask_bounds",
      sql`${t.normalizedYesAsk} IS NULL OR (${t.normalizedYesAsk} >= 0 AND ${t.normalizedYesAsk} <= 1)`,
    ),
    check(
      "mtm_market_quote_normalized_bid_ask_order",
      sql`${t.normalizedYesBid} IS NULL OR ${t.normalizedYesAsk} IS NULL OR ${t.normalizedYesBid} <= ${t.normalizedYesAsk}`,
    ),
    check(
      "mtm_market_quote_accepted_bounds",
      sql`${t.acceptedLower} IS NULL OR ${t.acceptedUpper} IS NULL OR (${t.acceptedLower} >= 0 AND ${t.acceptedUpper} <= 1 AND ${t.acceptedLower} <= ${t.acceptedUpper})`,
    ),
    check(
      "mtm_market_quote_trade_estimate_bounds",
      sql`${t.tradeEstimate} IS NULL OR (${t.tradeEstimate} >= 0 AND ${t.tradeEstimate} <= 1)`,
    ),
    check(
      "mtm_market_quote_trade_uncertainty_non_negative",
      sql`${t.tradeUncertainty} IS NULL OR ${t.tradeUncertainty} >= 0`,
    ),
    check(
      "mtm_market_quote_fallback_age_non_negative",
      sql`${t.fallbackAge} IS NULL OR ${t.fallbackAge} >= 0`,
    ),
    check(
      "mtm_market_quote_status_supported",
      sql`${t.status} IS NULL OR ${t.status} IN ('active', 'settled', 'suspended', 'unknown')`,
    ),
    check(
      "mtm_market_quote_outcome_supported",
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('yes', 'no', 'void')`,
    ),
  ],
);

export const mtmTeamProjectionTable = pgTable(
  "mtm_team_projection",
  {
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => mtmSnapshotTable.id, { onDelete: "cascade" }),
    team: text("team").notNull(),
    eWinsTotal: numeric("e_wins_total", { precision: 6, scale: 3 }),
    eRemainingWins: numeric("e_remaining_wins", { precision: 6, scale: 3 }),
    pBerth: numeric("p_berth", { precision: 5, scale: 4 }),
    pDivisional: numeric("p_divisional", { precision: 5, scale: 4 }),
    pConf: numeric("p_conf", { precision: 5, scale: 4 }),
    pSbBerth: numeric("p_sb_berth", { precision: 5, scale: 4 }),
    pSbWin: numeric("p_sb_win", { precision: 5, scale: 4 }),
    eRemainingRawDiff: numeric("e_remaining_raw_diff", { precision: 8, scale: 2 }),
    eRemainingMarqueeAddon: numeric("e_remaining_marquee_addon", { precision: 8, scale: 2 }),
    rating: numeric("rating", { precision: 12, scale: 3 }),
  },
  (t) => [uniqueIndex("mtm_team_projection_snapshot_team_idx").on(t.snapshotId, t.team)],
);

export const mtmEntryValuationTable = pgTable(
  "mtm_entry_valuation",
  {
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => mtmSnapshotTable.id, { onDelete: "cascade" }),
    entryId: integer("entry_id")
      .notNull()
      .references(() => calcuttaEntriesTable.id, { onDelete: "cascade" }),
    expectedPoints: numeric("expected_points", { precision: 10, scale: 2 }),
    expectedShare: numeric("expected_share", { precision: 9, scale: 6 }),
    expectedPayout: numeric("expected_payout", { precision: 12, scale: 2 }),
    auctionPrice: numeric("auction_price", { precision: 12, scale: 2 }),
    mtmMultiple: numeric("mtm_multiple", { precision: 12, scale: 3 }),
  },
  (t) => [uniqueIndex("mtm_entry_valuation_snapshot_entry_idx").on(t.snapshotId, t.entryId)],
);

export const insertMtmPipelineSnapshotSchema = createInsertSchema(mtmSnapshotTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMtmPipelineSnapshot = z.infer<typeof insertMtmPipelineSnapshotSchema>;
export type MtmSnapshotPipelineRow = typeof mtmSnapshotTable.$inferSelect;
export const insertMtmMarketQuoteSchema = createInsertSchema(mtmMarketQuoteTable);
export type InsertMtmMarketQuote = z.infer<typeof insertMtmMarketQuoteSchema>;
export type MtmMarketQuote = typeof mtmMarketQuoteTable.$inferSelect;