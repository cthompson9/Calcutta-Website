import { index, integer, jsonb, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { teamsTable } from "./teams";

/**
 * Maps a provider's team identity to the local team row used by the event
 * ledger. Provider IDs are intentionally scoped by sport and competition:
 * ESPN reuses numeric IDs across some products.
 */
export const providerTeamIdentitiesTable = pgTable(
  "provider_team_identities",
  {
    id: serial("id").primaryKey(),
    sport: text("sport").notNull(),
    competition: text("competition").notNull(),
    provider: text("provider").notNull(),
    providerTeamId: text("provider_team_id").notNull(),
    teamId: integer("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    canonicalName: text("canonical_name").notNull(),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex("provider_team_identities_scope_provider_id_idx").on(
      t.sport,
      t.competition,
      t.provider,
      t.providerTeamId,
    ),
    index("provider_team_identities_team_idx").on(t.teamId),
  ],
);

export const insertProviderTeamIdentitySchema = createInsertSchema(
  providerTeamIdentitiesTable,
).omit({ id: true });
export type InsertProviderTeamIdentity = z.infer<typeof insertProviderTeamIdentitySchema>;
export type ProviderTeamIdentity = typeof providerTeamIdentitiesTable.$inferSelect;