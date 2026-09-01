-- Supply the password at execution time; never commit it to this repository.
-- This is a psql script. Run it as a database administrator against the target database.

\prompt -s 'Password for calcutta_backup: ' calcutta_backup_password
CREATE ROLE calcutta_backup
  WITH LOGIN
  NOINHERIT
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  PASSWORD :'calcutta_backup_password';

GRANT CONNECT ON DATABASE :"DBNAME" TO calcutta_backup;
REVOKE CREATE ON SCHEMA public FROM calcutta_backup;
GRANT USAGE ON SCHEMA public TO calcutta_backup;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM calcutta_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO calcutta_backup;

-- This script must be run as the role that creates application tables.
SELECT current_user AS table_owner \gset
ALTER DEFAULT PRIVILEGES FOR ROLE :"table_owner" IN SCHEMA public
  GRANT SELECT ON TABLES TO calcutta_backup;

DO $$
BEGIN
  IF has_schema_privilege('calcutta_backup', 'public', 'CREATE') THEN
    RAISE EXCEPTION
      'calcutta_backup still inherits CREATE on schema public; revoke it from the granting role or PUBLIC';
  END IF;
END
$$;