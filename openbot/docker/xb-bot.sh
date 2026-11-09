#!/bin/sh
# xb-bot: the narrow root helper that gives each digital employee its own Linux user.
#
# Installed as /usr/local/sbin/xb-bot (root, 0755). pwuser reaches `ensure` and `run` through sudo;
# `restore` is for s6 alone, as root at container start, and is not in sudoers.
#
#   xb-bot ensure <key>             create xb-<key>, its directory and ACLs; print its uid
#   xb-bot run <key> <timeout_s>    stdin: NAME=VALUE lines, an empty line, then the command
#   xb-bot restore                  tighten the top directories and recreate users from the map
#
# Exit 64: arguments refused, or the helper is not ready (see restore). Exit 65 (run): the employee's
# user or directory is missing. Every error of the helper's own is a stderr line starting `xb-bot: `,
# printed before anything else, which is how agent-computer tells a refusal from a command that
# happened to exit 64 or 65 itself.
#
# Nothing is read from the caller's environment: sudo resets it, and PATH is set here. The one
# exception is `restore`, which s6 runs through with-contenv and which reads COMPUTER_PER_BOT_USERS.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
IFS=$(printf ' \t\nx')
IFS=${IFS%x}
umask 022

WORKSPACE=/workspace
BOTS=$WORKSPACE/bots
PROFILES=/profiles
MAP=$WORKSPACE/.xb-users
CONTAINER_ENV=/run/s6/container_environment
# Root's alone (0700): an employee who could open the lock could hold it and stall every ensure.
LOCKDIR=/run/xb-bot
LOCK=$LOCKDIR/lock
# Written by restore when it could not tighten the directories with the switch on; ensure refuses.
UNREADY=$LOCKDIR/unready
# For the helper's tests: makes restore's tightening fail. Only root can create it.
TEST_FAIL=$LOCKDIR/test-fail-tighten
UID_MIN=20000
UID_MAX=59999

said=
tmp=

die() {
  code=$1
  shift
  said=1
  printf 'xb-bot: %s\n' "$*" >&2
  exit "$code"
}

warn() {
  printf 'xb-bot: %s\n' "$*" >&2
}

oneline() {
  printf '%s' "$1" | tr '\n' ' '
}

# Whatever ends ensure or run before the command starts says so on an xb-bot: line.
on_exit() {
  rc=$?
  if [ -n "$tmp" ]; then
    rm -f -- "$tmp"
  fi
  if [ "$rc" != 0 ] && [ -z "$said" ]; then
    printf 'xb-bot: 意外失败（退出码 %s）\n' "$rc" >&2
  fi
}

# A command whose own complaint becomes part of one xb-bot: line instead of preceding it.
must() {
  what=$1
  shift
  out=$("$@" 2>&1) || die 1 "$what：$(oneline "$out")"
}

valid_key() {
  case $1 in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) return 0 ;;
  esac
  return 1
}

# A uid as the map records it: digits, no leading zero, inside the system range.
valid_uid() {
  case $1 in
    '' | 0* | *[!0-9]* | ??????*) return 1 ;;
  esac
  [ "$1" -ge "$UID_MIN" ] && [ "$1" -le "$UID_MAX" ]
}

# The map is root's: a link or a file somebody else owns is not trusted.
map_trusted() {
  [ ! -L "$MAP" ] && [ -f "$MAP" ] && [ "$(stat -c %u "$MAP")" = 0 ]
}

# The uid the map records for a key, or nothing. A last line without a newline counts.
mapped_uid() {
  [ -e "$MAP" ] || [ -L "$MAP" ] || return 0
  map_trusted || die 1 "映射文件 $MAP 不是 root 所有的普通文件，拒绝使用"
  while read -r mk mu _rest || [ -n "${mk:-}" ]; do
    if [ "$mk" = "$1" ]; then
      printf '%s\n' "$mu"
      return 0
    fi
    mk=
  done <"$MAP"
}

# xb-<key> with a primary group of its own (the same id as the uid where free) and xbbots beside it.
add_user() {
  au_key=$1
  au_uid=$2
  set -- --system --home-dir "$BOTS/$au_key" --no-create-home --shell /usr/sbin/nologin -G xbbots
  if getent group "xb-$au_key" >/dev/null 2>&1; then
    set -- "$@" -g "xb-$au_key"
  else
    set -- "$@" -U
  fi
  if [ -n "$au_uid" ]; then
    set -- "$@" -u "$au_uid"
  fi
  useradd "$@" "xb-$au_key"
}

# /workspace/bots as a real directory. pwuser owns /workspace and could leave a link here.
bots_dir() {
  if [ -L "$BOTS" ]; then
    rm -f "$BOTS" || return 1
  fi
  mkdir -p "$BOTS" && chown pwuser:pwuser "$BOTS" && chmod 0711 "$BOTS"
}

lockdir_ready() {
  if [ -L "$LOCKDIR" ] || { [ -e "$LOCKDIR" ] && [ ! -d "$LOCKDIR" ]; }; then
    rm -f "$LOCKDIR" || return 1
  fi
  (umask 077 && mkdir -p "$LOCKDIR") 2>/dev/null &&
    chown root:root "$LOCKDIR" && chmod 0700 "$LOCKDIR"
}

take_lock() {
  lockdir_ready || die 1 "准备 $LOCKDIR 失败"
  (umask 077 && true >>"$LOCK") 2>/dev/null || die 1 "创建 $LOCK 失败"
  chmod 0600 "$LOCK" 2>/dev/null || die 1 "设置 $LOCK 权限失败"
  exec 9>>"$LOCK"
  flock -w 60 9 || die 1 "等待 $LOCK 超时"
}

# Whether a child is still running: present and not a zombie waiting to be reaped.
running() {
  st=
  read -r _p _c st _r 2>/dev/null <"/proc/$1/stat" || return 1
  [ -n "$st" ] && [ "$st" != Z ]
}

cmd_ensure() {
  key=$1
  user=xb-$key
  trap on_exit EXIT
  take_lock
  if [ -e "$UNREADY" ]; then
    die 64 "未就绪：$(head -n 1 "$UNREADY" 2>/dev/null || true)"
  fi

  recorded=$(mapped_uid "$key")
  if [ -n "$recorded" ] && ! valid_uid "$recorded"; then
    die 1 "映射中 $key 的 uid（$recorded）不在 $UID_MIN–$UID_MAX 内"
  fi
  if ! uid=$(id -u "$user" 2>/dev/null); then
    out=$(add_user "$key" "$recorded" 2>&1) || die 1 "创建用户 $user 失败：$(oneline "$out")"
    uid=$(id -u "$user" 2>/dev/null) || die 1 "创建用户 $user 后查不到它"
  fi
  valid_uid "$uid" || die 1 "用户 $user 的 uid（$uid）不在 $UID_MIN–$UID_MAX 内"
  if [ -z "$recorded" ]; then
    if [ -e "$MAP" ] || [ -L "$MAP" ]; then
      map_trusted || die 1 "映射文件 $MAP 不是 root 所有的普通文件，拒绝写入"
    fi
    # A last line somebody left without a newline is ended first, not run into.
    (
      umask 077
      if [ -s "$MAP" ] && [ -n "$(tail -c 1 "$MAP")" ]; then
        printf '\n' >>"$MAP"
      fi
      printf '%s %s\n' "$key" "$uid" >>"$MAP"
    ) 2>/dev/null || die 1 "写入映射文件 $MAP 失败"
    must "设置映射文件权限失败" chown root:root "$MAP"
    must "设置映射文件权限失败" chmod 0600 "$MAP"
  elif [ "$recorded" != "$uid" ]; then
    die 1 "用户 $user 的 uid（$uid）与映射记录（$recorded）不一致"
  fi

  if [ ! -d "$BOTS" ] || [ -L "$BOTS" ]; then
    bots_dir 2>/dev/null || die 1 "创建 $BOTS 失败"
  fi
  real_bots=$(cd -P "$BOTS" 2>/dev/null && pwd) || die 1 "进不去 $BOTS"
  dir=$BOTS/$key
  if [ -L "$dir" ]; then
    rm -f "$dir"
  fi
  must "创建 $dir 失败" mkdir -p "$dir"
  # Worked on as `.` once inside, so a link swapped in for the path cannot redirect what follows.
  cd "$dir" 2>/dev/null || die 1 "进不去 $dir"
  [ "$(pwd -P)" = "$real_bots/$key" ] || die 1 "$dir 不是真实目录"
  must "设置 $dir 的属主失败" chown "$user:xbcomp" .
  must "设置 $dir 的权限失败" chmod 2770 .
  must "设置 $dir 的 ACL 失败（文件系统可能不支持 ACL）" setfacl -m "u:$user:rwx,u:pwuser:rwx,o::---" .
  must "设置 $dir 的默认 ACL 失败（文件系统可能不支持 ACL）" setfacl -d -m "u:$user:rwx,u:pwuser:rwx,o::---" .
  # The employee owns this directory and may have left a link or a file where .tmp belongs.
  if [ -L .tmp ] || { [ -e .tmp ] && [ ! -d .tmp ]; }; then
    rm -f .tmp
  fi
  must "创建 $dir/.tmp 失败" mkdir -p .tmp
  cd .tmp 2>/dev/null || die 1 "进不去 $dir/.tmp"
  [ "$(pwd -P)" = "$real_bots/$key/.tmp" ] || die 1 "$dir/.tmp 不是真实目录"
  must "设置 $dir/.tmp 的属主失败" chown "$user:xbcomp" .
  # g-s as well: .tmp inherits the parent's setgid bit, and GNU chmod keeps it on a directory.
  must "设置 $dir/.tmp 的权限失败" chmod 0700 .
  must "设置 $dir/.tmp 的权限失败" chmod g-s .
  printf '%s\n' "$uid"
}

cmd_run() {
  key=$1
  t=$2
  trap on_exit EXIT
  case $t in
    '' | 0* | *[!0-9]* | ????*) die 64 "timeout_s 必须是 1–600 的整数" ;;
  esac
  [ "$t" -ge 1 ] && [ "$t" -le 600 ] || die 64 "timeout_s 必须是 1–600 的整数"
  user=xb-$key
  id -u "$user" >/dev/null 2>&1 || die 65 "员工的系统用户 $user 不存在"
  dir=$BOTS/$key
  cd "$dir" 2>/dev/null || die 65 "员工目录 $dir 不存在"

  # sudo relays the caller's TERM, INT or HUP to this process, not to the command's group, so the
  # trap is what ends it: TERM to the group, up to three seconds, KILL to the group. Only this
  # command's group: the employee's other commands keep running. `${!:-}` covers a signal that
  # lands between `&` and `pid=$!`; before timeout has made its group, timeout itself is signalled.
  pid=
  on_signal() {
    trap '' TERM INT HUP
    said=1
    p=${pid:-${!:-}}
    if [ -n "$p" ]; then
      kill -s TERM -- "-$p" 2>/dev/null || kill -s TERM "$p" 2>/dev/null || true
      n=0
      while [ "$n" -lt 30 ] && running "$p"; do
        sleep 0.1
        n=$((n + 1))
      done
      kill -s KILL -- "-$p" 2>/dev/null || kill -s KILL "$p" 2>/dev/null || true
    fi
    exit 143
  }
  trap on_signal TERM INT HUP

  # NAME=VALUE lines up to the first empty one. The helper sets HOME, TMPDIR, USER, LOGNAME and
  # SHELL itself; a line naming one of them, or not naming anything, is skipped.
  set --
  while IFS= read -r line; do
    [ -n "$line" ] || break
    case $line in
      *=*) ;;
      *) continue ;;
    esac
    name=${line%%=*}
    case $name in
      '' | [0-9]* | *[!A-Za-z0-9_]*) continue ;;
      HOME | TMPDIR | USER | LOGNAME | SHELL) continue ;;
    esac
    set -- "$@" "$line"
  done

  # The command never goes into an argv, which every user can read in /proc. Root writes it to a
  # 0600 file in its own directory, hands the file to the employee (bash re-opens /dev/fd/3, and
  # that open is checked against the file's owner), opens it as fd 3 and unlinks it before the
  # command starts.
  lockdir_ready || die 1 "准备 $LOCKDIR 失败"
  tmp=$( (umask 077 && mktemp "$LOCKDIR/cmd.XXXXXX") 2>/dev/null) || die 1 "无法创建临时文件"
  cat >"$tmp" || die 1 "无法写入临时文件"
  must "无法设置临时文件属主" chown "$user" "$tmp"
  true 2>/dev/null <"$tmp" || die 1 "无法打开临时文件"
  exec 3<"$tmp"
  rm -f -- "$tmp"
  tmp=

  # Not exec: the helper stays to end the command's process group, which timeout creates and whose
  # id is timeout's pid.
  timeout --kill-after=5 "$t" runuser -u "$user" -- env -i "$@" \
    HOME="$dir" TMPDIR="$dir/.tmp" USER="$user" LOGNAME="$user" /bin/bash /dev/fd/3 &
  pid=$!
  exec 3<&-
  trap - EXIT

  rc=0
  wait "$pid" || rc=$?
  # Whatever the command left in its group (`sleep 1000 &`) ends with it, so nothing holds the
  # output pipes open. Long-running background processes are not supported. The trap stays until
  # this is done, so a signal now still cleans up.
  kill -s KILL -- "-$pid" 2>/dev/null || true
  trap - TERM INT HUP
  exit "$rc"
}

# One tightening step that did not work: logged now, and remembered for restore_exit.
step_failed() {
  warn "$1"
  reasons=${reasons:+$reasons；}$1
}

# A tightening step, its tool's own complaint folded into one xb-bot: line.
attempt() {
  what=$1
  shift
  out=$("$@" 2>&1) || step_failed "$what：$(oneline "$out")"
}

# restore never stops the container. With the switch off a failure is a warning; with it on, the
# reasons go into $UNREADY, ensure refuses, and /health reports the per-employee computer not ready
# while the API and the default employee keep serving.
restore_exit() {
  rc=$?
  trap - EXIT
  if [ "$rc" != 0 ]; then
    step_failed "restore 意外中止（退出码 $rc）"
  fi
  if [ -n "$reasons" ]; then
    if [ "$switch" = on ]; then
      if lockdir_ready 2>/dev/null && (umask 077 && printf '%s\n' "$reasons" >"$UNREADY") 2>/dev/null; then
        warn "员工独立电脑未就绪：$reasons"
      else
        # Not ready and unable to say so: the one case that still stops the container.
        warn "写入 $UNREADY 失败"
        exit 1
      fi
    else
      warn "COMPUTER_PER_BOT_USERS 未开启，以上失败只告警"
    fi
  fi
  exit 0
}

cmd_restore() {
  [ "$(id -u)" = 0 ] && [ -z "${SUDO_USER:-}" ] || die 64 "restore 只能由 root 直接运行"
  case ${COMPUTER_PER_BOT_USERS:-off} in
    on) switch=on ;;
    *) switch=off ;;
  esac
  reasons=
  trap restore_exit EXIT

  # Employees must never read the container's environment (COMPUTER_TOKEN, database URLs).
  if [ -d "$CONTAINER_ENV" ]; then
    attempt "收紧 $CONTAINER_ENV 失败" chown root:root "$CONTAINER_ENV"
    attempt "收紧 $CONTAINER_ENV 失败" chmod 0700 "$CONTAINER_ENV"
  fi

  take_lock
  rm -f "$UNREADY"
  if [ -e "$TEST_FAIL" ]; then
    step_failed "测试注入的收紧失败（$TEST_FAIL）"
  fi

  if out=$(mkdir -p "$WORKSPACE" "$PROFILES" 2>&1); then
    attempt "设置 $WORKSPACE、$PROFILES 属主失败" chown pwuser:pwuser "$WORKSPACE" "$PROFILES"
    attempt "设置 $WORKSPACE 权限失败" chmod 0711 "$WORKSPACE"
    attempt "设置 $PROFILES 权限失败" chmod 0700 "$PROFILES"
    # Not a tightening failure: without ACLs, `ensure` fails and /health says not ready anyway.
    out=$(setfacl -d -m o::--- "$WORKSPACE" 2>&1) ||
      warn "设置 $WORKSPACE 的默认 ACL 失败（文件系统可能不支持 ACL）：$(oneline "$out")"
    attempt "设置 $BOTS 失败" bots_dir
    # The default employee's old files: other loses everything, owners stay. Links are not
    # followed, and only what has an other bit is touched.
    attempt "去掉 $WORKSPACE 旧文件的 other 权限失败" \
      find "$WORKSPACE" -mindepth 1 -path "$BOTS" -prune -o ! -type l -perm /o=rwx -exec chmod o-rwx {} +
  else
    step_failed "创建 $WORKSPACE、$PROFILES 失败：$(oneline "$out")"
  fi

  if [ -e "$MAP" ] || [ -L "$MAP" ]; then
    if ! map_trusted; then
      step_failed "映射文件 $MAP 不是 root 所有的普通文件，跳过恢复用户"
    else
      attempt "设置映射文件权限失败" chmod 0600 "$MAP"
      # One employee that cannot be recreated is that employee's problem (its ensure fails), not
      # the computer's: logged, not a reason to be unready.
      while read -r mk mu _rest || [ -n "${mk:-}" ]; do
        [ -n "$mk" ] || continue
        if ! valid_key "$mk" || ! valid_uid "${mu:-}"; then
          warn "跳过映射行：$mk ${mu:-}（key 不合法或 uid 不在 $UID_MIN–$UID_MAX 内）"
          mk=
          continue
        fi
        if have=$(id -u "xb-$mk" 2>/dev/null); then
          [ "$have" = "$mu" ] || warn "用户 xb-$mk 的 uid（$have）与映射记录（$mu）不一致"
        elif ! out=$(add_user "$mk" "$mu" 2>&1); then
          warn "按映射重建用户 xb-$mk（uid $mu）失败：$(oneline "$out")"
        fi
        mk=
      done <"$MAP"
    fi
  fi
}

if [ $# -lt 1 ]; then
  die 64 "用法：xb-bot ensure <key> | run <key> <timeout_s> | restore"
fi
case $1 in
  ensure)
    [ $# -eq 2 ] && valid_key "$2" || die 64 "用法：xb-bot ensure <key>（key 为 12 位小写十六进制）"
    cmd_ensure "$2"
    ;;
  run)
    [ $# -eq 3 ] && valid_key "$2" || die 64 "用法：xb-bot run <key> <timeout_s>（key 为 12 位小写十六进制）"
    cmd_run "$2" "$3"
    ;;
  restore)
    [ $# -eq 1 ] || die 64 "用法：xb-bot restore"
    cmd_restore
    ;;
  *)
    die 64 "未知子命令：$1"
    ;;
esac
