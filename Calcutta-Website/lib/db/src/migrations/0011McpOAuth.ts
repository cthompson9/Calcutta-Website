export const mcpOAuthMigration = {
  version: "0011_mcp_oauth",
  sql: `
    create table if not exists mcp_oauth_clients (
      client_id text primary key,
      redirect_uris jsonb not null,
      client_name text,
      created_at timestamptz not null default now()
    );

    create table if not exists mcp_oauth_authorization_codes (
      code_hash text primary key,
      client_id text not null references mcp_oauth_clients(client_id) on delete cascade,
      redirect_uri text not null,
      code_challenge text not null,
      scope text not null default 'mcp',
      resource text not null,
      expires_at timestamptz not null,
      used_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index if not exists mcp_oauth_codes_client_idx
      on mcp_oauth_authorization_codes(client_id);
    create index if not exists mcp_oauth_codes_expires_idx
      on mcp_oauth_authorization_codes(expires_at);

    create table if not exists mcp_oauth_tokens (
      token_hash text primary key,
      token_type text not null check (token_type in ('access', 'refresh')),
      client_id text not null references mcp_oauth_clients(client_id) on delete cascade,
      scope text not null default 'mcp',
      resource text not null,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index if not exists mcp_oauth_tokens_client_idx
      on mcp_oauth_tokens(client_id);
    create index if not exists mcp_oauth_tokens_expires_idx
      on mcp_oauth_tokens(expires_at);
  `,
} as const;