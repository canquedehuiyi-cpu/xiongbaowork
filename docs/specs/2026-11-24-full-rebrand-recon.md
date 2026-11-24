# 全量去 OpenBot 品牌：只读摸底（2026-11-24）

基线：/home/user/xiongbaowork，origin/main `17f6fae8`（v0.2.15）。所有数字来自 `git grep` / `git ls-tree` 实测。
匹配口径：`open[-_ ]?bot`（不分大小写）；「行」= 命中行数，「次」= 出现次数（`-o`）。
除特别注明，路径相对仓库根；`xiongbao/` 是产品目录（对应上游仓库根）。

> 副作用说明：为数上游出现次数，执行了 `git fetch upstream --no-tags --depth=1 main`，随后 `--deepen` 两次。只更新了 `refs/remotes/upstream/main` 和 `.git/shallow`，没有动任何工作区文件，也没有切分支。

---

## 0. 先看三个最大的发现

1. **上游 main 的目录结构已经变了，`server/` 不在上游了。**
   `git ls-tree --name-only upstream/main`（bdb6280d8，2026-11-23）没有 `server/ worker/ runner/ toolkit/ charts/ supervisor/ agent-computer/ agent-bot/ docker/ spire/ patches/ tools/ Dockerfile`，新出现 `api/ management-agent/ tokens/ agent-langgraph-ts/ redocly.yaml backend-images.env`。
   抽样 21 个提交（2026-11-13 到 11-23）都没有 `server/`；本地旧的 `8b10d56d1`（2026-11-11）还有 `server/`。所以删除发生在 11-11 到 11-13 之间。浅克隆只到 11-13，看不到删除提交，**原因未查**，需要确认。
   对「自动改名再合并」的含义：熊宝现有 `xiongbao/` 里约四成含品牌字样的非测试文件（server 342 个、agent-computer 21、charts 37、docker 5、runner/toolkit/supervisor/worker 19 个，合计 424 个文件、约 2 150 行，占非测试 1 025 个文件的 41%）以后**没有上游可同步**，自动改名只覆盖 app / desktop / extension / shared / mobile / agent-* / docs / api 这一部分。
2. **全量改名的真正难点不是文本，是「已经落进数据里的名字」**：数据库角色与超级用户名、approval 加密版本串（连数据库 CHECK 约束都写死了）、凭据加密 AAD、HMAC 域串、持久化到对话历史里的事件名和标记、tenant 包 id `openbot`（决定线程 id 前缀与遥测哈希）。这些改了会解不开旧数据或断开旧对端。
3. **兼容机制已经有一套，方向相反**：环境变量现在是「`XIONGBAO_X` 复制到 `OPENBOT_X`，代码仍读 `OPENBOT_X`」（`xiongbao/shared/env-aliases.ts:1-34`，shell 版 `xiongbao/docker/s6/scripts/env-aliases.sh`）。全改名后要翻转为「`OPENBOT_X` 复制到 `XIONGBAO_X`，代码读新名」。到期删除也有现成机制（allowlist 的 `legacy-compat` + `removeIn`，源码注释版 `legacy-compat：introducedIn X，removeIn Y`，见 `xiongbao/scripts/brand/guard/allowlist.ts`、`compat-comments.ts`）；v0.2.15 刚用它删了一批旧名（commit `cc019e64`）。

---

## 1. 总量与分布

### 1.1 全仓

| 范围 | 文件数 | 行数 |
|---|---|---|
| 整个仓库（`git ls-files` 共 7 027 个文件） | 2 472 | 30 747 |
| 其中 `archives/`（历史归档，不是产品代码） | 294 | 12 307 |
| 其中根 `docs/`（本仓库自己的设计稿、计划、验收） | 45 | 1 393 |
| 其中根 `.github/` | 6 | 166 |
| 其中 `xiongbao/docs/` | 42 | 681 |
| `xiongbao/` 其余（代码+测试+md，不含 docs） | 2 082 | 16 180 |
| 　其中测试（`tests/`、`*.test.*`） | 1 037 | 7 318 |
| 　其中非测试非 md | 1 025 | 8 659 |
| 　其中 md（不含 docs/） | 56 | 850 |

大小写变体（不含 archives，`git grep -oF` 次数）：`OpenBot` 6 855、`openbot` 11 570、`OPENBOT` 2 388、`openBot` 77、`Open Bot`/`open bot` 各 2；`open-bot`、`open_bot`、`OPEN_BOT` 为 0。
另有 `open.bot`（域名，不是 openbot）：本仓库 `xiongbao/` 14 次，**上游 942 次**（几乎全是 `https://open.bot/errors/...` 的 API 错误类型地址）。

### 1.2 非测试非文档行数，按目录（`xiongbao/` 下）

| 目录 | 文件 | 行 | 备注 |
|---|---|---|---|
| desktop（上游整栈安装器，不交付） | 137 | 3 485 | 占非测试总量约四成，护栏整目录豁免 |
| server | 342 | 1 461 | **上游已无此目录** |
| app | 232 | 655 | |
| charts（Helm） | 37 | 499 | **上游已无此目录** |
| extension | 50 | 463 | |
| scripts | 58 | 419 | |
| shared | 38 | 210 | |
| agent-computer | 21 | 104 | **上游已无此目录** |
| examples | 15 | 67 | |
| toolkit | 9 | 39 | **上游已无此目录** |
| docker | 5 | 26 | **上游已无此目录** |
| desktop-device（熊宝自有） | 1 | 27 | 都是旧 sidecar 名 `openbot-runner` 的清理逻辑 |
| supervisor / runner / worker / mobile | 6 / 1 / 3 / 2 | 20 / 5 / 3 / 3 | |
| agent-*（14 个框架目录合计） | 54 | 293 | |

---

## 2. 按类别清点

### 2.1 总表

| 类别 | 数量 | 代表位置 | 分类 |
|---|---|---|---|
| A 包名与导入路径 `@openbot/*` | 526 个文件、788 行、793 次；包名 13 个（见下） | `xiongbao/package.json`（`"name": "openbot"`）、`shared/package.json`、`toolkit/package.json`；导入 `@openbot/shared` 571 次、`@openbot/toolkit` 200 次 | 纯文本可换，但要重生成 `bun.lock`（13 处）、`biome.json:56-69`、tsconfig 路径 |
| B 代码标识符（类型/函数/变量） | 506 个不同的带品牌词（含 OPENBOT_ 常量）；高频：`OpenBotClaudeAgentAdapter` 60、`openbotUrl` 287、`OpenBotRole` 46、`normaliseOpenBotOrigin` 38、`openbotModel` 33 | `server/src`、`app/src`、`extension/src`、`agent-claude-sdk/src/adapter.py` | 可换；改名后与熊宝已有名冲突 36 个（见 4.3） |
| C 文件与目录名 | 58 个被跟踪路径 | `xiongbao/charts/openbot/`（40 个文件）、`shared/openbot-actor.ts`、`shared/openbot-browser.ts`、`extension/src/shared/openbot-client.ts`、`extension/src/background/openbot-page.ts`、`app/src/lib/openbot-for-business.ts`、`app/src/components/layout/openbot-version.tsx`、`.claude/skills/openbot-{copy,data-access,screen-layout}/`、`docs/assets/openbot-stack-{dark,light}.svg`、测试 15 个 | 改名无冲突（`git ls-files` 逐个映射后目标路径都不存在） |
| D 环境变量 `OPENBOT_*` | 232 个不同名字（不含 archives）、2 229 次 | 见 2.2 | 双认 |
| E HTTP 头 / 协议常量 | 头：`x-openbot-*` 现存 11 种；非测试只剩 3 种（见 2.3）；协议常量：CUSTOM 事件、消息类型、`forwardedProps` 字段 | 见 2.3 | 双认或保留 |
| F 数据库 | 角色 2 个 + 超级用户/库名、触发器与函数 ≥ 20 个、CHECK 约束值、GUC、NOTIFY 通道 | 见 2.4 | 迁移或保留 |
| G 加密/签名标识串 | 7 个域串 + 5 个 approval 版本串 | 见 2.5 | **保留（不能改）** |
| H 浏览器存储 / cookie / 通知 tag | cookie 已改；localStorage 已改；剩余：`openbot-voice-chat`、`openbot-voice-context`、`openbot-unreachable`、`openbot:open`、`openbot-browser`、通知 tag、DOM id/类名 | 见 2.6 | |
| I 镜像 / 安装包 / 进程 / 服务名 | `Dockerfile` 只剩 2 处注释；镜像仓库名已是 `xiongbaowork`；剩 `images.openbot`（release 记录）、sidecar `openbot-runner`（升级清理）、compose 变量 `OPENBOT_IMAGE/TAG/PORT`、`openbot-release:dry-run`（CI） | 见 2.7 | |
| J Helm chart | 目录 `charts/openbot/` 40 个文件、chart 名 `openbot`、模板函数 `openbot.*` 约 150 处、K8s 标签 `openbot.dev/{bot-id,computer,person-id,component}`、`app.kubernetes.io/managed-by: openbot`（`server/src/computer/sandbox.ts:469`） | 京东云单容器不用 Helm | |
| K 日志与指标 | OTel/审计属性 `openbot.surface/state/target_type…` 约 12 个、桌面遥测 `openbot_version/platform/os_version/engine/arch`、日志里的名字（内部，分散） | `server/src/telemetry/product.ts`、`desktop-telemetry.ts` | 属性名改了会断客户已有查询 |
| L 文档 | `xiongbao/docs` 42 个文件 681 行；`xiongbao/**/*.md` 56 个文件 850 行；`CHANGELOG.md` 131 行；`xiongbao/README.md` 82 行；根 `docs/` 45 个文件 1 393 行；`archives/` 294 个文件 12 307 行 | | 历史文档不该改 |
| M 测试 | 1 037 个文件、7 318 行 | `xiongbao/server/tests`、`app/tests`（含护栏测试） | 随源码一起换；少量测试故意拼旧名证明兼容 |

包名清单（`"name"` 字段）：`@openbot/{agent-bot, agent-computer, agent-langgraph, agent-mastra, example-langgraph-bot, example-mastra-bot, recorder-extension, shared, supervisor, toolkit}` 共 10 个，另有无作用域的 `openbot`（根）、`openbot-desktop`、`openbot-mobile`；`desktop/src-tauri/Cargo.toml:2,9,13` 的 `openbot-desktop`、`openbot_desktop_lib`；`examples/pydantic-ai-bot/pyproject.toml:2`。

### 2.2 环境变量 `OPENBOT_*`

| 子类 | 个数 | 依据 |
|---|---|---|
| 全部不同名字（不含 archives） | 232 | `git grep -ohE 'OPENBOT_[A-Z0-9_]+' -- . ':!archives'` |
| **部署者会设**（出现在部署文档、`.env.example`、compose、Helm values、`docker/*.env`） | 48 | `docs/configuration.md` 65 行、`docs/deployment-xiongbao.md`、`docker/delivery.env.example`、`docker/compose.delivery.yml`、`charts/` 12 个 |
| 运行时代码读取（server/shared/agent-computer/runner/supervisor/worker/toolkit/extension/desktop-device 非测试） | 70 | |
| 只有桌面整栈用 | 94 个出现在 `desktop/`（不交付） | |
| 熊宝已有 `XIONGBAO_*` 名字 | 116 个；其中 29 个同名后缀也有 `OPENBOT_` 版本（=别名），87 个只有新名 | |

部署者会设的 48 个（原样）：`ACCESSIBILITY_DISABLED APP_URL BROKER_PROVIDER BROWSER_ABSENT BROWSER_CONTAINER_URL BROWSER_URL BUILD_{CHANNEL,COMMIT,DISTRIBUTION_ID,REPOSITORY,VERSION} DATABASE_WAIT_{HINT,SECONDS} DEPLOYMENT DESKTOP_HOST_TOKEN DEV_NO_AUTH EDITION GENERATIVE_UI HOST_GATEWAY IMAGE INBOUND_EMAIL_DOMAIN INBOUND_EMAIL_SNS_TOPIC_ARNS INSTALLATION_ID IN_CONTAINER LEARNING_AUTO_ASSIGN LEARNING_MODEL_TOKEN LOCAL_COMPUTER_DIR LOCAL_LEARNING MEMORY_SOURCE_DEFAULTS MODEL_CAPABILITIES_URL MODEL_OAUTH_FILE ONE_COMPUTER_EACH ORGANIZATION_AUTH_URL OTEL_EXPORT PORT PROACTIVE_DEFAULTS PRODUCT_TELEMETRY PUBLIC_URL RECORDER_DIR RECORDER_EXTRA_EXTENSION_IDS RLS_ENFORCE SELF_HOST_BANNER SERVER_USER SINGLE_USER TAG THIS_MACHINE_CONTAINER_HOST THIS_MACHINE_HOST TOOL_URL`（都带 `OPENBOT_` 前缀）。

其中两类要特别注意：
- **不走 env-aliases 的**：`OPENBOT_IMAGE`、`OPENBOT_TAG`、`OPENBOT_PORT` 是 Compose 与 README 命令读取的 shell 变量，不进容器。`xiongbao/docker/delivery.env.example:3` 明说「名字不变」；`xiongbao/docker/compose.delivery.yml:5,14` 用 `${OPENBOT_IMAGE:-…}`、`${OPENBOT_PORT:-3772}`；`docs/deployment-xiongbao.md` 里 `OPENBOT_TAG/IMAGE` 出现 20 多次。改名需要 compose 里写 `${XIONGBAO_IMAGE:-${OPENBOT_IMAGE:-…}}` 这种嵌套回退。
- **加密常量**：`OPENBOT_APPROVAL_EXACT_{AEAD,HEADER,SOURCE_BINDING,WIRE}_V1`、`OPENBOT_EXACT_INPUT_JSON_V1` 长得像环境变量，实际是版本串，见 2.5，**不能当环境变量改**。`env-names.ts` 的 `CRYPTO_NAMES` 单独列了它们。
- 「纯内部」：server 起子进程、对 agent-computer / runner 传的变量（如 `OPENBOT_COMPUTER_BROWSER`、`OPENBOT_BROWSER_URL`、`OPENBOT_TOOL_URL`）以及各类错误码（如 `OPENBOT_MODEL_AUTH_REQUIRED`、`OPENBOT_MODEL_REFUSED`，发到浏览器的错误码）。错误码也算协议，浏览器和服务端要同版发布。
- 京东云现网 `.env.delivery` 的实际内容我看不到。仓库样例 `delivery.env.example:12-15` 写的是 `XIONGBAO_SINGLE_USER/PUBLIC_URL/SELF_HOST_BANNER/RLS_ENFORCE`，但 `docs/deployment-xiongbao.md:81-89` 仍有 `OPENBOT_*` 写法，**现网可能是旧名，需要现场确认**。

### 2.3 HTTP 头与协议常量

`x-openbot-*` 当前（`git grep -ohi`，含测试）：`agent-token` 114、`desktop-host-token` 11、`recorder-bot` 4、`test-network-guard` 2、`person-id` 2、`computer-token` 2、`bot-id` 2、`probe` 1、`egress` 1、`dictation` 1、`build-version` 1。
**非测试、不含 desktop/ 的现存**：只有 `x-openbot-agent-token` 29 处（服务器 ↔ 托管 Bot 容器，14 个框架目录各有一份常量，Python 和 TS 都有；`shared/agent-authorisation.ts`）。`x-openbot-bot-id / person-id / computer-token / egress` 在 v0.2.15 已删（`cc019e64`），现在只发 `x-xiongbao-*`（94/15/63/2 处）。`x-openbot-dictation/voice` 服务端还认旧名：`server/src/browser-request-marker.ts:11-15`（`hasBrowserMarker` 同时判 `x-xiongbao-${kind}` 和 `x-openbot-${kind}`）。
上游 main 现在还有熊宝没有的头：`x-openbot-singleton` 134 次、`x-openbot-scheduled-work` 23、`x-openbot-install-token` 11（大小写混用）。

其他协议常量（都在持久化数据或对端里）：

| 名字 | 位置 | 说明 |
|---|---|---|
| CUSTOM 事件 `openbot.headless.waiting`、`openbot.ap.local-terminal.v1` | `server/src/approvals/continuation-target-store.ts:321,476` | 已写进对话历史 |
| 消息标记 `<<openbot:app-access-request>>`、`<<openbot:staffing-proposal>>` | | 已存进历史消息 |
| 浏览器扩展消息 `openbot.ping/connect/state/record/stop/connect.status`、`openbot-unreachable` | `extension/src`、`app/src/lib/desktop` | 扩展与网页成对；已装扩展不会同时升级 |
| `forwardedProps.openbotRun`、`openbotModel`、`openbotTimeZone`、`openbotWaiting` | `server/src/copilot.ts:3529,3594,3596`、`agents/harness-model.ts:6-11`；Python harness `agent-claude-sdk/src/adapter.py`、`agent-langgraph-agui/src/main.py` | 服务器与托管 Bot 镜像之间 |
| 出站接口 `/openbot/membership`、`/openbot/deliver` | `server/src/delivery/opentag.ts:86,120` | OpenTag 对端也认这个路径，**不归我们单方面改** |
| JSON 字段 `openbotUrl`（23 个非测试文件、147 行） | `shared/openbot-browser.ts:50,67,194` 等 | 扩展与 runner、浏览器网关之间；runner 产物里还出现 `openbotUrl:` |
| 工具 id `openbot:personal-memory`、`openbot:personal-defaults`、`openbot:always-on`、`openbot:learned-skills`、`openbot:staffing-default`；A2UI 目录 id `openbot/ui@1`；内置工具引用 `openbot/share_private_information` | `server/src/memory`、`app/src/lib/copilot/a2ui*` | 技能/智能体配置里可能已存 |
| 扩展企业策略键 `OpenBotUrl` | `extension/public/managed_schema.json`（同时有 `XiongbaoUrl`）；`extension/src/shared/policy.ts:41` `managed.XiongbaoUrl ?? managed.OpenBotUrl` | 客户电脑上的 GPO / 策略文件可能还写着旧键 |

### 2.4 数据库

| 对象 | 现状 | 证据 |
|---|---|---|
| 超级用户 `openbot` + 库名 `openbot`（单容器内） | 首次初始化时创建，口令随机；连接串 `postgres://openbot:…@127.0.0.1:5432/openbot` | `docker/s6/scripts/postgres-init.sh:58,63,64,87`、`migrate.sh:23` |
| 应用角色 `openbot_app`、`openbot_role_writer` | 迁移里 `CREATE ROLE`；`ALTER ROLE … PASSWORD` 每次启动重设 | `server/drizzle/0054_app_role.sql:15`；`migrate.sh:39-50`；连接串 `postgres://openbot_app:…` 在 `docker/s6/scripts/postgres-init.sh:93,98`、`charts/openbot/templates/_helpers.tpl:343`、`.env.example:16,28` |
| 迁移文件中的品牌字样 | `server/drizzle/` 82 个文件中 12 个含（23 行）；`server/recovery/**/sql/` 139 个文件中 58 个含（256 行）；`openbot_app` 120 次 | `git grep -ohE 'openbot[a-z_]*' -- server/drizzle server/recovery` |
| 触发器/函数 `openbot_team_row_guard`（18 个 `CREATE TRIGGER`）、`openbot_team_channel_member`、`openbot_team_bot_visible`、`openbot_team_channel_creator`、`openbot_flow_share_guard`、`openbot_grant_stamp_guard`、`openbot_mcp_tool_stamp_guard`、`openbot_channel_waker_group_link` 等 | 被 RLS 策略、服务端 SQL（`server/src/channels/routes.ts:1092` 的 `public.openbot_team_channel_creator(...)`）直接引用 | 熊宝自有迁移已用 `xiongbao_team_channel_hand_over`（10 次）说明新增对象已经用新名 |
| CHECK 约束值 | `"codec_version" = 'OPENBOT_EXACT_INPUT_JSON_V1'` 等 6 条，约束名 `apx_*_ck` | `server/src/db/schema/approval-exact-input-objects.ts:52,56,57,111,115,116`；**行里存的也是这个值** |
| GUC | `openbot.audit_retention_days`（`set_config`/`current_setting` 8 处） | 迁移 + `server/src` |
| NOTIFY 通道 | `openbot_work_offered`（5 处 `pg_notify`，`server/src/approvals/store.ts:425,1052`、`channels/group.ts:1291`、`delivery/store.ts:42`、`approvals/questions.ts:250`） | 单进程时改了无害；多副本滚动升级期间新旧要同时监听 |
| 迁移锁名 `openbot:apply-migrations` | `server/src/db/apply-migrations.ts:90` | |
| 种子/租户 id `openbot` | `xiongbao/examples/xiongbao/brand.yaml:4`（`tenant.id: openbot`）→ `deployment_packages.tenant_id`；`DEPLOYMENT_ID` 未设时默认取它（`docs/configuration.md:150`），**线程 id 前六字节是它的摘要**（`server/src/channels/thread-identity.ts:12-15`）、遥测 `ob_` 假名哈希也含部署名（`server/src/telemetry/product.ts:128`） | 已有改名机制：`tenant.former_ids`（`server/src/tenant-package.ts:1091-1102`，`deploymentNameOf` 2960-2984 保证「老部署继续用老名字」）。**但这个机制是让旧名继续算作部署名，不是迁移数据** |
| 学习容器 id `openbot` | `shared/learning.ts:113`；`server/src/learning/ensure-container.ts:51` | 是外部 Intelligence 项目里的容器名，改了会找不到已有容器 |
| 默认库口令 `"openbot"` | `server/src/auth/role-writer-lifecycle.ts:41` | 识别「公共默认口令」用的常量，旧库里可能真是这个口令 |
| 卷名 | `openbot_postgres-data` 只出现在 `desktop/`（不交付）；单容器 compose 的卷名是 `database/workspace/profiles` | |

### 2.5 加密与签名标识串（改了会解不开/验不过旧数据）

| 串 | 用途 | 位置 |
|---|---|---|
| `openbot.vault.credential.v2` | 凭据保险库 AES-GCM 的 AAD | `server/src/credentials.ts:44` |
| `openbot:agent-run` | 运行断言 HMAC 标签 | `server/src/agents/callback-token.ts:38` |
| `openbot-bearer` | HMAC 密钥串（响应/自动化签名） | `server/src/responsibilities/signatures.ts:137` |
| `openbot-automation-hook-signing:v1` | 自动化钩子签名域 | `server/src/automations/ingress-routes.ts` |
| `openbot web-bot-auth ed25519 v1` | HKDF info，派生 Ed25519 私钥种子（**改了公钥就变**，对端已登记的 keyid 失效） | `server/src/web-bot-auth.ts:54` |
| `openbot computer token v1` | 电脑令牌签名标签（服务器与电脑端共用） | `shared/computer-token.ts:35` |
| `openbot-product\0…` | 遥测假名 HMAC 输入 | `server/src/telemetry/product.ts:128` |
| `OPENBOT_APPROVAL_EXACT_{AEAD,HEADER,SOURCE_BINDING,WIRE}_V1`、`OPENBOT_EXACT_INPUT_JSON_V1` | 审批「精确输入对象」的版本串，**同时是 DB 列值与 CHECK 约束** | `server/src/approvals/exact-object-{crypto,header,wire}.ts`、`exact-input-json.ts:15`、`server/src/db/schema/approval-exact-input-objects.ts` |
| `openbot:` 前缀的 SPIRE 信任域 `openbot.local` | `xiongbao/spire/{agent,server}.conf` | 部署配置 |

护栏把这些列在 `scripts/brand/guard/scan.ts` 的 `NEVER_CHANGE`（10 项）、`SIGNING_DOMAINS`（7 项）和 `env-names.ts` 的 `CRYPTO_NAMES`（5 项）。结论一致：**这一类保留不改**（或是读新写旧，永远保留旧串）。

### 2.6 浏览器存储、cookie、IndexedDB、通知

| 项 | 现状 |
|---|---|
| cookie | 已改为 `xiongbao.organization-session`，读旧名的兼容读取随 P7 做了（`server/src/auth/organization.ts:8-12`） |
| localStorage 的 `xiongbao-theme/skin/sidebar…` | 已改，`readMigrated`（`app/src/lib/storage-migrate.ts:22`）读新键没有就搬旧键；现在源码里只剩 1 处调用 |
| 设计稿 2.3 表二列的 9 个旧存储键（`openbot.reachability.pendingSms` 等） | 现在 `app/src` 里查不到这些字符串，应已处理；**本次没有逐个核对** |
| 仍在的 | `"openbot-voice-chat"`、`"openbot-voice-context"`、`"openbot-unreachable"`、`"openbot:open"`（上游桌面事件）、`"openbot-browser"`（3 处）、`plugin:openbot-desktop`（上游桌面）、通知 tag `openbot-*`、DOM id/类名（`openbot-secret`、`.openbot-markdown`、`.openbot-breakdown`、`data-slot="openbot-version"`、`data-orb="openbot"`）、默认皮肤 id `"openbot"`（存在 `xiongbao-skin` 的**值**和服务器用户偏好里：`app/src/skins/registry.ts:13`、`shared/user-preferences.ts`、`app/index.html:30`） |
| IndexedDB | 网页不用；录制扩展用库名 `"openbot-recorder"`（`extension/src/shared/database.ts:1` 附近，`indexedDB.open(name…)` 在 :56）。已装扩展里已有录制数据，改库名等于丢本地缓存 |
| 本机文件 | `.env.openbot-installation-id`（Composio 安装身份，`docs/configuration.md:176`）、`~/.config/openbot-recorder/recorder-extension.pem`（扩展签名密钥，`extension/scripts/store-package.test.ts:218-226`）、`/etc/openbot/sandbox-template.json`（`server/src/config.ts:1690`）、`.openbot-write-probe-*`（`agent-computer/src/index.ts:338`）、旧文件 `openbot-snapshots.sqlite`（v0.2.15 已删回退） |

### 2.7 镜像、安装包、进程、服务

- `xiongbao/Dockerfile` 只剩 2 处注释（`:1`、`:524`），镜像名已是 `xiongbao-digital-employee`/`ghcr.io/…/xiongbaowork`。s6 服务目录里没有 openbot 命名。
- 发布记录 `container-images.json` 同时写 `images.xiongbao` 和 `images.openbot`；`.github/workflows/release.yml:719-723` 注明 `openbot` 键「被 promote 步骤和已发出去的安装器读取，保留在 GHCR」；`.github/workflows/mirror-release.yml:74-79` 读 `.images.openbot`。**这是对已装客户端的协议**。
- 设备端：`desktop-device/src-tauri/src/sidecar.rs:27,47,180,663-697` 保留 `LEGACY_SIDECAR = "openbot-runner"`，升级时清掉旧进程；v0.2.15 说明把 `shared/desktop-control.ts` 里的 `openbot-desktop`（桌面整栈自己的可执行文件名）作为 `persisted-data/keep`。
- 根 CI：`.github/workflows/{ci,clean-deploy,model-e2e}.yml` 共 150 行带品牌词（多为测试库名 `openbot_test`、`openbot:ci-owner` 这类 CI 内部名）；`release.yml:230-245` 的临时镜像名 `openbot-release:dry-run`。
- 上游桌面整栈 `xiongbao/desktop/`（不交付）：bundle id `ai.copilotkit.openbot.desktop`、原生宿主 `ai.copilotkit.openbot.recorder`（`shared/recorder-extension.json` 也写这个）、下载地址 `downloads.copilotkit.ai/latest/OpenBot-*.dmg/.exe`。

---

## 3. 哪些名字改了会影响已部署环境（含兼容方式）

| # | 名字 | 影响谁 | 兼容方式 | 到期 |
|---|---|---|---|---|
| 1 | `OPENBOT_*` 环境变量 | 京东云 `.env.delivery`（现网内容未见到）、客户的 compose/Helm values、已装设备端（`OPENBOT_RUNNER_DATA_DIR`） | **双认**：把现有 `applyEnvironmentAliases`（shared/env-aliases.ts）和 `env-aliases.sh` 翻转方向，旧名复制成新名，新名赢，冲突打警告；`OPENBOT_IMAGE/TAG/PORT` 用 compose 嵌套回退 `${XIONGBAO_IMAGE:-${OPENBOT_IMAGE:-…}}` | 按版本到期；但环境变量是部署者手里的，建议留至少两个大版本并在启动时打「旧名已弃用」警告 |
| 2 | 数据库超级用户/库 `openbot` | 已有 postgres 数据卷 | **迁移**：启动脚本检测到旧名时 `ALTER ROLE openbot RENAME TO …`、`ALTER DATABASE openbot RENAME TO …`（要连别的库）、同步改连接串文件（`postgres-init.sh:87-98`）。SCRAM 口令不含用户名，改名不用重设口令；`ALTER DEFAULT PRIVILEGES FOR ROLE openbot` 随 OID 跟着走。**也可以保留不改**（不可见，只有 `psql` 才看到） | 无需到期，一次性迁移 |
| 3 | 角色 `openbot_app`、`openbot_role_writer` | 已有库、Helm 的连接串、外部托管库（客户自管 postgres） | 新增一条迁移 `ALTER ROLE … RENAME`。**历史迁移 SQL 不改**（`server/drizzle` 冻结，`server/tests/recovery-*.test.ts` 按字节冻结 recovery SQL；迁移表按 hash 记录，`apply-migrations.ts:60-64`）。新装库先跑旧名迁移再被最后一条改名。外部托管库要另给运维 SQL | 无 |
| 4 | 触发器/函数 `openbot_team_*` 等约 20 个 | 已有库；服务端 SQL 引用 | 同样靠新迁移 `ALTER FUNCTION … RENAME`/`ALTER TRIGGER … RENAME`，再同步服务端 SQL 的引用。**也可以保留**（不可见，只有读库的人看到） | 无 |
| 5 | CHECK 约束 + 行值 `OPENBOT_EXACT_INPUT_JSON_V1` 等 | 已存的审批精确输入对象 | **保留**。要改只能是：新迁移放宽约束到「新旧两值」→ 代码双认 → 重新加密或重写存量行 → 收紧约束。成本高、收益只是「抓库才能看到」，建议不改 | 无 |
| 6 | AAD `openbot.vault.credential.v2` | 全部已加密凭据 | **保留**。要改只能「读旧写新」并逐行重新加密（`kid` 机制：`credentials.ts:45` 的 `CREDENTIAL_KID = "k1"` 可以加 `k2`）；一次失败就解不开 | 无 |
| 7 | HKDF `openbot web-bot-auth ed25519 v1` | 对端已登记的公钥 keyid | **保留** | 无 |
| 8 | `openbot:agent-run`、`openbot-bearer`、`openbot-automation-hook-signing:v1`、`openbot computer token v1` | 已签发的令牌、已配置的钩子签名、电脑端 | **保留**；或「验证时两个都试、签发用新」后到期（只对短命令牌可行：agent-run、computer token；`openbot-bearer` 若用于已持久化的签名则不可） | 令牌类可到期 |
| 9 | 事件名 `openbot.headless.waiting`、`openbot.ap.local-terminal.v1`，标记 `<<openbot:…>>`，工具 id `openbot:*`，`openbot/ui@1` | 已存对话历史、已存技能/智能体配置 | **保留**，或写入新名、读取同时认旧名（永远不能到期，因为历史永远在） | 不到期 |
| 10 | `x-openbot-agent-token` | 托管 Bot 容器镜像（14 个框架各一份）与服务器；已部署的旧镜像 | **双认**：服务器发新旧两个头（或只发新、读两个），Bot 镜像读两个。托管 Bot 镜像不在京东云单镜像里，但客户可能自己在跑 | 一个大版本后删旧 |
| 11 | `x-openbot-dictation/voice` | 浏览器 ↔ 服务器（同版发布） | 服务器已双认（`browser-request-marker.ts:11-15`），网页只发新；到期后删旧 | 已有窗口，按版本删 |
| 12 | 错误码 `OPENBOT_MODEL_*` 等 | 浏览器 ↔ 服务器 | 双认一版 | 一版 |
| 13 | 浏览器扩展：消息类型 `openbot.*`、`openbot-unreachable`、IndexedDB 库 `openbot-recorder`、策略键 `OpenBotUrl`、全局标志、原生宿主名 | **已装在客户电脑上的扩展**，不会和服务器同时升级；企业策略（GPO/plist）里的 `OpenBotUrl` | **双认**：扩展同时认新旧消息类型（网页/服务器发新）；策略键已有双认模式（`policy.ts:41` `managed.XiongbaoUrl ?? managed.OpenBotUrl`）可照搬；IndexedDB 开新库并一次性搬数据（旧库保留到到期）；扩展 id 与密钥（`~/.config/openbot-recorder/*.pem`）**不能变**，否则 Chrome 视作新扩展 | 至少两个大版本 |
| 14 | 设备端：sidecar `openbot-runner`、`OPENBOT_RUNNER_DATA_DIR` 的数据目录名、`openbot-snapshots.sqlite` | 已装设备端 | 已完成大半（0.2.15 删旧回退，保留 `LEGACY_SIDECAR` 清理旧进程）。数据目录名保留（之前决定）| 清理逻辑留到所有设备升过 |
| 15 | `images.openbot`（发布记录）、镜像名 | 已发出去的安装器、`mirror-release.yml` | **保留** `images.openbot` 键（或同时写新旧），直到所有已发安装器升级 | 随安装器 |
| 16 | tenant 包 id `openbot`（`examples/xiongbao/brand.yaml:4`） | 线程 id 前缀、遥测假名、`deployment_packages` 行、Composio 身份 | **保留**，改用 `tenant.former_ids: [openbot]` 让 `deploymentNameOf` 继续返回 `openbot`（现成机制）；或者给部署显式设 `DEPLOYMENT_ID=openbot` | 不到期 |
| 17 | cookie `xiongbao.organization-session`、存储键 | 已完成 | 无新增 | |
| 18 | 默认皮肤值 `"openbot"` | 用户偏好里已存的值 | 读取时把 `"openbot"` 映射到新皮肤 id，写新值 | 可到期 |
| 19 | Helm chart 名/标签 `openbot.dev/*`、`app.kubernetes.io/managed-by: openbot` | 已有 K8s 部署的升级（`helm upgrade` 换 chart 名会当成新 release）；已运行的电脑 pod 靠标签被找到（`server/src/computer/sandbox.ts:469`） | 京东云不用 Helm。若有客户用：chart 名保留，只换模板函数名；标签双认一版 | |
| 20 | OTel/审计属性 `openbot.*`、`OTEL service.name` 默认 `openbot` | 客户监控系统的查询与告警 | 属性名保留（已有规格结论）；`service.name` 默认值可改（可被配置覆盖） | |
| 21 | `/openbot/membership`、`/openbot/deliver` | OpenTag 对端 | **保留**（对方系统要认） | |
| 22 | Intelligence 学习容器 id `openbot` | 外部服务里已建的容器 | **保留** | |

---

## 4. 上游同步现状与「自动改名」可行性

### 4.1 同步点与格式

- `xiongbao/upstream-sync.json`：`{"commit": "e4a73d7bfe2c30276779c8d1473a9818e5ee1ae0", "repository": "https://github.com/CopilotKit/OpenBot.git"}`（两个字段）。上游提交 e4a73d7b 日期 2026-11-09（#1412）。`xiongbao/UPSTREAM.md` 第 7 行写「上游 main，2026-11-10」，差一天，以提交日期为准。
- `UPSTREAM.md` 的方法：不导入上游历史；`git merge-tree --write-tree --merge-base=<上次同步点> <本仓库 xiongbao 子树提交> <上游目标提交>`。分叉点 `63f99cf`（2026-10-05，#734）。已做过 M1、M2（6fb38c8b）、M3（v1.0.0 ac9c16f7）、M4（前端到 v1.0.0）、M5a/M5b（e4a73d7b）。最近一次合并 `64a8f7d1`（PR #428，2026-11-11）。**此后没有再同步**（`git log` 对 `upstream-sync.json` 只有 2026-11-16 的目录改名提交）。
- 辅助：`xiongbao/scripts/integrate-upstream.ts`（候选分支 + 回归命令）、`xiongbao/docs/upstream-upgrades.md`、`xiongbao/.github/workflows/upstream-upgrade.yml`（注意这些在 `xiongbao/.github/`，不是仓库根 `.github/`，根 CI 只有 `ci/clean-deploy/device-release/mirror-release/model-e2e/release`）。
- 护栏 `brand-new-lines` 用 `upstream-sync.json` 去上游取同步点，判断「这个 PR 是不是同步 PR」，并把「上游同路径同一行」的新增行豁免（`xiongbao/scripts/brand/guard/new-lines.ts:3,192-216,266-272`）。

### 4.2 目录对应

| 项 | 事实 |
|---|---|
| 仓库根与产品目录 | 本仓库根放熊宝自有的 `CLAUDE.md`、`CONTEXT.md`、`docs/`、`archives/`、`.github/`、各类 `*-REPORT.md`；`xiongbao/` 对应上游仓库根。2026-11-16 提交 `504b06850`「把产品目录 openbot/ 改名为 xiongbao/（纯移动）」；`UPSTREAM.md:19` 说明三方合并比较的是树内容，不看目录名 |
| 熊宝独有 | `desktop-device/`、`UPSTREAM.md`、`upstream-sync.json`、`NOTICE`、`THIRD-PARTY-NOTICES.md`、`capability-*.yaml`、`server/recovery/`（overlay 迁移）、`examples/xiongbao/`、`docker/`（部分）等 |
| 上游 **e4a73d7b 时**的顶层 | 含 `server worker runner? toolkit charts docker supervisor agent-computer spire` 等（`git ls-tree e4a73d7b --name-only`：有 `server charts docker supervisor toolkit worker spire agent-computer agent-bot`，没有 `runner`） |
| 上游 **当前 main bdb6280d8（2026-11-23）** 顶层 | 52 项；与熊宝 `xiongbao/` 的 64 项相比：上游新增 `AGENTS.md CLAUDE.md CONTRIBUTING.md agent-langgraph-ts api backend-images.env management-agent redocly.yaml tokens`；上游没有（熊宝有）`Dockerfile Dockerfile.dev NOTICE UPSTREAM.md agent-bot agent-computer agent-langgraph capability-*.yaml charts desktop-device docker patches runner server spire supervisor toolkit tools upstream-sync.json worker`。`agent-langgraph` → 上游改叫 `agent-langgraph-ts` |
| 浅克隆限制 | `git fetch` 只拿到 406 个提交（2026-11-13 起），**e4a73d7b 不在其祖先里**（`git merge-base --is-ancestor` 为否），所以本地算不出 e4a73d7b → 当前 main 的精确 diff；曾经的 `upstream/main` 旧值 8b10d56d1（2026-11-11）是强制更新被覆盖的。要做三方合并得先 `git fetch upstream --unshallow` 或按 e4a73d7b 取，**这一步我没做** |

### 4.3 上游里的 openbot 字样规模（`upstream/main` bdb6280d8，`git grep`）

| 指标 | 数量 |
|---|---|
| 文件数 / 行数 | 2 087 / 25 420（共 5 425 个文件） |
| `OpenBot` / `openbot` / `OPENBOT` / `openBot` | 18 319 / 8 249 / 2 267 / 58 次 |
| 路径含 openbot 的文件 | 28 |
| `@openbot/*` | 414 次；包：`shared` 385、`tokens` 10、`management-agent` 7、`recorder-extension` 6、`example-mastra-bot` 2 |
| `OPENBOT_*` 不同名字 | 264 |
| `x-openbot-*` | `agent-token` 91、`singleton` 134、`scheduled-work` 23、`install-token` 11、`desktop-host-token` 3、`bot-id` 3、`recorder-bot` 3 |
| `open.bot`（域名） | 942 |
| `copilotkit`（不分大小写，总数） | 3 947（熊宝 `xiongbao/` 3 891） |
| 同一行里既有 openbot 又有 copilotkit | 994 行 |
| 按顶层目录（行） | desktop 3 344、app 1 129、extension 865、scripts 329、tests 322、management-agent 247、api 246、docs 228、shared 165、CHANGELOG.md 108 |

### 4.4 能用确定的文本替换表做的

| 类 | 例子 | 方法 | 备注 |
|---|---|---|---|
| 包名/导入路径 | `@openbot/shared` → `@<新名>/shared` | 带词界替换 | `bun.lock` 要重新 `bun install` 生成，不能直接 sed（hash） |
| 标识符 | `OpenBotRole`→`XiongBaoRole`、`openbotUrl`→`xiongbaoUrl` | 逐大小写变体：`OpenBot`→`XiongBao`、`openBot`→`xiongBao`、`openbot`→`xiongbao`、`OPENBOT`→`XIONGBAO` | 对 506 个现存词做过映射，**36 个映射后会和熊宝已有的词相同**：29 个是环境变量别名（本来就该合并）、`xiongbaoModel`（`scripts/e2e/employee-eval/config.ts:89` 与上游 `openbotModel`）、`XiongBao`、`xiongbao_model`、`xiongbao`/`xiongbao_` 等。同名不同义会出现重复声明 |
| 环境变量 | `OPENBOT_X`→`XIONGBAO_X` | 可替换，但 `OPENBOT_*_V1` 的 5 个加密常量必须排除 | 要有排除清单 |
| 文件名/目录名 | `charts/openbot/`→新名、`openbot-actor.ts`→… | 路径映射，合并前对上游树整体 `git mv` | 58 个路径与熊宝现有路径无冲突；上游新增的路径靠同一张表 |
| 英文品牌词 | 注释里的 `OpenBot`（5 651 处） | 可换成产品英文名 | 但界面文案必须走 `brand.ts` 出口（`brand-exit.test.ts`），**不能机械替换成「XiongBao」**——熊宝的 `english_name` 是 `XiongBao Work`，短名「熊宝」，中文界面、复数、所有格（`OpenBot's`）都要人看 |
| 测试里的域名样例 | `openbot.test`、`openbot.example.com`、`admin@openbot.local` | 可换 | 部分测试故意拼旧值证明兼容，换了就失去意义 |

### 4.5 不能（或不该）用替换表的

| 情况 | 数量/位置 | 为什么 | 按许可证是否必须保留 |
|---|---|---|---|
| 版权与许可证文字 | `xiongbao/LICENSE:3` `Copyright (c) 2026 CopilotKit`（本文件里 `openbot` 0 次）；`xiongbao/NOTICE:3` 「derived from OpenBot」（1 次）；上游 `LICENSE` 同。`THIRD-PARTY-NOTICES.md` 0 次 | MIT 要求保留**版权声明和许可文本**（版权人是 CopilotKit，不是 OpenBot 这个名字）。`CopilotKit` 绝不能进替换表。「derived from OpenBot」这句不是 MIT 条款要求的措辞，改不改是**产品/法务决定**；本摸底不做法律判断 | 版权人名与许可正文必须保留；产品名可不写 |
| 第三方名字里的 copilotkit | `@copilotkit/*`（`openbot` 与 `copilotkit` 同行 994 行） | 依赖库名，改了等于换库 | 无关品牌，但属于第三方保留（`brand-artifacts` 已有 `third-party-name` 分类） |
| URL | 上游里含 openbot 的 URL 行 543；`github.com/CopilotKit/OpenBot` 120 次；`downloads.copilotkit.ai/latest/OpenBot-*.dmg/.exe` 150 次；`ghcr.io/copilotkit/charts/openbot*`；`dashboard.operations.copilotkit.ai/early-access/openbot` | 替换后指向不存在的地址；这些是上游的发布渠道，不是我们的 | 无 |
| `open.bot` 域名 | 上游 942 次（API 错误类型 URI）、熊宝 14 次 | 不含 `openbot` 字串，替换表不会命中；若表里写了 `open.bot` 会改坏上游 API 契约（`api/` 规范与生成客户端） | 无；这是一个设计问题：错误类型 URI 要不要换成熊宝自己的域名 |
| CHANGELOG 历史条目 | 上游 `CHANGELOG.md` 108 行；熊宝 `xiongbao/CHANGELOG.md` 131 行（已被熊宝按自己的版本号重写，含大量上游历史） | 历史描述的是当时发生的事，替换后会改写史实；熊宝已改写成中文版 CHANGELOG | 许可证不要求保留 CHANGELOG |
| 上游整栈桌面 `desktop/` | 非测试 3 485 行，bundle id `ai.copilotkit.openbot.desktop`、原生宿主 `ai.copilotkit.openbot.recorder`、`Cargo.toml` 名 | 不交付；改了会让后续合并整目录冲突，也无收益 | 无；现有护栏整目录豁免 |
| 加密/DB/协议已持久化名 | 见 2.4、2.5、2.3 | 机械替换会直接弄坏旧数据 | 无 |
| 外部 id | 扩展 id `icpcnhgj…`、`shared/recorder-extension.json` 的 `nativeHost` | 是 Chrome 的身份 | 无 |
| 误伤例子（已查到） | ① `extension/public/managed_schema.json` 现有 `XiongbaoUrl` 与 `OpenBotUrl` 两个键；对上游版本整体替换会变成**重复键**（JSON 后者覆盖前者，且失去旧键兼容）；② `shared/env-aliases.ts` 里的 `LEGACY_PREFIX = "OPENBOT_"`、`NEW_PREFIX = "XIONGBAO_"`——自动替换会把旧前缀也替换成新前缀，别名机制自己失效；③ `scripts/brand/guard/*.ts`、`app/tests/brand-*`、`docker/tests/env-aliases.test.sh` 故意拼旧名；④ `container-images.json` 的 `images.openbot` | | |
| 上游新增的、熊宝没有的词 | `x-openbot-singleton`（134）、`scheduled-work`、`install-token` 等 | 表要随上游更新补；漏一个就会在合并后冒出旧名，所以需要护栏兜底 | |

### 4.6 实施上要提前想清楚的几点（给设计稿用）

1. **改名表必须同时作用于三棵树**才能三方合并：旧同步点 e4a73d7b、上游目标、本仓库；否则合并基点和对方都含旧名、我方是新名，每一行都冲突。就是说要用「改名后的 e4a73d7b」当共同祖先，需要保证同一张表对 e4a73d7b 产生的结果与我方已改名的结果在未改动处一致。
2. **表要有「排除清单」**（加密串、持久化名、`copilotkit`、URL、`LICENSE`/`NOTICE`、历史迁移 SQL、`server/drizzle`、`desktop/`）和**文件级覆盖**（如 `managed_schema.json`、`env-aliases.ts` 这类熊宝改过兼容层的文件，合并时按我方为准）。
3. **本仓库的 `server/` 等 14 个上游已删目录不会再有上游输入**：只对 app、extension、desktop、shared、mobile、agent-*、api、docs、tokens、management-agent 有同步价值。`server/` 在 UPSTREAM.md 里的 M5a 之后一直是熊宝独立维护的状态，应在设计稿里写明「冻结后的 server 以熊宝为准」。需要弄清上游把后端搬到哪了（本摸底只能看到公共仓库树，没有看到原因）。
4. 上游已经自己改变了迁移与 API 规则（`docs/api-and-migrations.md`：API 12 个月内不能破坏，迁移不得删东西）；上游当前 CHANGELOG 的迁移已到 `0164_schedules_held_by_move`，而熊宝是 overlay 编号（`0239_aihub_provider_template` 是最新）。改名不影响编号，但「上游迁移 → overlay」的人工改编这一步无法自动化。

---

## 5. 现有品牌护栏在全改名后怎么变

现状（实测）：allowlist `xiongbao/app/tests/brand-leak-allowlist.json` 170 条（`persisted-data/keep` 90、`peer-protocol/keep` 33、`third-party-name/keep` 20、`parsed-exact-text/keep` 11、`developer-only/keep` 9、`upstream-shell-only/keep` 4、`operator-visible/rewrite` 3）；预算 `brand-budget.json` 60 行 1 166 行（`identifier` 512、`openbot-package` 397、`env-name` 74、`copilotkit-package` 69、`copilotkit-handle` 35、`never-change` 17、`crypto-name` 14 …）；词表 `app/tests/brand-artifacts/*.json` 共 199 条（web 79、docs 53、extension 41、deb 11、runner 7、image-files 6、image-logs 2、image-config 0）；棘轮批准 `scripts/brand/guard/ratchet-approvals.json`；护栏脚本共 11 个文件约 2 000 行（`scripts/brand/guard/*.ts`、`scan-artifact.ts`、`metrics.ts`）；测试 13 个 `app/tests/brand-*.test.ts`。

| 护栏 | 现在做什么 | 全改名后 |
|---|---|---|
| **brand-leak**（`scan.ts` + `brand-leak.test.ts`，`BRAND = /OpenBot|CopilotKit|copilotkit\.ai|qoder/i`） | 扫源码，用 `RULES`（identifier、`@openbot/`、OPENBOT_ 环境名等 14 条）抹掉允许的形状，剩下的必须在 allowlist 里；allowlist 只许缩 | **规则反转**：`identifier`（512 行）、`openbot-package`（397）、`env-name`、`import-*` 这些「放行」规则整体删除，因为这些位置不再有旧词，旧词出现就是漏网。保留的只有 `never-change`/`crypto-name`/`wire-dom`（加密串、持久化名、双认的旧名），以及 `copilotkit-*`（第三方库）。allowlist 的 90 条 `persisted-data` + 33 条 `peer-protocol` 变成真正的「永久保留清单」，`operator-visible/rewrite` 清零。`BRAND` 里的 `OpenBot` 要保留（它就是要抓的词），但还要新增「禁止出现旧名」的**位置**分类：哪些文件里可以出现（兼容层、迁移、加密常量、LICENSE/NOTICE、`UPSTREAM.md`、`desktop/`、`archives/`） |
| **EXEMPT_PATHS**（`scan.ts:244-269`） | 豁免 `desktop/`、`server/drizzle/`、`generated/`、测试、`brand.ts`、`charts/` | `charts/` 不再需要豁免（要改）；测试不再整体豁免，改为只豁免登记过的「故意拼旧名」的测试；`server/drizzle/` 和 recovery SQL 继续豁免；`desktop/` 继续豁免或同样纳入 |
| **brand-budget**（`brand-budget.json`，只许降） | 记录各规则抹掉了多少行，只准降不准升 | 1 166 → 近 0（只剩加密/持久化/双认少数几项）。预算变成「兼容层词典」：每行对应一个有 `removeIn` 的兼容点，到期自动要求降到 0 |
| **brand-new-lines**（`new-lines.ts`、`brand-new-lines.test.ts`） | PR 新增的行不许带旧名，**除非上游同路径有同一行**（同步带进来的行豁免） | 豁免反过来了：同步 PR 带进来的是**已被改名表处理过的**上游行，所以「上游同路径同一行」的比较要**先对上游文件应用改名表再比较**，否则每条上游行都不相等；并增加「改名后的上游树里仍有旧名」的检查，用来发现改名表漏掉的新词（如 `x-openbot-singleton`）。同步点校验（`upstream-sync.json` 能否从上游取到）保留；浅克隆/强制更新下取不到要给出明确提示（本次就遇到上游强制更新） |
| **brand-docs**（`brand-docs.test.ts`，扫 README、`*-xiongbao.md`、`delivery.env.example`、`compose.delivery.yml` 的词表 `brand-artifacts/docs.json` 53 条） | 部署文档只能出现登记过的旧词（如 `$OPENBOT_IMAGE`、`$OPENBOT_TAG`） | 53 条里大部分是 `OPENBOT_*` 命令行变量，改名后删；留下的只有「旧名仍可用」的说明句，且要求带 `removeIn`。文档范围扩大到全部对客户的文档（`xiongbao/docs/*`），不再只扫 `-xiongbao.md` 结尾的文件 |
| **brand-artifacts**（`scan-artifact.ts`，web/extension/runner/image-files/image-config/deb 六类产物；CI `ci.yml:288-320,643-644`） | 扫构建产物，产物里的词必须在词表里，词表只缩 | 词表 199 条里 `third-party-name`（`@copilotkit` 等）永久保留；`persisted-data`（`openbot_app`、`openbot_role_writer`、加密串）保留；`operator-visible/rewrite`（`OPENBOT_`、`<build-path>` 等）清零。这一层是**最有价值的**，因为它扫的是客户实际拿到的东西，不受源码改名表漏洞影响；建议继续保留并把「出现旧词即失败」作为默认，只靠词表豁免 |
| **legacy-compat 到期**（`brand-expiry`、`brand-legacy-compat-expiry`、`compat-comments.ts`） | 兼容点在 allowlist 或源码注释里登记 `introducedIn/removeIn`，到版本就失败 | 这是全改名的**主要安全阀**，用量会从现在的约 0 条（0.2.15 已删完）升到几十条：每个双认点（环境变量、头、扩展消息、策略键、存储…）都要一条。建议约定：环境变量单独一个「长期兼容」类（不到期或至少两个大版本），其余按版本到期 |
| 白名单分类（`allowlist.ts` 的 `CATEGORIES`/`PLANS`） | 9 类 | 增加类别：`rename-exception`（改名表排除项，含理由）和 `upstream-owned`（上游自有的 URL、域名、渠道）。`operator-visible/rewrite` 在第一次全量改名后应该为空 |
| **改名表本身的护栏**（新增） | 现在没有 | 需要：① 表的单元测试（每个变体、词界、排除项）；② 「对 e4a73d7b 应用表后再对我方树做三方合并是否零冲突」的演练；③ 改名后上游树的剩余旧词报告（等价于现在的 allowlist 扫描，但对象是上游树）；④ 表与 `NEVER_CHANGE`/`SIGNING_DOMAINS`/`CRYPTO_NAMES` 的一致性测试（排除清单里的串在我方树里必须原样存在） |

---

## 6. 还需要确认的事

1. 上游为什么在 2026-11-11 到 11-13 之间把 `server/` 等目录移出公共仓库？这决定「保留上游升级」到底能覆盖多少。
2. 京东云现网 `.env.delivery` 里是 `OPENBOT_*` 还是 `XIONGBAO_*`；现网数据卷里的超级用户/库名；是否有客户在用 Helm、托管 Bot 镜像、已装浏览器扩展与设备端（各版本）。
3. 新英文品牌名定哪个：`xiongbao`（代码标识）与 `XiongBao Work`（`brand.yaml` 的 `english_name`）并存，替换表里 `OpenBot` 在不同上下文（标识符、界面句子、所有格）要映射到哪种写法。
4. 本摸底没有逐个核对的：设计稿 2.3 表二那 9 个旧存储键是否已处理；日志里的品牌字样总数（分散在 `console.*`/`throw new Error`，没有单独数）；`archives/`（294 个文件）预期不改。
5. 本文件没有做法律判断；LICENSE 与 NOTICE 的措辞（「derived from OpenBot」）是否保留请法务/产品定。
