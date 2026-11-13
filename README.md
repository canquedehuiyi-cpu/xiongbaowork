# 熊宝数字员工

熊宝数字员工是一套可以私有化部署的「数字员工」工作空间。你在网页上和员工对话、把几位员工拉进一个群一起干活、
给它们排定时任务和长期职责；员工可以用你授权的应用（邮箱、日历、网盘、GitHub 等），也可以在你配对的电脑上
操作浏览器和本机应用。付款、改密码、对外发布这类事，员工只会停下来交给你本人。

账号、对话、任务和审计记录都存在你自己的 PostgreSQL 里；模型由部署方接入（兼容 OpenAI 接口的服务都可以，
已实测 DeepSeek）。交付物是一个 Docker 镜像和一个设备端安装包，不需要克隆源码。

| 交付物 | 当前版本 | 获取方式 |
| --- | --- | --- |
| 服务端镜像 | `v0.2.10` | `ghcr.io/canquedehuiyi-cpu/xiongbaowork:v0.2.10`，每个 Release 附 `container-images.json` 记录镜像 digest |
| 设备端（Windows / Linux） | `device-v0.2.4-rc.1`（未签名内测版） | GitHub Releases 中「熊宝数字员工 设备端」，附 `SHA256SUMS` |

## 能做什么

**员工与对话**

- **员工**：每位员工有自己的名字、头像、工作手册（人设和做事方式）、技能、可用的应用、模型和定时任务。
  每个人都有一位「小管家」（我的分身），日常的事先找它。
- **单聊和群聊**：群聊里几位员工按你排的顺序依次回答；侧栏可以按「会话 · 员工 · 群组」切换，
  对话旁边的中间栏列出这位员工的对话任务和自动任务。
- **在对话里招员工、组群聊**（main 上已有，下个版本发布）：跟小管家说要什么样的员工或群，
  它起草一张卡片，你在卡片上改、按确认后才真的创建。
- **任务看板**：员工手上的事、等你处理的事、做完的事放在一块看板上。

**让员工自己干活**

- **定时任务、长期职责、主动巡检**：到点自动做，或者盯着某件事有变化就处理。
- **流水线（WakerFlow）**：把几步串起来，可以有条件、循环、动作和「等我确认」节点；支持输入参数、版本、
  失败重试，可以分享给别人导入。
- **从对话中学习**：每天读一次最近的对话，把你的习惯和偏好整理成记忆，下次照着做。

**应用与信息来源**

- **应用目录**：通过连接器提供商（Composio，可选 Arcade）或自定义 MCP 服务接入第三方应用；
  支持团队账号（管理员批准后共享使用）和一个人在同一应用上连多个账号。
- **应用权限按员工给**：每位员工能用哪些应用、哪些动作分开设置；员工缺权限时会在对话里给你一张申请卡片。
- **信息来源**：本地文件夹、笔记本、百度网盘、已连接的应用都可以作为员工的资料来源。

**员工的电脑**

- **设备端**：在你自己的电脑上装设备端并配对后，员工可以在这台电脑上用浏览器、启用和使用本机应用、
  读本地文件夹、调用本机的 MCP 服务、查看桌面（只读）；你随时能看实时画面并接管。
- **服务器上的独立电脑**：每位员工也可以在服务器上有自己的 Linux 用户和浏览器，带实时终端。

**安全底线**

- **交给本人**：付款、确认收货、改密码和验证码、分享与公开发布等动作，员工只能停下来请你自己点，
  没有「总是允许」。
- **审批与审计**：需要批准的动作进审批箱，批准后只执行一次；所有授权、审批、执行都有审计记录。
- **多租户隔离**：数据库行级安全强制开启，运行期角色不能绕过；第三方凭据加密存放，只经保险库读取。

**团队与套餐**

- 团队版有成员、管理员、角色模板和企业管控；个人版一人使用、连上的应用每位员工都能用。
- 套餐名额、模型池和 token 计量由管理员在后台配置。

## 快速上手（Linux）

需要 Bash、Docker Engine、curl 和 OpenSSL；不需要 Git、GitHub 账号或 Bun。
WSL 使用 Docker Desktop 时先启用该发行版的 WSL Integration，并确认 `docker version` 同时显示 Client / Server。
在一个新建的空目录中执行下面的命令。它拉取发布镜像、下载同一标签的配置模板、生成随机密钥，
只在本机开放 `127.0.0.1:3772`，不配置模型密钥。换版本时先设置 `OPENBOT_TAG=<发布标签>`。
这段命令在每次发布后由 CI 原样执行（干净机器、未登录 GHCR）。

<!-- g7:linux:begin -->
```bash
OPENBOT_TAG=${OPENBOT_TAG:-v0.2.10}
OPENBOT_IMAGE=${OPENBOT_IMAGE:-ghcr.io/canquedehuiyi-cpu/xiongbaowork:$OPENBOT_TAG}
docker pull "$OPENBOT_IMAGE"
if [ -e .env.delivery ]; then
  echo '保留已有 .env.delivery 及其中的 KEY_ENCRYPTION_KEY'
else
  curl --fail --silent --show-error --location -o .env.delivery \
    "https://raw.githubusercontent.com/canquedehuiyi-cpu/xiongbaowork/$OPENBOT_TAG/openbot/docker/delivery.env.example"
  chmod 600 .env.delivery
  printf '\nKEY_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" >> .env.delivery
fi
docker run -d --name xiongbao-local --env-file .env.delivery \
  -p 127.0.0.1:3772:3001 \
  -v xiongbao-local-db:/var/lib/postgresql \
  -v xiongbao-local-workspace:/workspace \
  -v xiongbao-local-profiles:/profiles \
  "$OPENBOT_IMAGE"
deadline=$((SECONDS+60))
until curl --fail --silent --max-time 2 http://127.0.0.1:3772/health; do
  if [ "$SECONDS" -ge "$deadline" ]; then docker logs xiongbao-local; exit 1; fi
  sleep 1
done
echo
```
<!-- g7:linux:end -->

浏览器打开 [本机入口](http://localhost:3772)。第一次启动会初始化数据库、运行迁移。
`.env.delivery` 中的 `KEY_ENCRYPTION_KEY` 必须与数据卷一起保留；重复执行上面的命令不会覆盖它；
重复执行前先 `docker rm -f xiongbao-local`（命名卷保留）。

能打开页面不等于能对话：还要接入模型。在 `.env.delivery` 里填上 `BOT_MODEL`、`OPENAI_BASE_URL` 和密钥，
重建容器即可，详见[部署手册](openbot/docs/deployment-xiongbao.md)第 5 节。
按 digest 固定版本、校验镜像来源、对外部署和登录配置也在部署手册里。

## 快速上手（Windows Docker Desktop）

先启动 Docker Desktop，切换到 Linux containers；以下在 PowerShell 的一个新建空目录中执行。
不用安装 Git、Bun，也不用重建其他项目的 Compose 栈。确认 `docker version` 同时显示 Client / Server。
这段命令由人工验收，CI 只检查其内容不含源码构建步骤。

<!-- g7:windows:begin -->
```powershell
$OpenbotTag = if ($env:OPENBOT_TAG) { $env:OPENBOT_TAG } else { 'v0.2.10' }
$OpenbotImage = if ($env:OPENBOT_IMAGE) { $env:OPENBOT_IMAGE } else { "ghcr.io/canquedehuiyi-cpu/xiongbaowork:$OpenbotTag" }
docker pull $OpenbotImage
if ($LASTEXITCODE -ne 0) { throw '拉取镜像失败' }
if (Test-Path .env.delivery) {
  Write-Output '保留已有 .env.delivery 及其中的 KEY_ENCRYPTION_KEY'
} else {
  Invoke-WebRequest -UseBasicParsing -OutFile .env.delivery `
    "https://raw.githubusercontent.com/canquedehuiyi-cpu/xiongbaowork/$OpenbotTag/openbot/docker/delivery.env.example"
  $keyBytes = New-Object byte[] 32
  $keyGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $keyGenerator.GetBytes($keyBytes)
  $keyGenerator.Dispose()
  Add-Content .env.delivery ('KEY_ENCRYPTION_KEY=' + [Convert]::ToBase64String($keyBytes)) -Encoding ascii
}
docker run -d --name xiongbao-local --env-file .env.delivery `
  -p 127.0.0.1:3772:3001 `
  -v xiongbao-local-db:/var/lib/postgresql `
  -v xiongbao-local-workspace:/workspace `
  -v xiongbao-local-profiles:/profiles `
  $OpenbotImage
if ($LASTEXITCODE -ne 0) { throw '启动容器失败' }
$healthReady = $false
$healthDeadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $healthDeadline) {
  try {
    $healthResponse = Invoke-WebRequest http://127.0.0.1:3772/health -UseBasicParsing -TimeoutSec 2
    $healthReady = $healthResponse.StatusCode -eq 200
  } catch { $healthReady = $false }
  if ($healthReady) { break }
  Start-Sleep -Seconds 1
}
if (!$healthReady) { docker logs xiongbao-local; throw '60 秒内未健康' }
$healthResponse.StatusCode
```
<!-- g7:windows:end -->

成功应返回 200。浏览器入口也是 [localhost:3772](http://localhost:3772)。
Git Bash 若使用 `docker -v/-w` 的绝对路径，先设置 `MSYS_NO_PATHCONV=1`。

## 安装设备端

1. 从 GitHub Releases 下载最新的「熊宝数字员工 设备端」：Windows 用 `.exe` 安装包，Linux 用 `.deb`；
   用 `SHA256SUMS` 核对下载的文件。
2. 目前是未签名的内测版，Windows 可能弹出 SmartScreen 提示，选「仍要运行」。
   减少误报的做法见[人工步骤](docs/acceptance/HUMAN-STEPS.md)第 12.7 节。
3. 在网页「设置 › 我的设备」里生成配对码，把服务器地址和配对码分别填进设备端。显示「在线」即可。
4. 设备端常驻托盘；托盘菜单里可以打开窗口、添加本地文件夹、重新启动设备端服务或退出。

## 配置参考

| 配置 | 用途 |
| --- | --- |
| `KEY_ENCRYPTION_KEY` | 32 字节随机密钥的 base64；升级、恢复时保留同一份 |
| `EMBEDDED_POSTGRES` | `on` 使用容器内的数据库；`off` 使用外接数据库 |
| `DATABASE_URL` | 运行期连接串，角色必须是非超级用户、没有 `BYPASSRLS` |
| `MIGRATION_DATABASE_URL` | 只给迁移用的 owner 连接串；内嵌数据库由启动脚本生成 |
| `BOT_MODEL` / `OPENAI_BASE_URL` | 模型名和兼容 OpenAI 接口的地址；模型名必须来自供应商当前目录 |
| `OPENBOT_PUBLIC_URL` | 用户实际访问的地址；本机体验为 `http://localhost:3772` |
| `OPENBOT_SINGLE_USER` | 本机体验用 `true`（不用登录）；对外部署用 `false` 并配置登录 |
| `OPENBOT_RLS_ENFORCE` | 镜像默认 `refuse`：发现运行期角色能绕过行级安全就拒绝启动 |
| `COMPOSIO_API_KEY` / `ARCADE_API_KEY` | 接入应用目录的连接器提供商（可选） |
| `TENANT_PACKAGE_DIR` | 品牌包目录，构建期写进网页；运行期更换不改变已构建的网页 |

完整配置见[部署手册](openbot/docs/deployment-xiongbao.md)。最常见的三个坑：
模型名用 **`BOT_MODEL`**（没有 `OPENAI_MODEL` 这个配置）；运行期数据库串必须是**非超级用户、无 BYPASSRLS**；
Windows 上不能直接用 `bun` 跑服务端，用镜像或 Linux/WSL。

## 排障

| 现象 | 处理 |
| --- | --- |
| 健康检查不返回 200 | `docker logs xiongbao-local`，检查迁移、密钥、登录配置和端口占用 |
| `docker pull` 报 denied / unauthorized | 标签拼错，或镜像还没在 GHCR 公开；核对 Release 里的标签 |
| 日志出现 `rls-not-enforced` 并退出 | 运行期改用非超级用户、无 BYPASSRLS 的连接串；owner 只做迁移 |
| 页面能开但员工回复报错 | 核对 `BOT_MODEL`、接口地址和模型授权；改完重建容器 |
| 设备端显示「已暂停自动执行」 | 有动作结果不明；到「设置 › 我的设备 › 核查并恢复」核对后恢复 |
| 换品牌包后页面还是旧品牌 | 品牌在构建期写进网页，按附录从源码构建并换镜像 |
| 端口 3772 被占用 | 改宿主映射和 `OPENBOT_PUBLIC_URL`，容器内端口仍是 3001 |

停止体验容器：`docker rm -f xiongbao-local`（命名卷保留）。升级不要用 `docker compose down -v`，
备份前不要删数据库卷；备份、恢复与升级步骤见部署手册第 6 节。

## 文档

| 文档 | 内容 |
| --- | --- |
| [部署手册](openbot/docs/deployment-xiongbao.md) | 单容器、Compose、外接数据库、登录、模型、备份升级、版本校验 |
| [CHANGELOG](openbot/CHANGELOG.md) | 每个版本改了什么、升级要不要做额外的事 |
| [人工步骤](docs/acceptance/HUMAN-STEPS.md) | 发版、签名、真机验收等需要人来做的步骤和记录 |
| [功能验收清单](docs/acceptance/STORIES.md) | 每项功能的验收状态 |
| [对话招员工](openbot/docs/staffing.md) | 小管家起草、本人确认的流程和接口 |
| [设计稿](docs/specs/) 与 [实施计划](docs/plans/) | 各功能的设计和实施记录 |

## 开发者说明

源码在 `openbot/`，保持与上游开源项目相同的目录结构，以便持续同步上游更新（同步记录见 `openbot/UPSTREAM.md`）。
本仓库实际执行的 CI 是根目录的 `.github/workflows/`。服务端开发和测试请在 Linux/WSL 或容器里进行：
Windows 原生 Bun 在服务端依赖导入链上会挂死。

## 附录：从源码构建

只有修改源码或更换构建期品牌包时才需要本机构建；客户部署使用上面的发布镜像。
需要 Git 与 Docker Buildx；构建会下载工具链、Chromium 与依赖，首次耗时取决于网络和磁盘。

```bash
git clone https://github.com/canquedehuiyi-cpu/xiongbaowork.git
cd xiongbaowork/openbot
docker build -f Dockerfile -t xiongbao-digital-employee:local .
```

之后先设置 `OPENBOT_IMAGE=xiongbao-digital-employee:local`，再执行快速上手命令中除 `docker pull` 以外的各行。
本机构建的镜像没有发布 digest 和来源证明，不能作为交付验收证据。

## 开源许可

本产品包含以 MIT 许可发布的开源代码，版权声明 `Copyright (c) 2026 CopilotKit` 与许可全文见
[openbot/LICENSE](openbot/LICENSE)。第三方依赖、品牌素材和模型服务的许可或服务条款各自适用。
