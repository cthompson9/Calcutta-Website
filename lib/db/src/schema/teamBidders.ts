import { sql } from "drizzle-orm";
import {
  pgTable,
  primaryKey,
  integer,
  numeric,
  index,
  check,
} from "drizzle-orm/pg-core";
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
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasonsTable.id, {
        onDelete: "cascade",
      }),
    ownershipShare: numeric("ownership_share", { precision: 5, scale: 4 })
      .notNull()
      .default("1.0000"),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.bidderId, t.seasonId] }),
    // ownership_share is the primary auction stake — must be a valid fraction (0, 1]
    check(
      "team_bidders_ownership_share_range",
      sql`${t.ownershipShare} > 0 AND ${t.ownershipShare} <= 1`,
    ),
    // Quickly find all team owners for a season
    index("team_bidders_season_team_idx").on(t.seasonId, t.teamId),
    // Quickly find all teams owned by a bidder in a season
    index("team_bidders_season_bidder_idx").on(t.seasonId, t.bidderId),
  ],
);

export type TeamBidder = typeof teamBiddersTable.$inferSelect;
