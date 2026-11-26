#!/bin/sh
# env-aliases.sh against a temp directory standing in for /run/s6/container_environment.
# Runs on the CI host, no image needed:  sh docker/tests/env-aliases.test.sh
# Any failed assertion exits 1.
#
# The old OPENBOT_ spellings below are the point of this file: they prove that an env file written
# before the rename still configures the container.
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
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

# Cases 1-6 pass no defaults file, so the script reads /etc/xiongbao/defaults.env if it is there: they
# run on the CI host, which has none, not inside the image.
# 1. old-only deployment reads the new name: copied under the new name, the old file kept, silent
#    (the server names the old names in use when it starts, so the container does not say it twice)
d=$T/legacy; mkdir "$d"
printf %s http://old > "$d/OPENBOT_PUBLIC_URL"
err=$(sh "$SCRIPT" "$d" 2>&1 >/dev/null) || fail "old-only exited non-zero"
expect_file "$d" XIONGBAO_PUBLIC_URL http://old
expect_file "$d" OPENBOT_PUBLIC_URL http://old
[ -z "$err" ] || fail "old-only warned: $err"

# 2. new-only deployment reports nothing: untouched, silent, no old name grown
d=$T/new; mkdir "$d"
printf %s http://new > "$d/XIONGBAO_PUBLIC_URL"
err=$(sh "$SCRIPT" "$d" 2>&1 >/dev/null) || fail "new-only exited non-zero"
expect_file "$d" XIONGBAO_PUBLIC_URL http://new
[ "$(ls "$d" | wc -l)" -eq 1 ] || fail "new-only created files: $(ls "$d" | tr '\n' ' ')"
[ -z "$err" ] || fail "new-only warned: $err"

# 3. conflicting old and new names keep the new value and report the old name: exactly one warning
#    line, naming the old variable and never a value; an equal pair is silent
d=$T/both; mkdir "$d"
printf %s http://new > "$d/XIONGBAO_PUBLIC_URL"
printf %s http://old > "$d/OPENBOT_PUBLIC_URL"
printf %s refuse > "$d/XIONGBAO_RLS_ENFORCE"
printf %s refuse > "$d/OPENBOT_RLS_ENFORCE"
err=$(sh "$SCRIPT" "$d" 2>&1 >/dev/null) || fail "conflict exited non-zero"
expect_file "$d" XIONGBAO_PUBLIC_URL http://new
expect_file "$d" XIONGBAO_RLS_ENFORCE refuse
[ "$(printf %s "$err" | grep -c .)" -eq 1 ] || fail "wanted one warning line, got: $err"
case $err in *OPENBOT_PUBLIC_URL*) ;; *) fail "warning does not name OPENBOT_PUBLIC_URL: $err" ;; esac
case $err in *http://*) fail "warning printed a value: $err" ;; esac

# 4. the bare prefix, an empty old value and a platform model key are not copied
d=$T/bare; mkdir "$d"
printf %s x > "$d/OPENBOT_"
: > "$d/OPENBOT_EMPTY"
printf %s sk-test > "$d/OPENBOT_POOL_OPENAI"
sh "$SCRIPT" "$d" 2>/dev/null || fail "bare prefix exited non-zero"
[ ! -e "$d/XIONGBAO_" ] || fail "bare OPENBOT_ was copied"
[ ! -e "$d/XIONGBAO_EMPTY" ] || fail "empty OPENBOT_EMPTY was copied"
[ ! -e "$d/XIONGBAO_POOL_OPENAI" ] || fail "OPENBOT_POOL_OPENAI was copied: the database row names it"

# 5. an empty new value counts as unset, as `-e XIONGBAO_X=` leaves it: the old value is copied over it
d=$T/empty-new; mkdir "$d"
: > "$d/XIONGBAO_SINGLE_USER"
printf %s true > "$d/OPENBOT_SINGLE_USER"
err=$(sh "$SCRIPT" "$d" 2>&1 >/dev/null) || fail "empty new exited non-zero"
expect_file "$d" XIONGBAO_SINGLE_USER true
[ -z "$err" ] || fail "empty new warned: $err"

# 6. missing directory is a no-op, not a failure that would block container start
sh "$SCRIPT" "$T/nonexistent" 2>/dev/null || fail "missing directory exited non-zero"

# 7. the env file the JD cloud deployment runs on (names as measured 2026-11-24, values made up):
#    every old name lands under its new name, the one already new is left alone, nothing warns
d=$T/delivery; mkdir "$d"
printf %s https://work.example.cn > "$d/OPENBOT_PUBLIC_URL"
printf %s refuse > "$d/OPENBOT_RLS_ENFORCE"
printf %s false > "$d/OPENBOT_SELF_HOST_BANNER"
printf %s true > "$d/OPENBOT_SINGLE_USER"
printf %s 3773 > "$d/XIONGBAO_CONTENT_PORT"
err=$(sh "$SCRIPT" "$d" "$HERE/../defaults.env" 2>&1 >/dev/null) || fail "delivery env exited non-zero"
expect_file "$d" XIONGBAO_PUBLIC_URL https://work.example.cn
expect_file "$d" XIONGBAO_RLS_ENFORCE refuse
expect_file "$d" XIONGBAO_SELF_HOST_BANNER false
expect_file "$d" XIONGBAO_SINGLE_USER true
expect_file "$d" XIONGBAO_CONTENT_PORT 3773
expect_file "$d" XIONGBAO_IN_CONTAINER true
[ ! -e "$d/OPENBOT_CONTENT_PORT" ] || fail "delivery env: XIONGBAO_CONTENT_PORT was copied back to the old name"
[ ! -e "$d/OPENBOT_IN_CONTAINER" ] || fail "delivery env: the image default was written under the old name"
[ -z "$err" ] || fail "delivery env warned: $err"

# --- Image defaults (docker/defaults.env, L1-10): the lowest priority, written only when neither name is set.
DEFAULTS=$HERE/../defaults.env

# 8. only the old name set: the default does not override it; its value lands under the new name
d=$T/defaults-legacy; mkdir "$d"
printf %s warn > "$d/OPENBOT_RLS_ENFORCE"
err=$(sh "$SCRIPT" "$d" "$DEFAULTS" 2>&1 >/dev/null) || fail "only OPENBOT_RLS_ENFORCE=warn set: exited non-zero"
expect_file "$d" XIONGBAO_RLS_ENFORCE warn
expect_file "$d" OPENBOT_RLS_ENFORCE warn
[ -z "$err" ] || fail "only OPENBOT_RLS_ENFORCE=warn set: warned: $err"

# 9. neither name set: the default lands under the new name only
d=$T/defaults-none; mkdir "$d"
err=$(sh "$SCRIPT" "$d" "$DEFAULTS" 2>&1 >/dev/null) || fail "neither set: exited non-zero"
expect_file "$d" XIONGBAO_RLS_ENFORCE refuse
expect_file "$d" XIONGBAO_SELF_HOST_BANNER false
expect_file "$d" XIONGBAO_IN_CONTAINER true
[ ! -e "$d/OPENBOT_RLS_ENFORCE" ] || fail "neither set: the default was written under the old name"
[ -z "$err" ] || fail "neither set: warned: $err"

# 10. the new name set: it stays, and the default does not touch it
d=$T/defaults-new; mkdir "$d"
printf %s warn > "$d/XIONGBAO_RLS_ENFORCE"
err=$(sh "$SCRIPT" "$d" "$DEFAULTS" 2>&1 >/dev/null) || fail "XIONGBAO_RLS_ENFORCE=warn set: exited non-zero"
expect_file "$d" XIONGBAO_RLS_ENFORCE warn
[ ! -e "$d/OPENBOT_RLS_ENFORCE" ] || fail "XIONGBAO_RLS_ENFORCE=warn set: copied back to the old name"
[ -z "$err" ] || fail "XIONGBAO_RLS_ENFORCE=warn set: warned: $err"

# 11. no defaults file: nothing written, no error
d=$T/defaults-missing; mkdir "$d"
err=$(sh "$SCRIPT" "$d" "$T/no-such-defaults.env" 2>&1 >/dev/null) || fail "defaults.env missing: exited non-zero"
[ "$(ls "$d" | wc -l)" -eq 0 ] || fail "defaults.env missing: wrote $(ls "$d")"
[ -z "$err" ] || fail "defaults.env missing: warned: $err"

# 12. a defaults file's comments and blank lines are skipped; a value keeps everything after the first =
d=$T/defaults-format; mkdir "$d"
printf '%s\n' '# a comment' '' 'SOME_URL=http://x/?a=b' > "$T/format.env"
sh "$SCRIPT" "$d" "$T/format.env" 2>/dev/null || fail "defaults format: exited non-zero"
expect_file "$d" XIONGBAO_SOME_URL "http://x/?a=b"
[ "$(ls "$d" | wc -l)" -eq 1 ] || fail "defaults format: wrote $(ls "$d" | tr '\n' ' ')"

# 13. a build identity the image's build wrote into the defaults file (Dockerfile, BUILD_<X>): the
#     deployment's own identity under the old name wins; without one, the image's applies
cat "$DEFAULTS" > "$T/build.env"
printf '%s\n' 'BUILD_VERSION=v2' >> "$T/build.env"
d=$T/build-legacy; mkdir "$d"
printf %s v1 > "$d/OPENBOT_BUILD_VERSION"
sh "$SCRIPT" "$d" "$T/build.env" 2>/dev/null || fail "build identity, old name set: exited non-zero"
expect_file "$d" XIONGBAO_BUILD_VERSION v1
d=$T/build-none; mkdir "$d"
sh "$SCRIPT" "$d" "$T/build.env" 2>/dev/null || fail "build identity, none set: exited non-zero"
expect_file "$d" XIONGBAO_BUILD_VERSION v2
[ ! -e "$d/OPENBOT_BUILD_VERSION" ] || fail "build identity, none set: written under the old name"

# 14. a third party's own variable (docker/defaults.env, appendix A row 7): written as it is when unset, never
#     under a XIONGBAO_ or OPENBOT_ name, and the deployment's own value is left alone
d=$T/third-party-none; mkdir "$d"
sh "$SCRIPT" "$d" "$DEFAULTS" 2>/dev/null || fail "third-party default, none set: exited non-zero"
expect_file "$d" DO_NOT_TRACK 1
[ ! -e "$d/XIONGBAO_DO_NOT_TRACK" ] || fail "third-party default: XIONGBAO_ copy was written"
[ ! -e "$d/OPENBOT_DO_NOT_TRACK" ] || fail "third-party default: OPENBOT_ copy was written"
d=$T/third-party-set; mkdir "$d"
printf %s 0 > "$d/DO_NOT_TRACK"
sh "$SCRIPT" "$d" "$DEFAULTS" 2>/dev/null || fail "third-party default, set to 0: exited non-zero"
expect_file "$d" DO_NOT_TRACK 0

[ "$rc" -eq 0 ] && echo "env-aliases.sh: all passed"
exit "$rc"
