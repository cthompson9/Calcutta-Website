import { pgTable, primaryKey, integer, numeric } from "drizzle-orm/pg-core";
import { teamsTable } from "./teams";
import { seasonsTable } from "./seasons";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Season-scoped auction prices.
 * This is the authoritative source for a team's bid amount within a given season.
 * teams.bidAmount is kept as a deprecated legacy field.
 */
export const teamSeasonAuctionsTable = pgTable(
  "team_season_auctions",
  {
    teamId: integer("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasonsTable.id, { onDelete: "cascade" }),
    bidAmount: numeric("bid_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.seasonId] })],
);

export const insertTeamSeasonAuctionSchema = createInsertSchema(teamSeasonAuctionsTable);
export type InsertTeamSeasonAuction = z.infer<typeof insertTeamSeasonAuctionSchema>;
export type TeamSeasonAuction = typeof teamSeasonAuctionsTable.$inferSelect;
