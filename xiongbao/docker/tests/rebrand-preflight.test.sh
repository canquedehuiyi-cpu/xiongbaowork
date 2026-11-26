#!/bin/sh
# rebrand-preflight.sh (and the read-only pre-upgrade-check.sh) against real PostgreSQL clusters that
# this file creates with initdb, so the queries, pg_dump and pg_restore are the real ones.
#
#   CI, inside the delivery image (same PostgreSQL 16 and dash the container runs):
#     docker run --rm --user root --entrypoint /bin/sh -v "$PWD:/repo:ro" xiongbao:trackb \
#       /repo/docker/tests/rebrand-preflight.test.sh
#   On a machine with PostgreSQL 16 installed:  sh docker/tests/rebrand-preflight.test.sh
#   (PG_BIN overrides /usr/lib/postgresql/16/bin; as root, the clusters run as the postgres user,
#   which must be able to reach TMPDIR.)
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

# PostgreSQL refuses to run as root: as root, everything that touches a cluster runs as postgres.
as_pg() {
  if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

# start_cluster <name> <superuser>: initdb + start on a free loopback port; prints the port.
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

# The tables the in-flight check reads, as the server's schema has them (the columns that matter),
# the migration journal that marks a database as migrated, and some business rows.
seed() { # port superuser db
  sql "$1" "$2" "$3" "CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('h1', 1);
    CREATE TABLE approval_requests (id serial PRIMARY KEY, status text NOT NULL DEFAULT 'pending');
    CREATE TABLE approval_continuations (id serial PRIMARY KEY, state text NOT NULL);
    CREATE TABLE approval_continuation_steps (id serial PRIMARY KEY, state text NOT NULL);
    CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL);
    INSERT INTO notes (body) SELECT 'note ' || g FROM generate_series(1, 500) g;
    INSERT INTO approval_requests (status) VALUES ('approved'), ('denied'), ('consumed');
    INSERT INTO approval_continuations (state) VALUES ('completed');
    INSERT INTO approval_continuation_steps (state) VALUES ('completed');"
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
  env REBRAND_BACKUP_DIR="$BACKUP" REBRAND_STATE_DIR="$STATE" sh "$PREFLIGHT" step "$n" "$k" -- "$@" \
    >"$T/out" 2>"$T/err" </dev/null
  code=$?
  cat "$T/out" "$T/err" >>"$ALL"
}

state_of() { sed -n "s/^$1=//p" "$STATE/state" 2>/dev/null; }
backups() { ls "$BACKUP" 2>/dev/null | grep -c '^pre-rebrand-.*\.dump$'; }
mode_of() { stat -c %a "$1"; }

OLD=$(start_cluster old openbot) || exit 1
sql "$OLD" openbot postgres "CREATE DATABASE openbot OWNER openbot;" || exit 1
sql "$OLD" openbot postgres "CREATE ROLE openbot_app LOGIN; CREATE ROLE openbot_role_writer LOGIN;" || exit 1
seed "$OLD" openbot openbot || exit 1
sql "$OLD" openbot postgres "CREATE DATABASE fresh OWNER openbot;" || exit 1

NEW=$(start_cluster new xiongbao) || exit 1
sql "$NEW" xiongbao postgres "CREATE DATABASE xiongbao OWNER xiongbao;" || exit 1
sql "$NEW" xiongbao postgres "CREATE ROLE xiongbao_app LOGIN; CREATE ROLE xiongbao_role_writer LOGIN;" || exit 1
seed "$NEW" xiongbao xiongbao || exit 1
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

# ...and a failing step on such a volume is an ordinary failure: no backup named, no failure marker.
step "数据库迁移" "数据库表结构与系统数据" sh -c 'exit 4'
what="a failing step on a renamed volume names the step and leaves no marker"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif ! grep -q "数据库迁移" "$T/err"; then fail "$what: step not named: $(cat "$T/err")"
elif grep -q "备份" "$T/err"; then fail "$what: mentions a backup: $(cat "$T/err")"
elif [ -e "$BACKUP/rebrand-failed" ]; then fail "$what: wrote a failure marker"
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
#    renames a role; the dump restores to the data as it was and the file is not touched afterwards.
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
elif ls -A "$BACKUP" | grep -vq '^pre-rebrand-'; then fail "$what: leftovers: $(ls -A "$BACKUP")"
elif ! grep -q "$dump" "$T/out" "$T/err"; then fail "$what: path not printed"
elif [ "$(state_of needs_rebrand)" != 1 ]; then fail "$what: state $(cat "$STATE/state")"
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
  else
    sql "$OLD" openbot postgres "CREATE DATABASE restored OWNER openbot;"
    PGPASSWORD=$PW "$PG_BIN/pg_restore" -w -h 127.0.0.1 -p "$OLD" -U openbot -d restored "$dump" 2>"$T/restore.err" ||
      fail "$what: pg_restore: $(cat "$T/restore.err")"
    [ "$(sql "$OLD" openbot restored "SELECT count(*) FROM notes;")" = 500 ] || fail "$what: restored notes differ"
    clean && pass "$what"
  fi
  sql "$OLD" openbot postgres "ALTER ROLE xiongbao_role_writer RENAME TO openbot_role_writer;"
  sql "$OLD" openbot postgres "DROP DATABASE IF EXISTS restored;"
fi

# 7. migration failure leaves the backup and prints its path: the step stand-in fails as a migration
#    that rolled back would; the container must say which step, which data, and where the backup is.
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
elif [ ! -f "$BACKUP/rebrand-failed" ] || [ "$(mode_of "$BACKUP/rebrand-failed")" != 600 ]; then fail "$what: no 0600 failure marker"
else pass "$what"; fi

# 8. a failed attempt is not retried with a fresh backup on restart: the restart policy brings the
#    container straight back, and each boot would otherwise add a dump until the disk filled.
preflight "$OLD" openbot openbot
what="a failed attempt is not retried with a fresh backup on restart"
if [ "$code" -eq 0 ]; then fail "$what: exit 0"
elif [ "$(backups)" -ne "$count" ]; then fail "$what: $(backups) backups, was $count"
elif ! grep -qF "$dump" "$T/err" || ! grep -q "数据库迁移" "$T/err"; then fail "$what: earlier failure not repeated: $(cat "$T/err")"
elif ! grep -q "rebrand-failed" "$T/err"; then fail "$what: no way to retry given: $(cat "$T/err")"
else pass "$what"; fi
rm -f "$BACKUP/rebrand-failed"
sleep 1
preflight "$OLD" openbot openbot
[ "$code" -eq 0 ] && [ "$(backups)" -eq $((count + 1)) ] && pass "removing the marker allows a new attempt" ||
  fail "removing the marker allows a new attempt: exit $code, $(backups) backups: $(cat "$T/err")"

# 9. the read-only self-check reads the same numbers from a real database. A stand-in `docker` runs the
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
      test) exit 0 ;;
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

# 10. nothing above ever printed the database password.
if grep -qF "$PW" "$ALL"; then fail "the password was printed"; else pass "no output carries the password"; fi

exit "$rc"
