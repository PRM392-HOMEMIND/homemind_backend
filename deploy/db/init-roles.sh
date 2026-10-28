#!/usr/bin/env bash
set -euo pipefail
umask 077
# Passwords enter psql through stdin, never process arguments or terminal output.
migrator_password=$(cat /run/secrets/migrator_password)
app_password=$(cat /run/secrets/app_password)
[[ $migrator_password =~ ^[a-f0-9]{64}$ && $app_password =~ ^[a-f0-9]{64}$ ]]
{
  printf '\\set migrator_password %s\n\\set app_password %s\n' "$migrator_password" "$app_password"
  cat <<'SQL'
SELECT format('CREATE ROLE homemind_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'migrator_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='homemind_migrator') \gexec
SELECT format('CREATE ROLE homemind_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='homemind_app') \gexec
ALTER DATABASE homemind OWNER TO homemind_migrator;
ALTER SCHEMA public OWNER TO homemind_migrator;
REVOKE ALL ON DATABASE homemind FROM PUBLIC;
GRANT CONNECT ON DATABASE homemind TO homemind_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO homemind_app;
ALTER DEFAULT PRIVILEGES FOR ROLE homemind_migrator IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE homemind_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
SQL
} | psql --no-psqlrc -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname homemind
unset migrator_password app_password
