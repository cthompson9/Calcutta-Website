import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { seasonsTable } from "./seasons";
import { teamsTable } from "./teams";

/** Auditable, idempotent source record for a completed NFL game. */
export const nflGamesTable = pgTable(
  "nfl_games",
  {
    id: serial("id").primaryKey(),
    seasonId: integer("season_id").notNull().references(() => seasonsTable.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("manual"),
    sourceGameId: text("source_game_id").notNull(),
    periodSequence: integer("period_sequence").notNull(),
    round: text("round").notNull().default("regular"),
    homeTeamId: integer("home_team_id").notNull().references(() => teamsTable.id),
    awayTeamId: integer("away_team_id").notNull().references(() => teamsTable.id),
    homeScore: integer("home_score").notNull(),
    awayScore: integer("away_score").notNull(),
    actualKickoffAt: timestamp("actual_kickoff_at", { withTimezone: true }).notNull(),
    isMarquee: boolean("is_marquee").notNull().default(false),
    marqueeMultiplier: integer("marquee_multiplier").notNull().default(1),
    status: text("status").notNull().default("final"),
    sourceData: jsonb("source_data").$type<Record<string, unknown> | null>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("nfl_games_season_source_game_idx").on(t.seasonId, t.source, t.sourceGameId),
    index("nfl_games_season_period_idx").on(t.seasonId, t.periodSequence),
    index("nfl_games_home_team_idx").on(t.homeTeamId),
    index("nfl_games_away_team_idx").on(t.awayTeamId),
  ],
);

export const insertNflGameSchema = createInsertSchema(nflGamesTable).omit({ id: true, updatedAt: true });
export type InsertNflGame = z.infer<typeof insertNflGameSchema>;
export type NflGame = typeof nflGamesTable.$inferSelect;