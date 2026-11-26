#!/bin/sh
# Put the database back the way it was before the v0.2.16 rename, from the backup rebrand-preflight.sh
# made (pre-rebrand-<time>.dump). Ships in the v0.2.16 image so the failure message can point here.
#
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，goes with the rename migration
#
# 什么时候用：改名迁移失败且提示「业务库已经改动」或「集群已改名」，或者升级后想回到 v0.2.15。
# 提示「业务库没有改动」时不要还原：直接换回 v0.2.15 镜像，继续用原来的卷。
# 适用范围：只用于 v0.2.15 卷上做的备份（还原目标是 v0.2.15 首启过的新卷，超级用户、库、应用角色都是
# 改名前的名字，与备份里的属主和授权对象一致）。不要在 v0.2.16 或更新的容器里执行；更早版本的卷做的
# 备份请先咨询，不要照这里的步骤还原。
#
# 步骤（在宿主机上；旧容器名以 xiongbao 为例，停着也能取文件）：
#   1. 取出备份和本脚本：
#        docker cp xiongbao:/var/lib/postgresql/backup/pre-rebrand-<时间>.dump ./
#        docker cp xiongbao:/etc/s6-overlay/scripts/rebrand-restore.sh ./
#      原来的卷先留着别删（备份也在里面）。
#   2. 用 v0.2.15 镜像和一个「新的」数据库卷启动容器，等它健康：v0.2.15 首次启动会建好角色。
#      不能还原到原来那个卷（它已经部分改名），也不能还原到还没被 v0.2.15 启动过的空卷（缺角色）。
#      新卷所在的盘要能再放下一份库：还原先灌进一个临时库，成功后才替换原来的库。
#   3. 把备份拷进新容器，在新容器里执行本脚本（脚本从标准输入读进去，v0.2.15 镜像里不需要有它）：
#        docker cp pre-rebrand-<时间>.dump <新容器>:/tmp/restore.dump
#        docker exec -i <新容器> sh -s /tmp/restore.dump < rebrand-restore.sh
#   4. docker restart <新容器>（脚本停掉了 api，重启后才会再起来），登录核对数据。
#
# 脚本做的事，按顺序：
#   1) 用 pg_restore 把备份完整读一遍（读到每个数据块）；读不通就退出，数据库一点不动。
#   2) 停掉 api 服务（s6-svc），再确认库上没有任何其它连接；有就退出，数据库一点不动。
#   3) 新建一个空的临时库 <库名>_restoring（属主是库的 owner），用
#        pg_restore --single-transaction --exit-on-error
#      把备份灌进去：一个事务，任何一条出错就整体回滚，原来的库完全没碰过。
#      为什么灌进空库，而不是用 --clean 覆盖原库：v0.2.15 首启跑过迁移，迁移 0054 在库里设了默认权限
#      （新建的表自动授给应用角色读写）。--clean 会删表再按备份重建，重建时默认权限先把读写授出去，备份里
#      的 GRANT 只补不收，结果 user_roles 等表上应用角色多出写权限。空库里没有默认权限，表建好后只按备份
#      逐条授权，默认权限本身也随备份最后恢复：属主、授权、默认权限、行级策略都与备份时一致。
#   4) 再确认一次没有其它连接，删掉原来的库，把临时库改名成原来的名字。
#
# 中途失败时库在什么状态、怎么办：
#   - 1)、2) 失败：什么都没动。排除原因后重跑。
#   - 3) 失败：原来的库没动；临时库已删掉（删不掉时下次重跑会先删）。
#   - 4) 删原库失败（又有连接连上来了）：原来的库没动，临时库里是完整还原的数据。断开连接后重跑，会删掉
#     这个临时库、从 3) 重新灌一遍。
#   - 4) 删掉原库之后、改名之前中断：原来的库已经没了，完整还原的数据在临时库里。用同样的参数重跑本脚本，
#     它认出这个状态，直接把临时库改名成原来的名字，不再灌一遍；也可以手工执行
#       ALTER DATABASE "<库名>_restoring" RENAME TO "<库名>";
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
export PGPASSWORD="$pw"

# One statement on the `postgres` database; the names reach SQL as psql variables.
admin() {
  printf '%s\n' "$1" | "$PG_BIN/psql" -X -q -A -t -w -v ON_ERROR_STOP=1 \
    -v db="$db" -v tmpdb="$tmpdb" -v owner="$user" -h "$host" -p "$port" -U "$user" -d postgres
}
exists() { [ "$(admin "SELECT count(*) FROM pg_database WHERE datname = :'$1';")" = 1 ]; }
others() { admin "SELECT count(*) FROM pg_stat_activity WHERE datname IN (:'db', :'tmpdb') AND pid <> pg_backend_pid();"; }

if ! "$PG_BIN/pg_restore" -f /dev/null "$dump" 2>/dev/null; then
  echo "$dump 不是完整可读的备份（pg_restore 读不通），没有动数据库。" >&2
  exit 1
fi

# The swap was cut off after the old database was dropped. The copy is complete (the swap only starts
# once the restore committed), so finish the swap rather than restore again.
if ! exists db && exists tmpdb; then
  admin 'ALTER DATABASE :"tmpdb" RENAME TO :"db";'
  echo "上一次还原在替换库时中断：已把完整还原的临时库改名回 $db，没有再灌一遍。执行 docker restart <容器> 让服务重新启动，再登录核对数据。"
  exit 0
fi
if ! exists db; then
  echo "库 $db 不存在：本脚本要在 v0.2.15 首启过的容器里执行，没有动数据库。" >&2
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

admin 'DROP DATABASE IF EXISTS :"tmpdb";'
admin 'CREATE DATABASE :"tmpdb" OWNER :"owner";'
echo "正在把 $dump 还原到临时库 $tmpdb ……"
if ! "$PG_BIN/pg_restore" --single-transaction --exit-on-error -w \
  -h "$host" -p "$port" -U "$user" -d "$tmpdb" "$dump"; then
  admin 'DROP DATABASE IF EXISTS :"tmpdb";' || true
  echo "还原失败，已整体回滚，原来的库没有动过；报错见上方。执行 docker restart <容器> 恢复服务。" >&2
  exit 1
fi

n=$(others)
if [ "$n" != 0 ] || ! admin 'DROP DATABASE :"db";'; then
  echo "还原已灌进临时库 $tmpdb，但替换时库 $db 上有其它连接，原来的库没有动过。断开连接后重跑本脚本（会重新灌一遍）。" >&2
  exit 1
fi
if ! admin 'ALTER DATABASE :"tmpdb" RENAME TO :"db";'; then
  echo "原来的库已删除，完整还原的数据在临时库 $tmpdb 里，但改名失败。重跑本脚本会接着改名，或手工执行 ALTER DATABASE \"$tmpdb\" RENAME TO \"$db\";。" >&2
  exit 1
fi
echo "还原完成。执行 docker restart <容器> 让服务重新启动，再登录核对数据。"
