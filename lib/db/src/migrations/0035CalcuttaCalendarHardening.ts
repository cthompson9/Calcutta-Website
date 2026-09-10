export const calcuttaCalendarHardeningMigration = {
  version: "0035_calcutta_calendar_hardening",
  sql: `
    do $$ begin
      if not exists (select 1 from pg_constraint where conname='cal_slt_home_src_fk') then
        alter table calendar_slots add constraint cal_slt_home_src_fk foreign key (home_source_slot_id) references calendar_slots(id);
      end if;
      if not exists (select 1 from pg_constraint where conname='cal_slt_away_src_fk') then
        alter table calendar_slots add constraint cal_slt_away_src_fk foreign key (away_source_slot_id) references calendar_slots(id);
      end if;
    end $$;

    create or replace function cal_calendar_integrity_guard() returns trigger language plpgsql as $$
    begin
      if tg_table_name = 'calcutta_entries' then
        if exists (select 1 from calendar_participants p where p.team_id=old.team_id and p.calendar_id in (select id from calcutta_calendars where calcutta_id=old.calcutta_id)) then
          raise exception 'Calcutta entry is referenced by a calendar participant';
        end if;
      elsif tg_table_name = 'calcutta_calendars' and new.calcutta_id is distinct from old.calcutta_id then
        raise exception 'calendar Calcutta is immutable';
      elsif tg_table_name = 'calendar_rounds' and new.calendar_id is distinct from old.calendar_id then
        raise exception 'round calendar is immutable';
      elsif tg_table_name = 'calendar_slots' and new.round_id is distinct from old.round_id then
        raise exception 'slot round is immutable';
      elsif tg_table_name = 'calendar_participants' and new.calendar_id is distinct from old.calendar_id then
        raise exception 'participant calendar is immutable';
      elsif tg_table_name = 'calendar_projection_snapshots' and (new.slot_id is distinct from old.slot_id or new.mtm_snapshot_id is distinct from old.mtm_snapshot_id) then
        raise exception 'projection identity is immutable';
      elsif tg_table_name = 'calendar_projection_candidates'
        and (
          new.projection_id is distinct from old.projection_id
          or new.participant_id is distinct from old.participant_id
        ) then
        raise exception 'projection candidate identity is immutable';
      elsif tg_table_name = 'mtm_snapshot' and (new.status is distinct from old.status or new.pool_id is distinct from old.pool_id) and exists (select 1 from calendar_projection_snapshots where mtm_snapshot_id=old.id) then
        raise exception 'referenced MTM snapshot identity/status is immutable';
      end if;
      if tg_op = 'DELETE' then return old; else return new; end if;
    end $$;

    create or replace function cal_projection_set_guard() returns trigger language plpgsql as $$
    declare pid integer; pstatus text; preason text; n integer; total numeric; clinched integer;
    begin
      if tg_table_name = 'calendar_projection_candidates' then
        if tg_op = 'DELETE' then pid := old.projection_id; else pid := new.projection_id; end if;
      else
        if tg_op = 'DELETE' then pid := old.id; else pid := new.id; end if;
      end if;
      select status, unavailable_reason into pstatus, preason from calendar_projection_snapshots where id=pid;
      if pstatus is null then if tg_op = 'DELETE' then return old; else return new; end if; end if;
      select count(*), coalesce(sum(probability),0), count(*) filter (where exact_slot_clinched) into n,total,clinched from calendar_projection_candidates where projection_id=pid;
      if pstatus = 'available' then
        if preason is not null then raise exception 'available projection reason must be null'; end if;
        if n < 1 or total <> 1 then raise exception 'available projection requires candidate probabilities summing exactly to one'; end if;
        if clinched > 1 then raise exception 'projection may have at most one clinched candidate'; end if;
      elsif pstatus = 'unavailable' then
        if preason is null or btrim(preason) = '' then raise exception 'unavailable projection requires a nonblank reason'; end if;
        if n <> 0 then raise exception 'unavailable projection cannot have candidates'; end if;
      end if;
      if tg_op = 'DELETE' then return old; else return new; end if;
    end $$;

    drop trigger if exists cal_entry_calendar_guard on calcutta_entries;
    create constraint trigger cal_entry_calendar_guard after update or delete on calcutta_entries deferrable initially deferred for each row execute function cal_calendar_integrity_guard();
    drop trigger if exists cal_calendar_immutable_guard on calcutta_calendars;
    create trigger cal_calendar_immutable_guard before update on calcutta_calendars for each row execute function cal_calendar_integrity_guard();
    drop trigger if exists cal_round_immutable_guard on calendar_rounds;
    create trigger cal_round_immutable_guard before update on calendar_rounds for each row execute function cal_calendar_integrity_guard();
    drop trigger if exists cal_slot_immutable_guard on calendar_slots;
    create trigger cal_slot_immutable_guard before update on calendar_slots for each row execute function cal_calendar_integrity_guard();
    drop trigger if exists cal_participant_immutable_guard on calendar_participants;
    create trigger cal_participant_immutable_guard before update on calendar_participants for each row execute function cal_calendar_integrity_guard();
    drop trigger if exists cal_projection_identity_guard on calendar_projection_snapshots;
    create trigger cal_projection_identity_guard before update on calendar_projection_snapshots for each row execute function cal_calendar_integrity_guard();
    drop trigger if exists cal_projection_candidate_identity_guard on calendar_projection_candidates;
    create trigger cal_projection_candidate_identity_guard before update on calendar_projection_candidates for each row execute function cal_calendar_integrity_guard();
    drop trigger if exists cal_mtm_identity_guard on mtm_snapshot;
    create trigger cal_mtm_identity_guard before update on mtm_snapshot for each row execute function cal_calendar_integrity_guard();

    drop trigger if exists cal_projection_set_parent_guard on calendar_projection_snapshots;
    create constraint trigger cal_projection_set_parent_guard after insert or update or delete on calendar_projection_snapshots deferrable initially deferred for each row execute function cal_projection_set_guard();
    drop trigger if exists cal_projection_set_candidate_guard on calendar_projection_candidates;
    create constraint trigger cal_projection_set_candidate_guard after insert or update or delete on calendar_projection_candidates deferrable initially deferred for each row execute function cal_projection_set_guard();
  `,
} as const;