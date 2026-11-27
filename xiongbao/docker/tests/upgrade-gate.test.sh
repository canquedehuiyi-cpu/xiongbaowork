#!/bin/sh
# upgrade-gate.sh (the embedded database's check that its volume has been through v0.2.16).
#
#   CI, inside the delivery image (its dash):
#     docker run --rm --user root --entrypoint /bin/sh -v "$PWD:/repo:ro" xiongbao:trackb \
#       /repo/docker/tests/upgrade-gate.test.sh
#   Anywhere:  sh docker/tests/upgrade-gate.test.sh
#
# The script reads two things, the rename record on the volume and the names migrate.sh hands it, and
# connects to nothing, so no database is needed. The migration journal half of the check is the
# migrator's (server/tests/upgrade-gate.test.ts, server/tests/migration-baseline.test.ts). Any failed
# assertion exits 1.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
GATE=$HERE/../s6/scripts/upgrade-gate.sh
T=$(mktemp -d)
rc=0
trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL: $1" >&2; rc=1; }
pass() { echo "ok - $1"; }

mkdir -p "$T/backup"
# gate <user> <db>: one run; exit code in $code, output in $T/out and $T/err.
gate() {
  env UPGRADE_GATE_RECORD="$T/backup/rebrand-in-progress" \
    sh "$GATE" -h 127.0.0.1 -U "$1" -d "$2" >"$T/out" 2>"$T/err" </dev/null
  code=$?
}
passes() { [ "$code" -eq 0 ] && [ ! -s "$T/out" ] && [ ! -s "$T/err" ]; }
refuses() { # what to find in the refusal
  [ "$code" -eq 1 ] && [ ! -s "$T/out" ] && grep -q '请先升级到 v0.2.16' "$T/err" && grep -q '没有改动任何数据' "$T/err" &&
    grep -q "$1" "$T/err"
}

# 1. a volume under the names every volume has since v0.2.16 (new ones are created under them): passes,
#    silently.
gate xiongbao xiongbao
passes && pass "a volume under the new names passes" || fail "new names: exit $code: $(cat "$T/out" "$T/err")"

# 2. any other superuser or database name: a volume v0.2.16 never renamed. Refused, naming what it found.
gate legacy_owner xiongbao
refuses "超级用户是 legacy_owner、库是 xiongbao" && pass "another superuser name is refused" ||
  fail "another superuser: exit $code: $(cat "$T/out" "$T/err")"
gate xiongbao legacy_data
refuses "库是 legacy_data" && pass "another database name is refused" ||
  fail "another database: exit $code: $(cat "$T/out" "$T/err")"

# 3. v0.2.16's in-progress record on the volume: v0.2.16 began its rename and did not finish it. Refused,
#    whatever the names say, naming the record; a dangling link in its place counts as the record.
: >"$T/backup/rebrand-in-progress"
gate xiongbao xiongbao
refuses "rebrand-in-progress" && grep -q '还没有做完' "$T/err" && pass "v0.2.16's unfinished rename is refused" ||
  fail "v0.2.16's record: exit $code: $(cat "$T/out" "$T/err")"
rm -f "$T/backup/rebrand-in-progress"
ln -s "$T/nowhere" "$T/backup/rebrand-in-progress"
gate xiongbao xiongbao
refuses "rebrand-in-progress" && pass "a dangling link in the record's place is refused too" ||
  fail "the record as a dangling link: exit $code: $(cat "$T/out" "$T/err")"
rm -f "$T/backup/rebrand-in-progress"

# 4. usage: a missing host or a name that is not an identifier is a usage error.
sh "$GATE" -U xiongbao -d xiongbao >/dev/null 2>&1
[ "$?" -eq 2 ] || fail "a missing host is not a usage error"
sh "$GATE" -h 127.0.0.1 -U "x;y" -d xiongbao >/dev/null 2>&1
[ "$?" -eq 2 ] && pass "usage errors exit 2" || fail "a name that is not an identifier is not a usage error"

exit "$rc"
