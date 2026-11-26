#!/bin/sh
# env-defaults.sh against a temp directory standing in for /run/s6/container_environment.
# Runs on the CI host, no image needed:  sh docker/tests/env-defaults.test.sh
# As root and as any other user alike: it only reads and writes files in the directory it is given.
# Any failed assertion exits 1.
#
# The old OPENBOT_ spellings below are the input under test: an env file still written under them is
# refused, not read.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT=$HERE/../s6/scripts/env-defaults.sh
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
# 1. a setting only under its old name refuses to start: exit 1, the old name named, never its value, and
#    nothing written (not even the image's defaults)
d=$T/legacy; mkdir "$d"
printf %s http://old.example > "$d/OPENBOT_PUBLIC_URL"
err=$(sh "$SCRIPT" "$d" "$HERE/../defaults.env" 2>&1 >/dev/null) && fail "old-only was not refused"
case $err in *OPENBOT_PUBLIC_URL*) ;; *) fail "the refusal does not name OPENBOT_PUBLIC_URL: $err" ;; esac
case $err in *'请先升级到 v0.2.16'*) ;; *) fail "the refusal does not say to upgrade to v0.2.16 first: $err" ;; esac
case $err in *http://*) fail "the refusal printed a value: $err" ;; esac
[ "$(ls "$d" | tr '\n' ' ')" = "OPENBOT_PUBLIC_URL " ] || fail "old-only wrote files: $(ls "$d" | tr '\n' ' ')"

# 2. new-only deployment reports nothing: untouched, silent, no old name grown
d=$T/new; mkdir "$d"
printf %s http://new > "$d/XIONGBAO_PUBLIC_URL"
err=$(sh "$SCRIPT" "$d" 2>&1 >/dev/null) || fail "new-only exited non-zero"
expect_file "$d" XIONGBAO_PUBLIC_URL http://new
[ "$(ls "$d" | wc -l)" -eq 1 ] || fail "new-only created files: $(ls "$d" | tr '\n' ' ')"
[ -z "$err" ] || fail "new-only warned: $err"

# 3. a setting under both names starts, silently, on the new value: the new one is in effect, as in v0.2.16
d=$T/both; mkdir "$d"
printf %s http://new > "$d/XIONGBAO_PUBLIC_URL"
printf %s http://old > "$d/OPENBOT_PUBLIC_URL"
err=$(sh "$SCRIPT" "$d" 2>&1 >/dev/null) || fail "both set: exited non-zero: $err"
expect_file "$d" XIONGBAO_PUBLIC_URL http://new
[ -z "$err" ] || fail "both set: warned: $err"

# 4. the bare prefix and an empty old value are not settings; every old-only one is named, in one line
d=$T/bare; mkdir "$d"
printf %s x > "$d/OPENBOT_"
: > "$d/OPENBOT_EMPTY"
sh "$SCRIPT" "$d" 2>/dev/null || fail "bare prefix and empty value: exited non-zero"
d=$T/several; mkdir "$d"
printf %s sk-test > "$d/OPENBOT_POOL_OPENAI"
printf %s warn > "$d/OPENBOT_RLS_ENFORCE"
err=$(sh "$SCRIPT" "$d" 2>&1 >/dev/null) && fail "several old-only were not refused"
case $err in *'OPENBOT_POOL_OPENAI, OPENBOT_RLS_ENFORCE'*) ;; *) fail "the refusal does not name both: $err" ;; esac
case $err in *sk-test*) fail "the refusal printed a key: $err" ;; esac
[ "$(printf '%s\n' "$err" | grep -c .)" -eq 1 ] || fail "wanted one line, got: $err"

# 5. an empty new value counts as unset: an old value under it is refused, not read
d=$T/empty-new; mkdir "$d"
: > "$d/XIONGBAO_SINGLE_USER"
printf %s true > "$d/OPENBOT_SINGLE_USER"
err=$(sh "$SCRIPT" "$d" 2>&1 >/dev/null) && fail "empty new over an old value was not refused"
case $err in *OPENBOT_SINGLE_USER*) ;; *) fail "the refusal does not name OPENBOT_SINGLE_USER: $err" ;; esac

# 6. missing directory is a no-op, not a failure that would block container start
sh "$SCRIPT" "$T/nonexistent" 2>/dev/null || fail "missing directory exited non-zero"

# 7. the env file the JD cloud deployment runs on after v0.2.16's upgrade sheet (names as measured
#    2026-11-24, renamed; values made up): starts, silently, with the image's defaults under it
d=$T/delivery; mkdir "$d"
printf %s https://work.example.cn > "$d/XIONGBAO_PUBLIC_URL"
printf %s refuse > "$d/XIONGBAO_RLS_ENFORCE"
printf %s false > "$d/XIONGBAO_SELF_HOST_BANNER"
printf %s true > "$d/XIONGBAO_SINGLE_USER"
printf %s 3773 > "$d/XIONGBAO_CONTENT_PORT"
err=$(sh "$SCRIPT" "$d" "$HERE/../defaults.env" 2>&1 >/dev/null) || fail "delivery env exited non-zero: $err"
expect_file "$d" XIONGBAO_PUBLIC_URL https://work.example.cn
expect_file "$d" XIONGBAO_IN_CONTAINER true
[ -z "$err" ] || fail "delivery env warned: $err"
# The same file before v0.2.16's upgrade sheet renamed it is refused, every old name named.
d=$T/delivery-old; mkdir "$d"
printf %s https://work.example.cn > "$d/OPENBOT_PUBLIC_URL"
printf %s refuse > "$d/OPENBOT_RLS_ENFORCE"
printf %s false > "$d/OPENBOT_SELF_HOST_BANNER"
printf %s true > "$d/OPENBOT_SINGLE_USER"
printf %s 3773 > "$d/XIONGBAO_CONTENT_PORT"
err=$(sh "$SCRIPT" "$d" "$HERE/../defaults.env" 2>&1 >/dev/null) && fail "the delivery env before the rename was not refused"
case $err in *'OPENBOT_PUBLIC_URL, OPENBOT_RLS_ENFORCE, OPENBOT_SELF_HOST_BANNER, OPENBOT_SINGLE_USER'*) ;; *) fail "the delivery refusal does not name all four: $err" ;; esac

# --- Image defaults (docker/defaults.env, L1-10): the lowest priority, written only when neither name is set.
DEFAULTS=$HERE/../defaults.env

# 9. neither name set: the default lands under the new name only
d=$T/defaults-none; mkdir "$d"
err=$(sh "$SCRIPT" "$d" "$DEFAULTS" 2>&1 >/dev/null) || fail "neither set: exited non-zero"
expect_file "$d" XIONGBAO_RLS_ENFORCE refuse
expect_file "$d" XIONGBAO_SELF_HOST_BANNER false
expect_file "$d" XIONGBAO_IN_CONTAINER true
[ -z "$err" ] || fail "neither set: warned: $err"

# 10. the new name set: it stays, and the default does not touch it
d=$T/defaults-new; mkdir "$d"
printf %s warn > "$d/XIONGBAO_RLS_ENFORCE"
err=$(sh "$SCRIPT" "$d" "$DEFAULTS" 2>&1 >/dev/null) || fail "XIONGBAO_RLS_ENFORCE=warn set: exited non-zero"
expect_file "$d" XIONGBAO_RLS_ENFORCE warn
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
#     deployment's own identity wins; without one, the image's applies
cat "$DEFAULTS" > "$T/build.env"
printf '%s\n' 'BUILD_VERSION=v2' >> "$T/build.env"
d=$T/build-own; mkdir "$d"
printf %s v1 > "$d/XIONGBAO_BUILD_VERSION"
sh "$SCRIPT" "$d" "$T/build.env" 2>/dev/null || fail "build identity, own set: exited non-zero"
expect_file "$d" XIONGBAO_BUILD_VERSION v1
d=$T/build-none; mkdir "$d"
sh "$SCRIPT" "$d" "$T/build.env" 2>/dev/null || fail "build identity, none set: exited non-zero"
expect_file "$d" XIONGBAO_BUILD_VERSION v2

# 14. a third party's own variable (docker/defaults.env, appendix A row 7): written as it is when unset, never
#     under a XIONGBAO_ name, and the deployment's own value is left alone
d=$T/third-party-none; mkdir "$d"
sh "$SCRIPT" "$d" "$DEFAULTS" 2>/dev/null || fail "third-party default, none set: exited non-zero"
expect_file "$d" DO_NOT_TRACK 1
[ ! -e "$d/XIONGBAO_DO_NOT_TRACK" ] || fail "third-party default: XIONGBAO_ copy was written"
d=$T/third-party-set; mkdir "$d"
printf %s 0 > "$d/DO_NOT_TRACK"
sh "$SCRIPT" "$d" "$DEFAULTS" 2>/dev/null || fail "third-party default, set to 0: exited non-zero"
expect_file "$d" DO_NOT_TRACK 0

[ "$rc" -eq 0 ] && echo "env-defaults.sh: all passed"
exit "$rc"
