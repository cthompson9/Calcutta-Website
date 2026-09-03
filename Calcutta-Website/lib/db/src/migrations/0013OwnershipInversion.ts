export const ownershipInversionMigration = {
  version: "0013_ownership_inversion",
  sql: `
    -- The legacy table and the normalized primary ledger must describe precisely
    -- the same auction positions before the compatibility relation is replaced.
    lock table team_bidders, positions in access exclusive mode;

    do $$
    begin
      if not exists (select 1 from team_bidders) then
        raise exception
          'Cannot replace team_bidders: the populated legacy ownership table is unexpectedly empty';
      end if;
      if not exists (select 1 from positions where source = 'primary') then
        raise exception
          'Cannot replace team_bidders: no populated primary positions exist';
      end if;
      if (
        select count(distinct (team_id, season_id))
        from team_bidders
      ) <> (
        select count(distinct (ce.team_id, c.season_id))
        from positions p
        inner join calcutta_entries ce on ce.id = p.entry_id
        inner join calcuttas c on c.id = ce.calcutta_id
        where p.source = 'primary'
      ) then
        raise exception
          'Cannot replace team_bidders: legacy team/season coverage differs from primary positions';
      end if;
      if exists (
        (
          select team_id, bidder_id, season_id, ownership_share
          from team_bidders
          except all
          select ce.team_id, p.bidder_id, c.season_id, p.ownership_share
          from positions p
          inner join calcutta_entries ce on ce.id = p.entry_id
          inner join calcuttas c on c.id = ce.calcutta_id
          where p.source = 'primary'
        )
        union all
        (
          select ce.team_id, p.bidder_id, c.season_id, p.ownership_share
          from positions p
          inner join calcutta_entries ce on ce.id = p.entry_id
          inner join calcuttas c on c.id = ce.calcutta_id
          where p.source = 'primary'
          except all
          select team_id, bidder_id, season_id, ownership_share
          from team_bidders
        )
      ) then
        raise exception
          'Cannot replace team_bidders: legacy rows do not exactly match primary positions';
      end if;
    end
    $$;

    -- A bidder can hold only one primary auction position for an entry. Trade
    -- legs remain append-only and can have multiple rows for the same bidder.
    create unique index if not exists positions_primary_entry_bidder_idx
      on positions (entry_id, bidder_id)
      where source = 'primary';

    create or replace function enforce_positions_entry_ownership_total()
    returns trigger
    language plpgsql
    as $$
    declare
      checked_entry_id integer;
      signed_total numeric;
    begin
      foreach checked_entry_id in array array[
        case when tg_op in ('INSERT', 'UPDATE') then new.entry_id end,
        case when tg_op in ('DELETE', 'UPDATE') then old.entry_id end
      ]
      loop
        if checked_entry_id is null then
          continue;
        end if;

        select sum(ownership_share)
          into signed_total
        from positions
        where entry_id = checked_entry_id;

        -- Empty ledgers are allowed while an entry is being set up. Every
        -- nonempty ledger, including one with signed trade legs, must net 100%.
        if signed_total is not null and signed_total <> 1.0000::numeric then
          raise exception
            'Positions for entry % must net exactly 1.0000; received %',
            checked_entry_id, signed_total
            using errcode = '23514';
        end if;
      end loop;

      return null;
    end
    $$;

    drop trigger if exists positions_entry_ownership_total on positions;
    create constraint trigger positions_entry_ownership_total
      after insert or update or delete on positions
      deferrable initially deferred
      for each row
      execute function enforce_positions_entry_ownership_total();

    create or replace function prevent_approved_trade_primary_position_change()
    returns trigger
    language plpgsql
    as $$
    declare
      protected_entry_id integer;
    begin
      if tg_op = 'DELETE' then
        if old.source <> 'primary' then
          return old;
        end if;
        protected_entry_id := old.entry_id;
        if exists (
          select 1 from trades
          where entry_id = protected_entry_id and status = 'approved'
        ) then
          raise exception
            'Primary positions for entry % cannot change after an approved trade exists',
            protected_entry_id
            using errcode = '23514';
        end if;
        return old;
      end if;

      -- An UPDATE may move a primary position between entries or change its
      -- source. Protect both the source and destination ledgers in that case.
      if tg_op = 'UPDATE' and old.source = 'primary' then
        protected_entry_id := old.entry_id;
        if exists (
          select 1 from trades
          where entry_id = protected_entry_id and status = 'approved'
        ) then
          raise exception
            'Primary positions for entry % cannot change after an approved trade exists',
            protected_entry_id
            using errcode = '23514';
        end if;
      end if;

      if new.source = 'primary'
        and not (
          tg_op = 'UPDATE'
          and old.source = 'primary'
          and old.entry_id = new.entry_id
        ) then
        protected_entry_id := new.entry_id;
        if exists (
          select 1 from trades
          where entry_id = protected_entry_id and status = 'approved'
        ) then
          raise exception
            'Primary positions for entry % cannot change after an approved trade exists',
            protected_entry_id
            using errcode = '23514';
        end if;
      end if;

      return new;
    end
    $$;

    drop trigger if exists positions_primary_approved_trade_immutable on positions;
    create trigger positions_primary_approved_trade_immutable
      before insert or update or delete on positions
      for each row
      execute function prevent_approved_trade_primary_position_change();

    -- Re-run every destructive precondition immediately before replacement.
    -- The exclusive lock above prevents either relation changing between the
    -- equivalence proof and this final guard.
    do $$
    begin
      if not exists (select 1 from team_bidders)
        or not exists (select 1 from positions where source = 'primary')
      then
        raise exception
          'Cannot replace team_bidders: non-empty ownership safeguards failed';
      end if;
      if (
        select count(distinct (team_id, season_id))
        from team_bidders
      ) <> (
        select count(distinct (ce.team_id, c.season_id))
        from positions p
        inner join calcutta_entries ce on ce.id = p.entry_id
        inner join calcuttas c on c.id = ce.calcutta_id
        where p.source = 'primary'
      ) or exists (
        (
          select team_id, bidder_id, season_id, ownership_share
          from team_bidders
          except all
          select ce.team_id, p.bidder_id, c.season_id, p.ownership_share
          from positions p
          inner join calcutta_entries ce on ce.id = p.entry_id
          inner join calcuttas c on c.id = ce.calcutta_id
          where p.source = 'primary'
        )
        union all
        (
          select ce.team_id, p.bidder_id, c.season_id, p.ownership_share
          from positions p
          inner join calcutta_entries ce on ce.id = p.entry_id
          inner join calcuttas c on c.id = ce.calcutta_id
          where p.source = 'primary'
          except all
          select team_id, bidder_id, season_id, ownership_share
          from team_bidders
        )
      ) then
        raise exception
          'Cannot replace team_bidders: final coverage or row-equivalence safeguard failed';
      end if;
    end
    $$;

    drop table team_bidders;
    create view team_bidders as
      select
        ce.team_id,
        p.bidder_id,
        c.season_id,
        p.ownership_share
      from positions p
      inner join calcutta_entries ce on ce.id = p.entry_id
      inner join calcuttas c on c.id = ce.calcutta_id
      where p.source = 'primary';
  `,
} as const;