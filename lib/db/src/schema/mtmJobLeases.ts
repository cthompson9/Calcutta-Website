import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { calcuttasTable } from "./calcuttas";
import { mtmSnapshotTable } from "./mtmPipeline";

export const mtmJobLeasesTable = pgTable("mtm_job_leases", {
  poolId: integer("pool_id")
    .primaryKey()
    .references(() => calcuttasTable.id, { onDelete: "cascade" }),
  ownerToken: text("owner_token").notNull(),
  runId: text("run_id").notNull(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mtmJobRunsTable = pgTable(
  "mtm_job_runs",
  {
    runId: text("run_id").primaryKey(),
    poolId: integer("pool_id")
      .notNull()
      .references(() => calcuttasTable.id, { onDelete: "cascade" }),
    ownerToken: text("owner_token").notNull(),
    status: text("status").notNull(),
    failureKind: text("failure_kind"),
    error: text("error"),
    snapshotId: integer("snapshot_id").references(() => mtmSnapshotTable.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("mtm_job_runs_pool_started_idx").on(t.poolId, t.startedAt),
    check(
      "mtm_job_runs_status_supported",
      sql`${t.status} IN ('running', 'completed', 'failed', 'abandoned')`,
    ),
  ],
);