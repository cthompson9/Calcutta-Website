set search_path to cal;

-- Human-readable tracking phrases, derived from the generic event table.
-- No dollars, no MOIC, no IRR: just what happened.
create or replace view v_tracking as
select s.entry_id,
       p.seq,
       case
         -- March Madness / bracket advancement
         when s.metric='advance' and s.period_key='R32'   then 'Advanced to Round of 32'
         when s.metric='advance' and s.period_key='S16'   then 'Advanced to Sweet 16'
         when s.metric='advance' and s.period_key='E8'    then 'Advanced to Elite 8'
         when s.metric='advance' and s.period_key='F4'    then 'Advanced to Final Four'
         when s.metric='advance' and s.period_key in ('CHAMP','NCG') then 'Reached the Championship'
         when s.metric='advance' and s.period_key='TITLE' then 'Won the Championship'
         -- upsets
         when s.metric like 'upset_%plus' then
              'Upset by ' || replace(replace(s.metric,'upset_',''),'plus','') ||
              '+ seeds x' || trim(to_char(s.units,'FM999990'))
         -- World Cup
         when s.metric='win'  and s.period_key='GROUP' then 'Group stage: ' || trim(to_char(s.units,'FM999990')) || ' win(s)'
         when s.metric='tie'  and s.period_key='GROUP' then 'Group stage: ' || trim(to_char(s.units,'FM999990')) || ' draw(s)'
         when s.metric='loss' and s.period_key='GROUP' then 'Group stage: ' || trim(to_char(s.units,'FM999990')) || ' loss(es)'
         when s.metric='top_table'  then 'Won its group'
         when s.metric='knockouts'  then 'Advanced to the knockout round'
         when s.metric='win' and s.period_key is not null and s.period_key<>'GROUP'
              then 'Won in the ' || coalesce(p.label, s.period_key)
         when s.metric='shootout_loss'
              then 'Lost on penalties in the ' || coalesce(p.label, s.period_key)
         -- NBA
         when s.metric='game_win' then coalesce(p.label,s.period_key) || ': ' ||
              trim(to_char(s.units,'FM999990')) || ' game(s) won'
         when s.metric='sweep'            then 'Swept a series x' || trim(to_char(s.units,'FM999990'))
         when s.metric='upset_series_win' then 'Won a series as the lower seed x' || trim(to_char(s.units,'FM999990'))
         -- NFL
         when s.metric='banked_points'   then 'Banked opening points'
         when s.metric='reg_season_win'  then trim(to_char(s.units,'FM999990')) || ' regular-season win(s)'
         when s.metric='tie'             then trim(to_char(s.units,'FM999990')) || ' tie(s)'
         when s.metric in ('adj_point_differential','pt_diff')
              then 'Point differential ' || trim(to_char(s.units,'SFM999990'))
         when s.metric='pt_diff_rank_bonus' then 'Point-differential rank bonus'
         when s.metric='win_20plus'      then trim(to_char(s.units,'FM999990')) || ' win(s) by 20+'
         when s.metric='weekly_big_winner' then 'Weekly big winner x' || trim(to_char(s.units,'FM999990'))
         when s.metric='reg_season_big_win' then 'Regular-season big win'
         when s.metric='playoff_berth'   then 'Made the playoffs'
         when s.metric='div_round'       then 'Reached the divisional round'
         when s.metric='conf_round'      then 'Reached the conference championship'
         when s.metric='sb_berth'        then 'Reached the Super Bowl'
         when s.metric='win_super_bowl'  then 'Won the Super Bowl'
         else s.metric || ' x' || trim(to_char(s.units,'FM999990.99'))
       end as phrase
from scoring_events s
left join entries e on e.id = s.entry_id
left join calcuttas c on c.id = e.calcutta_id
left join format_periods p on p.format_key = c.format_key and p.key = s.period_key;

-- Team-by-team: what happened, and what it paid.
create or replace view v_entry_results as
select c.edition_number                                   as ed,
       c.name                                             as calcutta,
       c.sport,
       e.label                                            as lot,
       e.kind,
       (e.attributes->>'seed')                            as seed,
       coalesce(e.attributes->>'region', e.attributes->>'group',
                e.attributes->>'division')                as grouping,
       e.price,
       (select string_agg(o.display_name || ' ' ||
               trim(to_char(p.share*100,'FM999990.0')) || '%', ', ' order by p.share desc)
          from positions p join owners o on o.id=p.owner_id
         where p.entry_id=e.id and p.source='primary')     as ownership,
       (select string_agg(t.phrase, ' · ' order by t.seq nulls last, t.phrase)
          from v_tracking t where t.entry_id=e.id)         as tracking,
       x.points                                           as points,
       x.realized_return                                  as payout
from entries e
join calcuttas c on c.id=e.calcutta_id
left join expected_entry_results x on x.entry_id=e.id;

-- Owner-by-owner, per pool. Fractional lot counts, cost, payout.
create or replace view v_owner_results as
select c.edition_number as ed, c.name as calcutta, c.sport,
       o.display_name   as owner,
       round(sum(p.share),4)                       as lots,
       round(sum(p.share * e.price),2)             as cost,
       round(sum(p.share * x.realized_return),2)   as payout
from positions p
join entries   e on e.id=p.entry_id
join calcuttas c on c.id=e.calcutta_id
join owners    o on o.id=p.owner_id
left join expected_entry_results x on x.entry_id=e.id
where p.source='primary'
group by 1,2,3,4
order by 1, 7 desc nulls last;
