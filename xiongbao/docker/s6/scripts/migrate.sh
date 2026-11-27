#!/bin/sh
# Migrations, for the embedded database only.
#
# An external database is somebody else's release process: two replicas starting together would
# race, and a failed migration should stop a deploy rather than leave a half-migrated database
# serving. An embedded one has exactly one process and no deploy pipeline, so doing it here is the
# difference between the container working and the operator reading a runbook.
set -eu
[ "${EMBEDDED_POSTGRES:-off}" = "on" ] || exit 0
# Started is not ready: see wait-for-postgres.sh.
"$(dirname "$0")/wait-for-postgres.sh"
cd /app/server
export HOME=/home/apiuser

# s6 starting a long-running service does not mean PostgreSQL has finished crash recovery, so wait for an
# authenticated query before running migrations: up to 30 seconds for a login as the superuser, xiongbao on
# every volume (new volumes are created under it, and v0.2.16 renamed the older ones).
OWNER_PW="$(cat /var/lib/postgresql/pgpassword)"
DB_USER=xiongbao
DB_NAME=xiongbao
PSQL=/usr/lib/postgresql/16/bin/psql
LOGIN_ERR="$(mktemp)"
waited=0
until PGPASSWORD="$OWNER_PW" PGCONNECT_TIMEOUT=2 "$PSQL" -X -q -A -t -w -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" \
  -c 'SELECT 1' >/dev/null 2>"$LOGIN_ERR"; do
  if [ "$waited" -ge 30 ]; then
    echo 'migrate: could not log in to the embedded PostgreSQL as xiongbao within 30 seconds. The database said:' >&2
    cat "$LOGIN_ERR" >&2
    echo 'migrate: 数据库没有就绪，或者这个卷的超级用户与库还不叫 xiongbao（v0.2.16 之前建的卷，或 v0.2.16 首次启动没有做完改名）。这个版本只能从 v0.2.16 升级上来：先换回 v0.2.16 镜像启动一次，等它完成改名升级，再换成这个版本。不迁移、不启动（这一步没有改动任何数据）。' >&2
    rm -f "$LOGIN_ERR"
    exit 1
  fi
  waited=$((waited + 1))
  sleep 1
done
rm -f "$LOGIN_ERR"
echo 'migrate: embedded PostgreSQL is ready'
# This release is reached only from v0.2.16: a volume v0.2.16 began renaming and did not finish is refused
# here, before any migration, with the way out (upgrade-gate.sh). The migrator checks the database again,
# the way every deployment's does (server/src/db/upgrade-gate.ts), and takes a database v0.2.16 left
# behind onto the baseline the migration history was squashed into, after checking its structure
# (server/src/db/baseline-adoption.ts): a structure that differs stops the start with every difference
# printed, and nothing changes.
PGPASSWORD="$OWNER_PW" "$(dirname "$0")/upgrade-gate.sh" -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME"
# `scripts/migrate.ts`, not `drizzle-kit`. The CLI is a development dependency and needs esbuild to
# read its TypeScript config, which `bun install --production` leaves out of this image: asked to
# migrate here it exits 1 without printing why, and the container comes up against an empty database.
# The owner URL is scoped to migration; the API's connection strings are written at the end.
PGPASSWORD="$OWNER_PW" DATABASE_URL="postgres://$DB_USER:$OWNER_PW@127.0.0.1:5432/$DB_NAME" \
  s6-setuidgid apiuser /usr/local/bin/bun scripts/migrate.ts

APP_PW="$(cat /var/lib/postgresql/pgpassword-app)"
# Generated secrets are hex. Validate before placing one in a SQL literal.
case "$APP_PW" in ''|*[!0-9a-f]*) echo 'migrate: invalid app password file' >&2; exit 1 ;; esac
[ "${#APP_PW}" -eq 64 ] || { echo 'migrate: invalid app password length' >&2; exit 1; }
printf "ALTER ROLE xiongbao_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '%s';\n" "$APP_PW" | \
  PGPASSWORD="$OWNER_PW" s6-setuidgid apiuser /usr/lib/postgresql/16/bin/psql \
    -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 >/dev/null
echo 'migrate: xiongbao_app password installed; NOSUPERUSER NOBYPASSRLS'

WRITER_PW="$(cat /var/lib/postgresql/pgpassword-role-writer)"
case "$WRITER_PW" in ''|*[!0-9a-f]*) echo 'migrate: invalid role writer password file' >&2; exit 1 ;; esac
[ "${#WRITER_PW}" -eq 64 ] || { echo 'migrate: invalid role writer password length' >&2; exit 1; }
printf "ALTER ROLE xiongbao_role_writer WITH LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '%s';\n" "$WRITER_PW" | \
  PGPASSWORD="$OWNER_PW" s6-setuidgid apiuser /usr/lib/postgresql/16/bin/psql \
    -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 >/dev/null
echo 'migrate: xiongbao_role_writer password installed'
# The services' connection strings, replaced whole.
"$(dirname "$0")/database-urls.sh" "$DB_USER" "$DB_NAME"
