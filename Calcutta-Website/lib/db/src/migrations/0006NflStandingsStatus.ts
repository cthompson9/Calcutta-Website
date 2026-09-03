export const nflStandingsStatusMigration = {
  version: "0006_nfl_standings_status",
  sql: `
    alter table team_results
      add column if not exists playoff_status text not null default 'unknown';

    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conname = 'team_results_playoff_status_values'
      ) then
        alter table team_results
          add constraint team_results_playoff_status_values
          check (playoff_status in ('unknown', 'alive', 'clinched', 'eliminated'));
      end if;
    end $$;
  `,
} as const;