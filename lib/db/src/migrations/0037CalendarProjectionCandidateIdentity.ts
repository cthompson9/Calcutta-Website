export const calendarProjectionCandidateIdentityMigration = {
  version: "0037_calendar_projection_candidate_identity",
  sql: `
    create or replace function cal_calendar_integrity_guard() returns trigger language plpgsql as $$
    begin
      if tg_table_name = 'calcutta_entries' then
        if exists (
          select 1
          from calendar_participants p
          where p.team_id=old.team_id
            and p.calendar_id in (
              select id from calcutta_calendars where calcutta_id=old.calcutta_id
            )
        ) then
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
      elsif tg_table_name = 'calendar_projection_snapshots'
        and (
          new.slot_id is distinct from old.slot_id
          or new.mtm_snapshot_id is distinct from old.mtm_snapshot_id
        ) then
        raise exception 'projection identity is immutable';
      elsif tg_table_name = 'calendar_projection_candidates'
        and new.projection_id is distinct from old.projection_id then
        raise exception 'projection candidate parent is immutable';
      elsif tg_table_name = 'mtm_snapshot'
        and (
          new.status is distinct from old.status
          or new.pool_id is distinct from old.pool_id
        )
        and exists (
          select 1
          from calendar_projection_snapshots
          where mtm_snapshot_id=old.id
        ) then
        raise exception 'referenced MTM snapshot identity/status is immutable';
      end if;
      if tg_op = 'DELETE' then return old; else return new; end if;
    end $$;

    drop trigger if exists cal_projection_candidate_identity_guard
      on calendar_projection_candidates;
    create trigger cal_projection_candidate_identity_guard
      before update on calendar_projection_candidates
      for each row execute function cal_calendar_integrity_guard();
  `,
} as const;