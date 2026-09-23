import { index, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { calcuttasTable } from "./calcuttas";
import { calcuttaEntriesTable } from "./calcuttaEntries";
import { biddersTable } from "./bidders";

export const auctionSessionsTable = pgTable("auction_sessions", {
  id: serial("id").primaryKey(),
  calcuttaId: integer("calcutta_id").notNull().references(() => calcuttasTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("setup"),
  currentLotId: integer("current_lot_id"),
  revision: integer("revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("auction_sessions_calcutta_idx").on(t.calcuttaId),
  check("auction_sessions_status_check", sql`${t.status} in ('setup','live','complete')`),
]);

export const auctionLotsTable = pgTable("auction_lots", {
  id: serial("id").primaryKey(),
  auctionId: integer("auction_id").notNull().references(() => auctionSessionsTable.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  displayName: text("display_name").notNull(),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  entryId: integer("entry_id").notNull().references(() => calcuttaEntriesTable.id),
  status: text("status").notNull().default("available"),
  nominationId: text("nomination_id"),
  nominationSequence: integer("nomination_sequence"),
  currentBidCents: integer("current_bid_cents"),
  nominatedAt: timestamp("nominated_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("auction_lots_external_idx").on(t.auctionId, t.externalId),
  uniqueIndex("auction_lots_entry_idx").on(t.auctionId, t.entryId),
  index("auction_lots_status_idx").on(t.auctionId, t.status),
  check("auction_lots_status_check", sql`${t.status} in ('available','bidding','sold')`),
  check("auction_lots_bid_check", sql`${t.currentBidCents} is null or ${t.currentBidCents} >= 0`),
]);

export const auctionConsortiaTable = pgTable("auction_consortia", {
  id: serial("id").primaryKey(),
  auctionId: integer("auction_id").notNull().references(() => auctionSessionsTable.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  bidderId: integer("bidder_id").references(() => biddersTable.id),
  active: integer("active").notNull().default(1),
}, (t) => [
  uniqueIndex("auction_consortia_name_idx").on(t.auctionId, t.displayName),
  uniqueIndex("auction_consortia_bidder_idx").on(t.auctionId, t.bidderId).where(sql`${t.bidderId} is not null`),
]);

export const auctionSalesTable = pgTable("auction_sales", {
  id: serial("id").primaryKey(),
  auctionId: integer("auction_id").notNull().references(() => auctionSessionsTable.id, { onDelete: "cascade" }),
  lotId: integer("lot_id").notNull().references(() => auctionLotsTable.id),
  totalCents: integer("total_cents").notNull(),
  source: text("source").notNull().default("manual"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  correctedAt: timestamp("corrected_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("auction_sales_lot_idx").on(t.lotId),
  check("auction_sales_positive_check", sql`${t.totalCents} > 0`),
]);

export const auctionSaleAllocationsTable = pgTable("auction_sale_allocations", {
  id: serial("id").primaryKey(),
  saleId: integer("sale_id").notNull().references(() => auctionSalesTable.id, { onDelete: "cascade" }),
  bidderId: integer("bidder_id").notNull().references(() => biddersTable.id),
  share: numeric("share", { precision: 9, scale: 6 }).notNull(),
  cents: integer("cents").notNull(),
}, (t) => [
  uniqueIndex("auction_sale_allocations_bidder_idx").on(t.saleId, t.bidderId),
  check("auction_sale_allocations_share_check", sql`${t.share} > 0 and ${t.share} <= 1`),
  check("auction_sale_allocations_cents_check", sql`${t.cents} > 0`),
]);

export const auctionEventsTable = pgTable("auction_events", {
  id: serial("id").primaryKey(),
  auctionId: integer("auction_id").notNull().references(() => auctionSessionsTable.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  eventType: text("event_type").notNull(),
  idempotencyKey: text("idempotency_key"),
  nominationId: text("nomination_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("auction_events_sequence_idx").on(t.auctionId, t.sequence),
  uniqueIndex("auction_events_idempotency_idx").on(t.auctionId, t.idempotencyKey),
]);