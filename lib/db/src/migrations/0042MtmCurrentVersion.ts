export const mtmCurrentVersionMigration = {
  version: "0042_mtm_current_version",
  sql: `
    create table if not exists mtm_valuation_version (
      id integer generated always as identity primary key,
      pool_id integer not null constraint mtm_val_version_pool_fk references calcuttas(id) on delete cascade,
      source_snapshot_id integer not null constraint mtm_val_version_source_snapshot_fk references mtm_snapshot(id) on delete restrict,
      actuals_state_hash text not null,
      actuals_as_of timestamptz not null,
      mtm_as_of timestamptz not null,
      mark_type text not null,
       status text not null default 'candidate',
      stale_reason text,
      provisional_event_id integer constraint mtm_val_version_provisional_event_fk references events(id) on delete restrict,
      provisional_outcome text,
      created_at timestamptz not null default now(),
      constraint mtm_val_version_mark_type_supported check (mark_type in ('official','provisional','pending_recalculation')),
       constraint mtm_val_version_status_supported check (status in ('candidate','current','superseded')),
      constraint mtm_val_version_provisional_outcome_supported check (provisional_outcome is null or provisional_outcome in ('home_win','away_win','tie')),
      constraint mtm_val_version_provisional_pair check ((provisional_event_id is null and provisional_outcome is null) or (provisional_event_id is not null and provisional_outcome is not null))
    );
    create index if not exists mtm_val_version_pool_created_idx on mtm_valuation_version(pool_id, created_at);
    create index if not exists mtm_val_version_source_snapshot_idx on mtm_valuation_version(source_snapshot_id);
    create unique index if not exists mtm_val_version_one_current_idx on mtm_valuation_version(pool_id) where status = 'current';

    create table if not exists mtm_valuation_game (
      id integer generated always as identity primary key,
      version_id integer not null constraint mtm_val_game_version_fk references mtm_valuation_version(id) on delete cascade,
      event_id integer not null constraint mtm_val_game_event_fk references events(id) on delete restrict,
      week integer not null,
      home_team_id integer not null,
      away_team_id integer not null,
      home_score integer,
      away_score integer,
      outcome text,
      linkage_status text not null default 'incorporated',
      is_provisional boolean not null default false,
      constraint mtm_val_game_status_supported check (linkage_status in ('incorporated','pending')),
      constraint mtm_val_game_outcome_supported check (outcome is null or outcome in ('home_win','away_win','tie')),
      constraint mtm_val_game_provisional_incorporated check (not is_provisional or linkage_status = 'incorporated'),
      constraint mtm_val_game_incorporated_result_complete check (linkage_status = 'pending' or (home_score is not null and away_score is not null and outcome is not null)),
      constraint mtm_val_game_scores_pair check ((home_score is null and away_score is null) or (home_score is not null and away_score is not null)),
      constraint mtm_val_game_distinct_teams check (home_team_id <> away_team_id),
      constraint mtm_val_game_version_event_unique unique (version_id, event_id)
    );
    create unique index if not exists mtm_val_game_one_provisional_idx on mtm_valuation_game(version_id) where is_provisional;
    create index if not exists mtm_val_game_version_status_idx on mtm_valuation_game(version_id, linkage_status);

    -- Publication is append-only apart from the single status transition used
    -- to supersede an older current version.  Source/as-of/linkage metadata can
    -- never be rewritten after a version has been created.
    create or replace function mtm_valuation_version_guard() returns trigger language plpgsql as $$
    declare
      source_status text;
      source_method text;
      source_pool integer;
      source_pot numeric;
      pool_entries integer;
      valuation_rows integer;
      valuation_entries integer;
      valuation_invalid integer;
      valuation_total numeric;
      source_games integer;
      raw_source_games integer;
      linked_source_games integer;
      linked_games integer;
      linked_invalid integer;
      pending_canonical_invalid integer;
      actuals_json text;
      provisional_games integer;
      pending_games integer;
      conditional_rows integer;
      conditional_entries integer;
      conditional_pool_entries integer;
      conditional_invalid integer;
      conditional_total numeric;
    begin
      if tg_op = 'INSERT' then
        if new.status <> 'candidate' then
          raise exception 'MTM valuation versions must be inserted as candidates';
        end if;
        return new;
      end if;
      if tg_op = 'DELETE' then
        raise exception 'MTM valuation versions are append-only: deletes are rejected';
      end if;
       if tg_op = 'UPDATE' then
         if not (
           (old.status = 'candidate' and new.status in ('current', 'superseded'))
           or (old.status = 'current' and new.status = 'superseded')
         ) then
           raise exception 'Invalid MTM valuation status transition';
        end if;
        if old.pool_id is distinct from new.pool_id
          or old.source_snapshot_id is distinct from new.source_snapshot_id
          or old.actuals_state_hash is distinct from new.actuals_state_hash
          or old.actuals_as_of is distinct from new.actuals_as_of
          or old.mtm_as_of is distinct from new.mtm_as_of
          or old.mark_type is distinct from new.mark_type
          or old.stale_reason is distinct from new.stale_reason
          or old.provisional_event_id is distinct from new.provisional_event_id
          or old.provisional_outcome is distinct from new.provisional_outcome
          or old.created_at is distinct from new.created_at
        then
          raise exception 'MTM valuation version metadata is immutable';
        end if;
        if old.status = 'candidate' and new.status = 'current' then
          select status, method_version, pool_id, (state_json->>'pot')::numeric
          into source_status, source_method, source_pool, source_pot
          from mtm_snapshot where id = new.source_snapshot_id;
          if source_status is distinct from 'ok'
            or source_method = 'mtm-v3-review'
            or source_pool is distinct from new.pool_id
            or source_pot is null
            or source_pot <= 0
          then
            raise exception 'Current MTM source must be a successful non-review snapshot for the same pool';
          end if;

          select count(*) into pool_entries from calcutta_entries where calcutta_id = new.pool_id;
          select count(*) into valuation_rows
          from mtm_entry_valuation
          where snapshot_id = new.source_snapshot_id;
          select count(*), count(distinct v.entry_id),
                 count(*) filter (where v.expected_payout is null or v.expected_payout::numeric < 0),
                 coalesce(sum(v.expected_payout::numeric), 0)
          into linked_source_games, valuation_entries, valuation_invalid, valuation_total
          from mtm_entry_valuation v
          join calcutta_entries e on e.id = v.entry_id and e.calcutta_id = new.pool_id
          where v.snapshot_id = new.source_snapshot_id;
          if pool_entries <> 32 or valuation_rows <> 32 or linked_source_games <> 32 or valuation_entries <> 32
            or valuation_invalid <> 0 or abs(valuation_total - source_pot) > 0.01
          then
            raise exception 'Current MTM official valuations are incomplete or do not conserve the pool';
          end if;

          select count(*),
                 count(*) filter (
                   where home_score is null or away_score is null or outcome is null
                     or outcome <> case
                       when home_score > away_score then 'home_win'
                       when away_score > home_score then 'away_win'
                       else 'tie'
                     end
                 ),
                 count(*) filter (where is_provisional),
                 count(*) filter (where linkage_status = 'pending')
          into linked_games, linked_invalid, provisional_games, pending_games
          from mtm_valuation_game where version_id = new.id;
          if linked_invalid <> 0 then
            raise exception 'Current MTM game linkage must contain complete, score-consistent finalized results';
          end if;

          with source_actuals as (
            select
              e.id as event_id,
              e.week,
              e.home_team_id,
              e.away_team_id,
              (actual->>'home_score')::integer as home_score,
              (actual->>'away_score')::integer as away_score
            from jsonb_array_elements(
              coalesce((select input_provenance->'realized_results'
                        from mtm_snapshot where id = new.source_snapshot_id), '[]'::jsonb)
            ) actual
            join events e
              on e.season_id = (select season_id from calcuttas where id = new.pool_id)
             and e.sport = 'NFL'
             and e.competition = 'NFL_REGULAR_SEASON'
             and e.source = actual->>'provider'
             and e.source_event_id = actual->>'source_id'
          ),
          linked_source as (
            select event_id, week, home_team_id, away_team_id, home_score, away_score
            from mtm_valuation_game
            where version_id = new.id and linkage_status = 'incorporated' and not is_provisional
          )
          select
            (select count(*) from source_actuals),
            (select count(*) from linked_source)
          into source_games, linked_source_games;
          select jsonb_array_length(
            coalesce((select input_provenance->'realized_results'
                      from mtm_snapshot where id = new.source_snapshot_id), '[]'::jsonb)
          ) into raw_source_games;
          if raw_source_games <> source_games or source_games <> linked_source_games or exists (
            with source_actuals as (
              select e.id as event_id, e.week, e.home_team_id, e.away_team_id,
                     (actual->>'home_score')::integer as home_score,
                     (actual->>'away_score')::integer as away_score
              from jsonb_array_elements(
                coalesce((select input_provenance->'realized_results'
                          from mtm_snapshot where id = new.source_snapshot_id), '[]'::jsonb)
              ) actual
              join events e
                on e.season_id = (select season_id from calcuttas where id = new.pool_id)
               and e.sport = 'NFL'
               and e.competition = 'NFL_REGULAR_SEASON'
               and e.source = actual->>'provider'
               and e.source_event_id = actual->>'source_id'
            ),
            linked_source as (
              select event_id, week, home_team_id, away_team_id, home_score, away_score
              from mtm_valuation_game
              where version_id = new.id and linkage_status = 'incorporated' and not is_provisional
            )
            select * from (
              (select * from source_actuals except select * from linked_source)
              union all
              (select * from linked_source except select * from source_actuals)
            ) differences
          ) then
            raise exception 'Current MTM incorporated game set does not exactly match the source snapshot actuals';
          end if;

          select count(*) filter (
            where e.id is null
              or g.week <> e.week
              or g.home_team_id <> e.home_team_id
              or g.away_team_id <> e.away_team_id
              or g.home_score is distinct from e.home_score
              or g.away_score is distinct from e.away_score
          )
          into pending_canonical_invalid
          from mtm_valuation_game g
          left join events e
            on e.id = g.event_id
           and e.season_id = (select season_id from calcuttas where id = new.pool_id)
           and e.sport = 'NFL'
           and e.competition = 'NFL_REGULAR_SEASON'
          where g.version_id = new.id
            and (g.linkage_status = 'pending' or g.is_provisional);
          if pending_canonical_invalid <> 0 then
            raise exception 'Pending and provisional games must match finalized canonical pool events';
          end if;

          select '[' || coalesce(string_agg(actual_json, ',' order by actual_json), '') || ']'
          into actuals_json
          from (
            select
              '{"game_id":' || to_jsonb(event_id::text)::text ||
              ',"week":' || week::text ||
              ',"home_team_id":' || to_jsonb(home_team_id::text)::text ||
              ',"away_team_id":' || to_jsonb(away_team_id::text)::text ||
              ',"home_score":' || home_score::text ||
              ',"away_score":' || away_score::text || '}' as actual_json
            from mtm_valuation_game where version_id = new.id
          ) canonical_actuals;
          if linked_games = 0 and new.actuals_state_hash <> encode(sha256(convert_to('[]', 'UTF8')), 'hex')
            or linked_games > 0 and new.actuals_state_hash <> encode(sha256(convert_to(actuals_json, 'UTF8')), 'hex')
          then
            raise exception 'Current MTM actuals hash does not match its exact linked game state';
          end if;
          if new.mark_type = 'official' and (
            provisional_games <> 0 or pending_games <> 0
            or new.provisional_event_id is not null or new.provisional_outcome is not null
          ) then
            raise exception 'Official MTM versions cannot contain provisional or pending games';
          elsif new.mark_type = 'provisional' then
            if provisional_games <> 1 or pending_games <> 0
              or new.provisional_event_id is null or new.provisional_outcome is null
              or not exists (
                select 1 from mtm_valuation_game
                where version_id = new.id and is_provisional
                  and event_id = new.provisional_event_id
                  and outcome = new.provisional_outcome
              )
            then
              raise exception 'Provisional MTM version linkage is incomplete';
            end if;
            select count(*), count(distinct c.entry_id),
                   count(*) filter (where e.id is not null),
                   count(*) filter (
                     where c.gross_conditional is null or c.gross_conditional::numeric < 0
                       or c.gross_baseline is null or c.gross_baseline::numeric < 0
                       or c.quality_status not in ('good', 'warning')
                   ),
                   coalesce(sum(c.gross_conditional::numeric), 0)
            into conditional_rows, conditional_entries, conditional_pool_entries, conditional_invalid, conditional_total
            from mtm_game_conditional c
            left join calcutta_entries e on e.id = c.entry_id and e.calcutta_id = new.pool_id
            where c.snapshot_id = new.source_snapshot_id
              and c.event_id = new.provisional_event_id
              and c.outcome = new.provisional_outcome;
            if conditional_rows <> 32 or conditional_entries <> 32 or conditional_pool_entries <> 32
              or conditional_invalid <> 0 or abs(conditional_total - source_pot) > 0.01
            then
              raise exception 'Provisional MTM conditionals are incomplete or do not conserve the pool';
            end if;
          elsif new.mark_type = 'pending_recalculation' and (
            pending_games < 1 or provisional_games <> 0 or new.stale_reason is null
          ) then
            raise exception 'Pending MTM versions must identify pending games and a stale reason';
          end if;
        end if;
      end if;
      return new;
    end $$;
    drop trigger if exists mtm_valuation_version_append_only on mtm_valuation_version;
    create trigger mtm_valuation_version_append_only before insert or update or delete on mtm_valuation_version
      for each row execute function mtm_valuation_version_guard();

    create or replace function mtm_valuation_game_guard() returns trigger language plpgsql as $$
    declare
      parent_status text;
    begin
      if tg_op <> 'INSERT' then
        raise exception 'MTM valuation game linkage is append-only';
      end if;
      select status into parent_status
      from mtm_valuation_version
      where id = new.version_id;
      if parent_status is distinct from 'candidate' then
        raise exception 'MTM valuation game linkage can only be added to a candidate version';
      end if;
      return new;
    end $$;
    drop trigger if exists mtm_valuation_game_append_only on mtm_valuation_game;
    create trigger mtm_valuation_game_append_only before insert or update or delete on mtm_valuation_game
      for each row execute function mtm_valuation_game_guard();

    create or replace function mtm_current_source_guard() returns trigger language plpgsql as $$
    begin
      if exists (
        select 1 from mtm_valuation_version
        where source_snapshot_id = old.id
      ) then
        raise exception 'An MTM snapshot referenced by a valuation version is immutable';
      end if;
      return case when tg_op = 'DELETE' then old else new end;
    end $$;
    drop trigger if exists mtm_current_source_immutable on mtm_snapshot;
    create trigger mtm_current_source_immutable before update or delete on mtm_snapshot
      for each row execute function mtm_current_source_guard();

    create or replace function mtm_current_payload_guard() returns trigger language plpgsql as $$
    declare
      old_snapshot_id integer;
      new_snapshot_id integer;
    begin
      old_snapshot_id := case when tg_op = 'INSERT' then null else old.snapshot_id end;
      new_snapshot_id := case when tg_op = 'DELETE' then null else new.snapshot_id end;
      if exists (
        select 1 from mtm_valuation_version
        where source_snapshot_id in (old_snapshot_id, new_snapshot_id)
      ) then
        raise exception 'MTM valuation payload for a versioned source is immutable';
      end if;
      return case when tg_op = 'DELETE' then old else new end;
    end $$;
    drop trigger if exists mtm_current_entry_valuation_immutable on mtm_entry_valuation;
    create trigger mtm_current_entry_valuation_immutable
      before insert or update or delete on mtm_entry_valuation
      for each row execute function mtm_current_payload_guard();
    drop trigger if exists mtm_current_game_conditional_immutable on mtm_game_conditional;
    create trigger mtm_current_game_conditional_immutable
      before insert or update or delete on mtm_game_conditional
      for each row execute function mtm_current_payload_guard();
  `,
} as const;