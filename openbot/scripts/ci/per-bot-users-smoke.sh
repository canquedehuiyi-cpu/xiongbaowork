#!/usr/bin/env bash
# Per-employee users, proved in the delivery image: two employees cannot read each other's files,
# the default employee still runs as pwuser, an employee cannot sudo, and a stopped command (the
# HTTP request aborted) ends within 10 seconds although it runs under sudo as another user.
#
#   bash scripts/ci/per-bot-users-smoke.sh openbot:trackb
#
# One disposable container and volume, started the way image-smoke.sh starts them, with the embedded
# computer on (the image default). Every call goes to the computer on 127.0.0.1:4100 from inside the
# container, with the token s6 generated (computer-token.sh). Any failed check exits 1.
set -euo pipefail
image=${1:-openbot:trackb}
name="openbot-perbot-${GITHUB_RUN_ID:-local}-$$"
volume="$name-data"
port=3773
evidence=${EVIDENCE_DIR:-$PWD/.delivery-evidence}
mkdir -p "$evidence"
evidence=$(cd "$evidence" && pwd)
log="$evidence/per-bot-users.log"
cleanup() {
  docker logs "$name" > "$log" 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
export MSYS_NO_PATHCONV=1
failures=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; failures=$((failures+1)); }

key_of() { printf %s "$1" | sha256sum | cut -c1-12; }
A=smoke-a
B=smoke-b
keyA=$(key_of "$A")
keyB=$(key_of "$B")
userA="xb-$keyA"
echo "keys: $A=$keyA $B=$keyB"

# call <bot|-> <path> <json body> [curl args...]: the response body, then the HTTP code on a last
# line of its own ("000" when curl got no response). `-` sends no bot header (the default employee).
call() {
  local bot=$1 path=$2 body=$3
  shift 3
  printf '%s' "$body" | docker exec -i "$name" sh -c '
    bot=$1; path=$2; shift 2
    token=$(cat /run/s6/container_environment/COMPUTER_TOKEN)
    if [ "$bot" != - ]; then set -- "$@" -H "x-openbot-bot-id: $bot"; fi
    exec curl -sS -w "\n%{http_code}" -X POST "$@" \
      -H "authorization: Bearer $token" -H "content-type: application/json" \
      --data-binary @- "http://127.0.0.1:4100$path"
  ' sh "$bot" "$path" "$@" || true
}
code_of() { printf '%s\n' "$1" | tail -n 1; }
body_of() { printf '%s\n' "$1" | sed '$d'; }
exec_body() { jq -nc --arg c "$1" '{command: $c}'; }
# exit_of <response>: the command's exitCode when the call returned 200 with one, else empty.
exit_of() {
  [ "$(code_of "$1")" = 200 ] || return 0
  body_of "$1" | jq -r '.exitCode // empty | tostring' 2>/dev/null || true
}

docker volume create "$volume" >/dev/null
key=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
docker run -d --name "$name" -p "127.0.0.1:$port:3001" \
  -v "$volume:/var/lib/postgresql" \
  -e EMBEDDED_POSTGRES=on -e COPILOTKIT_TELEMETRY_DISABLED=true \
  -e TENANT_PACKAGE_DIR=../examples/qoderwake \
  -e OPENBOT_SINGLE_USER=true -e OPENBOT_PUBLIC_URL="http://localhost:$port" \
  -e KEY_ENCRYPTION_KEY="$key" "$image" >/dev/null

healthy=false
deadline=$((SECONDS+90))
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/health" || true)" = 200 ]; then
    healthy=true; break
  fi
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || break
  sleep 1
done
if [ "$healthy" = true ]; then pass "API /health is 200 (${SECONDS}s)"; else fail "API /health is 200 within 90s"; fi

# The computer answers /health without a token; 503 there is the per-employee computer unready.
health=""
computer_code=000
if [ "$healthy" = true ]; then
  deadline=$((SECONDS+60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    computer_code=$(docker exec "$name" curl -s -o /tmp/xb-smoke-health -w '%{http_code}' --max-time 5 http://127.0.0.1:4100/health || true)
    [ "$computer_code" = 200 ] && break
    sleep 1
  done
  health=$(docker exec "$name" cat /tmp/xb-smoke-health 2>/dev/null || true)
fi
echo "computer /health: HTTP $computer_code perBotUsers=$(printf '%s' "$health" | jq -c '.perBotUsers // null' 2>/dev/null || echo '?')"
if [ "$computer_code" = 200 ] && [ "$(printf '%s' "$health" | jq -r '.perBotUsers.ready // false')" = true ]; then
  pass "computer /health perBotUsers.ready is true"
else
  fail "computer /health perBotUsers.ready is true"
  docker exec "$name" sh -c 'cat /run/xb-bot/unready 2>/dev/null' | sed 's/^/unready: /' || true
fi

if [ "$healthy" = true ]; then
  marker="per-bot-smoke-$$-$RANDOM"

  r=$(call "$A" /files/write "$(jq -nc --arg t "$marker" '{path: "a.txt", contents: $t}')")
  if [ "$(code_of "$r")" = 200 ]; then pass "$A writes a.txt with the file tools"; else fail "$A writes a.txt with the file tools (HTTP $(code_of "$r"): $(body_of "$r"))"; fi

  r=$(call "$B" /files/read '{"path":"a.txt"}')
  if [ "$(code_of "$r")" != 200 ]; then pass "$B's /files/read a.txt is not 200 (HTTP $(code_of "$r"))"; else fail "$B's /files/read a.txt is not 200 (got 200: $(body_of "$r"))"; fi

  r=$(call "$A" /exec "$(exec_body 'cat a.txt')")
  out=$(body_of "$r" | jq -r '.stdout // empty' 2>/dev/null || true)
  if [ "$(exit_of "$r")" = 0 ] && [ "$out" = "$marker" ]; then pass "$A's command reads a.txt"; else fail "$A's command reads a.txt (HTTP $(code_of "$r"): $(body_of "$r"))"; fi

  r=$(call "$B" /exec "$(exec_body "cat ../$keyA/a.txt")")
  rc=$(exit_of "$r")
  # Permission denied, not merely absent: with the switch off the path does not exist at all.
  if [ -n "$rc" ] && [ "$rc" != 0 ] && ! body_of "$r" | grep -q "$marker" \
    && body_of "$r" | jq -r '.stderr' | grep -q 'Permission denied'; then
    pass "$B's command cannot cat ../$keyA/a.txt (exit $rc: $(body_of "$r" | jq -r '.stderr' | head -n 1))"
  else
    fail "$B's command cannot cat ../$keyA/a.txt (HTTP $(code_of "$r"): $(body_of "$r"))"
  fi

  r=$(call - /exec "$(exec_body 'id -un')")
  out=$(body_of "$r" | jq -r '.stdout // empty' 2>/dev/null | tr -d '\n' || true)
  if [ "$(exit_of "$r")" = 0 ] && [ "$out" = pwuser ]; then pass "without a bot header id -un is pwuser"; else fail "without a bot header id -un is pwuser (HTTP $(code_of "$r"): $(body_of "$r"))"; fi

  r=$(call "$A" /exec "$(exec_body 'id -un')")
  out=$(body_of "$r" | jq -r '.stdout // empty' 2>/dev/null | tr -d '\n' || true)
  if [ "$(exit_of "$r")" = 0 ] && [ "$out" = "$userA" ]; then pass "$A's id -un is $userA"; else fail "$A's id -un is $userA (HTTP $(code_of "$r"): $(body_of "$r"))"; fi

  r=$(call "$A" /exec "$(exec_body 'sudo -n apt-get --version')")
  rc=$(exit_of "$r")
  if [ -n "$rc" ] && [ "$rc" != 0 ]; then
    pass "$A cannot sudo -n apt-get --version (exit $rc: $(body_of "$r" | jq -r '.stderr' | head -n 1))"
  else
    fail "$A cannot sudo -n apt-get --version (HTTP $(code_of "$r"): $(body_of "$r"))"
  fi

  # Stopping: curl gives up after 3 seconds and closes the connection, the computer aborts the
  # request, and the employee's sleep (running as $userA under sudo) must be gone within 10 seconds.
  sleeping() { docker exec "$name" pgrep -u "$userA" -x sleep >/dev/null 2>&1; }
  stop_out=$(mktemp)
  call "$A" /exec "$(exec_body 'sleep 60')" --max-time 3 > "$stop_out" 2>&1 &
  curl_pid=$!
  seen=false
  while kill -0 "$curl_pid" 2>/dev/null; do
    if [ "$seen" = false ] && sleeping; then seen=true; fi
    sleep 0.2
  done
  wait "$curl_pid" || true
  echo "curl --max-time 3 ended: $(tr '\n' ' ' < "$stop_out")"
  rm -f "$stop_out"
  if [ "$seen" = true ]; then pass "$A's sleep 60 was running as $userA before curl gave up"; else fail "$A's sleep 60 was running as $userA before curl gave up"; fi
  gone=false
  started=$SECONDS
  while [ $((SECONDS-started)) -le 10 ]; do
    if docker exec "$name" pgrep -u "$userA" -x sleep >/dev/null 2>&1; then pg=0; else pg=$?; fi
    # 1 is "no such process"; 2 (no such user) is not evidence that it stopped.
    if [ "$pg" = 1 ]; then gone=true; break; fi
    sleep 0.5
  done
  elapsed=$((SECONDS-started))
  if [ "$seen" = true ] && [ "$gone" = true ]; then
    pass "$A's sleep is gone ${elapsed}s after curl timed out (limit 10s)"
  else
    fail "$A's sleep is gone within 10s after curl timed out (after ${elapsed}s: $(docker exec "$name" ps -o user,pid,ppid,pgid,stat,args -A 2>/dev/null | grep -E 'sleep|xb-bot|sudo|timeout|runuser' | grep -v grep | tr '\n' ';'))"
  fi

  # Nothing of the stopped command is left on the root side either: sudo and the helper (both carry
  # `xb-bot run` in their arguments), runuser for this employee, and the timeout in front of it.
  # pgrep run directly by docker exec, not through a shell, so it never matches itself.
  leftovers() {
    local pattern
    for pattern in 'xb-bot run' "runuser -u $userA " "^timeout .* runuser -u $userA "; do
      if docker exec "$name" pgrep -f -- "$pattern" >/dev/null 2>&1; then echo "$pattern"; fi
    done
  }
  left=""
  started=$SECONDS
  while [ $((SECONDS-started)) -le 10 ]; do
    left=$(leftovers)
    [ -z "$left" ] && break
    sleep 0.5
  done
  elapsed=$((SECONDS-started))
  if [ "$seen" = true ] && [ -z "$left" ]; then
    pass "no xb-bot run, runuser or timeout of $userA left ${elapsed}s after the sleep went (limit 10s)"
  else
    fail "no xb-bot run, runuser or timeout of $userA left within 10s (still matching: $(printf '%s' "$left" | tr '\n' '|'); $(docker exec "$name" ps -o user,pid,ppid,pgid,stat,args -A 2>/dev/null | grep -E 'sleep|xb-bot|sudo|timeout|runuser' | grep -v grep | tr '\n' ';'))"
  fi

  # A process an employee leaves outside its command's group (setsid) survives the command, so the
  # computer ends every employee process before it (re)starts: otherwise one could take port 4100
  # first, or read the computer's argv, while it comes back up, and catch COMPUTER_TOKEN.
  lingering() { docker exec "$name" pgrep -u "$userA" -f 'sleep 1003' >/dev/null 2>&1; }
  # `; sleep 1` so the child has called setsid before the command ends and its group is killed.
  r=$(call "$A" /exec "$(exec_body 'setsid sleep 1003 >/dev/null 2>&1 </dev/null & sleep 1')")
  if [ "$(exit_of "$r")" = 0 ] && lingering; then
    pass "$A leaves a setsid sleep that outlives its command"
  else
    fail "$A leaves a setsid sleep that outlives its command (HTTP $(code_of "$r"): $(body_of "$r"))"
  fi
  # The computer's pid as s6 sees it (the run script execs into bun, so it is bun's).
  svc=$(docker exec "$name" sh -c 'for d in /run/service/computer /run/s6-rc/servicedirs/computer; do if [ -d "$d" ]; then echo "$d"; break; fi; done' || true)
  computer_pid() { docker exec "$name" /command/s6-svstat -p "$svc" 2>/dev/null || true; }
  before=$(computer_pid)
  echo "computer service: ${svc:-not found}, pid ${before:-?}"
  docker exec "$name" /command/s6-svc -r "$svc" || true
  restarted=false
  gone=false
  started=$SECONDS
  while [ $((SECONDS-started)) -le 60 ]; do
    now=$(computer_pid)
    code=$(docker exec "$name" curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:4100/health || true)
    if [ -n "$now" ] && [ "$now" != -1 ] && [ "$now" != "$before" ] && [ "$code" = 200 ]; then restarted=true; fi
    if lingering; then gone=false; else gone=true; fi
    [ "$restarted" = true ] && break
    sleep 1
  done
  elapsed=$((SECONDS-started))
  if [ "$restarted" = true ]; then
    pass "the computer restarted (pid $before -> $(computer_pid)) and /health is 200 again after ${elapsed}s"
  else
    fail "the computer restarted and /health is 200 again within 60s (pid $before -> $(computer_pid), HTTP $code)"
  fi
  if [ "$restarted" = true ] && [ "$gone" = true ]; then
    pass "$A's setsid sleep is gone once the computer has restarted"
  else
    fail "$A's setsid sleep is gone once the computer has restarted ($(docker exec "$name" ps -o user,pid,args -u "$userA" 2>/dev/null | tr '\n' ';'))"
  fi
fi

echo "PER-BOT USERS failed checks=$failures"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '## 员工独立电脑冒烟\n\n失败检查：%s（逐项结果见日志）。\n' "$failures" >> "$GITHUB_STEP_SUMMARY"
fi
if [ "$failures" -ne 0 ]; then
  docker logs "$name" > "$log" 2>&1 || true
  bash scripts/ci/print-diagnostics.sh "$log" || true
fi
[ "$failures" -eq 0 ]
