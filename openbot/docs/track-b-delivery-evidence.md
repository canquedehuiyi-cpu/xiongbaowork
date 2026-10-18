# B 线交付证据（2026-10-09）

分支 `feat/b-delivery-form`；基线 `03df9efa29cc51b64bd4a7b695dcb977ac0869f6`。
仅修改 B 所有权文件，以及明确要求的上游 README 首行和部署文档拆分。
共享 G2、共享数据库和真实模型 provider 均不参与验证。
最新状态见[部署验收记录](delivery-acceptance-2026-10-09.md)：全新 WSL、PowerShell 5.1
与独立 Compose 已完成；下面按工作包保留首次执行及远端运行的历史记录。

## WP-0.2：根工作流

问题：上游工作流在 `openbot/.github`，GitHub 不执行。

改动：根 `.github/workflows/ci.yml`，只有 static / server-test / app-test / image。
六个服务端分片各使用自己的 pgvector/pg17 service，owner 迁移、app 角色测试；
基线提交重跑相同 head 分片文件名单，独立 head/base 数据库，报告失败名称多重集差集。
阶段 0–2 测试 job 允许失败，阶段 3 移除 `continue-on-error`。
镜像脚本一次性使用 3772，trap 删除自己的容器和卷，无 provider 凭据。

证据：

```text
YAML parse: [ "static", "server-test", "app-test", "image" ]
cd openbot/scripts/ci && tools/bun/bun.exe test test-report.test.mjs
3 pass / 0 fail / 5 expect() calls
bash -n scripts/ci/{prepare-baseline,run-tests,image-smoke}.sh: exit 0
git diff --check: exit 0
```

CI 从 `openbot` 根运行测试时包含服务端 preload；Windows 本机无依赖的尝试曾报
`Cannot find package eventsource`，没有被当作绿灯。报告单元测试从独立目录跑。
远端 main Actions 与全套测试证据要在合并/运行后补齐；本地结构检查不等于 DoD-1。

## WP-1.4：构建期品牌注入

问题：SPA 生成配置发生在 build，运行期指定品牌包不能改变壳。

改动：app-build 的 `ARG TENANT_PACKAGE_DIR=../examples/qoderwake` 与对应 ENV；
运行镜像也显式指定 qoderwake，并默认 `OPENBOT_SELF_HOST_BANNER=false`。
没有改动 generate-app-config 的 fintech 回落逻辑，按用户边界交由 A/C 配合。

证据：`docker build --target app-build -f Dockerfile -t openbot:trackb-app-build .`
的 prebuild 已运行 generate:app-config，Vite 输出 `✓ built in 1m 8s`、该 RUN 层 `DONE 72.1s`。
此提交时 Docker 仍在导出镜像层，完整构建和产物断言在最终验证补齐。
`biome lint --error-on-warnings scripts/ci`：`Checked 3 files ... No fixes applied`，exit 0。

交给 A/C 的期望（PR 也列出）：

- app HTML 的首帧 title 包含 `熊宝数字员工`；生成后的主 JS 包含品牌名称。
- HTML 和主 JS 不含 `Self-host OpenBot` 字面量；运行期关闭 banner 不会移除 bundle 字面量。
- 服务端配置与 generate-app-config 未指定 TENANT_PACKAGE_DIR 时也默认 qoderwake。
- 默认模型不硬编码厂商，BOT_MODEL 的实际覆盖语义和未配置模型引导由 A/C 实现。

## WP-1.5：镜像 RLS 默认

问题：内嵌 PostgreSQL 只提供 owner 串，RLS 对超级用户不起作用；迁移的 app 密码固定。

改动：同卷保存 pgpassword / pgpassword-app 两个 600 文件，旧卷只补 app 密码。
启动导出 MIGRATION_DATABASE_URL；无显式 DATABASE_URL 时生成 openbot_app 串。
显式 owner 串保留，供 refuse 检测；迁移用临时 owner 环境，完成后 ALTER ROLE
设置随机口令、NOSUPERUSER、NOBYPASSRLS。API unset owner 变量，owner 环境文件仅 root 可读。
镜像默认 OPENBOT_RLS_ENFORCE=refuse，API finish 保存真实退出码并 halt，迁移失败也终止容器。
实现依据：[s6-overlay 官方 finish 文档](https://github.com/just-containers/s6-overlay#setting-the-exit-code-of-the-container-to-the-exit-code-of-your-main-service)。

证据：`bash -n docker/s6/scripts/{postgres-init,migrate}.sh docker/s6/s6-rc.d/api/{run,finish}`
与 `git diff --check` 都 exit 0。完整 runtime 构建在本次提交时进行中；
实际角色、固定密码拒绝、600 权限、owner 非零退出见最终验证，不能凭脚本语法宣称 DoD-3。

## WP-2.6：中文交付文档

问题：根目录无产品 README，原部署文档混合本机共享栈操作和交付步骤。

改动：根中文 README 包含 Linux / PowerShell 快速上手、配置、排障、上游关系及 MIT 许可；
交付手册放在 openbot/docs，原文完整保留为开发环境笔记，加历史共享操作禁执行说明；
原 docs/deployment-qoderwake.md 成为入口索引。上游 README 仅加引导行。
新增交付 env 模板及独立 compose.delivery.yml，不使用上游开发 Compose。

证据：

```text
docker compose --project-name xiongbao-trackb-docs --env-file .env.delivery \
  -f docker/compose.delivery.yml config --quiet: exit 0
upstream README and historic notes preserved
git diff --check: exit 0
```

上述 Compose 只做 config 解析，没有启动或写入共享服务。
干净机器 / 全新 WSL 的 DoD-8 操作记录尚未完成，本机一次性镜像验证不能代替该证据。

## WP-0.3：配置文档固定三条坑

问题：错误模型变量、owner 运行期串、Windows 宿主起服会制造“配置了却无效”的交付失败。

改动：README、部署手册与 .env.example 明确 BOT_MODEL / 非超级用户 / 镜像或 Linux/WSL；
开发模板 RLS refuse、banner=false 与镜像一致。兼容路径的 BOT_MODEL 需同时配置 OPENAI_BASE_URL，
员工绑定优先；未配置模型引导仍由 A/C 实现。真实模型名称不写死，也没有修改本机真实 .env 或重启共享栈。

证据：`rg -n OPENAI_MODEL openbot/server/src openbot/app/src openbot/scripts` 无命中；
当前 `server/src/copilot.ts` 的 runtimeModelForEnvironment 读取 BOT_MODEL，
兼容 OpenAI 的 selectedModelApplies 条件要求 OPENAI_BASE_URL。

## 最终本地验证

```text
docker build --target app-build ... : exit 0
docker build -f Dockerfile -t openbot:trackb . : exit 0
runtime manifest: sha256:5257dbf2334e91f27aad9a0f1e22826b6292dbe8518698d092ac4e1db6113813
biome lint --error-on-warnings . : Checked 1320 files, exit 0
Linux container bun run typecheck:
  app pretypecheck: Exited with code 0
  runner / worker / server / app typecheck: each Exited with code 0
report unit tests: 3 pass / 0 fail / 7 expect() calls
delivery Compose config --quiet: exit 0
```

Docker build 的最终 chown 层耗时 623.4 秒，导出/解包层另耗时 157.8 秒。
首次 typecheck 容器漏挂 agent-computer/src 导致解析失败；补齐当前源码后四 workspace 全过，
没有把缺源码的测试环境误判为项目类型错误。首次产物镜像内没有 biome.json，误扫 dist 的结果作废；
以上 lint 是读取本 worktree 的真实 biome 配置并覆盖全仓源码的运行。

`image-smoke.sh` 从 Git Bash 调用原生 Docker/Bun。首次验证发现 MSYS_NO_PATHCONV 同时禁用了
宿主 env-file / 产物目录转换；补显式 cygpath -m 后完整重跑。该修正收进 WP-0.2 提交。

最终一次性容器输出（未配置任何模型 provider，已清理容器/卷）：

```text
HEALTH elapsed=20s (limit 60s)
PASS startup rls-not-enforced / rls-role-check-unavailable count = 0
PASS /api/capabilities 200
PASS selfHostBanner=false
PASS HTML 200
FAIL HTML contains 熊宝数字员工 (C owns title)
PASS HTML excludes Self-host OpenBot
PASS main JS entry exists / main JS 200
FAIL main JS contains 熊宝数字员工
PASS main JS excludes Self-host OpenBot
PASS pgpassword / pgpassword-app permissions = 600
PASS current_user, rolsuper, rolbypassrls = openbot_app|f|f
PASS migration's fixed app password is rejected
PASS apiuser cannot read MIGRATION_DATABASE_URL environment file
PASS owner container Running = false / ExitCode = 1
PASS owner log contains Refusing to serve: tenant isolation
```

生成配置已包含品牌名称，HTML 和入口主 JS 两个品牌名称断言仍红；镜像检查组退出 1。
这两项交由 C 的 index.html / main.tsx 完成，不能改 B 断言掩盖。DoD-3 的本地镜像断言通过，
DoD-2 不通过；DoD-1 main 全绿与 DoD-8 干净机器仍未验收。
详细日志在本 worktree `.scratch/track-b/`；远端 CI artifact 是每次运行的独立证据。

## 首次远端 CI

[运行 37902867816](https://github.com/xiongpinji/xiongbao-Wake-/actions/runs/37902867816)，
branch head 7630f87，四种 job 均执行；不是 main 的 DoD-1 验收。

- static success：lint 1320 文件、四 workspace typecheck exit 0、报告测试 3 pass / 0 fail。
- app 基线 16 fail / head 16 fail，新增与消失的失败名称多重集均为空。
- server 1/2/3/5/6 片的基线与 head 分别为 4/1/2/1/1 fail，名称差集均为空。
- server 第 4 片两边都 658 pass / 7 fail / 5 errors，5 个 BuiltInAgent export not found 导入错误；
  报告标为未验证，交给 A 修复，不作为全套差集为空的证据。
- image 构建 exit 0，6 秒健康；RLS 默认角色、两个密码权限、固定密码拒绝、owner 退出 1 均通过。
  HTML 与主 JS 品牌名称仍缺失，两项红灯交 C，未放宽断言。

首次镜像 artifact 上传显示 `include-hidden-files: false` / `No files were found`，
因为证据目录以点号开头。[上传工具的官方说明](https://github.com/actions/upload-artifact#uploading-hidden-files)
确认会忽略隐藏目录。修正为 runner.temp/delivery-evidence，缺文件改为 error；
[运行 37904039582](https://github.com/xiongpinji/xiongbao-Wake-/actions/runs/37904039582)
已成功上传并实际下载 index.html / main.js / startup.log / owner.log。

## 补验：部署文档、恢复与升级

全新 WSL 导入官方 Ubuntu 24.04 rootfs，不安装宿主 Bun；从私有远端新克隆并读取已提交 B 增量。
完整镜像构建 389 秒，18 秒健康；Windows PowerShell 5.1 新克隆构建 421.9 秒，21.2 秒健康；
独立 Compose config/up/health 共 12.2 秒。每项挂三个新卷；结束后删除自己容器与测试卷。
首次启动原始截图已入 docs/images，首屏读到了熊宝品牌；标题仍为 OpenBot，按 C 契约保留待验。

复用卷曾暴露迁移抢跑：PostgreSQL 57P03 / database system is starting up。
migrate 增加限时认证查询就绪检查，postgres 使用 SIGINT 正常停服。
实际强制终止后恢复、数据/双口令保留、旧卷补 app 口令、角色 f/f 与固定密码拒绝均通过。
两名用户注册、跨租户列表隐藏/按 id 404、第三位员工 402：`TENANTS assertions=9 failed=0; provider calls=0`。

权限改为 runtime COPY --chown 保持 pwuser；末步从 833.5 秒降为 0.9 秒，完整 /app 属主检查通过。
最终完整镜像 smoke 29 秒健康；除了 C 的两条品牌文字断言，其他检查全部通过。
DoD-8 已按“干净 WSL”口径补齐；DoD-1 main 全绿与 DoD-2 完整品牌验收仍需三线合入后复验。
[A/C 契约](contracts/track-b-delivery.md)和 PR 保留具体期望。
