#!/bin/sh
# The rename of a new embedded database's superuser and database (rebrand-superuser.sh), the connection
# strings written after it (database-urls.sh), the check that refuses a volume v0.2.16 never upgraded
# (upgrade-gate.sh, and the migrator's own), and the order migrate.sh runs them in, against real PostgreSQL
# clusters this file creates with initdb and migrates with the server's own migrator, the way postgres-init
# and migrate.sh do.
#
#   CI, inside the delivery image (its PostgreSQL 16, its dash, its migrator under /app/server):
#     docker run --rm --user root --entrypoint /bin/sh -v "$PWD:/repo:ro" xiongbao:trackb \
#       /repo/docker/tests/rebrand-superuser.test.sh
#   On a machine with PostgreSQL 16, pgvector and bun:  sh docker/tests/rebrand-superuser.test.sh
#   (PG_BIN overrides /usr/lib/postgresql/16/bin; MIGRATOR_DIR the server directory to migrate with,
#   /app/server when it exists, else this checkout's server/. As root, the clusters run as postgres, which
#   must be able to reach TMPDIR.)
#
# Any failed assertion exits 1.
#
# The old superuser, database and role names below are the point of this file: a new volume carries them
# until the migrations are squashed into a new baseline (R4 Task 26), and the rename must turn exactly those
# into the new ones; a volume made by v0.2.15 carries them too, and must be refused untouched.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPTS=$HERE/../s6/scripts
SUPERUSER=$SCRIPTS/rebrand-superuser.sh
URLS=$SCRIPTS/database-urls.sh
GATE=$SCRIPTS/upgrade-gate.sh
PG_BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
if [ -z "${MIGRATOR_DIR:-}" ]; then
  if [ -f /app/server/scripts/migrate.ts ]; then MIGRATOR_DIR=/app/server; else MIGRATOR_DIR=$(cd "$HERE/../../server" && pwd); fi
fi
GATE_SQL_DIR=$MIGRATOR_DIR/recovery/recovery-20261018-v1/sql
T=$(mktemp -d)
chmod 755 "$T"
ALL=$T/all-output
: >"$ALL"
mkdir -p "$T/home"
rc=0
CLUSTERS=""

cleanup() {
  for d in $CLUSTERS; do as_pg "$PG_BIN/pg_ctl" -D "$d" -m immediate -w stop >/dev/null 2>&1 || true; done
  rm -rf "$T"
}
trap cleanup EXIT

FAILS=0
fail() { echo "FAIL: $1" >&2; rc=1; FAILS=$((FAILS + 1)); }
pass() { echo "ok - $1"; }
begin() { FAILS_AT=$FAILS; }
clean() { [ "$FAILS" -eq "$FAILS_AT" ]; }

for need in "$PG_BIN/initdb" "$MIGRATOR_DIR/scripts/migrate.ts"; do
  [ -e "$need" ] || { echo "FAIL: missing $need (set PG_BIN / MIGRATOR_DIR)" >&2; exit 1; }
done
command -v bun >/dev/null 2>&1 || { echo "FAIL: bun is not on PATH" >&2; exit 1; }

# PostgreSQL refuses to run as root: as root, everything that runs a cluster runs as postgres.
as_pg() {
  if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi
}
hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

# fresh_volume <name> [auth]: what postgres-init does on a new volume (generated passwords on the volume,
# initdb under the old superuser name with scram, createdb under the old database name, pgvector), on a
# free loopback port, left in $port. Not called in a subshell, so the cluster is registered for cleanup. $T/<name>/vol stands for /var/lib/postgresql, $T/<name>/env for
# s6's container environment, $T/<name>/state for the preflight's run directory.
fresh_volume() {
  d=$T/$1
  mkdir -p "$d/vol" "$d/env" "$d/state"
  for f in pgpassword pgpassword-app pgpassword-role-writer; do
    (umask 077 && hex >"$d/vol/$f")
  done
  cp "$d/vol/pgpassword" "$d/pwfile"
  if [ "$(id -u)" = 0 ]; then
    mkdir -p "$d/data"
    chown postgres:postgres "$d" "$d/data" "$d/pwfile"
  fi
  as_pg "$PG_BIN/initdb" -D "$d/data" -A "${2:-scram-sha-256}" -U openbot --pwfile="$d/pwfile" >"$d/initdb.log" 2>&1 ||
    { echo "initdb failed: $(tail -n 5 "$d/initdb.log")" >&2; return 1; }
  rm -f "$d/pwfile"
  CLUSTERS="$CLUSTERS $d/data"
  port=$((20000 + ($$ + ${#CLUSTERS}) % 20000))
  tries=0
  until as_pg "$PG_BIN/pg_ctl" -D "$d/data" -l "$d/server.log" -w -t 20 \
    -o "-c listen_addresses=127.0.0.1 -c port=$port -c unix_socket_directories=$d" start >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 20 ] || { echo "could not start $1: $(tail -n 5 "$d/server.log")" >&2; return 1; }
    port=$((port + 7))
  done
  PGPASSWORD=$(cat "$d/vol/pgpassword") "$PG_BIN/createdb" -w -h 127.0.0.1 -p "$port" -U openbot openbot || return 1
  sql "$1" "$port" openbot openbot 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null || return 1
}

pw_of() { cat "$T/$1/vol/$2"; }
# sql <volume> <port> <user> <db> <statement>: one statement, logged in with the volume's owner password.
sql() {
  PGPASSWORD=$(pw_of "$1" pgpassword) "$PG_BIN/psql" -X -q -A -t -w -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p "$2" -U "$3" -d "$4" -c "$5"
}
# logs_in <port> <user> <db> <password>
logs_in() {
  PGPASSWORD=$4 "$PG_BIN/psql" -X -q -A -t -w -h 127.0.0.1 -p "$1" -U "$2" -d "$3" -c 'SELECT 1' >/dev/null 2>&1
}
# The names the cluster carries: "<bootstrap superuser> | <databases>" (templates and postgres left out).
names_of() { # volume port user db
  sql "$1" "$2" "$3" "$4" "SELECT (SELECT rolname FROM pg_roles WHERE oid = 10) || ' | ' ||
    (SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1'));"
}
# The superuser's stored password verifier, as a checksum: compared, never printed.
verifier_of() { # volume port user db
  sql "$1" "$2" "$3" "$4" "SELECT rolpassword FROM pg_authid WHERE oid = 10;" | cksum
}
verifier_kind() { # volume port user db
  sql "$1" "$2" "$3" "$4" "SELECT split_part(rolpassword, '\$', 1) FROM pg_authid WHERE oid = 10;"
}
# Every row of the database, as pg_dump prints the data. Its comment lines name each table's owner, which
# the rename changes, so they are left out; so is the migration journal, which the v0.2.16 migrations
# (0240) add to, and each table's COPY line, whose column list grows when a migration adds a column.
# Further pg_dump options after the four.
data_print() { # volume port user db [pg_dump option...]
  d_vol=$1 d_port=$2 d_user=$3 d_db=$4
  shift 4
  PGPASSWORD=$(pw_of "$d_vol" pgpassword) "$PG_BIN/pg_dump" -w --data-only --exclude-schema=drizzle "$@" -h 127.0.0.1 -p "$d_port" -U "$d_user" -d "$d_db" 2>/dev/null |
    grep -v '^--\|^\\\(un\)\{0,1\}restrict \|^COPY ' | cksum
}
# A connection string the services read, aimed at the test cluster's port (the file says 5432).
url_at() { sed "s/@127\\.0\\.0\\.1:5432\\//@127.0.0.1:$2\\//" "$T/$1/env/$3"; }
# Old brand words in what a boot printed: the delivery image's startup log is scanned for them.
old_words() { grep -o -i 'openbot[a-z0-9_]*' "$@"; }


# The migrator, run as migrate.sh runs it (from the server directory, the owner URL in DATABASE_URL).
MIGRATE="cd \"\$1\" && exec bun scripts/migrate.ts"

# app_passwords <volume> <port> <superuser> <database>: migrate.sh's two ALTER ROLE … PASSWORD, through
# the superuser on the names it carries this boot. The migrations before it (0240) renamed the application
# roles; APP_ROLE / WRITER_ROLE give v0.2.15's names when a v0.2.15 volume is laid down.
app_passwords() {
  printf "ALTER ROLE %s WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '%s';\n" "${APP_ROLE:-xiongbao_app}" "$(pw_of "$1" pgpassword-app)" |
    PGPASSWORD=$(pw_of "$1" pgpassword) "$PG_BIN/psql" -X -q -w -h 127.0.0.1 -p "$2" -U "$3" -d "$4" -v ON_ERROR_STOP=1 >/dev/null &&
    printf "ALTER ROLE %s WITH LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '%s';\n" "${WRITER_ROLE:-xiongbao_role_writer}" "$(pw_of "$1" pgpassword-role-writer)" |
    PGPASSWORD=$(pw_of "$1" pgpassword) "$PG_BIN/psql" -X -q -w -h 127.0.0.1 -p "$2" -U "$3" -d "$4" -v ON_ERROR_STOP=1 >/dev/null
}


# boot <volume> <port>: what migrate.sh does once the database accepts connections, command for command
# and in its order (only the paths and the port differ): which names; the check that the volume may be
# migrated; the migrations; the application roles' passwords; the superuser and database rename; the names
# again and the connection strings. Stops at the first command that fails, as `set -e` does: $code is the
# exit code, $stopped names the command, the output is in $T/out and $T/err. KILLED_AFTER_MIGRATE=1 ends the
# boot right after the migrations, the way a container killed there (docker stop, OOM, a host reboot) ends it.
boot() {
  b_vol=$1 b_port=$2
  (
    set -e
    vol=$T/$b_vol/vol
    export UPGRADE_GATE_PG_BIN="$PG_BIN" UPGRADE_GATE_SQL_DIR="$GATE_SQL_DIR" UPGRADE_GATE_RECORD="$vol/backup/rebrand-in-progress" \
      REBRAND_PG_BIN="$PG_BIN" REBRAND_SUPERUSER_HINT="$vol/superuser-renamed" DATABASE_URLS_DIR="$T/$b_vol/env" \
      DATABASE_SECRETS_DIR="$vol" HOME="$T/home"
    OWNER_PW=$(cat "$vol/pgpassword")
    at() { echo "$1" >"$T/stage"; }
    at names
    NAMES=$(PGPASSWORD=$OWNER_PW sh "$SUPERUSER" names --wait 5 -h 127.0.0.1 -p "$b_port" -U openbot -d openbot)
    DB_USER=${NAMES% *} DB_NAME=${NAMES#* }
    at gate
    PGPASSWORD=$OWNER_PW sh "$GATE" -h 127.0.0.1 -p "$b_port" -U "$DB_USER" -d "$DB_NAME"
    at migrate
    PGPASSWORD=$OWNER_PW DATABASE_URL="postgres://$DB_USER:$OWNER_PW@127.0.0.1:$b_port/$DB_NAME" \
      sh -c "$MIGRATE" migrate "$MIGRATOR_DIR"
    if [ "${KILLED_AFTER_MIGRATE:-}" = 1 ]; then at killed; exit 137; fi
    at passwords
    app_passwords "$b_vol" "$b_port" "$DB_USER" "$DB_NAME"
    at rename
    PGPASSWORD=$OWNER_PW sh "$SUPERUSER" rename -h 127.0.0.1 -p "$b_port" -U openbot -d openbot
    at urls
    NAMES=$(PGPASSWORD=$OWNER_PW sh "$SUPERUSER" names -h 127.0.0.1 -p "$b_port" -U openbot -d openbot)
    sh "$URLS" "${NAMES% *}" "${NAMES#* }"
    at done
  ) >"$T/out" 2>"$T/err" </dev/null
  code=$?
  stopped=$(cat "$T/stage")
  cat "$T/out" "$T/err" >>"$ALL"
}

# Calls of rebrand-superuser.sh on their own.
superuser() { # volume port names|rename [VAR=value...]
  s_vol=$1 s_port=$2 s_cmd=$3
  shift 3
  env PGPASSWORD="$(pw_of "$s_vol" pgpassword)" REBRAND_PG_BIN="$PG_BIN" REBRAND_SUPERUSER_HINT="$T/$s_vol/vol/superuser-renamed" "$@" \
    sh "$SUPERUSER" "$s_cmd" -h 127.0.0.1 -p "$s_port" -U openbot -d openbot >"$T/out" 2>"$T/err" </dev/null
  code=$?
  cat "$T/out" "$T/err" >>"$ALL"
}

# 1. fresh volume ends with the new names after migrations: the first boot migrates under the names initdb
#    gave it (0054 grants default privileges FOR ROLE the old superuser, so the migrations need it), then
#    renames, and the services' connection strings name the new superuser and database.
fresh_volume fresh || exit 1
F=$port
boot fresh "$F"
what="fresh volume ends with the new names after migrations"
begin
if [ "$code" -ne 0 ]; then fail "$what: stopped at $stopped (exit $code): $(cat "$T/out" "$T/err")"
else
  F_PW=$(pw_of fresh pgpassword)
  [ "$(names_of fresh "$F" xiongbao xiongbao)" = "xiongbao | xiongbao" ] || fail "$what: names are $(names_of fresh "$F" xiongbao xiongbao)"
  [ "$(sql fresh "$F" xiongbao xiongbao "SELECT count(*) FROM pg_roles WHERE rolname IN ('openbot', 'xiongbao_renaming');")" = 0 ] ||
    fail "$what: the old superuser or the temporary role is still there"
  [ "$(sql fresh "$F" xiongbao xiongbao "SELECT count(*) > 10 FROM drizzle.__drizzle_migrations;")" = t ] || fail "$what: migrations did not run"
  # 0054's default privileges belonged to the old name; they follow the role, not the name.
  [ "$(sql fresh "$F" xiongbao xiongbao "SELECT count(*) > 0 AND bool_and(pg_get_userbyid(defaclrole) = 'xiongbao') FROM pg_default_acl;")" = t ] ||
    fail "$what: default privileges do not belong to the renamed superuser"
  [ "$(cat "$T/fresh/env/MIGRATION_DATABASE_URL")" = "postgres://xiongbao:$F_PW@127.0.0.1:5432/xiongbao" ] ||
    fail "$what: MIGRATION_DATABASE_URL does not name the new superuser and database"
  [ "$(PGPASSWORD='' "$PG_BIN/psql" -X -q -A -t -w "$(url_at fresh "$F" DATABASE_URL)" -c "SELECT current_user || ' ' || current_database() || ' ' || rolsuper FROM pg_roles WHERE rolname = current_user;" 2>&1)" = "xiongbao_app xiongbao false" ] ||
    fail "$what: DATABASE_URL does not log the app role in to the renamed database"
  [ "$(PGPASSWORD='' "$PG_BIN/psql" -X -q -A -t -w "$(url_at fresh "$F" ROLE_WRITER_DATABASE_URL)" -c "SELECT current_user || ' ' || current_database();" 2>&1)" = "xiongbao_role_writer xiongbao" ] ||
    fail "$what: ROLE_WRITER_DATABASE_URL does not log the role writer in to the renamed database"
  for f in MIGRATION_DATABASE_URL DATABASE_URL ROLE_WRITER_DATABASE_URL; do
    [ "$(stat -c %a "$T/fresh/env/$f")" = 600 ] || fail "$what: $f mode $(stat -c %a "$T/fresh/env/$f")"
  done
  [ "$(ls -A "$T/fresh/env" | tr '\n' ' ')" = "DATABASE_URL MIGRATION_DATABASE_URL ROLE_WRITER_DATABASE_URL " ] ||
    fail "$what: unexpected files in the container environment: $(ls -A "$T/fresh/env")"
  [ -f "$T/fresh/vol/superuser-renamed" ] || fail "$what: the rename was not recorded on the volume"
  grep -q "已改名为 xiongbao" "$T/out" || fail "$what: the rename is not in the log: $(cat "$T/out")"
  [ -z "$(old_words "$T/out" "$T/err")" ] || fail "$what: the log carries old names: $(old_words "$T/out" "$T/err" | sort -u | tr '\n' ' ')"
  # Which name to try first comes from the volume, so the boot leaves no failed login in the server log.
  [ "$(grep -c 'authentication failed' "$T/fresh/server.log")" = 0 ] || fail "$what: the boot left failed logins in the server log"
  logs_in "$F" openbot postgres "$F_PW" && fail "$what: the old superuser name still logs in"
fi
clean && pass "$what"


# A volume made by v0.2.15: the same postgres-init (since v0.2.0: initdb -A scram-sha-256 under the old
# superuser, createdb under the old database name), migrated, the application roles' passwords set as
# v0.2.15's migrate.sh sets them, and a person's data on top.
# The migrations through 0239 are byte for byte the ones v0.2.15 shipped (server/drizzle and the recovery
# overlay only grew since that tag), so the schema is v0.2.15's too: the migrator stops there for tests
# (XIONGBAO_TEST_MIGRATE_THROUGH, honoured only with NODE_ENV=test), before 0240 renames anything.
v0215_volume() { # name; leaves the port in $port
  fresh_volume "$1" || return 1
  PGPASSWORD=$(pw_of "$1" pgpassword) DATABASE_URL="postgres://openbot:$(pw_of "$1" pgpassword)@127.0.0.1:$port/openbot" HOME="$T/home" \
    NODE_ENV=test XIONGBAO_TEST_MIGRATE_THROUGH=0239_aihub_provider_template \
    sh -c "$MIGRATE" migrate "$MIGRATOR_DIR" >"$T/out" 2>&1 || { echo "migrating the v0.2.15 volume failed: $(tail -n 20 "$T/out")" >&2; return 1; }
  [ "$(sql "$1" "$port" openbot openbot "SELECT count(*) FROM pg_roles WHERE rolname IN ('openbot_app', 'openbot_role_writer');")" = 2 ] ||
    { echo "the v0.2.15 volume does not carry v0.2.15's application roles" >&2; return 1; }
  APP_ROLE=openbot_app WRITER_ROLE=openbot_role_writer app_passwords "$1" "$port" openbot openbot || return 1
  sql "$1" "$port" openbot openbot "CREATE TABLE public.upgrade_probe (id serial PRIMARY KEY, body text NOT NULL);
    INSERT INTO public.upgrade_probe (body) SELECT 'row ' || g FROM generate_series(1, 200) g;
    GRANT SELECT ON public.upgrade_probe TO openbot_app;" || return 1
}

# 2. a volume v0.2.15 made is refused before anything changes: this release is reached only from v0.2.16,
#    which is the release that renames such a volume. The boot stops at the check, says to upgrade to v0.2.16
#    first, and leaves the names, the journal, the data, the password verifier and the container environment
#    exactly as they were. Asked directly (as an external database's deployment asks it), the migrator
#    refuses the same database the same way.
v0215_volume v0215 || exit 1
V=$port
V_PW=$(pw_of v0215 pgpassword)
V_VERIFIER=$(verifier_of v0215 "$V" openbot openbot)
V_DATA=$(data_print v0215 "$V" openbot openbot)
V_JOURNAL=$(sql v0215 "$V" openbot openbot "SELECT count(*) FROM drizzle.__drizzle_migrations;")
boot v0215 "$V"
what="a volume v0.2.15 made is refused before anything changes"
begin
if [ "$code" -eq 0 ] || [ "$stopped" != gate ]; then fail "$what: stopped at $stopped (exit $code): $(cat "$T/out" "$T/err")"
else
  grep -q "请先升级到 v0.2.16" "$T/err" || fail "$what: does not say to upgrade to v0.2.16 first: $(cat "$T/err")"
  grep -q "没有改动任何数据" "$T/err" || fail "$what: does not say nothing changed: $(cat "$T/err")"
  [ "$(names_of v0215 "$V" openbot openbot)" = "openbot | openbot" ] || fail "$what: names are now $(names_of v0215 "$V" openbot openbot)"
  [ "$(sql v0215 "$V" openbot openbot "SELECT count(*) FROM drizzle.__drizzle_migrations;")" = "$V_JOURNAL" ] || fail "$what: the journal changed"
  [ "$(data_print v0215 "$V" openbot openbot)" = "$V_DATA" ] || fail "$what: the data changed"
  [ "$(verifier_of v0215 "$V" openbot openbot)" = "$V_VERIFIER" ] || fail "$what: the password verifier changed"
  [ "$(sql v0215 "$V" openbot openbot "SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE '%\_app' OR rolname LIKE '%\_role\_writer';")" = "openbot_app,openbot_role_writer" ] ||
    fail "$what: the application roles were renamed"
  [ -z "$(ls -A "$T/v0215/env")" ] || fail "$what: connection strings were written: $(ls -A "$T/v0215/env")"
  [ ! -e "$T/v0215/vol/superuser-renamed" ] || fail "$what: the volume says renamed"
  logs_in "$V" openbot openbot "$V_PW" || fail "$what: the old names no longer log in"
fi
PGPASSWORD=$V_PW DATABASE_URL="postgres://openbot:$V_PW@127.0.0.1:$V/openbot" HOME="$T/home" \
  sh -c "$MIGRATE" migrate "$MIGRATOR_DIR" >"$T/out" 2>"$T/err" </dev/null
m_code=$?
cat "$T/out" "$T/err" >>"$ALL"
if [ "$m_code" -eq 0 ]; then fail "$what: the migrator migrated it when asked directly"
else
  grep -q "0240_rebrand_names、0241_rebrand_history" "$T/err" && grep -q "openbot_app、openbot_role_writer" "$T/err" &&
    grep -q "请先升级到 v0.2.16" "$T/err" || fail "$what: the migrator's refusal does not say why: $(cat "$T/err")"
  [ "$(sql v0215 "$V" openbot openbot "SELECT count(*) FROM drizzle.__drizzle_migrations;")" = "$V_JOURNAL" ] ||
    fail "$what: the migrator changed the journal"
  [ "$(data_print v0215 "$V" openbot openbot)" = "$V_DATA" ] || fail "$what: the migrator changed the data"
fi
clean && pass "$what"

# 3. a first boot killed after its migrations, before the rename: the next boot finds the journal holding
#    the rename migrations under the old names, lets it through, and finishes the rename with connection
#    strings that name the new superuser and database.
fresh_volume killed || exit 1
K=$port
K_PW=$(pw_of killed pgpassword)
KILLED_AFTER_MIGRATE=1 boot killed "$K"
what="a first boot killed after its migrations finishes the rename on the next"
begin
if [ "$stopped" != killed ]; then fail "$what: the first boot stopped at $stopped (exit $code): $(cat "$T/out" "$T/err")"
else
  [ "$(names_of killed "$K" openbot openbot)" = "openbot | openbot" ] || fail "$what: renamed before the kill"
  boot killed "$K"
  if [ "$code" -ne 0 ]; then fail "$what: the next boot stopped at $stopped (exit $code): $(cat "$T/out" "$T/err")"
  else
    [ "$(names_of killed "$K" xiongbao xiongbao)" = "xiongbao | xiongbao" ] || fail "$what: names are $(names_of killed "$K" xiongbao xiongbao)"
    [ "$(cat "$T/killed/env/MIGRATION_DATABASE_URL")" = "postgres://xiongbao:$K_PW@127.0.0.1:5432/xiongbao" ] ||
      fail "$what: MIGRATION_DATABASE_URL does not name the new superuser and database"
    [ "$(PGPASSWORD='' "$PG_BIN/psql" -X -q -A -t -w "$(url_at killed "$K" DATABASE_URL)" -c "SELECT current_user || ' ' || current_database();" 2>&1)" = "xiongbao_app xiongbao" ] ||
      fail "$what: DATABASE_URL does not log the app role in to the renamed database"
  fi
fi
clean && pass "$what"

# 4. second start after rename is a no-op: the rename has nothing left to do and says nothing, the names,
#    the password verifier and the connection strings stay byte for byte. Then the whole boot again: the
#    check lets a renamed volume through without a word, and the migrations find nothing to apply.
F_VERIFIER=$(verifier_of fresh "$F" xiongbao xiongbao)
urls_print=$(cat "$T/fresh/env/MIGRATION_DATABASE_URL" "$T/fresh/env/DATABASE_URL" "$T/fresh/env/ROLE_WRITER_DATABASE_URL" | cksum)
failed_logins=$(grep -c 'authentication failed' "$T/fresh/server.log")
superuser fresh "$F" rename
what="second start after rename is a no-op"
begin
[ "$code" -eq 0 ] && [ ! -s "$T/out" ] && [ ! -s "$T/err" ] || fail "$what: the rename again: exit $code: $(cat "$T/out" "$T/err")"
journal_before=$(sql fresh "$F" xiongbao xiongbao "SELECT count(*) FROM drizzle.__drizzle_migrations;")
data_before=$(data_print fresh "$F" xiongbao xiongbao)
boot fresh "$F"
if [ "$code" -ne 0 ]; then fail "$what: stopped at $stopped (exit $code): $(cat "$T/out" "$T/err")"
else
  grep -q 'upgrade-gate\|rebrand-' "$T/out" "$T/err" && fail "$what: printed: $(grep 'upgrade-gate\|rebrand-' "$T/out" "$T/err")"
  [ "$(names_of fresh "$F" xiongbao xiongbao)" = "xiongbao | xiongbao" ] || fail "$what: names are $(names_of fresh "$F" xiongbao xiongbao)"
  [ "$(verifier_of fresh "$F" xiongbao xiongbao)" = "$F_VERIFIER" ] || fail "$what: the password verifier changed"
  [ "$(cat "$T/fresh/env/MIGRATION_DATABASE_URL" "$T/fresh/env/DATABASE_URL" "$T/fresh/env/ROLE_WRITER_DATABASE_URL" | cksum)" = "$urls_print" ] ||
    fail "$what: the connection strings changed"
  [ "$(grep -c 'authentication failed' "$T/fresh/server.log")" = "$failed_logins" ] || fail "$what: the boot left failed logins in the server log"
  [ "$(sql fresh "$F" xiongbao xiongbao "SELECT count(*) FROM drizzle.__drizzle_migrations;")" = "$journal_before" ] ||
    fail "$what: the second boot applied migrations"
  [ "$(data_print fresh "$F" xiongbao xiongbao)" = "$data_before" ] || fail "$what: the second boot changed data"
  [ "$(sql fresh "$F" xiongbao xiongbao "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'openbot%';")" = 0 ] ||
    fail "$what: a role still carries an old name"
fi
clean && pass "$what"

# 5. the hint on the volume only decides which name is tried first: without it a renamed cluster is still
#    found (one failed login), and the next rename puts it back.
rm -f "$T/fresh/vol/superuser-renamed"
superuser fresh "$F" names
[ "$code" -eq 0 ] && [ "$(cat "$T/out")" = "xiongbao xiongbao" ] && pass "a renamed cluster is found without the hint" ||
  fail "a renamed cluster is found without the hint: exit $code: $(cat "$T/out" "$T/err")"
superuser fresh "$F" rename
[ "$code" -eq 0 ] && [ -f "$T/fresh/vol/superuser-renamed" ] && [ ! -L "$T/fresh/vol/superuser-renamed" ] &&
  pass "the rename on a renamed cluster records the hint again" || fail "the rename records the hint again: exit $code: $(cat "$T/err")"

# A cluster whose superuser password is stored as an MD5 hash (possible only with an md5 line in
# pg_hba.conf, which v0.2.15 never writes): PostgreSQL clears MD5 hashes on a rename, because the hash
# involves the role name.
fresh_volume md5 md5 || exit 1
M=$port
M_PW=$(pw_of md5 pgpassword)
printf "SET password_encryption = 'md5';\nALTER ROLE openbot PASSWORD '%s';\n" "$M_PW" |
  PGPASSWORD=$M_PW "$PG_BIN/psql" -X -q -w -h 127.0.0.1 -p "$M" -U openbot -d postgres -v ON_ERROR_STOP=1 >/dev/null || exit 1
[ "$(verifier_kind md5 "$M" openbot postgres | cut -c1-3)" = md5 ] || fail "the md5 cluster stores an md5 hash"

# 6. the hint before a rename is harmless: tried first, the new name fails and the old one answers.
: >"$T/md5/vol/superuser-renamed"
superuser md5 "$M" names
[ "$code" -eq 0 ] && [ "$(cat "$T/out")" = "openbot openbot" ] && pass "a stale hint falls back to the old names" ||
  fail "a stale hint falls back to the old names: exit $code: $(cat "$T/out" "$T/err")"
rm -f "$T/md5/vol/superuser-renamed"

# 7. a role that already has the new name and is not the bootstrap superuser: the rename cannot happen,
#    so it refuses before changing anything.
sql md5 "$M" openbot postgres "CREATE ROLE xiongbao NOLOGIN;"
superuser md5 "$M" rename
[ "$code" -ne 0 ] && grep -q "不是集群的引导超级用户" "$T/err" && [ "$(names_of md5 "$M" openbot openbot)" = "openbot | openbot" ] &&
  pass "a stray role with the new name refuses before anything changes" ||
  fail "a stray role with the new name refuses: exit $code: $(cat "$T/err")"
sql md5 "$M" openbot postgres "DROP ROLE xiongbao;"

# 7b. a leftover of the temporary role the rename uses (the transaction never commits one, so only a
#     hand-made one exists): one that can log in, holds a privilege or belongs to anything is refused by
#     name before anything changes; a bare NOLOGIN one is dropped and the rename goes on (case 8 below).
sql md5 "$M" openbot postgres "CREATE ROLE xiongbao_renaming NOLOGIN; GRANT CONNECT ON DATABASE postgres TO xiongbao_renaming;"
superuser md5 "$M" rename
what="a leftover temporary role that holds anything is refused by name"
if [ "$code" -ne 3 ]; then fail "$what: exit $code: $(cat "$T/err")"
elif ! grep -q "xiongbao_renaming" "$T/err"; then fail "$what: the role is not named: $(cat "$T/err")"
elif grep -q "别的连接" "$T/err"; then fail "$what: blamed on other connections: $(cat "$T/err")"
elif [ "$(names_of md5 "$M" openbot openbot)" != "openbot | openbot" ]; then fail "$what: names changed"
else pass "$what"; fi
sql md5 "$M" openbot postgres "REVOKE CONNECT ON DATABASE postgres FROM xiongbao_renaming; ALTER ROLE xiongbao_renaming LOGIN;"
superuser md5 "$M" rename
[ "$code" -eq 3 ] && grep -q "xiongbao_renaming" "$T/err" && [ "$(names_of md5 "$M" openbot openbot)" = "openbot | openbot" ] &&
  pass "a leftover temporary role that can log in is refused by name" ||
  fail "a leftover temporary role that can log in is refused: exit $code: $(cat "$T/err")"
sql md5 "$M" openbot postgres "ALTER ROLE xiongbao_renaming NOLOGIN;"

# 8. an MD5-hashed password still works after the rename: replaced in the same transaction by a SCRAM
#    verifier of the same password.
superuser md5 "$M" rename
what="an md5 password still logs in after the rename, now as scram"
if [ "$code" -ne 0 ]; then fail "$what: exit $code: $(cat "$T/err")"
elif ! logs_in "$M" xiongbao xiongbao "$M_PW"; then fail "$what: the password does not log in under the new names"
elif [ "$(verifier_kind md5 "$M" xiongbao xiongbao)" != SCRAM-SHA-256 ]; then fail "$what: stored as $(verifier_kind md5 "$M" xiongbao xiongbao | cut -c1-3)"
elif [ "$(sql md5 "$M" xiongbao xiongbao "SELECT count(*) FROM pg_roles WHERE rolname = 'xiongbao_renaming';")" != 0 ]; then fail "$what: the bare leftover role was not dropped"
else pass "$what"; fi

# 8b. a cluster with one name new and the other old (the rename does both in one transaction, so only a
#     hand-made change gets here): the names say exactly that, and the rename finishes the other one.
sql md5 "$M" xiongbao postgres "ALTER DATABASE xiongbao RENAME TO openbot;"
superuser md5 "$M" names
n_out=$(cat "$T/out")
superuser md5 "$M" rename
[ "$n_out" = "xiongbao openbot" ] && [ "$code" -eq 0 ] && [ "$(names_of md5 "$M" xiongbao xiongbao)" = "xiongbao | xiongbao" ] &&
  pass "a renamed superuser with the old database gets the database renamed" ||
  fail "a renamed superuser with the old database gets the database renamed: names '$n_out', exit $code: $(cat "$T/err")"
PGPASSWORD=$M_PW "$PG_BIN/psql" -X -q -w -h 127.0.0.1 -p "$M" -U xiongbao -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE undo_rename SUPERUSER NOLOGIN" -c "SET SESSION AUTHORIZATION undo_rename" \
  -c "ALTER ROLE xiongbao RENAME TO openbot" -c "RESET SESSION AUTHORIZATION" -c "DROP ROLE undo_rename" >/dev/null 2>&1 || exit 1
rm -f "$T/md5/vol/superuser-renamed"
superuser md5 "$M" names
n_out=$(cat "$T/out")
superuser md5 "$M" rename
[ "$n_out" = "openbot xiongbao" ] && [ "$code" -eq 0 ] && [ "$(names_of md5 "$M" xiongbao xiongbao)" = "xiongbao | xiongbao" ] &&
  logs_in "$M" xiongbao xiongbao "$M_PW" && pass "a renamed database with the old superuser gets the superuser renamed" ||
  fail "a renamed database with the old superuser gets the superuser renamed: names '$n_out', exit $code: $(cat "$T/err")"

# 9. both databases at once: nothing can tell which one holds the data, so the names are not guessed and
#    nothing is renamed.
sql md5 "$M" xiongbao postgres "CREATE DATABASE openbot;"
before=$(names_of md5 "$M" xiongbao xiongbao)
superuser md5 "$M" names
n_code=$code
superuser md5 "$M" rename
[ "$n_code" -ne 0 ] && [ "$code" -ne 0 ] && grep -q "同时存在" "$T/err" && [ "$(names_of md5 "$M" xiongbao xiongbao)" = "$before" ] &&
  pass "two candidate databases are refused, not guessed" || fail "two candidate databases are refused: exit $n_code/$code: $(cat "$T/err")"
# 9b. with --wait (migrate.sh's readiness wait), a refusal like that one is final: it returns at once with
#     its own exit code and reason, not after the wait as if the database were not up. A login that keeps
#     failing is waited for, then said so.
started=$(date +%s)
env PGPASSWORD="$M_PW" REBRAND_PG_BIN="$PG_BIN" REBRAND_SUPERUSER_HINT="$T/md5/vol/superuser-renamed" \
  sh "$SUPERUSER" names --wait 10 -h 127.0.0.1 -p "$M" -U openbot -d openbot >"$T/out" 2>"$T/err" </dev/null
code=$?
took=$(($(date +%s) - started))
cat "$T/out" "$T/err" >>"$ALL"
[ "$code" -eq 3 ] && [ "$took" -lt 5 ] && grep -q "同时存在" "$T/err" && ! grep -q "等了" "$T/err" &&
  pass "a refusal under --wait returns at once with its own reason" ||
  fail "a refusal under --wait returns at once: exit $code after ${took}s: $(cat "$T/err")"
sql md5 "$M" xiongbao postgres "DROP DATABASE openbot;"
started=$(date +%s)
env PGPASSWORD=wrong-password REBRAND_PG_BIN="$PG_BIN" REBRAND_SUPERUSER_HINT="$T/md5/vol/superuser-renamed" \
  sh "$SUPERUSER" names --wait 2 -h 127.0.0.1 -p "$M" -U openbot -d openbot >"$T/out" 2>"$T/err" </dev/null
code=$?
took=$(($(date +%s) - started))
cat "$T/out" "$T/err" >>"$ALL"
[ "$code" -eq 1 ] && [ "$took" -ge 2 ] && grep -q "等了 2 秒" "$T/err" &&
  pass "a login that keeps failing is waited for, then reported" ||
  fail "a login that keeps failing is waited for: exit $code after ${took}s: $(cat "$T/err")"

# 10. the connection strings: an explicit DATABASE_URL or ROLE_WRITER_DATABASE_URL is left as the deployment
#     wrote it; each file is replaced by a rename (a new inode), never rewritten in place; a password file
#     that is not a generated password is refused and named, its value never printed.
mkdir -p "$T/urls/env" "$T/urls/vol"
cp "$T/fresh/vol/pgpassword" "$T/fresh/vol/pgpassword-app" "$T/fresh/vol/pgpassword-role-writer" "$T/urls/vol/"
printf 'explicit' >"$T/urls/env/DATABASE_URL"
printf 'explicit' >"$T/urls/env/ROLE_WRITER_DATABASE_URL"
printf 'old' >"$T/urls/env/MIGRATION_DATABASE_URL"
inode=$(stat -c %i "$T/urls/env/MIGRATION_DATABASE_URL")
env DATABASE_URLS_DIR="$T/urls/env" DATABASE_SECRETS_DIR="$T/urls/vol" DATABASE_URL=explicit ROLE_WRITER_DATABASE_URL=explicit \
  sh "$URLS" xiongbao xiongbao >"$T/out" 2>"$T/err"
code=$?
cat "$T/out" "$T/err" >>"$ALL"
what="explicit connection strings are kept and the owner's is replaced whole"
if [ "$code" -ne 0 ]; then fail "$what: exit $code: $(cat "$T/err")"
elif [ "$(cat "$T/urls/env/DATABASE_URL")" != explicit ] || [ "$(cat "$T/urls/env/ROLE_WRITER_DATABASE_URL")" != explicit ]; then fail "$what: an explicit string was replaced"
elif [ "$(cat "$T/urls/env/MIGRATION_DATABASE_URL")" != "postgres://xiongbao:$(pw_of fresh pgpassword)@127.0.0.1:5432/xiongbao" ]; then fail "$what: owner string not written"
elif [ "$(stat -c %i "$T/urls/env/MIGRATION_DATABASE_URL")" = "$inode" ]; then fail "$what: rewritten in place"
elif [ -s "$T/out" ] || [ -s "$T/err" ]; then fail "$what: printed something"
elif [ "$(ls -A "$T/urls/env" | wc -l)" -ne 3 ]; then fail "$what: leftovers: $(ls -A "$T/urls/env")"
else pass "$what"; fi
printf 'not-hex!' >"$T/urls/vol/pgpassword-app"
rm -f "$T/urls/env/DATABASE_URL"
env DATABASE_URLS_DIR="$T/urls/env" DATABASE_SECRETS_DIR="$T/urls/vol" sh "$URLS" xiongbao xiongbao >"$T/out" 2>"$T/err"
code=$?
cat "$T/out" "$T/err" >>"$ALL"
[ "$code" -ne 0 ] && grep -q "pgpassword-app" "$T/err" && ! grep -q "not-hex" "$T/err" && [ ! -e "$T/urls/env/DATABASE_URL" ] &&
  [ -z "$(ls -A "$T/urls/env" | grep '^\.')" ] && pass "a password file that is not a generated password is refused" ||
  fail "a password file that is not a generated password is refused: exit $code: $(cat "$T/err")"
# One hex digit short of a generated password is refused too.
cp "$T/fresh/vol/pgpassword-app" "$T/urls/vol/pgpassword-app"
cut -c2- "$T/fresh/vol/pgpassword-role-writer" | tr -d '\n' >"$T/urls/vol/pgpassword-role-writer"
env DATABASE_URLS_DIR="$T/urls/env" DATABASE_SECRETS_DIR="$T/urls/vol" sh "$URLS" xiongbao xiongbao >"$T/out" 2>"$T/err"
code=$?
cat "$T/out" "$T/err" >>"$ALL"
[ "$code" -ne 0 ] && grep -q "pgpassword-role-writer" "$T/err" && pass "a password of the wrong length is refused" ||
  fail "a password of the wrong length is refused: exit $code: $(cat "$T/err")"
cp "$T/fresh/vol/pgpassword-role-writer" "$T/urls/vol/pgpassword-role-writer"
# A rename that fails leaves no temporary file behind (it holds a password).
mkdir -p "$T/failmv"
printf '#!/bin/sh\nexit 1\n' >"$T/failmv/mv"
chmod 755 "$T/failmv/mv"
env PATH="$T/failmv:$PATH" DATABASE_URLS_DIR="$T/urls/env" DATABASE_SECRETS_DIR="$T/urls/vol" sh "$URLS" xiongbao xiongbao >"$T/out" 2>"$T/err"
code=$?
cat "$T/out" "$T/err" >>"$ALL"
[ "$code" -ne 0 ] && [ -z "$(ls -A "$T/urls/env" | grep '^\.')" ] && pass "a failed rename leaves no temporary file with a password" ||
  fail "a failed rename leaves no temporary file: exit $code: $(ls -A "$T/urls/env")"

# 11. nothing above printed a password.
leaked=0
for v in fresh v0215 killed md5; do
  for f in pgpassword pgpassword-app pgpassword-role-writer; do
    grep -qF "$(pw_of "$v" "$f")" "$ALL" && leaked=1
  done
done
[ "$leaked" -eq 0 ] && pass "no output carries a password" || fail "a password was printed"

exit "$rc"
