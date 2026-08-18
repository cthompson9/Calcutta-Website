import { pgTable, serial, integer, numeric, date, text } from "drizzle-orm/pg-core";
import { teamsTable } from "./teams";
import { seasonsTable } from "./seasons";
import { biddersTable } from "./bidders";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
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
  /** Percentage of the team traded, 0–100. Default 100 = full ownership transfer. */
  percentage: numeric("percentage", { precision: 5, scale: 2 }).notNull().default("100"),
  /** Approval workflow: pending → approved | rejected */
  status: text("status").notNull().default("pending"),
  tradeDate: date("trade_date", { mode: "string" }).notNull(),
  notes: text("notes"),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
