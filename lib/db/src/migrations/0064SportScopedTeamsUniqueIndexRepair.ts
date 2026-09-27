export const sportScopedTeamsUniqueIndexRepairMigration = {
  version: "0064_sport_scoped_teams_unique_index_repair",
  sql: `
    do $$
    declare
      item record;
    begin
      for item in
        select ns.nspname as schema_name, tbl.relname as table_name, con.conname as constraint_name
        from pg_constraint con
        join pg_class tbl on tbl.oid = con.conrelid
        join pg_namespace ns on ns.oid = tbl.relnamespace
        join pg_attribute attr on attr.attrelid = tbl.oid
          and attr.attname = 'name'
          and attr.attnum = con.conkey[1]
        where ns.nspname = current_schema()
          and tbl.relname = 'teams'
          and con.contype = 'u'
          and array_length(con.conkey, 1) = 1
      loop
        execute format(
          'alter table %I.%I drop constraint %I',
          item.schema_name, item.table_name, item.constraint_name
        );
      end loop;

      for item in
        select ns.nspname as schema_name, idx.relname as index_name
        from pg_index ind
        join pg_class tbl on tbl.oid = ind.indrelid
        join pg_namespace ns on ns.oid = tbl.relnamespace
        join pg_class idx on idx.oid = ind.indexrelid
        join pg_attribute attr on attr.attrelid = tbl.oid
          and attr.attname = 'name'
          and attr.attnum = any(ind.indkey)
        where ns.nspname = current_schema()
          and tbl.relname = 'teams'
          and ind.indisunique
          and not ind.indisprimary
          and ind.indnkeyatts = 1
          and ind.indnatts = 1
      loop
        execute format('drop index if exists %I.%I', item.schema_name, item.index_name);
      end loop;
    end
    $$;

    create unique index if not exists teams_sport_name_idx on teams (sport, name);
  `,
} as const;