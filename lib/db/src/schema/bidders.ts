import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const biddersTable = pgTable("bidders", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  // Transitional source for moving legacy bidder assignments into dated
  // memberships. It remains private to the migration bridge and is not
  // exposed by the bidder API.
  legacyConsortiumId: integer("consortium_id"),
});

export const insertBidderSchema = createInsertSchema(biddersTable).omit({ id: true });
export type InsertBidder = z.infer<typeof insertBidderSchema>;
export type Bidder = typeof biddersTable.$inferSelect;
