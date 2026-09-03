import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Public OAuth clients registered by remote MCP clients such as Claude.
 * They are intentionally public clients: PKCE, rather than a client secret,
 * protects the authorization-code exchange.
 */
export const mcpOauthClientsTable = pgTable(
  "mcp_oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    clientName: text("client_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * One-time OAuth authorization codes. Only a SHA-256 digest is stored so a
 * database read cannot be replayed as an authorization code.
 */
export const mcpOauthAuthorizationCodesTable = pgTable(
  "mcp_oauth_authorization_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    scope: text("scope").notNull().default("mcp"),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.clientId],
      foreignColumns: [mcpOauthClientsTable.clientId],
      name: "mcp_oauth_codes_client_fk",
    }).onDelete("cascade"),
    index("mcp_oauth_codes_client_idx").on(t.clientId),
    index("mcp_oauth_codes_expires_idx").on(t.expiresAt),
  ],
);

/**
 * OAuth access and refresh tokens. Raw values are returned only once to the
 * client; lookup and revocation always use their digests.
 */
export const mcpOauthTokensTable = pgTable(
  "mcp_oauth_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    tokenType: text("token_type").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpOauthClientsTable.clientId, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("mcp"),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "mcp_oauth_tokens_token_type_check",
      sql`${t.tokenType} in ('access', 'refresh')`,
    ),
    index("mcp_oauth_tokens_client_idx").on(t.clientId),
    index("mcp_oauth_tokens_expires_idx").on(t.expiresAt),
  ],
);