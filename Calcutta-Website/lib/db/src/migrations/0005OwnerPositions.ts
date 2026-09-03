export const ownerPositionsMigration = {
  version: "0005_owner_positions",
  sql: `
    create extension if not exists btree_gist;

    alter table calcuttas
      add column if not exists as_of_date date;

    create table if not exists consortium_memberships (
      id serial primary key,
      bidder_id integer not null references bidders(id) on delete cascade,
      consortium_id integer not null references consortia(id) on delete cascade,
      from_date date not null,
      to_date date,
      constraint consortium_memberships_date_order
        check (to_date is null or to_date > from_date)
    );
    create index if not exists consortium_memberships_bidder_dates_idx
      on consortium_memberships (bidder_id, from_date, to_date);
    create index if not exists consortium_memberships_consortium_idx
      on consortium_memberships (consortium_id);
    create unique index if not exists consortium_memberships_exact_interval_idx
      on consortium_memberships (bidder_id, consortium_id, from_date);
    create unique index if not exists consortium_memberships_one_active_bidder_idx
      on consortium_memberships (bidder_id) where to_date is null;

    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conname = 'consortium_memberships_no_overlap'
      ) then
        alter table consortium_memberships
        add constraint consortium_memberships_no_overlap
        exclude using gist (
          bidder_id with =,
          daterange(from_date, coalesce(to_date, 'infinity'::date), '[)') with &&
        );
      end if;
    end $$;

    create table if not exists positions (
      id serial primary key,
      entry_id integer not null references calcutta_entries(id) on delete cascade,
      bidder_id integer not null references bidders(id) on delete cascade,
      ownership_share numeric(9, 6) not null,
      source text not null,
      cost_basis numeric(12, 2) not null default 0,
      trade_id integer references trades(id) on delete cascade,
      constraint positions_source_values check (source in ('primary', 'trade')),
      constraint positions_primary_positive check (source <> 'primary' or ownership_share > 0)
    );
    create index if not exists positions_entry_idx on positions (entry_id);
    create index if not exists positions_bidder_idx on positions (bidder_id);
    create index if not exists positions_trade_idx on positions (trade_id);
    create unique index if not exists positions_source_trade_idx
      on positions (entry_id, bidder_id, source, trade_id);
  `,
} as const;