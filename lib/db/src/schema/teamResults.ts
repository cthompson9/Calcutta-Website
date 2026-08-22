import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  integer,
  boolean,
  numeric,
  primaryKey,
  check,
  index,
} from "drizzle-orm/pg-core";
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
    losses: integer("losses").notNull().default(0),
    ties: integer("ties").notNull().default(0),
    ptDiff: integer("pt_diff").notNull().default(0),
    startingPoints: numeric("starting_points", { precision: 8, scale: 4 })
      .notNull()
      .default("150"),
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
    realizedReturn: numeric("realized_return", { precision: 10, scale: 4 })
      .notNull()
      .default("0"),
    realizedMultiple: numeric("realized_multiple", { precision: 10, scale: 7 })
      .notNull()
      .default("0"),
    netReturn: numeric("net_return", { precision: 10, scale: 4 })
      .notNull()
      .default("0"),
    netPctReturn: numeric("net_pct_return", { precision: 10, scale: 7 })
      .notNull()
      .default("0"),
    markToMarket: numeric("mark_to_market", { precision: 10, scale: 4 })
      .notNull()
      .default("0"),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.seasonId] }),
    // Existing guard: total games must not exceed a full 17-game season
    check(
      "team_results_record_total_at_most_17",
      sql`${t.wins} + ${t.losses} + ${t.ties} <= 17`,
    ),
    // Wins, losses, and ties must be non-negative
    check("team_results_wins_nonneg", sql`${t.wins} >= 0`),
    check("team_results_losses_nonneg", sql`${t.losses} >= 0`),
    check("team_results_ties_nonneg", sql`${t.ties} >= 0`),
    // Playoff seed is either NULL (unset) or a valid 1–7 value
    check(
      "team_results_seed_range",
      sql`${t.seed} IS NULL OR (${t.seed} >= 1 AND ${t.seed} <= 7)`,
    ),
    // Quickly load all results for a season
    index("team_results_season_idx").on(t.seasonId),
  ],
);

export type TeamResult = typeof teamResultsTable.$inferSelect;
