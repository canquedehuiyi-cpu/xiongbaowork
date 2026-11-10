# 熊宝数字员工

熊宝数字员工把对话、数字员工、小组协作、自主工作和任务看板放在同一个工作空间中。
这是基于 CopilotKit OpenBot 开发的私有化版本：账号、对话、任务与审计数据存入自己的 PostgreSQL，
模型由部署方或用户接入。当前目标是 v0.1；浏览器执行、真实模型成功路径及完整发布验收以验收记录为准。

正式部署拉取已发布镜像 `ghcr.io/canquedehuiyi-cpu/xiongbaowork:<标签>`，不需要克隆源码或本机构建。
每个发布的 GitHub Release 附带 `container-images.json`，记录该标签对应的镜像 digest。
镜像在 GHCR 设为公开之前，未登录的 `docker pull` 会被拒绝；在此之前请向交付方确认镜像已公开。

源码位于 `openbot/`。本仓库的交付路径是 Docker 镜像；Windows 使用 Docker Desktop 的 Linux 容器。
开发环境、历史走查记录与交付部署分别见[部署手册](openbot/docs/deployment-qoderwake.md)、
[开发环境笔记](openbot/docs/development-environment-qoderwake.md)、[B 线验证记录](openbot/docs/track-b-delivery-evidence.md)。

![镜像首次启动的本机入口](openbot/docs/images/delivery-first-start.png)

这是未接入模型时的首次启动实测。当前界面中文化和标签页标题的验收状态见
[部署验收记录](openbot/docs/delivery-acceptance-2026-10-09.md)。

## Linux 快速上手

需要 Bash、Docker Engine、curl 和 OpenSSL；不需要 Git、GitHub 账号或 Bun。
WSL 使用 Docker Desktop 时先启用该发行版的 WSL Integration，并确认 `docker version` 同时显示 Client / Server。
在一个新建的空目录中执行下面的命令。它拉取发布镜像、下载同一标签的配置模板、生成随机密钥，
只在本机开放 `127.0.0.1:3772`，不配置模型密钥。换版本时先设置 `OPENBOT_TAG=<发布标签>`。
这段命令在每次发布后由 CI 原样执行（Gate 7 Linux：干净机器、未登录 GHCR）。

<!-- g7:linux:begin -->
```bash
OPENBOT_TAG=${OPENBOT_TAG:-v0.2.7}
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
`.env.delivery` 中的 `KEY_ENCRYPTION_KEY` 必须与数据卷一起保留；重复执行上面的命令不会覆盖它；重复执行前先 `docker rm -f xiongbao-local`（命名卷保留）。
模型尚未接入时不能把“页面可打开”当作“对话已可用”；模型接入见部署手册。
按 digest 固定版本、校验镜像来源和升级见[部署手册](openbot/docs/deployment-qoderwake.md)。

## Windows Docker Desktop 快速上手

先启动 Docker Desktop，切换到 Linux containers；以下在 PowerShell 的一个新建空目录中执行。
不用安装 Git、Bun，也不用重建其他项目的 Compose 栈。确认 `docker version` 同时显示 Client / Server。
这段命令目前由人工验收（Gate 7 Windows 一半），CI 只检查其内容不含源码构建步骤。

<!-- g7:windows:begin -->
```powershell
$OpenbotTag = if ($env:OPENBOT_TAG) { $env:OPENBOT_TAG } else { 'v0.2.7' }
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
Windows 原生 Bun 在服务端依赖导入链上会挂死；服务端开发与测试使用 Linux/WSL 或容器。

## 配置参考与排障

| 配置 | 用途 |
| --- | --- |
| `KEY_ENCRYPTION_KEY` | 32 字节随机密钥的 base64；升级、恢复时保留同一份 |
| `EMBEDDED_POSTGRES` | `on` 使用持久化内嵌数据库；`off` 使用外接数据库 |
| `DATABASE_URL` | API 运行期非超级用户连接串，角色不能有 `BYPASSRLS` |
| `MIGRATION_DATABASE_URL` | 仅迁移用 owner 串；内嵌数据库由启动脚本产生 |
| `TENANT_PACKAGE_DIR` | 镜像构建期默认 `../examples/qoderwake`；运行期换包不改变已构建 SPA |
| `OPENBOT_RLS_ENFORCE` | 镜像默认 `refuse`；不接受超级用户作为 API 角色 |
| `OPENBOT_SELF_HOST_BANNER` | 镜像默认 `false` |
| `OPENBOT_SINGLE_USER` | 本机体验用 `true`；对外部署用 `false` 并配置登录 |
| `OPENBOT_PUBLIC_URL` | 用户实际访问的地址；本机体验为 `http://localhost:3772` |
| `BOT_MODEL` / `OPENAI_BASE_URL` | 兼容 OpenAI 接口的模型名及 API 地址；名称必须来自供应商当前目录 |

完整配置、登录、Compose、外接数据库、备份与升级见[部署手册](openbot/docs/deployment-qoderwake.md)。

三条配置坑：模型名用 **BOT_MODEL**（`OPENAI_MODEL` 全仓没有读取代码）；
运行期数据库串必须是**非超级用户、无 BYPASSRLS**；
Windows 宿主不能直接 `bun` 起 server，交付路径是**镜像或 Linux/WSL**。

| 现象 | 处理 |
| --- | --- |
| 健康检查没返回 200 | `docker logs xiongbao-local`，检查迁移、密钥、登录配置和端口占用 |
| `docker pull` 报 denied / unauthorized | 镜像尚未在 GHCR 公开，或标签拼写错误；核对 Release 中的标签 |
| 日志出现 `rls-not-enforced` 并退出 | 改用非超级用户、无 BYPASSRLS 的运行期连接串；owner 只做迁移 |
| 页面可打开但模型报错 | 核对 `BOT_MODEL`、兼容 API 地址及模型授权；修改后重建容器读取配置 |
| 换品牌包后页面仍是旧品牌 | SPA 品牌在构建期注入，按附录从源码构建并更换镜像 |
| 本机端口 3772 被占用 | 更改宿主映射和 `OPENBOT_PUBLIC_URL`，内部端口仍为 3001 |
| Windows 宿主 server 无输出 | 使用镜像或 Linux/WSL，详见开发环境笔记 |

停止体验容器可执行 `docker rm -f xiongbao-local`；命名卷仍然保留。
备份前不要删除数据库卷，升级时不要使用 `docker compose down -v`。

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

## 与上游及许可的关系

上游项目是 [CopilotKit OpenBot](https://github.com/CopilotKit/OpenBot)。本仓库在其基础上增加
熊宝品牌、任务看板、数字员工与租户能力；不表示由 CopilotKit 提供官方托管或商业支持。
上游源码与原始说明保留在 `openbot/`，根 `.github/workflows/ci.yml` 是本 fork 实际执行的 CI。
上游 `openbot/.github/workflows/` 保留用于同步。

代码沿用 [MIT 许可](openbot/LICENSE)，保留 `Copyright (c) 2026 CopilotKit` 与许可文本。
第三方依赖、品牌素材和模型服务的许可或服务条款各自适用。
