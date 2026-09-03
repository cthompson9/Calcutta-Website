export const phase1ReleaseSafetyMigration = {
  version: "0024_phase1_release_safety_v1",
  sql: `
    lock table
      trades,
      mtm_snapshots,
      positions,
      calcutta_entries,
      calcuttas,
      calcutta_rules
    in share row exclusive mode;

    create temporary table phase1_release_safety_baseline
      on commit drop
      as
      select
        (select count(*)::bigint from trades) as trade_count,
        (select count(*)::bigint from mtm_snapshots) as mtm_count,
        (select count(*)::bigint from positions) as position_count,
        (select count(*)::bigint from team_bidders) as team_bidder_count;

    alter table calcutta_rules add column if not exists calculation text;
    alter table calcutta_rules add column if not exists condition text;

    do $$
    begin
      if (
        select count(*)
        from calcuttas c
        inner join seasons s on s.id = c.season_id
        where s.year in (2025, 2026)
          and c.sport = 'NFL'
          and c.is_canonical = true
      ) <> 2 then
        raise exception
          'Phase 1 rules require exactly one canonical NFL Calcutta for each of 2025 and 2026';
      end if;

      if exists (
        select 1
        from calcutta_rules r
        inner join calcuttas c on c.id = r.calcutta_id
        inner join seasons s on s.id = c.season_id
        where s.year in (2025, 2026)
          and c.sport = 'NFL'
          and c.is_canonical = true
          and (
            (r.rule_name = 'banked' and exists (
              select 1 from calcutta_rules replacement
              where replacement.calcutta_id = r.calcutta_id
                and replacement.rule_name = 'banked_points'
            ))
            or
            (r.rule_name = 'win' and exists (
              select 1 from calcutta_rules replacement
              where replacement.calcutta_id = r.calcutta_id
                and replacement.rule_name = 'regular_season_win'
            ))
          )
      ) then
        raise exception
          'Cannot canonicalize Phase 1 rule names: legacy and replacement rows both exist';
      end if;
    end
    $$;

    update calcutta_rules r
      set rule_name = case r.rule_name
        when 'banked' then 'banked_points'
        when 'win' then 'regular_season_win'
      end,
      updated_at = now()
    from calcuttas c
    inner join seasons s on s.id = c.season_id
    where r.calcutta_id = c.id
      and s.year in (2025, 2026)
      and c.sport = 'NFL'
      and c.is_canonical = true
      and r.rule_name in ('banked', 'win');

    insert into calcutta_rules (
      calcutta_id,
      rule_name,
      rule_type,
      calculation,
      condition,
      value,
      multiplier,
      description,
      active
    )
    select
      c.id,
      seed.rule_name,
      'points',
      seed.calculation,
      seed.condition,
      seed.value,
      seed.multiplier,
      seed.description,
      true
    from calcuttas c
    inner join seasons s on s.id = c.season_id
    cross join (
      values
        ('banked_points', 'fixed', null, 150.000000::numeric, null::numeric, 'Starting banked points'),
        ('regular_season_win', 'win', null, 10.000000::numeric, null::numeric, 'Points awarded per regular-season win'),
        ('point_differential', 'pt_diff', null, null::numeric, null::numeric, 'Points awarded for adjusted point differential'),
        ('marquee_point_differential', 'pt_diff', 'is_marquee', null::numeric, 2.000000::numeric, 'Marquee games double point differential only'),
        ('playoff_berth', 'playoff_berth', null, null::numeric, null::numeric, 'Points awarded for qualifying for the playoffs'),
        ('divisional_round', 'div_round', null, null::numeric, null::numeric, 'Points awarded for reaching the divisional round'),
        ('conference_championship', 'conf_round', null, null::numeric, null::numeric, 'Points awarded for reaching the conference championship'),
        ('super_bowl_appearance', 'sb_berth', null, null::numeric, null::numeric, 'Points awarded for reaching the Super Bowl'),
        ('super_bowl_win', 'win_super_bowl', null, null::numeric, null::numeric, 'Points awarded for winning the Super Bowl')
    ) as seed(rule_name, calculation, condition, value, multiplier, description)
    where s.year in (2025, 2026)
      and c.sport = 'NFL'
      and c.is_canonical = true
    on conflict (calcutta_id, rule_name) do update
      set rule_type = excluded.rule_type,
          calculation = excluded.calculation,
          condition = excluded.condition,
          value = excluded.value,
          multiplier = excluded.multiplier,
          description = excluded.description,
          active = excluded.active,
          updated_at = now();

    do $$
    begin
      if exists (select 1 from trades where entry_id is null) then
        raise exception
          'Phase 1 safety gate failed: unresolved trades.entry_id rows remain';
      end if;
      if exists (
        select 1
        from trades t
        inner join calcutta_entries ce on ce.id = t.entry_id
        inner join calcuttas c on c.id = ce.calcutta_id
        where ce.team_id is distinct from t.team_id
           or c.season_id is distinct from t.season_id
      ) then
        raise exception
          'Phase 1 safety gate failed: a trade entry does not round-trip to its team and season';
      end if;

      if exists (select 1 from mtm_snapshots where entry_id is null) then
        raise exception
          'Phase 1 safety gate failed: unresolved mtm_snapshots.entry_id rows remain';
      end if;
      if exists (
        select 1
        from mtm_snapshots m
        inner join calcutta_entries ce on ce.id = m.entry_id
        inner join calcuttas c on c.id = ce.calcutta_id
        where ce.team_id is distinct from m.team_id
           or c.season_id is distinct from m.season_id
      ) then
        raise exception
          'Phase 1 safety gate failed: an MTM entry does not round-trip to its team and season';
      end if;

      if not exists (select 1 from positions where source = 'primary') then
        raise exception
          'Phase 1 safety gate failed: primary positions are unexpectedly empty';
      end if;
      if not exists (select 1 from team_bidders) then
        raise exception
          'Phase 1 safety gate failed: team_bidders is unexpectedly empty';
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
          'Phase 1 safety gate failed: team_bidders team/season coverage differs from primary positions';
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
          'Phase 1 safety gate failed: team_bidders rows differ from primary positions';
      end if;

      if exists (
        select 1
        from (
          select
            c.id,
            count(r.id) filter (
              where r.rule_name in (
                'banked_points',
                'regular_season_win',
                'point_differential',
                'marquee_point_differential',
                'playoff_berth',
                'divisional_round',
                'conference_championship',
                'super_bowl_appearance',
                'super_bowl_win'
              )
            ) as required_count,
            count(r.id) filter (
              where r.rule_name in (
                'point_differential',
                'playoff_berth',
                'divisional_round',
                'conference_championship',
                'super_bowl_appearance',
                'super_bowl_win'
              )
                and r.value is null
                and r.multiplier is null
            ) as null_rule_count,
            max(r.value) filter (where r.rule_name = 'banked_points') as banked_value,
            max(r.value) filter (where r.rule_name = 'regular_season_win') as win_value,
            max(r.multiplier) filter (
              where r.rule_name = 'marquee_point_differential'
                and r.calculation = 'pt_diff'
                and r.condition = 'is_marquee'
                and r.value is null
            ) as marquee_multiplier
          from calcuttas c
          inner join seasons s on s.id = c.season_id
          left join calcutta_rules r on r.calcutta_id = c.id
          where s.year in (2025, 2026)
            and c.sport = 'NFL'
            and c.is_canonical = true
          group by c.id
        ) validation
        where required_count <> 9
           or null_rule_count <> 6
           or banked_value is distinct from 150.000000::numeric
           or win_value is distinct from 10.000000::numeric
           or marquee_multiplier is distinct from 2.000000::numeric
      ) then
        raise exception
          'Phase 1 safety gate failed: canonical NFL Calcutta rules are incomplete';
      end if;

      if (
        select count(*)::bigint from trades
      ) <> (
        select trade_count from phase1_release_safety_baseline
      ) or (
        select count(*)::bigint from mtm_snapshots
      ) <> (
        select mtm_count from phase1_release_safety_baseline
      ) or (
        select count(*)::bigint from positions
      ) <> (
        select position_count from phase1_release_safety_baseline
      ) or (
        select count(*)::bigint from team_bidders
      ) <> (
        select team_bidder_count from phase1_release_safety_baseline
      ) then
        raise exception
          'Phase 1 safety gate failed: protected row counts changed';
      end if;
    end
    $$;
  `,
} as const;