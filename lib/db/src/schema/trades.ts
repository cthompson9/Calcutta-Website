import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  integer,
  numeric,
  date,
  text,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { teamsTable } from "./teams";
import { seasonsTable } from "./seasons";
import { biddersTable } from "./bidders";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable(
  "trades",
  {
    id: serial("id").primaryKey(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasonsTable.id, { onDelete: "cascade" }),
    teamId: integer("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    fromBidderId: integer("from_bidder_id")
      .notNull()
      .references(() => biddersTable.id),
    toBidderId: integer("to_bidder_id")
      .notNull()
      .references(() => biddersTable.id),
    price: numeric("price", { precision: 10, scale: 2 }).notNull().default("0"),
    /** Percentage of the team traded, 1–100. Default 100 = full ownership transfer. */
    percentage: numeric("percentage", { precision: 5, scale: 2 }).notNull().default("100"),
    /** Approval workflow: pending → approved | rejected */
    status: text("status").notNull().default("pending"),
    /** Immutable audit metadata for a commissioner approval or rejection. */
    decisionAt: timestamp("decision_at", { withTimezone: true }),
    /** Trusted channel that recorded the commissioner decision; never stores credentials. */
    decisionSource: text("decision_source"),
    tradeDate: date("trade_date", { mode: "string" }).notNull(),
    notes: text("notes"),
  },
  (t) => [
    // Trade price must be non-negative (zero-cost transfers are permitted)
    check("trades_price_nonneg", sql`${t.price} >= 0`),
    // Percentage must be a meaningful fraction of ownership (1–100)
    check("trades_percentage_range", sql`${t.percentage} >= 1 AND ${t.percentage} <= 100`),
    // A bidder cannot trade a team to themselves
    check("trades_seller_ne_buyer", sql`${t.fromBidderId} <> ${t.toBidderId}`),
    // Only known workflow states are valid
    check(
      "trades_status_values",
      sql`${t.status} IN ('pending', 'approved', 'rejected')`,
    ),
    // Quickly retrieve all trades for a season (dashboard, bulk ops)
    index("trades_season_idx").on(t.seasonId),
    // Filter by team within a season
    index("trades_season_team_idx").on(t.seasonId, t.teamId),
    // Filter pending approvals
    index("trades_status_idx").on(t.status),
  ],
);

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
