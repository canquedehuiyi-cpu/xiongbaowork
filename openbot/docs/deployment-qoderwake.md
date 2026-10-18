# 熊宝数字员工部署手册

本手册面向交付部署；从仓库根进入 `openbot/` 执行命令。
本机历史端口、迁移研发与测试经验在[开发环境笔记](development-environment-qoderwake.md)。
对外发布仍需 DoD-1/2/3/8 的证据，当前记录见[B 线交付验证](track-b-delivery-evidence.md)。
全新 WSL、Windows PowerShell 与独立 Compose 的实际命令和耗时见
[部署验收记录](delivery-acceptance-2026-10-09.md)。

## 1. 单容器：Linux / Windows Docker Desktop

按[根 README](../../README.md)对应平台步骤构建镜像、生成随机密钥，挂三个命名卷。
内嵌 PostgreSQL 使用 16 + pgvector；CI 服务端测试使用独立 pgvector/pg17 service。
镜像同一个 3001 端口提供 API 与 SPA，3772 是本机示例宿主端口。

必须挂载 `/var/lib/postgresql` 的父目录，不能只挂 `/var/lib/postgresql/data`。
数据目录旁的 `pgpassword` 与 `pgpassword-app` 保存 owner / app 的随机口令，权限 600；
必须与数据一并保留。镜像重建会复用口令，并在迁移后再次设置 app 角色。
`/workspace` 与 `/profiles` 分别保存员工文件和浏览器会话。

本机模板开启单用户体验，只绑定 loopback。对外部署改用登录配置（第 3 节），
在反向代理后提供 HTTPS。员工执行位置 `TENANT_RUNTIME=device` 需要配对并在线的设备；
云端浏览器模式为 `cloud`，共享浏览器不是每员工独立沙箱。

## 2. Compose 形态

同样先构建镜像、准备 `.env.delivery`；这个 Compose 文件只管理本产品独立服务与卷。

```bash
docker compose --project-name xiongbao-local --env-file .env.delivery \
  -f docker/compose.delivery.yml config --quiet
docker compose --project-name xiongbao-local --env-file .env.delivery \
  -f docker/compose.delivery.yml up -d
docker compose --project-name xiongbao-local --env-file .env.delivery \
  -f docker/compose.delivery.yml logs --tail=100 app
```

PowerShell 可把命令写在一行，或用反引号续行。修改宿主端口时，
在 `.env.delivery` 设 `OPENBOT_PORT=新端口` 并同步 `OPENBOT_PUBLIC_URL`。
停服用同一 `--project-name` 的 `stop`；`down` 会删容器而保留卷，禁止在升级时加 `-v`。
开发用 `openbot/docker-compose.yml` 不作为交付起法，它还包含上游开发服务和宿主进程假设。

## 3. 对外部署与账号

将下列配置写到只由部署方读取的 `.env.delivery`，生成的值请持久保管。
配置 `BETTER_AUTH_SECRET` 和 `BETTER_AUTH_URL` 即启用邮箱密码登录；OAuth 可以按
[配置参考](configuration.md)追加。首位管理员邮箱必须在 `INITIAL_ADMIN_EMAILS`。

```dotenv
OPENBOT_SINGLE_USER=false
OPENBOT_PUBLIC_URL=https://employees.example.com
BETTER_AUTH_URL=https://employees.example.com
BETTER_AUTH_SECRET=<至少32字符的随机值>
INITIAL_ADMIN_EMAILS=admin@example.com
TRUSTED_ORIGINS=https://employees.example.com
KEY_ENCRYPTION_KEY=<32字节随机值的base64>
OPENBOT_RLS_ENFORCE=refuse
OPENBOT_SELF_HOST_BANNER=false
```

将示例域名与占位值替换后再启动。反向代理转发到本机 3772，保留同一 origin 的 API 与 SPA，
支持 SSE 长连接和设备 WebSocket。模型接入、用户注册、配额与跨租户隔离需要独立验收。
不用公开端口 4100，也不要把 Docker socket 挂给交付容器。

## 4. 外接 PostgreSQL：分开迁移和运行

外接数据库推荐 pgvector/pg17，先准备名为 `openbot` 的迁移 owner 与独立数据库。
迁移 `0054` 的 default privileges 指定 owner 名 `openbot`；用不同 owner 时需逐项检查授权。
下面连接串是格式示例，密码使用实际私密值并按 URL 规则编码。

```dotenv
EMBEDDED_POSTGRES=off
DATABASE_URL=postgres://openbot_app:<URL编码口令>@db.example.com:5432/openbot_b?sslmode=require
```

**API 运行期必须是非超级用户、无 BYPASSRLS 的角色。owner 串只用于迁移。**
嵌入模式会自动导出 `MIGRATION_DATABASE_URL`，外接模式不会自动迁移，运维在发布流程中单独执行。
创建临时的私密 `.env.migration`，其中 `DATABASE_URL` 是 owner 串；不要把该文件交给 API 容器。

```bash
docker run --rm --env-file .env.migration --entrypoint /bin/sh \
  xiongbao-digital-employee:local \
  -c 'cd /app/server && exec /usr/local/bin/bun scripts/migrate.ts'
```

迁移后通过安全 SQL 会话设置独立随机 app 密码（覆盖迁移中的公开开发密码），并约束角色：

```sql
ALTER ROLE openbot_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '<随机口令>';
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'openbot_app';
-- 期望 openbot_app | f | f
```

将同一口令写入运行期 DATABASE_URL，启动 API。生产数据库依运营方的备份和 TLS 策略配置；
若 API 日志出现 `rls-not-enforced`，容器会拒绝启动。不要通过关闭 refuse 绕过配置错误。

## 5. 品牌与模型配置

```bash
docker build --build-arg TENANT_PACKAGE_DIR=../examples/qoderwake \
  -f Dockerfile -t xiongbao-digital-employee:local .
```

品牌包必须在 build context 内（这里是 `openbot/`）；相对路径以 server 为基准。
自定义包要同时配置构建参数和运行期 TENANT_PACKAGE_DIR。SPA 首屏标题与主 JS 品牌由 C 线入口代码完成；
只设置运行期变量不会重写 bundle。上游推广条在运行期由 `OPENBOT_SELF_HOST_BANNER=false` 关闭。

模型可在产品模型库接入并绑定到员工；部署默认的 OpenAI 兼容接口配置为：

```dotenv
OPENAI_BASE_URL=https://your-provider.example/v1
OPENAI_API_KEY=<供应商密钥>
BOT_MODEL=<供应商当前支持的准确模型名>
```

**模型名用 BOT_MODEL，OPENAI_MODEL 全仓没有读取代码，不会生效。**
兼容 OpenAI 路径上必须同时设置 `OPENAI_BASE_URL`；`BOT_PROVIDER` 留空或设为 `openai`。
供应商模型名和鉴权方式必须依据自己的账号目录。BOT_MODEL 覆盖部署级默认值，员工绑定优先；
未设置兼容地址时 OpenAI 路径仍按品牌包默认模型。默认模型占位与“未配置模型”引导由 A/C 的 WP-1.3 完成。
不能承诺“设置 BOT_MODEL 后所有员工立即使用它”。修改环境配置后重新创建容器，`docker restart`
不会读取已改的 env-file。B 线验证不发送对话，不使用任何真实 provider。

## 6. 备份、恢复与升级

至少备份数据库、两个同卷口令文件、workspace、profiles，以及原有 KEY_ENCRYPTION_KEY 和登录 secret。
密钥丢失或更换会使已有凭据无法解密；不要每次升级重新生成。
内嵌库可以在容器运行时用 pg_dump 作一致性逻辑备份。以下在 Linux shell 执行，输出是数据库内容，请私密保存：

```bash
mkdir -p backup
chmod 700 backup
docker exec xiongbao-local sh -c \
  'url=$(cat /run/s6/container_environment/MIGRATION_DATABASE_URL); exec /usr/lib/postgresql/16/bin/pg_dump "$url" -Fc' \
  > backup/database.dump
```

PowerShell 通过管道重定向二进制可能改变内容；使用 `docker exec ... pg_dump -f /tmp/database.dump`
再 `docker cp xiongbao-local:/tmp/database.dump backup/database.dump`，避免在 Windows shell 转码。
不复制正在写入的 PGDATA。需要卷级快照时先正常停服，然后整体备份三个卷和密钥。
恢复先在隔离新卷、新项目、新端口验证（3772 的 B 线测试不能与体验容器同时占用），确认健康、
原数据可读、原凭据可解密，再切换。外接库使用数据库服务方的一致性备份和恢复流程。

升级先备份，在新镜像上验证迁移；单容器重建时使用原命名卷和原 env-file。
Compose 使用 `OPENBOT_IMAGE=新标签`、`up -d`；内嵌库每次启动自动迁移。
一旦有 schema 迁移，回滚镜像不一定足够，必要时恢复备份；不要把只回滚代码当成数据库回滚。

## 7. 健康与交付断言

```bash
curl --fail http://127.0.0.1:3772/health
docker logs xiongbao-local
```

根 CI 镜像测试：启动 60 秒内 health 200；capabilities 200 / selfHostBanner=false；
日志无 rls-not-enforced（同时拒绝 role-check-unavailable）；HTML、主 JS 含品牌且无推广字面量；
两个口令文件 600；app 角色 f/f，固定密码不能登录；显式 owner 串的容器必须退出非零。
同时验证强制终止后复用原卷保留数据和口令、旧卷补齐 app 口令，以及登录模式下
两人注册、私有员工跨租户读取 404、Free 档第三位员工 402；不发送模型请求。
`bash scripts/ci/image-smoke.sh <镜像>` 只使用自己的临时容器/卷及 3772，结束自动清理。

全套测试绿色必须读取日志的 `0 fail`，不能只读退出码。
阶段 0–2 的测试 continue-on-error、构建成功、健康成功和完整验收是不同结果。

## 8. 三条必须记住的配置坑（WP-0.3）

1. **模型名用 BOT_MODEL；OPENAI_MODEL 全仓没有读取代码。** 兼容 OpenAI 路径还需 OPENAI_BASE_URL，
   供应商实际模型名从其账号目录确认。环境文件修改后重新创建服务容器。
2. **运行期数据库串必须是非超级用户、无 BYPASSRLS。** owner 只供迁移；否则 RLS 不约束 API，
   镜像默认 refuse 拒绝启动。不能用“接口返回 200”替代角色检查。
3. **Windows 宿主不能直接 bun 起 server。** 交付路径是镜像或 Linux/WSL；宿主只调用 Docker 与 HTTP 检查。
   Git Bash 使用 Docker 的 -v/-w 绝对路径时设置 MSYS_NO_PATHCONV=1。
