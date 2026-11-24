#!/bin/sh
# 现网只读核对：只输出名字与计数，绝不输出任何值（口令、连接串、环境变量值、行内容）。
#
# 用法：sh prod-inspect.sh <容器名> <.env.delivery 路径>
#
# 安全约束（改动本脚本时不得破坏）：
#   - 数据库只经 `docker exec` 在容器内访问，连接串由容器内的 sh 从 s6 环境文件读出，写进 0600 的
#     PGPASSFILE（退出即删），不进任何命令行参数，`ps` 看不到。
#   - 每个会话以 `SET default_transaction_read_only = on` 开头；语句只有 count(*) 与目录名查询。
#   - 一条查询出错时只打印 `名字=n/a`，不转发数据库的报错（报错里可能带值）。
#   - 计数只放行纯数字；名字清单只放行 [A-Za-z0-9_.:-]。
set -eu

if [ "$#" -ne 2 ]; then
  echo "用法：sh prod-inspect.sh <容器名> <.env.delivery 路径>" >&2
  exit 1
fi
CONTAINER=$1
ENV_FILE=$2

case $CONTAINER in
  '' | *[!A-Za-z0-9_.-]*)
    echo "容器名只能含字母、数字、下划线、点、横线。" >&2
    exit 1
    ;;
esac

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "找不到容器 $CONTAINER。请先运行 docker ps 看真实的容器名，再把它作为第一个参数。" >&2
  exit 2
fi
if [ ! -r "$ENV_FILE" ]; then
  echo "读不到 .env.delivery：$ENV_FILE" >&2
  exit 2
fi

NAME_RE='^(OPENBOT|XIONGBAO|COPILOTKIT|CPK)_[A-Z0-9_]*'

# 容器内执行的会话脚本：读连接串、拆成 pgpass 一行、再交给 psql；SQL 来自标准输入。
# 单引号包住，整段在宿主机侧不展开。
PSQL_SH='
set -eu
PSQL=/usr/lib/postgresql/16/bin/psql
[ -x "$PSQL" ] || PSQL=psql
u=$(cat /run/s6/container_environment/MIGRATION_DATABASE_URL)
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
f=$(mktemp)
trap "rm -f \"$f\"" EXIT
printf "%s:%s:%s:%s:%s\n" "$host" "$port" "$db" "$user" "$pw" > "$f"
PGPASSFILE=$f "$PSQL" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$user" -d "$db"
'

# 跑一条只读 SQL，原样输出结果行；出错则无输出（报错一律丢弃）。
session() {
  printf 'SET default_transaction_read_only = on;\n%s\n' "$1" |
    docker exec -i "$CONTAINER" sh -c "$PSQL_SH" 2>/dev/null || true
}

# 名字=行数；非纯数字（含出错）一律写 n/a。
count() {
  out=$(session "$2" | tail -n 1)
  case $out in
    '' | *[!0-9]*) out=n/a ;;
  esac
  echo "$1=$out"
}

# 名字清单：只放行名字字符。
names() {
  session "$1" | grep -E '^[A-Za-z0-9_.:-]+$' || true
}

echo "# env-file"
grep -E "${NAME_RE}=" "$ENV_FILE" | sed 's/=.*//' | sort -u || true

echo
echo "# container-env"
docker exec "$CONTAINER" ls /run/s6/container_environment 2>/dev/null |
  grep -E "${NAME_RE}\$" | sort -u || true

echo
echo "# database"
echo "# roles whose name contains the old brand"
names "SELECT rolname FROM pg_roles WHERE rolname ILIKE '%openbot%' ORDER BY rolname;"
echo "# databases whose name contains the old brand"
names "SELECT datname FROM pg_database WHERE datname ILIKE '%openbot%' ORDER BY datname;"
echo "# functions whose name contains the old brand"
names "SELECT proname FROM pg_proc WHERE proname ILIKE '%openbot%' GROUP BY proname ORDER BY proname;"
echo "# triggers whose name contains the old brand"
names "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname ILIKE '%openbot%' GROUP BY tgname ORDER BY tgname;"
out=$(session "SELECT pg_database_size(current_database());" | tail -n 1)
case $out in '' | *[!0-9]*) out=n/a ;; esac
echo "database_size_bytes=$out"
avail=$(docker exec "$CONTAINER" df -kP /var/lib/postgresql 2>/dev/null | awk 'NR==2 {print $4}')
case $avail in '' | *[!0-9]*) avail=n/a ;; esac
echo "pg_volume_avail_kb=$avail"

echo
echo "# rows"
count approval_exact_input_captures "SELECT count(*) FROM approval_exact_input_captures;"
count approval_exact_input_objects "SELECT count(*) FROM approval_exact_input_objects;"
count approvals_pending "SELECT count(*) FROM approval_requests WHERE status = 'pending';"
count continuations_unfinished "SELECT count(*) FROM approval_continuations WHERE state <> 'completed';"
count continuation_steps_unfinished "SELECT count(*) FROM approval_continuation_steps WHERE state <> 'completed';"
# 运行断言是签名令牌，不入库：无表可数。
echo "run_assertions_unexpired=n/a"
# 凭据的 kid 在封套 JSON 里（JSON.stringify 无空格）；v1 封套没有 kid。用 LIKE 而不是 ::jsonb，坏行不会让整条查询报错。
count credentials_all "SELECT count(*) FROM credentials;"
count credentials_live_kid_k1 "SELECT count(*) FROM credentials WHERE revoked_at IS NULL AND encrypted_value LIKE '%\"kid\":\"k1\"%';"
count credentials_live_kid_other "SELECT count(*) FROM credentials WHERE revoked_at IS NULL AND encrypted_value LIKE '%\"kid\":\"%' AND encrypted_value NOT LIKE '%\"kid\":\"k1\"%';"
count credentials_live_no_kid "SELECT count(*) FROM credentials WHERE revoked_at IS NULL AND encrypted_value NOT LIKE '%\"kid\":%';"
count automation_hooks_signed "SELECT count(*) FROM automation_triggers WHERE secret_hash IS NOT NULL;"
# web-bot-auth 只由环境变量 WEB_BOT_AUTH 控制，库里没有开关；该变量不带品牌前缀，env 两节里看不到。
echo "web_bot_auth_switch=n/a"
# OpenTag 的密钥与地址只在环境变量里；库里只有经它绑定的 Slack/Teams 身份。
count opentag_chat_bindings "SELECT count(*) FROM delivery_bindings WHERE transport IN ('slack', 'teams');"
count learning_settings_rows "SELECT count(*) FROM learning_settings;"
count learning_thread_bindings_old_container "SELECT count(*) FROM learning_thread_bindings WHERE container_id ILIKE '%openbot%';"
count learning_person_spaces_rows "SELECT count(*) FROM learning_person_spaces;"
count brokered_identities_rows "SELECT count(*) FROM brokered_identities;"
count shared_account_mcp_servers "SELECT count(*) FROM mcp_servers WHERE shared_vendor_user_id LIKE 'openbot-deployment:%';"
count shared_account_composio_connections "SELECT count(*) FROM composio_connections WHERE vendor_user_id LIKE 'openbot-deployment:%';"
count shared_account_brokered_accounts "SELECT count(*) FROM brokered_accounts WHERE vendor_user_id LIKE 'openbot-deployment:%';"
count shared_account_pending_authorizations "SELECT count(*) FROM pending_authorizations WHERE vendor_user_id LIKE 'openbot-deployment:%';"
count deployment_packages_tenant_old_brand "SELECT count(*) FROM deployment_packages WHERE tenant_id = 'openbot';"
count plugin_grants_granted_by_old_brand "SELECT count(*) FROM plugin_grants WHERE granted_by LIKE 'openbot:%';"
# plugin_grants 没有 updated_by 列。
echo "plugin_grants_updated_by_old_brand=n/a"
# 记忆默认值的键是 pg_advisory_xact_lock 的事务内锁键，不入库。
echo "memory_default_keys_old_brand=n/a"
count user_skin_old_brand "SELECT count(*) FROM users WHERE preferences->>'skin' = 'openbot';"

echo
echo "# copilotkit-usage"
echo "copilotkit_env_file=$(grep -cE '^(COPILOTKIT|CPK)_[A-Z0-9_]*=' "$ENV_FILE" || true)"
echo "copilotkit_container_env=$(docker exec "$CONTAINER" ls /run/s6/container_environment 2>/dev/null | grep -cE '^(COPILOTKIT|CPK)_[A-Z0-9_]*$' || true)"
count learning_settings_rows_again "SELECT count(*) FROM learning_settings;"
