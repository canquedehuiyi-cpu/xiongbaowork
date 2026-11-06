#!/usr/bin/env bash
# The device app's deb on a fresh Linux machine, from checksum to uninstall (F2 stage 3, HUMAN-STEPS
# 12.6). The one Linux implementation: device-release.yml's clean-linux job runs it on the files the
# release will publish, and ci.yml's device-clean-linux job on every pull request's unsigned deb.
# Each workflow step runs one phase, in this order:
#
#   sums         the deb is the one $DIST/SHA256SUMS names (sha256sum -c --ignore-missing); this
#                also starts the evidence file with the machine's details;
#   install      sudo apt-get install -y on the deb (its Depends come from the archive);
#   files        dpkg says it is installed at $VERSION, with the app, the runner and the desktop entry;
#   selfcheck    the installed runner's own one-shot commands, with no network;
#   server       migrate the job's own PostgreSQL and start the real server in the background (its
#                PID goes to $LOG_DIR/server.pid; `stop-server` stops it by that PID);
#   lifecycle    against that server, with the INSTALLED binaries:
#                  1. sign up a fresh person and mint a pairing code through the API (「我的设备」);
#                  2. pair with the installed runner ($RUNNER_BIN), into the data directory the app
#                     itself uses, and see the device online on the server;
#                  3. the server sends that device one command with no model involved:
#                     `projects.branches`, which the runner answers with `git ls-remote --heads`;
#                  4. stop the runner by PID: no openbot-runner is left, and the device goes offline;
#                  5. start the installed app ($APP_BIN) on a virtual display: it starts its own
#                     sidecar without re-pairing and the device comes back online (the stand-in for
#                     "reboot, back online by itself": a fresh start of the app with no input);
#                  6. SIGTERM the app, the same quit() as the tray's 「退出」: no openbot-runner is
#                     left and the device goes offline; then start and quit it once more;
#   stop-server  stop the server by its PID (run it under `if: always()`);
#   uninstall    sudo apt-get remove: nothing of the package and no openbot-runner is left;
#   result       no FAIL line in the evidence, then `RESULT: PASS` as its last line.
#
# Inputs (env): EVIDENCE (the evidence file, every phase); DIST (holds the deb and SHA256SUMS) and
# VERSION (the deb's version) for sums, install, files; COMMIT and TAG (empty for a CI build) for the
# evidence header; ORIGIN and LOG_DIR for server, lifecycle and stop-server; OWNER_DATABASE_URL,
# APP_DATABASE_URL, ROLE_WRITER_URL and PGPASSWORD for server; optionally RUNNER_BIN, APP_BIN,
# GIT_PROBE_URL, GIT_PROBE_BRANCH, OFFLINE_TIMEOUT (seconds). Every process this starts is stopped by
# its PID.
set -euo pipefail

: "${EVIDENCE:?EVIDENCE is the evidence file}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
openbot="$(cd "$here/../.." && pwd)"
RUNNER_BIN=${RUNNER_BIN:-/usr/bin/openbot-runner}
APP_BIN=${APP_BIN:-/usr/bin/xiongbao-device}
GIT_PROBE_URL=${GIT_PROBE_URL:-https://github.com/octocat/Hello-World.git}
GIT_PROBE_BRANCH=${GIT_PROBE_BRANCH:-master}
OFFLINE_TIMEOUT=${OFFLINE_TIMEOUT:-150}
NAME="clean-linux-$$"
started=()

pass() { echo "PASS $*" | tee -a "$EVIDENCE"; }
fail() {
  echo "::error::$*"
  echo "FAIL $*" >> "$EVIDENCE"
  exit 1
}

deb_name() {
  : "${VERSION:?VERSION is the deb version}"
  echo "xiongbao-device_${VERSION}_amd64.deb"
}

phase_sums() {
  : "${DIST:?DIST holds the deb and SHA256SUMS}"
  local deb listed actual os
  deb="$(deb_name)"
  mkdir -p "$(dirname "$EVIDENCE")"
  os="$(. /etc/os-release && echo "$PRETTY_NAME")"
  {
    echo "熊宝数字员工 设备端 ${VERSION}：全新 Linux 机器检查（HUMAN-STEPS 12.6）"
    if [ -n "${TAG:-}" ]; then
      echo "标签 ${TAG}，提交 ${COMMIT:-未知}"
    else
      echo "CI 构建的未签名安装包（不发布），提交 ${COMMIT:-未知}"
    fi
    echo "系统：${os}，内核 $(uname -r)，$(uname -m)，托管镜像 ${ImageOS:-未知} ${ImageVersion:-未知}"
  } > "$EVIDENCE"
  [ -f "$DIST/SHA256SUMS" ] || fail "there is no SHA256SUMS in $DIST."
  listed="$(awk -v file="$deb" '$2 == file { print $1 }' "$DIST/SHA256SUMS")"
  if ! [[ "$listed" =~ ^[0-9a-f]{64}$ ]]; then
    fail "SHA256SUMS does not list $deb exactly once."
  fi
  (cd "$DIST" && sha256sum -c --ignore-missing SHA256SUMS) || fail "sha256sum -c --ignore-missing SHA256SUMS failed."
  actual="$(sha256sum "$DIST/$deb" | cut -d' ' -f1)"
  [ "$actual" = "$listed" ] || fail "SHA256 mismatch for $deb: $actual, SHA256SUMS says $listed."
  {
    echo "安装包：${deb}"
    echo "SHA256：${actual}"
    echo "签名：deb 不做代码签名，只核对 SHA256（checksum-only）"
  } >> "$EVIDENCE"
  pass "SHA256SUMS 校验（sha256sum -c --ignore-missing）"
}

phase_install() {
  : "${DIST:?DIST holds the deb}"
  local deb
  deb="$(deb_name)"
  sudo apt-get update
  # An absolute path, so apt takes it as a file and not a package name.
  sudo apt-get install -y "$(cd "$DIST" && pwd)/$deb"
  pass "sudo apt-get install -y ./$deb"
}

phase_files() {
  local status binary entry
  status="$(dpkg-query -W -f='${Status} ${Version}' xiongbao-device)"
  [ "$status" = "install ok installed ${VERSION:?VERSION is the deb version}" ] || fail "dpkg says: $status"
  for binary in /usr/bin/xiongbao-device /usr/bin/openbot-runner; do
    [ -x "$binary" ] || fail "$binary is missing or not executable."
    echo "已安装 ${binary}，SHA256 $(sha256sum "$binary" | cut -d' ' -f1)" >> "$EVIDENCE"
  done
  entry=/usr/share/applications/xiongbao-device.desktop
  grep -qx 'Exec=xiongbao-device' "$entry" || fail "$entry does not run xiongbao-device."
  grep -qx 'Name=熊宝数字员工 设备端' "$entry" || fail "$entry is not named 熊宝数字员工 设备端."
  pass "已安装 /usr/bin/xiongbao-device、/usr/bin/openbot-runner 与 ${entry}（dpkg：${status}）"
}

phase_selfcheck() {
  local scratch code=0 data
  scratch="$(mktemp -d)"
  /usr/bin/openbot-runner --help > "$scratch/help.txt" 2>&1 || code=$?
  [ "$code" = 2 ] && grep -q -- '--pair CODE' "$scratch/help.txt" || fail "--help exited $code without the usage."
  mkdir "$scratch/folder"
  data="$scratch/data"
  /usr/bin/openbot-runner --data-dir "$data" --add-root "selfcheck=$scratch/folder" | jq -e '.ok and (.roots | length) == 1' > /dev/null ||
    fail "--add-root did not add the folder."
  /usr/bin/openbot-runner --data-dir "$data" --list-roots | jq -e '.ok and .roots[0].name == "selfcheck"' > /dev/null ||
    fail "--list-roots did not list the folder."
  /usr/bin/openbot-runner --data-dir "$data" --remove-root selfcheck | jq -e '.ok and (.roots | length) == 0' > /dev/null ||
    fail "--remove-root did not remove the folder."
  if [ -n "$(ps -C openbot-runner -o pid= || true)" ]; then
    fail "an openbot-runner is still running after the one-shot commands."
  fi
  rm -rf "$scratch"
  pass "已安装的 openbot-runner 自检：--help 退出码 2 并打印用法；--add-root / --list-roots / --remove-root 正常；之后没有残留进程"
}

# The server side of 「我的设备」, from this checkout: only the server runs from source, the device
# side is what apt installed. The server-test recipe: migrate as the owner, then the runtime roles.
phase_server() {
  : "${ORIGIN:?ORIGIN is the server to start}"
  : "${LOG_DIR:?LOG_DIR is where the server log goes}"
  : "${OWNER_DATABASE_URL:?}" "${APP_DATABASE_URL:?}" "${ROLE_WRITER_URL:?}"
  mkdir -p "$LOG_DIR"
  (cd "$openbot" && DATABASE_URL="$OWNER_DATABASE_URL" bun run --cwd server scripts/migrate.ts)
  psql -h 127.0.0.1 -U openbot -d postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE openbot_app WITH PASSWORD 'ci-app' NOSUPERUSER NOBYPASSRLS"
  psql -h 127.0.0.1 -U openbot -d postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE openbot_role_writer WITH PASSWORD 'ci-role-writer'"
  local pidfile="$LOG_DIR/server.pid" key secret
  key="$(openssl rand -base64 32)"
  secret="$(openssl rand -hex 32)"
  echo "::add-mask::$key"
  echo "::add-mask::$secret"
  (
    cd "$openbot/server"
    export KEY_ENCRYPTION_KEY="$key" BETTER_AUTH_SECRET="$secret"
    export DATABASE_URL="$APP_DATABASE_URL" ROLE_WRITER_DATABASE_URL="$ROLE_WRITER_URL"
    export BETTER_AUTH_URL="$ORIGIN" OPENBOT_PUBLIC_URL="$ORIGIN" PORT="${ORIGIN##*:}"
    # Sign-in refuses to start without a named administrator (audit defect #3). Nobody signs in as
    # this address: the person under test is an ordinary sign-up, as a customer would be.
    export INITIAL_ADMIN_EMAILS=device-clean-admin@example.test
    export NODE_ENV=test TENANT_PACKAGE_DIR=../examples/qoderwake INTELLIGENCE_MODE=local
    export COPILOTKIT_TELEMETRY_DISABLED=true DO_NOT_TRACK=1
    nohup bun src/index.ts > "$LOG_DIR/server.log" 2>&1 &
    echo "$!" > "$pidfile"
  )
  for _ in $(seq 1 90); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$ORIGIN/health" || true)" = 200 ]; then return 0; fi
    kill -0 "$(cat "$pidfile")" || { echo "::error::the server exited"; exit 1; }
    sleep 1
  done
  echo "::error::the server was not healthy within 90s"
  exit 1
}

phase_stop_server() {
  local pidfile="${LOG_DIR:?LOG_DIR holds server.pid}/server.pid"
  [ -f "$pidfile" ] || return 0
  stop_pid "$(cat "$pidfile")"
}

phase_uninstall() {
  local status file
  sudo apt-get remove -y xiongbao-device
  status="$(dpkg-query -W -f='${Status}' xiongbao-device 2> /dev/null || true)"
  case "$status" in
    "" | "deinstall ok config-files" | "unknown ok not-installed" | "deinstall ok not-installed") ;;
    *) fail "xiongbao-device is still installed: $status" ;;
  esac
  for file in /usr/bin/xiongbao-device /usr/bin/openbot-runner /usr/share/applications/xiongbao-device.desktop; do
    if [ -e "$file" ]; then fail "$file is still there after apt-get remove."; fi
  done
  if [ -n "$(ps -C openbot-runner -o pid= || true)" ]; then
    fail "an openbot-runner is still running after uninstall."
  fi
  pass "sudo apt-get remove -y xiongbao-device：应用、openbot-runner 与桌面入口都已删除，没有残留进程"
  echo "说明：apt 不删除用户目录里的 ~/.local/share/com.xiongbao.device（配对信息），与普通 Linux 软件一致" >> "$EVIDENCE"
}

# RESULT: PASS only when every check before it wrote its PASS and none wrote FAIL.
phase_result() {
  [ -f "$EVIDENCE" ] || { echo "::error::there is no evidence file at $EVIDENCE"; exit 1; }
  if grep -q '^FAIL ' "$EVIDENCE"; then
    echo "::error::a check failed:"
    grep '^FAIL ' "$EVIDENCE"
    exit 1
  fi
  echo "RESULT: PASS" >> "$EVIDENCE"
  cat "$EVIDENCE"
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

phase_lifecycle() {
  : "${ORIGIN:?ORIGIN is the server to pair with}"
  : "${LOG_DIR:?LOG_DIR is where runner and app logs go}"
  mkdir -p "$LOG_DIR"
  work=$(mktemp -d)
  jar="$work/cookies"
  trap cleanup EXIT

  [ -x "$RUNNER_BIN" ] || fail "no runner at $RUNNER_BIN"
  [ -x "$APP_BIN" ] || fail "no app at $APP_BIN"
  local app_data="${XDG_DATA_HOME:-$HOME/.local/share}/com.xiongbao.device"
  [ ! -e "$app_data" ] || fail "$app_data already exists: this is not a clean machine"
  [ -z "$(runners)" ] || fail "an openbot-runner is already running"
  # Test harness only, not the app's dependencies: a virtual display and a session bus for the tray app.
  sudo apt-get install -y xvfb dbus-daemon dbus-session-bus-common

  # 1. A person and a pairing code.
  local email status code runner device app child round
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
}

case "${1:-}" in
  sums) phase_sums ;;
  install) phase_install ;;
  files) phase_files ;;
  selfcheck) phase_selfcheck ;;
  server) phase_server ;;
  lifecycle) phase_lifecycle ;;
  stop-server) phase_stop_server ;;
  uninstall) phase_uninstall ;;
  result) phase_result ;;
  *)
    echo "usage: $0 sums|install|files|selfcheck|server|lifecycle|stop-server|uninstall|result" >&2
    exit 2
    ;;
esac
