#!/bin/sh
# upgrade-gate.sh (the embedded database's check that its volume has been through v0.2.16) against real
# PostgreSQL clusters this file creates with initdb, standing each at a shape a volume can be in.
#
#   CI, inside the delivery image (its PostgreSQL 16, its dash):
#     docker run --rm --user root --entrypoint /bin/sh -v "$PWD:/repo:ro" xiongbao:trackb \
#       /repo/docker/tests/upgrade-gate.test.sh
#   On a machine with PostgreSQL 16:  sh docker/tests/upgrade-gate.test.sh
#   (PG_BIN overrides /usr/lib/postgresql/16/bin. As root, the clusters run as postgres, which must be able
#   to reach TMPDIR; as any other user they run as that user.)
#
# The migration journal is laid down by hand: only which hashes it holds matters to the check, and this way
# the test needs no migrator. Any failed assertion exits 1.
#
# The superuser and database names before v0.2.16 are the input under test: a new volume is still created
# under them (until the migrations are squashed into a baseline), and a volume v0.2.15 made carries them.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
GATE=$HERE/../s6/scripts/upgrade-gate.sh
SQL_DIR=$(cd "$HERE/../../server/recovery/recovery-20261018-v1/sql" && pwd)
PG_BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
T=$(mktemp -d)
chmod 755 "$T"
rc=0
CLUSTERS=""

as_pg() {
  if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi
}
cleanup() {
  for d in $CLUSTERS; do as_pg "$PG_BIN/pg_ctl" -D "$d" -m immediate -w stop >/dev/null 2>&1 || true; done
  rm -rf "$T"
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; rc=1; }
pass() { echo "ok - $1"; }

[ -e "$PG_BIN/initdb" ] || { echo "FAIL: missing $PG_BIN/initdb (set PG_BIN)" >&2; exit 1; }
PW=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')

# cluster <name> <superuser> <database>: initdb under that superuser with scram, the database created, on a
# free loopback port left in $port.
cluster() {
  d=$T/$1
  mkdir -p "$d"
  printf '%s' "$PW" >"$d/pwfile"
  [ "$(id -u)" = 0 ] && chown -R postgres:postgres "$d"
  as_pg "$PG_BIN/initdb" -D "$d/data" -A scram-sha-256 -U "$2" --pwfile="$d/pwfile" >"$d/initdb.log" 2>&1 ||
    { echo "initdb failed: $(tail -n 5 "$d/initdb.log")" >&2; return 1; }
  CLUSTERS="$CLUSTERS $d/data"
  port=$((20000 + ($$ + ${#CLUSTERS} * 13) % 20000))
  tries=0
  until as_pg "$PG_BIN/pg_ctl" -D "$d/data" -l "$d/server.log" -w -t 20 \
    -o "-c listen_addresses=127.0.0.1 -c port=$port -c unix_socket_directories=$d" start >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 20 ] || { echo "could not start $1: $(tail -n 5 "$d/server.log")" >&2; return 1; }
    port=$((port + 7))
  done
  [ "$3" = postgres ] || PGPASSWORD=$PW "$PG_BIN/createdb" -w -h 127.0.0.1 -p "$port" -U "$2" "$3" || return 1
}
sql() { # port user db statement
  PGOPTIONS='-c client_min_messages=warning' PGPASSWORD=$PW "$PG_BIN/psql" -X -q -A -t -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$1" -U "$2" -d "$3" -c "$4"
}
hash_of() { sha256sum "$SQL_DIR/$1.sql" | cut -d' ' -f1; }
# journal <port> <user> <db> <hash...>: the migrator's journal holding exactly these hashes.
journal() {
  j_port=$1 j_user=$2 j_db=$3
  shift 3
  sql "$j_port" "$j_user" "$j_db" "DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);" || return 1
  for h in "$@"; do sql "$j_port" "$j_user" "$j_db" "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('$h', 1);" || return 1; done
}
# gate <port> <user> <db> [VAR=value...]: one run; exit code in $code, output in $T/out and $T/err.
gate() {
  g_port=$1 g_user=$2 g_db=$3
  shift 3
  env PGPASSWORD="$PW" UPGRADE_GATE_PG_BIN="$PG_BIN" UPGRADE_GATE_SQL_DIR="$SQL_DIR" \
    UPGRADE_GATE_RECORD="$T/backup/rebrand-in-progress" "$@" \
    sh "$GATE" -h 127.0.0.1 -p "$g_port" -U "$g_user" -d "$g_db" >"$T/out" 2>"$T/err" </dev/null
  code=$?
}
passes() { [ "$code" -eq 0 ] && [ ! -s "$T/out" ] && [ ! -s "$T/err" ]; }
refuses() { # what to find in the refusal
  [ "$code" -eq 1 ] && [ ! -s "$T/out" ] && grep -q '请先升级到 v0.2.16' "$T/err" && grep -q '没有改动任何数据' "$T/err" &&
    grep -q "$1" "$T/err"
}
mkdir -p "$T/backup"

# The superuser and database a v0.2.15 volume carried, assembled so the source never spells them.
OLD_USER=open
OLD_USER=${OLD_USER}bot
OLD_DB=$OLD_USER
cluster old "$OLD_USER" "$OLD_DB" || exit 1
O=$port
R240=$(hash_of 0240_rebrand_names)
R241=$(hash_of 0241_rebrand_history)

# 1. a new volume (no journal yet) under the names postgres-init still gives it migrates: passes, silently.
gate "$O" "$OLD_USER" "$OLD_DB"
passes && pass "a new volume under the old names passes" || fail "a new volume: exit $code: $(cat "$T/out" "$T/err")"

# 2. a volume v0.2.15 made: old names and a journal without the rename migrations. Refused, naming the
#    superuser and database it found and the migrations it lacks; the journal is as it was.
journal "$O" "$OLD_USER" "$OLD_DB" 1111 2222 || exit 1
gate "$O" "$OLD_USER" "$OLD_DB"
refuses "超级用户是 $OLD_USER、库是 $OLD_DB" && grep -q '0240、0241' "$T/err" &&
  [ "$(sql "$O" "$OLD_USER" "$OLD_DB" 'SELECT count(*) FROM drizzle.__drizzle_migrations;')" = 2 ] &&
  pass "a volume v0.2.15 made is refused before anything changes" ||
  fail "a volume v0.2.15 made: exit $code: $(cat "$T/out" "$T/err")"

# 3. only one of the two rename migrations recorded: refused the same way.
journal "$O" "$OLD_USER" "$OLD_DB" 1111 "$R240" || exit 1
gate "$O" "$OLD_USER" "$OLD_DB"
refuses "0240、0241" && pass "a journal with only one rename migration is refused" ||
  fail "one rename migration: exit $code: $(cat "$T/out" "$T/err")"

# 4. both recorded under the old names: a first boot (or v0.2.16's upgrade) migrated and stopped before the
#    last step, the superuser and database rename, which migrate.sh runs next. Passes, silently.
journal "$O" "$OLD_USER" "$OLD_DB" 1111 "$R240" "$R241" || exit 1
gate "$O" "$OLD_USER" "$OLD_DB"
passes && pass "a migrated volume whose rename is still to run passes" || fail "rename still to run: exit $code: $(cat "$T/out" "$T/err")"

# 5. v0.2.16's in-progress record on the volume: v0.2.16 began its rename and did not finish it. Refused,
#    whatever the names and the journal say, naming the record.
: >"$T/backup/rebrand-in-progress"
gate "$O" "$OLD_USER" "$OLD_DB"
refuses "rebrand-in-progress" && grep -q '还没有做完' "$T/err" && pass "v0.2.16's unfinished rename is refused" ||
  fail "v0.2.16's record: exit $code: $(cat "$T/out" "$T/err")"
rm -f "$T/backup/rebrand-in-progress"
ln -s "$T/nowhere" "$T/backup/rebrand-in-progress"
gate "$O" "$OLD_USER" "$OLD_DB"
refuses "rebrand-in-progress" && pass "a dangling link in the record's place is refused too" ||
  fail "the record as a dangling link: exit $code: $(cat "$T/out" "$T/err")"
rm -f "$T/backup/rebrand-in-progress"

# 6. a journal the check cannot read (the password does not match): refused, saying it could not tell.
env PGPASSWORD=wrong UPGRADE_GATE_PG_BIN="$PG_BIN" UPGRADE_GATE_SQL_DIR="$SQL_DIR" UPGRADE_GATE_RECORD="$T/backup/rebrand-in-progress" \
  sh "$GATE" -h 127.0.0.1 -p "$O" -U "$OLD_USER" -d "$OLD_DB" >"$T/out" 2>"$T/err" </dev/null
code=$?
[ "$code" -eq 1 ] && grep -q '读不出这个库的迁移记录' "$T/err" && pass "a journal that cannot be read is refused" ||
  fail "unreadable journal: exit $code: $(cat "$T/out" "$T/err")"

# 7. a volume under the new names passes without asking the database anything (the migrator checks the
#    rest), and the record refuses it too.
cluster new xiongbao xiongbao || exit 1
N=$port
journal "$N" xiongbao xiongbao 1111 || exit 1
gate "$N" xiongbao xiongbao
passes && pass "a volume under the new names passes" || fail "new names: exit $code: $(cat "$T/out" "$T/err")"
: >"$T/backup/rebrand-in-progress"
gate "$N" xiongbao xiongbao
refuses "rebrand-in-progress" && pass "the record refuses a volume under the new names too" ||
  fail "record under new names: exit $code: $(cat "$T/out" "$T/err")"
rm -f "$T/backup/rebrand-in-progress"

# 8. usage: a missing host or a name that is not an identifier is a usage error, before any connection.
sh "$GATE" -U xiongbao -d xiongbao >/dev/null 2>&1
[ "$?" -eq 2 ] || fail "a missing host is not a usage error"
sh "$GATE" -h 127.0.0.1 -U "x;y" -d xiongbao >/dev/null 2>&1
[ "$?" -eq 2 ] && pass "usage errors exit 2" || fail "a name that is not an identifier is not a usage error"

# 9. nothing printed the password.
grep -rqF "$PW" "$T/out" "$T/err" && fail "a password was printed" || pass "no output carries a password"

exit "$rc"
