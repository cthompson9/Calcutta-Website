export const competitionScoringMigration = {
  version: "0018_competition_scoring_v2",
  sql: `
    alter table payout_rules
      alter column dollars_per_unit drop not null,
      alter column dollars_per_unit drop default,
      alter column playoff_multiplier drop not null,
      alter column playoff_multiplier drop default;
    alter table payout_rules drop constraint if exists payout_rules_metric_supported;
    alter table payout_rules add constraint payout_rules_metric_supported
      check (metric ~ '^[a-z][a-z0-9_]*$');
    alter table payout_rules drop constraint if exists payout_rules_multiplier_non_negative;
    alter table payout_rules add constraint payout_rules_multiplier_non_negative
      check (playoff_multiplier is null or playoff_multiplier >= 0);

    alter table calcutta_rules drop constraint if exists calcutta_rules_rule_name_nonempty;
    alter table calcutta_rules add constraint calcutta_rules_rule_name_nonempty
      check (length(trim(rule_name)) > 0);
    alter table calcutta_rules drop constraint if exists calcutta_rules_multiplier_non_negative;
    alter table calcutta_rules add constraint calcutta_rules_multiplier_non_negative
      check (multiplier is null or multiplier >= 0);

    alter table snapshot_metrics drop constraint if exists snapshot_metrics_metric_supported;
    alter table snapshot_metrics add constraint snapshot_metrics_metric_supported
      check (metric ~ '^[a-z][a-z0-9_]*$');

    alter table sport_periods
      add column if not exists competition text;
    update sport_periods
      set competition = case
        when sport = 'NFL' then 'NFL_REGULAR_SEASON'
        when sport = 'CFB' then 'CFB_REGULAR_SEASON'
        else sport || '_DEFAULT'
      end
      where competition is null;
    alter table sport_periods alter column competition set not null;
    alter table sport_periods alter column competition drop default;
    drop index if exists sport_periods_sport_sequence_idx;
    create unique index if not exists sport_periods_competition_sequence_idx
      on sport_periods(sport, competition, sequence);
    alter table sport_periods drop constraint if exists sport_periods_sport_nonempty;
    alter table sport_periods add constraint sport_periods_sport_nonempty
      check (length(trim(sport)) > 0);
    alter table sport_periods drop constraint if exists sport_periods_competition_nonempty;
    alter table sport_periods add constraint sport_periods_competition_nonempty
      check (length(trim(competition)) > 0);

    alter table team_results
      drop constraint if exists team_results_record_total_at_most_17;
  `,
} as const;