# 熊宝数字员工部署手册

本手册面向交付部署。客户部署拉取发布镜像 `ghcr.io/canquedehuiyi-cpu/xiongbaowork`，
不需要源码、Git 或本机构建；只有[附录：从源码构建](#附录从源码构建)需要进入 `xiongbao/`。
本机历史端口、迁移研发与测试经验在[开发环境笔记](development-environment-xiongbao.md)。
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
单容器不带搜索服务，员工的 `web_search` 会说明「未配置搜索」；怎么打开见 [5.4](#54-联网搜索读网页与爬网站)。

本机模板开启单用户体验，只绑定 loopback。对外部署改用登录配置（第 3 节），
在反向代理后提供 HTTPS。员工执行位置 `TENANT_RUNTIME=device` 需要配对并在线的设备；
云端浏览器模式为 `cloud`，共享浏览器不是每员工独立沙箱。

## 2. Compose 形态

这个 Compose 文件只管理本产品独立服务与卷。在新建空目录中下载同一标签的 Compose 文件、配置模板和
Release 附件 `container-images.json`，生成密钥，并把 `OPENBOT_IMAGE` 设为其中的 digest 引用（见第 7 节）。
需要 curl、OpenSSL 和 jq。不设置 `OPENBOT_IMAGE` 时，Compose 使用只在源码构建后才存在的本机镜像，`up` 会失败。

```bash
OPENBOT_TAG=v0.2.13
raw="https://raw.githubusercontent.com/canquedehuiyi-cpu/xiongbaowork/${OPENBOT_TAG}/xiongbao/docker"
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
开发用 `xiongbao/docker-compose.yml` 不作为交付起法，它还包含上游开发服务和宿主进程假设。

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

### 3.1 内容源端口：让浏览器直接打开员工做的网页

员工在工作区里做出的静态网页目录（有 `index.html` 的文件夹），可以在对话里点「打开」直接在浏览器里看。
这些网页是员工写的代码，**不能和应用同源运行**，否则网页里的脚本就能冒用你的登录。所以它们由单独的
「内容源」提供：另一个端口，或者另一组子域名。两种方式二选一，都不设就没有这个功能（点「打开」会提示
没有配置内容源，其余功能不受影响）。

**方式一：内容源端口（最简单，IP 访问也能用）**

1. 在 `.env.delivery` 里加 `XIONGBAO_CONTENT_PORT=3773`（1024–65535，不能和 API、应用端口相同）。
2. **容器要映射 3773。** `docker/compose.delivery.yml` 已带 `127.0.0.1:3773:3773`，默认只绑本机。浏览器在别的机器上，
   就要把绑定改成对外：在 `.env.delivery` 里加 `XIONGBAO_CONTENT_BIND=0.0.0.0`（宿主端口用 `XIONGBAO_CONTENT_HOST_PORT` 改，
   容器里始终是 3773）。开发用的 `docker-compose.yml` 同理，把 `127.0.0.1:` 换成对外地址。
3. **京东云（或任何云）安全组必须多放行 3773/TCP**（入方向，来源按你的访问范围；同时检查主机自己的防火墙）。
   不放行，「打开」给出的链接浏览器连不上，表现是一直转圈。
4. 链接的形态是 `<协议>://<你打开应用时用的主机名>:3773/__open/<令牌>`：主机名取自你发起「打开」的那个请求，
   协议取该请求自己的协议。**服务器不读 `X-Forwarded-Proto` 等转发头**，所以应用放在 HTTPS 反代后面时，服务器看到的是
   HTTP，链接会写成 `http://…:3773`。点链接在新标签页里打开不受影响；但 3773 若要给 HTTPS 页面里嵌着用，浏览器会拦混合内容，
   这种情况请用方式二，或在 3773 前面再放一个带证书的反代。若在 3773 前另加 TLS 反代，要用
   `proxy_set_header Host $http_host;`（保留端口，而不是 `$host`），否则写请求与 WebSocket 的来源检查会因主机对不上而被误拒。
5. **主反代必须保留 `Host`**（Nginx 写 `proxy_set_header Host $host;`）。链接的主机名取自「打开」请求的 `Host`，
   不保留的话主机名会变成 `127.0.0.1` 之类，链接在别人的浏览器里打不开。
6. **应用若发 HSTS**（`Strict-Transport-Security`，尤其带 `includeSubDomains`，或同一主机名），浏览器会把
   `http://主机:3773` 强制改成 `https://主机:3773`，而 3773 没有 TLS，页面就打不开。两个办法：让内容端口也上 TLS
   （3773 前面再放一个带证书的反代），或改用方式二（域名模式）。
7. 同一个浏览器同一时刻只有一个当前网页：再打开另一个目录，会替换前一个（「打开」的回答里 `replaces: true`）。

**方式二：泛子域名（每个网页一个子域，浏览器里各自独立）**

1. 选一个专用域名，例如 `apps.example.com`，设 `XIONGBAO_CONTENT_DOMAIN=apps.example.com`
   （只写主机名，不要协议、端口和路径；**不能等于或是应用所在域名的上级**：应用在 `app.example.com`，
   就不能把内容域名设成 `example.com`，否则整个应用都会被当成内容源。启动时会按 `OPENBOT_PUBLIC_URL`、
   前端地址和 `TRUSTED_ORIGINS` 里的主机名检查，撞上就拒绝启动）。设了域名就不再单独监听内容端口，
   `XIONGBAO_CONTENT_PORT` 不再起作用，3773 也不必放行。
   **内容域名请用与应用不同的可注册域**（例如应用在 `app.example.com`，内容放在另一个域名下，而不是 `apps.example.com`）：
   程序的脚本可以给自己的上级域写 cookie，同一个可注册域下的应用会收到这些 cookie。
2. **泛域名解析：** 给 `*.apps.example.com` 加一条解析，指向和应用相同的入口。
3. **泛域名证书：** 申请 `*.apps.example.com` 的泛域名证书（通配符证书只能用 DNS 验证方式签发，
   按你的 DNS 服务商做）。链接固定写 `https://`，没有证书浏览器会报错。
4. **反代：** 把 `*.apps.example.com` 的请求原样转给应用的主端口（宿主 3772），**保留原始 `Host` 头**，
   服务器按 `Host` 的后缀 `.apps.example.com` 把这些请求交给内容源，其余名字照旧交给应用。示例（Nginx）：

```nginx
server {
    listen 443 ssl;
    server_name *.apps.example.com;
    ssl_certificate     /etc/ssl/apps.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/apps.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3772;
        proxy_set_header Host $host;
    }
}
```

5. 每个网页的子域名是它的目标（人、员工、目录）算出的 16 位小写十六进制，别的网页拿到令牌也进不了这个子域。
6. **关闭或脱敏反代的访问日志里 `/__open/` 与 `/u/` 开头的路径**：这两类路径里带着令牌（30 分钟有效，换得到访问权）。
   Nginx 里给这个 `server` 加 `access_log off;`，或用 `map` 把这两类路径在日志里换成占位。端口模式没有反代，
   但服务器自己的访问日志、浏览器历史里同样会有 `/u/<令牌>/`，别把它们当公开信息。

**两种方式共有的行为（安全相关）**

- **链接等同凭据，请勿转发。** `/__open/` 链接 30 分钟内转发给别人，对方就能以你的身份打开；打开后以你的身份续期，
  最长 12 小时。地址栏里的 `/u/` 地址 30 分钟内同样有效。端口模式下建议给 3773 配 TLS（前面放带证书的反代），
  免得链接和令牌在网络上明文传输。

- 「打开」先要求你有权看：自己的员工，或你所在对话/卡片里这一次运行交付过该目录下的文件。目录必须真的存在且有
  `index.html`；工作区根目录、以 `.` 开头的目录（如 `.git`）一律拒绝。
- 链接里的令牌 30 分钟有效，换成 HttpOnly 的 `xb_content` cookie（不设 `Domain`，只属于当前主机）。
  内容源**只认这一个 cookie**，应用的登录 cookie 即使同主机被带上来也不读、不转发。
- 页面本身带 `sandbox` 安全头（脚本、表单可用，但拿不到任何 cookie 和本地存储），页面里的相对资源走
  `/u/<令牌>/…` 路径加载。
- 每次请求都会确认你仍是成员、员工仍在、卡片仍可见（同一授权的结果缓存 1 分钟，同时到达的请求合并成一次查询）：
  不通过则 404 并清掉 cookie。所以被移出对话的人约 1 分钟内失去访问。cookie 用满一半后续期 30 分钟，
  但从第一次打开起最多续到 12 小时，之后要重新点「打开」。
- 页面地址里的 `/u/<令牌>/` 令牌 30 分钟过期且不续期；过期后在同一个浏览器里刷新页面（带着同一目标的有效 cookie），
  会被自动带到新的令牌地址继续看，别的情况（比如换了浏览器）一律 404，重新点「打开」即可。
- 每次成功「打开」写一条审计 `content.opened`（员工、目录、对话或卡片、方式），**不含令牌或链接**。

**员工电脑「打开正在运行的程序」只会转给该员工自己的程序。** 判断依据是监听端口所属的系统用户，所以服务器、数据库与员工电脑
分属不同系统用户（官方镜像就是这样）时无需设置。若你把服务器和员工电脑放在**同一台主机、同一个系统用户**下运行，
请把服务器端口、内容源端口（`XIONGBAO_CONTENT_PORT`）、数据库端口等设进 `COMPUTER_FORWARD_DENY_PORTS`（逗号分隔，不设默认值），
这些端口就一律不会被转发。

**共享模式下转发分不出员工。** 若关闭「每员工独立系统用户」（共享模式），所有员工的程序都跑在同一个系统用户下，
按系统用户判断就分不出是哪位员工的程序，一位员工的交付可能把另一位员工的端口转给看交付的人。官方镜像默认开启独立系统用户，
建议保持默认开启；确需共享模式时，不要对不信任的员工开放程序转发。

**不带范围的打开可以打开该员工座位上任意本机端口。** 打开自己有权使用的员工时，若请求不带对话运行或交付卡范围，
服务器只确认你能使用这位员工，不要求端口出现在交付里；它的能力与让该员工自己去访问那个端口相当。界面不走这条路，
只在员工座位由多人共用时需要留意。

**多副本部署需要会话粘滞。** 对话里「本轮产物」清单靠一轮开始时在电脑上记的快照标记，标记存在处理这条对话的服务器进程的内存里。
默认由服务器自己执行电脑工具，整轮在一个副本上完成，不受影响；若关闭 `XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS`，
由页面逐个执行电脑工具，同一轮的各个请求落到不同副本时这一轮不会有产物清单，所以多副本请按对话粘滞到同一副本。

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

群组合一（第 6.1 节）的 0206、0207、0211、0212 随镜像迁移：内嵌库启动时自动执行，外接库照本节先用新 digest 跑迁移、再重建 API 容器。

## 5. 品牌与模型配置

发布镜像在构建期内置 `examples/xiongbao` 品牌包。SPA 首屏标题与主 JS 品牌在构建期注入，
只设置运行期 TENANT_PACKAGE_DIR 不会重写 bundle；换品牌包需要按附录从源码构建。
推广条默认关闭（只有 `OPENBOT_SELF_HOST_BANNER=true` 且租户包配了 `support_url` 才显示），这里保留 `=false` 只是显式声明。

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

**DeepSeek 的思考模式默认开着（期三）。** `OPENAI_BASE_URL` 指向 `https://api.deepseek.com`（或员工在模型库、
平台体验模型里绑定 DeepSeek 官方地址）时，员工先想再做：思考内容随对话流出、存进这一轮的记录，带工具的多步
对话按 DeepSeek 的规则把思考传回去，不会再被拒（400）。代价是 token 用量和等待时间上升。

```dotenv
# 全部员工关闭思考模式（路由、起标题这类辅助请求本来就不思考）
DEEPSEEK_THINKING=disabled
```

员工设置里没有「思考模式」开关，所有员工一律开着；要全关只能用上面的 `DEEPSEEK_THINKING=disabled`。`PATCH /api/agents/<id>` 和创建员工时带的 `thinking` 字段会被接受但忽略，员工资料里也不再返回它。
`DEEPSEEK_THINKING=enabled` 只多一件事：辅助请求也按 DeepSeek 自己的默认思考。别的模型供应商不受这个开关影响。
改完同样要重新创建容器。

**AIHUB 中转（OpenAI 兼容）。** 模型库的提供方里有「AIHUB 中转」，接口地址留空时用 `https://aihubcc.cc/v1`，密钥填中转站发的 `sk-` 开头的密钥。员工要调工具，模型只能选 `gemini-4-argon` 或 `gemini-4-hydrogen`；带 `-app` 后缀的版本不支持工具调用，选了员工用不了电脑上的工具。其中 `gemini-4-argon` 的上下文按 1M 计，`gemini-4-hydrogen` 中转站文档没写，需要在模型库里手动填上限。思考内容经 `reasoning_content` 返回。2026-11-23 用 `gemini-4-argon`、`gemini-4-hydrogen` 和真实密钥实测（能力冒烟 `code`、`edit-grep` 通过），多步工具调用在思考模式下正常，不需要回传思考内容，也没有为它加补丁。

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

### 5.2 能力资源与其降级说明

镜像内置的品牌包随带 28 名员工、3 支专家团和 109 条技能，外加 3 个连接器声明（github / TAPD /
腾讯文档）。**技能分三档，徽章在「能力与资源 → 我的」页上**：

| 档位 | 徽章 | 运维含义 |
| --- | --- | --- |
| `full` | 完整可用 | 正文没有引用本环境不可执行的工具形态，声明即可用。 |
| `degraded` | 部分可用 | 两种成因：正文引用了 file-tool 类工具，装载时已改写到 `computer_read_file` / `computer_write_file` 或插入环境事实段；或正文引用了没随包附上的附件（`references/` 里被拒的文件、`assets/`、`scripts/`）。功能主体可用，按正文走会撞到缺文件；缺什么记在 `_porting.reason_ref`。 |
| `blocked` | 暂不可用 | 正文真的要跑本地命令 / 调脚本 / 引用平台私有身份。**这不是故障，也不需要运维动作**：openbot 员工没有本地 shell，系统不做 shim，只在正文保留调用证据并插入降级说明。有人问"这个技能为什么用不了"时，答案在这里。 |

每条 blocked 的判定原因（原文 + 行号 + 规则）见品牌包随带的
`docs/porting/tool-ref-audit.md`——那是对外解释"为什么 109 条里只有 64 条开箱即用"的唯一可信答案。
**不要把"暂不可用"当成待修故障上报**：档位由静态审计判定，修复它意味着改写技能正文或给员工接上
对应连接器，而不是重启或重装。

**连接器的「待绑定」状态**：品牌包只声明连接器（服务行 + `credential_env` 名），**从不携带凭据，
也从不自动授予**。装包后连接器显示「待绑定」是预期状态；管理员在连接页绑定凭据、刷新工具清单、
再给员工授予之后，对应工具才可用。github 声明为逐用户 OAuth（每人自己授权），TAPD / 腾讯文档为
部署级共享凭据（环境变量 `TAPD_MCP_CREDENTIAL_ID` / `TENCENT_DOCS_MCP_CREDENTIAL_ID` 指向凭据，
由同步在启动时绑定）。包内技能不因声明了工具而多给任何授权——能调什么始终由员工的授予决定。

升级换包时，同步只回收本包声明集合内的行（技能、频道、团队、连接器服务行），管理员手工添加的
连接器与授予不受影响。

### 5.3 生成图片、视频和文档

员工有三件新工具：`generate_image` 出图，`generate_video` 出视频（视频要几分钟，没等到会给任务号，
员工再用 `check_video` 取）。每位员工默认都有，员工的工具权限里拒绝 `bot/generate_image`、
`bot/generate_video` 即可关掉（关掉视频，`check_video` 一起不给）。

**生成服务走通用接口，按环境变量配置，不写死哪一家**：

| 变量 | 说明 |
| --- | --- |
| `XIONGBAO_IMAGE_BASE_URL`、`XIONGBAO_IMAGE_API_KEY`、`XIONGBAO_IMAGE_MODEL` | OpenAI 兼容的 `POST {BASE_URL}/images/generations`。 |
| `XIONGBAO_VIDEO_BASE_URL`、`XIONGBAO_VIDEO_API_KEY`、`XIONGBAO_VIDEO_MODEL` | 视频服务的地址、密钥、模型。 |
| `XIONGBAO_VIDEO_PROVIDER` | 视频接口形状：`openai-compatible`（默认，OpenAI 的 `/videos` 建任务、`/videos/{id}` 查、`/videos/{id}/content` 取）或 `zhipu`（智谱的 `/videos/generations` 与 `/async-result/{id}`）。 |

三项缺一项，工具不报错，只告诉员工还没有配置、缺哪几项。出站请求和模型库的自定义地址同一道校验
（不连内网地址、不跟随重定向）。服务器要能连到所填的地址，和服务回答里的图片、视频下载地址。

智谱开放平台的免费模型可以作为起步：在 open.bigmodel.cn 注册，控制台「API Keys」新建密钥，然后

```dotenv
XIONGBAO_IMAGE_BASE_URL=https://open.bigmodel.cn/api/paas/v4
XIONGBAO_IMAGE_API_KEY=<智谱密钥>
XIONGBAO_IMAGE_MODEL=cogview-3-flash
XIONGBAO_VIDEO_PROVIDER=zhipu
XIONGBAO_VIDEO_BASE_URL=https://open.bigmodel.cn/api/paas/v4
XIONGBAO_VIDEO_API_KEY=<智谱密钥>
XIONGBAO_VIDEO_MODEL=cogvideox-flash
```

免费型号和额度以智谱当前的定价页为准。其它兼容 OpenAI 图片接口的服务（硅基流动、通义的兼容模式、
各类网关）同样只填地址、密钥和模型名。

**生成的文件存在本部署的数据库里**（表 `generated_media`，迁移 0230，单个最大 50 MB），地址是
`/api/media/<id>`，只有生成时那一轮的那个人登录后能打开；对话里员工用 markdown 图片写法把图片放出来。
每次生成在审计里记一条「生成图片或视频」（`media.generated`），带员工、种类、服务、模型和张数。

**文档类文件（Word、Excel、PPT、PDF）在员工的电脑工作区里生成。** 两个镜像都装了 python-docx、openpyxl、
python-pptx、reportlab、weasyprint、pypdf、pdfplumber、pandas、markitdown（把 PDF、Office、HTML 转成 markdown）、
pandoc 和中文字体（Noto CJK、文泉驿微米黑）；单镜像另装 LibreOffice 无界面版，用来把 Word、Excel、PPT
转成 PDF。镜像构建时和 CI 都会跑 `/opt/docs-toolchain/selfcheck.py`，生成带中文的各类文件再读回来。
自己排查时可以在容器里以 pwuser 运行：

```bash
docker exec -u pwuser <容器> python3 /opt/docs-toolchain/selfcheck.py --require-pandoc --require-soffice
```

### 5.4 联网搜索、读网页与爬网站

每位员工默认有三个联网工具（员工权限里可以逐个关掉，规则写 `bot/web_search`、`bot/web_fetch`、`bot/web_crawl`）：

| 工具 | 做什么 | 依赖 |
| --- | --- | --- |
| `web_search` | 搜公开网页，返回标题、网址、摘要 | 搜索提供方，默认自建的 SearXNG（`XIONGBAO_SEARCH_URL`） |
| `web_fetch` | 读一个网页的正文，转成 Markdown；`render_js` 为真时先渲染 JS | 不依赖服务；`render_js` 用 Crawl4AI（`XIONGBAO_CRAWL_URL`），没有就按普通方式读 |
| `web_crawl` | 从一个网址起爬同一网站的多页，只回每页摘要，全文存档两小时供 `web_fetch` 读 | 有 Crawl4AI 交给它深度爬取，没有就在服务进程里做简易爬取（只抓静态 HTML） |

**Compose 形态默认带 SearXNG**（`searxng` 服务，镜像 `searxng/searxng:2026.11.2-cccbc9e15`，设置在
`docker/searxng/settings.yml`），应用容器的 `XIONGBAO_SEARCH_URL` 默认指向 `http://searxng:8080`，`up -d` 即可用。
SearXNG 不对外发布端口，它的限流器关着（那是给公网实例防爬虫的，要 Valkey），调用频率由服务端限在全部署每秒
最多两次搜索。

**Crawl4AI 按需打开**（`crawl4ai` 服务，`crawl` profile，镜像 `unclecode/crawl4ai:0.9.5`，有几个 GB）：

```bash
printf '\nXIONGBAO_CRAWL_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env.delivery
docker compose --project-name xiongbao-local --env-file .env.delivery \
  -f docker/compose.delivery.yml --profile crawl up -d
```

同一个令牌同时给 Crawl4AI（`CRAWL4AI_API_TOKEN`）和应用（`XIONGBAO_CRAWL_TOKEN`）。没设令牌时 Crawl4AI 只绑它自己的回环，
应用连不上，员工自动退回进程内抓取，不报错。

**单容器部署默认不带 SearXNG**：`web_search` 会回答「本部署没有配置搜索服务（未配置搜索）」，员工改用浏览器搜索或如实说明没能
联网核对；`web_fetch` 和 `web_crawl` 照常可用（进程内抓取）。要打开搜索，另起一个 SearXNG（设置照抄
`docker/searxng/settings.yml`，`search.formats` 必须含 `json`），在 `.env.delivery` 写 `XIONGBAO_SEARCH_URL=http://<它的地址>:8080`，
重启应用容器。Crawl4AI 同理：写 `XIONGBAO_CRAWL_URL` 和 `XIONGBAO_CRAWL_TOKEN`。

**安全边界**：`web_fetch`、`web_crawl` 的地址由模型给，每一跳都过出站校验（只许 http/https；回环、私网、链路本地、云元数据地址
一律拒；DNS 解析结果逐个判；重定向每一跳重判）。交给 Crawl4AI 的只有校验过的公网地址，它交回的页面再按地址判一遍；爬取中途发现
的链接由 Crawl4AI 自己请求，靠它自带的出站校验（`CRAWL4AI_ALLOW_INTERNAL_URLS=false`）拦内网。爬取默认遵守 robots.txt、同一网站
每秒最多一个请求、User-Agent 固定为 `XiongbaoBot/1.0`，单次爬取最多 50 页、3 层、120 秒、20 MB。

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
停旧容器用 `docker stop`（单容器加 `--time 30`；Compose 的开发文件已给 server 设 `stop_grace_period: 30s`），
不要用 `docker rm -f`：它直接 SIGKILL，服务端来不及收尾。微信 ClawBot 的消息按「至多一次」处理：
关停时在跑的那一轮最多再等 7 秒，被强杀或被中止的那一轮不会重来，用户要在微信里再发一次。
一旦有 schema 迁移，回滚镜像不一定足够，必要时恢复备份；不要把只回滚代码当成数据库回滚。

### 6.1 群组合一升级须知

这一版把「群组」和「群聊」合成一个：侧边栏只剩「群组」，群组里可以直接聊天。已有数据由开机任务自动转换。

1. **迁移自动执行**：0206、0207、0211、0212 随新镜像应用。内嵌库每次启动自动跑迁移；外接库照第 4 节先用新 digest 跑迁移，再重建 API 容器。
2. **先备份**，照本节上面的做法。升级后首次启动，服务端日志里会出现一行 `{"type":"waker-group-upgrade",…}` 汇总，记下转换（`converted`）和补挂（`backfilled`）的数量。
   - 开机任务在后台执行，不挡健康检查；多副本时只有一个副本真正执行；已经处理过的不再重做。
   - 单项失败记一行 `waker-group-upgrade-item-failed`（附群组或频道 id 和原因），其余项照常处理。
3. **推迟转换**：在 env 文件里设 `XIONGBAO_GROUP_UPGRADE=off` 再启动，开机任务整个跳过（默认开）。之后去掉这一行再重启即可。
4. **用户能看到的变化**：
   - 侧边栏「群组」里，原来的群聊和群组合成一个列表。
   - 原来有 2–20 位员工的群组变成可以聊天的群组，名字、员工、顺序、头像、流程都不变。转出来的聊天是空的，会一次性出现在「会话」列表顶部。
   - 所有者已经用不了的员工不算在内。剩下不足 2 位的标「待补成员」，超过 20 位的标「待调整成员（超过 20 位）」，这两种群组的成员名单都不改动；补够或减到 2–20 位后自动开始聊天。转换出来的群组里，所有者用不了的员工不进聊天，群组自己的成员名单不变。所有者已被停用或没有任何角色的群组不转换（`no_owner`）。
   - 原来有 2 位以上员工的群聊各补挂一个群组。没有任何人类成员的老共享群聊没有人可以接手，补挂时会被软删，并记一行 `waker-group-upgrade-chat-dropped`；回滚手册不还原它。所有者已有同名群组时，补挂的名字加「（2）」。
   - 同名的老群聊和转出来的群组会同时存在，不自动合并，可以自行解散其中一个。
   - 装包带来的频道（`package_id` 非空，如专家团队）不是群组：不挂群组，也不补建。
   - 已经停用的人会离开他所在的共享群组，他创建的群组连同头像、流程、运行记录、看板任务卡交给群里最早加入的在籍成员。之后再停用的人也一样，账号恢复后不还，要重新邀请。
5. **0207 建三个索引**：`channel_memberships (user_id)`、`channels (created_by)`（共享群）、`users (lower(email))`。建索引期间这三张表的写入会短暂等待。表很大的外接库，可以在升级前先用 `CREATE INDEX CONCURRENTLY IF NOT EXISTS` 以同样的名字建好，0207 会跳过。
6. **旧链接**照旧可用：`/bots?tab=groups` 打开「我建的群组」；`/wakers?tab=groups` 仍带到这里；`/group/new` 打开「新建群组」；`/group/<id>`、`/pipelines`、`/tasks?crew=…`、`/tasks?group=…` 不变。
7. **0207 的停用触发器换回旧镜像后仍然有效。** 它是数据库对象，不随代码回退。停用照样会把人移出他所在的所有共享群，照样把他创建的群组连同流程、运行记录、看板卡移交给最早的在籍成员，旧代码对此一无所知；移交没有数据回滚手段。回滚期间要停掉它，按第 6.2 节第一步执行。
8. **回滚**：换回上一版 digest 即可让代码回退，见第 6.2 节。需要撤销自动转换的，按第 6.2 节第二步执行，或者恢复备份。
9. **设备端**：不涉及，设备端不读写群组。

### 6.2 群组合一回滚手册

**代码回退**：换回上一版 digest（第 7 节）。0206、0207、0211 都是新增，旧代码不读新列、新表、新函数，留在库里无害。0212 只收紧台账表的列权限，不需要数据回滚：换回不含 0211、0212 的镜像后，台账表和它的权限留在库里，无害。唯一的例外是 0207 的停用触发器，见第一步。

以下语句都用迁移属主账号执行（应用账号没有权限）。单容器内嵌库这样进入：

```bash
docker exec -it xiongbao-local sh -c \
  'url=$(cat /run/s6/container_environment/MIGRATION_DATABASE_URL); exec /usr/lib/postgresql/16/bin/psql "$url"'
```

外接库用第 4 节 `.env.migration` 里的 owner 串连接。

**第一步：停用 0207 的停用触发器。** 这一步单独做，与第二步的数据回滚无关，换回旧镜像时就做。下面这段先自动核对这张表上只有 0207 建的那一个触发器，多出别的就报错停下，不会停用任何东西；核对通过才停用：

```sql
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.revoked_access'::regclass AND NOT tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'public.revoked_access 上的用户触发器不是恰好一个，先查清楚再停用';
  END IF;
  EXECUTE 'ALTER TABLE public.revoked_access DISABLE TRIGGER USER';
END
$$;
```

- 停用期间，被停用的人不再离开共享群，他创建的群也不移交，回到 0207 之前的行为。
- 之后重新升级到含 0207 的版本时，迁移不会重跑，要由属主手动恢复：先把上面那段 `DO` 里的 `DISABLE` 换成 `ENABLE` 执行一次（同样先核对只有一个触发器），再把 0207 迁移文件（镜像内 `/app/server/recovery/recovery-20261018-v1/sql/0207_team_channel_hand_over.sql`）最后一段 `DO $$ … $$` 原样执行一次。这一段对每个已停用的人补做一次离开与移交，可以重复执行，用来补上停用期间停用的人。

**第二步：撤销自动转换（需要时才做）。** 整段原样执行，它自己开、关事务：

- 开头那条查询列出**已经被移交过的转换群组**：群组 id、原所有者、现所有者、频道 id。这些不回滚，把输出存档。
- 后面在同一个事务里做三件事：
  1. 软删转换出来、至今没人用过的聊天，并把转换时被筛掉的员工补回群组的成员名单（接在现有成员后面）。
  2. 删除补挂出来、至今没人用过的群组。老群聊随之解挂，聊天本身不动。
  3. 清空台账。

<!-- group-upgrade-rollback:start -->
```sql
BEGIN;
SELECT set_config('app.tenant_id', 'platform', true);

-- 已经被移交过的转换群组：不回滚，只记录。把这条查询的输出存档。
SELECT l.group_id, l.original_owner, g.tenant_id AS current_owner, l.channel_id
  FROM waker_group_upgrades l
  JOIN waker_groups g ON g.id = l.group_id
 WHERE l.outcome = 'converted' AND g.tenant_id <> l.original_owner
 ORDER BY l.group_id;

-- 1. 转换出来的聊天：台账记的频道仍未删除、仍挂着这个群组、没有任何消息，群组也没被移交过。
--    软删它，并把被筛掉的员工补回成员名单。
WITH undone AS (
  UPDATE channels c SET deleted_at = now(), updated_at = now()
    FROM waker_group_upgrades l
    JOIN waker_groups g ON g.id = l.group_id
   WHERE l.outcome = 'converted'
     AND c.id = l.channel_id
     AND c.deleted_at IS NULL
     AND c.waker_group_id = l.group_id
     AND g.tenant_id = l.original_owner
     AND NOT EXISTS (SELECT 1 FROM group_messages m WHERE m.channel_id = c.id)
  RETURNING l.group_id, l.dropped_agent_ids
)
INSERT INTO waker_group_members (group_id, agent_id, position)
SELECT u.group_id, d.agent_id,
       ((SELECT coalesce(max(CASE WHEN p.position ~ '^[0-9]{1,9}$' THEN p.position::int END), -1)
           FROM waker_group_members p WHERE p.group_id = u.group_id) + d.n)::text
  FROM undone u
 CROSS JOIN LATERAL unnest(u.dropped_agent_ids) WITH ORDINALITY AS d(agent_id, n)
ON CONFLICT (group_id, agent_id) DO NOTHING;

-- 2. 补挂出来的群组：没有组团流程模板、没有头像、也没有任何运行记录。删除它，老群聊随外键解挂。
DELETE FROM waker_groups g
 USING waker_group_upgrades l
 WHERE l.group_id = g.id
   AND l.outcome = 'backfilled'
   AND NOT EXISTS (SELECT 1 FROM group_task_templates t WHERE t.group_id = g.id)
   AND NOT EXISTS (SELECT 1 FROM portraits p WHERE p.subject_kind = 'group' AND p.subject_id = g.id::text)
   AND NOT EXISTS (SELECT 1 FROM group_task_runs r WHERE r.group_id = g.id);

-- 3. 清空台账。
DELETE FROM waker_group_upgrades;
COMMIT;
```
<!-- group-upgrade-rollback:end -->

不回滚的情况和原因：

- **有消息或已经被用过的不回滚**：转换出来的聊天有了消息，补挂的群组有了流程模板、头像或运行记录，都说明用户已经在用，回滚会丢掉他的东西。删模板会保留运行记录（运行的模板 id 置空），删群组却会连运行记录一起删，所以第 2 步单独查运行记录，「没有模板」不等于「没用过」。
- **已经被移交过的转换群组不回滚，只由开头的查询记录**：群组现在的所有者不是台账上的原所有者。这种群组的聊天即使没有消息，软删之后群组也会留在接手人名下，原所有者再也找不回它。
- **台账记的聊天已经删除、不再挂着这个群组，或者台账没记聊天的，第 1 步都跳过**：转换途中用户自己给群组开了聊天时，群组挂着用户的聊天，台账记的是转换建的那个（已软删或留着）或者空，用户的聊天不能当成转换建的删掉。
- 第 2、3 步对被移交过的群组照常判断：按群组 id 查模板、头像、运行记录，不看所有者。
- 未完成的转换（台账 `started`）和保留为群组的（`pending_members`、`too_many`、`no_owner`）只清台账，群组和聊天都不动。
- 回滚之后再升级：第 1 步软删的聊天仍挂着原群组，开机任务不会再转换这些群组，它们显示为「未开始聊天」，用户可以自己开始聊天；第 2 步删掉群组的老群聊会被重新补挂。

全量回退仍然是恢复备份（本节开头）。

## 7. 版本固定与来源校验

每个 GitHub Release 附带 `container-images.json`，记录该标签发布时经过 Gate 1 验证的 digest。
部署和升级使用 digest，而不是可移动的标签；部署前可校验镜像由本仓库的发布流程构建。

```bash
OPENBOT_TAG=v0.2.13
gh release download "$OPENBOT_TAG" -R canquedehuiyi-cpu/xiongbaowork --pattern container-images.json
OPENBOT_IMAGE="$(jq -r .images.openbot.reference container-images.json)"
gh attestation verify "oci://$OPENBOT_IMAGE" -R canquedehuiyi-cpu/xiongbaowork
docker pull "$OPENBOT_IMAGE"
docker image inspect "$OPENBOT_IMAGE" --format '{{json .RepoDigests}}'
```

`reference` 形如 `ghcr.io/canquedehuiyi-cpu/xiongbaowork@sha256:<64 位十六进制>`；
按标签拉取后 `RepoDigests` 应包含同一个引用。`gh attestation verify` 需要已登录的 GitHub CLI。

### 7.1 从京东云镜像仓库拉取（国内服务器）

服务器从 GHCR 拉镜像很慢（约 24KB/s）时，用发布流程同步到京东云容器镜像仓库（JCR）的那份。

1. 在 JCR 控制台建注册表和仓库，再建一个只有该注册表 JCR 权限（取令牌、推送、拉取）的子账号和 AccessKey。
2. 在 GitHub 仓库的 `release` Environment 里填 2 个 secret 和 4 个变量：

   | 类型 | 名称 | 值 |
   | --- | --- | --- |
   | 变量 | `XB_REGISTRY` | 注册表 URI，如 `xiongbao-work-cn-north-1.jcr.service.jdcloud.com` |
   | 变量 | `XB_IMAGE_REPOSITORY` | 仓库名（小写） |
   | 变量 | `XB_JDCLOUD_REGION` | `cn-north-1` |
   | 变量 | `XB_JDCLOUD_REGISTRY_NAME` | 注册表名，如 `xiongbao-work` |
   | secret | `XB_JDCLOUD_ACCESS_KEY_ID` | 子账号 AccessKey ID |
   | secret | `XB_JDCLOUD_SECRET_ACCESS_KEY` | 子账号 AccessKey Secret |

   此后每次发布自动同步。京东云的登录令牌只有几小时有效，所以仓库里不存固定密码，发布时用 AccessKey 换两小时的临时令牌。
3. 补同步已发布的旧版本：在 GitHub 的 Actions 里从 `main` 运行「补同步镜像到自有仓库」，填版本标签（如 `v0.2.15`）。步骤摘要里写着目标引用和平台清单 digest。
4. 服务器拉取。JCR 拉取也要先登录：在京东云控制台该注册表页面点「获取临时令牌」，复制它给出的 `docker login` 命令在服务器上执行（令牌 12 小时有效，足够一次部署）；然后按 digest 拉取，digest 用步骤摘要里的平台清单 digest：

```bash
docker pull xiongbao-work-cn-north-1.jcr.service.jdcloud.com/<仓库名>@sha256:<平台清单 digest>
```

长期不登录就要自动拉取的服务器（定时升级之类），需要在服务器上定期用只有拉取权限的子账号重新取令牌并 `docker login`；令牌最长 24 小时，不能一次登录管到底。

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
不能作为交付验收证据。从仓库根进入 `xiongbao/`：

```bash
docker build --build-arg TENANT_PACKAGE_DIR=../examples/xiongbao \
  -f Dockerfile -t xiongbao-digital-employee:local .
```

品牌包必须在 build context 内（这里是 `xiongbao/`）；相对路径以 server 为基准。
自定义包要同时配置构建参数和运行期 TENANT_PACKAGE_DIR。之后把上文命令中的镜像换成
`xiongbao-digital-employee:local`（单容器跳过 `docker pull`）；Compose 未设置 `OPENBOT_IMAGE` 时默认使用这个本机标签。
