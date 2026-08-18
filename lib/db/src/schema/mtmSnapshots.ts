import { pgTable, serial, integer, numeric, date, uniqueIndex } from "drizzle-orm/pg-core";
import { teamsTable } from "./teams";
import { seasonsTable } from "./seasons";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const mtmSnapshotsTable = pgTable(
  "mtm_snapshots",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasonsTable.id, { onDelete: "cascade" }),
    weekNum: integer("week_num").notNull(), // 0=pre-season, 1-18=regular season, 19+=playoffs
    snapshotDate: date("snapshot_date", { mode: "string" }),
    mtmValue: numeric("mtm_value", { precision: 10, scale: 4 }).notNull().default("0"),
  },
  (t) => [
    uniqueIndex("mtm_team_season_week_idx").on(t.teamId, t.seasonId, t.weekNum),
  ],
);

export const insertMtmSnapshotSchema = createInsertSchema(mtmSnapshotsTable).omit({ id: true });
export type InsertMtmSnapshot = z.infer<typeof insertMtmSnapshotSchema>;
export type MtmSnapshot = typeof mtmSnapshotsTable.$inferSelect;
