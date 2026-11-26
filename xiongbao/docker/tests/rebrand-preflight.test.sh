#!/bin/sh
# rebrand-preflight.sh (and the read-only pre-upgrade-check.sh) against real PostgreSQL clusters that
# this file creates with initdb, so the queries, pg_dump and pg_restore are the real ones.
#
#   CI, inside the delivery image (same PostgreSQL 16 and dash the container runs):
#     docker run --rm --user root --entrypoint /bin/sh -v "$PWD:/repo:ro" xiongbao:trackb \
#       /repo/docker/tests/rebrand-preflight.test.sh
#   On a machine with PostgreSQL 16, pgvector and bun:  sh docker/tests/rebrand-preflight.test.sh
#   (PG_BIN overrides /usr/lib/postgresql/16/bin; MIGRATOR_DIR the server directory whose migrator builds
#   the databases the restore is tested on, /app/server when it exists, else this checkout's server/. As
#   root, the clusters run as the postgres user, which must be able to reach TMPDIR.)
#
# Any failed assertion exits 1. Nothing here needs a full disk: the space cases put a stand-in `df`
# first on PATH, the way production reads free space.
#
# The old superuser and role names below are the point of this file: a volume made by v0.2.15 carries
# them, and the preflight must recognise it.
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PREFLIGHT=$HERE/../s6/scripts/rebrand-preflight.sh
PRECHECK=$HERE/../../scripts/rebrand/pre-upgrade-check.sh
PG_BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
# The restore is tested against databases the server's own migrator built (the image's under /app/server,
# else this checkout's server/), because what matters there is what the migrations leave behind.
if [ -z "${MIGRATOR_DIR:-}" ]; then
  if [ -f /app/server/scripts/migrate.ts ]; then MIGRATOR_DIR=/app/server; else MIGRATOR_DIR=$(cd "$HERE/../../server" && pwd); fi
fi
PW=pw-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
T=$(mktemp -d)
chmod 755 "$T"
ALL=$T/all-output
: >"$ALL"
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
# A case of several assertions passes when none of them failed since `begin`.
begin() { FAILS_AT=$FAILS; }
clean() { [ "$FAILS" -eq "$FAILS_AT" ]; }

if [ ! -x "$PG_BIN/initdb" ]; then
  echo "FAIL: no PostgreSQL at $PG_BIN (set PG_BIN)" >&2
  exit 1
fi
[ -f "$MIGRATOR_DIR/scripts/migrate.ts" ] || { echo "FAIL: no migrator at $MIGRATOR_DIR (set MIGRATOR_DIR)" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "FAIL: bun is not on PATH" >&2; exit 1; }
mkdir -p "$T/home"

# PostgreSQL refuses to run as root: as root, everything that touches a cluster runs as postgres.
as_pg() {
  if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

# start_cluster <name> <superuser>: initdb + start on a free loopback port; prints the port. Called in a
# command substitution, so the caller adds $T/<name>/data to CLUSTERS for cleanup.
start_cluster() {
  d=$T/$1
  mkdir -p "$d"
  printf %s "$PW" >"$d/pw"
  [ "$(id -u)" = 0 ] && chown -R postgres:postgres "$d"
  as_pg "$PG_BIN/initdb" -D "$d/data" -A scram-sha-256 -U "$2" --pwfile="$d/pw" >"$d/initdb.log" 2>&1 ||
    { echo "initdb failed: $(tail -n 5 "$d/initdb.log")" >&2; return 1; }
  CLUSTERS="$CLUSTERS $d/data"
  port=$((20000 + $$ % 20000))
  tries=0
  until as_pg "$PG_BIN/pg_ctl" -D "$d/data" -l "$d/server.log" -w -t 20 \
    -o "-c listen_addresses=127.0.0.1 -c port=$port -c unix_socket_directories=$d" start >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 20 ] || { echo "could not start $1: $(tail -n 5 "$d/server.log")" >&2; return 1; }
    port=$((port + 7))
  done
  echo "$port"
}

# sql <port> <user> <db> <statement>: one statement as the cluster's superuser.
sql() {
  PGPASSWORD=$PW "$PG_BIN/psql" -X -q -A -t -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$1" -U "$2" -d "$3" -c "$4"
}

# What a migrated volume looks like where it matters here: the tables the in-flight check reads, the
# migration journal that marks a database as migrated, pgvector, a table that migrations seed with a
# default row (restoring over it is where a plain pg_restore loses data), a grant and a row-security
# policy naming the app role (restoring needs that role), and some business rows.
seed() { # port superuser db app-role
  sql "$1" "$2" "$3" "CREATE EXTENSION IF NOT EXISTS vector;
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('h1', 1);
    CREATE TABLE approval_requests (id serial PRIMARY KEY, status text NOT NULL DEFAULT 'pending');
    CREATE TABLE approval_continuations (id serial PRIMARY KEY, state text NOT NULL);
    CREATE TABLE approval_continuation_steps (id serial PRIMARY KEY, state text NOT NULL);
    CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);
    INSERT INTO settings VALUES ('theme', 'default');
    CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL, embedding vector(3));
    INSERT INTO notes (body) SELECT 'note ' || g FROM generate_series(1, 500) g;
    GRANT SELECT, INSERT ON notes TO $4;
    ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
    CREATE POLICY notes_app ON notes TO $4 USING (true);
    INSERT INTO approval_requests (status) VALUES ('approved'), ('denied'), ('consumed');
    INSERT INTO approval_continuations (state) VALUES ('completed');
    INSERT INTO approval_continuation_steps (state) VALUES ('completed');"
}
# What a person did on top: changed a seeded row, added rows.
use() { # port superuser db
  sql "$1" "$2" "$3" "UPDATE settings SET value = 'dark' WHERE key = 'theme';
    INSERT INTO settings VALUES ('lang', 'zh');
    INSERT INTO notes (body, embedding) VALUES ('written by a person', '[1,2,3]');"
}

# Everything a refusal must leave alone: the roles, and the database as pg_dump prints it.
fingerprint() { # port superuser db
  {
    sql "$1" "$2" postgres "SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname !~ '^pg_';"
    # pg_dump 16.10+ brackets a plain dump with \restrict <random key>: not data, so not compared.
    PGPASSWORD=$PW "$PG_BIN/pg_dump" -w -h 127.0.0.1 -p "$1" -U "$2" -d "$3" | grep -v '^\\\(un\)\{0,1\}restrict '
  } | cksum
}

FAKEBIN=$T/fakebin
mkdir -p "$FAKEBIN"
cat >"$FAKEBIN/df" <<'EOF'
#!/bin/sh
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/test 99999999 0 %s 1%% /var/lib/postgresql\n' "$FAKE_AVAIL_KB"
EOF
chmod 755 "$FAKEBIN/df"

BACKUP=$T/backup
STATE=$T/state

# preflight <port> <superuser> <db> [VAR=value...]: `check`, output in $T/out and $T/err, exit in $code.
preflight() {
  p=$1 u=$2 db=$3
  shift 3
  env PGPASSWORD="$PW" REBRAND_BACKUP_DIR="$BACKUP" REBRAND_STATE_DIR="$STATE" REBRAND_PG_BIN="$PG_BIN" "$@" \
    sh "$PREFLIGHT" check -h 127.0.0.1 -p "$p" -U "$u" -d "$db" >"$T/out" 2>"$T/err" </dev/null
  code=$?
  cat "$T/out" "$T/err" >>"$ALL"
}

# step <name> <data> <command...>: the step runner, as migrate.sh calls it.
step() {
  n=$1 k=$2
  shift 2
  env PGPASSWORD="$PW" REBRAND_BACKUP_DIR="$BACKUP" REBRAND_STATE_DIR="$STATE" REBRAND_PG_BIN="$PG_BIN" \
    sh "$PREFLIGHT" step "$n" "$k" -- "$@" >"$T/out" 2>"$T/err" </dev/null
  code=$?
  cat "$T/out" "$T/err" >>"$ALL"
}

# finish: the last line of migrate.sh.
finish() {
  env REBRAND_BACKUP_DIR="$BACKUP" REBRAND_STATE_DIR="$STATE" sh "$PREFLIGHT" finish >"$T/out" 2>"$T/err" </dev/null
  code=$?
  cat "$T/out" "$T/err" >>"$ALL"
}

state_of() { sed -n "s/^$1=//p" "$STATE/state" 2>/dev/null; }
MARKER=$BACKUP/rebrand-in-progress
backups() { ls "$BACKUP" 2>/dev/null | grep -c '^pre-rebrand-.*\.dump$'; }
mode_of() { stat -c %a "$1"; }

OLD=$(start_cluster old openbot) || exit 1
CLUSTERS="$CLUSTERS $T/old/data"
sql "$OLD" openbot postgres "CREATE DATABASE openbot OWNER openbot;" || exit 1
sql "$OLD" openbot postgres "CREATE ROLE openbot_app LOGIN; CREATE ROLE openbot_role_writer LOGIN;" || exit 1
seed "$OLD" openbot openbot openbot_app || exit 1
use "$OLD" openbot openbot || exit 1
sql "$OLD" openbot postgres "CREATE DATABASE fresh OWNER openbot;" || exit 1

NEW=$(start_cluster new xiongbao) || exit 1
CLUSTERS="$CLUSTERS $T/new/data"
sql "$NEW" xiongbao postgres "CREATE DATABASE xiongbao OWNER xiongbao;" || exit 1
sql "$NEW" xiongbao postgres "CREATE ROLE xiongbao_app LOGIN; CREATE ROLE xiongbao_role_writer LOGIN;" || exit 1
seed "$NEW" xiongbao xiongbao xiongbao_app || exit 1
sql "$NEW" xiongbao postgres "CREATE DATABASE fresh OWNER xiongbao;" || exit 1

# 1. already renamed database skips preflight and backup: a pending approval and no free space at all
#    would each refuse, so passing proves neither check ran; nothing is printed and nothing written.
sql "$NEW" xiongbao xiongbao "INSERT INTO approval_requests (status) VALUES ('pending');"
preflight "$NEW" xiongbao xiongbao PATH="$FAKEBIN:$PATH" FAKE_AVAIL_KB=0
what="already renamed database skips preflight and backup"
if [ "$code" -ne 0 ]; then fail "$what: exit $code: $(cat "$T/err")"
elif [ -e "$BACKUP" ]; then fail "$what: created $BACKUP"
elif [ -s "$T/out" ] || [ -s "$T/err" ]; then fail "$what: printed: $(cat "$T/out" "$T/err")"
elif [ "$(state_of needs_rebrand)" != 0 ]; then fail "$what: state says needs_rebrand=$(state_of needs_rebrand)"
else pass "$what"; fi
sql "$NEW" xiongbao xiongbao "DELETE FROM approval_requests WHERE status = 'pending';"

# ...and a failing step on such a volume is an ordinary failure: no backup named, no record written.
step "数据库迁移" "数据库表结构与系统数据" sh -c 'exit 4'
what="a failing step on a renamed volume names the step and writes no record"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "数据库迁移" "$T/err"; then fail "$what: step not named: $(cat "$T/err")"
elif grep -q "备份" "$T/err"; then fail "$what: mentions a backup: $(cat "$T/err")"
elif [ -e "$BACKUP" ]; then fail "$what: wrote under $BACKUP"
else pass "$what"; fi

# 2. the roles decide, in every half-renamed shape: either old name left means the rename is not done.
#    An empty database keeps the backup out of it; the state file says what was decided.
begin
sql "$OLD" openbot postgres "ALTER ROLE openbot_app RENAME TO xiongbao_app;"
preflight "$OLD" openbot fresh
[ "$code" -eq 0 ] && [ "$(state_of needs_rebrand)" = 1 ] ||
  fail "old superuser with a renamed app role still needs the rename (exit $code, $(cat "$T/err"))"
sql "$OLD" openbot postgres "ALTER ROLE xiongbao_app RENAME TO openbot_app;"
sql "$NEW" xiongbao postgres "ALTER ROLE xiongbao_app RENAME TO openbot_app;"
preflight "$NEW" xiongbao fresh
[ "$code" -eq 0 ] && [ "$(state_of needs_rebrand)" = 1 ] ||
  fail "renamed superuser with the old app role still needs the rename (exit $code, $(cat "$T/err"))"
sql "$NEW" xiongbao postgres "ALTER ROLE openbot_app RENAME TO xiongbao_app;"
# The superuser and the database are renamed in a step of their own, after the application roles: every
# role renamed but the database not yet (or the other way round) is still a rename to finish.
preflight "$NEW" xiongbao fresh
[ "$code" -eq 0 ] && [ "$(state_of needs_rebrand)" = 1 ] ||
  fail "every role renamed but not the database still needs the rename (exit $code, $(cat "$T/err"))"
sql "$NEW" xiongbao postgres "ALTER ROLE xiongbao_role_writer RENAME TO openbot_role_writer;"
sql "$NEW" xiongbao xiongbao "INSERT INTO approval_requests (status) VALUES ('pending');"
preflight "$NEW" xiongbao xiongbao
[ "$code" -ne 0 ] && grep -q "待审批：1" "$T/err" ||
  fail "the renamed database with the old role writer still needs the rename (exit $code, $(cat "$T/err"))"
sql "$NEW" xiongbao xiongbao "DELETE FROM approval_requests WHERE status = 'pending';"
sql "$NEW" xiongbao postgres "ALTER ROLE openbot_role_writer RENAME TO xiongbao_role_writer;"
clean && pass "a half-renamed cluster still needs the rename"

# 3. a fresh empty database needs no backup: a new volume's first boot has the old names (initdb runs
#    before the rename) but no data yet.
preflight "$OLD" openbot fresh
what="a fresh empty database needs no backup"
if [ "$code" -ne 0 ]; then fail "$what: exit $code: $(cat "$T/err")"
elif [ "$(backups)" -ne 0 ]; then fail "$what: wrote a backup"
elif [ "$(state_of needs_rebrand)" != 1 ] || [ -n "$(state_of backup)" ]; then fail "$what: state $(cat "$STATE/state")"
else pass "$what"; fi

# 4. pending approvals refuse the upgrade and leave data untouched
sql "$OLD" openbot openbot "INSERT INTO approval_requests (status) VALUES ('pending'), ('pending');
  INSERT INTO approval_continuations (state) VALUES ('dispatched');
  INSERT INTO approval_continuation_steps (state) VALUES ('running'), ('unknown'), ('reserved');"
before=$(fingerprint "$OLD" openbot openbot)
preflight "$OLD" openbot openbot
after=$(fingerprint "$OLD" openbot openbot)
what="pending approvals refuse the upgrade and leave data untouched"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "待审批：2" "$T/err"; then fail "$what: pending count missing: $(cat "$T/err")"
elif ! grep -q "未完成的续跑：1" "$T/err"; then fail "$what: continuation count missing: $(cat "$T/err")"
elif ! grep -q "未完成的续跑步骤：3" "$T/err"; then fail "$what: step count missing: $(cat "$T/err")"
elif ! grep -q "运行断言" "$T/err"; then fail "$what: run assertions not mentioned: $(cat "$T/err")"
elif ! grep -q "v0.2.15" "$T/err" || ! grep -q "pre-upgrade-check.sh" "$T/err"; then fail "$what: no way out given: $(cat "$T/err")"
elif [ -e "$BACKUP" ]; then fail "$what: backup directory created"
elif [ "$before" != "$after" ]; then fail "$what: data changed"
else pass "$what"; fi
# Each count refuses on its own.
begin
sql "$OLD" openbot openbot "UPDATE approval_requests SET status = 'denied' WHERE status = 'pending';"
preflight "$OLD" openbot openbot
[ "$code" -ne 0 ] && grep -q "待审批：0" "$T/err" || fail "unfinished continuations alone refuse (exit $code)"
sql "$OLD" openbot openbot "UPDATE approval_continuations SET state = 'completed';"
preflight "$OLD" openbot openbot
[ "$code" -ne 0 ] && grep -q "未完成的续跑：0" "$T/err" || fail "unfinished continuation steps alone refuse (exit $code)"
sql "$OLD" openbot openbot "UPDATE approval_continuation_steps SET state = 'completed';"
clean && pass "each in-flight count refuses on its own"

# 5. insufficient space refuses before touching data: one KB short of twice the database size.
size=$(sql "$OLD" openbot openbot "SELECT pg_database_size('openbot');")
need_kb=$(((size * 2 + 1023) / 1024))
before=$(fingerprint "$OLD" openbot openbot)
preflight "$OLD" openbot openbot PATH="$FAKEBIN:$PATH" FAKE_AVAIL_KB=$((need_kb - 1))
after=$(fingerprint "$OLD" openbot openbot)
need_mb=$(((need_kb + 1023) / 1024))
what="insufficient space refuses before touching data"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "至少 ${need_mb} MB" "$T/err"; then fail "$what: needed space not stated as ${need_mb} MB: $(cat "$T/err")"
elif ! grep -q "× 2" "$T/err"; then fail "$what: rule not stated: $(cat "$T/err")"
elif [ -e "$BACKUP" ]; then fail "$what: backup directory created"
elif [ "$before" != "$after" ]; then fail "$what: data changed"
else pass "$what"; fi

# ...and exactly twice the size is enough.
preflight "$OLD" openbot openbot PATH="$FAKEBIN:$PATH" FAKE_AVAIL_KB=$need_kb
[ "$code" -eq 0 ] && [ "$(backups)" -eq 1 ] && pass "exactly twice the database size is enough" ||
  fail "exactly twice the database size is enough: exit $code, $(backups) backups: $(cat "$T/err")"
rm -rf "$BACKUP"

# 6. backup is written 0600 before any rename: the rename stand-in looks at the backup first, then
#    renames a role; the backup is not touched afterwards; `finish` clears the record.
echo stale >"$T/stale"
mkdir -p "$BACKUP" && cp "$T/stale" "$BACKUP/.pre-rebrand-killed.partial" && cp "$T/stale" "$BACKUP/.rebrand-in-progress.cutoff"
[ "$(id -u)" = 0 ] && chown -R postgres:postgres "$BACKUP"
preflight "$OLD" openbot openbot
dump=$(state_of backup)
what="backup is written 0600 before any rename"
case $(basename "$dump") in
  pre-rebrand-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.dump) named=1 ;;
  *) named=0 ;;
esac
if [ "$code" -ne 0 ]; then fail "$what: exit $code: $(cat "$T/err")"
elif [ "$named" -ne 1 ] || [ "$(dirname "$dump")" != "$BACKUP" ]; then fail "$what: unexpected path $dump"
elif [ ! -f "$dump" ]; then fail "$what: $dump missing"
elif [ "$(mode_of "$dump")" != 600 ]; then fail "$what: file mode $(mode_of "$dump")"
elif [ "$(mode_of "$BACKUP")" != 700 ]; then fail "$what: directory mode $(mode_of "$BACKUP")"
elif [ "$(id -u)" = 0 ] && [ "$(stat -c %U "$dump")" != postgres ]; then fail "$what: owner $(stat -c %U "$dump")"
elif [ "$(id -u)" = 0 ] && [ "$(stat -c %U "$BACKUP")" != postgres ]; then fail "$what: directory owner $(stat -c %U "$BACKUP")"
elif [ -e "$BACKUP/.pre-rebrand-killed.partial" ] || [ -e "$BACKUP/.rebrand-in-progress.cutoff" ]; then fail "$what: an interrupted temporary file was kept"
elif ls -A "$BACKUP" | grep -v '^pre-rebrand-' | grep -vqx 'rebrand-in-progress'; then fail "$what: leftovers: $(ls -A "$BACKUP")"
elif [ ! -f "$MARKER" ] || [ "$(mode_of "$MARKER")" != 600 ]; then fail "$what: no 0600 in-progress record"
elif ! grep -qx "backup=$dump" "$MARKER"; then fail "$what: record does not name the backup: $(cat "$MARKER")"
elif ! grep -q "$dump" "$T/out" "$T/err"; then fail "$what: path not printed"
elif [ "$(state_of needs_rebrand)" != 1 ]; then fail "$what: state $(cat "$STATE/state")"
elif [ "$(ls -A "$STATE")" != state ]; then fail "$what: more than the state file under $STATE: $(ls -A "$STATE")"
elif [ "$(mode_of "$STATE/state")" != 644 ]; then fail "$what: state file mode $(mode_of "$STATE/state")"
else
  begin
  sum=$(cksum <"$dump")
  step "改名" "数据库角色名" sh -c '
    [ -f "$1" ] && [ "$(stat -c %a "$1")" = 600 ] || { echo "no backup before the rename" >&2; exit 1; }
    PGPASSWORD=$2 "$3/psql" -X -q -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$4" -U openbot -d postgres \
      -c "ALTER ROLE openbot_role_writer RENAME TO xiongbao_role_writer;"
  ' rename "$dump" "$PW" "$PG_BIN" "$OLD"
  if [ "$code" -ne 0 ]; then fail "$what: rename stand-in failed: $(cat "$T/err")"
  elif [ "$(cksum <"$dump")" != "$sum" ]; then fail "$what: backup changed after the rename"
  elif ! grep -qx "ok=改名" "$MARKER"; then fail "$what: completed step not recorded: $(cat "$MARKER")"
  fi
  sql "$OLD" openbot postgres "ALTER ROLE xiongbao_role_writer RENAME TO openbot_role_writer;"
  finish
  if [ "$code" -ne 0 ] || [ -e "$MARKER" ]; then fail "$what: finish did not clear the record (exit $code)"
  elif ! grep -qF "$dump" "$T/out"; then fail "$what: finish does not name the backup it keeps"
  elif [ ! -f "$dump" ]; then fail "$what: finish removed the backup"
  fi
  clean && pass "$what"
fi

# 7. the backup restores, by the documented steps, over a new volume that v0.2.15 has already started on:
#    every grant, column grant, default privilege, row-security policy, owner and row comes back exactly
#    as backed up. Both sides are built by the server's own migrations, so the target carries what a real
#    first start leaves (0054's default privileges among it). The control shows why the restore goes into
#    an empty database: pg_restore --clean over the migrated one hands the app role writes it never had.
#
# migrated <port> <db>: what v0.2.15's first start does to a database (pgvector, every migration v0.2.15
# shipped, the app role's password). The migrator stops at v0.2.15's last migration for tests
# (XIONGBAO_TEST_MIGRATE_THROUGH, honoured only with NODE_ENV=test): 0240 and later are v0.2.16's.
migrated() {
  sql "$1" openbot postgres "CREATE DATABASE $2 OWNER openbot;" &&
    sql "$1" openbot "$2" "CREATE EXTENSION IF NOT EXISTS vector;" &&
    (cd "$MIGRATOR_DIR" && DATABASE_URL="postgres://openbot:$PW@127.0.0.1:$1/$2" HOME="$T/home" \
      NODE_ENV=test XIONGBAO_TEST_MIGRATE_THROUGH=0239_aihub_provider_template bun scripts/migrate.ts) >"$T/migrate.log" 2>&1 &&
    sql "$1" openbot "$2" "ALTER ROLE openbot_app WITH LOGIN PASSWORD '$PW';" ||
    { echo "migrating $2 failed: $(tail -n 20 "$T/migrate.log")" >&2; return 1; }
}
# Owners, grants, column grants, default privileges, row-security switches and policies, function and
# schema grants: everything a restore could get wrong about who may do what.
security_print() { # port db
  sql "$1" openbot "$2" "SELECT concat_ws('|', n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner), c.relacl::text,
      c.relrowsecurity, c.relforcerowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'drizzle') ORDER BY 1;
    SELECT concat_ws('|', a.attrelid::regclass::text, a.attname, a.attacl::text) FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND a.attacl IS NOT NULL ORDER BY 1;
    SELECT concat_ws('|', pg_get_userbyid(defaclrole), defaclnamespace::regnamespace::text, defaclobjtype, defaclacl::text)
      FROM pg_default_acl ORDER BY 1;
    SELECT concat_ws('|', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check)
      FROM pg_policies ORDER BY 1;
    SELECT concat_ws('|', p.oid::regprocedure::text, pg_get_userbyid(p.proowner), p.proacl::text, p.prosecdef)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1;
    SELECT concat_ws('|', nspname, pg_get_userbyid(nspowner), nspacl::text) FROM pg_namespace
      WHERE nspname IN ('public', 'drizzle') ORDER BY 1;" | cksum
}
data_print() { # port db
  PGPASSWORD=$PW "$PG_BIN/pg_dump" -w --data-only -h 127.0.0.1 -p "$1" -U openbot -d "$2" 2>/dev/null |
    grep -v '^--\|^\\\(un\)\{0,1\}restrict ' | cksum
}
restore() { # dump
  env REBRAND_RESTORE_URL_FILE="$T/v15-url" REBRAND_RESTORE_PG_BIN="$PG_BIN" REBRAND_RESTORE_API_SERVICE="$T/no-api" \
    sh -s "$1" >"$T/out" 2>"$T/err" <"$HERE/../s6/scripts/rebrand-restore.sh"
  code=$?
  cat "$T/out" "$T/err" >>"$ALL"
}
databases() { sql "$1" openbot postgres "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE NOT datistemplate;"; }
# The volume backed up: a v0.2.15 database with a person's rows on top, through the preflight's own backup.
SRC=$(start_cluster source openbot) || exit 1
CLUSTERS="$CLUSTERS $T/source/data"
migrated "$SRC" openbot || exit 1
sql "$SRC" openbot openbot "CREATE TABLE public.restore_probe (id serial PRIMARY KEY, body text NOT NULL);
  INSERT INTO public.restore_probe (body) SELECT 'row ' || g FROM generate_series(1, 300) g;
  GRANT SELECT, INSERT ON public.restore_probe TO openbot_app;
  GRANT UPDATE (body) ON public.restore_probe TO openbot_app;" || exit 1
preflight "$SRC" openbot openbot REBRAND_BACKUP_DIR="$T/source-backup"
src_dump=$(state_of backup)
[ "$code" -eq 0 ] && [ -f "$src_dump" ] || { echo "backing up the source failed: $(cat "$T/err")" >&2; exit 1; }
src_security=$(security_print "$SRC" openbot)
src_data=$(data_print "$SRC" openbot)
# The volume restored onto: started by v0.2.15 (migrated, so its default privileges are in place), plus a
# second migrated database on the same cluster for the control.
V15=$(start_cluster v0215 openbot) || exit 1
CLUSTERS="$CLUSTERS $T/v0215/data"
migrated "$V15" openbot || exit 1
migrated "$V15" plain || exit 1
cp "$src_dump" "$T/restore.dump"
chmod 644 "$T/restore.dump"
printf 'postgres://openbot:%s@127.0.0.1:%s/openbot' "$PW" "$V15" >"$T/v15-url"
# A file that is not a complete backup is refused before the database is touched.
head -c 2000 "$T/restore.dump" >"$T/cut.dump"
before=$(security_print "$V15" openbot)$(data_print "$V15" openbot)
restore "$T/cut.dump"
[ "$code" -ne 0 ] && [ "$(security_print "$V15" openbot)$(data_print "$V15" openbot)" = "$before" ] && [ "$(databases "$V15")" = "openbot,plain,postgres" ] &&
  pass "a truncated backup is refused and the database is untouched" ||
  fail "a truncated backup is refused and the database is untouched: exit $code: $(cat "$T/err")"
# A session still connected (the API not stopped): refused, nothing touched, no temporary database left.
PGPASSWORD=$PW "$PG_BIN/psql" -X -q -w -h 127.0.0.1 -p "$V15" -U openbot_app -d openbot -c 'SELECT pg_sleep(120)' >/dev/null 2>&1 &
holder=$!
tries=0
until [ "$(sql "$V15" openbot postgres "SELECT count(*) FROM pg_stat_activity WHERE usename = 'openbot_app';")" = 1 ]; do
  tries=$((tries + 1))
  [ "$tries" -lt 50 ] || { echo "the holding session never connected" >&2; exit 1; }
  sleep 0.2
done
restore "$T/restore.dump"
sql "$V15" openbot postgres "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'openbot_app';" >/dev/null
kill "$holder" 2>/dev/null
wait "$holder" 2>/dev/null
what="a restore with another session on the database is refused and touches nothing"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "其它连接" "$T/err"; then fail "$what: $(cat "$T/err")"
elif [ "$(security_print "$V15" openbot)$(data_print "$V15" openbot)" != "$before" ]; then fail "$what: the database changed"
elif [ "$(databases "$V15")" != "openbot,plain,postgres" ]; then fail "$what: databases now $(databases "$V15")"
else pass "$what"; fi
# The restore itself.
restore "$T/restore.dump"
what="the backup restores every grant, policy, owner and row over a volume v0.2.15 has started on"
if [ "$code" -ne 0 ]; then fail "$what: exit $code: $(cat "$T/out" "$T/err")"
elif [ "$(security_print "$V15" openbot)" != "$src_security" ]; then fail "$what: owners, grants, default privileges or policies differ from the backup"
elif [ "$(data_print "$V15" openbot)" != "$src_data" ]; then fail "$what: the rows differ from the backup"
elif [ "$(sql "$V15" openbot openbot "SELECT has_table_privilege('openbot_app', 'public.user_roles', 'UPDATE');")" != f ]; then fail "$what: the app role can update user_roles"
elif [ "$(PGPASSWORD=$PW "$PG_BIN/psql" -X -q -A -t -w -h 127.0.0.1 -p "$V15" -U openbot_app -d openbot -c "SELECT count(*) FROM public.restore_probe;" 2>&1)" != 300 ]; then fail "$what: the app role cannot read the person's rows"
elif [ "$(databases "$V15")" != "openbot,plain,postgres" ]; then fail "$what: databases now $(databases "$V15")"
else pass "$what"; fi
# The control: --clean over a migrated database lets its default privileges widen the app role's grants.
[ "$(sql "$SRC" openbot openbot "SELECT has_table_privilege('openbot_app', 'public.user_roles', 'UPDATE');")" = f ] ||
  fail "control: the source's app role can already update user_roles"
PGPASSWORD=$PW "$PG_BIN/pg_restore" --clean --if-exists --single-transaction --exit-on-error -w -h 127.0.0.1 -p "$V15" -U openbot -d plain "$T/restore.dump" >/dev/null 2>&1
[ "$(sql "$V15" openbot plain "SELECT has_table_privilege('openbot_app', 'public.user_roles', 'UPDATE');")" = t ] &&
  pass "control: pg_restore --clean over a migrated database gives the app role writes on user_roles" ||
  fail "control: --clean over a migrated database no longer widens grants, so the empty-database restore may no longer be needed"
# A swap cut off after the old database was dropped: running the script again finishes it, without
# restoring a second time.
sql "$V15" openbot postgres "ALTER DATABASE openbot RENAME TO openbot_restoring;"
restore "$T/restore.dump"
what="a restore cut off between dropping and renaming is finished by running it again"
if [ "$code" -ne 0 ]; then fail "$what: exit $code: $(cat "$T/err")"
elif ! grep -q "没有再灌一遍" "$T/out"; then fail "$what: $(cat "$T/out")"
elif [ "$(databases "$V15")" != "openbot,plain,postgres" ]; then fail "$what: databases now $(databases "$V15")"
elif [ "$(security_print "$V15" openbot)$(data_print "$V15" openbot)" != "$src_security$src_data" ]; then fail "$what: the database differs from the backup"
else pass "$what"; fi

# 8. migration failure leaves the backup and prints its path. The stand-in fails without committing
#    anything (the journal is as it was), so the message says nothing changed and sends nobody to restore.
preflight "$OLD" openbot openbot
dump=$(state_of backup)
count=$(backups)
step "数据库迁移" "数据库表结构与系统数据" sh -c 'echo "migration exploded" >&2; exit 3'
what="migration failure leaves the backup and prints its path"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif [ -z "$dump" ] || [ ! -f "$dump" ]; then fail "$what: backup gone ($dump)"
elif ! grep -qF "$dump" "$T/err"; then fail "$what: backup path not printed: $(cat "$T/err")"
elif ! grep -q "数据库迁移" "$T/err" || ! grep -q "数据库表结构与系统数据" "$T/err"; then fail "$what: step or data not named: $(cat "$T/err")"
elif ! grep -q "migration exploded" "$T/err"; then fail "$what: the step's own error was swallowed"
elif ! grep -q "业务库没有改动" "$T/err"; then fail "$what: does not say the database is unchanged: $(cat "$T/err")"
elif grep -q "rebrand-restore.sh" "$T/err"; then fail "$what: sends an unchanged database to a restore"
elif [ ! -f "$MARKER" ]; then fail "$what: the in-progress record is gone"
else pass "$what"; fi

# 9. a restart after the failure resumes: no new backup, the old one named, the steps run again.
preflight "$OLD" openbot openbot
what="a restart after a failed step resumes with the same backup and makes no new one"
if [ "$code" -ne 0 ]; then fail "$what: exit $code: $(cat "$T/err")"
elif [ "$(backups)" -ne "$count" ]; then fail "$what: $(backups) backups, was $count"
elif [ "$(state_of backup)" != "$dump" ] || [ "$(state_of needs_rebrand)" != 1 ]; then fail "$what: state $(cat "$STATE/state")"
elif ! grep -qF "$dump" "$T/out" || ! grep -q "不再备份" "$T/out"; then fail "$what: log does not name the backup it keeps: $(cat "$T/out")"
else pass "$what"; fi

# 10. a step that committed and then failed: the journal grew, so the message says the database changed
#     and points to the restore steps.
step "数据库迁移" "数据库表结构与系统数据" sh -c '
  PGPASSWORD=$1 "$2/psql" -X -q -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$3" -U openbot -d openbot \
    -c "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('"'h2'"', 2);" && exit 1
' commit "$PW" "$PG_BIN" "$OLD"
what="a step that changed the database says so and points to the restore steps"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "业务库已经改动" "$T/err" || ! grep -q "1 条变成 2 条" "$T/err"; then fail "$what: $(cat "$T/err")"
elif ! grep -q "/etc/s6-overlay/scripts/rebrand-restore.sh" "$T/err" || ! grep -qF "$dump" "$T/err"; then fail "$what: no restore pointer or backup: $(cat "$T/err")"
else pass "$what"; fi
sql "$OLD" openbot openbot "DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'h2';"

# 11. the container killed in the middle of a step (docker stop, OOM, host reboot): the runner never gets
#     to report, the record stays, and the next boot resumes without a new backup. Same for a failure in
#     migrate.sh outside any step: nothing clears the record but `finish`.
preflight "$OLD" openbot openbot
step "数据库迁移" "数据库表结构与系统数据" sh -c 'kill -KILL "$PPID"; sleep 5'
killed=$code
preflight "$OLD" openbot openbot
what="an attempt killed mid-step resumes on restart without a new backup"
if [ "$killed" -eq 0 ]; then fail "$what: the stand-in was not killed"
elif [ "$code" -ne 0 ]; then fail "$what: exit $code: $(cat "$T/err")"
elif [ "$(backups)" -ne "$count" ]; then fail "$what: $(backups) backups, was $count"
elif [ "$(state_of backup)" != "$dump" ]; then fail "$what: state names $(state_of backup)"
else pass "$what"; fi
step "改名" "数据库角色名" true
preflight "$OLD" openbot openbot
[ "$code" -eq 0 ] && [ "$(backups)" -eq "$count" ] && grep -q "已完成的步骤：改名" "$T/out" &&
  pass "a failure outside any step resumes without a new backup and lists the steps done" ||
  fail "a failure outside any step resumes without a new backup: exit $code, $(backups) backups: $(cat "$T/out" "$T/err")"

# 12. resuming still refuses work in flight, and refuses when the recorded backup has gone.
sql "$OLD" openbot openbot "INSERT INTO approval_requests (status) VALUES ('pending');"
preflight "$OLD" openbot openbot
what="resuming still refuses work in flight, and says the database is as backed up"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "待审批：1" "$T/err"; then fail "$what: $(cat "$T/err")"
elif ! grep -q "上一次改名没有改动业务库" "$T/err" || ! grep -qF "$MARKER" "$T/err"; then fail "$what: no comparison or no record to delete: $(cat "$T/err")"
elif grep -q "数据没动过" "$T/err"; then fail "$what: still the unconditional wording: $(cat "$T/err")"
else pass "$what"; fi
# The previous boot committed the business transaction and then stopped short of `finish` (killed, or a
# command outside the steps failed); someone went back to v0.2.15 on the same volume and left work in
# flight. The refusal must say the database has changed, never that it is untouched.
sql "$OLD" openbot openbot "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('h2', 2);"
preflight "$OLD" openbot openbot
what="a resumed refusal after a committed change says the database changed"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "已经改动了业务库" "$T/err" || ! grep -q "1 条变成 2 条" "$T/err"; then fail "$what: $(cat "$T/err")"
elif grep -q "数据没动过\|数据没有改动" "$T/err"; then fail "$what: claims untouched data: $(cat "$T/err")"
elif ! grep -q "rebrand-restore.sh" "$T/err"; then fail "$what: no way back given: $(cat "$T/err")"
else pass "$what"; fi
sql "$OLD" openbot openbot "DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'h2';"
# The database cannot be read (after the role rename has half run, the old name no longer connects):
# unknown, never "unchanged".
preflight "$OLD" openbot openbot PGPASSWORD=wrong-password
what="a resumed refusal that cannot read the database does not claim it is unchanged"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "无法确认上一次改名是否已经改动了数据库" "$T/err"; then fail "$what: $(cat "$T/err")"
elif grep -q "数据没动过\|数据没有改动" "$T/err"; then fail "$what: claims untouched data: $(cat "$T/err")"
elif [ "$(backups)" -ne "$count" ]; then fail "$what: $(backups) backups, was $count"
else pass "$what"; fi
sql "$OLD" openbot openbot "UPDATE approval_requests SET status = 'denied' WHERE status = 'pending';"
mv "$dump" "$T/moved.dump"
preflight "$OLD" openbot openbot
[ "$code" -ne 0 ] && grep -qF "$dump" "$T/err" && [ "$(backups)" -eq $((count - 1)) ] &&
  pass "a recorded backup that has gone refuses rather than carrying on without one" ||
  fail "a recorded backup that has gone refuses: exit $code: $(cat "$T/err")"
mv "$T/moved.dump" "$dump"

# 13. once `finish` has run, the next attempt is a new one with a new backup.
finish
sleep 1
preflight "$OLD" openbot openbot
[ "$code" -eq 0 ] && [ "$(backups)" -eq $((count + 1)) ] && pass "after finish the next attempt makes a new backup" ||
  fail "after finish the next attempt makes a new backup: exit $code, $(backups) backups: $(cat "$T/err")"
finish

# 14. links on the volume are refused, never followed: the backup directory as a link, or a link where
#     the in-progress record goes. The link's target is left as it was.
mkdir -p "$T/elsewhere"
chmod 755 "$T/elsewhere"
ln -s "$T/elsewhere" "$T/linked-dir"
preflight "$OLD" openbot openbot REBRAND_BACKUP_DIR="$T/linked-dir"
[ "$code" -ne 0 ] && [ "$(mode_of "$T/elsewhere")" = 755 ] && [ -z "$(ls -A "$T/elsewhere")" ] &&
  pass "a backup directory that is a link is refused and its target untouched" ||
  fail "a backup directory that is a link is refused: exit $code, target mode $(mode_of "$T/elsewhere"): $(ls -A "$T/elsewhere")"
ln -s "$T/elsewhere/planted" "$MARKER"
preflight "$OLD" openbot openbot
[ "$code" -ne 0 ] && [ ! -e "$T/elsewhere/planted" ] && pass "a link where the record goes is refused and not followed" ||
  fail "a link where the record goes is refused: exit $code"
rm -f "$MARKER"

# 15a. a catalog query that fails refuses before anything is written: the connection refused (wrong
#      password), or an answer that is not a number.
count=$(backups)
preflight "$OLD" openbot openbot PGPASSWORD=wrong-password
what="a catalog query that fails refuses and writes nothing"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "无法读取数据库角色" "$T/err" || ! grep -q "数据没有改动" "$T/err"; then fail "$what: $(cat "$T/err")"
elif [ "$(backups)" -ne "$count" ] || [ -e "$MARKER" ] || [ -e "$STATE/state" ]; then fail "$what: something was written"
else pass "$what"; fi
mkdir -p "$T/oddbin"
printf '#!/bin/sh\ncat >/dev/null\necho "not-a-number"\n' >"$T/oddbin/psql"
chmod 755 "$T/oddbin/psql"
preflight "$OLD" openbot openbot REBRAND_PG_BIN="$T/oddbin"
[ "$code" -ne 0 ] && grep -q "无法读取数据库角色" "$T/err" && [ "$(backups)" -eq "$count" ] && [ ! -e "$STATE/state" ] &&
  pass "a catalog answer that is not a number refuses" ||
  fail "a catalog answer that is not a number refuses: exit $code: $(cat "$T/err")"

# 15. a dump that fails refuses, and leaves neither a temporary file, a record nor a state.
mkdir -p "$T/badbin"
for b in psql pg_restore; do ln -s "$PG_BIN/$b" "$T/badbin/$b"; done
printf '#!/bin/sh\necho "pg_dump: error: simulated" >&2\nexit 1\n' >"$T/badbin/pg_dump"
chmod 755 "$T/badbin/pg_dump"
count=$(backups)
preflight "$OLD" openbot openbot REBRAND_PG_BIN="$T/badbin"
what="a failed dump refuses and leaves nothing behind"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "simulated" "$T/err"; then fail "$what: dump error not shown: $(cat "$T/err")"
elif [ "$(backups)" -ne "$count" ] || ls -A "$BACKUP" | grep -q '\.partial$'; then fail "$what: files left: $(ls -A "$BACKUP")"
elif [ -e "$MARKER" ] || [ -e "$STATE/state" ]; then fail "$what: record or state written"
else pass "$what"; fi

# 16. a volume from before the continuation tables existed (before v0.2.12): those counts are 0, the log
#     says so, and the rename goes ahead instead of refusing for ever.
sql "$OLD" openbot postgres "CREATE DATABASE older OWNER openbot;"
sql "$OLD" openbot older "CREATE SCHEMA drizzle;
  CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
  INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('h1', 1);
  CREATE TABLE approval_requests (id serial PRIMARY KEY, status text NOT NULL DEFAULT 'pending');"
preflight "$OLD" openbot older REBRAND_BACKUP_DIR="$T/older-backup"
[ "$code" -eq 0 ] && grep -q "按 0 计" "$T/out" && grep -q "approval_continuations" "$T/out" &&
  [ -n "$(state_of backup)" ] && pass "missing continuation tables count as 0 on an older volume" ||
  fail "missing continuation tables count as 0 on an older volume: exit $code: $(cat "$T/out" "$T/err")"

# 16b. resuming on a cluster whose superuser and database already carry the new name (the last step
#     committed, the boot was killed before finish) while the journal is as it was at the backup: the rename
#     is a cluster change the journal never records, and v0.2.15 cannot log in to it, so a refusal must not
#     call the database unchanged or send anyone back to v0.2.15 directly.
R=$T/renamed-backup
mkdir -p "$R"
echo dump >"$R/pre-rebrand-20261126T000000Z.dump"
printf 'started=2026-11-26T00:00:00Z\nbackup=%s\njournal=1\nok=数据库迁移\nok=超级用户与库改名\n' "$R/pre-rebrand-20261126T000000Z.dump" >"$R/rebrand-in-progress"
chmod 700 "$R" && chmod 600 "$R"/*
[ "$(id -u)" = 0 ] && chown -R postgres:postgres "$R"
sql "$NEW" xiongbao xiongbao "INSERT INTO approval_requests (status) VALUES ('pending');"
preflight "$NEW" xiongbao xiongbao REBRAND_BACKUP_DIR="$R"
what="a resumed refusal on a renamed cluster does not call it unchanged"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "待审批：1" "$T/err"; then fail "$what: $(cat "$T/err")"
elif ! grep -q "已经把数据库超级用户与库改成了新名字" "$T/err" || ! grep -q "不能直接换回 v0.2.15（集群已改名）" "$T/err"; then fail "$what: no renamed wording: $(cat "$T/err")"
elif grep -q "没有改动业务库\|可以直接回去\|数据没动过" "$T/err"; then fail "$what: claims unchanged: $(cat "$T/err")"
elif ! grep -q "rebrand-restore.sh" "$T/err"; then fail "$what: no restore pointer: $(cat "$T/err")"
else pass "$what"; fi
sql "$NEW" xiongbao xiongbao "DELETE FROM approval_requests WHERE status = 'pending';"

# 17. the read-only self-check reads the same numbers from a real database. A stand-in `docker` runs the
#    in-container part here, against the old cluster; every session is read-only, so data is untouched.
cat >"$FAKEBIN/docker" <<'EOF'
#!/bin/sh
case "$1" in
  inspect) exit 0 ;;
  exec)
    shift
    [ "$1" = "-i" ] && shift
    shift
    case "$1" in
      test) case "$*" in *rebrand-in-progress*) exit 1 ;; *) exit 0 ;; esac ;;
      df) printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\n/dev/vdb 99999999 1 %s 1%% /var/lib/postgresql\n' "$FAKE_AVAIL_KB" ;;
      sh) shift; exec sh "$@" ;;
      *) echo "unexpected exec: $*" >&2; exit 1 ;;
    esac ;;
  *) echo "unexpected docker call: $*" >&2; exit 1 ;;
esac
EOF
chmod 755 "$FAKEBIN/docker"
printf 'postgres://openbot:%s@127.0.0.1:%s/openbot' "$PW" "$OLD" >"$T/url"
chmod 600 "$T/url"
precheck() {
  env PATH="$FAKEBIN:$PATH" FAKE_AVAIL_KB=99999999 PRE_UPGRADE_URL_FILE="$T/url" PRE_UPGRADE_PSQL="$PG_BIN/psql" \
    sh "$PRECHECK" xiongbao >"$T/out" 2>"$T/err" </dev/null
  code=$?
  cat "$T/out" "$T/err" >>"$ALL"
}
sql "$OLD" openbot openbot "INSERT INTO approval_requests (status) VALUES ('pending');"
before=$(fingerprint "$OLD" openbot openbot)
precheck
after=$(fingerprint "$OLD" openbot openbot)
what="pre-upgrade check reads real counts and says no while approvals are pending"
if [ "$code" -ne 1 ]; then fail "$what: exit $code: $(cat "$T/out" "$T/err")"
elif ! grep -q "待审批：1" "$T/out"; then fail "$what: $(cat "$T/out")"
elif ! grep -q "需要改名：是" "$T/out"; then fail "$what: rename need not detected: $(cat "$T/out")"
elif ! grep -q "暂不能升级" "$T/out"; then fail "$what: no no-go verdict: $(cat "$T/out")"
elif [ "$before" != "$after" ]; then fail "$what: data changed"
else pass "$what"; fi
sql "$OLD" openbot openbot "UPDATE approval_requests SET status = 'denied' WHERE status = 'pending';"
precheck
[ "$code" -eq 0 ] && grep -q "可以升级" "$T/out" && pass "pre-upgrade check says go once nothing is in flight" ||
  fail "pre-upgrade check says go once nothing is in flight: exit $code: $(cat "$T/out" "$T/err")"

# 18. nothing above ever printed the database password.
if grep -qF "$PW" "$ALL"; then fail "the password was printed"; else pass "no output carries the password"; fi

exit "$rc"
