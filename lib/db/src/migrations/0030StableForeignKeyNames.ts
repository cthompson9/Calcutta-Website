export const stableForeignKeyNamesMigration = {
  version: "0030_stable_foreign_key_names",
  sql: `
    do $$
    declare
      fk record;
      current_constraint_name text;
      matching_constraint_count integer;
    begin
      for fk in
        select *
        from (
          values
            (
              'historical_calcutta_rosters',
              'calcutta_id',
              'normalized_calcuttas',
              'historical_rosters_calcutta_fk'
            ),
            (
              'historical_calcutta_links',
              'normalized_calcutta_id',
              'normalized_calcuttas',
              'historical_links_normalized_calcutta_fk'
            ),
            (
              'normalized_calcutta_owners',
              'calcutta_id',
              'normalized_calcuttas',
              'normalized_calcutta_owners_calcutta_fk'
            ),
            (
              'normalized_expected_entry_results',
              'entry_id',
              'normalized_entries',
              'normalized_expected_entry_results_entry_fk'
            ),
            (
              'normalized_expected_owner_results',
              'calcutta_id',
              'normalized_calcuttas',
              'normalized_expected_owner_results_calcutta_fk'
            ),
            (
              'normalized_expected_owner_results',
              'owner_id',
              'normalized_owners',
              'normalized_expected_owner_results_owner_fk'
            ),
            (
              'trades',
              'entry_id',
              'calcutta_entries',
              'trades_entry_id_fkey'
            )
        ) as targets(source_table, source_column, target_table, new_name)
      loop
        if exists (
          select 1
          from pg_constraint
          where conrelid = to_regclass(format('public.%I', fk.source_table))
            and conname = fk.new_name
        ) then
          continue;
        end if;

        select count(*), min(c.conname)
          into matching_constraint_count, current_constraint_name
        from pg_constraint c
        join pg_class target on target.oid = c.confrelid
        join pg_namespace target_namespace on target_namespace.oid = target.relnamespace
        join pg_attribute source_column
          on source_column.attrelid = c.conrelid
         and source_column.attnum = any(c.conkey)
        where c.conrelid = to_regclass(format('public.%I', fk.source_table))
          and c.contype = 'f'
          and target_namespace.nspname = 'public'
          and target.relname = fk.target_table
          and source_column.attname = fk.source_column
          and cardinality(c.conkey) = 1;

        if matching_constraint_count <> 1 then
          raise exception
            'Expected exactly one %.% FK to %, found %',
            fk.source_table,
            fk.source_column,
            fk.target_table,
            matching_constraint_count;
        end if;

        execute format(
          'alter table public.%I rename constraint %I to %I',
          fk.source_table,
          current_constraint_name,
          fk.new_name
        );
      end loop;
    end
    $$;
  `,
} as const;