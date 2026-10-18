#!/bin/sh
# Migrations, for the embedded database only.
#
# An external database is somebody else's release process: two replicas starting together would
# race, and a failed migration should stop a deploy rather than leave a half-migrated database
# serving. An embedded one has exactly one process and no deploy pipeline, so doing it here is the
# difference between the container working and the operator reading a runbook.
set -eu
[ "${EMBEDDED_POSTGRES:-off}" = "on" ] || exit 0
cd /app/server
export HOME=/home/apiuser
# `scripts/migrate.ts`, not `drizzle-kit`. The CLI is a development dependency and needs esbuild to
# read its TypeScript config, which `bun install --production` leaves out of this image: asked to
# migrate here it exits 1 without printing why, and the container comes up against an empty database.
: "${MIGRATION_DATABASE_URL:?postgres-init must supply the owner URL}"
# s6 starting a long-running service does not mean PostgreSQL has finished
# crash recovery. Wait for an authenticated query before running migrations.
OWNER_PW="$(cat /var/lib/postgresql/pgpassword)"
deadline=$(($(date +%s)+30))
until PGPASSWORD="$OWNER_PW" PGCONNECT_TIMEOUT=2 s6-setuidgid apiuser \
  /usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -U openbot -d openbot \
  -v ON_ERROR_STOP=1 -Atqc 'SELECT 1' >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo 'migrate: embedded PostgreSQL was not ready within 30 seconds' >&2
    exit 1
  fi
  sleep 1
done
echo 'migrate: embedded PostgreSQL is ready'
# Scope the owner URL to migration; never replace the API's environment file.
DATABASE_URL="$MIGRATION_DATABASE_URL" s6-setuidgid apiuser /usr/local/bin/bun scripts/migrate.ts

APP_PW="$(cat /var/lib/postgresql/pgpassword-app)"
# Generated secrets are hex. Validate before placing one in a SQL literal.
case "$APP_PW" in ''|*[!0-9a-f]*) echo 'migrate: invalid app password file' >&2; exit 1 ;; esac
[ "${#APP_PW}" -eq 64 ] || { echo 'migrate: invalid app password length' >&2; exit 1; }
printf "ALTER ROLE openbot_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '%s';\n" "$APP_PW" | \
  PGPASSWORD="$OWNER_PW" s6-setuidgid apiuser /usr/lib/postgresql/16/bin/psql \
    -h 127.0.0.1 -U openbot -d openbot -v ON_ERROR_STOP=1 >/dev/null
echo 'migrate: openbot_app password installed; NOSUPERUSER NOBYPASSRLS'
