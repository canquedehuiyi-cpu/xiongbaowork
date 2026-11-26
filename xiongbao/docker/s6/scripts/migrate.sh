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
# authenticated query before running migrations. That query is also how this boot learns which names the
# superuser and the database carry: xiongbao on every volume v0.2.16 or later finished with, and the names
# before v0.2.16 on a new volume until its first boot renames them below (postgres-init.sh says why).
# rebrand-superuser.sh asks; the old names are only ever passed to it, as -U and -d.
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.18，until the migrations are squashed into a baseline
# that new volumes start from under the new names (R4 Task 26)
OWNER_PW="$(cat /var/lib/postgresql/pgpassword)"
SUPERUSER="$(dirname "$0")/rebrand-superuser.sh"
# Up to 30 seconds for a login; a refusal for a reason that waiting does not change (exit 3: both databases
# there, or neither) stops at once, and only that reason is printed.
rc=0
NAMES="$(PGPASSWORD="$OWNER_PW" PGCONNECT_TIMEOUT=2 "$SUPERUSER" names --wait 30 -h 127.0.0.1 -U openbot -d openbot)" || rc=$?
case $rc in
  0) ;;
  3) exit 1 ;;
  *) echo 'migrate: embedded PostgreSQL was not ready within 30 seconds' >&2; exit 1 ;;
esac
DB_USER="${NAMES% *}"
DB_NAME="${NAMES#* }"
echo 'migrate: embedded PostgreSQL is ready'
# This release is reached only from v0.2.16: a volume that has not been through v0.2.16's rename is
# refused here, before any migration, with the way out (upgrade-gate.sh says which volumes). The migrator
# checks the database again, the way every deployment's does (server/src/db/upgrade-gate.ts).
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
# Last, after every migration and before any service starts (no other session may be connected to a
# database being renamed): on a new volume's first boot the superuser and the database take the new name,
# in one transaction on the `postgres` database. Nothing to do on a volume already renamed, and nothing is
# printed then.
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.18，until the migrations are squashed into a baseline
# that new volumes start from under the new names (R4 Task 26)
PGPASSWORD="$OWNER_PW" "$SUPERUSER" rename -h 127.0.0.1 -U openbot -d openbot
# The services' connection strings, under the names the database answers to now, replaced whole.
NAMES="$(PGPASSWORD="$OWNER_PW" "$SUPERUSER" names -h 127.0.0.1 -U openbot -d openbot)"
"$(dirname "$0")/database-urls.sh" "${NAMES% *}" "${NAMES#* }"
