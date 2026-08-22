import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { consortiaTable } from "./consortia";

export const biddersTable = pgTable("bidders", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  consortiumId: integer("consortium_id").references(() => consortiaTable.id, {
    onDelete: "set null",
  }),
});

export const insertBidderSchema = createInsertSchema(biddersTable).omit({ id: true });
export type InsertBidder = z.infer<typeof insertBidderSchema>;
export type Bidder = typeof biddersTable.$inferSelect;
