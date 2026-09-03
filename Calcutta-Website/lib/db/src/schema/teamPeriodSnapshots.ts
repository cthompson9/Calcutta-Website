import { check, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { calcuttaEntriesTable } from "./calcuttaEntries";
import { sportPeriodsTable } from "./sportPeriods";

export const teamPeriodSnapshotsTable = pgTable(
  "team_period_snapshots",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => calcuttaEntriesTable.id, { onDelete: "cascade" }),
    periodId: integer("period_id")
      .notNull()
      .references(() => sportPeriodsTable.id, { onDelete: "cascade" }),
    basis: text("basis").notNull(),
    wins: numeric("wins", { precision: 8, scale: 4 }).notNull().default("0"),
    losses: numeric("losses", { precision: 8, scale: 4 }).notNull().default("0"),
    ties: numeric("ties", { precision: 8, scale: 4 }).notNull().default("0"),
    ptDiff: numeric("pt_diff", { precision: 10, scale: 4 }).notNull().default("0"),
    ordinaryWins: numeric("ordinary_wins", { precision: 8, scale: 4 }).notNull().default("0"),
    marqueeWins: numeric("marquee_wins", { precision: 8, scale: 4 }).notNull().default("0"),
    ordinaryTies: numeric("ordinary_ties", { precision: 8, scale: 4 }).notNull().default("0"),
    marqueeTies: numeric("marquee_ties", { precision: 8, scale: 4 }).notNull().default("0"),
    ordinaryPtDiff: numeric("ordinary_pt_diff", { precision: 10, scale: 4 }).notNull().default("0"),
    marqueePtDiff: numeric("marquee_pt_diff", { precision: 10, scale: 4 }).notNull().default("0"),
    playoffBerth: numeric("playoff_berth", { precision: 8, scale: 6 }).notNull().default("0"),
    divRound: numeric("div_round", { precision: 8, scale: 6 }).notNull().default("0"),
    confRound: numeric("conf_round", { precision: 8, scale: 6 }).notNull().default("0"),
    sbBerth: numeric("sb_berth", { precision: 8, scale: 6 }).notNull().default("0"),
    winSuperBowl: numeric("win_super_bowl", { precision: 8, scale: 6 }).notNull().default("0"),
    playoffStatus: text("playoff_status").notNull().default("unknown"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("team_period_snapshots_entry_period_basis_idx").on(
      t.entryId,
      t.periodId,
      t.basis,
    ),
    check("team_period_snapshots_basis_supported", sql`${t.basis} IN ('realized', 'mtm')`),
    check(
      "team_period_snapshots_playoff_status_supported",
      sql`${t.playoffStatus} IN ('unknown', 'alive', 'clinched', 'eliminated')`,
    ),
    check("team_period_snapshots_wins_non_negative", sql`${t.wins} >= 0`),
    check("team_period_snapshots_losses_non_negative", sql`${t.losses} >= 0`),
    check("team_period_snapshots_ties_non_negative", sql`${t.ties} >= 0`),
    check(
      "team_period_snapshots_playoff_bounds",
      sql`${t.playoffBerth} >= 0 AND ${t.playoffBerth} <= 1 AND ${t.divRound} >= 0 AND ${t.divRound} <= 1 AND ${t.confRound} >= 0 AND ${t.confRound} <= 1 AND ${t.sbBerth} >= 0 AND ${t.sbBerth} <= 1 AND ${t.winSuperBowl} >= 0 AND ${t.winSuperBowl} <= 1`,
    ),
  ],
);

export const insertTeamPeriodSnapshotSchema = createInsertSchema(teamPeriodSnapshotsTable).omit({
  id: true,
  capturedAt: true,
});
export type InsertTeamPeriodSnapshot = z.infer<typeof insertTeamPeriodSnapshotSchema>;
export type TeamPeriodSnapshot = typeof teamPeriodSnapshotsTable.$inferSelect;