import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { biddersTable } from "./bidders";
import { calcuttasTable } from "./calcuttas";
import { consortiaTable } from "./consortia";
import {
  normalizedCalcuttasTable,
  normalizedCalcuttaOwnersTable,
  normalizedOwnersTable,
} from "./normalizedHistorical";

export const historicalCalcuttaRostersTable = pgTable(
  "historical_calcutta_rosters",
  {
    id: serial("id").primaryKey(),
    calcuttaId: integer("calcutta_id")
      .notNull()
      .references(() => normalizedCalcuttasTable.id, { onDelete: "cascade" }),
    ownerId: integer("owner_id").references(() => normalizedOwnersTable.id),
    bidderId: integer("bidder_id").references(() => biddersTable.id, {
      onDelete: "set null",
    }),
    consortiumId: integer("consortium_id").references(() => consortiaTable.id, {
      onDelete: "restrict",
    }),
    sourceOwnerLabel: text("source_owner_label").notNull(),
    sourcePath: text("source_path").notNull(),
    sourceHash: text("source_hash").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.calcuttaId, t.ownerId],
      foreignColumns: [
        normalizedCalcuttaOwnersTable.calcuttaId,
        normalizedCalcuttaOwnersTable.ownerId,
      ],
      name: "historical_calcutta_rosters_pool_owner_fkey",
    }).onDelete("cascade"),
    uniqueIndex("historical_calcutta_rosters_source_label_idx").on(
      t.calcuttaId,
      t.sourceOwnerLabel,
    ),
    uniqueIndex("historical_calcutta_rosters_pool_owner_idx")
      .on(t.calcuttaId, t.ownerId)
      .where(sql`${t.ownerId} is not null`),
    index("historical_calcutta_rosters_bidder_idx").on(
      t.calcuttaId,
      t.bidderId,
    ),
    index("historical_calcutta_rosters_consortium_idx").on(t.consortiumId),
  ],
);

export type HistoricalCalcuttaRoster =
  typeof historicalCalcuttaRostersTable.$inferSelect;

export const historicalCalcuttaLinksTable = pgTable(
  "historical_calcutta_links",
  {
    normalizedCalcuttaId: integer("normalized_calcutta_id")
      .primaryKey()
      .references(() => normalizedCalcuttasTable.id, { onDelete: "cascade" }),
    legacyCalcuttaId: integer("legacy_calcutta_id")
      .notNull()
      .references(() => calcuttasTable.id, { onDelete: "restrict" }),
    sourcePath: text("source_path").notNull(),
    sourceHash: text("source_hash").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("historical_calcutta_links_legacy_idx").on(t.legacyCalcuttaId),
  ],
);