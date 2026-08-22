import { sql } from "drizzle-orm";
import { pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

export const consortiaTable = pgTable(
  "consortia",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
  },
  (table) => [
    uniqueIndex("consortia_name_lower_unique").on(sql`lower(${table.name})`),
  ],
);

export type Consortium = typeof consortiaTable.$inferSelect;