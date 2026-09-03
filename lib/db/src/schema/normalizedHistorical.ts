import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  pgView,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Migration 0020 owns enforce_normalized_entry_ownership_total /
 * normalized_positions_net_one and the v_tracking, v_entry_results, and
 * v_owner_results views. Drizzle does not model deferred trigger functions,
 * and these migration-defined reporting views intentionally remain outside
 * the table schema.
 */
/**
 * Stage-1's historical ledger is deliberately namespaced.  The unprefixed
 * calcutta/teams/positions relations are the live XII read model and must not
 * be repurposed until the offseason.
 */
export const normalizedCompetitionFormatsTable = pgTable(
  "competition_formats",
  {
    key: text("key").primaryKey(),
    sport: text("sport").notNull(),
    structure: text("structure").notNull(),
    definition: jsonb("definition").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "competition_formats_structure_check",
      sql`${t.structure} in ('league','single_elim','series_bracket','group_knockout')`,
    ),
  ],
);

export const normalizedFormatPeriodsTable = pgTable("format_periods", {
  formatKey: text("format_key").notNull().references(() => normalizedCompetitionFormatsTable.key, { onDelete: "cascade" }),
  key: text("key").notNull(),
  sequence: integer("seq").notNull(),
  label: text("label").notNull(),
  kind: text("kind").notNull().default("regular"),
  weight: numeric("weight", { precision: 10, scale: 4 }).notNull().default("1"),
  isScored: boolean("is_scored").notNull().default(true),
}, (t) => [
  primaryKey({ columns: [t.formatKey, t.key], name: "format_periods_pkey" }),
  uniqueIndex("format_periods_format_seq_idx").on(t.formatKey, t.sequence),
  check(
    "format_periods_kind_check",
    sql`${t.kind} in ('baseline','regular','group','knockout')`,
  ),
]);

export const normalizedCalcuttasTable = pgTable("normalized_calcuttas", {
  id: serial("id").primaryKey(),
  editionNumber: integer("edition_number").notNull(),
  name: text("name").notNull(),
  sport: text("sport").notNull(),
  formatKey: text("format_key").notNull().references(() => normalizedCompetitionFormatsTable.key),
  seasonYear: integer("season_year").notNull(),
  potSize: numeric("pot_size", { precision: 14, scale: 2 }),
  asOfDate: date("as_of_date", { mode: "string" }),
  normalization: jsonb("normalization").notNull(),
  status: text("status").notNull().default("complete"),
}, (t) => [
  uniqueIndex("normalized_calcuttas_edition_idx").on(t.editionNumber),
  uniqueIndex("normalized_calcuttas_name_idx").on(t.name),
]);

export const normalizedOwnersTable = pgTable("normalized_owners", {
  id: serial("id").primaryKey(),
  displayName: text("display_name").notNull(),
  email: text("email"),
}, (t) => [uniqueIndex("normalized_owners_display_name_idx").on(t.displayName)]);

export const normalizedCalcuttaOwnersTable = pgTable("normalized_calcutta_owners", {
  calcuttaId: integer("calcutta_id").notNull(),
  ownerId: integer("owner_id").notNull().references(() => normalizedOwnersTable.id),
  label: text("label").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.calcuttaId],
    foreignColumns: [normalizedCalcuttasTable.id],
    name: "normalized_calcutta_owners_calcutta_fk",
  }).onDelete("cascade"),
  primaryKey({ columns: [t.calcuttaId, t.ownerId], name: "normalized_calcutta_owners_pkey" }),
  uniqueIndex("normalized_calcutta_owners_label_idx").on(t.calcuttaId, t.label),
]);

export const normalizedTeamsTable = pgTable("normalized_teams", {
  id: serial("id").primaryKey(),
  sport: text("sport").notNull(),
  name: text("name").notNull(),
}, (t) => [uniqueIndex("normalized_teams_sport_name_idx").on(t.sport, t.name)]);

export const normalizedEntriesTable = pgTable("normalized_entries", {
  id: serial("id").primaryKey(),
  calcuttaId: integer("calcutta_id").notNull().references(() => normalizedCalcuttasTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  lotOrder: integer("lot_order"),
  price: numeric("price", { precision: 14, scale: 2 }).notNull(),
  kind: text("kind").notNull().default("single"),
  attributes: jsonb("attributes"),
}, (t) => [
  uniqueIndex("normalized_entries_calcutta_label_idx").on(t.calcuttaId, t.label),
  index("normalized_entries_calcutta_idx").on(t.calcuttaId),
  check(
    "normalized_entries_kind_check",
    sql`${t.kind} in ('single','bundle','placeholder')`,
  ),
]);

export const normalizedEntryTeamsTable = pgTable("normalized_entry_teams", {
  entryId: integer("entry_id").notNull().references(() => normalizedEntriesTable.id, { onDelete: "cascade" }),
  teamId: integer("team_id").notNull().references(() => normalizedTeamsTable.id),
  seed: integer("seed"),
  resolved: boolean("resolved").notNull().default(true),
}, (t) => [primaryKey({ columns: [t.entryId, t.teamId], name: "normalized_entry_teams_pkey" })]);

export const normalizedPositionsTable = pgTable("normalized_positions", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id").notNull().references(() => normalizedEntriesTable.id, { onDelete: "cascade" }),
  ownerId: integer("owner_id").notNull().references(() => normalizedOwnersTable.id),
  share: numeric("share", { precision: 9, scale: 6 }).notNull(),
  source: text("source").notNull().default("primary"),
  tradeId: integer("trade_id"),
}, (t) => [
  index("normalized_positions_entry_idx").on(t.entryId),
  check(
    "normalized_positions_source_check",
    sql`${t.source} in ('primary','trade')`,
  ),
]);

export const normalizedTradesTable = pgTable("normalized_trades", {
  id: serial("id").primaryKey(),
  calcuttaId: integer("calcutta_id")
    .notNull()
    .references(() => normalizedCalcuttasTable.id, { onDelete: "cascade" }),
  sheetRef: text("sheet_ref"),
  tradeDate: date("trade_date", { mode: "string" }),
  detail: text("detail"),
  scope: text("scope").notNull().default("entry"),
  entryId: integer("entry_id").references(() => normalizedEntriesTable.id),
  fromOwnerId: integer("from_owner_id").references(() => normalizedOwnersTable.id),
  toOwnerId: integer("to_owner_id").references(() => normalizedOwnersTable.id),
  pct: numeric("pct", { precision: 9, scale: 6 }),
  cash: numeric("cash", { precision: 14, scale: 6 }),
  status: text("status").notNull().default("approved"),
  referenceOwnerId: integer("reference_owner_id").references(() => normalizedOwnersTable.id),
  factor: numeric("factor", { precision: 9, scale: 4 }),
  basis: text("basis"),
  sourceData: jsonb("source_data").notNull(),
}, (t) => [
  index("normalized_trades_calcutta_idx").on(t.calcuttaId),
  index("normalized_trades_entry_idx").on(t.entryId),
  check(
    "normalized_trades_scope_check",
    sql`${t.scope} in ('entry','book','synthetic_book','sidebet','cash')`,
  ),
  check(
    "normalized_trades_basis_check",
    sql`${t.basis} is null or ${t.basis} in ('lion_king','net')`,
  ),
  check(
    "normalized_trades_scope_shape",
    sql`(${t.scope} = 'entry' and ${t.entryId} is not null and ${t.basis} is null)
      or (${t.scope} in ('book','synthetic_book') and ${t.basis} is not null)
      or (${t.scope} in ('sidebet','cash') and ${t.basis} is null and ${t.factor} is null)`,
  ),
]);

export const normalizedScoringRulesTable = pgTable("normalized_scoring_rules", {
  id: serial("id").primaryKey(),
  calcuttaId: integer("calcutta_id").notNull().references(() => normalizedCalcuttasTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  metric: text("metric"),
  periodKey: text("period_key"),
  rate: numeric("rate", { precision: 14, scale: 8 }).notNull(),
  groupAttr: text("group_attr"),
  fallback: text("fallback").array(),
  note: text("note"),
}, (t) => [
  index("normalized_scoring_rules_calcutta_idx").on(t.calcuttaId),
  check(
    "normalized_scoring_rules_kind_check",
    sql`${t.kind} in ('per_unit','direct_share','group_rank_bonus','split_pool')`,
  ),
]);

export const normalizedScoringEventsTable = pgTable("normalized_scoring_events", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id").notNull().references(() => normalizedEntriesTable.id, { onDelete: "cascade" }),
  periodKey: text("period_key"),
  metric: text("metric").notNull(),
  units: numeric("units", { precision: 12, scale: 4 }).notNull(),
  source: text("source").notNull().default("sheet"),
}, (t) => [
  /**
   * Migration 0020 owns this constraint's NULLS NOT DISTINCT modifier.
   * drizzle-kit 0.31 introspection drops that modifier, so spelling it here
   * makes every push try to replace the already-correct populated constraint.
   * Keep this introspection-compatible declaration until that bug is fixed.
   */
  unique("normalized_scoring_events_entry_period_metric_idx").on(
    t.entryId,
    t.periodKey,
    t.metric,
  ),
  index("normalized_scoring_events_entry_idx").on(t.entryId),
]);

export const normalizedExpectedEntryResultsTable = pgTable("normalized_expected_entry_results", {
  entryId: integer("entry_id").primaryKey(),
  points: numeric("points", { precision: 14, scale: 4 }),
  realizedReturn: numeric("realized_return", { precision: 14, scale: 2 }),
}, (t) => [
  foreignKey({
    columns: [t.entryId],
    foreignColumns: [normalizedEntriesTable.id],
    name: "normalized_expected_entry_results_entry_fk",
  }).onDelete("cascade"),
]);

export const normalizedExpectedOwnerResultsTable = pgTable("normalized_expected_owner_results", {
  calcuttaId: integer("calcutta_id").notNull(),
  ownerId: integer("owner_id").notNull(),
  cost: numeric("cost", { precision: 14, scale: 2 }),
  realized: numeric("realized", { precision: 14, scale: 2 }),
}, (t) => [
  foreignKey({
    columns: [t.calcuttaId],
    foreignColumns: [normalizedCalcuttasTable.id],
    name: "normalized_expected_owner_results_calcutta_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.ownerId],
    foreignColumns: [normalizedOwnersTable.id],
    name: "normalized_expected_owner_results_owner_fk",
  }),
  primaryKey({ columns: [t.calcuttaId, t.ownerId], name: "normalized_expected_owner_results_pkey" }),
]);

/** Same provenance fields as import_runs, scoped to a historical edition. */
export const normalizedImportRunsTable = pgTable("normalized_import_runs", {
  id: serial("id").primaryKey(),
  editionNumber: integer("edition_number").notNull(),
  source: text("source").notNull(),
  sourceHash: text("source_hash").notNull(),
  importedTeams: integer("imported_teams").notNull(),
  importedOwners: integer("imported_owners").notNull(),
  requestedBy: text("requested_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("normalized_import_runs_edition_source_hash_idx").on(t.editionNumber, t.source, t.sourceHash),
]);

export const normalizedTrackingView = pgView("v_tracking", {
  entryId: integer("entry_id"),
  sequence: integer("seq"),
  phrase: text("phrase"),
}).existing();

export const normalizedEntryResultsView = pgView("v_entry_results", {
  editionNumber: integer("ed"),
  calcutta: text("calcutta"),
  sport: text("sport"),
  lot: text("lot"),
  kind: text("kind"),
  seed: text("seed"),
  grouping: text("grouping"),
  price: numeric("price", { precision: 14, scale: 2 }),
  ownership: text("ownership"),
  tracking: text("tracking"),
  points: numeric("points", { precision: 14, scale: 4 }),
  payout: numeric("payout", { precision: 14, scale: 2 }),
}).existing();

export const normalizedOwnerResultsView = pgView("v_owner_results", {
  editionNumber: integer("ed"),
  calcutta: text("calcutta"),
  sport: text("sport"),
  owner: text("owner"),
  lots: numeric("lots"),
  cost: numeric("cost"),
  payout: numeric("payout"),
}).existing();