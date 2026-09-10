export const calendarProjectionSetGuardMigration = {
  version: "0036_calendar_projection_set_guard",
  sql: `
    create or replace function cal_projection_set_guard() returns trigger language plpgsql as $$
    declare pid integer; pstatus text; preason text; n integer; total numeric; clinched integer;
    begin
      if tg_table_name = 'calendar_projection_candidates' then
        if tg_op = 'DELETE' then pid := old.projection_id; else pid := new.projection_id; end if;
      else
        if tg_op = 'DELETE' then pid := old.id; else pid := new.id; end if;
      end if;
      select status, unavailable_reason into pstatus, preason
      from calendar_projection_snapshots
      where id=pid;
      if pstatus is null then
        if tg_op = 'DELETE' then return old; else return new; end if;
      end if;
      select
        count(*),
        coalesce(sum(probability), 0),
        count(*) filter (where exact_slot_clinched)
      into n, total, clinched
      from calendar_projection_candidates
      where projection_id=pid;
      if pstatus = 'available' then
        if preason is not null then
          raise exception 'available projection reason must be null';
        end if;
        if n < 1 or total <> 1 then
          raise exception 'available projection requires candidate probabilities summing exactly to one';
        end if;
        if clinched > 1 then
          raise exception 'projection may have at most one clinched candidate';
        end if;
      elsif pstatus = 'unavailable' then
        if preason is null or btrim(preason) = '' then
          raise exception 'unavailable projection requires a nonblank reason';
        end if;
        if n <> 0 then
          raise exception 'unavailable projection cannot have candidates';
        end if;
      end if;
      if tg_op = 'DELETE' then return old; else return new; end if;
    end $$;
  `,
} as const;