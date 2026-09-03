export const mtmEntryScopeMigration = {
  version: "0014_mtm_entry_scope",
  sql: `
    lock table mtm_snapshots, calcuttas, calcutta_entries in share row exclusive mode;

    create temporary table phase1_mtm_entry_scope_baseline
      on commit drop
      as select count(*)::bigint as row_count from mtm_snapshots;

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

    do $$
    begin
      if exists (select 1 from mtm_snapshots where entry_id is null) then
        raise exception
          'Cannot tighten mtm_snapshots.entry_id: nullable backfill left unresolved rows';
      end if;
      if exists (
        select 1
        from mtm_snapshots ms
        inner join calcutta_entries ce on ce.id = ms.entry_id
        inner join calcuttas c on c.id = ce.calcutta_id
        where ce.team_id is distinct from ms.team_id
           or c.season_id is distinct from ms.season_id
      ) then
        raise exception
          'Cannot tighten mtm_snapshots.entry_id: entry mapping does not round-trip to team and season';
      end if;
      if (
        select count(*)::bigint from mtm_snapshots
      ) <> (
        select row_count from phase1_mtm_entry_scope_baseline
      ) then
        raise exception
          'Cannot tighten mtm_snapshots.entry_id: row count changed during backfill';
      end if;
    end
    $$;

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