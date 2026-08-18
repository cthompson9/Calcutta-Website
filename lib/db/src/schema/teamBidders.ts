import { pgTable, primaryKey, integer, numeric } from "drizzle-orm/pg-core";
import { biddersTable } from "./bidders";
import { teamsTable } from "./teams";
import { seasonsTable } from "./seasons";

export const teamBiddersTable = pgTable(
  "team_bidders",
  {
    teamId: integer("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => biddersTable.id, { onDelete: "cascade" }),
    // nullable so we can push first, then seed seasons and backfill
    seasonId: integer("season_id").references(() => seasonsTable.id, {
      onDelete: "cascade",
    }),
    ownershipShare: numeric("ownership_share", { precision: 5, scale: 4 })
      .notNull()
      .default("1.0000"),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.bidderId] })],
);

export type TeamBidder = typeof teamBiddersTable.$inferSelect;
