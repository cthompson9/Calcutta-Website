/**
 * Additive persistence for the raw reference mark selected for each quote.
 * These columns deliberately remain separate from accepted book bounds and
 * trade estimates: a retained mark is not an observed book.
 */
export const mtmReferenceMarksMigration = {
  version: "0058_mtm_reference_marks",
  sql: `
    alter table mtm_market_quote
      add column if not exists last_price numeric(12,10),
      add column if not exists reference_price numeric(12,10),
      add column if not exists selection_method text,
      add column if not exists selection_reason jsonb,
      add column if not exists reference_accepted_at timestamptz,
      add column if not exists reference_source_snapshot_id integer,
      add column if not exists reference_source_ticker text,
      add column if not exists reference_policy_version text,
      add column if not exists fetch_outcome text;

    create index if not exists mtm_market_quote_reference_lookup_idx
      on mtm_market_quote(source, event_id, market_ticker, outcome, strike, reference_price)
      where reference_price is not null;

    alter table mtm_market_quote
      drop constraint if exists mtm_market_quote_last_price_bounds,
      add constraint mtm_market_quote_last_price_bounds
        check (last_price is null or (last_price >= 0 and last_price <= 1)),
      drop constraint if exists mtm_market_quote_reference_price_bounds,
      add constraint mtm_market_quote_reference_price_bounds
        check (reference_price is null or (reference_price >= 0 and reference_price <= 1)),
      drop constraint if exists mtm_market_quote_fetch_outcome_supported,
      add constraint mtm_market_quote_fetch_outcome_supported
        check (fetch_outcome is null or fetch_outcome in ('fulfilled', 'failed', 'missing', 'not_requested'));
  `,
} as const;