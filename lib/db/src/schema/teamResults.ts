import { pgTable, serial, integer, boolean, numeric, primaryKey } from "drizzle-orm/pg-core";
import { teamsTable } from "./teams";
import { seasonsTable } from "./seasons";

export const teamResultsTable = pgTable(
  "team_results",
  {
    id: serial("id"),
    teamId: integer("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasonsTable.id, { onDelete: "cascade" }),

    // Season performance stats
    wins: numeric("wins", { precision: 4, scale: 1 }).notNull().default("0"),
    ptDiff: integer("pt_diff").notNull().default(0),
    startingPoints: numeric("starting_points", { precision: 8, scale: 4 }).notNull().default("150"),
    draftOrder: integer("draft_order"),

    // Playoff results (boolean flags stored as booleans)
    playoffBerth: boolean("playoff_berth").notNull().default(false),
    divRound: boolean("div_round").notNull().default(false),
    confRound: boolean("conf_round").notNull().default(false),
    sbBerth: boolean("sb_berth").notNull().default(false),
    winSuperBowl: boolean("win_super_bowl").notNull().default(false),

    // Playoff seed within conference (1=best, 7=worst wildcard). Set via MCP.
    seed: integer("seed"),

    // Financial results
    realizedReturn: numeric("realized_return", { precision: 10, scale: 4 }).notNull().default("0"),
    realizedMultiple: numeric("realized_multiple", { precision: 10, scale: 7 }).notNull().default("0"),
    netReturn: numeric("net_return", { precision: 10, scale: 4 }).notNull().default("0"),
    netPctReturn: numeric("net_pct_return", { precision: 10, scale: 7 }).notNull().default("0"),
    markToMarket: numeric("mark_to_market", { precision: 10, scale: 4 }).notNull().default("0"),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.seasonId] })],
);

export type TeamResult = typeof teamResultsTable.$inferSelect;
