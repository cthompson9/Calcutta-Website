import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { calcuttasTable } from "./calcuttas";

export const mtmActualsRequestTable = pgTable(
  "mtm_actuals_request",
  {
    poolId: integer("pool_id").primaryKey(),
    requestedRevision: text("requested_revision").notNull(),
    completedRevision: text("completed_revision"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.poolId],
      foreignColumns: [calcuttasTable.id],
      name: "mtm_actuals_request_pool_fk",
    }).onDelete("cascade"),
    index("mtm_actuals_request_status_idx").on(t.status, t.nextAttemptAt),
    check(
      "mtm_actuals_request_status_supported",
      sql`${t.status} IN ('pending', 'running', 'completed', 'failed')`,
    ),
  ],
);

export type MtmActualsRequest = typeof mtmActualsRequestTable.$inferSelect;