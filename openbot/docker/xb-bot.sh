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
# Exit 64: arguments refused. Exit 65 (run): the employee's user or directory is missing. Every error
# of the helper's own is one stderr line starting `xb-bot: `, which is how agent-computer tells a
# refusal from a command that happened to exit 64 or 65 itself.
#
# Nothing is read from the caller's environment: sudo resets it, and PATH is set here.
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
LOCK=/run/xb-bot.lock
CONTAINER_ENV=/run/s6/container_environment
UID_MIN=20000
UID_MAX=59999

die() {
  code=$1
  shift
  printf 'xb-bot: %s\n' "$*" >&2
  exit "$code"
}

warn() {
  printf 'xb-bot: %s\n' "$*" >&2
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

# The uid the map records for a key, or nothing.
mapped_uid() {
  [ -e "$MAP" ] || [ -L "$MAP" ] || return 0
  map_trusted || die 1 "映射文件 $MAP 不是 root 所有的普通文件，拒绝使用"
  while read -r mk mu _rest; do
    if [ "$mk" = "$1" ]; then
      printf '%s\n' "$mu"
      return 0
    fi
  done <"$MAP"
}

add_user() {
  # $1 key, $2 uid or empty
  if [ -n "$2" ]; then
    useradd --system -u "$2" --gid xbbots --home-dir "$BOTS/$1" --no-create-home \
      --shell /usr/sbin/nologin "xb-$1"
  else
    useradd --system --gid xbbots --home-dir "$BOTS/$1" --no-create-home \
      --shell /usr/sbin/nologin "xb-$1"
  fi
}

# /workspace/bots as a real directory. pwuser owns /workspace and could leave a link here.
bots_dir() {
  if [ -L "$BOTS" ]; then
    rm -f "$BOTS"
  fi
  mkdir -p "$BOTS"
  chown pwuser:pwuser "$BOTS"
  chmod 0711 "$BOTS"
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
  exec 9>>"$LOCK"
  flock -w 60 9 || die 1 "等待 $LOCK 超时"

  recorded=$(mapped_uid "$key")
  if [ -n "$recorded" ] && ! valid_uid "$recorded"; then
    die 1 "映射中 $key 的 uid（$recorded）不在 $UID_MIN–$UID_MAX 内"
  fi
  if ! uid=$(id -u "$user" 2>/dev/null); then
    add_user "$key" "$recorded" >&2 || die 1 "创建用户 $user 失败"
    uid=$(id -u "$user") || die 1 "创建用户 $user 后查不到它"
  fi
  valid_uid "$uid" || die 1 "用户 $user 的 uid（$uid）不在 $UID_MIN–$UID_MAX 内"
  if [ -z "$recorded" ]; then
    if [ -e "$MAP" ] || [ -L "$MAP" ]; then
      map_trusted || die 1 "映射文件 $MAP 不是 root 所有的普通文件，拒绝写入"
    fi
    (umask 077 && printf '%s %s\n' "$key" "$uid" >>"$MAP") || die 1 "写入映射文件失败"
    chown root:root "$MAP" && chmod 0600 "$MAP" || die 1 "设置映射文件权限失败"
  elif [ "$recorded" != "$uid" ]; then
    die 1 "用户 $user 的 uid（$uid）与映射记录（$recorded）不一致"
  fi

  if [ ! -d "$BOTS" ] || [ -L "$BOTS" ]; then
    bots_dir || die 1 "创建 $BOTS 失败"
  fi
  real_bots=$(cd -P "$BOTS" && pwd) || die 1 "进不去 $BOTS"
  dir=$BOTS/$key
  if [ -L "$dir" ]; then
    rm -f "$dir"
  fi
  mkdir -p "$dir" || die 1 "创建 $dir 失败"
  # Worked on as `.` once inside, so a link swapped in for the path cannot redirect what follows.
  cd "$dir" || die 1 "进不去 $dir"
  [ "$(pwd -P)" = "$real_bots/$key" ] || die 1 "$dir 不是真实目录"
  chown "$user:xbcomp" . && chmod 2770 . || die 1 "设置 $dir 的属主和权限失败"
  setfacl -m "u:$user:rwx,u:pwuser:rwx,o::---" . || die 1 "设置 $dir 的 ACL 失败（文件系统可能不支持 ACL）"
  setfacl -d -m "u:$user:rwx,u:pwuser:rwx,o::---" . || die 1 "设置 $dir 的默认 ACL 失败（文件系统可能不支持 ACL）"
  # The employee owns this directory and may have left a link or a file where .tmp belongs.
  if [ -L .tmp ] || { [ -e .tmp ] && [ ! -d .tmp ]; }; then
    rm -f .tmp
  fi
  mkdir -p .tmp || die 1 "创建 $dir/.tmp 失败"
  cd .tmp || die 1 "进不去 $dir/.tmp"
  [ "$(pwd -P)" = "$real_bots/$key/.tmp" ] || die 1 "$dir/.tmp 不是真实目录"
  # g-s as well: .tmp inherits the parent's setgid bit, and GNU chmod keeps it on a directory.
  chown "$user:xbcomp" . && chmod 0700 . && chmod g-s . || die 1 "设置 $dir/.tmp 的属主和权限失败"
  printf '%s\n' "$uid"
}

cmd_run() {
  key=$1
  t=$2
  case $t in
    '' | 0* | *[!0-9]* | ????*) die 64 "timeout_s 必须是 1–600 的整数" ;;
  esac
  [ "$t" -ge 1 ] && [ "$t" -le 600 ] || die 64 "timeout_s 必须是 1–600 的整数"
  user=xb-$key
  id -u "$user" >/dev/null 2>&1 || die 65 "员工的系统用户 $user 不存在"
  dir=$BOTS/$key
  cd "$dir" 2>/dev/null || die 65 "员工目录 $dir 不存在"

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
  cmd=$(cat)

  # sudo relays the caller's TERM, INT or HUP to this process, not to the command's group, so the
  # trap is what ends it: TERM to the group, up to three seconds, KILL to the group, then anything
  # left running as the employee.
  pid=
  on_signal() {
    trap '' TERM INT HUP
    if [ -n "$pid" ]; then
      kill -s TERM -- "-$pid" 2>/dev/null || true
      n=0
      while [ "$n" -lt 30 ] && running "$pid"; do
        sleep 0.1
        n=$((n + 1))
      done
      kill -s KILL -- "-$pid" 2>/dev/null || true
    fi
    pkill -KILL -u "$user" 2>/dev/null || true
    exit 143
  }
  trap on_signal TERM INT HUP

  # Not exec: the helper stays to end the command's process group, which timeout creates and whose
  # id is timeout's pid.
  timeout --kill-after=5 "$t" runuser -u "$user" -- env -i "$@" \
    HOME="$dir" TMPDIR="$dir/.tmp" USER="$user" LOGNAME="$user" /bin/bash -c "$cmd" &
  pid=$!

  rc=0
  wait "$pid" || rc=$?
  trap - TERM INT HUP
  # Whatever the command left in its group (`sleep 1000 &`) ends with it, so nothing holds the
  # output pipes open. Long-running background processes are not supported.
  kill -s KILL -- "-$pid" 2>/dev/null || true
  exit "$rc"
}

cmd_restore() {
  [ "$(id -u)" = 0 ] && [ -z "${SUDO_USER:-}" ] || die 64 "restore 只能由 root 直接运行"
  failed=0

  # Employees must never read the container's environment (COMPUTER_TOKEN, database URLs).
  if [ -d "$CONTAINER_ENV" ]; then
    chown root:root "$CONTAINER_ENV" && chmod 0700 "$CONTAINER_ENV" ||
      { warn "收紧 $CONTAINER_ENV 失败"; failed=1; }
  fi

  exec 9>>"$LOCK"
  flock -w 60 9 || die 1 "等待 $LOCK 超时"

  mkdir -p "$WORKSPACE" "$PROFILES" || die 1 "创建 $WORKSPACE、$PROFILES 失败"
  chown pwuser:pwuser "$WORKSPACE" "$PROFILES" || { warn "设置 $WORKSPACE、$PROFILES 属主失败"; failed=1; }
  chmod 0711 "$WORKSPACE" || { warn "设置 $WORKSPACE 权限失败"; failed=1; }
  chmod 0700 "$PROFILES" || { warn "设置 $PROFILES 权限失败"; failed=1; }
  # Not fatal: without ACLs, `ensure` fails and /health says the computer is not ready.
  setfacl -d -m o::--- "$WORKSPACE" || warn "设置 $WORKSPACE 的默认 ACL 失败（文件系统可能不支持 ACL）"
  bots_dir || { warn "设置 $BOTS 失败"; failed=1; }

  # The default employee's old files: other loses everything, owners stay. Links are not followed.
  find "$WORKSPACE" -mindepth 1 -path "$BOTS" -prune -o ! -type l -exec chmod o-rwx {} + ||
    { warn "去掉 $WORKSPACE 旧文件的 other 权限失败"; failed=1; }

  if [ -e "$MAP" ] || [ -L "$MAP" ]; then
    if ! map_trusted; then
      warn "映射文件 $MAP 不是 root 所有的普通文件，跳过恢复用户"
      failed=1
    else
      chmod 0600 "$MAP" || warn "设置映射文件权限失败"
      while read -r mk mu _rest; do
        [ -n "$mk" ] || continue
        if ! valid_key "$mk" || ! valid_uid "$mu"; then
          warn "跳过映射行：$mk $mu（key 不合法或 uid 不在 $UID_MIN–$UID_MAX 内）"
          continue
        fi
        if have=$(id -u "xb-$mk" 2>/dev/null); then
          [ "$have" = "$mu" ] || warn "用户 xb-$mk 的 uid（$have）与映射记录（$mu）不一致"
          continue
        fi
        add_user "$mk" "$mu" >&2 || warn "按映射重建用户 xb-$mk（uid $mu）失败"
      done <"$MAP"
    fi
  fi

  [ "$failed" = 0 ] || die 1 "restore 未能全部完成"
}

[ $# -ge 1 ] || die 64 "用法：xb-bot ensure <key> | run <key> <timeout_s> | restore"
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
