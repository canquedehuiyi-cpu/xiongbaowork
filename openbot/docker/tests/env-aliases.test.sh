#!/bin/sh
# env-aliases.sh against a temp directory standing in for /run/s6/container_environment.
# Runs on the CI host, no image needed:  sh docker/tests/env-aliases.test.sh
# Any failed assertion exits 1.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT=$HERE/../s6/scripts/env-aliases.sh
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
rc=0

fail() { echo "FAIL: $1" >&2; rc=1; }
# Compare a file's exact bytes: s6 container_environment files carry no trailing newline.
expect_file() { # dir name value
  if [ ! -f "$1/$2" ]; then fail "$2 missing"; return; fi
  got=$(cat "$1/$2")
  [ "$got" = "$3" ] || fail "$2 is '$got', wanted '$3'"
}

# 1. legacy only: untouched, silent
d=$T/legacy; mkdir "$d"
printf %s http://old > "$d/OPENBOT_PUBLIC_URL"
err=$(sh "$SCRIPT" "$d" 2>&1 >/dev/null) || fail "legacy-only exited non-zero"
expect_file "$d" OPENBOT_PUBLIC_URL http://old
[ -z "$err" ] || fail "legacy-only warned: $err"
[ "$(ls "$d" | wc -l)" -eq 1 ] || fail "legacy-only created files"

# 2. new only: copied to the legacy name, silent
d=$T/new; mkdir "$d"
printf %s http://new > "$d/XIONGBAO_PUBLIC_URL"
err=$(sh "$SCRIPT" "$d" 2>&1 >/dev/null) || fail "new-only exited non-zero"
expect_file "$d" OPENBOT_PUBLIC_URL http://new
expect_file "$d" XIONGBAO_PUBLIC_URL http://new
[ -z "$err" ] || fail "new-only warned: $err"

# 3. conflict: new wins, exactly one warning line naming the legacy variable; equal pair is silent
d=$T/both; mkdir "$d"
printf %s http://new > "$d/XIONGBAO_PUBLIC_URL"
printf %s http://old > "$d/OPENBOT_PUBLIC_URL"
printf %s refuse > "$d/XIONGBAO_RLS_ENFORCE"
printf %s refuse > "$d/OPENBOT_RLS_ENFORCE"
err=$(sh "$SCRIPT" "$d" 2>&1 >/dev/null) || fail "conflict exited non-zero"
expect_file "$d" OPENBOT_PUBLIC_URL http://new
expect_file "$d" OPENBOT_RLS_ENFORCE refuse
[ "$(printf %s "$err" | grep -c .)" -eq 1 ] || fail "wanted one warning line, got: $err"
case $err in *OPENBOT_PUBLIC_URL*) ;; *) fail "warning does not name OPENBOT_PUBLIC_URL: $err" ;; esac

# 4. empty-suffix name is ignored
d=$T/bare; mkdir "$d"
printf %s x > "$d/XIONGBAO_"
sh "$SCRIPT" "$d" 2>/dev/null || fail "bare prefix exited non-zero"
[ ! -e "$d/OPENBOT_" ] || fail "bare XIONGBAO_ was copied"

# 5. missing directory is a no-op, not a failure that would block container start
sh "$SCRIPT" "$T/nonexistent" 2>/dev/null || fail "missing directory exited non-zero"

[ "$rc" -eq 0 ] && echo "env-aliases.sh: all passed"
exit "$rc"
