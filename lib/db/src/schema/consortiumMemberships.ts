import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgTable,
  serial,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { biddersTable } from "./bidders";
import { consortiaTable } from "./consortia";

export const consortiumMembershipsTable = pgTable(
  "consortium_memberships",
  {
    id: serial("id").primaryKey(),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => biddersTable.id, { onDelete: "cascade" }),
    consortiumId: integer("consortium_id")
      .notNull()
      .references(() => consortiaTable.id, { onDelete: "cascade" }),
    fromDate: date("from_date", { mode: "string" }).notNull(),
    toDate: date("to_date", { mode: "string" }),
  },
  (t) => [
    index("consortium_memberships_bidder_dates_idx").on(
      t.bidderId,
      t.fromDate,
      t.toDate,
    ),
    index("consortium_memberships_consortium_idx").on(t.consortiumId),
    uniqueIndex("consortium_memberships_exact_interval_idx").on(
      t.bidderId,
      t.consortiumId,
      t.fromDate,
    ),
    uniqueIndex("consortium_memberships_one_active_bidder_idx")
      .on(t.bidderId)
      .where(sql`${t.toDate} IS NULL`),
    check(
      "consortium_memberships_date_order",
      sql`${t.toDate} IS NULL OR ${t.toDate} > ${t.fromDate}`,
    ),
  ],
);

export type ConsortiumMembership = typeof consortiumMembershipsTable.$inferSelect;