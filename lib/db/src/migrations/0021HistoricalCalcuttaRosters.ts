export const historicalCalcuttaRostersMigration = {
  version: "0021_historical_calcutta_rosters_v1",
  sql: `
    create table if not exists historical_calcutta_rosters (
      id serial primary key,
      calcutta_id integer not null references normalized_calcuttas(id) on delete cascade,
      owner_id integer references normalized_owners(id),
      bidder_id integer references bidders(id) on delete set null,
      consortium_id integer references consortia(id) on delete restrict,
      source_owner_label text not null,
      source_path text not null,
      source_hash text not null,
      recorded_at timestamptz not null default now(),
      constraint historical_calcutta_rosters_pool_owner_fkey
        foreign key(calcutta_id, owner_id)
        references normalized_calcutta_owners(calcutta_id, owner_id)
        on delete cascade
    );
    create unique index if not exists historical_calcutta_rosters_source_label_idx
      on historical_calcutta_rosters(calcutta_id, source_owner_label);
    create unique index if not exists historical_calcutta_rosters_pool_owner_idx
      on historical_calcutta_rosters(calcutta_id, owner_id)
      where owner_id is not null;
    create index if not exists historical_calcutta_rosters_bidder_idx
      on historical_calcutta_rosters(calcutta_id, bidder_id);
    create index if not exists historical_calcutta_rosters_consortium_idx
      on historical_calcutta_rosters(consortium_id);
  `,
} as const;