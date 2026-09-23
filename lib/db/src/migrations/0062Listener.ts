export const listenerMigration = {
  version: "0062_listener",
  sql: `
    create table if not exists listener_tickets (
      hash text primary key, auction_id integer not null references auction_sessions(id) on delete cascade,
      origin text not null, expires_at timestamptz not null, redemption_id uuid, session_id uuid
    );
    create index if not exists listener_tickets_expiry_idx on listener_tickets(expires_at);
    create table if not exists listener_sessions (
      id uuid primary key, auction_id integer not null references auction_sessions(id) on delete cascade,
      token_hash text not null, expires_at timestamptz not null, revoked_at timestamptz,
      last_seen_at timestamptz, recording boolean not null default false, pending integer not null default 0
    );
    create index if not exists listener_sessions_auction_idx on listener_sessions(auction_id);
    create table if not exists listener_transcript_events (
      id integer generated always as identity primary key, listener_session_id uuid not null references listener_sessions(id) on delete cascade,
      event_id text not null, local_session_id text not null, upload_id text not null,
      website_session_id uuid not null, received_at timestamptz not null, event_type text not null,
      transcript text not null, participant text,
      constraint listener_transcript_session_event_unique unique(listener_session_id,event_id)
    );
    create index if not exists listener_transcript_auction_time_idx on listener_transcript_events(listener_session_id,received_at);
  `,
} as const;