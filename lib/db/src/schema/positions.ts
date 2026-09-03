import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { biddersTable } from "./bidders";
import { calcuttaEntriesTable } from "./calcuttaEntries";
import { tradesTable } from "./trades";

/**
 * Migration 0013 owns the functions/triggers
 * enforce_positions_entry_ownership_total / positions_entry_ownership_total
 * and prevent_approved_trade_primary_position_change /
 * positions_primary_approved_trade_immutable. Drizzle does not model trigger
 * functions or deferred constraint triggers.
 */
export const positionsTable = pgTable(
  "positions",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => calcuttaEntriesTable.id, { onDelete: "cascade" }),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => biddersTable.id, { onDelete: "cascade" }),
    /** Signed fraction: primary rows are positive; trade legs may be negative. */
    ownershipShare: numeric("ownership_share", { precision: 9, scale: 6 }).notNull(),
    source: text("source").notNull(),
    /** Positive for cash paid and negative for cash received on a position leg. */
    costBasis: numeric("cost_basis", { precision: 12, scale: 2 }).notNull().default("0"),
    tradeId: integer("trade_id").references(() => tradesTable.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("positions_entry_idx").on(t.entryId),
    index("positions_bidder_idx").on(t.bidderId),
    index("positions_trade_idx").on(t.tradeId),
    uniqueIndex("positions_source_trade_idx").on(
      t.entryId,
      t.bidderId,
      t.source,
      t.tradeId,
    ),
    uniqueIndex("positions_primary_entry_bidder_idx")
      .on(t.entryId, t.bidderId)
      .where(sql`${t.source} = 'primary'`),
    check(
      "positions_source_values",
      sql`${t.source} IN ('primary', 'trade')`,
    ),
    check(
      "positions_primary_positive",
      sql`${t.source} <> 'primary' OR ${t.ownershipShare} > 0`,
    ),
  ],
);

export type Position = typeof positionsTable.$inferSelect;