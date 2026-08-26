import {
  integer,
  numeric,
  pgView,
} from "drizzle-orm/pg-core";

/**
 * Read-only legacy compatibility projection. Primary ownership is stored in
 * positions; this view intentionally has no insert/update/delete table API.
 */
export const teamBiddersTable = pgView(
  "team_bidders",
  {
    teamId: integer("team_id").notNull(),
    bidderId: integer("bidder_id").notNull(),
    seasonId: integer("season_id").notNull(),
    ownershipShare: numeric("ownership_share", { precision: 9, scale: 6 }).notNull(),
  },
).existing();

export type TeamBidder = typeof teamBiddersTable.$inferSelect;
