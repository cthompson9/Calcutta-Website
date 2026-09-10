import { jsonb, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { seasonsTable } from "./seasons";

/**
 * Shared state for request-driven refresh jobs. Unlike import provenance,
 * this row tracks cache freshness even when a source replay is a no-op.
 */
export const refreshJobStatesTable = pgTable(
  "refresh_job_states",
  {
    id: serial("id").primaryKey(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasonsTable.id, { onDelete: "cascade" }),
    sport: text("sport").notNull().default("NFL"),
    competition: text("competition").notNull().default("NFL_REGULAR_SEASON"),
    job: text("job").notNull(),
    scheduleCache: jsonb("schedule_cache").$type<unknown>(),
    scheduleFetchedAt: timestamp("schedule_fetched_at", { withTimezone: true }),
    lastGameStatusSignature: text("last_game_status_signature"),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    lastSucceededAt: timestamp("last_succeeded_at", { withTimezone: true }),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastResult: jsonb("last_result").$type<unknown>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("refresh_job_states_season_scope_job_idx").on(
      t.seasonId,
      t.sport,
      t.competition,
      t.job,
    ),
  ],
);

export type RefreshJobState = typeof refreshJobStatesTable.$inferSelect;