#!/bin/sh
# Put the database back the way it was before the v0.2.16 rename, from the backup rebrand-preflight.sh
# made (pre-rebrand-<time>.dump). Ships in the v0.2.16 image so the failure message can point here.
#
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，goes with the rename migration
#
# 什么时候用：改名迁移失败且提示「业务库已经改动」，或者升级后想回到 v0.2.15。
# 提示「业务库没有改动」时不要还原：直接换回 v0.2.15 镜像，继续用原来的卷。
#
# 步骤（在宿主机上；旧容器名以 xiongbao 为例，停着也能取文件）：
#   1. 取出备份和本脚本：
#        docker cp xiongbao:/var/lib/postgresql/backup/pre-rebrand-<时间>.dump ./
#        docker cp xiongbao:/etc/s6-overlay/scripts/rebrand-restore.sh ./
#      原来的卷先留着别删（备份也在里面）。
#   2. 用 v0.2.15 镜像和一个「新的」数据库卷启动容器，等它健康：v0.2.15 首次启动会建好表、角色和默认数据。
#      不能还原到原来那个卷（它已经部分改名），也不能还原到还没被 v0.2.15 启动过的空卷（缺角色）。
#   3. 把备份拷进新容器，在新容器里执行本脚本（脚本从标准输入读进去，v0.2.15 镜像里不需要有它）：
#        docker cp pre-rebrand-<时间>.dump <新容器>:/tmp/restore.dump
#        docker exec -i <新容器> sh -s /tmp/restore.dump < rebrand-restore.sh
#   4. docker restart <新容器>，登录核对数据。
#
# 脚本做的事：确认文件是完整的备份；停掉 api 服务（s6-svc，停不掉只告警）；以库的 owner 身份执行
#   pg_restore --clean --if-exists --single-transaction --exit-on-error
# 先删掉 v0.2.15 首启建的同名对象、再按备份重建并灌入数据，整个过程一个事务：任何一条出错就整体回滚，
# 新卷保持 v0.2.15 首启的样子。（不加 --clean 时，带默认数据的表会因主键冲突整表灌不进去，数据会丢。）
# 口令只经 PGPASSWORD 交给 pg_restore，不进命令行参数，不打印。
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

if ! "$PG_BIN/pg_restore" -f /dev/null "$dump" 2>/dev/null; then
  echo "$dump 不是完整可读的备份（pg_restore 读不通），没有动数据库。" >&2
  exit 1
fi

if [ -d "$API" ]; then
  svc=s6-svc
  command -v s6-svc >/dev/null 2>&1 || svc=/command/s6-svc
  if "$svc" -wD -T 60000 -d "$API" 2>/dev/null; then
    echo "已停掉 api 服务。"
  else
    echo "警告：没能停掉 api 服务，照样还原（还原期间网页可能报错）。" >&2
  fi
fi

echo "正在还原 $dump ……"
if PGPASSWORD=$pw "$PG_BIN/pg_restore" --clean --if-exists --single-transaction --exit-on-error -w \
  -h "$host" -p "$port" -U "$user" -d "$db" "$dump"; then
  echo "还原完成。执行 docker restart <容器> 让服务重新启动，再登录核对数据。"
else
  echo "还原失败，已整体回滚，数据库保持还原前的样子；报错见上方。执行 docker restart <容器> 恢复服务。" >&2
  exit 1
fi
