#!/bin/sh
# The safety rails around the v0.2.16 rename of persisted names (roles, database, functions, markers,
# credentials, history). Nothing in here renames anything: it decides whether this volume still needs
# the rename, makes sure the rename may start, backs the database up before the first step touches
# data, runs the steps, and keeps a record on the volume until the last step is done.
#
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，the whole file goes with the rename migration
#
# ORDER AND ATOMICITY (controller ruling for R3). Atomic per database connection: every migration of the
# business database (the drizzle/recovery SQL, the object rename, the credential rekey, the history
# rewrite) is one transaction on the business database, and inserts its rows into the migration journal
# in that same transaction; the role and database rename has to connect to the `postgres` database, so
# it cannot share that transaction and runs last, before the service starts. Across steps the safety is:
# the in-progress record written right after the backup and removed only when every step is done; every
# step idempotent, so it can run again; and the backup.
#
#   PGPASSWORD=<owner password> rebrand-preflight.sh check -h <host> [-p <port>] -U <superuser> -d <database>
#
#     The rename is needed while the cluster does not yet carry every new name: the bootstrap superuser
#     (oid 10, the role initdb created) called xiongbao, the database this connects to called xiongbao,
#     and the roles xiongbao_app and xiongbao_role_writer. In the delivery container that is the same as
#     "one of the old names is still there": initdb created the superuser and the database under the old
#     name, migrations 0054 and 0109 created the old application roles, and the rename turns exactly
#     those four into the new names, in two steps (the application roles with the business database, the
#     superuser and the database last), so a volume can sit between them and still needs the rename.
#     (Spelled through the new names because the brand guard keeps the bare old superuser name out of new
#     image script lines.) Connect with the names the cluster answers to now (migrate.sh asks
#     rebrand-superuser.sh), so a resumed rename finds the database whichever step it stopped after.
#
#     In this order:
#       - an in-progress record from an earlier boot (the rename started and did not finish: a step
#         failed, a command outside the steps failed, or the container was killed) means resume: no new
#         backup, the recorded one is named in the log and every step runs again. Checked before the
#         names, because the rename is several steps, the last of them committed apart from the others,
#         and a boot can stop between them with some names new and some old. Refused if the recorded
#         backup is gone, or if work is in flight again; such a refusal first compares the migration
#         journal with the record, and says the business database changed, did not, or cannot be told;
#       - not needed: prints nothing, writes nothing but the state file, exits 0;
#       - needed, on a database no migration has ever run on (a new volume's first boot): no user data,
#         nothing to back up, exits 0;
#       - needed, otherwise, each refusal exiting 1 before anything is written: anything in flight
#         (pending approvals, unfinished continuations and their steps, with the same queries as
#         scripts/rebrand/prod-inspect.sh; run assertions are signed tokens, never stored, so there is
#         nothing to count; a table older volumes do not have yet counts as 0); then less free space
#         where the backup goes than twice the database size;
#       - then `pg_dump -Fc` to $BACKUP_DIR/pre-rebrand-<UTC YYYYMMDDTHHMMSSZ>.dump, mode 0600, owner
#         postgres, in a 0700 directory on the database volume, written as postgres under a temporary
#         name, read back in full, renamed; then the in-progress record next to it.
#
#   PGPASSWORD=<owner password> rebrand-preflight.sh step <step name> <kind of data> -- <command> [args...]
#
#     Runs one step. A step that succeeds is added to the in-progress record. A step that fails stops
#     migrate.sh and so the container (S6_BEHAVIOUR_IF_STAGE2_FAILS=2), after saying which step, which
#     kind of data, which steps had already completed, and whether the business database has changed:
#     it compares the migration journal with its size at backup time, which the ruling above makes exact
#     for the business transaction. Unchanged: nothing to restore, the old version runs on this volume as
#     it is. Changed: resume by restarting, or restore with rebrand-restore.sh next to this file. The
#     superuser and database rename is a change to the cluster that the journal never records, and once it
#     is made v0.2.15 cannot log in at all: so "unchanged" also needs the cluster to still carry its old
#     names (asked, not assumed), and a renamed cluster is reported as one the old version cannot take back.
#     The same holds for check's refusals while it resumes.
#
#   rebrand-preflight.sh finish
#
#     After the last step: removes the in-progress record. Until then every boot resumes.
#
# The state of this boot is kept in $STATE_DIR/state for `step` (no secret in it: the decision, the
# backup path, the connection's host, port, user and database names). The overrides below exist for the
# tests and for a deployment whose database is not in this container; the delivery image uses the
# defaults.
set -eu
umask 077

PG_BIN=${REBRAND_PG_BIN:-/usr/lib/postgresql/16/bin}
BACKUP_DIR=${REBRAND_BACKUP_DIR:-/var/lib/postgresql/backup}
STATE_DIR=${REBRAND_STATE_DIR:-/run/xiongbao-rebrand}
STATE=$STATE_DIR/state
MARKER=$BACKUP_DIR/rebrand-in-progress
ERR=$STATE_DIR/err

say() { printf 'rebrand-preflight: %s\n' "$@"; }
refuse() { printf 'rebrand-preflight: %s\n' "$@" >&2; }

usage() {
  echo 'usage: rebrand-preflight.sh check -h <host> [-p <port>] -U <superuser> -d <database>' >&2
  echo '       rebrand-preflight.sh step <step name> <kind of data> -- <command> [args...]' >&2
  echo '       rebrand-preflight.sh finish' >&2
  exit 2
}

# The database volume belongs to postgres, and so does everything written on it here. Written as
# postgres, so a link someone with the postgres uid planted on the volume gains them nothing.
as_pg() {
  if [ "$(id -u)" != 0 ] || ! id postgres >/dev/null 2>&1; then "$@"
  elif command -v s6-setuidgid >/dev/null 2>&1; then s6-setuidgid postgres "$@"
  else runuser -u postgres -- "$@"; fi
}

state_value() { sed -n "s/^$1=//p" "$STATE" 2>/dev/null || true; }
# The record is read as postgres too: a link swapped in after the -L check reaches only what postgres can.
marker_value() { as_pg sed -n "s/^$1=//p" "$MARKER" 2>/dev/null | tail -n 1; }
done_steps() { as_pg sed -n 's/^ok=//p' "$MARKER" 2>/dev/null | awk '!seen[$0]++' | tr '\n' ' ' | sed 's/ $//'; }

# What a refusal may say about the data. Without an in-progress record nothing has been renamed yet; with
# one, check() replaces both after comparing the migration journal with its size at backup time
# (resume_notes), so a refusal never claims "unchanged" for a database an earlier boot changed.
DATA_NOTE='（数据没有改动）'
GO_BACK='换回 v0.2.15 镜像启动（数据没动过，可以直接回去）'

write_state() { # needs_rebrand backup
  printf 'needs_rebrand=%s\nbackup=%s\nhost=%s\nport=%s\nuser=%s\ndb=%s\n' \
    "$1" "$2" "$host" "$port" "$user" "$db" >"$STATE.tmp"
  chmod 644 "$STATE.tmp"
  mv -f "$STATE.tmp" "$STATE"
}

# Replace the in-progress record with stdin: a fresh file made by mktemp (never an existing path), then
# renamed over the record, which replaces a link rather than following it.
write_marker() {
  tmp=$(as_pg mktemp "$BACKUP_DIR/.rebrand-in-progress.XXXXXX")
  as_pg sh -c 'cat >"$1"' sh "$tmp"
  as_pg mv -f "$tmp" "$MARKER"
}

no_links() {
  for p in "$BACKUP_DIR" "$MARKER"; do
    if [ -L "$p" ]; then
      refuse "$p 是符号链接，不改名、不启动（这次启动没有改动任何数据；没有读它，所以说不出上一次改名做到了哪里）。" \
        "备份目录和其中的记录只能是普通目录、普通文件；删掉这个链接后再启动。"
      exit 1
    fi
  done
}

# One read-only session per question, answered by one line; the error text goes to a 0600 file that is
# removed on exit. A failed query refuses: deciding on a half answer is how a rename starts with work in
# flight.
ask() {
  printf 'SET default_transaction_read_only = on;\n%s\n' "$1" |
    "$PG_BIN/psql" -X -q -A -t -w -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$user" -d "$db" 2>"$ERR" |
    tail -n 1
}
number() { # what sql
  n=$(ask "$2") || n=''
  case $n in
    '' | *[!0-9]*)
      refuse "无法读取$1，不改名、不启动$DATA_NOTE。数据库的报错：" "$(cat "$ERR" 2>/dev/null)"
      exit 1
      ;;
  esac
  echo "$n"
}

# In-flight counts; a table this volume does not have yet (volumes from before v0.2.12 have no
# continuation tables) counts as 0 and is named in the log.
in_flight_count() { # var table what sql
  t=$(number "表 $2 是否存在" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = '$2';") || exit 1
  if [ "$t" -eq 0 ]; then
    missing="$missing $2"
    eval "$1=0"
  else
    v=$(number "$3" "$4") || exit 1
    eval "$1=\$v"
  fi
}
in_flight() {
  missing=''
  # The same statements as scripts/rebrand/prod-inspect.sh (pre-upgrade-check.test.ts holds them equal).
  in_flight_count pending approval_requests "待审批数" "SELECT count(*) FROM approval_requests WHERE status = 'pending';"
  in_flight_count continuations approval_continuations "未完成的续跑数" "SELECT count(*) FROM approval_continuations WHERE state <> 'completed';"
  in_flight_count steps approval_continuation_steps "未完成的续跑步骤数" "SELECT count(*) FROM approval_continuation_steps WHERE state <> 'completed';"
  [ -z "$missing" ] || say "这个库还没有这些表（早于 v0.2.12 的卷），对应的在途数按 0 计：$missing"
  if [ "$pending" -gt 0 ] || [ "$continuations" -gt 0 ] || [ "$steps" -gt 0 ]; then
    refuse "还有没处理完的在途工作，不改名、不启动$DATA_NOTE：" \
      "  待审批：$pending" \
      "  未完成的续跑：$continuations" \
      "  未完成的续跑步骤：$steps" \
      "  未过期的运行断言：不入库，不计数（10 分钟内自动过期的签名令牌）" \
      "处理办法：$GO_BACK，在网页里把待审批全部批准或拒绝，" \
      "等已批准的任务续跑完；再在服务器上运行 pre-upgrade-check.sh，三项都是 0 时重新升级。"
    exit 1
  fi
}

# Whether the superuser or the database already carries the new name: 1, 0, or nothing when it cannot be
# read. A change to the cluster, not to the business database, so the migration journal does not show it.
cluster_renamed() {
  r=$(ask "SELECT ((SELECT rolname FROM pg_roles WHERE oid = 10) = 'xiongbao' OR current_database() = 'xiongbao')::int;") || r=''
  case $r in 0 | 1) echo "$r" ;; esac
}
RESTORE_STEPS='先按 /etc/s6-overlay/scripts/rebrand-restore.sh 开头写的步骤用备份还原（还原回到备份那一刻：备份之后写进去的数据都会丢掉，上面列出的待审批与续跑也在其中，还原后要重新发起）'

# With an in-progress record: has the business database changed since the backup, or the cluster been
# renamed? Same answers as a failing step gives. Unknown (the database cannot be read, or the record
# lacks the count) is never reported as unchanged.
resume_notes() {
  was=$(marker_value journal)
  now=$(ask "SELECT count(*) FROM drizzle.__drizzle_migrations;") || now=''
  renamed=''
  [ -z "$now" ] || renamed=$(cluster_renamed)
  case $was:$now:$renamed in
    *[!0-9:]* | :* | *::* | *:)
      DATA_NOTE='（这次启动没有改动任何数据；但读不到迁移记录或集群的名字，无法确认上一次改名是否已经改动了数据库）'
      GO_BACK='先不要换回 v0.2.15（上一次改名可能已经改动了数据库）：修好数据库连接后再启动，看到确切结论再决定'
      ;;
    "$now:$now:1")
      DATA_NOTE="（注意：上一次改名已经把数据库超级用户与库改成了新名字；迁移记录虽与备份时一样（$now 条），v0.2.15 已经登录不了这个库）"
      GO_BACK="不能直接换回 v0.2.15（集群已改名）：要在 v0.2.15 上处理，$RESTORE_STEPS"
      ;;
    "$now:$now:0")
      DATA_NOTE="（上一次改名没有改动业务库：迁移记录与备份时一样，$now 条）"
      GO_BACK="换回 v0.2.15 镜像启动（业务库没被改动，可以直接回去；换回之前先删掉 $MARKER，以后再升级时才会重新备份）"
      ;;
    *)
      DATA_NOTE="（注意：上一次改名已经改动了业务库，迁移记录从备份时的 $was 条变成 $now 条）"
      GO_BACK="不能直接换回 v0.2.15（业务库已经改动）：要在 v0.2.15 上处理，$RESTORE_STEPS"
      ;;
  esac
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

  # A refusal leaves no state behind, so no step can mistake an earlier decision for this one.
  mkdir -p "$STATE_DIR"
  chmod 755 "$STATE_DIR"
  rm -f "$STATE"
  trap 'rm -f "$ERR"' EXIT
  no_links
  # A dump killed half-way (container stopped, host rebooted) leaves its temporary file: not a backup,
  # and it would count against the space check. Same for a record write cut off before its rename.
  if [ -d "$BACKUP_DIR" ]; then
    as_pg find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '.pre-rebrand-*.partial' -o -name '.rebrand-in-progress.*' \) -delete
  fi

  if [ -f "$MARKER" ]; then
    resume_notes
    backup=$(marker_value backup)
    if [ -z "$backup" ] || [ ! -f "$backup" ]; then
      refuse "上一次改名迁移没有完成，记录里的备份 ${backup:-（没有）} 却不见了。不改名、不启动$DATA_NOTE。" \
        "没有备份就不再继续：先把备份放回原处，再启动。" \
        "确认不需要那份备份时，删掉 $MARKER 再启动，会重新检查、重新备份。"
      exit 1
    fi
    in_flight
    write_state 1 "$backup"
    steps_done=$(done_steps)
    say "上一次改名迁移没有完成（开始于 $(marker_value started)；已完成的步骤：${steps_done:-无}）。" \
      "这次不再备份，沿用升级前的备份 $backup，各步骤从头再执行一遍（每一步都可以重跑）。"
    return 0
  fi

  renamed=$(number "数据库角色" "SELECT count(*) + (current_database() = 'xiongbao')::int FROM pg_roles
    WHERE (oid = 10 AND rolname = 'xiongbao') OR rolname IN ('xiongbao_app', 'xiongbao_role_writer');") || exit 1
  if [ "$renamed" -eq 4 ]; then
    write_state 0 ''
    return 0
  fi

  migrated=$(number "迁移记录表" "SELECT count(*) FROM pg_tables WHERE schemaname = 'drizzle' AND tablename = '__drizzle_migrations';") || exit 1
  if [ "$migrated" -eq 0 ]; then
    say "数据库还没有任何迁移（新装的卷），没有数据要备份。"
    write_state 1 ''
    return 0
  fi

  in_flight

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
  journal=$(number "迁移记录" "SELECT count(*) FROM drizzle.__drizzle_migrations;") || exit 1

  # Created by root (its parent may be root's), handed over without following a link, and from then on
  # touched only as postgres.
  [ -d "$BACKUP_DIR" ] || mkdir -m 700 "$BACKUP_DIR"
  no_links
  if [ "$(id -u)" = 0 ] && id postgres >/dev/null 2>&1; then chown -h postgres:postgres "$BACKUP_DIR"; fi
  as_pg chmod 700 "$BACKUP_DIR"
  name=pre-rebrand-$(date -u +%Y%m%dT%H%M%SZ).dump
  # Two attempts within one second would share a name; never overwrite a backup.
  while [ -e "$BACKUP_DIR/$name" ]; do
    sleep 1
    name=pre-rebrand-$(date -u +%Y%m%dT%H%M%SZ).dump
  done
  final=$BACKUP_DIR/$name
  say "正在备份数据库到 $final ……"
  partial=''
  # Read back in full (pg_restore to /dev/null reads every data block, not only the table of contents).
  if ! partial=$(as_pg mktemp "$BACKUP_DIR/.pre-rebrand-XXXXXX.partial" 2>"$ERR") ||
    ! as_pg "$PG_BIN/pg_dump" -Fc -w -h "$host" -p "$port" -U "$user" -d "$db" -f "$partial" 2>>"$ERR" ||
    ! as_pg "$PG_BIN/pg_restore" -f /dev/null "$partial" 2>>"$ERR" ||
    ! as_pg mv -n "$partial" "$final" 2>>"$ERR" || [ -e "$partial" ]; then
    [ -z "$partial" ] || as_pg rm -f "$partial"
    refuse "备份没有做成，不改名、不启动（数据没有改动）。报错：" "$(cat "$ERR")"
    exit 1
  fi
  sync
  printf 'started=%s\nbackup=%s\njournal=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$final" "$journal" | write_marker
  write_state 1 "$final"
  say "升级前备份已写好：$final（$((($(wc -c <"$final") + 1048575) / 1048576)) MB，权限 0600）。改名迁移开始。"
}

step() {
  [ "$#" -ge 4 ] && [ "$3" = "--" ] || usage
  label=$1 data=$2
  shift 3
  code=0
  # The command runs under the usual umask; 077 is for what this script itself writes.
  (umask 022 && exec "$@") || code=$?
  if [ -L "$MARKER" ] || [ ! -f "$MARKER" ]; then
    [ "$code" -eq 0 ] && return 0
    refuse "「$label」这一步失败（退出码 $code），涉及的数据：$data。服务不启动；它自己的报错见上方。"
    exit "$code"
  fi
  if [ "$code" -eq 0 ]; then
    { as_pg cat "$MARKER"; printf 'ok=%s\n' "$label"; } | write_marker
    return 0
  fi

  backup=$(marker_value backup)
  journal=$(marker_value journal)
  steps_done=$(done_steps)
  host=$(state_value host) port=$(state_value port) user=$(state_value user) db=$(state_value db)
  now='' renamed=''
  if [ -n "$host" ]; then
    now=$(ask "SELECT count(*) FROM drizzle.__drizzle_migrations;") || now=''
    [ "$now" != "$journal" ] || renamed=$(cluster_renamed)
    rm -f "$ERR"
  fi
  # Unchanged journal but a renamed cluster (or one whose names cannot be read): not "unchanged".
  case $renamed in 0) ;; 1) now=renamed ;; *) [ "$now" != "$journal" ] || now='' ;; esac
  refuse "「$label」这一步失败（退出码 $code），涉及的数据：$data。服务不启动；它自己的报错见上方。" \
    "这次之前已完成的步骤：${steps_done:-无}。升级前的备份：$backup（容器内路径，0600）。"
  case $now in
    renamed)
      refuse "业务库的迁移记录与备份时一样（$journal 条），但数据库超级用户与库已经改成新名字（这是集群级改动，迁移记录里看不到），" \
        "v0.2.15 用旧名登录不了：不能直接换回 v0.2.15。修好原因后重启容器，各步骤会接着做（不会再备份）；" \
        "要回到升级前，按镜像里 /etc/s6-overlay/scripts/rebrand-restore.sh 开头写的步骤用这份备份还原。"
      ;;
    '' | *[!0-9]*)
      refuse "无法确认数据库是否已改动（读不到迁移记录或集群的名字）。修好原因后重启容器会接着做（不会再备份）；" \
        "要回到升级前，按镜像里 /etc/s6-overlay/scripts/rebrand-restore.sh 开头写的步骤用这份备份还原。"
      ;;
    "$journal")
      refuse "业务库没有改动：迁移记录与备份时一样（$journal 条），业务库的事务没有提交，不需要还原备份。" \
        "可以修好原因后重启容器重试（不会再备份）；也可以直接换回 v0.2.15 镜像继续用这个卷，" \
        "换回之前先删掉 $MARKER，以后再升级时才会重新备份：" \
        "  docker run --rm --volumes-from xiongbao --user root --entrypoint rm \"\$(docker inspect -f '{{.Config.Image}}' xiongbao)\" -f $MARKER" \
        "（容器名不是 xiongbao 时换成实际的名字。）"
      ;;
    *)
      refuse "业务库已经改动：迁移记录从备份时的 $journal 条变成 $now 条，不能直接换回 v0.2.15。" \
        "修好原因后重启容器，各步骤会接着做（每一步都可以重跑，不会再备份）；" \
        "要回到升级前，按镜像里 /etc/s6-overlay/scripts/rebrand-restore.sh 开头写的步骤用这份备份还原。"
      ;;
  esac
  exit "$code"
}

finish() {
  [ "$#" -eq 0 ] || usage
  if [ -L "$MARKER" ]; then
    refuse "$MARKER 是符号链接，没有动它；删掉这个链接。"
    exit 1
  fi
  [ -f "$MARKER" ] || return 0
  backup=$(marker_value backup)
  as_pg rm -f "$MARKER"
  say "改名迁移全部完成。升级前的备份保留在 $backup，确认一切正常后可以删除。"
}

case ${1:-} in
  check) shift; check "$@" ;;
  step) shift; step "$@" ;;
  finish) shift; finish "$@" ;;
  *) usage ;;
esac
