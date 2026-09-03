export const canonicalCalcuttaScopeMigration = {
  version: "0017_canonical_calcutta_scope",
  sql: `
    do $$
    begin
      if exists (
        select 1
        from calcuttas
        where is_canonical = true
        group by season_id, sport
        having count(*) > 1
      ) then
        raise exception 'Cannot enforce canonical Calcutta scope: duplicate canonical rows exist for a season and sport.';
      end if;
    end
    $$;

    create unique index if not exists calcuttas_canonical_season_sport_idx
      on calcuttas(season_id, sport)
      where is_canonical = true;
  `,
} as const;