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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mtm_snapshot_pool_as_of_hour_idx").on(t.poolId, t.asOfHour),
    index("mtm_snapshot_pool_created_idx").on(t.poolId, t.createdAt),
    check("mtm_snapshot_trigger_supported", sql`${t.trigger} IN ('scheduled', 'manual')`),
    check("mtm_snapshot_status_supported", sql`${t.status} IN ('ok', 'failed')`),
  ],
);

export const mtmMarketQuoteTable = pgTable(
  "mtm_market_quote",
  {
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => mtmSnapshotTable.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("kalshi"),
    series: text("series").notNull(),
    marketTicker: text("market_ticker").notNull(),
    team: text("team"),
    strike: numeric("strike", { precision: 6, scale: 2 }),
    yesBid: numeric("yes_bid", { precision: 5, scale: 4 }),
    yesAsk: numeric("yes_ask", { precision: 5, scale: 4 }),
    volume: integer("volume"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    rawQuote: jsonb("raw_quote").$type<Record<string, unknown> | null>(),
  },
  (t) => [
    uniqueIndex("mtm_market_quote_snapshot_ticker_idx").on(t.snapshotId, t.marketTicker),
    index("mtm_market_quote_snapshot_idx").on(t.snapshotId),
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