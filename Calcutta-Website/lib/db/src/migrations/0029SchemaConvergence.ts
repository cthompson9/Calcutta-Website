export const schemaConvergenceMigration = {
  version: "0029_schema_convergence",
  sql: `
    -- Restore the primary-position guarantee if an earlier drizzle push
    -- removed the migration-0013 index.
    create unique index if not exists positions_primary_entry_bidder_idx
      on positions (entry_id, bidder_id)
      where source = 'primary';

    do $$
    declare
      current_constraint_name text;
      matching_constraint_count integer;
    begin
      if not exists (
        select 1
        from pg_constraint
        where conrelid = 'mcp_oauth_authorization_codes'::regclass
          and conname = 'mcp_oauth_codes_client_fk'
      ) then
        select count(*), min(c.conname)
          into matching_constraint_count, current_constraint_name
        from pg_constraint c
        join pg_class target on target.oid = c.confrelid
        join pg_attribute source_column
          on source_column.attrelid = c.conrelid
         and source_column.attnum = any(c.conkey)
        where c.conrelid = 'mcp_oauth_authorization_codes'::regclass
          and c.contype = 'f'
          and target.relname = 'mcp_oauth_clients'
          and source_column.attname = 'client_id'
          and cardinality(c.conkey) = 1;

        if matching_constraint_count <> 1 then
          raise exception
            'Expected exactly one authorization-code client FK, found %',
            matching_constraint_count;
        end if;

        execute format(
          'alter table mcp_oauth_authorization_codes rename constraint %I to mcp_oauth_codes_client_fk',
          current_constraint_name
        );
      end if;
    end
    $$;

    do $$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conrelid = 'mcp_oauth_tokens'::regclass
          and conname = 'mcp_oauth_tokens_token_type_check'
      ) then
        alter table mcp_oauth_tokens
          add constraint mcp_oauth_tokens_token_type_check
          check (token_type in ('access', 'refresh'));
      end if;
    end
    $$;
  `,
} as const;