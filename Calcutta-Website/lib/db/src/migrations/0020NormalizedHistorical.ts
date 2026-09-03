/**
 * The Stage-1 history ledger is additive.  Do not rename these tables to the
 * live relation names before the XII convergence work is explicitly approved.
 * The ownership trigger is intentionally raw SQL: drizzle does not model
 * deferred constraint triggers.
 */
export const normalizedHistoricalMigration = {
  version: "0020_normalized_historical_v6",
  sql: `
    create table if not exists competition_formats (
      key text primary key, sport text not null, structure text not null,
      constraint competition_formats_structure_check
        check (structure in ('league','single_elim','series_bracket','group_knockout')),
      definition jsonb not null, created_at timestamptz not null default now()
    );
    create table if not exists format_periods (
      format_key text not null references competition_formats(key) on delete cascade,
      key text not null, seq integer not null, label text not null,
      kind text not null default 'regular',
      constraint format_periods_kind_check
        check (kind in ('baseline','regular','group','knockout')),
      weight numeric(10,4) not null default 1, is_scored boolean not null default true,
      constraint format_periods_pkey primary key(format_key,key)
    );
    create unique index if not exists format_periods_format_seq_idx
      on format_periods(format_key,seq);
    create table if not exists normalized_calcuttas (
      id serial primary key, edition_number integer not null, name text not null,
      sport text not null, format_key text not null references competition_formats(key),
      season_year integer not null, pot_size numeric(14,2), as_of_date date,
      normalization jsonb not null, status text not null default 'complete'
    );
    create unique index if not exists normalized_calcuttas_edition_idx
      on normalized_calcuttas(edition_number);
    create unique index if not exists normalized_calcuttas_name_idx
      on normalized_calcuttas(name);
    create table if not exists normalized_owners (
      id serial primary key, display_name text not null, email text
    );
    create unique index if not exists normalized_owners_display_name_idx
      on normalized_owners(display_name);
    create table if not exists normalized_calcutta_owners (
      calcutta_id integer not null references normalized_calcuttas(id) on delete cascade,
      owner_id integer not null references normalized_owners(id), label text not null,
      constraint normalized_calcutta_owners_pkey primary key(calcutta_id,owner_id)
    );
    create unique index if not exists normalized_calcutta_owners_label_idx
      on normalized_calcutta_owners(calcutta_id,label);
    create table if not exists normalized_teams (
      id serial primary key, sport text not null, name text not null
    );
    create unique index if not exists normalized_teams_sport_name_idx
      on normalized_teams(sport,name);
    create table if not exists normalized_entries (
      id serial primary key, calcutta_id integer not null references normalized_calcuttas(id) on delete cascade,
      label text not null, lot_order integer, price numeric(14,2) not null,
      kind text not null default 'single',
      constraint normalized_entries_kind_check
        check(kind in ('single','bundle','placeholder')),
      attributes jsonb
    );
    create unique index if not exists normalized_entries_calcutta_label_idx
      on normalized_entries(calcutta_id,label);
    create index if not exists normalized_entries_calcutta_idx on normalized_entries(calcutta_id);
    create table if not exists normalized_entry_teams (
      entry_id integer not null references normalized_entries(id) on delete cascade,
      team_id integer not null references normalized_teams(id), seed integer,
      resolved boolean not null default true, primary key(entry_id,team_id)
    );
    create table if not exists normalized_positions (
      id serial primary key, entry_id integer not null references normalized_entries(id) on delete cascade,
      owner_id integer not null references normalized_owners(id), share numeric(9,6) not null,
      source text not null default 'primary',
      constraint normalized_positions_source_check
        check(source in ('primary','trade')),
      trade_id integer
    );
    create index if not exists normalized_positions_entry_idx on normalized_positions(entry_id);
    create table if not exists normalized_trades (
      id serial primary key,
      calcutta_id integer not null references normalized_calcuttas(id) on delete cascade,
      sheet_ref text, trade_date date, detail text,
      scope text not null default 'entry',
      constraint normalized_trades_scope_check
        check(scope in ('entry','book','synthetic_book','sidebet','cash')),
      entry_id integer references normalized_entries(id),
      from_owner_id integer references normalized_owners(id),
      to_owner_id integer references normalized_owners(id),
      pct numeric(9,6), cash numeric(14,6),
      status text not null default 'approved',
      reference_owner_id integer references normalized_owners(id),
      factor numeric(9,4), basis text,
      constraint normalized_trades_basis_check
        check(basis is null or basis in ('lion_king','net')),
      source_data jsonb not null
    );
    alter table normalized_trades
      add column if not exists status text not null default 'approved';
    alter table normalized_trades
      drop constraint if exists normalized_trades_scope_shape;
    alter table normalized_trades
      add constraint normalized_trades_scope_shape check(
        (scope='entry' and entry_id is not null and basis is null)
        or (scope in ('book','synthetic_book') and basis is not null)
        or (scope in ('sidebet','cash') and basis is null and factor is null)
      );
    create index if not exists normalized_trades_calcutta_idx
      on normalized_trades(calcutta_id);
    create index if not exists normalized_trades_entry_idx
      on normalized_trades(entry_id);
    create table if not exists normalized_scoring_rules (
      id serial primary key, calcutta_id integer not null references normalized_calcuttas(id) on delete cascade,
      kind text not null,
      constraint normalized_scoring_rules_kind_check
        check(kind in ('per_unit','direct_share','group_rank_bonus','split_pool')),
      metric text, period_key text, rate numeric(14,8) not null, group_attr text,
      fallback text[], note text
    );
    create index if not exists normalized_scoring_rules_calcutta_idx on normalized_scoring_rules(calcutta_id);
    create table if not exists normalized_scoring_events (
      id serial primary key, entry_id integer not null references normalized_entries(id) on delete cascade,
      period_key text, metric text not null, units numeric(12,4) not null,
      source text not null default 'sheet'
    );
    alter table normalized_scoring_events
      drop constraint if exists normalized_scoring_events_entry_period_metric_idx;
    drop index if exists normalized_scoring_events_entry_period_metric_idx;
    alter table normalized_scoring_events
      add constraint normalized_scoring_events_entry_period_metric_idx
      unique nulls not distinct(entry_id,period_key,metric);
    create index if not exists normalized_scoring_events_entry_idx on normalized_scoring_events(entry_id);
    create table if not exists normalized_expected_entry_results (
      entry_id integer primary key references normalized_entries(id) on delete cascade,
      points numeric(14,4), realized_return numeric(14,2)
    );
    create table if not exists normalized_expected_owner_results (
      calcutta_id integer not null references normalized_calcuttas(id) on delete cascade,
      owner_id integer not null references normalized_owners(id),
      cost numeric(14,2), realized numeric(14,2), primary key(calcutta_id,owner_id)
    );
    create table if not exists normalized_import_runs (
      id serial primary key, edition_number integer not null, source text not null,
      source_hash text not null, imported_teams integer not null, imported_owners integer not null,
      requested_by text not null, created_at timestamptz not null default now()
    );
    create unique index if not exists normalized_import_runs_edition_source_hash_idx
      on normalized_import_runs(edition_number,source,source_hash);
    create or replace function enforce_normalized_entry_ownership_total() returns trigger language plpgsql as $$
    declare t numeric;
    begin
      select coalesce(sum(share),0) into t from normalized_positions
        where entry_id=coalesce(new.entry_id,old.entry_id);
      if t <> 1.000000 then
        raise exception 'normalized entry % ownership must net exactly 1.000000, got %',
          coalesce(new.entry_id,old.entry_id),t using errcode='23514';
      end if;
      return null;
    end $$;
    drop trigger if exists normalized_positions_net_one on normalized_positions;
    create constraint trigger normalized_positions_net_one after insert or update or delete on normalized_positions
      deferrable initially deferred for each row execute function enforce_normalized_entry_ownership_total();
    create or replace view v_tracking as
      select s.entry_id,
        case when s.metric='banked_points' then 2147483647 else p.seq end as seq,
        case
          when s.metric='advance' and s.period_key='R32' then 'Advanced to Round of 32'
          when s.metric='advance' and s.period_key='S16' then 'Advanced to Sweet 16'
          when s.metric='advance' and s.period_key='E8' then 'Advanced to Elite 8'
          when s.metric='advance' and s.period_key='F4' then 'Advanced to Final Four'
          when s.metric='advance' and s.period_key in ('CHAMP','NCG') then 'Reached the Championship'
          when s.metric='advance' and s.period_key='TITLE' then 'Won the Championship'
          when s.metric like 'upset_%plus' then 'Upset by ' || replace(replace(s.metric,'upset_',''),'plus','') || '+ seeds x' || trim(to_char(s.units,'FM999990'))
          when s.metric='win' and s.period_key='GROUP' then 'Group stage: ' || trim(to_char(s.units,'FM999990')) || ' win(s)'
          when s.metric='tie' and s.period_key='GROUP' then 'Group stage: ' || trim(to_char(s.units,'FM999990')) || ' draw(s)'
          when s.metric='loss' and s.period_key='GROUP' then 'Group stage: ' || trim(to_char(s.units,'FM999990')) || ' loss(es)'
          when s.metric='top_table' then 'Won its group'
          when s.metric='knockouts' then 'Advanced to the knockout round'
          when s.metric='win' and s.period_key is not null and s.period_key<>'GROUP'
            then 'Won in the ' || coalesce(p.label,s.period_key)
          when s.metric='shootout_loss'
            then 'Lost on penalties in the ' || coalesce(p.label,s.period_key)
          when s.metric='game_win' then coalesce(p.label,s.period_key) || ': ' || trim(to_char(s.units,'FM999990')) || ' game(s) won'
          when s.metric='sweep' then 'Swept a series x' || trim(to_char(s.units,'FM999990'))
          when s.metric='upset_series_win' then 'Won a series as the lower seed x' || trim(to_char(s.units,'FM999990'))
          when s.metric='banked_points' then 'Banked opening points'
          when s.metric='reg_season_win' then trim(to_char(s.units,'FM999990')) || ' regular-season win(s)'
          when s.metric='tie' then trim(to_char(s.units,'FM999990')) || ' tie(s)'
          when s.metric in ('adj_point_differential','pt_diff')
            then 'Point differential ' || trim(to_char(s.units,'SFM999990'))
          when s.metric='pt_diff_rank_bonus' then 'Point-differential rank bonus'
          when s.metric='win_20plus' then trim(to_char(s.units,'FM999990')) || ' win(s) by 20+'
          when s.metric='weekly_big_winner' then 'Weekly big winner x' || trim(to_char(s.units,'FM999990'))
          when s.metric='reg_season_big_win' then 'Regular-season big win'
          when s.metric='playoff_berth' then 'Made the playoffs'
          when s.metric='div_round' then 'Reached the divisional round'
          when s.metric='conf_round' then 'Reached the conference championship'
          when s.metric='sb_berth' then 'Reached the Super Bowl'
          when s.metric='win_super_bowl' then 'Won the Super Bowl'
          else s.metric || ' x' || trim(to_char(s.units,'FM999990.99'))
        end as phrase
      from normalized_scoring_events s
      join normalized_entries e on e.id=s.entry_id
      join normalized_calcuttas c on c.id=e.calcutta_id
      left join format_periods p on p.format_key=c.format_key and p.key=s.period_key;
    create or replace view v_entry_results as
      select c.edition_number as ed,c.name as calcutta,c.sport,e.label as lot,e.kind,
        e.attributes->>'seed' as seed,coalesce(e.attributes->>'region',e.attributes->>'group',e.attributes->>'division') as grouping,
        e.price,
        (select string_agg(o.display_name || ' ' || trim(to_char(p.share*100,'FM999990.0')) || '%', ', ' order by p.share desc,o.display_name)
          from normalized_positions p join normalized_owners o on o.id=p.owner_id where p.entry_id=e.id and p.source='primary') as ownership,
        (select string_agg(t.phrase,' · ' order by t.seq nulls last,t.phrase) from v_tracking t where t.entry_id=e.id) as tracking,
        x.points,x.realized_return as payout
      from normalized_entries e join normalized_calcuttas c on c.id=e.calcutta_id
      left join normalized_expected_entry_results x on x.entry_id=e.id;
    create or replace view v_owner_results as
      select c.edition_number as ed,c.name as calcutta,c.sport,o.display_name as owner,
        round(sum(p.share),4) as lots,round(sum(p.share*e.price),2) as cost,
        round(sum(p.share*x.realized_return),2) as payout
      from normalized_positions p join normalized_entries e on e.id=p.entry_id
      join normalized_calcuttas c on c.id=e.calcutta_id join normalized_owners o on o.id=p.owner_id
      left join normalized_expected_entry_results x on x.entry_id=e.id
      where p.source='primary' group by 1,2,3,4
      order by 1,7 desc nulls last;
  `,
} as const;