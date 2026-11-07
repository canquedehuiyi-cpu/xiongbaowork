# 熊宝数字员工部署手册

本手册面向交付部署。客户部署拉取发布镜像 `ghcr.io/canquedehuiyi-cpu/xiongbaowork`，
不需要源码、Git 或本机构建；只有[附录：从源码构建](#附录从源码构建)需要进入 `openbot/`。
本机历史端口、迁移研发与测试经验在[开发环境笔记](development-environment-qoderwake.md)。
对外发布仍需 DoD-1/2/3/8 的证据，当前记录见[B 线交付验证](track-b-delivery-evidence.md)。
全新 WSL、Windows PowerShell 与独立 Compose 的实际命令和耗时见
[部署验收记录](delivery-acceptance-2026-10-09.md)。

## 1. 单容器：Linux / Windows Docker Desktop

按[根 README](../../README.md)对应平台步骤拉取发布镜像、下载同一标签的配置模板、生成随机密钥，挂三个命名卷。
README 的 Linux 命令块在每次发布后由 `.github/workflows/clean-deploy.yml` 原样执行（Gate 7 Linux）；
Windows 命令块由人工验收。GHCR 包设为公开之前，未登录的拉取会失败，该 CI 任务也会失败。
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

这个 Compose 文件只管理本产品独立服务与卷。在新建空目录中下载同一标签的 Compose 文件、配置模板和
Release 附件 `container-images.json`，生成密钥，并把 `OPENBOT_IMAGE` 设为其中的 digest 引用（见第 7 节）。
需要 curl、OpenSSL 和 jq。不设置 `OPENBOT_IMAGE` 时，Compose 使用只在源码构建后才存在的本机镜像，`up` 会失败。

```bash
OPENBOT_TAG=v0.2.2
raw="https://raw.githubusercontent.com/canquedehuiyi-cpu/xiongbaowork/$OPENBOT_TAG/openbot/docker"
mkdir -p docker
curl --fail --silent --show-error --location -o docker/compose.delivery.yml "$raw/compose.delivery.yml"
curl --fail --silent --show-error --location -o .env.delivery "$raw/delivery.env.example"
chmod 600 .env.delivery
printf '\nKEY_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" >> .env.delivery
curl --fail --silent --show-error --location -o container-images.json \
  "https://github.com/canquedehuiyi-cpu/xiongbaowork/releases/download/$OPENBOT_TAG/container-images.json"
printf 'OPENBOT_IMAGE=%s\n' "$(jq -r .images.openbot.reference container-images.json)" >> .env.delivery
grep -E '^OPENBOT_IMAGE=ghcr\.io/.+@sha256:[0-9a-f]{64}$' .env.delivery
```

Compose 文件按 `docker/` 目录相对读取上一级的 `.env.delivery`；最后一行应打印 digest 形式的镜像引用。

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

`INITIAL_ADMIN_EMAILS` 只对经过验证的地址生效，也就是通过身份提供方（Google、Microsoft、Okta 或已登记的 SSO）登录的账号。
用邮箱密码注册的账号无人验证过，所以即使地址在名单里也不会自动成为管理员：否则谁先抢注这个地址，谁就拿到平台管理员。
只用邮箱密码登录的部署，请先用该地址注册，再在服务器容器里执行一次：

```bash
docker exec <容器名> sh -c 'export DATABASE_URL="$(cat /run/s6/container_environment/DATABASE_URL)" ROLE_WRITER_DATABASE_URL="$(cat /run/s6/container_environment/ROLE_WRITER_DATABASE_URL)"; cd /app/server && bun scripts/grant-admin.ts admin@example.com'
```

能在容器里执行命令的人已经掌握数据库和全部密钥，所以由他指定首位管理员。这条命令会写一条审计记录。

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
ROLE_WRITER_DATABASE_URL=postgres://openbot_role_writer:<URL编码口令>@db.example.com:5432/openbot_b?sslmode=require
```

**API 运行期必须是非超级用户、无 BYPASSRLS 的角色。owner 串只用于迁移。**
`ROLE_WRITER_DATABASE_URL` 是迁移 `0109` 建立的 `openbot_role_writer`，唯一可以写入身份角色的登录；
缺少它 API 拒绝启动（`ROLE_WRITER_DATABASE_URL is required`）。内嵌模式自动生成这两条连接串，外接模式需要自己配置。
嵌入模式会自动导出 `MIGRATION_DATABASE_URL`，外接模式不会自动迁移，运维在发布流程中单独执行。
创建临时的私密 `.env.migration`，其中 `DATABASE_URL` 是 owner 串；不要把该文件交给 API 容器。
迁移与运行使用同一个 digest（`container-images.json` 的取得见第 7 节）。
下面两段命令在每次发布后由 CI 原样执行（Gate 7 Linux 外接库：独立 pgvector/pg17 容器）。

<!-- g7:external-migrate:begin -->
```bash
OPENBOT_IMAGE="$(jq -r .images.openbot.reference container-images.json)"
docker run --rm --env-file .env.migration --entrypoint /bin/sh \
  "$OPENBOT_IMAGE" \
  -c 'cd /app/server && exec /usr/local/bin/bun scripts/migrate.ts'
```
<!-- g7:external-migrate:end -->

迁移后用 owner 通过安全 SQL 会话为两个角色设置各自独立的随机密码（覆盖迁移中的公开开发密码），并约束角色：

<!-- g7:external-roles:begin -->
```sql
ALTER ROLE openbot_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '<app随机口令>';
ALTER ROLE openbot_role_writer WITH LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '<role_writer随机口令>';
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
  WHERE rolname IN ('openbot_app', 'openbot_role_writer') ORDER BY rolname;
-- 期望 openbot_app | f | f 与 openbot_role_writer | f | f
```
<!-- g7:external-roles:end -->

将两个口令分别写入运行期 `DATABASE_URL` 与 `ROLE_WRITER_DATABASE_URL`，删除 `.env.migration`，
再按 README 的单容器命令（`.env.delivery` 已存在时会保留）或第 2 节 Compose 启动 API。
生产数据库依运营方的备份和 TLS 策略配置；
若 API 日志出现 `rls-not-enforced`，容器会拒绝启动。不要通过关闭 refuse 绕过配置错误。

## 5. 品牌与模型配置

发布镜像在构建期内置 `examples/qoderwake` 品牌包。SPA 首屏标题与主 JS 品牌在构建期注入，
只设置运行期 TENANT_PACKAGE_DIR 不会重写 bundle；换品牌包需要按附录从源码构建。
上游推广条在运行期由 `OPENBOT_SELF_HOST_BANNER=false` 关闭。

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

### 5.1 首次真实部署实测要点（2026-11-06，京东云 Ubuntu 22.04，v0.2.0）

以下各条都已在真实部署上遇到，并对照代码核实：

1. **单容器镜像不带内置 Bot。**
   - 新建员工时「内置」一项是灰的，提示「这个部署没有自带的员工可供运行」。原因是没有设置 `MANAGED_AGENT_AG_UI_URL`（见 `server/src/config.ts` 的 `managedAgentConfig`），内置 Bot 是 Compose 里单独的 `agent-bot` 服务。
   - 单容器部署里能直接对话的是每个人的「我的分身」。它用的是部署级模型，即本节开头的 `OPENAI_BASE_URL`、`OPENAI_API_KEY` 和 `BOT_MODEL`。
   - 品牌包里的公共员工（通用助手等）由系统统一管理，设置页只能看，会写「这位员工归别人所有」，模型显示为「外部托管模型」，这是正常现象。
2. **模型库接入自己的密钥要看套餐。**
   - 新租户默认是 Free 套餐，「能力与资源 → 模型」会提示「免费版只能使用平台体验模型」，接入按钮不可用。
   - 管理员在 `/plans` 把工作空间切到允许「可接入自己的模型」的套餐即可。这里不涉及付费，切换立即生效。
3. **v0.2.0 的模型「测试」按钮必然失败。**
   - 不论密钥是否正确，都显示 "The connectivity test could not be run."，原因是前端发的是 GET，服务端只认 POST。
   - canquedehuiyi-cpu/xiongbaowork#276 已修复，下一个镜像版本生效。在那之前，直接用对话来验证模型。
4. **在服务器上写入密钥，不要把它打在命令里。**
   - 用 `read -rsp "提示语" K` 读入，提示语原样保留，出现提示后只粘贴一次。粘两次会得到两倍长度的无效密钥，供应商会报 `Authentication Fails`。
   - 可以只检查长度，不显示内容。DeepSeek 密钥是 35 位：

     ```bash
     awk -F= '/^OPENAI_API_KEY=/{print length(substr($0,16))}' /opt/xiongbao/.env.delivery
     ```

   - 密钥一旦出现在终端回显或聊天记录里，就到供应商后台删除并重建。
5. **健康检查地址是 `/health`，不是 `/api/health`。** 后者会返回 404。
6. **要在自己电脑上执行命令，得跟本人的「我的分身」说。**
   - 生产默认 `TENANT_RUNTIME=device`：员工的电脑操作跑在这个员工**主人**配对的设备上（`server/src/devices/selection.ts`）。品牌包的公共员工不归任何人，所以永远用不了谁的电脑，会提示 "does not belong to a tenant with machines of its own."。
   - v0.2.0 里侧栏那段「我的分身」对话（`/channel/channel_<uuid>`）其实由公共员工 `general-assistant` 接，它当时也叫「我的分身」，所以在这段对话里用不了电脑。这段对话是首页「开始新对话」不 @ 时默认交给第一个公共员工建出来的；多用户部署（`OPENBOT_SINGLE_USER=false`）不会给每个人建品牌包的对话。实测改为跟本人的分身（`avatar-<本人>`）对话后，命令在配对的 Windows 设备上跑通了。
   - 已修复（#283、#286）：
     - 公共员工改名「通用助手」，它的说明写明不代表任何人、用不了任何人的电脑。
     - 每个人第一次打开应用（读对话列表）时，自动有一段和本人分身的对话「我的分身」；删掉的不会再补回来。
     - 不 @ 时默认交给本人的分身，而不是第一个公共员工。
     - 分身带上造员工、造技能的技能。
     - 已有的人下次打开就会补上；旧的那段对话和群聊会按员工的当前名字改名（例如「通用助手」），员工和历史都不变。
     - 单用户部署由品牌包同步在启动时处理。两种部署都不需要手工迁移。

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

升级先备份，按第 7 节取得新版本的 digest 并校验来源，在隔离环境验证迁移；
单容器重建时使用原命名卷和原 env-file，镜像写成 `ghcr.io/canquedehuiyi-cpu/xiongbaowork@sha256:<新 digest>`。
Compose 把 `.env.delivery` 中的 `OPENBOT_IMAGE` 改为同样的 digest 引用，再 `pull` 和 `up -d`；
内嵌库每次启动自动迁移；外接库先用新 digest 执行第 4 节的迁移命令，再重建 API 容器。标签可以被移动，digest 不能；回滚就是换回上一个版本的 digest。
一旦有 schema 迁移，回滚镜像不一定足够，必要时恢复备份；不要把只回滚代码当成数据库回滚。

## 7. 版本固定与来源校验

每个 GitHub Release 附带 `container-images.json`，记录该标签发布时经过 Gate 1 验证的 digest。
部署和升级使用 digest，而不是可移动的标签；部署前可校验镜像由本仓库的发布流程构建。

```bash
OPENBOT_TAG=v0.2.2
gh release download "$OPENBOT_TAG" -R canquedehuiyi-cpu/xiongbaowork --pattern container-images.json
OPENBOT_IMAGE="$(jq -r .images.openbot.reference container-images.json)"
gh attestation verify "oci://$OPENBOT_IMAGE" -R canquedehuiyi-cpu/xiongbaowork
docker pull "$OPENBOT_IMAGE"
docker image inspect "$OPENBOT_IMAGE" --format '{{json .RepoDigests}}'
```

`reference` 形如 `ghcr.io/canquedehuiyi-cpu/xiongbaowork@sha256:<64 位十六进制>`；
按标签拉取后 `RepoDigests` 应包含同一个引用。`gh attestation verify` 需要已登录的 GitHub CLI。

## 8. 健康与交付断言

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
发布流程先对推送的 digest 执行上述检查（Gate 1），再打标签；随后 `clean-deploy.yml` 在全新 Linux
runner 上、不登录 GHCR，原样执行 README 的 Linux 命令块，核对运行的镜像 digest 与 `container-images.json`
一致，并运行同一组接口断言（Gate 7 Linux）。同一任务另有外接库一半：独立的 pgvector/pg17 容器，
原样执行第 4 节的迁移与角色命令，再用同一 README 命令启动 `EMBEDDED_POSTGRES=off` 的 API，
确认内嵌库未初始化、API 以 `openbot_app` 连接外接库。也可以在 Actions 中手动运行该 workflow 并填写标签。

全套测试绿色必须读取日志的 `0 fail`，不能只读退出码。
阶段 0–2 的测试 continue-on-error、构建成功、健康成功和完整验收是不同结果。

## 9. 三条必须记住的配置坑（WP-0.3）

1. **模型名用 BOT_MODEL；OPENAI_MODEL 全仓没有读取代码。** 兼容 OpenAI 路径还需 OPENAI_BASE_URL，
   供应商实际模型名从其账号目录确认。环境文件修改后重新创建服务容器。
2. **运行期数据库串必须是非超级用户、无 BYPASSRLS。** owner 只供迁移；否则 RLS 不约束 API，
   镜像默认 refuse 拒绝启动。不能用“接口返回 200”替代角色检查。
3. **Windows 宿主不能直接 bun 起 server。** 交付路径是镜像或 Linux/WSL；宿主只调用 Docker 与 HTTP 检查。
   Git Bash 使用 Docker 的 -v/-w 绝对路径时设置 MSYS_NO_PATHCONV=1。

## 附录：从源码构建

只有修改源码或更换构建期品牌包时才在本机构建；这样得到的镜像没有发布 digest 和来源证明，
不能作为交付验收证据。从仓库根进入 `openbot/`：

```bash
docker build --build-arg TENANT_PACKAGE_DIR=../examples/qoderwake \
  -f Dockerfile -t xiongbao-digital-employee:local .
```

品牌包必须在 build context 内（这里是 `openbot/`）；相对路径以 server 为基准。
自定义包要同时配置构建参数和运行期 TENANT_PACKAGE_DIR。之后把上文命令中的镜像换成
`xiongbao-digital-employee:local`（单容器跳过 `docker pull`）；Compose 未设置 `OPENBOT_IMAGE` 时默认使用这个本机标签。
