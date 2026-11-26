#!/bin/sh
# 升级到 v0.2.16 之前的只读自查：在还跑着 v0.2.15 的服务器上执行，告诉你现在能不能升级。
#
# 用法：sh pre-upgrade-check.sh [容器名]      （容器名默认 xiongbao）
#
# 查的就是 v0.2.16 启动时 rebrand-preflight.sh 会拦的几项，口径相同：
#   - 需要改名：库里还有旧名角色（超级用户或应用角色）；
#   - 在途工作：待审批、未完成的续跑、未完成的续跑步骤（与 prod-inspect.sh 的查询逐字相同）；
#   - 备份空间：数据库卷可用空间 ≥ 库大小 × 2（v0.2.16 迁移前自动备份到这块卷上）。
#
# 只读：每个数据库会话以 `SET default_transaction_read_only = on` 开头，只问 count(*) 与库大小。
# 不打印任何值：连接串由容器内的 sh 读出，口令只进 psql 的环境变量 PGPASSWORD；数据库报错一律丢弃。
#
# 退出码：0 可以升级；1 暂不能升级（原因与处理办法已打印）；2 无法确认（容器、数据库或查询有问题）。
set -eu

if [ "$#" -gt 1 ]; then
  echo "用法：sh pre-upgrade-check.sh [容器名]" >&2
  exit 1
fi
CONTAINER=${1:-xiongbao}
case $CONTAINER in
  '' | *[!A-Za-z0-9_.-]*)
    echo "容器名只能含字母、数字、下划线、点、横线。" >&2
    exit 1
    ;;
esac

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "找不到容器 $CONTAINER。请先运行 docker ps 看真实的容器名，再把它作为参数。" >&2
  exit 2
fi
if ! docker exec "$CONTAINER" test -s /run/s6/container_environment/MIGRATION_DATABASE_URL >/dev/null 2>&1; then
  echo "容器 $CONTAINER 里没有内置数据库的连接信息：本自查只适用于用内置数据库（EMBEDDED_POSTGRES=on）的交付容器，且容器要在运行。" >&2
  exit 2
fi

# 容器内执行：读连接串、拆开、口令经环境变量交给 psql；SQL 来自标准输入。与 prod-inspect.sh 相同。
# URL 文件与 psql 路径可由容器内的环境变量覆盖（只给测试用，现网容器里没有这两个变量）。
PSQL_SH='
set -eu
PSQL=${PRE_UPGRADE_PSQL:-/usr/lib/postgresql/16/bin/psql}
[ -x "$PSQL" ] || PSQL=psql
u=$(cat "${PRE_UPGRADE_URL_FILE:-/run/s6/container_environment/MIGRATION_DATABASE_URL}")
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
PGPASSWORD=$pw "$PSQL" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$user" -d "$db"
'

# 一条只读 SQL 的单个数字结果；出错或不是数字时输出 ?（无法确认）。
number() {
  out=$(printf 'SET default_transaction_read_only = on;\n%s\n' "$1" |
    docker exec -i "$CONTAINER" sh -c "$PSQL_SH" 2>/dev/null | tail -n 1) || out=''
  case $out in
    '' | *[!0-9]*) echo '?' ;;
    *) echo "$out" ;;
  esac
}
mb() { # 字节 -> MB，向上取整
  case $1 in '?') echo '?' ;; *) echo $((($1 + 1048575) / 1048576)) ;; esac
}

# 「需要改名」按 Task 18 的接口：库里存在角色 openbot 或 openbot_app。
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，读旧角色名判断要不要改名，随改名迁移一起删
roles=$(number "SELECT count(*) FROM pg_roles WHERE rolname IN ('openbot', 'openbot_app');")
# 在途数：表不存在（早于 v0.2.12 的卷没有续跑表）按 0 计，与 v0.2.16 的前置检查一致。
# 计数语句与 prod-inspect.sh、docker/s6/scripts/rebrand-preflight.sh 逐字相同（pre-upgrade-check.test.ts 守着）。
in_flight() { # 表名 计数语句；表不存在时输出 none
  t=$(number "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = '$1';")
  case $t in
    0) echo none ;;
    '?') echo '?' ;;
    *) number "$2" ;;
  esac
}
pending=$(in_flight approval_requests "SELECT count(*) FROM approval_requests WHERE status = 'pending';")
continuations=$(in_flight approval_continuations "SELECT count(*) FROM approval_continuations WHERE state <> 'completed';")
steps=$(in_flight approval_continuation_steps "SELECT count(*) FROM approval_continuation_steps WHERE state <> 'completed';")
MISSING=''
[ "$pending" != none ] || { MISSING="$MISSING approval_requests"; pending=0; }
[ "$continuations" != none ] || { MISSING="$MISSING approval_continuations"; continuations=0; }
[ "$steps" != none ] || { MISSING="$MISSING approval_continuation_steps"; steps=0; }
size=$(number "SELECT pg_database_size(current_database());")
# v0.2.16 上次升级没完成时留在卷上的进行中记录：留着它再升级会沿用旧备份，不重新备份。
MARKER=/var/lib/postgresql/backup/rebrand-in-progress
leftover=0
if docker exec "$CONTAINER" test -e "$MARKER" >/dev/null 2>&1; then leftover=1; fi
avail_kb=$(docker exec "$CONTAINER" df -kP /var/lib/postgresql 2>/dev/null | awk 'NR == 2 { print $4 }') || avail_kb=''
case $avail_kb in '' | *[!0-9]*) avail_kb='?' ;; esac
UNKNOWN=0
for v in "$roles" "$pending" "$continuations" "$steps" "$size" "$avail_kb"; do
  [ "$v" != '?' ] || UNKNOWN=1
done

echo "熊宝 v0.2.16 升级前自查（只读，不改任何数据）"
echo "容器：$CONTAINER"
case $roles in
  '?') echo "需要改名：无法确认" ;;
  0) echo "需要改名：否（库里已经没有旧名角色）" ;;
  *) echo "需要改名：是（库里还有 $roles 个旧名角色，v0.2.16 首次启动时自动改名，改名前自动备份）" ;;
esac
echo "待审批：$pending"
echo "未完成的续跑：$continuations"
echo "未完成的续跑步骤：$steps"
[ -z "$MISSING" ] || echo "（这个库还没有这些表，按 0 计：$MISSING）"
echo "未过期的运行断言：不入库，无法计数（10 分钟内有效的签名令牌；升级前确认没有正在执行的对话或任务即可）"
echo "数据库大小：$(mb "$size") MB"
if [ "$size" = '?' ]; then
  need_kb='?'
  echo "备份需要可用空间：无法确认"
else
  need_kb=$(((size * 2 + 1023) / 1024))
  echo "备份需要可用空间：至少 $(((need_kb + 1023) / 1024)) MB（库大小 × 2）"
fi
case $avail_kb in
  '?') echo "数据库卷可用空间：无法确认" ;;
  *) echo "数据库卷可用空间：$((avail_kb / 1024)) MB" ;;
esac

blocked=0
echo
if [ "$roles" != 0 ]; then
  for n in "$pending" "$continuations" "$steps"; do
    case $n in '?') ;; *) [ "$n" -eq 0 ] || blocked=1 ;; esac
  done
  if [ "$blocked" -eq 1 ]; then
    echo "· 还有在途工作：在网页里把待审批全部批准或拒绝，等已批准的任务续跑完，再运行本自查。"
  fi
  if [ "$need_kb" != '?' ] && [ "$avail_kb" != '?' ] && [ "$avail_kb" -lt "$need_kb" ]; then
    blocked=1
    echo "· 数据库卷空间不够：还差 $(((need_kb - avail_kb + 1023) / 1024)) MB。在宿主机上清理这块盘（例如 docker system prune 清掉不用的镜像），再运行本自查。"
  fi
fi

if [ "$leftover" -eq 1 ]; then
  blocked=1
  echo "· 卷上有上次 v0.2.16 升级没完成留下的记录 $MARKER：在 v0.2.15 上用过之后它对应的备份已经过时。"
  echo "  删掉它再升级（v0.2.16 会重新备份）：docker exec $CONTAINER rm -f $MARKER"
fi

if [ "$blocked" -eq 1 ]; then
  echo "结论：暂不能升级（处理完上面几项再升级；v0.2.16 遇到同样情况会拒绝启动，数据不会动）"
  exit 1
fi
if [ "$UNKNOWN" -eq 1 ]; then
  echo "结论：无法确认（有几项没查到，标成了 ?；确认容器在运行、数据库正常后重试）"
  exit 2
fi
echo "结论：可以升级"
exit 0
