export const auctionMigration = {
  version: "0060_auction",
  sql: `
    do $guard$
    declare t text; required text[] := array['auction_sessions','auction_lots','auction_consortia','auction_sales','auction_sale_allocations','auction_events'];
    begin
      foreach t in array required loop
        if to_regclass(t) is not null then
          if (select count(*) from information_schema.columns where table_name=t) <
             case t when 'auction_sessions' then 9 when 'auction_lots' then 14
             when 'auction_consortia' then 7 when 'auction_sales' then 8
             when 'auction_sale_allocations' then 5 when 'auction_events' then 8 end
          then raise exception 'incompatible partially matching auction table %', t; end if;
          if t = 'auction_sessions' and not exists (select 1 from information_schema.columns where table_name=t and column_name='calcutta_id') then raise exception 'incompatible pre-existing auction table %', t; end if;
          if t = 'auction_lots' and not exists (select 1 from information_schema.columns where table_name=t and column_name='entry_id') then raise exception 'incompatible pre-existing auction table %', t; end if;
          if t = 'auction_consortia' and not exists (select 1 from information_schema.columns where table_name=t and column_name='auction_id') then raise exception 'incompatible pre-existing auction table %', t; end if;
          if t = 'auction_sales' and not exists (select 1 from information_schema.columns where table_name=t and column_name='lot_id') then raise exception 'incompatible pre-existing auction table %', t; end if;
          if t = 'auction_sale_allocations' and not exists (select 1 from information_schema.columns where table_name=t and column_name='sale_id') then raise exception 'incompatible pre-existing auction table %', t; end if;
          if t = 'auction_events' and not exists (select 1 from information_schema.columns where table_name=t and column_name='sequence') then raise exception 'incompatible pre-existing auction table %', t; end if;
        end if;
      end loop;
    end $guard$;
    create table if not exists auction_sessions (
      id serial primary key, calcutta_id integer not null references calcuttas(id) on delete cascade,
      status text not null default 'setup', current_lot_id integer, revision integer not null default 0,
      created_at timestamptz not null default now(), started_at timestamptz, completed_at timestamptz,
      constraint auction_sessions_calcutta_unique unique(calcutta_id),
      constraint auction_sessions_status_check check(status in ('setup','live','complete'))
    );
    create table if not exists auction_lots (
      id serial primary key, auction_id integer not null references auction_sessions(id) on delete cascade,
      external_id text not null, display_name text not null, aliases jsonb not null default '[]',
      metadata jsonb not null default '{}', entry_id integer not null references calcutta_entries(id),
      status text not null default 'available', nomination_id text, nomination_sequence integer,
      current_bid_cents integer, nominated_at timestamptz, updated_at timestamptz not null default now(),
      constraint auction_lots_external_unique unique(auction_id, external_id),
      constraint auction_lots_entry_unique unique(auction_id, entry_id),
      constraint auction_lots_status_check check(status in ('available','bidding','sold')),
      constraint auction_lots_bid_check check(current_bid_cents is null or current_bid_cents >= 0)
    );
    create index if not exists auction_lots_status_idx on auction_lots(auction_id,status);
    create table if not exists auction_consortia (
      id serial primary key, auction_id integer not null references auction_sessions(id) on delete cascade,
      display_name text not null, aliases jsonb not null default '[]',
      bidder_id integer references bidders(id), active integer not null default 1,
      constraint auction_consortia_name_unique unique(auction_id, display_name)
    );
    create table if not exists auction_sales (
      id serial primary key, auction_id integer not null references auction_sessions(id) on delete cascade,
      lot_id integer not null unique references auction_lots(id), total_cents integer not null,
      source text not null default 'manual', reason text, created_at timestamptz not null default now(),
      corrected_at timestamptz, constraint auction_sales_positive check(total_cents > 0)
    );
    create table if not exists auction_sale_allocations (
      id serial primary key, sale_id integer not null references auction_sales(id) on delete cascade,
      bidder_id integer not null references bidders(id), share numeric(9,6) not null, cents integer not null,
      constraint auction_sale_allocations_unique unique(sale_id,bidder_id),
      constraint auction_sale_allocations_share check(share > 0 and share <= 1),
      constraint auction_sale_allocations_cents check(cents > 0)
    );
    create table if not exists auction_events (
      id serial primary key, auction_id integer not null references auction_sessions(id) on delete cascade,
      sequence integer not null, event_type text not null, idempotency_key text, nomination_id text,
      payload jsonb not null default '{}', created_at timestamptz not null default now(),
      constraint auction_events_sequence_unique unique(auction_id,sequence),
      constraint auction_events_idempotency_unique unique(auction_id,idempotency_key)
    );
  `,
} as const;