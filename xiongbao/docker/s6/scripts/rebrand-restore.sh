#!/bin/sh
# Put the database back the way it was before the v0.2.16 rename, from the backup rebrand-preflight.sh
# made (pre-rebrand-<time>.dump). Ships in the v0.2.16 image so the failure message can point here.
#
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，goes with the rename migration
#
# 什么时候用：改名迁移失败且提示「业务库已经改动」或「集群已改名」，或者升级后想回到 v0.2.15。
# 提示「业务库没有改动」时不要还原：直接换回 v0.2.15 镜像，继续用原来的卷。
# 还原回到备份那一刻：备份之后写进去的数据（新对话、新审批、改过的设置）都会丢掉。
# 适用范围：只用于 v0.2.15 卷上做的备份（还原目标是 v0.2.15 首启过的新卷，超级用户、库、应用角色都是
# 改名前的名字，与备份里的属主和授权对象一致）。不要在 v0.2.16 或更新的镜像里执行（脚本会拒绝）；更早
# 版本的卷做的备份请先咨询，不要照这里的步骤还原。
#
# 为什么不在正在运行的 v0.2.15 容器里执行：v0.2.15 的 api 服务一停（s6-svc -d），它的 finish 脚本就让
# 整个容器停机，库也跟着停，还原做不完。所以先停掉完整容器，用 v0.2.15 镜像起一个只跑本脚本的一次性
# 容器，挂同一个数据库卷：脚本自己按镜像的 postgres-init 写好连接信息、只启动 PostgreSQL，还原完把它停掉；
# 之后再正常启动完整容器。在运行中的完整容器里执行会被拒绝（什么都不动）。
#
# 步骤（在宿主机上；完整的可复制命令见部署手册 docs/deployment-xiongbao.md 6.4 节「回滚」）：
#   1. 停掉 v0.2.16 容器（docker stop，留着别删，备份在它的数据库卷里），取出整个备份目录和本脚本：
#        docker cp <v0.2.16 容器>:/var/lib/postgresql/backup ./backup
#        docker cp <v0.2.16 容器>:/etc/s6-overlay/scripts/rebrand-restore.sh ./
#      备份目录里每份备份旁边的 <备份>.size 是备份时的库大小，脚本用它估算空间。原来的卷先留着别删。
#   2. 用 v0.2.15 镜像和一个「新的」数据库卷正常启动容器，等它健康：v0.2.15 首次启动会建好库和角色。
#      不能还原到原来那个卷（它已经部分改名），也不能还原到还没被 v0.2.15 启动过的空卷（缺角色），
#      也不能还原到已经在用、有对话的 v0.2.15 卷（会被备份内容整个替换）：这几种脚本都会拒绝。
#   3. 停掉这个容器，用 v0.2.15 镜像起一次性容器挂上同一个新卷和备份目录，从标准输入执行本脚本。一次性容器
#      起固定的名字：重跑时上一个还没结束，docker 会因为重名直接拒绝，不会有两个库同时写一个目录：
#        docker stop <新容器>
#        docker run --rm -i --name <新容器>-restoring --user root --entrypoint sh -v <新卷>:/var/lib/postgresql \
#          -v "$PWD/backup:/restore:ro" <v0.2.15 镜像> -s /restore/pre-rebrand-<时间>.dump < rebrand-restore.sh
#   4. docker start <新容器>，登录核对数据。
#   宿主机上如果还有别的进程连着这个库（例如源码目录里 scripts/start.sh 起的 server、worker），先停掉。
#
# 脚本做的事，按顺序：
#   1) 认环境：在 v0.2.16 或更新的镜像里（有 rebrand-preflight.sh）、在运行中的完整容器里（有 s6 的 api
#      服务目录）都拒绝。用 pg_restore 把备份完整读一遍（读到每个数据块），同时量出展开后的大小；读不通
#      就退出。到这里数据库一点没动。
#   2) 一次性容器里（没有连接信息文件）：数据目录要已经由 v0.2.15 建好；用镜像自己的 postgres-init 写出
#      连接信息（超级用户与库的名字、口令都来自卷和镜像，本脚本不写死），以 postgres 身份启动 PostgreSQL，
#      只听 127.0.0.1；脚本退出时（成功或失败）把它停掉。数据目录里有 postmaster.pid 就不启动、拒绝：别的容器
#      的进程跨容器看不见，PostgreSQL 自己的检查会把它当残留，在同一个目录上起第二个库。
#   3) 认目标，下面几种都拒绝、数据库一点不动：集群里已经有新名字的角色（原来的卷或 v0.2.16 的卷）；卷上有
#      pre-rebrand 备份或改名进行中记录（升级过的原卷）；应用角色还不在（没被 v0.2.15 启动完）；库里已经
#      有对话（不是新卷）。
#   4) 空间：数据目录所在盘的可用空间要不少于「备份时的库大小（含索引，读 <备份>.size）与展开后大小两者
#      取大，再 × 2」（临时库与写入日志）；没有 .size 时按展开后的大小 × 3 估。不够就拒绝，数据库一点不动。
#   5) 确认库上没有任何客户端连接（api、宿主机上的进程）；有就退出，数据库一点不动。
#   6) 新建一个空的临时库 <库名>_restoring（属主是库的 owner），用
#        pg_restore --single-transaction --exit-on-error
#      把备份灌进去：一个事务，任何一条出错就整体回滚，原来的库完全没碰过。灌完在临时库上记一个标记
#      （库的注释，写明是哪一份备份：校验和与长度），表示「这份备份已完整还原在这里」。
#      为什么灌进空库，而不是用 --clean 覆盖原库：v0.2.15 首启跑过迁移，迁移 0054 在库里设了默认权限
#      （新建的表自动授给应用角色读写）。--clean 会删表再按备份重建，重建时默认权限先把读写授出去，备份里
#      的 GRANT 只补不收，结果 user_roles 等表上应用角色多出写权限。空库里没有默认权限，表建好后只按备份
#      逐条授权，默认权限本身也随备份最后恢复：属主、授权、默认权限、行级策略都与备份时一样。
#   7) 再确认一次没有客户端连接，在一个事务里把原来的库改名为 <库名>_before_restore、把临时库改名为原来的
#      名字：两个改名一起生效或都不生效，任何时刻都有一个叫原名的库。
#   8) 删掉 <库名>_before_restore。
#
# 中途失败或中断时库在什么状态、怎么办（都是用同样的命令重跑本脚本）：
#   - 1)–5) 失败：什么都没动。排除原因后重跑。
#   - 6) 失败：原来的库没动；临时库已删掉（删不掉时下次重跑会先删）。
#   - 6) 灌完、7) 之前中断，或 7) 因为有连接没能改名：原来的库没动，临时库里是完整还原的数据并带着标记。
#     重跑时认出标记，不再灌一遍，直接做 7)、8)。没有标记的临时库（灌到一半）会被删掉重灌。
#   - 7) 之后、8) 删完之前中断：原名的库已经是还原出来的（带标记），旧库留在 <库名>_before_restore。
#     重跑时认出这个状态，只删掉旧库（只看旧库上有没有连接，原名库上的连接不碍事）。
#   - 已经全部完成后又重跑：认出原名的库就是这份备份还原的，什么都不做。
# 口令只经 PGPASSWORD 交给 psql、pg_restore，不进命令行参数，不打印。
#
# 下面的覆盖变量只给测试用；交付镜像用默认值。
set -eu
umask 077

dump=${1:-}
if [ -z "$dump" ] || [ ! -f "$dump" ]; then
  echo "用法：docker run --rm -i --user root --entrypoint sh -v <新卷>:/var/lib/postgresql -v <备份目录>:/restore:ro <v0.2.15 镜像> -s /restore/<备份文件> < rebrand-restore.sh" >&2
  exit 2
fi
PG_BIN=${REBRAND_RESTORE_PG_BIN:-/usr/lib/postgresql/16/bin}
URL_FILE=${REBRAND_RESTORE_URL_FILE:-/run/s6/container_environment/MIGRATION_DATABASE_URL}
API=${REBRAND_RESTORE_API_SERVICE:-/run/service/api}
# Present only in the v0.2.16 image (and the rename's later releases): the restore target is v0.2.15.
NEWER_IMAGE_FILE=${REBRAND_RESTORE_NEWER_IMAGE_FILE:-/etc/s6-overlay/scripts/rebrand-preflight.sh}
# Where v0.2.16 put its backup and in-progress record on the volume it upgraded.
BACKUP_DIR=${REBRAND_RESTORE_BACKUP_DIR:-/var/lib/postgresql/backup}
# The one-shot container: the volume's cluster, and the image's own step that writes its connection strings.
DATA_DIR=${REBRAND_RESTORE_DATA_DIR:-/var/lib/postgresql/data}
POSTGRES_INIT=${REBRAND_RESTORE_POSTGRES_INIT:-/etc/s6-overlay/scripts/postgres-init.sh}

if [ -e "$NEWER_IMAGE_FILE" ]; then
  echo "这是 v0.2.16 或更新的镜像（有 $NEWER_IMAGE_FILE）：本脚本只在 v0.2.15 镜像起的一次性容器里执行，没有动数据库。" >&2
  exit 2
fi
if [ -e "$API" ]; then
  echo "这是正在运行的完整容器（有 $API）：在这里停 api 会让 v0.2.15 整个容器停机，还原做不完。没有动数据库。" >&2
  echo "先 docker stop 这个容器，再按步骤 3 用 v0.2.15 镜像起一次性容器、挂同一个数据库卷执行本脚本。" >&2
  exit 2
fi

started=''
work=$(mktemp -d)
# As root (the one-shot container), PostgreSQL runs as postgres; the tests run it as themselves.
as_pg() {
  if [ "$(id -u)" != 0 ]; then "$@"
  elif command -v runuser >/dev/null 2>&1; then runuser -u postgres -- "$@"
  else /command/s6-setuidgid postgres "$@"; fi
}
stop_postgres() {
  [ -n "$started" ] || return 0
  as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 ||
    echo "警告：没能停掉这次启动的 PostgreSQL（容器退出时会一起结束）。" >&2
  started=''
}
trap 'stop_postgres; rm -rf "$work"' EXIT

# Read the whole backup (every data block), measuring what it expands to on the way.
bytes=$({ "$PG_BIN/pg_restore" -f - "$dump" 2>/dev/null && : >"$work/read"; } | wc -c | tr -d ' ')
if [ ! -e "$work/read" ]; then
  echo "$dump 不是完整可读的备份（pg_restore 读不通），没有动数据库。" >&2
  exit 1
fi
# The database's size when it was backed up, written beside the backup by rebrand-preflight.sh.
recorded=''
if [ -r "$dump.size" ]; then
  recorded=$(head -n 1 "$dump.size")
  case $recorded in '' | *[!0-9]*) recorded='' ;; esac
fi

# The one-shot container: no connection strings yet. Have the image's own init write them (it knows the
# cluster's names and reads the password from the volume), then start only PostgreSQL.
if [ ! -s "$URL_FILE" ]; then
  if [ ! -s "$DATA_DIR/PG_VERSION" ]; then
    echo "$DATA_DIR 里没有数据库：先用 v0.2.15 镜像和这个新卷正常启动一次、等它健康（步骤 2），再停掉它执行本脚本。没有动任何东西。" >&2
    exit 1
  fi
  if [ ! -f "$POSTGRES_INIT" ]; then
    echo "这个镜像里没有 $POSTGRES_INIT：本脚本要用 v0.2.15 的交付镜像起一次性容器执行。没有动任何东西。" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$URL_FILE")"
  if ! EMBEDDED_POSTGRES=on sh "$POSTGRES_INIT" >"$work/init.log" 2>&1 || [ ! -s "$URL_FILE" ]; then
    cat "$work/init.log" >&2
    echo "没能写出连接信息（镜像的 postgres-init 失败，报错见上方）。没有动数据库。" >&2
    exit 1
  fi
fi
u=$(cat "$URL_FILE")
rest=${u#*://}
user=${rest%%:*}
rest=${rest#*:}
pw=${rest%%@*}
rest=${rest#*@}
hostport=${rest%%/*}
db=${rest#*/}
host=${hostport%%:*}
case $hostport in
  *:*) port=${hostport#*:} ;;
  *) port=5432 ;;
esac
for n in "$user" "$db"; do
  case $n in
    '' | *[!a-z0-9_]*)
      echo "$URL_FILE 里的用户名或库名不是本镜像生成的样子，没有动数据库。" >&2
      exit 2
      ;;
  esac
done
case $port in
  '' | *[!0-9]*)
    echo "$URL_FILE 里的端口不是数字，没有动数据库。" >&2
    exit 2
    ;;
esac
tmpdb=${db}_restoring
old=${db}_before_restore
mark=''
export PGPASSWORD="$pw"

# Nothing answering: the one-shot container's PostgreSQL is not up yet. Start it, loopback only.
if ! "$PG_BIN/pg_isready" -q -h "$host" -p "$port" 2>/dev/null; then
  if [ ! -s "$DATA_DIR/PG_VERSION" ]; then
    echo "连不上 $host:$port 的数据库，$DATA_DIR 里也没有数据库可以启动。没有动任何东西。" >&2
    exit 1
  fi
  # Another container may be running a postmaster on this very data directory (the full container, or an
  # earlier one-shot restore still going after the terminal dropped). Its pid and shared memory live in
  # that container's namespaces, so PostgreSQL's own check would take the lock file for a stale one and
  # start a second postmaster on the same files. Any lock file at all is a refusal here.
  if [ -e "$DATA_DIR/postmaster.pid" ]; then
    echo "$DATA_DIR/postmaster.pid 在：可能还有别的容器正在用这个数据库卷（完整容器，或上一次还没结束的还原容器）。没有动数据库。" >&2
    echo "先用 docker ps 看还有没有挂着这个卷在跑的容器（docker ps --filter volume=<新卷>）：有就等它结束或 docker stop 它，再重跑。" >&2
    echo "确实一个都没有，说明上一次没有正常停库：把完整容器 docker start 一次、等它健康，再 docker stop（这样会正常停库、删掉这个文件），然后重跑。" >&2
    exit 1
  fi
  [ "$(id -u)" != 0 ] || chown postgres:postgres "$work"
  chmod 700 "$work"
  echo "正在启动这个卷上的 PostgreSQL（只听 $host:$port，还原完就停）……"
  if ! as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$work/postgres.log" -w -t 120 \
    -o "-c listen_addresses=$host -c port=$port -c unix_socket_directories=$work" start >/dev/null; then
    cat "$work/postgres.log" >&2 2>/dev/null || true
    echo "PostgreSQL 没能启动（日志见上方）。没有动数据库。" >&2
    exit 1
  fi
  started=1
fi

# One statement (or one transaction) on the `postgres` database; the names reach SQL as psql variables.
admin() {
  printf '%s\n' "$1" | "$PG_BIN/psql" -X -q -A -t -w -v ON_ERROR_STOP=1 \
    -v db="$db" -v tmpdb="$tmpdb" -v old="$old" -v owner="$user" -v mark="$mark" \
    -h "$host" -p "$port" -U "$user" -d postgres
}
# One question to the database the restore would replace.
indb() {
  printf '%s\n' "$1" | "$PG_BIN/psql" -X -q -A -t -w -v ON_ERROR_STOP=1 \
    -h "$host" -p "$port" -U "$user" -d "$db"
}
exists() { [ "$(admin "SELECT count(*) FROM pg_database WHERE datname = :'$1';")" = 1 ]; }
# The comment on a database: where a complete restore of this backup leaves its mark.
mark_of() { admin "SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = :'$1';"; }
# Client sessions on the named databases (psql variables). An autovacuum worker is told to leave by the
# drop and the rename themselves, and must not make the script refuse.
sessions_on() { admin "SELECT count(*) FROM pg_stat_activity WHERE datname IN ($1) AND backend_type = 'client backend' AND pid <> pg_backend_pid();"; }
others() { sessions_on ":'db', :'tmpdb', :'old'"; }
target_refused() {
  echo "$1" >&2
  echo "按步骤 2 用 v0.2.15 镜像和一个新的数据库卷另起一个容器，停掉它后按步骤 3 执行本脚本。" >&2
  exit 1
}

# Which backup a restored database came from: its checksum and length, never its content.
mark="rebrand-restore:$(cksum <"$dump" | awk '{ print $1 "-" $2 }')"

# A restore of this very backup already took the original name: only the database it replaced may be left.
# Sessions on the restored database (the service may be running on it again) do not stop that drop.
if exists db && [ "$(mark_of db)" = "$mark" ]; then
  if exists old; then
    if [ "$(sessions_on ":'old'")" != 0 ] || ! admin 'DROP DATABASE :"old";'; then
      echo "库 $db 已经是这份备份还原出来的；替换下来的原库 $old 还在，有连接连着它，没能删掉。断开后重跑本脚本。" >&2
      exit 1
    fi
    echo "上一次还原已经替换完成：库 $db 是这份备份还原出来的，这次删掉了替换下来的原库 $old。"
  else
    echo "库 $db 已经是这份备份还原出来的，没有再做一遍。"
  fi
  exit 0
fi
if ! exists db; then
  echo "库 $db 不存在：本脚本要在 v0.2.15 首启过的卷上执行，没有动数据库。" >&2
  exit 1
fi
if exists old; then
  echo "有一个 $old 库，但 $db 不是这份备份还原出来的：不知道它是怎么来的，没有动数据库。先查清楚（psql 里 \\l+），确认不要后删掉它再重跑。" >&2
  exit 1
fi

# Is this the right target: a new volume that v0.2.15 has started on, and nothing else.
renamed=$(admin "SELECT count(*) FROM pg_roles WHERE rolname IN ('xiongbao_app', 'xiongbao_role_writer') OR (oid = 10 AND rolname = 'xiongbao');")
[ "$renamed" = 0 ] ||
  target_refused "这个集群里已经有新名字的角色：它是 v0.2.16 改过名（或改到一半）的卷，不是 v0.2.15 新卷，没有动数据库。"
for f in "$BACKUP_DIR"/pre-rebrand-*.dump "$BACKUP_DIR"/rebrand-in-progress; do
  [ ! -e "$f" ] ||
    target_refused "这个卷上有 v0.2.16 升级留下的 $f：它是升级过的原卷，不是新卷，没有动数据库。"
done
roles=$(admin "SELECT count(*) FROM pg_roles WHERE rolname IN (:'owner' || '_app', :'owner' || '_role_writer');")
if [ "$roles" != 2 ]; then
  echo "集群里还没有应用角色：这个卷还没被 v0.2.15 完整启动过（迁移没跑完），没有动数据库。先正常启动一次、等它健康。" >&2
  exit 1
fi
threads=0
if [ "$(indb "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'threads';")" != 0 ]; then
  threads=$(indb "SELECT count(*) FROM public.threads;")
fi
[ "$threads" = 0 ] ||
  target_refused "库 $db 里已经有 $threads 个对话：它不是新卷，还原会把它整个替换掉，没有动数据库。"

# Room for the copy beside the database it replaces: the database as it was (indexes included) when the
# size was recorded, else what the dump expands to with room for indexes.
data_dir=$(admin 'SHOW data_directory;')
avail_kb=$(df -kP "$data_dir" 2>/dev/null | awk 'NR == 2 { print $4 }')
case $avail_kb in
  '' | *[!0-9]*)
    echo "读不到 $data_dir 所在盘的可用空间，没有动数据库。" >&2
    exit 1
    ;;
esac
mb() { echo $((($1 + 1048575) / 1048576)); }
if [ -n "$recorded" ]; then
  base=$recorded
  [ "$bytes" -le "$base" ] || base=$bytes
  need=$((base * 2))
  how="备份时的库大小 $(mb "$recorded") MB（含索引）与展开后的 $(mb "$bytes") MB 取大，× 2"
else
  need=$((bytes * 3))
  how="没有记下备份时的库大小（$dump.size），按展开后的 $(mb "$bytes") MB × 3 估"
fi
need_kb=$(((need + 1023) / 1024))
if [ "$avail_kb" -lt "$need_kb" ]; then
  echo "空间不够，没有动数据库：" >&2
  echo "  还原要在 $data_dir 所在盘至少有 $(((need_kb + 1023) / 1024)) MB 可用（$how）" >&2
  echo "  现在可用：$((avail_kb / 1024)) MB，还差 $(((need_kb - avail_kb + 1023) / 1024)) MB" >&2
  echo "处理办法：在宿主机上清理这块盘（例如 docker system prune 清掉不用的镜像），然后重跑本脚本。" >&2
  exit 1
fi

n=$(others)
if [ "$n" != 0 ]; then
  echo "库 $db 上还有 $n 个客户端连接，没有动数据库。还原要在库上没有任何连接时做：完整容器要先 docker stop，" >&2
  echo "宿主机上连着这个库的进程（例如 scripts/start.sh 起的 server、worker）也先停掉，然后重跑。" >&2
  exit 1
fi

if exists tmpdb && [ "$(mark_of tmpdb)" = "$mark" ]; then
  echo "临时库 $tmpdb 里已经是这份备份完整还原的数据（上一次在替换之前停下了），不再灌一遍，直接替换。"
else
  admin 'DROP DATABASE IF EXISTS :"tmpdb";'
  admin 'CREATE DATABASE :"tmpdb" OWNER :"owner";'
  echo "正在把 $dump 还原到临时库 $tmpdb ……"
  if ! "$PG_BIN/pg_restore" --single-transaction --exit-on-error -w \
    -h "$host" -p "$port" -U "$user" -d "$tmpdb" "$dump"; then
    admin 'DROP DATABASE IF EXISTS :"tmpdb";' || true
    echo "还原失败，已整体回滚，原来的库没有动过；报错见上方。" >&2
    exit 1
  fi
  admin "COMMENT ON DATABASE :\"tmpdb\" IS :'mark';"
fi

# Both renames in one transaction: there is always a database under the original name.
n=$(others)
if [ "$n" != 0 ] || ! admin 'BEGIN; ALTER DATABASE :"db" RENAME TO :"old"; ALTER DATABASE :"tmpdb" RENAME TO :"db"; COMMIT;'; then
  echo "还原已完整灌进临时库 $tmpdb，但替换时库 $db 上有连接，原来的库没有动过。断开连接后重跑本脚本（不会再灌一遍）。" >&2
  exit 1
fi
if ! admin 'DROP DATABASE :"old";'; then
  echo "还原完成，库 $db 已是备份里的数据；替换下来的原库 $old 没能删掉。重跑本脚本会删掉它（不会再还原一遍）。" >&2
  exit 0
fi
echo "还原完成。"
