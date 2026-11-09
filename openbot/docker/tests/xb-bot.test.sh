#!/bin/sh
# The root helper, tested as root inside the delivery image (it creates users, so nowhere else):
#
#   docker run --rm --user root --entrypoint /bin/sh -v "$PWD/docker/tests:/t:ro" openbot:trackb /t/xb-bot.test.sh
#
# Any failed assertion exits 1.
set -u
XB=/usr/local/sbin/xb-bot
A=aaaaaaaaaaa1
B=bbbbbbbbbbb2
C=ccccccccccc3
D=ddddddddddd4
E=eeeeeeeeeee5
F=fffffffffff6
G=aaaaaaaaaab7
H=aaaaaaaaaac8
DIRA=/workspace/bots/$A
T=$(mktemp -d)

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() {
  echo "ok - $*"
}
# expect_code <code> <description> -- command...
expect_code() {
  want=$1
  what=$2
  shift 3
  "$@" >"$T/out" 2>"$T/err" </dev/null
  got=$?
  [ "$got" = "$want" ] || fail "$what: exit $got, want $want ($(head -c 300 "$T/err"))"
  pass "$what"
}
# as <key> <timeout> <stdin text>: run through the helper, stdout to $T/out, stderr to $T/err.
as() {
  printf '%s' "$3" | "$XB" run "$1" "$2" >"$T/out" 2>"$T/err"
}
none_left() {
  # $1: pgrep arguments
  # shellcheck disable=SC2086
  left=$(pgrep $1 || true)
  [ -z "$left" ]
}

# What s6 does at container start. A container environment to protect, as /init would leave it.
mkdir -p /run/s6/container_environment
echo secret-token >/run/s6/container_environment/COMPUTER_TOKEN
chmod 0755 /run/s6/container_environment
chmod 0644 /run/s6/container_environment/COMPUTER_TOKEN
COMPUTER_PER_BOT_USERS=on "$XB" restore || fail "restore at start exited $?"
pass "restore at start"
[ "$(stat -c '%U %a' /run/xb-bot)" = "root 700" ] || fail "/run/xb-bot is $(stat -c '%U %a' /run/xb-bot 2>&1)"
[ "$(stat -c '%U %a' /run/xb-bot/lock)" = "root 600" ] || fail "/run/xb-bot/lock is $(stat -c '%U %a' /run/xb-bot/lock 2>&1)"
pass "the lock is root's alone (/run/xb-bot 700, lock 600)"

# --- Arguments --------------------------------------------------------------------------------
expect_code 64 "unknown subcommand is 64" -- "$XB" nope
head -n 1 "$T/err" | grep -q '^xb-bot: ' || fail "a refusal's first stderr line starts with xb-bot: ($(cat "$T/err"))"
pass "refusal is prefixed with xb-bot:"
expect_code 64 "ensure with a bad key is 64" -- "$XB" ensure ABC
expect_code 64 "run with timeout 0 is 64" -- "$XB" run "$A" 0
expect_code 64 "run with timeout 601 is 64" -- "$XB" run "$A" 601
printf '\ntrue\n' | "$XB" run "$D" 10 >/dev/null 2>"$T/err"
code=$?
[ "$code" = 65 ] || fail "run for a key never ensured: exit $code, want 65"
head -n 1 "$T/err" | grep -q '^xb-bot: ' || fail "65 is prefixed with xb-bot:"
pass "run for a key never ensured is 65"

# --- ensure -----------------------------------------------------------------------------------
UA=$("$XB" ensure "$A") || fail "first ensure of A exited $?"
UA2=$("$XB" ensure "$A") || fail "second ensure of A exited $?"
[ "$UA" = "$UA2" ] || fail "ensure is not idempotent: $UA then $UA2"
[ "$UA" -ge 20000 ] && [ "$UA" -le 59999 ] || fail "uid $UA is outside 20000-59999"
[ "$(id -u "xb-$A")" = "$UA" ] || fail "id -u xb-$A is not $UA"
pass "ensure is idempotent and the uid ($UA) is in range"
[ "$(stat -c '%U:%G %a' "$DIRA")" = "xb-$A:xbcomp 2770" ] || fail "A's directory is $(stat -c '%U:%G %a' "$DIRA")"
[ "$(stat -c '%U %a' "$DIRA/.tmp")" = "xb-$A 700" ] || fail "A's .tmp is $(stat -c '%U %a' "$DIRA/.tmp")"
getfacl -p "$DIRA" 2>/dev/null | grep -q "^default:user:pwuser:rwx" || fail "A's directory has no default ACL for pwuser"
[ "$(stat -c '%U %a' /workspace/.xb-users)" = "root 600" ] || fail "the map is $(stat -c '%U %a' /workspace/.xb-users)"
grep -q "^$A $UA\$" /workspace/.xb-users || fail "the map has no line for A"
pass "A's directory, .tmp, ACL and map line"
UB=$("$XB" ensure "$B") || fail "ensure of B exited $?"
[ "$UB" != "$UA" ] || fail "A and B share uid $UA"
GA=$(id -g "xb-$A")

# Each employee its own primary group; xbbots only as a supplementary one.
as "$A" 10 '
id -gn
id -Gn
' || fail "id as A exited $?"
[ "$(sed -n 1p "$T/out")" = "xb-$A" ] || fail "A's primary group is $(sed -n 1p "$T/out"), want xb-$A"
case " $(sed -n 2p "$T/out") " in
  *" xbbots "*) ;;
  *) fail "A is not in xbbots: $(sed -n 2p "$T/out")" ;;
esac
pass "A has its own primary group, with xbbots supplementary"
as "$A" 10 '
echo group-private > /tmp/a-group.txt && chmod 0640 /tmp/a-group.txt
' || fail "A could not write /tmp/a-group.txt"
as "$B" 10 '
cat /tmp/a-group.txt
' && fail "B read A's group-readable file in /tmp: $(cat "$T/out")"
pass "B cannot read A's group-readable file in /tmp"

# Employees may not install system packages; pwuser (the default employee) still may.
as "$A" 10 '
sudo -n apt-get --version
' && fail "employee A may sudo apt-get"
pass "an employee may not sudo apt-get"
# Asked of sudo itself, for every command: whatever else might stop sudo later cannot hide a rule.
sudo -l -U "xb-$A" >"$T/out" 2>&1
grep -q 'not allowed to run sudo' "$T/out" || fail "sudo -l -U xb-$A lists something: $(cat "$T/out")"
pass "sudoers grants an employee nothing"
runuser -u pwuser -- sudo -n apt-get --version >/dev/null 2>"$T/err" || fail "pwuser may no longer sudo apt-get: $(cat "$T/err")"
pass "pwuser may still sudo apt-get"

# --- run --------------------------------------------------------------------------------------
as "$A" 10 'PATH=/usr/bin:/bin

id -u
' || fail "run id -u exited $?"
[ "$(cat "$T/out")" = "$UA" ] || fail "run as A printed $(cat "$T/out"), want $UA"
pass "run executes as A's uid"

start=$(date +%s)
as "$A" 30 '
echo hi; sleep 1000 &
' || fail "run with a background sleep exited $?"
took=$(($(date +%s) - start))
[ "$took" -le 3 ] || fail "run with a background sleep took ${took}s"
grep -q hi "$T/out" || fail "run with a background sleep printed $(cat "$T/out")"
sleep 0.2
none_left "-u xb-$A sleep" || fail "a background sleep outlived its command"
pass "a command's background process ends with it (${took}s)"

printf '\nsleep 1000\n' | "$XB" run "$A" 600 >/dev/null 2>&1 &
helper=$!
sleep 1
none_left "-u xb-$A sleep" && fail "the long sleep did not start"
start=$(date +%s)
kill -s TERM "$helper"
n=0
while kill -s 0 "$helper" 2>/dev/null && [ "$n" -lt 80 ]; do
  sleep 0.1
  n=$((n + 1))
done
kill -s 0 "$helper" 2>/dev/null && fail "the helper was still running 8s after TERM"
wait "$helper" 2>/dev/null
took=$(($(date +%s) - start))
sleep 0.2
none_left "-u xb-$A" || fail "processes of xb-$A left after TERM: $(pgrep -a -u "xb-$A")"
pass "TERM to the helper ends the command's group (${took}s)"

# Stopping one command leaves the same employee's other commands running.
printf '\nsleep 1001\n' | "$XB" run "$A" 600 >/dev/null 2>&1 &
h1=$!
printf '\nsleep 1002\n' | "$XB" run "$A" 600 >/dev/null 2>&1 &
h2=$!
sleep 1
pgrep -u "xb-$A" -f 'sleep 1001' >/dev/null || fail "the first concurrent command did not start"
pgrep -u "xb-$A" -f 'sleep 1002' >/dev/null || fail "the second concurrent command did not start"
kill -s TERM "$h1"
wait "$h1" 2>/dev/null
sleep 0.2
pgrep -u "xb-$A" -f 'sleep 1001' >/dev/null && fail "the stopped command is still running"
pgrep -u "xb-$A" -f 'sleep 1002' >/dev/null || fail "stopping one command ended the employee's other command"
pass "stopping one command leaves the employee's other command running"
kill -s TERM "$h2"
wait "$h2" 2>/dev/null
sleep 0.2
none_left "-u xb-$A" || fail "processes of xb-$A left after stopping both: $(pgrep -a -u "xb-$A")"

# An employee can neither open the helper's lock nor hold up another employee's ensure with it.
as "$A" 10 '
: </run/xb-bot/lock
' && fail "A opened /run/xb-bot/lock"
as "$A" 10 '
: </run/xb-bot.lock
' && fail "A opened /run/xb-bot.lock"
pass "an employee cannot open the helper's lock"
printf '\nflock -x /run/xb-bot/lock sleep 30 & flock -x /run/xb-bot.lock sleep 30 & sleep 30\n' |
  "$XB" run "$A" 60 >/dev/null 2>&1 &
holder=$!
sleep 1
start=$(date +%s)
timeout 20 "$XB" ensure "$B" >"$T/out" 2>"$T/err" || fail "ensure of B while A tried to hold the lock exited $?: $(cat "$T/err")"
took=$(($(date +%s) - start))
[ "$took" -le 5 ] || fail "ensure of B took ${took}s while A tried to hold the lock"
kill -s TERM "$holder"
wait "$holder" 2>/dev/null
pass "ensure of B is not held up by A (${took}s)"

# The command's text is not in any argv another employee can read with ps.
printf '\n: secret-marker-m1; sleep 20\n' | "$XB" run "$A" 30 >/dev/null 2>&1 &
hm=$!
sleep 1
as "$B" 10 '
ps -eo args
' || fail "B could not run ps"
grep -q 'sleep 20' "$T/out" || fail "B's ps does not show A's sleep, so it proves nothing: $(cat "$T/out")"
grep -q secret-marker-m1 "$T/out" && fail "B saw A's command text in ps: $(grep secret-marker-m1 "$T/out")"
kill -s TERM "$hm"
wait "$hm" 2>/dev/null
pass "another employee's ps does not show the command's text"

# The command's fd is closed before it runs, and nothing it prints names /dev/fd/3.
as "$A" 10 '
ls -l /proc/$$/fd/3
' && fail "fd 3 is still open in the employee's shell: $(cat "$T/out")"
pass "fd 3 is closed before the command runs"
as "$A" 10 '
echo "zero=$0"
no-such-command-xb
'
grep -q '/dev/fd/3' "$T/out" "$T/err" && fail "the command's \$0 or errors name /dev/fd/3: $(cat "$T/out" "$T/err")"
grep -q 'no-such-command-xb' "$T/err" || fail "the command's error did not arrive: $(cat "$T/err")"
pass "\$0 and error prefixes do not name /dev/fd/3"

as "$A" 10 '
cat /run/s6/container_environment/COMPUTER_TOKEN
' && fail "A read the container environment: $(cat "$T/out")"
grep -q secret-token "$T/out" && fail "A saw the token"
[ "$(stat -c '%U %a' /run/s6/container_environment)" = "root 700" ] || fail "container environment is $(stat -c '%U %a' /run/s6/container_environment)"
pass "A cannot read the container environment"
as "$A" 10 '
cat /proc/1/environ
' && fail "A read /proc/1/environ"
pass "A cannot read /proc/1/environ"

for i in 1 2 3 4; do
  ("$XB" ensure "$C" >"$T/c$i" 2>"$T/c$i.err"; echo $? >"$T/c$i.code") &
done
wait
UC=$(cat "$T/c1")
for i in 1 2 3 4; do
  [ "$(cat "$T/c$i.code")" = 0 ] || fail "concurrent ensure $i exited $(cat "$T/c$i.code"): $(cat "$T/c$i.err")"
  [ "$(cat "$T/c$i")" = "$UC" ] || fail "concurrent ensure $i printed $(cat "$T/c$i"), want $UC"
done
[ -n "$UC" ] || fail "concurrent ensure printed no uid"
pass "four concurrent ensures agree on uid $UC"

as "$A" 10 '
echo private > secret.txt
' || fail "A could not write in its own directory"
as "$B" 10 "
cat $DIRA/secret.txt
" && fail "B read A's file: $(cat "$T/out")"
grep -q 'Permission denied' "$T/err" || fail "B's cat failed without Permission denied: $(cat "$T/err")"
pass "B cannot read A's file (Permission denied)"

as "$A" 10 '
ls /profiles
' && fail "A listed /profiles"
pass "A cannot list /profiles"
as "$A" 10 '
echo "$TMPDIR"
'
[ "$(cat "$T/out")" = "$DIRA/.tmp" ] || fail "A's TMPDIR is $(cat "$T/out")"
pass "A's TMPDIR is its own .tmp"

runuser -u pwuser -- sh -c "echo from-pwuser > $DIRA/pw.txt" || fail "pwuser could not write into A's directory"
as "$A" 10 '
cat pw.txt && echo appended >> pw.txt
' || fail "A could not read and append a file pwuser wrote: $(cat "$T/err")"
grep -q from-pwuser "$T/out" || fail "A read $(cat "$T/out") from pw.txt"
grep -q appended "$DIRA/pw.txt" || fail "A's append did not land"
pass "A reads and appends what pwuser wrote"
runuser -u pwuser -- cat "$DIRA/secret.txt" >"$T/out" 2>"$T/err" || fail "pwuser could not read A's file: $(cat "$T/err")"
grep -q private "$T/out" || fail "pwuser read $(cat "$T/out")"
pass "pwuser reads what A wrote"

as "$A" 10 'HOME=/x

echo "$HOME"
'
[ "$(cat "$T/out")" = "$DIRA" ] || fail "A's HOME is $(cat "$T/out")"
pass "a HOME line is ignored"

start=$(date +%s)
as "$A" 2 '
sleep 30
'
code=$?
took=$(($(date +%s) - start))
[ "$code" = 124 ] || [ "$code" = 137 ] || fail "timed-out run exited $code"
[ "$took" -le 8 ] || fail "timed-out run took ${took}s"
pass "a timed-out run exits $code after ${took}s"

# --- through sudo, as pwuser ------------------------------------------------------------------
runuser -u pwuser -- sudo -n "$XB" ensure "$B" >"$T/out" 2>"$T/err" || fail "pwuser's sudo ensure failed: $(cat "$T/err")"
[ "$(cat "$T/out")" = "$UB" ] || fail "pwuser's sudo ensure printed $(cat "$T/out")"
printf '\nid -u\n' | runuser -u pwuser -- sudo -n "$XB" run "$B" 10 >"$T/out" 2>"$T/err" || fail "pwuser's sudo run failed: $(cat "$T/err")"
[ "$(cat "$T/out")" = "$UB" ] || fail "pwuser's sudo run printed $(cat "$T/out")"
pass "pwuser may sudo ensure and run"
# Asked of sudo itself, so a refusal by the helper (SUDO_USER set) cannot pass for sudo's.
runuser -u pwuser -- sudo -n -l "$XB" ensure "$B" >/dev/null 2>"$T/err" || fail "sudo -l does not allow pwuser ensure: $(cat "$T/err")"
runuser -u pwuser -- sudo -n -l "$XB" restore >"$T/out" 2>&1 && fail "sudoers allows pwuser restore: $(cat "$T/out")"
pass "sudoers does not allow pwuser restore"

# --- restore ----------------------------------------------------------------------------------
owner_before=$(stat -c %u "$DIRA/secret.txt")
pkill -KILL -u "xb-$A" 2>/dev/null || true
userdel "xb-$A" || fail "userdel xb-$A failed"
id -u "xb-$A" >/dev/null 2>&1 && fail "xb-$A still exists after userdel"
"$XB" restore || fail "restore after userdel exited $?"
[ "$(id -u "xb-$A")" = "$UA" ] || fail "restore recreated xb-$A as $(id -u "xb-$A" 2>&1), want $UA"
[ "$(stat -c %u "$DIRA/secret.txt")" = "$owner_before" ] || fail "A's old file changed owner"
[ "$(stat -c %U "$DIRA/secret.txt")" = "xb-$A" ] || fail "A's old file is owned by $(stat -c %U "$DIRA/secret.txt")"
[ "$(id -g "xb-$A")" = "$GA" ] || fail "restore gave xb-$A gid $(id -g "xb-$A"), want $GA"
pass "restore brings xb-$A back with uid $UA and its files"

chmod 0755 /profiles
echo old >/workspace/old.txt
chmod 0644 /workspace/old.txt
echo keep >/workspace/keep.txt
chmod 0640 /workspace/keep.txt
keep_ctime=$(stat -c %z /workspace/keep.txt)
sleep 1.1
"$XB" restore || fail "restore exited $?"
[ "$(stat -c %z /workspace/keep.txt)" = "$keep_ctime" ] || fail "restore touched keep.txt, which had no other bits"
[ "$(stat -c %a /profiles)" = 700 ] || fail "/profiles is $(stat -c %a /profiles)"
[ "$(stat -c %a /workspace)" = 711 ] || fail "/workspace is $(stat -c %a /workspace)"
[ "$(stat -c %a /workspace/bots)" = 711 ] || fail "/workspace/bots is $(stat -c %a /workspace/bots)"
[ "$(stat -c %a /workspace/old.txt)" = 640 ] || fail "old.txt is $(stat -c %a /workspace/old.txt)"
runuser -u pwuser -- sh -c 'echo new > /workspace/pwuser-new.txt' || fail "pwuser cannot create files in /workspace"
pass "restore tightens /profiles, /workspace and old files; pwuser still writes /workspace"

echo "$E 0" >>/workspace/.xb-users
"$XB" restore 2>"$T/err" || fail "restore with a uid-0 line exited $?"
grep -q '^xb-bot: ' "$T/err" || fail "the skipped line was not logged"
uid_e=$(getent passwd "xb-$E" | cut -d: -f3)
[ -z "$uid_e" ] || [ "$uid_e" != 0 ] || fail "restore created xb-$E with uid 0"
pass "a uid-0 map line is skipped"

# A last map line without a newline is still read, and the next ensure does not run into it.
printf '%s %s' "$F" 21000 >>/workspace/.xb-users
"$XB" restore 2>"$T/err" || fail "restore with an unterminated last line exited $?"
[ "$(id -u "xb-$F" 2>/dev/null)" = 21000 ] || fail "the unterminated last map line was not restored"
UG=$("$XB" ensure "$G") || fail "ensure of G after an unterminated line exited $?"
grep -q "^$F 21000\$" /workspace/.xb-users || fail "the map lost F's line: $(cat /workspace/.xb-users)"
grep -q "^$G $UG\$" /workspace/.xb-users || fail "the map has no line for G: $(cat /workspace/.xb-users)"
pass "a last map line without a newline is read"

# Every error of the helper's own starts with xb-bot:, even when useradd fails first.
printf '%s %s\n' "$H" "$UB" >>/workspace/.xb-users
"$XB" ensure "$H" >/dev/null 2>"$T/err" && fail "ensure with a uid already taken succeeded"
head -n 1 "$T/err" | grep -q '^xb-bot: ' || fail "a failed useradd's first stderr line is not xb-bot: ($(cat "$T/err"))"
pass "a failed useradd is reported on one xb-bot: line"

# Tightening that fails at start: with the switch off a warning, with it on the helper unready.
# The failure is injected through a file only root can create, in the helper's own directory.
touch /run/xb-bot/test-fail-tighten
COMPUTER_PER_BOT_USERS=off "$XB" restore 2>"$T/err"
code=$?
[ "$code" = 0 ] || fail "with the switch off, a failed tightening made restore exit $code"
grep -q '^xb-bot: ' "$T/err" || fail "with the switch off, the failed tightening was not logged"
[ ! -e /run/xb-bot/unready ] || fail "with the switch off, restore marked the helper unready"
"$XB" ensure "$B" >/dev/null 2>"$T/err" || fail "with the switch off, ensure was refused: $(cat "$T/err")"
pass "with the switch off, a failed tightening only warns"
COMPUTER_PER_BOT_USERS=on "$XB" restore 2>"$T/err"
code=$?
[ "$code" = 0 ] || fail "with the switch on, a failed tightening made restore exit $code"
[ "$(stat -c '%U %a' /run/xb-bot/unready 2>&1)" = "root 600" ] || fail "the unready mark is $(stat -c '%U %a' /run/xb-bot/unready 2>&1)"
[ -s /run/xb-bot/unready ] || fail "the unready mark carries no reason"
"$XB" ensure "$B" >/dev/null 2>"$T/err"
code=$?
[ "$code" = 64 ] || fail "ensure while unready exited $code, want 64"
head -n 1 "$T/err" | grep -q '^xb-bot: 未就绪：' || fail "ensure while unready said $(cat "$T/err")"
pass "with the switch on, a failed tightening makes ensure refuse (64, xb-bot: 未就绪：)"
rm -f /run/xb-bot/test-fail-tighten
COMPUTER_PER_BOT_USERS=on "$XB" restore 2>"$T/err" || fail "a clean restore exited $?"
[ ! -e /run/xb-bot/unready ] || fail "a clean restore left the unready mark"
"$XB" ensure "$B" >/dev/null 2>"$T/err" || fail "ensure after a clean restore was refused: $(cat "$T/err")"
pass "a clean restore clears the unready mark"

# The switch is read as agent-computer reads it: trimmed, any case.
touch /run/xb-bot/test-fail-tighten
COMPUTER_PER_BOT_USERS=' ON ' "$XB" restore 2>"$T/err"
code=$?
[ "$code" = 0 ] || fail "with COMPUTER_PER_BOT_USERS=' ON ', restore exited $code"
[ -e /run/xb-bot/unready ] || fail "with COMPUTER_PER_BOT_USERS=' ON ', a failed tightening did not mark the helper unready"
"$XB" ensure "$B" >/dev/null 2>"$T/err"
code=$?
[ "$code" = 64 ] || fail "with COMPUTER_PER_BOT_USERS=' ON ', ensure while unready exited $code"
pass "COMPUTER_PER_BOT_USERS=' ON ' counts as on"
rm -f /run/xb-bot/test-fail-tighten

# Command files a killed helper left behind are removed at start.
touch /run/xb-bot/cmd.stale1
COMPUTER_PER_BOT_USERS=on "$XB" restore 2>"$T/err" || fail "restore exited $?"
[ ! -e /run/xb-bot/cmd.stale1 ] || fail "restore left /run/xb-bot/cmd.stale1"
[ ! -e /run/xb-bot/unready ] || fail "a clean restore left the unready mark"
pass "restore removes stale command files"

rm -rf "$T"
echo "all xb-bot tests passed"
