# B 线部署验收记录（2026-10-09）

本记录验收 B 所有权内的交付基础设施。共享 G2（3010/3001）、共享数据库
`openbot` / `openbot_test` 未参与；不使用真实模型凭据、不发送对话。
本轮独立实例全部使用 3772，容器和测试卷在每项结束后删除。

## 1. 全新 WSL 按 Linux 快速上手执行（DoD-8）

从 Ubuntu 24.04 官方镜像导出 rootfs，在 D 盘导入临时发行版
`XiongbaoTrackB-20261009`，不复用现有 Ubuntu 的 home、Bun、源码或数据库。
安装前没有 Git / OpenSSL / Bun；安装 Git、curl、OpenSSL 后连接现有 Docker Desktop 的 Linux engine。
Docker CLI 为 29.5.3，Git 2.43.0，OpenSSL 3.0.13。
这是干净 WSL 的产品部署验证；Docker Engine / Desktop 是前置条件，镜像基础层缓存可复用。

远端私有仓库的 B 分支新克隆耗时 10 秒；GitHub 认证是必须的前置条件。
本轮提交尚未推送时，通过 Git bundle 读取已提交的 B 增量，检出
`813564e313675f9b37a5f98e4e80ea1dc05d6019`，`git status --porcelain` 为空。
这是提交整理前的源码快照，运行文件与最终 PR 一致；最终 SHA 的构建另由 Actions 复验。

照根 README 执行复制模板、生成 32 字节 base64 密钥、docker build、docker run 和 curl 健康轮询。
只替换镜像、容器和卷名称为本轮 B 专属名称，不改变配置和端口语义：

```text
ENV seconds=0
docker build -f Dockerfile -t openbot:trackb-dod8-linux .
BUILD seconds=389
docker run ... -p 127.0.0.1:3772:3001
  -v openbot-trackb-dod8-linux-db:/var/lib/postgresql
  -v openbot-trackb-dod8-linux-workspace:/workspace
  -v openbot-trackb-dod8-linux-profiles:/profiles
{"status":"ok"}
HEALTH 200 seconds=18
PASS fresh WSL README: no host Bun, clean checkout, three new volumes,
  health 200, no RLS warnings, application ownership preserved
TOTAL seconds=412
```

完整镜像 manifest：`sha256:944f74058441a66d8a2c5d9a1c1dd9cc7b9fc9fe5e63c7171984f6b4d794d318`。
原始日志：本 worktree `.scratch/track-b/readme-linux-final.log`。
首次启动截图：[原始截图](images/delivery-first-start.png)。页面欢迎语已读到熊宝品牌，
浏览器标题仍为 OpenBot，引导页仍有英文；这些属于 C 的 WP-1.4 / WP-2.5，不能作为 DoD-2/7 通过。

## 2. Windows Docker Desktop / PowerShell

在现有 Windows Docker Desktop 主机上，从远端新克隆候选分支，读取相同已提交 B 增量；
使用三个新卷，与共享栈无关。在 Windows PowerShell 5.1.26100.9444 实际执行 README 命令，
无需宿主 Bun；UseBasicParsing 可用。

```text
POWERSHELL=5.1.26100.9444
SOURCE=813564e313675f9b37a5f98e4e80ea1dc05d6019
docker build -f Dockerfile -t openbot:trackb-dod8-windows .
BUILD seconds=421.9
Invoke-WebRequest http://127.0.0.1:3772/health -UseBasicParsing -TimeoutSec 2
200
HEALTH 200 seconds=21.2
PASS Windows PowerShell README: clean remote clone, three new volumes,
  health 200, no RLS warnings
TOTAL seconds=444.4
```

完整镜像 manifest：`sha256:b021c7f2c5f8fae302693eaf61341137db2a03872c34dea38da31c66c71c827a`。
日志：`.scratch/track-b/readme-windows.log` / `readme-windows-build.log`。
这不是一台新装 Windows 主机；DoD-8 的“没装过机器或干净 WSL”由第 1 节的全新发行版满足。

## 3. 独立 Compose

使用相同完整镜像，按部署手册的 config/up/logs/down 起法，
项目名为 `openbot-trackb-dod8-compose`，三个卷均为新卷；在 env-file 指定
`OPENBOT_IMAGE=openbot:trackb`，不使用共享开发 Compose。

```text
docker compose --project-name openbot-trackb-dod8-compose --env-file .env.delivery
  -f docker/compose.delivery.yml config --quiet
exit 0
docker compose ... up -d
COMPOSE health=200 seconds=12.2
PASS independent Compose config/up/health/logs, three new volumes, no provider credentials
docker compose ... down
container / network removed; three test volumes removed
```

日志：`.scratch/track-b/readme-compose.log` / `readme-compose-startup.log`。
12.2 秒包含 config 与 up；健康轮询在 up 后限时 60 秒。

## 4. 首次启动、崩溃恢复、旧卷升级与租户隔离

扩展 image job 的脚本使用随机密钥和自己的新卷，完成以下真实数据库与 HTTP 检查：

- 首次健康、capabilities 200 / selfHostBanner=false、无 RLS 警告。
- app 角色 `openbot_app|f|f`；两个口令文件 600；公开固定密码无法登录。
- apiuser 不能读取 owner 环境文件；所有 `/app` 文件属主为 pwuser。
- 写入仅用于验证的记录，强制终止一次性容器，重新创建并复用原卷；数据和两份口令保持。
- 模拟旧卷缺少 app 口令；保留 owner 口令，自动生成 app 口令并覆盖角色密码。
- 登录模式下注册两人；B 列表不含 A 的私有员工，按 id 读取返回 404。
- Free 档第三位员工返回 402 / quota_exceeded / used=2 / limit=2。
- 显式 owner 运行期串的容器退出 1，日志为 Refusing to serve: tenant isolation。

最终完整镜像（Windows 新克隆构建的 b021c7f2…，本地标记 openbot:trackb）
重跑 `bash scripts/ci/image-smoke.sh openbot:trackb`，实际输出：

```text
HEALTH elapsed=29s (limit 60s)
PASS wait_health ...
PASS ... sha256sum -c ...
PASS test preserved = preserved
PASS test openbot_app|f|f = openbot_app|f|f
TENANTS assertions=9 failed=0; provider calls=0
PASS test false = false
PASS test 1 -ne 0
IMAGE failed command checks=1
```

最后一个失败组是 HTML / 主 JS 的两条品牌断言，按 C 路径契约保留。
其他全部检查通过；脚本整体退出 1，没有把 C 品牌缺口判绿。
此前也用运行时补丁镜像定位并确认了修复；完整镜像复验日志为
`.scratch/track-b/image-full-final.log`，其中全目录属主检查、恢复/升级与全部租户检查通过。

## 5. 本轮发现并修复的部署问题

复用原卷时 PostgreSQL 尚在恢复，迁移提前连接导致 `57P03: the database system is starting up`，
s6 随即停容器。现在 migrate 先用 owner 做认证查询、限时等待就绪，再执行迁移与 ALTER ROLE。
强制终止后的复验日志明确出现自动恢复、完成恢复、数据库 ready、迁移成功，数据和口令断言通过。
正常停服改用 PostgreSQL 的 SIGINT fast shutdown，并已观察到完整 shutdown checkpoint。
[PostgreSQL 停服说明](https://www.postgresql.org/docs/16/server-shutdown.html)、
[s6 down-signal 定义](https://www.skarnet.org/software/s6/servicedir.html)。

冷构建的末步递归 chown /app 耗时 833.5 秒，随后导出阶段终止以换用修复后的构建。
改为 runtime COPY --chown，保留原 pwuser 属主；末步只改自动创建的顶层目录，耗时 0.9 秒。
全目录 find 属主检查为空，完整镜像可启动。
[Docker COPY 属主说明](https://docs.docker.com/reference/dockerfile/#copy---chown---chmod)。

README 补上私有仓库认证、curl/Buildx、WSL Docker 集成前提，并在 Windows 健康检查中
使用 UseBasicParsing 兼容 PowerShell 5.1。

## 6. 整体交付仍须 A/C 合入后的验证

[A/C 契约](contracts/track-b-delivery.md)列出两条品牌断言、默认包回落和测试收口期望。
本记录不把阶段 0–2 允许测试红视为 DoD-1；阶段 3 要移除 continue-on-error，
并在 main 上取得四种 job 的绿色运行。B 保留当前的严格品牌断言和基线差集报告。
