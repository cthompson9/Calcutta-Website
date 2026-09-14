/**
 * Additive evidence fields for the engine-facing MTM market quote relation.
 *
 * This migration intentionally does not introduce another valuation ledger.
 * Existing snapshots and quote identity remain valid; consumers that do not
 * know the handoff fields continue to read the original quote columns.
 */
export const mtmEvidenceStorageMigration = {
  version: "0050_mtm_evidence_storage",
  sql: `
    alter table mtm_market_quote
      add column if not exists observation_id text,
      add column if not exists provider text,
      add column if not exists contract text,
      add column if not exists settlement_predicate text,
      add column if not exists family text,
      add column if not exists event_id integer,
      add column if not exists source_observed_at timestamptz,
      add column if not exists captured_at timestamptz,
      add column if not exists normalized_yes_bid numeric(5,4),
      add column if not exists normalized_yes_ask numeric(5,4),
      add column if not exists depth jsonb,
      add column if not exists status text,
      add column if not exists outcome text,
      add column if not exists material_event jsonb,
      add column if not exists state_version text,
      add column if not exists quality_report jsonb,
      add column if not exists quality_policy_version text,
      add column if not exists accepted_lower numeric(5,4),
      add column if not exists accepted_upper numeric(5,4),
      add column if not exists trade_estimate numeric(5,4),
      add column if not exists trade_uncertainty numeric(5,4),
      add column if not exists fallback_identity text,
      add column if not exists fallback_age numeric(14,3),
      add column if not exists evidence_group jsonb,
      add column if not exists completeness_manifest jsonb,
      add column if not exists raw_metadata jsonb;

    create unique index if not exists mtm_market_quote_snapshot_observation_idx
      on mtm_market_quote(snapshot_id, observation_id)
      where observation_id is not null;
    create index if not exists mtm_market_quote_event_idx
      on mtm_market_quote(event_id);
    create index if not exists mtm_market_quote_provider_contract_idx
      on mtm_market_quote(provider, contract);

    -- The original inline Drizzle reference used a generated name. Rename
    -- that one legacy constraint when present so the schema has a stable,
    -- short name without dropping/recreating the relationship.
    do $$
    declare
      old_name text;
    begin
      select conname into old_name
      from pg_constraint
      where conrelid = 'mtm_market_quote'::regclass
        and contype = 'f'
        and confrelid = 'mtm_snapshot'::regclass
        and conname <> 'mtm_quote_snapshot_fk'
      limit 1;
      if old_name is not null then
        execute format(
          'alter table mtm_market_quote rename constraint %I to mtm_quote_snapshot_fk',
          old_name
        );
      end if;
    end $$;

    do $$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conname = 'mtm_quote_event_fk'
          and conrelid = 'mtm_market_quote'::regclass
      ) then
        alter table mtm_market_quote
          add constraint mtm_quote_event_fk
          foreign key (event_id) references events(id) on delete set null;
      end if;
    end $$;

    alter table mtm_market_quote
      drop constraint if exists mtm_market_quote_yes_bid_bounds,
      add constraint mtm_market_quote_yes_bid_bounds
        check (yes_bid is null or (yes_bid >= 0 and yes_bid <= 1)),
      drop constraint if exists mtm_market_quote_yes_ask_bounds,
      add constraint mtm_market_quote_yes_ask_bounds
        check (yes_ask is null or (yes_ask >= 0 and yes_ask <= 1)),
      drop constraint if exists mtm_market_quote_normalized_bid_bounds,
      add constraint mtm_market_quote_normalized_bid_bounds
        check (normalized_yes_bid is null or (normalized_yes_bid >= 0 and normalized_yes_bid <= 1)),
      drop constraint if exists mtm_market_quote_normalized_ask_bounds,
      add constraint mtm_market_quote_normalized_ask_bounds
        check (normalized_yes_ask is null or (normalized_yes_ask >= 0 and normalized_yes_ask <= 1)),
      drop constraint if exists mtm_market_quote_normalized_bid_ask_order,
      add constraint mtm_market_quote_normalized_bid_ask_order
        check (normalized_yes_bid is null or normalized_yes_ask is null or normalized_yes_bid <= normalized_yes_ask),
      drop constraint if exists mtm_market_quote_accepted_bounds,
      add constraint mtm_market_quote_accepted_bounds
        check (accepted_lower is null or accepted_upper is null or
          (accepted_lower >= 0 and accepted_upper <= 1 and accepted_lower <= accepted_upper)),
      drop constraint if exists mtm_market_quote_trade_estimate_bounds,
      add constraint mtm_market_quote_trade_estimate_bounds
        check (trade_estimate is null or (trade_estimate >= 0 and trade_estimate <= 1)),
      drop constraint if exists mtm_market_quote_trade_uncertainty_non_negative,
      add constraint mtm_market_quote_trade_uncertainty_non_negative
        check (trade_uncertainty is null or trade_uncertainty >= 0),
      drop constraint if exists mtm_market_quote_fallback_age_non_negative,
      add constraint mtm_market_quote_fallback_age_non_negative
        check (fallback_age is null or fallback_age >= 0),
      drop constraint if exists mtm_market_quote_status_supported,
      add constraint mtm_market_quote_status_supported
        check (status is null or status in ('active', 'settled', 'suspended', 'unknown')),
      drop constraint if exists mtm_market_quote_outcome_supported,
      add constraint mtm_market_quote_outcome_supported
        check (outcome is null or outcome in ('yes', 'no', 'void'));
  `,
} as const;