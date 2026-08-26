export const platformSchemaMigration = {
  version: "0012_platform_schema",
  sql: `
    alter table calcuttas add column if not exists competition_format text;
    alter table calcuttas add column if not exists status text;
    update calcuttas
      set competition_format = coalesce(competition_format, 'NFL_REGULAR_SEASON'),
          status = coalesce(status, 'active');
    alter table calcuttas alter column competition_format set default 'NFL_REGULAR_SEASON';
    alter table calcuttas alter column competition_format set not null;
    alter table calcuttas alter column status set default 'active';
    alter table calcuttas alter column status set not null;

    alter table calcutta_entries add column if not exists metadata jsonb;

    create table if not exists calcutta_rules (
      id serial primary key,
      calcutta_id integer not null references calcuttas(id) on delete cascade,
      rule_name text not null,
      rule_type text,
      value numeric(16, 6),
      multiplier numeric(16, 6),
      description text,
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint calcutta_rules_rule_type_supported
        check (rule_type is null or rule_type in ('points', 'fixed_pct', 'shared_pool'))
    );
    create unique index if not exists calcutta_rules_calcutta_rule_idx
      on calcutta_rules(calcutta_id, rule_name);

    insert into calcutta_rules (
      calcutta_id, rule_name, rule_type, value, multiplier, description, active
    )
    select c.id, rule_seed.rule_name, 'points', rule_seed.value, null,
      rule_seed.description, true
    from calcuttas c
    inner join seasons s on s.id = c.season_id
    cross join (
      values
        ('banked', 150.000000::numeric, 'Starting banked points'),
        ('win', 10.000000::numeric, 'Points awarded per win')
    ) as rule_seed(rule_name, value, description)
    where s.year in (2025, 2026)
      and c.sport = 'NFL'
      and c.is_canonical = true
    on conflict (calcutta_id, rule_name) do update
      set rule_type = excluded.rule_type,
          value = excluded.value,
          multiplier = excluded.multiplier,
          description = excluded.description,
          active = excluded.active,
          updated_at = now();

    create table if not exists events (
      id serial primary key,
      season_id integer not null references seasons(id) on delete cascade,
      source text not null default 'manual',
      source_event_id text not null,
      week integer not null,
      event_date date not null,
      kickoff_at timestamptz,
      timezone text not null default 'America/New_York',
      away_team_id integer not null references teams(id),
      home_team_id integer not null references teams(id),
      venue text,
      network text,
      status text not null default 'scheduled',
      away_score integer,
      home_score integer,
      source_data jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint events_distinct_teams check (home_team_id <> away_team_id),
      constraint events_week_non_negative check (week >= 0)
    );
    create unique index if not exists events_season_source_event_idx
      on events(season_id, source, source_event_id);
    create unique index if not exists events_season_week_matchup_idx
      on events(season_id, week, away_team_id, home_team_id);
    create index if not exists events_season_week_idx on events(season_id, week);
    create index if not exists events_home_team_idx on events(home_team_id);
    create index if not exists events_away_team_idx on events(away_team_id);

    create table if not exists event_market_snapshots (
      id serial primary key,
      event_id integer not null references events(id) on delete cascade,
      snapshot_at timestamptz not null,
      source text not null,
      spread numeric(7, 2),
      home_moneyline integer,
      away_moneyline integer,
      home_implied_probability numeric(8, 6),
      away_implied_probability numeric(8, 6),
      total numeric(7, 2),
      source_data jsonb,
      created_at timestamptz not null default now(),
      constraint event_market_snapshots_home_probability_bounds
        check (home_implied_probability is null or (home_implied_probability >= 0 and home_implied_probability <= 1)),
      constraint event_market_snapshots_away_probability_bounds
        check (away_implied_probability is null or (away_implied_probability >= 0 and away_implied_probability <= 1))
    );
    create unique index if not exists event_market_snapshots_event_source_time_idx
      on event_market_snapshots(event_id, source, snapshot_at);
    create index if not exists event_market_snapshots_event_time_idx
      on event_market_snapshots(event_id, snapshot_at);

    create table if not exists event_projections (
      id serial primary key,
      event_id integer not null references events(id) on delete cascade,
      snapshot_at timestamptz not null,
      model_name text not null,
      source text not null default 'manual',
      home_win_probability numeric(8, 6),
      away_win_probability numeric(8, 6),
      projected_home_score numeric(7, 2),
      projected_away_score numeric(7, 2),
      projected_point_differential numeric(7, 2),
      source_data jsonb,
      created_at timestamptz not null default now(),
      constraint event_projections_home_probability_bounds
        check (home_win_probability is null or (home_win_probability >= 0 and home_win_probability <= 1)),
      constraint event_projections_away_probability_bounds
        check (away_win_probability is null or (away_win_probability >= 0 and away_win_probability <= 1)),
      constraint event_projections_probability_pair
        check (
          (home_win_probability is null and away_win_probability is null)
          or (
            home_win_probability is not null
            and away_win_probability is not null
            and abs((home_win_probability + away_win_probability) - 1) <= 0.000001
          )
        )
    );
    create unique index if not exists event_projections_event_model_source_time_idx
      on event_projections(event_id, model_name, source, snapshot_at);
    create index if not exists event_projections_event_time_idx
      on event_projections(event_id, snapshot_at);

    create table if not exists snapshot_metrics (
      id serial primary key,
      entry_id integer not null references calcutta_entries(id) on delete cascade,
      period_id integer not null references sport_periods(id) on delete cascade,
      basis text not null,
      metric text not null,
      value numeric(16, 6) not null,
      source text not null default 'manual',
      source_data jsonb,
      snapshot_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint snapshot_metrics_basis_supported check (basis in ('realized', 'mtm'))
    );
    create unique index if not exists snapshot_metrics_entry_period_basis_metric_idx
      on snapshot_metrics(entry_id, period_id, basis, metric);
    create index if not exists snapshot_metrics_entry_basis_idx
      on snapshot_metrics(entry_id, basis);
    create index if not exists snapshot_metrics_period_basis_idx
      on snapshot_metrics(period_id, basis);

    alter table trades add column if not exists entry_id integer;
    update trades t
      set entry_id = mapped.entry_id
    from (
      select c.season_id, ce.team_id, min(ce.id) as entry_id
      from calcuttas c
      inner join calcutta_entries ce on ce.calcutta_id = c.id
      where c.is_canonical = true
        and c.sport = 'NFL'
      group by c.season_id, ce.team_id
      having count(*) = 1
    ) mapped
    where t.season_id = mapped.season_id
      and t.team_id = mapped.team_id
      and t.entry_id is null;

    do $$
    begin
      if exists (
        select 1
        from trades t
        left join (
          select c.season_id, ce.team_id, min(ce.id) as entry_id, count(*) as entry_count
          from calcuttas c
          inner join calcutta_entries ce on ce.calcutta_id = c.id
          where c.is_canonical = true
            and c.sport = 'NFL'
          group by c.season_id, ce.team_id
        ) mapped on mapped.season_id = t.season_id and mapped.team_id = t.team_id
        where mapped.entry_count is distinct from 1
          or t.entry_id is distinct from mapped.entry_id
      ) then
        raise exception 'Cannot backfill trades.entry_id: every trade must map to exactly one matching Calcutta entry';
      end if;
    end
    $$;

    alter table trades alter column entry_id set default null;
    alter table trades alter column entry_id set not null;
    alter table trades add constraint trades_entry_id_fkey
      foreign key (entry_id) references calcutta_entries(id) on delete restrict;
    create index if not exists trades_entry_idx on trades(entry_id);

    create or replace function populate_trade_entry_id()
    returns trigger
    language plpgsql
    as $$
    declare
      canonical_calcutta_id integer;
      canonical_calcutta_count integer;
    begin
      if new.entry_id is null then
        select min(c.id), count(*)
          into canonical_calcutta_id, canonical_calcutta_count
        from calcuttas c
        where c.season_id = new.season_id
          and c.is_canonical = true
          and c.sport = 'NFL';

        if canonical_calcutta_count = 0 then
          insert into calcuttas (
            season_id, name, year, sport, competition_format, status, is_canonical
          )
          select
            s.id,
            s.year::text || ' NFL Calcutta',
            s.year,
            'NFL',
            'NFL_REGULAR_SEASON',
            'active',
            true
          from seasons s
          where s.id = new.season_id
          on conflict (name) do nothing;

          select min(c.id), count(*)
            into canonical_calcutta_id, canonical_calcutta_count
          from calcuttas c
          where c.season_id = new.season_id
            and c.is_canonical = true
            and c.sport = 'NFL';
        end if;

        if canonical_calcutta_count <> 1 then
          raise exception 'Cannot derive trade entry_id: season % has % canonical NFL Calcuttas',
            new.season_id, canonical_calcutta_count;
        end if;

        select ce.id
          into new.entry_id
        from calcutta_entries ce
        where ce.calcutta_id = canonical_calcutta_id
          and ce.team_id = new.team_id;

        if new.entry_id is null then
          insert into calcutta_entries (calcutta_id, team_id)
            values (canonical_calcutta_id, new.team_id)
            on conflict (calcutta_id, team_id) do nothing;

          select ce.id
            into new.entry_id
          from calcutta_entries ce
          where ce.calcutta_id = canonical_calcutta_id
            and ce.team_id = new.team_id;
        end if;
      end if;

      if new.entry_id is null or not exists (
        select 1
        from calcutta_entries ce
        inner join calcuttas c on c.id = ce.calcutta_id
        where ce.id = new.entry_id
          and c.season_id = new.season_id
          and ce.team_id = new.team_id
      ) then
        raise exception 'Trade entry_id must match its season_id and team_id';
      end if;

      return new;
    end
    $$;

    drop trigger if exists trades_populate_entry_id on trades;
    create trigger trades_populate_entry_id
      before insert or update of season_id, team_id, entry_id on trades
      for each row execute function populate_trade_entry_id();

    -- positions already have a non-null entry_id with a foreign key. The
    -- legacy payout_rules and team_period_snapshots tables intentionally remain
    -- in place: payout_rules is still queried by reporting code and
    -- team_period_snapshots contains 128 live historical rows.
  `,
} as const;
