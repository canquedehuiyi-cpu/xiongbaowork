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
# 改名前的名字，与备份里的属主和授权对象一致）。不要在 v0.2.16 或更新的容器里执行（脚本会拒绝）；更早
# 版本的卷做的备份请先咨询，不要照这里的步骤还原。
#
# 步骤（在宿主机上；完整的可复制命令见部署手册 docs/deployment-xiongbao.md 6.4 节「回滚」）：
#   1. 停掉 v0.2.16 容器（docker stop，留着别删，备份在它的数据库卷里），取出备份和本脚本：
#        docker cp <v0.2.16 容器>:/var/lib/postgresql/backup/pre-rebrand-<时间>.dump ./
#        docker cp <v0.2.16 容器>:/etc/s6-overlay/scripts/rebrand-restore.sh ./
#      原来的卷先留着别删（备份也在里面）。
#   2. 用 v0.2.15 镜像和一个「新的」数据库卷启动容器，等它健康：v0.2.15 首次启动会建好角色。
#      不能还原到原来那个卷（它已经部分改名），也不能还原到还没被 v0.2.15 启动过的空卷（缺角色），
#      也不能还原到已经在用、有对话的 v0.2.15 卷（会被备份内容整个替换）：这三种脚本都会拒绝。
#      新卷所在的盘要能再放下一份库：还原先灌进一个临时库，成功后才替换原来的库（脚本先检查空间）。
#      宿主机上如果还有别的进程连着这个库（例如源码目录里 scripts/start.sh 起的 server、worker），先停掉。
#   3. 把备份拷进新容器，在新容器里执行本脚本（脚本从标准输入读进去，v0.2.15 镜像里不需要有它）：
#        docker cp pre-rebrand-<时间>.dump <新容器>:/tmp/restore.dump
#        docker exec -i <新容器> sh -s /tmp/restore.dump < rebrand-restore.sh
#   4. docker restart <新容器>（脚本停掉了 api，重启后才会再起来），登录核对数据。
#
# 脚本做的事，按顺序：
#   1) 用 pg_restore 把备份完整读一遍（读到每个数据块），同时量出展开后的大小；读不通就退出，数据库一点不动。
#   2) 认目标，下面几种都拒绝、数据库一点不动：在 v0.2.16 或更新的镜像里（有 rebrand-preflight.sh）；集群里
#      已经有新名字的角色（原来的卷或 v0.2.16 的卷）；卷上有 pre-rebrand 备份或改名进行中记录（升级过的
#      原卷）；应用角色还不在（没被 v0.2.15 启动完）；库里已经有对话（不是新卷）。
#   3) 空间：数据目录所在盘的可用空间要不少于「备份展开后的大小 × 2」（临时库的表、索引和写入日志），
#      不够就拒绝，数据库一点不动。
#   4) 停掉 api 服务（s6-svc），再确认库上没有任何其它连接；有就退出，数据库一点不动。
#   5) 新建一个空的临时库 <库名>_restoring（属主是库的 owner），用
#        pg_restore --single-transaction --exit-on-error
#      把备份灌进去：一个事务，任何一条出错就整体回滚，原来的库完全没碰过。灌完在临时库上记一个标记
#      （库的注释，写明是哪一份备份：校验和与长度），表示「这份备份已完整还原在这里」。
#      为什么灌进空库，而不是用 --clean 覆盖原库：v0.2.15 首启跑过迁移，迁移 0054 在库里设了默认权限
#      （新建的表自动授给应用角色读写）。--clean 会删表再按备份重建，重建时默认权限先把读写授出去，备份里
#      的 GRANT 只补不收，结果 user_roles 等表上应用角色多出写权限。空库里没有默认权限，表建好后只按备份
#      逐条授权，默认权限本身也随备份最后恢复：属主、授权、默认权限、行级策略都与备份时一样。
#   6) 再确认一次没有其它连接，在一个事务里把原来的库改名为 <库名>_before_restore、把临时库改名为原来的
#      名字：两个改名一起生效或都不生效，任何时刻都有一个叫原名的库。
#   7) 删掉 <库名>_before_restore。
#
# 中途失败或中断时库在什么状态、怎么办（都是用同样的参数重跑本脚本）：
#   - 1)–4) 失败：什么都没动。排除原因后重跑。
#   - 5) 失败：原来的库没动；临时库已删掉（删不掉时下次重跑会先删）。
#   - 5) 灌完、6) 之前中断，或 6) 因为有连接没能改名：原来的库没动，临时库里是完整还原的数据并带着标记。
#     重跑时认出标记，不再灌一遍，直接做 6)、7)。没有标记的临时库（灌到一半）会被删掉重灌。
#   - 6) 之后、7) 删完之前中断：原名的库已经是还原出来的（带标记），旧库留在 <库名>_before_restore。
#     重跑时认出这个状态，只删掉旧库。
#   - 已经全部完成后又重跑：认出原名的库就是这份备份还原的，什么都不做。
# 口令只经 PGPASSWORD 交给 psql、pg_restore，不进命令行参数，不打印。
#
# 连接信息读容器里 postgres-init 每次启动写的 MIGRATION_DATABASE_URL；下面的覆盖变量只给测试用。
set -eu
umask 077

dump=${1:-}
if [ -z "$dump" ] || [ ! -f "$dump" ]; then
  echo "用法：docker exec -i <容器> sh -s <容器内的备份路径> < rebrand-restore.sh" >&2
  exit 2
fi
PG_BIN=${REBRAND_RESTORE_PG_BIN:-/usr/lib/postgresql/16/bin}
URL_FILE=${REBRAND_RESTORE_URL_FILE:-/run/s6/container_environment/MIGRATION_DATABASE_URL}
API=${REBRAND_RESTORE_API_SERVICE:-/run/service/api}
# Present only in the v0.2.16 image (and the rename's later releases): the restore target is v0.2.15.
NEWER_IMAGE_FILE=${REBRAND_RESTORE_NEWER_IMAGE_FILE:-/etc/s6-overlay/scripts/rebrand-preflight.sh}
# Where v0.2.16 put its backup and in-progress record on the volume it upgraded.
BACKUP_DIR=${REBRAND_RESTORE_BACKUP_DIR:-/var/lib/postgresql/backup}

if [ -e "$NEWER_IMAGE_FILE" ]; then
  echo "这是 v0.2.16 或更新的镜像（有 $NEWER_IMAGE_FILE）：本脚本只在用 v0.2.15 镜像和新数据库卷启动的容器里执行，没有动数据库。" >&2
  exit 2
fi
if [ ! -s "$URL_FILE" ]; then
  echo "读不到 $URL_FILE：本脚本要在用内置数据库、正在运行的 v0.2.15 交付容器里执行。" >&2
  exit 2
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
tmpdb=${db}_restoring
old=${db}_before_restore
mark=''
export PGPASSWORD="$pw"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

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
others() { admin "SELECT count(*) FROM pg_stat_activity WHERE datname IN (:'db', :'tmpdb', :'old') AND pid <> pg_backend_pid();"; }
target_refused() {
  echo "$1" >&2
  echo "按步骤 2 用 v0.2.15 镜像和一个新的数据库卷另起一个容器，在那个容器里执行本脚本。" >&2
  exit 1
}

# Read the whole backup (every data block), measuring what it expands to on the way.
bytes=$({ "$PG_BIN/pg_restore" -f - "$dump" 2>/dev/null && : >"$work/read"; } | wc -c | tr -d ' ')
if [ ! -e "$work/read" ]; then
  echo "$dump 不是完整可读的备份（pg_restore 读不通），没有动数据库。" >&2
  exit 1
fi
# Which backup a restored database came from: its checksum and length, never its content.
mark="rebrand-restore:$(cksum <"$dump" | awk '{ print $1 "-" $2 }')"

# A restore of this very backup already took the original name: only the database it replaced may be left.
if exists db && [ "$(mark_of db)" = "$mark" ]; then
  if exists old; then
    if [ "$(others)" != 0 ] || ! admin 'DROP DATABASE :"old";'; then
      echo "库 $db 已经是这份备份还原出来的；替换下来的原库 $old 还在，有连接连着它，没能删掉。断开后重跑本脚本。" >&2
      exit 1
    fi
    echo "上一次还原已经替换完成：库 $db 是这份备份还原出来的，这次删掉了替换下来的原库 $old。执行 docker restart <容器> 让服务重新启动，再登录核对数据。"
  else
    echo "库 $db 已经是这份备份还原出来的，没有再做一遍。执行 docker restart <容器> 让服务重新启动，再登录核对数据。"
  fi
  exit 0
fi
if ! exists db; then
  echo "库 $db 不存在：本脚本要在 v0.2.15 首启过的容器里执行，没有动数据库。" >&2
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
  echo "集群里还没有应用角色：这个容器还没被 v0.2.15 完整启动过（迁移没跑完），没有动数据库。等它健康后再执行。" >&2
  exit 1
fi
threads=0
if [ "$(indb "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'threads';")" != 0 ]; then
  threads=$(indb "SELECT count(*) FROM public.threads;")
fi
[ "$threads" = 0 ] ||
  target_refused "库 $db 里已经有 $threads 个对话：它不是新卷，还原会把它整个替换掉，没有动数据库。"

# Room for the copy beside the database it replaces.
data_dir=$(admin 'SHOW data_directory;')
avail_kb=$(df -kP "$data_dir" 2>/dev/null | awk 'NR == 2 { print $4 }')
case $avail_kb in
  '' | *[!0-9]*)
    echo "读不到 $data_dir 所在盘的可用空间，没有动数据库。" >&2
    exit 1
    ;;
esac
need_kb=$(((bytes * 2 + 1023) / 1024))
if [ "$avail_kb" -lt "$need_kb" ]; then
  echo "空间不够，没有动数据库：" >&2
  echo "  备份展开后约 $(((bytes + 1048575) / 1048576)) MB；还原要在 $data_dir 所在盘至少有 $(((need_kb + 1023) / 1024)) MB 可用（展开后的大小 × 2）" >&2
  echo "  现在可用：$((avail_kb / 1024)) MB，还差 $(((need_kb - avail_kb + 1023) / 1024)) MB" >&2
  echo "处理办法：在宿主机上清理这块盘（例如 docker system prune 清掉不用的镜像），然后重跑本脚本。" >&2
  exit 1
fi

if [ -d "$API" ]; then
  svc=s6-svc
  command -v s6-svc >/dev/null 2>&1 || svc=/command/s6-svc
  if "$svc" -wD -T 60000 -d "$API" 2>/dev/null; then
    echo "已停掉 api 服务。"
  else
    echo "警告：没能停掉 api 服务；下面检查库上的连接，有连接就不还原。" >&2
  fi
fi
n=$(others)
if [ "$n" != 0 ]; then
  echo "库 $db 上还有 $n 个其它连接，没有动数据库。断开它们（例如停掉 api：s6-svc -d /run/service/api）后重跑。" >&2
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
    echo "还原失败，已整体回滚，原来的库没有动过；报错见上方。执行 docker restart <容器> 恢复服务。" >&2
    exit 1
  fi
  admin "COMMENT ON DATABASE :\"tmpdb\" IS :'mark';"
fi

# Both renames in one transaction: there is always a database under the original name.
n=$(others)
if [ "$n" != 0 ] || ! admin 'BEGIN; ALTER DATABASE :"db" RENAME TO :"old"; ALTER DATABASE :"tmpdb" RENAME TO :"db"; COMMIT;'; then
  echo "还原已完整灌进临时库 $tmpdb，但替换时库 $db 上有其它连接，原来的库没有动过。断开连接后重跑本脚本（不会再灌一遍）。" >&2
  exit 1
fi
if ! admin 'DROP DATABASE :"old";'; then
  echo "还原完成，库 $db 已是备份里的数据；替换下来的原库 $old 没能删掉。重跑本脚本会删掉它（不会再还原一遍）。" >&2
  echo "执行 docker restart <容器> 让服务重新启动，再登录核对数据。"
  exit 0
fi
echo "还原完成。执行 docker restart <容器> 让服务重新启动，再登录核对数据。"
