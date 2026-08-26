export const mtmEntryScopeMigration = {
  version: "0014_mtm_entry_scope",
  sql: `
    lock table mtm_snapshots, calcuttas, calcutta_entries in share row exclusive mode;

    alter table mtm_snapshots add column if not exists entry_id integer;

    -- Legacy MTM rows belong to the single canonical NFL entry for their
    -- season/team. Refuse to guess if that identity is absent or ambiguous.
    do $$
    begin
      if exists (
        select 1
        from mtm_snapshots ms
        left join (
          select c.season_id, ce.team_id, min(ce.id) as entry_id, count(*) as matches
          from calcuttas c
          inner join calcutta_entries ce on ce.calcutta_id = c.id
          where c.sport = 'NFL' and c.is_canonical = true
          group by c.season_id, ce.team_id
        ) canonical
          on canonical.season_id = ms.season_id
         and canonical.team_id = ms.team_id
        where ms.entry_id is null
          and (canonical.entry_id is null or canonical.matches <> 1)
      ) then
        raise exception
          'Cannot scope MTM snapshots: a legacy row has no unambiguous canonical NFL Calcutta entry';
      end if;
    end
    $$;

    update mtm_snapshots ms
      set entry_id = canonical.entry_id
    from (
      select c.season_id, ce.team_id, min(ce.id) as entry_id
      from calcuttas c
      inner join calcutta_entries ce on ce.calcutta_id = c.id
      where c.sport = 'NFL' and c.is_canonical = true
      group by c.season_id, ce.team_id
      having count(*) = 1
    ) canonical
    where ms.entry_id is null
      and ms.season_id = canonical.season_id
      and ms.team_id = canonical.team_id;

    alter table mtm_snapshots
      drop constraint if exists mtm_snapshots_entry_id_calcutta_entries_id_fk;
    alter table mtm_snapshots
      add constraint mtm_snapshots_entry_id_calcutta_entries_id_fk
      foreign key (entry_id) references calcutta_entries(id) on delete cascade;
    alter table mtm_snapshots alter column entry_id set not null;

    drop index if exists mtm_team_season_date_idx;
    drop index if exists mtm_team_season_key_idx;
    create unique index mtm_entry_date_idx
      on mtm_snapshots(entry_id, snapshot_date);
    create unique index mtm_entry_key_idx
      on mtm_snapshots(entry_id, snapshot_key)
      where snapshot_key is not null;
    create index if not exists mtm_snapshots_entry_idx
      on mtm_snapshots(entry_id);
  `,
} as const;