#!/usr/bin/env bash
# 一条命令起"单用户全栈"（G2），并把它踩过的两个坑变成机器检查。
#
# 为什么不用 `docker compose up`：compose 会**重建本机正在用的 `openbot-postgres-1`**。
# 这里只创建自己的容器，一律 `openbot-g2-*` / `openbot-echo-bot` 前缀，绝不碰别人的栈。
#
# 用法：
#   openbot/scripts/g2-stack.sh up       # 起 server + app + computer(+ echo)
#   openbot/scripts/g2-stack.sh status    # 谁活着，以及命名空间有没有错位（诊断见 check）
#   openbot/scripts/g2-stack.sh down      # 只收自己的容器
#
# 密钥：一次性开发值，**运行时生成、只作为容器环境变量传入**，不落任何文件、不进 git。
set -euo pipefail

command="${1:-up}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
B="$repo_root/openbot"
IMAGE=openbot-dev
COMPUTER_IMAGE=openbot-agent-computer:latest
DB_URL="postgres://openbot_app:openbot@host.docker.internal:5433/openbot"
SERVER=openbot-g2-server
APP=openbot-g2-app
COMPUTER=openbot-g2-computer
ECHO=openbot-echo-bot
COMPUTER_TOKEN="g2-dev-$$"

die() {
  printf '%s\n' "FAIL: $*" >&2
  exit 1
}

recreate() {
  local name="$1"
  shift
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" "$@" >/dev/null
  printf 'up   %s\n' "$name"
}

up() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 ||
    die "$IMAGE 不存在：先 build 开发镜像（见 docs/deployment-qoderwake.md §5）"

  # 单用户模式的关键三点（都是实测）：
  #   1) 一个 BETTER_AUTH_* 都不能给 —— 给了就有"登录方式"，单用户会自己关掉（config.ts 的
  #      `singleUser = !organizationAuthUrl && singleUserAllowed(env, auth !== undefined)`）。
  #   2) INTELLIGENCE_MODE=local 必须有，否则 server 拒绝启动（Missing: INTELLIGENCE_API_KEY）。
  #   3) OPENBOT_PUBLIC_URL 必须是回环地址，否则 singleUserAllowed 拒绝启动 —— 这是设计。
  recreate "$SERVER" \
    -e DATABASE_URL="$DB_URL" \
    -e KEY_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
    -e OPENBOT_SINGLE_USER=true \
    -e INTELLIGENCE_MODE=local \
    -e OPENBOT_PUBLIC_URL=http://localhost:3001 \
    -e OPENBOT_SELF_HOST_BANNER=false \
    -e COMPUTER_TOKEN="$COMPUTER_TOKEN" \
    -e AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true \
    -p 3001:3001 -p 3010:3010 \
    -v "$B/server/src:/app/server/src" \
    -v "$B/server/drizzle:/app/server/drizzle" \
    -v "$B/server/scripts:/app/server/scripts" \
    -v "$B/shared:/app/shared" \
    -v "$B/examples:/app/examples" \
    -v "$B/.env:/app/.env" \
    "$IMAGE" bash -lc "cd /app/server && bun --env-file=../.env src/index.ts"

  # app / computer / echo 都寄生在 server 的网络命名空间上：vite 的代理目标是字面量
  # `http://localhost:${SERVER_PORT}`，server 找电脑是字面量 `localhost:4100`。
  # 因此**不能 `docker restart openbot-g2-server`**：重启换命名空间，三个寄生容器集体失联，
  # 表现为 vite 代理 ECONNREFUSED、`/api/computers/.../control` 503、`computer` 显示 healthy
  # 却挂在已死沙箱上。改代码后要重起就整组重建（本脚本的 up 是幂等的）。
  recreate "$APP" \
    --network "container:$SERVER" \
    -e SERVER_PORT=3001 -e APP_PORT=3010 \
    -v "$B/app/src:/app/app/src" -v "$B/app/tests:/app/app/tests" \
    -v "$B/shared:/app/shared" -v "$B/server/src:/app/server/src" \
    -v "$B/examples:/app/examples" -v "$B/scripts:/app/scripts" -v "$B/.env:/app/.env" \
    "$IMAGE" bash -lc "cd /app/app && bun run dev --host 0.0.0.0 --port 3010 --strictPort"

  if docker image inspect "$COMPUTER_IMAGE" >/dev/null 2>&1; then
    recreate "$COMPUTER" \
      --network "container:$SERVER" \
      -e COMPUTER_TOKEN="$COMPUTER_TOKEN" \
      -e COMPUTER_BROWSER_MODE=headless \
      "$COMPUTER_IMAGE" bun src/index.ts
  else
    printf 'skip %s（镜像缺失：docker compose build agent-computer 之后再 up 一次）\n' "$COMPUTER"
  fi

  if [ -f "$B/examples/echo-bot/index.ts" ]; then
    recreate "$ECHO" \
      --network "container:$SERVER" \
      -v "$B/examples:/app/examples" \
      "$IMAGE" bash -lc "cd /app/examples/echo-bot && bun index.ts"
  fi

  check || die "起来了但接线不对，看上面的诊断"
  printf '\n打开 http://localhost:3010 （登录者 dev-local-user，单用户模式）\n'
}

# 实测形状的自检：命名空间一致 + server 能到达 4100/4200 + app 代理能穿透。
check() {
  local ok=0
  local server_id borrowed missing=""
  server_id="$(docker inspect -f '{{.Id}}' "$SERVER" 2>/dev/null || echo '')"
  [ -n "$server_id" ] || {
    printf 'MISS %s 没在跑\n' "$SERVER"
    return 1
  }
  for name in "$APP" "$COMPUTER" "$ECHO"; do
    docker container inspect "$name" >/dev/null 2>&1 || continue
    borrowed="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$name")"
    if [ "$borrowed" != "container:$server_id" ]; then
      # NetworkMode 里存的是容器完整 id；不一致就说明它挂在旧（或已死）沙箱上。
      missing="$missing $name(挂在 ${borrowed##container:} 上，应为 $server_id)"
    fi
  done
  if [ -n "$missing" ]; then
    printf 'MISS 命名空间错位：%s\n     ⇒ 重跑本脚本的 up（会逐个重建，不能用 docker restart）\n' "$missing"
    ok=1
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3010/api/channels || echo 000)"
  if [ "$code" != "200" ]; then
    printf 'MISS app 代理到 server 不通（/api/channels=%s）\n' "$code"
    ok=1
  fi
  [ "$ok" = 0 ] && printf 'ok   单用户全栈就绪：http://localhost:3010\n'
  return "$ok"
}

status() {
  for name in "$SERVER" "$APP" "$COMPUTER" "$ECHO"; do
    state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo absent)"
    printf '%-22s %s\n' "$name" "$state"
  done
  check || true
}

down() {
  docker rm -f "$APP" "$COMPUTER" "$ECHO" "$SERVER" >/dev/null 2>&1 || true
  printf 'down   g2 全家（别人的容器一个没碰）\n'
}

case "$command" in
  up) up ;;
  status) status ;;
  check) check ;;
  down) down ;;
  *) die "unknown command: $command（用 up|status|check|down）" ;;
esac
