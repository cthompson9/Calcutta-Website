import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid, boolean } from "drizzle-orm/pg-core";
import { auctionSessionsTable } from "./auction";

export const listenerTicketsTable = pgTable("listener_tickets", {
  hash: text("hash").primaryKey(),
  auctionId: integer("auction_id").notNull().references(() => auctionSessionsTable.id, { onDelete: "cascade" }),
  origin: text("origin").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redemptionId: uuid("redemption_id"),
  sessionId: uuid("session_id"),
}, (t) => [index("listener_tickets_expiry_idx").on(t.expiresAt)]);

export const listenerSessionsTable = pgTable("listener_sessions", {
  id: uuid("id").primaryKey(),
  auctionId: integer("auction_id").notNull().references(() => auctionSessionsTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  recording: boolean("recording").notNull().default(false),
  pending: integer("pending").notNull().default(0),
}, (t) => [index("listener_sessions_auction_idx").on(t.auctionId)]);

export const listenerTranscriptEventsTable = pgTable("listener_transcript_events", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  listenerSessionId: uuid("listener_session_id").notNull().references(() => listenerSessionsTable.id, { onDelete: "cascade" }),
  eventId: text("event_id").notNull(),
  localSessionId: text("local_session_id").notNull(),
  uploadId: text("upload_id").notNull(),
  websiteSessionId: uuid("website_session_id").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  eventType: text("event_type").notNull(),
  transcript: text("transcript").notNull(),
  participant: text("participant"),
}, (t) => [
  uniqueIndex("listener_transcript_session_event_idx").on(t.listenerSessionId, t.eventId),
  index("listener_transcript_auction_time_idx").on(t.listenerSessionId, t.receivedAt),
]);