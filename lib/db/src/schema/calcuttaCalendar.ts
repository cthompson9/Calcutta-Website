import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { calcuttasTable } from "./calcuttas";
import { teamsTable } from "./teams";
import { mtmSnapshotTable } from "./mtmPipeline";

export const scheduleStates = ["not_applicable", "not_loaded", "loaded"] as const;
export const calendarFormats = ["nfl_single_elimination", "nba_seven_game", "mlb_series", "march_madness_64"] as const;

export const calcuttaCalendarsTable = pgTable("calcutta_calendars", {
  id: serial("id").primaryKey(),
  calcuttaId: integer("calcutta_id").notNull(),
  format: text("format").notNull(),
  scheduleState: text("schedule_state").notNull().default("not_loaded"),
  scheduleAbsentReason: text("schedule_absent_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("cal_cal_calcutta_uq").on(t.calcuttaId),
  check("cal_cal_format_ck", sql`${t.format} IN ('nfl_single_elimination','nba_seven_game','mlb_series','march_madness_64')`),
  check("cal_cal_state_ck", sql`${t.scheduleState} IN ('not_applicable','not_loaded','loaded')`),
  check("cal_cal_absence_ck", sql`${t.scheduleState} <> 'not_applicable' OR ${t.scheduleAbsentReason} IS NOT NULL`),
  foreignKey({ columns: [t.calcuttaId], foreignColumns: [calcuttasTable.id], name: "cal_cal_fk" }).onDelete("cascade"),
]);

export const calendarParticipantsTable = pgTable("calendar_participants", {
  id: serial("id").primaryKey(),
  calendarId: integer("calendar_id").notNull(),
  teamId: integer("team_id").notNull(),
  seed: integer("seed"),
  designation: text("designation"),
}, (t) => [
  uniqueIndex("cal_par_cal_team_uq").on(t.calendarId, t.teamId),
  check("cal_par_seed_ck", sql`${t.seed} IS NULL OR ${t.seed} > 0`),
  check("cal_par_desig_ck", sql`${t.designation} IS NULL OR ${t.designation} IN ('home','away')`),
  foreignKey({ columns: [t.calendarId], foreignColumns: [calcuttaCalendarsTable.id], name: "cal_par_cal_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.teamId], foreignColumns: [teamsTable.id], name: "cal_par_team_fk" }),
]);

export const calendarRoundsTable = pgTable("calendar_rounds", {
  id: serial("id").primaryKey(),
  calendarId: integer("calendar_id").notNull(),
  sequence: integer("sequence").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
}, (t) => [uniqueIndex("cal_rnd_cal_seq_uq").on(t.calendarId, t.sequence), check("cal_rnd_seq_ck", sql`${t.sequence} > 0`), foreignKey({ columns: [t.calendarId], foreignColumns: [calcuttaCalendarsTable.id], name: "cal_rnd_cal_fk" }).onDelete("cascade")]);

export const calendarSlotsTable: any = pgTable("calendar_slots", {
  id: serial("id").primaryKey(),
  roundId: integer("round_id").notNull(),
  slotNumber: integer("slot_number").notNull(),
  homeSourceSlotId: integer("home_source_slot_id"),
  awaySourceSlotId: integer("away_source_slot_id"),
}, (t) => [
  uniqueIndex("cal_slt_rnd_num_uq").on(t.roundId, t.slotNumber),
  check("cal_slt_src_ck", sql`${t.homeSourceSlotId} IS NULL OR ${t.awaySourceSlotId} IS NULL OR ${t.homeSourceSlotId} <> ${t.awaySourceSlotId}`),
  foreignKey({ columns: [t.roundId], foreignColumns: [calendarRoundsTable.id], name: "cal_slt_rnd_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.homeSourceSlotId], foreignColumns: [calendarSlotsTable.id as AnyPgColumn], name: "cal_slt_home_src_fk" }),
  foreignKey({ columns: [t.awaySourceSlotId], foreignColumns: [calendarSlotsTable.id as AnyPgColumn], name: "cal_slt_away_src_fk" }),
]);

export const calendarSlotCandidatesTable = pgTable("calendar_slot_candidates", {
  id: serial("id").primaryKey(),
  slotId: integer("slot_id").notNull(),
  participantId: integer("participant_id"),
  sourceSlotId: integer("source_slot_id"),
  seed: integer("seed"),
  designation: text("designation"),
}, (t) => [
  check("cal_can_one_src_ck", sql`(${t.participantId} IS NOT NULL)::integer + (${t.sourceSlotId} IS NOT NULL)::integer = 1`),
  check("cal_can_desig_ck", sql`${t.designation} IS NULL OR ${t.designation} IN ('home','away')`),
  check("cal_can_seed_ck", sql`${t.seed} IS NULL OR ${t.seed} > 0`),
  foreignKey({ columns: [t.slotId], foreignColumns: [calendarSlotsTable.id], name: "cal_can_slt_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.participantId], foreignColumns: [calendarParticipantsTable.id], name: "cal_can_par_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.sourceSlotId], foreignColumns: [calendarSlotsTable.id], name: "cal_can_src_fk" }).onDelete("cascade"),
]);

export const calendarSeriesTable = pgTable("calendar_series", {
  id: serial("id").primaryKey(),
  slotId: integer("slot_id").notNull(),
  bestOf: integer("best_of").notNull(),
}, (t) => [check("cal_ser_best_ck", sql`${t.bestOf} IN (3,5,7)`), foreignKey({ columns: [t.slotId], foreignColumns: [calendarSlotsTable.id], name: "cal_ser_slt_fk" }).onDelete("cascade")]);

export const calendarGamesTable = pgTable("calendar_games", {
  id: serial("id").primaryKey(),
  slotId: integer("slot_id").notNull(),
  gameNumber: integer("game_number").notNull(),
  homeParticipantId: integer("home_participant_id"),
  awayParticipantId: integer("away_participant_id"),
  neutralSite: boolean("neutral_site").notNull().default(false),
}, (t) => [
  uniqueIndex("cal_gam_slt_num_uq").on(t.slotId, t.gameNumber),
  check("cal_gam_distinct_ck", sql`${t.homeParticipantId} IS NULL OR ${t.awayParticipantId} IS NULL OR ${t.homeParticipantId} <> ${t.awayParticipantId}`),
  foreignKey({ columns: [t.slotId], foreignColumns: [calendarSlotsTable.id], name: "cal_gam_slt_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.homeParticipantId], foreignColumns: [calendarParticipantsTable.id], name: "cal_gam_home_fk" }),
  foreignKey({ columns: [t.awayParticipantId], foreignColumns: [calendarParticipantsTable.id], name: "cal_gam_away_fk" }),
]);

export const calendarContingentGamesTable = pgTable("calendar_contingent_games", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  prerequisiteSlotId: integer("prerequisite_slot_id").notNull(),
  outcome: text("outcome").notNull(),
}, (t) => [uniqueIndex("cal_con_key_uq").on(t.gameId, t.prerequisiteSlotId, t.outcome), foreignKey({ columns: [t.gameId], foreignColumns: [calendarGamesTable.id], name: "cal_con_gam_fk" }).onDelete("cascade"), foreignKey({ columns: [t.prerequisiteSlotId], foreignColumns: [calendarSlotsTable.id], name: "cal_con_prq_fk" })]);

export const calendarProjectionSnapshotsTable = pgTable("calendar_projection_snapshots", {
  id: serial("id").primaryKey(),
  slotId: integer("slot_id").notNull(),
  mtmSnapshotId: integer("mtm_snapshot_id").notNull(),
  status: text("status").notNull(),
  unavailableReason: text("unavailable_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("cal_prj_slt_mtm_uq").on(t.slotId, t.mtmSnapshotId),
  check("cal_prj_status_ck", sql`${t.status} IN ('available','unavailable')`),
  check("cal_prj_unavail_ck", sql`${t.status} <> 'unavailable' OR ${t.unavailableReason} IS NOT NULL`),
  foreignKey({ columns: [t.slotId], foreignColumns: [calendarSlotsTable.id], name: "cal_prj_slt_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.mtmSnapshotId], foreignColumns: [mtmSnapshotTable.id], name: "cal_prj_mtm_fk" }),
]);

export const calendarProjectionCandidatesTable = pgTable("calendar_projection_candidates", {
  id: serial("id").primaryKey(),
  projectionId: integer("projection_id").notNull(),
  participantId: integer("participant_id").notNull(),
  probability: numeric("probability", { precision: 8, scale: 6 }).notNull(),
  exactSlotClinched: boolean("exact_slot_clinched").notNull().default(false),
}, (t) => [
  uniqueIndex("cal_pcan_key_uq").on(t.projectionId, t.participantId),
  check("cal_pcan_prob_ck", sql`${t.probability} >= 0 AND ${t.probability} <= 1`),
  check("cal_pcan_clinched_ck", sql`NOT ${t.exactSlotClinched} OR ${t.probability} = 1`),
  foreignKey({ columns: [t.projectionId], foreignColumns: [calendarProjectionSnapshotsTable.id], name: "cal_pcan_prj_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.participantId], foreignColumns: [calendarParticipantsTable.id], name: "cal_pcan_par_fk" }).onDelete("cascade"),
]);

export const calendarPoolEconomicsTable = pgTable("calendar_pool_economics", {
  id: serial("id").primaryKey(),
  calendarId: integer("calendar_id").notNull(),
  key: text("key").notNull(),
  value: numeric("value", { precision: 14, scale: 4 }).notNull(),
}, (t) => [uniqueIndex("cal_eco_key_uq").on(t.calendarId, t.key), foreignKey({ columns: [t.calendarId], foreignColumns: [calcuttaCalendarsTable.id], name: "cal_eco_cal_fk" }).onDelete("cascade")]);

export const calendarRubricValuesTable = pgTable("calendar_rubric_values", {
  id: serial("id").primaryKey(),
  calendarId: integer("calendar_id").notNull(),
  label: text("label").notNull(),
  points: numeric("points", { precision: 10, scale: 4 }).notNull(),
}, (t) => [uniqueIndex("cal_rub_label_uq").on(t.calendarId, t.label), foreignKey({ columns: [t.calendarId], foreignColumns: [calcuttaCalendarsTable.id], name: "cal_rub_cal_fk" }).onDelete("cascade")]);

export const insertCalcuttaCalendarSchema = createInsertSchema(calcuttaCalendarsTable).omit({ id: true, createdAt: true });
export type InsertCalcuttaCalendar = z.infer<typeof insertCalcuttaCalendarSchema>;
export type CalcuttaCalendar = typeof calcuttaCalendarsTable.$inferSelect;
