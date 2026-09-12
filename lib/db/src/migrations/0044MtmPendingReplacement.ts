export const mtmPendingReplacementMigration = {
  version: "0046_mtm_pending_replacement",
  sql: `
    drop trigger if exists mtm_valuation_version_append_only on mtm_valuation_version;
    create trigger mtm_valuation_version_append_only
      before insert or update on mtm_valuation_version
      for each row when (new.mark_type <> 'pending_recalculation')
      execute function mtm_valuation_version_guard();
    drop trigger if exists mtm_valuation_version_delete_guard on mtm_valuation_version;
    create trigger mtm_valuation_version_delete_guard
      before delete on mtm_valuation_version
      for each row execute function mtm_valuation_version_guard();

    create or replace function mtm_pending_replacement_guard() returns trigger
      language plpgsql as $$
      declare
        source_status text;
        source_method text;
        source_pool integer;
        source_pot numeric;
        pool_entries integer;
        valuation_rows integer;
        valuation_pool_rows integer;
        valuation_entries integer;
        valuation_invalid integer;
        valuation_total numeric;
        pending_games integer;
        provisional_games integer;
        missing_source integer;
        raw_source_games integer;
        mapped_source_games integer;
        noncanonical_games integer;
        actuals_json text;
      begin
        if tg_op = 'INSERT' then
          if new.status <> 'candidate' then
            raise exception 'MTM valuation versions must be inserted as candidates';
          end if;
          return new;
        end if;
        if old.status = 'candidate' and new.status not in ('current', 'superseded')
           or old.status = 'current' and new.status <> 'superseded'
           or old.status = 'superseded'
        then
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
        then
          raise exception 'MTM valuation version metadata is immutable';
        end if;
        if old.status = 'candidate' and new.status = 'current' then
          select status, method_version, pool_id, (state_json->>'pot')::numeric
            into source_status, source_method, source_pool, source_pot
            from mtm_snapshot where id = new.source_snapshot_id;
          if source_status is distinct from 'ok' or source_method = 'mtm-v3-review'
             or source_pool is distinct from new.pool_id or source_pot is null or source_pot <= 0
          then
            raise exception 'Current MTM pending source must be successful and same-pool';
          end if;
          select count(*) into pool_entries from calcutta_entries where calcutta_id = new.pool_id;
          select count(*) into valuation_rows
            from mtm_entry_valuation where snapshot_id = new.source_snapshot_id;
          select count(*), count(distinct v.entry_id),
                 count(*) filter (where v.expected_payout is null or v.expected_payout::numeric < 0),
                 coalesce(sum(v.expected_payout::numeric), 0)
            into valuation_pool_rows, valuation_entries, valuation_invalid, valuation_total
            from mtm_entry_valuation v
            join calcutta_entries e on e.id = v.entry_id and e.calcutta_id = new.pool_id
           where v.snapshot_id = new.source_snapshot_id;
          if pool_entries <> 32 or valuation_rows <> 32 or valuation_pool_rows <> 32
             or valuation_entries <> 32
             or valuation_invalid <> 0 or abs(valuation_total - source_pot) > 0.01
          then
            raise exception 'Current MTM pending source valuations are incomplete or unreconciled';
          end if;
          select count(*) filter (where linkage_status = 'pending'),
                 count(*) filter (where is_provisional)
            into pending_games, provisional_games
            from mtm_valuation_game where version_id = new.id;
          if pending_games < 1 or provisional_games <> 0 or new.stale_reason is null then
            raise exception 'Pending MTM versions require pending canonical evidence';
          end if;
          select count(*) filter (
            where e.id is null
              or (
                e.home_score is not null and e.away_score is not null and (
                  g.week <> e.week
                  or g.home_team_id <> e.home_team_id
                  or g.away_team_id <> e.away_team_id
                  or g.home_score is distinct from e.home_score
                  or g.away_score is distinct from e.away_score
                  or g.outcome <> case
                    when e.home_score > e.away_score then 'home_win'
                    when e.away_score > e.home_score then 'away_win'
                    else 'tie'
                  end
                )
              )
              or (
                (e.home_score is null or e.away_score is null) and (
                  g.linkage_status <> 'pending'
                  or not exists (
                    select 1
                    from jsonb_array_elements(
                      coalesce((select input_provenance->'realized_results'
                                from mtm_snapshot where id = new.source_snapshot_id), '[]'::jsonb)
                    ) actual
                    join jsonb_array_elements(
                      coalesce((select state_json->'entries'
                                from mtm_snapshot where id = new.source_snapshot_id), '[]'::jsonb)
                    ) home_entry on home_entry->>'team' = actual->>'home'
                    join jsonb_array_elements(
                      coalesce((select state_json->'entries'
                                from mtm_snapshot where id = new.source_snapshot_id), '[]'::jsonb)
                    ) away_entry on away_entry->>'team' = actual->>'away'
                    join calcutta_entries source_home
                      on source_home.id = (home_entry->>'entry_id')::integer
                     and source_home.calcutta_id = new.pool_id
                    join calcutta_entries source_away
                      on source_away.id = (away_entry->>'entry_id')::integer
                     and source_away.calcutta_id = new.pool_id
                    where actual->>'provider' = e.source
                      and actual->>'source_id' = e.source_event_id
                      and (actual->>'week')::integer = g.week
                      and source_home.team_id = g.home_team_id
                      and source_away.team_id = g.away_team_id
                      and (actual->>'home_score')::integer = g.home_score
                      and (actual->>'away_score')::integer = g.away_score
                  )
                )
              )
          ) into noncanonical_games
          from mtm_valuation_game g
          left join events e
            on e.id = g.event_id
           and e.season_id = (select season_id from calcuttas where id = new.pool_id)
           and e.sport = 'NFL'
           and e.competition = 'NFL_REGULAR_SEASON'
          where g.version_id = new.id;
          if noncanonical_games <> 0 then
            raise exception 'Pending MTM linkage must match canonical pool events';
          end if;
          select jsonb_array_length(coalesce(
            (select input_provenance->'realized_results'
               from mtm_snapshot where id = new.source_snapshot_id),
            '[]'::jsonb
          )) into raw_source_games;
          select count(*) into mapped_source_games
            from jsonb_array_elements(
              coalesce((select input_provenance->'realized_results'
                          from mtm_snapshot where id = new.source_snapshot_id), '[]'::jsonb)
            ) actual
            join events e
              on e.season_id = (select season_id from calcuttas where id = new.pool_id)
             and e.sport = 'NFL'
             and e.competition = 'NFL_REGULAR_SEASON'
             and e.source = actual->>'provider'
             and e.source_event_id = actual->>'source_id';
          if raw_source_games <> mapped_source_games then
            raise exception 'Pending MTM source contains unmappable actuals';
          end if;
          select count(*) into missing_source
            from (
              select e.id as event_id
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
              except
              select event_id from mtm_valuation_game
               where version_id = new.id and linkage_status in ('incorporated', 'pending')
            ) missing;
          if missing_source <> 0 then
            raise exception 'Pending MTM linkage must retain every source event or same-event replacement';
          end if;
          select '[' || coalesce(string_agg(actual_json, ',' order by actual_json), '') || ']'
            into actuals_json
            from (
              select '{"game_id":' || to_jsonb(event_id::text)::text ||
                ',"week":' || week::text ||
                ',"home_team_id":' || to_jsonb(home_team_id::text)::text ||
                ',"away_team_id":' || to_jsonb(away_team_id::text)::text ||
                ',"home_score":' || home_score::text ||
                ',"away_score":' || away_score::text || '}' as actual_json
                from mtm_valuation_game where version_id = new.id
            ) canonical_actuals;
          if new.actuals_state_hash <> encode(sha256(convert_to(actuals_json, 'UTF8')), 'hex') then
            raise exception 'Current MTM pending actuals hash does not match linked canonical state';
          end if;
        end if;
        return new;
      end $$;
    drop trigger if exists mtm_pending_replacement_guard on mtm_valuation_version;
    create trigger mtm_pending_replacement_guard
      before insert or update on mtm_valuation_version
      for each row when (new.mark_type = 'pending_recalculation')
      execute function mtm_pending_replacement_guard();
  `,
};