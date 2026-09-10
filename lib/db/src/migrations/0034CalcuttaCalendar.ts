export const calcuttaCalendarMigration = {
  version: "0034_calcutta_calendar",
  sql: `
    create table if not exists calcutta_calendars (
      id serial primary key, calcutta_id integer not null constraint cal_cal_fk references calcuttas(id) on delete cascade,
      format text not null constraint cal_cal_format_ck check (format in ('nfl_single_elimination','nba_seven_game','mlb_series','march_madness_64')),
      schedule_state text not null default 'not_loaded' constraint cal_cal_state_ck check (schedule_state in ('not_applicable','not_loaded','loaded')),
      schedule_absent_reason text, created_at timestamptz not null default now(),
      constraint cal_cal_absence_ck check (schedule_state <> 'not_applicable' or schedule_absent_reason is not null)
    );
    create unique index if not exists cal_cal_calcutta_uq on calcutta_calendars(calcutta_id);
    create table if not exists calendar_participants (
      id serial primary key, calendar_id integer not null constraint cal_par_cal_fk references calcutta_calendars(id) on delete cascade,
      team_id integer not null constraint cal_par_team_fk references teams(id), seed integer,
      designation text constraint cal_par_desig_ck check (designation is null or designation in ('home','away')),
      constraint cal_par_seed_ck check (seed is null or seed > 0)
    );
    create unique index if not exists cal_par_cal_team_uq on calendar_participants(calendar_id, team_id);
    create table if not exists calendar_rounds (
      id serial primary key, calendar_id integer not null constraint cal_rnd_cal_fk references calcutta_calendars(id) on delete cascade,
      sequence integer not null, name text not null, kind text not null,
      constraint cal_rnd_seq_ck check (sequence > 0)
    );
    create unique index if not exists cal_rnd_cal_seq_uq on calendar_rounds(calendar_id, sequence);
    create table if not exists calendar_slots (
      id serial primary key, round_id integer not null constraint cal_slt_rnd_fk references calendar_rounds(id) on delete cascade,
      slot_number integer not null, home_source_slot_id integer constraint cal_slt_home_src_fk references calendar_slots(id), away_source_slot_id integer constraint cal_slt_away_src_fk references calendar_slots(id),
      constraint cal_slt_src_ck check (home_source_slot_id is null or away_source_slot_id is null or home_source_slot_id <> away_source_slot_id)
    );
    create unique index if not exists cal_slt_rnd_num_uq on calendar_slots(round_id, slot_number);
    create table if not exists calendar_slot_candidates (
      id serial primary key, slot_id integer not null constraint cal_can_slt_fk references calendar_slots(id) on delete cascade,
      participant_id integer constraint cal_can_par_fk references calendar_participants(id) on delete cascade,
      source_slot_id integer constraint cal_can_src_fk references calendar_slots(id) on delete cascade,
      seed integer, designation text,
      constraint cal_can_one_src_ck check ((participant_id is not null)::integer + (source_slot_id is not null)::integer = 1),
      constraint cal_can_seed_ck check (seed is null or seed > 0),
      constraint cal_can_desig_ck check (designation is null or designation in ('home','away'))
    );
    create table if not exists calendar_series (
      id serial primary key, slot_id integer not null constraint cal_ser_slt_fk references calendar_slots(id) on delete cascade,
      best_of integer not null constraint cal_ser_best_ck check (best_of in (3,5,7))
    );
    create table if not exists calendar_games (
      id serial primary key, slot_id integer not null constraint cal_gam_slt_fk references calendar_slots(id) on delete cascade,
      game_number integer not null, home_participant_id integer constraint cal_gam_home_fk references calendar_participants(id),
      away_participant_id integer constraint cal_gam_away_fk references calendar_participants(id), neutral_site boolean not null default false,
      constraint cal_gam_distinct_ck check (home_participant_id is null or away_participant_id is null or home_participant_id <> away_participant_id)
    );
    create unique index if not exists cal_gam_slt_num_uq on calendar_games(slot_id, game_number);
    create table if not exists calendar_contingent_games (
      id serial primary key, game_id integer not null constraint cal_con_gam_fk references calendar_games(id) on delete cascade,
      prerequisite_slot_id integer not null constraint cal_con_prq_fk references calendar_slots(id), outcome text not null
    );
    create unique index if not exists cal_con_key_uq on calendar_contingent_games(game_id, prerequisite_slot_id, outcome);
    create table if not exists calendar_projection_snapshots (
      id serial primary key, slot_id integer not null constraint cal_prj_slt_fk references calendar_slots(id) on delete cascade,
      mtm_snapshot_id integer not null constraint cal_prj_mtm_fk references mtm_snapshot(id),
      status text not null constraint cal_prj_status_ck check (status in ('available','unavailable')),
      unavailable_reason text,
      created_at timestamptz not null default now(),
      constraint cal_prj_unavail_ck check (status <> 'unavailable' or unavailable_reason is not null)
    );
    create unique index if not exists cal_prj_slt_mtm_uq on calendar_projection_snapshots(slot_id, mtm_snapshot_id);
    create table if not exists calendar_projection_candidates (
      id serial primary key, projection_id integer not null constraint cal_pcan_prj_fk references calendar_projection_snapshots(id) on delete cascade,
      participant_id integer not null constraint cal_pcan_par_fk references calendar_participants(id) on delete cascade,
      probability numeric(8,6) not null constraint cal_pcan_prob_ck check (probability >= 0 and probability <= 1),
      exact_slot_clinched boolean not null default false,
      constraint cal_pcan_clinched_ck check (not exact_slot_clinched or probability = 1)
    );
    create unique index if not exists cal_pcan_key_uq on calendar_projection_candidates(projection_id, participant_id);
    create table if not exists calendar_pool_economics (
      id serial primary key, calendar_id integer not null constraint cal_eco_cal_fk references calcutta_calendars(id) on delete cascade,
      key text not null, value numeric(14,4) not null
    );
    create unique index if not exists cal_eco_key_uq on calendar_pool_economics(calendar_id, key);
    create table if not exists calendar_rubric_values (
      id serial primary key, calendar_id integer not null constraint cal_rub_cal_fk references calcutta_calendars(id) on delete cascade,
      label text not null, points numeric(10,4) not null
    );
    create unique index if not exists cal_rub_label_uq on calendar_rubric_values(calendar_id, label);
    create or replace function cal_validate_calendar_links() returns trigger language plpgsql as $$
    declare target_cal integer; parent_cal integer; participant_cal integer; team_cal integer; snapshot_pool integer; snapshot_status text;
    begin
      if tg_table_name = 'calendar_participants' then
        target_cal := new.calendar_id;
        if not exists (select 1 from calcutta_entries e join calcutta_calendars c on c.calcutta_id=e.calcutta_id where c.id=target_cal and e.team_id=new.team_id) then
          raise exception 'participant team is not entered in this Calcutta';
        end if;
      elsif tg_table_name = 'calendar_slots' then
        select r.calendar_id into target_cal from calendar_rounds r where r.id=new.round_id;
        if new.home_source_slot_id is not null and (select r.calendar_id from calendar_rounds r join calendar_slots s on s.round_id=r.id where s.id=new.home_source_slot_id) <> target_cal then raise exception 'cross-calendar home source slot'; end if;
        if new.away_source_slot_id is not null and (select r.calendar_id from calendar_rounds r join calendar_slots s on s.round_id=r.id where s.id=new.away_source_slot_id) <> target_cal then raise exception 'cross-calendar away source slot'; end if;
      elsif tg_table_name = 'calendar_slot_candidates' then
        select r.calendar_id into target_cal from calendar_rounds r join calendar_slots s on s.round_id=r.id where s.id=new.slot_id;
        if new.participant_id is not null and (select p.calendar_id from calendar_participants p where p.id=new.participant_id) <> target_cal then raise exception 'cross-calendar participant candidate'; end if;
        if new.source_slot_id is not null and (select r.calendar_id from calendar_rounds r join calendar_slots s on s.round_id=r.id where s.id=new.source_slot_id) <> target_cal then raise exception 'cross-calendar source candidate'; end if;
      elsif tg_table_name = 'calendar_games' then
        select r.calendar_id into target_cal from calendar_rounds r join calendar_slots s on s.round_id=r.id where s.id=new.slot_id;
        if new.home_participant_id is not null and (select p.calendar_id from calendar_participants p where p.id=new.home_participant_id) <> target_cal then raise exception 'cross-calendar home participant'; end if;
        if new.away_participant_id is not null and (select p.calendar_id from calendar_participants p where p.id=new.away_participant_id) <> target_cal then raise exception 'cross-calendar away participant'; end if;
      elsif tg_table_name = 'calendar_contingent_games' then
        select r.calendar_id into target_cal from calendar_rounds r join calendar_slots s on s.round_id=r.id join calendar_games g on g.slot_id=s.id where g.id=new.game_id;
        if (select r.calendar_id from calendar_rounds r join calendar_slots s on s.round_id=r.id where s.id=new.prerequisite_slot_id) <> target_cal then raise exception 'cross-calendar contingent prerequisite'; end if;
      elsif tg_table_name = 'calendar_projection_snapshots' then
        select r.calendar_id into target_cal from calendar_rounds r join calendar_slots s on s.round_id=r.id where s.id=new.slot_id;
        select m.pool_id, m.status into snapshot_pool, snapshot_status from mtm_snapshot m where m.id=new.mtm_snapshot_id;
        if snapshot_status is distinct from 'ok' then raise exception 'projection requires successful MTM snapshot'; end if;
        if snapshot_pool is distinct from (select calcutta_id from calcutta_calendars where id=target_cal) then raise exception 'projection MTM pool does not match calendar'; end if;
      elsif tg_table_name = 'calendar_projection_candidates' then
        if (select status from calendar_projection_snapshots where id=new.projection_id) <> 'available' then raise exception 'unavailable projection cannot have candidates'; end if;
        select r.calendar_id into target_cal from calendar_rounds r join calendar_slots s on s.round_id=r.id join calendar_projection_snapshots p on p.slot_id=s.id where p.id=new.projection_id;
        if (select calendar_id from calendar_participants where id=new.participant_id) <> target_cal then raise exception 'cross-calendar projection candidate'; end if;
      end if;
      return new;
    end $$;
    drop trigger if exists cal_validate_participant on calendar_participants;
    create trigger cal_validate_participant before insert or update on calendar_participants for each row execute function cal_validate_calendar_links();
    drop trigger if exists cal_validate_slot on calendar_slots;
    create trigger cal_validate_slot before insert or update on calendar_slots for each row execute function cal_validate_calendar_links();
    drop trigger if exists cal_validate_candidate on calendar_slot_candidates;
    create trigger cal_validate_candidate before insert or update on calendar_slot_candidates for each row execute function cal_validate_calendar_links();
    drop trigger if exists cal_validate_game on calendar_games;
    create trigger cal_validate_game before insert or update on calendar_games for each row execute function cal_validate_calendar_links();
    drop trigger if exists cal_validate_contingent on calendar_contingent_games;
    create trigger cal_validate_contingent before insert or update on calendar_contingent_games for each row execute function cal_validate_calendar_links();
    drop trigger if exists cal_validate_projection on calendar_projection_snapshots;
    create trigger cal_validate_projection before insert or update on calendar_projection_snapshots for each row execute function cal_validate_calendar_links();
    drop trigger if exists cal_validate_projection_candidate on calendar_projection_candidates;
    create trigger cal_validate_projection_candidate before insert or update on calendar_projection_candidates for each row execute function cal_validate_calendar_links();
  `,
} as const;