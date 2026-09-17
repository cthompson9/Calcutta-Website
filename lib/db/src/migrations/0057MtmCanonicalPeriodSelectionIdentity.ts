export const mtmCanonicalPeriodSelectionIdentityMigration = {
  version: "0057_mtm_canonical_period_selection_identity",
  sql: `
    do $$
    begin
      if exists (
        select 1
        from mtm_canonical_period_selection
        group by pool_id, sport_period_id, snapshot_id
        having count(*) > 1
      ) then
        raise exception
          'Cannot add MTM canonical period selection identity: duplicate audit rows already exist';
      end if;
    end $$;

    create unique index if not exists mtm_period_sel_pool_period_snapshot_uq
      on mtm_canonical_period_selection(pool_id, sport_period_id, snapshot_id);
  `,
} as const;