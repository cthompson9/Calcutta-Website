export const competitionScoringConstraintConvergenceMigration = {
  version: "0055_competition_scoring_constraint_convergence",
  sql: `
    alter table payout_rules
      drop constraint if exists payout_rules_metric_supported;
    alter table payout_rules
      add constraint payout_rules_metric_supported
      check (metric ~ '^[a-z][a-z0-9_]*$');

    alter table snapshot_metrics
      drop constraint if exists snapshot_metrics_metric_supported;
    alter table snapshot_metrics
      add constraint snapshot_metrics_metric_supported
      check (metric ~ '^[a-z][a-z0-9_]*$');
  `,
} as const;