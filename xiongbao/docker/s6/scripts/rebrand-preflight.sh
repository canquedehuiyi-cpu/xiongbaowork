#!/bin/sh
# The safety rails in front of the v0.2.16 rename of persisted names (roles, database, functions,
# markers, credentials, history). Nothing in here renames anything: it decides whether this volume
# still needs the rename and, when it does, makes sure the rename may start and that a backup exists
# before the first step touches data.
#
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，the whole file goes with the rename migration
#
#   PGPASSWORD=<owner password> rebrand-preflight.sh check -h <host> [-p <port>] -U <superuser> -d <database>
#
#     Needs the rename when the cluster does not yet carry the new names: the bootstrap superuser
#     (oid 10, the role initdb created) is not yet called xiongbao, or there is no xiongbao_app role yet.
#     In the delivery container that is the same as "one of the two old roles is still there": initdb
#     created the superuser under the old name, migration 0054 created the old app role, and the rename
#     turns exactly those two into the new names. (Spelled through the new names because the brand
#     guard keeps the bare old superuser name out of new image script lines.)
#
#     Not needed: prints nothing, writes nothing but the state file, exits 0.
#     Needed, on a database no migration has ever run on (a new volume's first boot): nothing to back
#       up; exits 0.
#     Needed, otherwise, in this order, each refusal exiting 1 before anything is written:
#       - a failure marker from an earlier attempt (see `step`) refuses: retrying would only add a dump;
#       - anything in flight refuses: pending approvals, unfinished continuations and their steps, with
#         the same queries as scripts/rebrand/prod-inspect.sh (run assertions are signed tokens, never
#         stored, so there is nothing to count);
#       - less free space where the backup goes than twice the database size refuses;
#       - then `pg_dump -Fc` to $BACKUP_DIR/pre-rebrand-<UTC YYYYMMDDTHHMMSSZ>.dump, mode 0600, owner
#         postgres, in a 0700 directory on the database volume. Written under a temporary name, read
#         back with pg_restore --list, and only then given its final name.
#
#   rebrand-preflight.sh step <step name> <kind of data> -- <command> [args...]
#
#     Runs one step of the migration. Every step is expected to run in a single transaction, so a
#     failure has rolled that step back. On failure it prints which step, which kind of data and, when
#     this boot made a backup, where the backup is; writes the failure marker next to the backup; and
#     exits non-zero, so migrate.sh stops and the container does not serve (S6_BEHAVIOUR_IF_STAGE2_FAILS=2).
#     Later rename tasks add their work as further steps in migrate.sh.
#
# The state of this boot (needs_rebrand=0|1, backup=<path or empty>) is kept in $STATE_DIR/state, which
# `step` reads; it holds no secret. The overrides below exist for the tests and for a deployment whose
# database is not in this container; the delivery image uses the defaults.
set -eu

PG_BIN=${REBRAND_PG_BIN:-/usr/lib/postgresql/16/bin}
BACKUP_DIR=${REBRAND_BACKUP_DIR:-/var/lib/postgresql/backup}
STATE_DIR=${REBRAND_STATE_DIR:-/run/xiongbao-rebrand}
STATE=$STATE_DIR/state
MARKER=$BACKUP_DIR/rebrand-failed

say() { printf 'rebrand-preflight: %s\n' "$*"; }
refuse() { printf 'rebrand-preflight: %s\n' "$@" >&2; }

usage() {
  echo 'usage: rebrand-preflight.sh check -h <host> [-p <port>] -U <superuser> -d <database>' >&2
  echo '       rebrand-preflight.sh step <step name> <kind of data> -- <command> [args...]' >&2
  exit 2
}

write_state() { # needs_rebrand backup
  mkdir -p "$STATE_DIR"
  printf 'needs_rebrand=%s\nbackup=%s\n' "$1" "$2" >"$STATE.tmp"
  chmod 644 "$STATE.tmp"
  mv -f "$STATE.tmp" "$STATE"
}

# Files on the database volume belong to postgres, as the rest of it does; only root can hand them over.
give_to_postgres() {
  if [ "$(id -u)" = 0 ] && id postgres >/dev/null 2>&1; then chown postgres:postgres "$@"; fi
}

check() {
  host='' port=5432 user='' db=''
  while [ "$#" -ge 2 ]; do
    case $1 in
      -h) host=$2 ;;
      -p) port=$2 ;;
      -U) user=$2 ;;
      -d) db=$2 ;;
      *) usage ;;
    esac
    shift 2
  done
  [ "$#" -eq 0 ] && [ -n "$host" ] && [ -n "$user" ] && [ -n "$db" ] || usage
  case $port in '' | *[!0-9]*) usage ;; esac

  # One read-only session per question; the answer is one line. A failed query refuses: deciding on a
  # half answer is how a rename starts with work in flight.
  ask() {
    printf 'SET default_transaction_read_only = on;\n%s\n' "$1" |
      "$PG_BIN/psql" -X -q -A -t -w -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$user" -d "$db" 2>"$STATE_DIR/psql.err" |
      tail -n 1
  }
  number() { # what sql
    n=$(ask "$2") || n=''
    case $n in
      '' | *[!0-9]*)
        refuse "无法读取$1，不改名、不启动（数据没有改动）。数据库的报错：" "$(cat "$STATE_DIR/psql.err" 2>/dev/null)"
        exit 1
        ;;
    esac
    echo "$n"
  }
  # A refusal leaves no state behind, so no step can mistake an earlier decision for this one.
  mkdir -p "$STATE_DIR"
  rm -f "$STATE"

  renamed=$(number "数据库角色" "SELECT count(*) FROM pg_roles WHERE (oid = 10 AND rolname = 'xiongbao') OR rolname = 'xiongbao_app';") || exit 1
  if [ "$renamed" -eq 2 ]; then
    write_state 0 ''
    return 0
  fi

  if [ -e "$MARKER" ]; then
    refuse "上一次改名迁移失败了，这次不再自动重试（每试一次都会多一份备份）。不改名、不启动。" \
      "上一次的记录：" "$(sed 's/^/  /' "$MARKER")" \
      "排除失败原因后，删掉 $MARKER 再启动容器，例如在宿主机执行：" \
      "  docker run --rm --volumes-from xiongbao --user root --entrypoint rm \"\$(docker inspect -f '{{.Config.Image}}' xiongbao)\" -f $MARKER" \
      "  docker start xiongbao" \
      "（容器名不是 xiongbao 时换成实际的名字。）"
    exit 1
  fi

  migrated=$(number "迁移记录" "SELECT count(*) FROM pg_tables WHERE schemaname = 'drizzle' AND tablename = '__drizzle_migrations';") || exit 1
  if [ "$migrated" -eq 0 ]; then
    say "数据库还没有任何迁移（新装的卷），没有数据要备份。"
    write_state 1 ''
    return 0
  fi

  # The same statements as scripts/rebrand/prod-inspect.sh (pre-upgrade-check.test.ts holds them equal).
  pending=$(number "待审批数" "SELECT count(*) FROM approval_requests WHERE status = 'pending';") || exit 1
  continuations=$(number "未完成的续跑数" "SELECT count(*) FROM approval_continuations WHERE state <> 'completed';") || exit 1
  steps=$(number "未完成的续跑步骤数" "SELECT count(*) FROM approval_continuation_steps WHERE state <> 'completed';") || exit 1
  if [ "$pending" -gt 0 ] || [ "$continuations" -gt 0 ] || [ "$steps" -gt 0 ]; then
    refuse "还有没处理完的在途工作，不改名、不启动（数据没有改动）：" \
      "  待审批：$pending" \
      "  未完成的续跑：$continuations" \
      "  未完成的续跑步骤：$steps" \
      "  未过期的运行断言：不入库，不计数（10 分钟内自动过期的签名令牌）" \
      "处理办法：换回 v0.2.15 镜像启动（数据没动过，可以直接回去），在网页里把待审批全部批准或拒绝，" \
      "等已批准的任务续跑完；再在服务器上运行 pre-upgrade-check.sh，三项都是 0 时重新升级。"
    exit 1
  fi

  size=$(number "数据库大小" "SELECT pg_database_size(current_database());") || exit 1
  # df on the backup directory, or on the directory it will be created in.
  where=$BACKUP_DIR
  [ -d "$where" ] || where=$(dirname "$BACKUP_DIR")
  avail_kb=$(df -kP "$where" 2>/dev/null | awk 'NR == 2 { print $4 }')
  case $avail_kb in
    '' | *[!0-9]*)
      refuse "读不到 $where 所在盘的可用空间，不改名、不启动（数据没有改动）。"
      exit 1
      ;;
  esac
  need_kb=$(((size * 2 + 1023) / 1024))
  if [ "$avail_kb" -lt "$need_kb" ]; then
    mb() { echo $((($1 + 1023) / 1024)); }
    refuse "备份盘空间不够，不改名、不启动（数据没有改动）。" \
      "  数据库：$(mb $(((size + 1023) / 1024))) MB" \
      "  备份前 $BACKUP_DIR 所在盘需要至少 $(mb "$need_kb") MB 可用（库大小 × 2）" \
      "  现在可用：$((avail_kb / 1024)) MB，还差 $(mb $((need_kb - avail_kb))) MB" \
      "处理办法：在宿主机上清理这块盘（例如 docker system prune 清掉不用的镜像），然后重启容器。"
    exit 1
  fi

  (umask 077 && mkdir -p "$BACKUP_DIR")
  chmod 700 "$BACKUP_DIR"
  give_to_postgres "$BACKUP_DIR"
  name=pre-rebrand-$(date -u +%Y%m%dT%H%M%SZ).dump
  # Two attempts within one second would share a name; never overwrite a backup.
  while [ -e "$BACKUP_DIR/$name" ]; do
    sleep 1
    name=pre-rebrand-$(date -u +%Y%m%dT%H%M%SZ).dump
  done
  final=$BACKUP_DIR/$name
  partial=$BACKUP_DIR/.$name.partial
  say "正在备份数据库到 $final ……"
  if ! (umask 077 && "$PG_BIN/pg_dump" -Fc -w -h "$host" -p "$port" -U "$user" -d "$db" -f "$partial") 2>"$STATE_DIR/pg_dump.err" ||
    ! "$PG_BIN/pg_restore" --list "$partial" >/dev/null 2>>"$STATE_DIR/pg_dump.err"; then
    rm -f "$partial"
    refuse "备份没有做成，不改名、不启动（数据没有改动）。pg_dump 的报错：" "$(cat "$STATE_DIR/pg_dump.err")"
    exit 1
  fi
  chmod 600 "$partial"
  give_to_postgres "$partial"
  mv -f "$partial" "$final"
  sync
  write_state 1 "$final"
  say "升级前备份已写好：$final（$((($(wc -c <"$final") + 1048575) / 1048576)) MB，权限 0600）。改名迁移开始。"
}

step() {
  [ "$#" -ge 4 ] && [ "$3" = "--" ] || usage
  label=$1 data=$2
  shift 3
  needs=$(sed -n 's/^needs_rebrand=//p' "$STATE" 2>/dev/null || true)
  backup=$(sed -n 's/^backup=//p' "$STATE" 2>/dev/null || true)
  code=0
  "$@" || code=$?
  [ "$code" -eq 0 ] && return 0

  if [ "$needs" = 1 ] && [ -n "$backup" ]; then
    (
      umask 077
      printf 'step=%s\ndata=%s\nbackup=%s\nat=%s\n' "$label" "$data" "$backup" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$MARKER"
    )
    give_to_postgres "$MARKER"
    refuse "「$label」这一步失败（退出码 $code），涉及的数据：$data。服务不启动。" \
      "这一步在单个事务里执行，失败时已整体回滚，这一步涉及的数据保持原样；它自己的报错见上方。" \
      "升级前的备份：$backup（容器内路径，0600）。取到宿主机：docker cp xiongbao:$backup ./" \
      "要回到升级前：换回 v0.2.15 镜像，用这份备份按升级单的回滚步骤恢复。" \
      "为免重启一次多一份备份，排除原因之前不会再试；排除后删掉 $MARKER 再启动。"
  else
    refuse "「$label」这一步失败（退出码 $code），涉及的数据：$data。服务不启动；它自己的报错见上方。"
  fi
  exit "$code"
}

case ${1:-} in
  check) shift; check "$@" ;;
  step) shift; step "$@" ;;
  *) usage ;;
esac
