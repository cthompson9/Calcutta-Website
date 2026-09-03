export const entryResultEconomicsMigration = {
  version: "0015_entry_result_economics",
  sql: `
    lock table calcutta_entries, calcuttas, team_results in share row exclusive mode;

    alter table calcutta_entries
      add column if not exists realized_return numeric(10, 4) default '0',
      add column if not exists realized_multiple numeric(10, 7) default '0',
      add column if not exists net_return numeric(10, 4) default '0',
      add column if not exists net_pct_return numeric(10, 7) default '0',
      add column if not exists mark_to_market numeric(10, 4) default '0';

    -- A legacy result may only be copied when its canonical NFL entry has one
    -- and only one identity. Never guess across duplicate canonical pools.
    do $$
    begin
      if exists (
        select 1
        from team_results tr
        join (
          select c.season_id, ce.team_id, count(*) as matches
          from calcuttas c
          join calcutta_entries ce on ce.calcutta_id = c.id
          where c.sport = 'NFL' and c.is_canonical = true
          group by c.season_id, ce.team_id
        ) canonical on canonical.season_id = tr.season_id
          and canonical.team_id = tr.team_id
        where canonical.matches <> 1
      ) then
        raise exception 'Cannot scope result economics: legacy row has ambiguous canonical NFL Calcutta entry';
      end if;
    end
    $$;

    update calcutta_entries ce
      set realized_return = tr.realized_return,
          realized_multiple = tr.realized_multiple,
          net_return = tr.net_return,
          net_pct_return = tr.net_pct_return,
          mark_to_market = tr.mark_to_market
    from calcuttas c
    join team_results tr on tr.season_id = c.season_id
    where ce.calcutta_id = c.id
      and tr.team_id = ce.team_id
      and c.sport = 'NFL'
      and c.is_canonical = true;
  `,
} as const;