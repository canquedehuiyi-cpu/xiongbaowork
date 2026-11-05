#!/usr/bin/env bash
# The installed device app on a fresh Linux machine, against a real server (F2 stage 3, HUMAN-STEPS
# 12.6). Run by device-release.yml's clean-linux job after `apt-get install ./xiongbao-device_*.deb`:
#
#   1. sign up a fresh person and mint a pairing code through the API (what 「我的设备」 does);
#   2. pair with the INSTALLED runner (/usr/bin/openbot-runner), into the data directory the app
#      itself uses, and see the device online on the server;
#   3. the server sends that device one command with no model involved: `projects.branches`, which
#      the runner answers by running `git ls-remote --heads` on this machine;
#   4. stop the runner by PID: no openbot-runner is left, and the server sees the device go offline;
#   5. start the INSTALLED app (/usr/bin/xiongbao-device) on a virtual display: it starts its own
#      sidecar without re-pairing and the device comes back online (the stand-in for "reboot, back
#      online by itself": a fresh start of the app with no input);
#   6. SIGTERM the app, which goes through the same quit() as the tray's 「退出」: no openbot-runner
#      is left and the device goes offline; then start and quit it once more.
#
# Inputs (env): ORIGIN (the server, already healthy), EVIDENCE (file that PASS lines are appended
# to), LOG_DIR (runner and app logs), and optionally RUNNER_BIN, APP_BIN, GIT_PROBE_URL,
# GIT_PROBE_BRANCH, OFFLINE_TIMEOUT (seconds). Every process this starts is stopped by its PID.
set -euo pipefail

: "${ORIGIN:?ORIGIN is the server to pair with}"
: "${EVIDENCE:?EVIDENCE is the evidence file}"
: "${LOG_DIR:?LOG_DIR is where runner and app logs go}"
RUNNER_BIN=${RUNNER_BIN:-/usr/bin/openbot-runner}
APP_BIN=${APP_BIN:-/usr/bin/xiongbao-device}
GIT_PROBE_URL=${GIT_PROBE_URL:-https://github.com/octocat/Hello-World.git}
GIT_PROBE_BRANCH=${GIT_PROBE_BRANCH:-master}
OFFLINE_TIMEOUT=${OFFLINE_TIMEOUT:-150}
NAME="clean-linux-$$"

mkdir -p "$LOG_DIR"
work=$(mktemp -d)
jar="$work/cookies"
started=()

pass() { echo "PASS $*" | tee -a "$EVIDENCE"; }
fail() {
  echo "::error::$*"
  echo "FAIL $*" >> "$EVIDENCE"
  exit 1
}

stop_pid() {
  local pid=$1
  kill -0 "$pid" 2> /dev/null || return 0
  kill -TERM "$pid" 2> /dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2> /dev/null || return 0
    sleep 1
  done
  kill -KILL "$pid" 2> /dev/null || true
}
cleanup() {
  local index
  for ((index = ${#started[@]} - 1; index >= 0; index--)); do stop_pid "${started[$index]}"; done
  rm -rf "$work"
}
trap cleanup EXIT

# The PIDs of every process named openbot-runner on this machine (none, on a clean one at rest).
runners() { ps -C openbot-runner -o pid= | tr -d ' ' || true; }
no_runner() { [ -z "$(runners)" ]; }

until_true() {
  local what=$1 seconds=$2
  shift 2
  for _ in $(seq 1 "$seconds"); do
    if "$@"; then return 0; fi
    sleep 1
  done
  fail "$what (waited ${seconds}s)"
}

api() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS --max-time 90 -b "$jar" -c "$jar" -o "$work/body" -w '%{http_code}'
    -X "$method" -H "origin: $ORIGIN")
  if [ -n "$body" ]; then args+=(-H 'content-type: application/json' --data "$body"); fi
  curl "${args[@]}" "$ORIGIN$path"
}

# The one device's `online`, as 「我的设备」 reads it.
device_online() {
  [ "$(api GET /api/devices)" = 200 ] || return 2
  jq -r --arg name "$NAME" '[.devices[] | select(.name == $name)] | if length == 1 then .[0].online else "missing" end' "$work/body"
}
is_online() { [ "$(device_online)" = true ]; }
is_offline() { [ "$(device_online)" = false ]; }

[ -x "$RUNNER_BIN" ] || fail "no runner at $RUNNER_BIN"
[ -x "$APP_BIN" ] || fail "no app at $APP_BIN"
app_data="${XDG_DATA_HOME:-$HOME/.local/share}/com.xiongbao.device"
[ ! -e "$app_data" ] || fail "$app_data already exists: this is not a clean machine"
[ -z "$(runners)" ] || fail "an openbot-runner is already running"

# 1. A person and a pairing code.
email="device-clean-$(date +%s)-$$@example.test"
status=$(api POST /api/auth/sign-up/email \
  "$(jq -cn --arg email "$email" --arg password "pw-$(openssl rand -hex 16)" '{name: "设备端全新机器检查", email: $email, password: $password}')")
[ "$status" = 200 ] || fail "sign-up answered $status"
[ "$(api GET /api/me)" = 200 ] || fail "the session cookie does not authenticate /api/me"
pass "注册新用户并登录（POST /api/auth/sign-up/email，GET /api/me 200）"
[ "$(api POST /api/devices/pair)" = 201 ] || fail "POST /api/devices/pair did not answer 201"
code=$(jq -r '.code // empty' "$work/body")
[ -n "$code" ] || fail "no pairing code in the answer"
pass "「我的设备」生成配对码（POST /api/devices/pair 201）"

# 2. Pair with the installed runner, in the data directory the app uses (main.rs: <app data>/runner).
"$RUNNER_BIN" --server "$ORIGIN" --data-dir "$app_data/runner" --name "$NAME" --pair "$code" \
  > "$LOG_DIR/runner-pair.log" 2>&1 &
runner=$!
started+=("$runner")
until_true "the installed runner did not pair" 60 grep -q '^runner: paired as ' "$LOG_DIR/runner-pair.log"
until_true "the paired device is not online" 60 is_online
[ "$(stat -c %a "$app_data/runner/runner-state.json")" = 600 ] || fail "runner-state.json is not 0600"
pass "已安装的 $RUNNER_BIN 用配对码配对成功，设备在服务器上显示在线（runner-state.json 为 0600）"
[ "$(api POST /api/runner/register "$(jq -cn --arg code "$code" '{code: $code, deviceId: "second-use", name: "second-use"}')")" = 403 ] ||
  fail "the pairing code could be spent twice"
pass "配对码只能用一次（再次使用返回 403）"

# 3. One command from the server to this device, with no model: git ls-remote on this machine.
api GET /api/devices > /dev/null
device=$(jq -r --arg name "$NAME" '.devices[] | select(.name == $name) | .id' "$work/body")
status=$(api POST /api/projects/branches "$(jq -cn --arg id "$device" --arg url "$GIT_PROBE_URL" '{deviceId: $id, url: $url}')")
[ "$status" = 200 ] || fail "projects.branches answered $status: $(cat "$work/body")"
jq -e --arg branch "$GIT_PROBE_BRANCH" '.branches | index($branch) != null' "$work/body" > /dev/null ||
  fail "projects.branches did not list $GIT_PROBE_BRANCH: $(cat "$work/body")"
pass "服务器向设备下发一条命令（projects.branches：设备上运行 git ls-remote $GIT_PROBE_URL），设备返回分支 $GIT_PROBE_BRANCH"

# 4. Stop it by PID: nothing left, and the server notices.
kill -TERM "$runner"
wait "$runner" || fail "the runner exited $? on SIGTERM"
[ -z "$(runners)" ] || fail "openbot-runner still running after it was stopped: $(runners)"
until_true "the stopped device still shows online" "$OFFLINE_TIMEOUT" is_offline
pass "按 PID 停止 runner 后没有残留的 openbot-runner 进程，服务器显示设备离线"

# 5 and 6. The installed app, twice: it starts its own sidecar without a pairing code, and quits clean.
printf '{\n  "server": "%s",\n  "name": "%s"\n}\n' "$ORIGIN" "$NAME" > "$app_data/device.json"
if [ -z "${DISPLAY:-}" ]; then
  Xvfb :77 -screen 0 1280x800x24 -nolisten tcp > "$LOG_DIR/xvfb.log" 2>&1 &
  started+=("$!")
  export DISPLAY=:77
  until_true "Xvfb did not start" 20 test -e /tmp/.X11-unix/X77
fi
dbus-daemon --session --nofork --address="unix:path=$work/bus" > "$LOG_DIR/dbus.log" 2>&1 &
started+=("$!")
export DBUS_SESSION_BUS_ADDRESS="unix:path=$work/bus"
until_true "the session bus did not start" 20 test -S "$work/bus"

# The app's supervised runner, not a one-shot --list-roots the window may run (roots.rs).
sidecar_of() {
  local app=$1 pid
  for pid in $(ps -o pid= --ppid "$app"); do
    if [ "$(ps -o comm= -p "$pid")" = openbot-runner ] &&
      ! tr '\0' '\n' < "/proc/$pid/cmdline" 2> /dev/null | grep -qx -- --list-roots; then
      echo "$pid"
      return 0
    fi
  done
  return 1
}
has_sidecar() { sidecar_of "$1" > /dev/null; }

for round in 1 2; do
  "$APP_BIN" > "$LOG_DIR/app-$round.log" 2>&1 &
  app=$!
  started+=("$app")
  until_true "the app (round $round) did not start openbot-runner" 60 has_sidecar "$app"
  child=$(sidecar_of "$app")
  [ "$(readlink -f "/proc/$child/exe")" = "$(readlink -f "$RUNNER_BIN")" ] ||
    fail "the app started $(readlink -f "/proc/$child/exe"), not the installed $RUNNER_BIN"
  if tr '\0' '\n' < "/proc/$child/cmdline" | grep -qx -- --pair; then
    fail "the app passed --pair again"
  fi
  until_true "the device is not back online after the app started (round $round)" 60 is_online
  pass "第 $round 次启动已安装的 $APP_BIN：自动拉起安装目录里的 openbot-runner（PID $child，无需重新配对），设备重新在线"
  # SIGTERM is routed to the same quit() as the tray's 「退出」 (main.rs route_signals_to_quit).
  kill -TERM "$app"
  for _ in $(seq 1 30); do kill -0 "$app" 2> /dev/null || break; sleep 1; done
  kill -0 "$app" 2> /dev/null && fail "the app did not quit within 30s (round $round)"
  wait "$app" || true
  # The supervised runner is gone with the app. A one-shot `--list-roots` the window may have asked
  # for just before (roots.rs) ends by itself, so the machine gets a few seconds to settle.
  kill -0 "$child" 2> /dev/null && fail "the app's runner (PID $child) outlived the app (round $round)"
  until_true "openbot-runner left running after the app quit (round $round)" 10 no_runner
  until_true "the device still shows online after the app quit (round $round)" "$OFFLINE_TIMEOUT" is_offline
  pass "第 $round 次退出应用（与托盘「退出」同一路径）：没有残留的 openbot-runner 进程，服务器显示设备离线"
done
