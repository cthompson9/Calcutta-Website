export const retireLegacyConsortiumMigration = {
  version: "0006_retire_legacy_consortium",
  sql: `
    -- The permanent bidder link was a bootstrap source for dated
    -- memberships. Preserve it for bidders that still have no open-ended
    -- membership before removing the obsolete column.
    do $$
    begin
      if exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'bidders'
          and column_name = 'consortium_id'
      ) then
        execute $migration$
          insert into consortium_memberships (bidder_id, consortium_id, from_date)
          select
            b.id,
            b.consortium_id,
            (current_timestamp at time zone 'America/New_York')::date
          from bidders b
          where b.consortium_id is not null
            and not exists (
              select 1
              from consortium_memberships m
              where m.bidder_id = b.id
                and m.to_date is null
            )
          on conflict do nothing
        $migration$;
      end if;
    end $$;

    alter table bidders
      drop column if exists consortium_id;
  `,
} as const;