export const historicalCalcuttaLinksMigration = {
  version: "0023_historical_calcutta_links_v1",
  sql: `
    create table if not exists historical_calcutta_links (
      normalized_calcutta_id integer primary key
        references normalized_calcuttas(id) on delete cascade,
      legacy_calcutta_id integer not null unique
        references calcuttas(id) on delete restrict,
      source_path text not null,
      source_hash text not null,
      recorded_at timestamptz not null default now()
    );
  `,
} as const;