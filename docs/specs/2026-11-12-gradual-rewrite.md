# 熊宝「逐步重写」设计稿（按可见度分层）

状态：用户已同意（2026-11-12）；第 9 节 10 个问题全部按建议执行，见第 9 节末「用户决定」
日期：2026-11-12
依据：用户决定（2026-11-12）：
1. 目标是**看起来像原创**：客户和客户的技术人员在交付物里看不到上游痕迹；同时**持续同步上游 OpenBot**，MIT 义务照常履行。
2. 采用方案 A「按可见度分层」：第 1 层交付物可见面先清；第 2 层源码随改随清；第 3 层护栏升级。
3. HTTP 头、存储键会新旧版本混跑：新旧名字都接受一个版本，下下个版本去掉旧名。

前序：品牌去痕规格 `docs/specs/2026-11-11-brand-removal.md`（第 7 问「逐步重写另写设计稿」）、计划 `docs/plans/2026-11-12-brand-removal.md`。品牌去痕已随 #472 合入 main，首次进入 **v0.2.9**（`git merge-base --is-ancestor ebde8f59 v0.2.8` 为否）。

盘点基线：分支 `docs/gradual-rewrite-spec`，基于 main `d51b1e3c`。下文路径**除特别注明外都相对 `openbot/`**；仓库根的文件写作 `<根>/…`。「行」指 `grep -c` 的匹配行数，不是出现次数。

---

## 0. 一句话

品牌去痕清掉了「客户在界面上看得见」的上游名字；这一阶段把范围扩大到「客户的**技术人员**打开开发者工具、`docker inspect`、`docker exec`、安装目录、日志、网络抓包时看得见」的地方，并把护栏从「扫源码」升级为「扫交付物」。代码内部的目录名、包名、上游类型名照旧不动，好让同步上游几乎不起冲突。

---

## 1. 目标与不做的事

### 1.1 目标

1. **交付物可见面**（第 1 层）不出现上游名字：浏览器开发者工具（请求头、cookie、本地存储、IndexedDB、控制台、产物字符串）、镜像（`docker inspect` 的 ENV 与 LABEL、`docker exec` 看到的文件名与路径、启动日志）、设备端安装包（文件名、注册表、进程名、`--help`）、浏览器扩展（清单、企业策略键、注入网页的元素）、给客户的部署文档和样例配置。
2. 需要改名的协议值（请求头、存储键、cookie、文件名、策略键）**新旧两个名字都接受一个版本**，下下个版本再删旧名；删旧名的时间点由测试强制，不靠人记。
3. 熊宝自有文件和熊宝改过的行（第 2 层）不再引入上游名字。
4. 护栏（第 3 层）扫描构建产物、镜像文件清单、安装包内容；对新增行做「不得引入」检查；白名单补上分类和处理去向，**剩余工作量可以直接从白名单读出来**。
5. 环境变量：`OPENBOT_*` 继续兼容读取；文档、样例、安装包、界面提示、启动报错只写 `XIONGBAO_*`。

### 1.2 不做的事

| 不动的东西 | 为什么不动 |
|---|---|
| 目录名 `openbot/` | 上游同步用三方合并（`UPSTREAM.md`「同步方法」），每个上游文件路径都在它下面；一改，每次同步都是整棵树改名。 |
| 包名：根 `package.json` 的 `"name": "openbot"`、`@openbot/*` 工作区包 | 全部 `private`；改了每次同步都冲突。镜像里能看见的问题用第 9 节第 2 问（是否继续把源码放进镜像）解决，不靠改包名。 |
| 上游文件里的类型名、函数名、变量名（如 `OpenBotRole`、`OPENBOT_HARNESS_NAME`、`selectOpenBotManualChunk`） | 同上。只有打包压缩后不再出现在产物里的才算「看不见」；看得见的靠第 1 层处理**值**，不处理**名字**。 |
| 加密/签名域串、持久化标记、数据库名与角色名、历史迁移、K8s 标签 | 品牌去痕规格 1.2 节已列明：改了会坏数据。护栏继续断言它们原样存在（`app/tests/brand-leak.test.ts` 的 `NEVER_CHANGE`、`SIGNING_DOMAINS`、`WIRE_HEADERS`）。 |
| 第三方库自带的名字（`@copilotkit/*` 的类名、日志前缀、文档链接） | 那是依赖库的名字，不是上游 OpenBot 的品牌；改它等于换库（见第 9 节第 9 问）。 |
| 上游桌面整栈安装器 `desktop/` | 已决定不交付（品牌去痕计划「用户决定」第 1 条）；护栏继续整目录豁免。 |
| 上游文档 `docs/`（上游部分）、`CHANGELOG.md`、`README.md` | 已决定不给客户；仓库内保持原样。 |

### 1.3 判断原则

- 客户或客户技术人员**不用读源码**就能看见 → 第 1 层，本阶段改。
- 只有读源码才看见 → 第 2 层：熊宝自有文件和熊宝改动的行要干净，上游原样的行不动。
- 改了会坏数据或断开已部署的对端 → 保留，进白名单，分类写清楚。
- 镜像里带了源码，「读源码」就等于「`docker exec` 看一眼」——这条把第 1、2 层连在一起，见 2.1 节发现 2 和第 9 节第 2 问。

---

## 2. 现状清单（盘点）

### 2.1 先说三个影响全局的发现

**发现 1：仓库是公开的，客户的部署脚本直接从它下载。**
- `gh api repos/canquedehuiyi-cpu/xiongbaowork --jq '{private, visibility}'` → `{"private":false,"visibility":"public"}`。
- 客户部署文档让客户从这个仓库拉文件：`<根>/README.md:76` 下载 `raw.githubusercontent.com/canquedehuiyi-cpu/xiongbaowork/$OPENBOT_TAG/openbot/docker/delivery.env.example`（URL 里就有 `openbot` 目录名）；`docs/deployment-xiongbao.md:42` 从同一仓库的 Release 下载 `container-images.json`。
- 设备端安装包也发在这个仓库的 GitHub Release 上（`<根>/.github/workflows/device-release.yml:1` 注释「installers on a GitHub Release」）。
- 镜像的 OCI 标签 `org.opencontainers.image.source` 指向仓库地址（`<根>/.github/workflows/release.yml:143`）。
- 仓库里有 `UPSTREAM.md:3`「本目录（`openbot/`）是 CopilotKit/openbot 的二次开发版本」。

只要仓库公开，客户技术人员顺着文档里的链接一步就能看到全部上游痕迹，前面各层的工作都会被绕过。→ 第 9 节第 1 问。

**发现 2：交付镜像里带着完整的 TypeScript 源码和测试。**
- `Dockerfile:196-201` 把 `server`、`shared`、`toolkit`、`examples`、`agent-computer/src` 整目录复制进运行镜像；`.dockerignore` 只排除 `node_modules`、`.env*`、`dist` 等，不排除测试。
- 这些目录里 `openbot|copilotkit|qoder`（不分大小写）的行数：`server` 5 428（其中 `server/tests` 3 637、`server/src` 1 464）、`shared` 295、`toolkit` 92、`agent-computer/src` 146、`examples` 37。命令：`git ls-files <目录> | xargs grep -oiE "openbot|copilotkit|qoder" | wc -l`。
- 可行性试验：`bun build server/src/index.ts --target=bun --minify --packages=external` 158 ms 构建成功，产出单文件 2.65 MB，其中 `openbot` 471 次、`copilotkit` 84 次（多为 `@openbot/*` 导入路径、`OPENBOT_*` 名字、协议值）。**只验证了能构建，没验证能运行**（迁移 SQL、`recovery/`、动态导入要按文件读取）。

→ 第 9 节第 2 问。

**发现 3：现有护栏看到的「剩余工作量」比实际少很多，而且有 10 条白名单理由写错了。**
- 护栏扫描范围内（1 662 个文件）带品牌字样的行共 2 986 行：注释 1 585 行直接跳过；代码 1 401 行里 1 150 行被 `RULES` 整块抹掉；剩下 251 行由白名单 194 条覆盖。各规则抹掉的行数：标识符 464、`@openbot/*` 包名 397、导入路径 328+157、`OPENBOT_*` 169、`@copilotkit/*` 69、小写 `copilotkit` 35、`x-/data-openbot-*` 23、不改串 17、`/api/copilotkit` 8、其他 5（用临时脚本复用测试里的 `RULES`/`codeLines` 统计）。
- 其中 `OPENBOT_\w*` 一条规则同时抹掉了**环境变量名、给运维看的报错里的变量名、发到浏览器的错误码**（如 `OPENBOT_MODEL_AUTH_REQUIRED`），后两类恰恰是第 1 层要改的。
- 白名单现在是 **194 条**（不是 196 条：`e1570e7c` 时是 196，`37246ea0` 删到 194，见 `git log -- app/tests/brand-leak-allowlist.json`）。每条都**有**分类：分类写在 `reason` 字段开头（`persisted-identifier: …`），由测试「allowlist entries name a known category and a note」校验（`brand-leak.test.ts` 的 `CATEGORIES`，8 个值）。没有的是**独立的 `category` 字段**和**处理去向**。现状分布：`persisted-identifier` 138、`internal-log` 16、`external-name` 14、`parsed-exact-text` 11、`developer-only` 6、`internal-error` 5、`upstream-shell-only` 4。
- 有 10 条理由写「legacy browser storage key, read once by readMigrated」，但对应文件**根本没调用 `readMigrated`**，代码仍在用旧键读写（见 2.3 节表二）。

### 2.2 `x-openbot-*` 请求头

命令：`grep -rnE "x-openbot-|X-OpenBot-|X-Openbot-" --exclude-dir=node_modules`，按头名、按源码/测试分组。

| 头 | 发送方 | 读取方 | 链路 | 客户能看见吗 |
|---|---|---|---|---|
| `x-openbot-agent-token` | 服务器：`server/src/agents/routes.ts:842`、`agents/runtime-agents.ts:74`、`agents/plan-model.ts:235,299`、`model-catalogue.ts:355`；Bot 回调服务器：`agent-langgraph/src/index.ts:263`、`agent-langgraph-agui/src/tool_runtime.py:456` | 14 个 Python 框架各一份常量（如 `agent-adk/src/main.py:36`、`agent-crewai/src/main.py:35`…共 12 个 `main.py` + `tool_runtime.py`）、`agent-mastra/src/mastra/index.ts:174`、`shared/agent-authorisation.ts:18`；服务器 `app.ts:2527`、`copilot.ts:459,1907,3067` | 服务器 ↔ 托管 Bot 容器 | 只能抓包看见。托管 Bot 框架只在组件镜像里（`.github/published-images.json`），京东云单镜像不含 |
| `x-openbot-bot-id` | 服务器 `computer/client.ts:264`、`computer/provider.ts:209`、`computer/policy-network.ts:221`；CI 脚本 `scripts/ci/per-bot-users-smoke.sh:47` | `agent-computer/src/index.ts:270` | 服务器 → agent-computer | 单镜像里走 `127.0.0.1:4100`（`Dockerfile:345`），只能在容器内抓包看见；但 agent-computer 的**报错文字**会说出头名：`agent-computer/src/bot-browser-host.ts:79`、`browser-host.ts:460`、`real-browser.ts:406` |
| `x-openbot-person-id` | 服务器 `computer/client.ts:265`、`computer/provider.ts:211` | `agent-computer/src/index.ts:274` | 同上 | 同上 |
| `x-openbot-computer-token` | 服务器 `browser/routes.ts:470`、`computer/policy-network.ts:108,223`、`computer/client.ts:314`、`computer/provider.ts:237` | `agent-computer/src/authorisation.ts:38` | 同上 | 同上 |
| `x-openbot-egress` | agent-computer 出网代理拒绝时的**响应头**：`agent-computer/src/egress.ts:831,1015` | Bot 的浏览器 | agent-computer → Bot 浏览器 | 在 Bot 浏览器里打开开发者工具才看得见 |
| `x-openbot-desktop-host-token` | 上游桌面 `desktop/src-tauri/src/desktop_connection.rs:26` | 服务器 `desktop-connection-failure.ts:41` | 上游桌面 → 服务器 | `desktop/` 不交付 |
| `x-openbot-voice`、`x-openbot-dictation` | **已改完**：网页改发 `x-xiongbao-*`（`app/src/lib/voice/webrtc.ts:116`、`voice/websocket.ts:124`、`voice/archive.ts:105`、`dictation/recording.ts:118`） | 服务器新旧都认：`server/src/browser-request-marker.ts:11` | 浏览器 → 服务器 | 旧名只剩服务器兼容读取，v0.2.9 起算窗口期 |
| `x-openbot-recorder-bot`、`x-openbot-build-version`、`x-openbot-probe` | 只出现在测试（`server/tests/recorder-trajectory-gate.test.ts:202`、`server/tests/release-status.test.ts:81`、`server/tests/composio-transport.test.ts:1220`、`extension/tests/*`） | 源码不读 | — | 否 |
| `X-Openbot-Test-Network-Guard` | 测试工具 `server/scripts/test-network-guard.ts:336` | — | — | 否 |

结论：
- **设备端（`desktop-device/`、`runner/`）不发送也不读取任何 `x-openbot-*` 头**（对这两个目录 grep 为空）。用户决定里「服务器和设备端同时接受新旧名字」对请求头这一项**落不到设备端**，设备端没有混跑问题。
- 浏览器能看见的两个头已经改完。剩下的都是**服务之间的内部头**，客户只能在容器里抓包或读源码时看见。要不要改见第 9 节第 3 问。

### 2.3 cookie、浏览器存储、IndexedDB

**表一：已经改名并兼容旧名的（品牌去痕 P7，提交 `61e4f0e0`）**

| 对象 | 新名 | 旧名处理 | 依据 |
|---|---|---|---|
| cookie | `xiongbao.organization-session` | 读新旧两个，写新名，登录/退出时清旧名 | `server/src/auth/organization.ts:8-12,196,323,381`；录制器 `server/src/recorder/wiring.ts:209-210` |
| localStorage | `xiongbao-theme`、`xiongbao-skin`、`xiongbao-sidebar`、`xiongbao-sidebar-width:*`、`xiongbao-sidebar-more`、`xiongbao-sidebar-view`、`xiongbao-notify-prompt-answered` | `readMigrated`：读新键，没有就读旧键、写新键、**删旧键** | `app/src/lib/storage-migrate.ts:9,21-22`；首屏前的内联脚本 `app/index.html:14-29` |

**表二：仍然在用旧名读写的（白名单理由写的是「已迁移」，实际没有）**

命令：对白名单里理由含 `readMigrated` 的条目，检查对应文件是否调用 `readMigrated`。

| 键 | 存储 | 依据 |
|---|---|---|
| `openbot.reachability.pendingSms` | sessionStorage | `app/src/components/delivery/reaching-you.tsx:66,69-77`、`components/reachability/link-conversation-dialog.tsx:34,37-45` |
| `openbot.wakerflow-share-return` | sessionStorage | `app/src/lib/wakerflows.ts:1315,1322-1331` |
| `openbot:pending-handoff:<botId>` | sessionStorage | `app/src/lib/computers/handoff.ts:17,22,44` |
| `openbot.teach-a-bot.introduced` | localStorage | `app/src/components/browser/teach-steps.tsx:31,39,47` |
| `openbot:computer-activity-wiped:<id>` | localStorage（还监听 `storage` 事件按前缀匹配） | `app/src/lib/computers/activity.ts:117,186,199,218` |
| `openbot:voice-outbox:<…>` | localStorage | `app/src/lib/voice/outbox.ts:5,12,21` |
| `openbot:carried-on:<toolCallId>` | localStorage | `app/src/lib/copilot/carry-on.ts:40,48,59` |
| `openbot:check-in-declined:<toolCallId>` | localStorage | `app/src/lib/copilot/check-in-offer-tool.tsx:50,54,62` |
| `openbot.bot-thread.<agentId>` | localStorage | `app/src/lib/copilot/bot-thread.ts:25,29,34,43` |

**表三：存储里的「值」**

| 值 | 位置 | 说明 |
|---|---|---|
| 默认皮肤 id `"openbot"` | `app/src/skins/registry.ts:13`、`shared/user-preferences.ts`（`DEFAULT_SKIN`）、`app/index.html:30`（`skin !== "openbot"`） | 存在 `xiongbao-skin` 键的**值**里，也存在服务器的用户偏好里 |

**IndexedDB**：网页（`app/src`）不用 IndexedDB（grep `indexedDB|openDB|idb-keyval` 为空）。录制扩展用 `"openbot-recorder"`：`extension/src/shared/database.ts:1`。

**其他开发者工具里看得见的**（不是存储，但同类）：
- 浏览器通知 tag：`openbot-learned-*`、`openbot-attention-*`、`openbot-ping-*`、`openbot-<channelId>`（`app/src/components/browser/learning-next.tsx:244`、`components/bot-profile/attention.tsx`、`lib/notifications/show.ts`）。
- DOM：`id="openbot-secret"`（`app/src/components/computer/computer-view.tsx:931,937`）、`data-slot="openbot-version"`（`components/layout/openbot-version.tsx:17`）、`data-orb="openbot"`（`components/onboarding/demo-orb.tsx:27`）、CSS 类 `.openbot-markdown`、`.openbot-breakdown`（`app/src/styles.css`、`lib/copilot/a2ui-markdown.tsx`、`a2ui-breakdown.tsx`）。
- 控制台：`console.warn("OpenBot couldn't reach its back end.")`（`app/src/lib/copilot/stopped-turn.ts`，白名单 `internal-log`）。
- 上游桌面才会触发的：`window.__OPENBOT_WS_PORT__`（`app/src/lib/socket-url.ts:19-26`）、事件名 `openbot:open`（`lib/desktop/open-requests.ts:8`）、`plugin:openbot-desktop`（`lib/desktop/queries.ts`）——`desktop/` 不交付，网页里这些分支在普通浏览器中不执行，但字符串在产物里。

### 2.4 镜像、`docker/`、`charts/`、compose

交付给京东云的是根 `Dockerfile` 构建的单镜像，用 `docker/compose.delivery.yml` 启动（`<根>/.github/workflows/release.yml:137-145` 构建、推送）。

**镜像里的路径和文件名**

| 项 | 依据 | 客户怎么看见 |
|---|---|---|
| `/usr/local/sbin/openbot-apt`，sudoers 规则 `pwuser ALL=(root) NOPASSWD: /usr/local/sbin/openbot-apt` | `Dockerfile:279-287`；脚本 `docker/openbot-apt:5-6,43-44`（用法提示里写 `sudo openbot-apt`）；测试 `docker/tests/xb-bot.test.sh:122-136`（根 CI `image` job 在 `ci.yml:335` 运行它）；`openbot/.github/workflows/ci.yml:856-929` 也有断言，但那是上游副本，不运行 | `docker exec`、Bot 终端里 `sudo -l` |
| `/app/**` 源码树、`/app/package.json`（`"name": "openbot"`）、`/app/node_modules/@openbot/*` | `Dockerfile:184-201` | `docker exec ls /app`，见 2.1 发现 2 |
| `/etc/openbot/sandbox-template.json`（配置默认路径） | `server/src/config.ts:1604` | 只有 Helm chart 挂载；单镜像里不存在，但启动报错会说出这个路径 |
| `/licenses/`（`LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md`） | `Dockerfile:223-224` | 应该看见（MIT 义务） |
| Bot 终端：`PROMPT_COMMAND=__openbot_prompt`、临时目录 `.openbot-shell-*`；Windows 输出流变量 `$openbotOut` | `agent-computer/src/live-shell.ts:209-220,420`、`agent-computer/src/shell.ts:1030` | 在员工的实时终端里敲 `echo $PROMPT_COMMAND`、`ls /tmp` |
| 登录态文件 `openbot-session-cookies.json` | `agent-computer/src/session-cookies.ts:28` | `/profiles` 卷里 |
| 内置数据库名 `openbot`、角色 `openbot_app`、`openbot_role_writer`，默认密码 `"openbot"` | `docker/s6/scripts/postgres-init.sh:58-98`、`docker/s6/scripts/migrate.sh:23-50`、`server/src/auth/role-writer-lifecycle.ts` | `psql`、容器里 `ps` 看到的 postgres 进程标题。**保留**（会坏数据） |

**`docker inspect` 看得见的 ENV**（最终阶段）：
- `OPENBOT_SELF_HOST_BANNER=false`（`Dockerfile:227`）
- `OPENBOT_RLS_ENFORCE=refuse`（`Dockerfile:381`）
- `OPENBOT_BUILD_VERSION`、`_COMMIT`、`_DISTRIBUTION_ID`、`_REPOSITORY`、`_CHANNEL`（`Dockerfile:385-394`）
- `OPENBOT_IN_CONTAINER=true`（`Dockerfile:400`）
- `COPILOTKIT_TELEMETRY_DISABLED=1`（`Dockerfile:404`，第三方库的变量名）

**LABEL**：所有 Dockerfile 都没有 `LABEL`（`grep -n LABEL Dockerfile */Dockerfile` 为空）；发布时由 `<根>/.github/workflows/release.yml:142-145` 加 `org.opencontainers.image.source/revision/version` 三个；`provenance: true`、`sbom: true`（`:146-147`）——SBOM 会列出 `openbot`、`@openbot/*` 包名。

**Dockerfile 注释**：`Dockerfile:1`「# OpenBot, whole, in one container.」等。注释不进镜像层；只有在仓库公开（发现 1）或把 Dockerfile 交给客户时才可见。`docker history` 能看到 `RUN` 命令本身（含 `/usr/local/sbin/openbot-apt`）。

**发布清单**：`container-images.json` 的键是 `images.openbot`（`<根>/.github/workflows/release.yml:354`），客户文档按这个键取值：`docs/deployment-xiongbao.md:43,117,231`（`jq -r .images.openbot.reference`）。

**交付 compose 与样例配置**：
- `docker/compose.delivery.yml:5,10` 用 Compose 插值 `${OPENBOT_IMAGE:-…}`、`${OPENBOT_PORT:-3772}`；这两个是 Compose 在宿主机上读的，**不经过** `XIONGBAO_` 别名。
- `docker/delivery.env.example:2-9` 已注明「配置名用 `XIONGBAO_` 前缀；旧前缀仍可用」，但 `OPENBOT_IMAGE` / `OPENBOT_TAG` 例外仍是旧名；`:26-32` 介绍 CopilotKit Intelligence（第三方服务，属实）。
- 客户文档仍满是旧名：`<根>/README.md` 18 处 `OPENBOT_`、0 处 `XIONGBAO_`；`docs/deployment-xiongbao.md` 25 处 / 0 处；`docs/development-environment-xiongbao.md` 10 处 / 0 处；`.env.example` 30 处 / 0 处（命令：`grep -o "OPENBOT_[A-Z0-9_]*" <文件> | wc -l`）。

**`charts/openbot/`**：整套是上游的。`Chart.yaml` 写 `name: openbot`、`description: Run OpenBot on …`、`home/sources: https://github.com/CopilotKit/OpenBot`、`maintainers: CopilotKit`；`values.yaml:14` 镜像 `ghcr.io/copilotkit/openbot`。品牌去痕阶段决定不动 Helm chart；是否交付见第 9 节第 6 问。

**开发用 `docker-compose.yml`**：库名/用户/密码 `openbot`（`:17-19`）、镜像 `openbot-server:latest`（`:66,104`）、`.openbot/` 挂载（`:204-205`）。只给开发者用。

### 2.5 设备端（`desktop-device/`）与桌面客户端（`desktop/`）安装包

**设备端：基本干净。**
- `tauri.conf.json`：`productName` 熊宝数字员工 设备端、`mainBinaryName` `xiongbao-device`、`identifier` `com.xiongbao.device`、窗口标题、`shortDescription`、`longDescription` 都是熊宝；图标指向本目录 `icons/`；版权 `Copyright (c) 2026 熊宝; portions Copyright (c) 2026 CopilotKit (MIT)`（`:41`，MIT 署名，必须保留）。`tauri.linux.conf.json` 的 `productName` 是 `xiongbao-device`。
- 侧车：`binaries/xiongbao-runner`、`binaries/agent-desktop`（`tauri.bundle.conf.json`）。旧名 `openbot-runner` 只用于在老机器上识别并清理：`src-tauri/src/sidecar.rs:27`（`LEGACY_SIDECAR`）及其单元测试（`:620-675`）。
- 托盘与菜单文字全是中文熊宝（`src-tauri/src/main.rs:244,387,752-757`）；`ui/index.html:6` 标题熊宝。
- 注册表：配置里没有 `publisher`，Windows 安装器的注册表项由 `productName`/`identifier` 推出，不含上游名（按配置推断，未在 Windows 上实装核对）。
- 仍有上游名的地方：
  - 开发用环境变量 `OPENBOT_RUNNER_BINARY`、`OPENBOT_AGENT_DESKTOP_BINARY`（`sidecar.rs:396,414,952,967-968`），Rust 侧**没有** `XIONGBAO_` 别名。
  - runner 的 `--help` 文字写着 `OPENBOT_RUNNER_DATA_DIR`、`OPENBOT_DESKTOP_HELPER`、`OPENBOT_DESKTOP_ENGINE`（`runner/src/index.ts:203,220-221`）——客户技术人员运行 `xiongbao-runner --help` 会看到。
  - runner 写到客户电脑上的文件：浏览器档案目录里的 `openbot-snapshots.sqlite`（`runner/src/browser.ts:695`）。
  - runner 往 Bot 打开的网页里加属性 `data-openbot-secret`（`runner/src/browser.ts:120`），见 2.9 节。
- runner 二进制的打包：`desktop-device/scripts/build-sidecar.ts:52-63` 用 `bun build --compile`，**没有 `--minify`**。试验（同样参数，不加 `--compile`）：产物 7.70 MB，`openbot` 28 次，其中有模块路径注释 `// shared/openbot-browser.ts`，以及构建机的绝对路径（`playwright-core` 的 `__dirname`，含 `…/openbot/node_modules/…`）2 处；476 行注释。CI 构建机路径是 `/home/runner/work/xiongbaowork/xiongbaowork/openbot/…`，所以发出去的二进制里同样会带 `openbot`。

**上游桌面 `desktop/`：不交付**，只记录现状：`tauri.conf.json` 的 `productName` XiongBao、`identifier` `com.xiongbao.desktop`、窗口标题「熊宝」、`publisher` XiongBao，但 `copyright` 是 `CopilotKit`、`desktop/index.html:6` 是 `<title>OpenBot</title>`；它注册原生消息主机 `ai.copilotkit.openbot.recorder`（`shared/recorder-extension.json:2`，`desktop/src-tauri/src/recorder_install.rs`）。根 CI 只跑它的测试，不发布它。

### 2.6 环境变量

**别名机制已经覆盖所有 Node 进程**：`shared/env-aliases.ts`（把每个 `XIONGBAO_<X>` 抄成 `OPENBOT_<X>`，新名优先，冲突打一行警告），由 `shared/apply-env-aliases.ts` 在各入口第一行导入：`server/src/index.ts:1`、`runner/src/index.ts:15`、`supervisor/src/index.ts:1`、`worker/src/index.ts:20`、`agent-computer/src/index.ts:1`；脚本走 `server/src/config.ts:1781-1788` 自己再套一遍；容器里 `docker/s6/scripts/env-aliases.sh` 对 `/run/s6/container_environment` 做同样的事。**规则按前缀，不按清单**，所以服务器读取的每个 `OPENBOT_<X>` 都自动有 `XIONGBAO_<X>` 新名。

**没有别名的地方**：
- Rust：设备端两个开发变量（2.5 节）。
- Python：托管 Bot 框架读 `OPENBOT_TOOL_URL`（`agent-langgraph-agui/src/tool_runtime.py:448`；TS 的 `agent-langgraph/src/index.ts:240` 也读，但它不导入别名模块）。
- Compose 宿主机插值：`OPENBOT_IMAGE`、`OPENBOT_PORT`、`OPENBOT_TAG`（2.4 节）。
- 构建期：`Dockerfile:385-389` 的 `ARG OPENBOT_BUILD_*`、`<根>/.github/workflows/*` 的 `OPENBOT_*`。

**服务器（`server/src` + `shared`）里出现的 61 个 `OPENBOT_` 名字**（`git ls-files server/src shared | grep -v test | xargs grep -ohE "\bOPENBOT_[A-Z0-9_]+" | sort -u`），按用途分三类：

| 类别 | 名字（代表位置） | 处理 |
|---|---|---|
| **真正的环境变量**（读 `process.env` / `optional(environment, …)`），约 38 个 | `config.ts` 经 `optional()` 读 16 个：`ACCESSIBILITY_DISABLED`、`APP_URL`、`BROKER_PROVIDER`、`BUILD_VERSION`、`EDITION`、`GENERATIVE_UI`、`IN_CONTAINER`、`LEARNING_AUTO_ASSIGN`、`LOCAL_LEARNING`、`MEMORY_SOURCE_DEFAULTS`、`ORGANIZATION_AUTH_URL`、`PROACTIVE_DEFAULTS`、`PUBLIC_URL`、`RECORDER_EXTRA_EXTENSION_IDS`、`SELF_HOST_BANNER`、`THIS_MACHINE_HOST`；其余直接读 `env.`：`BUILD_CHANNEL/COMMIT/DISTRIBUTION_ID/REPOSITORY`（`release-status.ts:38-41`）、`DESKTOP_HOST_TOKEN`（`index.ts:4643`）、`DEV_NO_AUTH`、`SINGLE_USER`（`auth/dev-actor.ts:152-154`）、`DISTRIBUTION`、`ARCH`、`ENGINE`、`OS_VERSION`、`PLATFORM`、`VERSION`（`desktop-telemetry.ts`，上游桌面才设）、`INBOUND_EMAIL_DOMAIN`、`INBOUND_EMAIL_SNS_TOPIC_ARNS`（`responsibilities/email.ts:37-38`）、`LEARNING_MODEL_TOKEN`（`index.ts:2180`）、`LEARNING_MODEL_UNAVAILABLE`（`learning/review.ts:48`）、`MODEL_CAPABILITIES_URL`（`model-catalogue.ts:772`）、`MODEL_OAUTH_FILE`（`index.ts:4718`）、`OTEL_EXPORT`（`telemetry/otel.ts:134`）、`PRODUCT_TELEMETRY`（`telemetry/product.ts:115`）、`RLS_ENFORCE`（`auth/role-writer-lifecycle.ts:23`）、`CREDENTIAL_LOCK`（`provider-oauth-lock.ts:121`，PowerShell 里读）、`TENANT_FRAME_GUARD`（`tenant/context.ts:21`）、`BROWSER_URL`、`RECORDER_DIR`（`shared/openbot-browser.ts:383,387`）、`POOL_*`（模式 `db/schema/model.ts:72`） | 全部已有 `XIONGBAO_` 新名（前缀别名）。本阶段只改**说出名字的地方**：文档、样例、界面、报错 |
| **发到浏览器或对端的错误码/协议值** | `MODEL_AUTH_REQUIRED`、`MODEL_REFUSED`、`MODEL_BILLING`（`agents/provider-refusal.ts:60,64`、Python `agent-claude-sdk/src/adapter.py:812-841`、`agent-langgraph-agui/src/tool_runtime.py:284-322`）、`PROVIDER_REQUEST_REFUSED`（`provider-error.ts:130`）、`LEARNED_SKILLS_ERROR`（`learning/remote.ts:262`）、`AP_LOCAL_STREAM_ERROR`、`AP_LOCAL_TERMINAL_MISSING`（`threads/postgres-runner.ts:326,341`）、`HARNESS_START_FAILED`（Python）、`toolkit` 的 `HEADLESS_TOOL_ERROR`、`TOOL_LIMIT_EXCEEDED` | 出现在浏览器开发者工具的事件流里（AG-UI `RUN_ERROR` 的 `code`）。属于第 1 层，但发送方横跨 Python 框架和上游文件，见 3.1 节 L1-8 |
| **加密版本串、元数据键、常量名** | `APPROVAL_EXACT_AEAD_V1`、`APPROVAL_EXACT_HEADER_V1`、`APPROVAL_EXACT_SOURCE_BINDING_V1`、`APPROVAL_EXACT_WIRE_V1`、`EXACT_INPUT_JSON_V1`（`approvals/*`，数据库 CHECK 约束也写死：`db/schema/approval-exact-input-objects.ts:52,56`）；常量名 `OPENBOT_TOOL_LIMIT`（值 `"OpenBot"` 写进审计行，`agents/tool-limit.ts:62`）、`OPENBOT_HARNESS_NAME`（值 `"OpenBot"`，`shared/harnesses.ts:109`）、`OPENBOT_WAITING_METADATA`（值 `"openbotWaiting"`，`shared/waiting.ts:12`）、`OPENBOT_ASKS`、`OPENBOT_CONTAINER` | 加密版本串**绝对不改**；常量名不改（第 2 层不动标识符），它们的**值**按 2.10 节处理 |

**说出旧变量名的「人看的文字」**：
- 网页：`app/src/components/manage/plugin-page.tsx:1417`「XIONGBAO_PUBLIC_URL（旧名 OPENBOT_PUBLIC_URL 仍可用）」、`app/src/routes/_authed/_app/responsibilities.tsx:978`「…旧名 OPENBOT_* 仍可用」——产物里确实有（`grep` dist 命中）。
- 服务器启动报错、运维提示：粗略约 40 行（`server/src` 里字符串内含空格又含 `OPENBOT_` 的非注释行，含少量误报），如 `config.ts:613,742,754,1476,1809,1959-1979,2001`、`edition.ts:79`、`auth/dev-actor.ts:158`、`auth/role-writer-lifecycle.ts:27`、`web-bot-auth.ts:153`、`browser/bot-browser.ts:99`、`browser/routes.ts:286`（后两条还写「This OpenBot」）。
- runner `--help` 3 行（2.5 节）。

### 2.7 前端产物

- **sourcemap**：`app/vite.config.ts:212-235` 的 `build` 只设了 `rollupOptions`，没有 `sourcemap`；Vite 7.3.6（`app/node_modules/vite/package.json`）默认 `false`。实测构建（`bun run --cwd app build`，47 秒）：`app/dist` 788 个文件，`.map` 文件 0 个，含 `sourceMappingURL` 的文件 0 个。
- **压缩**：Vite 默认 esbuild 压缩，局部变量名被改短，但**字符串常量、对象属性名、`console.*` 调用全部保留**。
- **产物里的上游字样**（`grep -roiE … app/dist`）：`openbot` 20 个文件 93 次；`copilotkit` 13 个文件 560 次；`qoder` 0。
  - `openbot` 93 次的来源：表二的 9 个存储键；表一的 7 个旧键常量（兼容读取）；`index.html` 内联脚本 3 处；通知 tag；DOM id/类名；默认皮肤 id；Recorder 协议消息类型 `openbot.ping/connect/state/record/stop`、`openbot-unreachable`；`openbot/ui@1`（A2UI 目录 id）；`openbot/share_private_information` 等内置工具引用；`<<openbot:app-access-request>>`、`<<openbot:staffing-proposal>>`；JSON 字段名 `openbotVersion`、`keyFromOpenBot`、`runsOnOpenBotModel`、`openbotUrl`、`openbotTimeZone`、`openbotWaiting`；`console.warn("OpenBot couldn't reach its back end.")`；上游桌面才显示的文字「This version of OpenBot doesn't update itself…」「OpenBot service」、`github.com/CopilotKit/OpenBot/blob/main/desktop/TELEMETRY.md`；关于页的「OpenBot（MIT）」（MIT 署名）；管理页的「名为 openbot 的容器」「openbot.surface 标签」；`OPENBOT_PUBLIC_URL` 等「旧名仍可用」提示；**应用配置里的 `brand:{tenantId:"openbot",…}`**（来自 `examples/xiongbao/brand.yaml:4` 的 `tenant.id: openbot`）。
  - `copilotkit` 560 次基本来自第三方库：`data-copilotkit*` 属性 203 次、类名与日志前缀 `CopilotKit` 97 次、`[CopilotKit] …`/`[CopilotKit Inspector] …` 控制台报错、文档链接 `docs.copilotkit.ai/*`、`copilotkit.ai/pricing`、`cdn.copilotkit.ai/inspector-hud/v1.json`、`telemetry.copilotkit.ai`。
- **第三方库里会画在界面上的东西**：
  - 许可横幅「Powered by CopilotKit / Get a license」在 `CopilotKitProvider` 内渲染，条件是运行时返回 `licenseStatus === "none"` 且没有公钥（`node_modules/.bun/@copilotkit+react-core@1.85.0+…/dist/copilotkit-D6mTCuNU.mjs:3975`）；服务器端运行时**只在接入 Intelligence 时**才返回 `licenseStatus`（`@copilotkit+runtime@1.85.0+…/dist/v2/runtime/handlers/get-runtime-info.mjs:110`）。京东云没有接 Intelligence，所以现在不出现。
  - Inspector 已关：`app/src/lib/copilot/provider.tsx:44` `enableInspector={false}`；但 Inspector 代码和它请求 `cdn.copilotkit.ai`、`telemetry.copilotkit.ai` 的地址仍打进了产物（`index-*.js`、`mermaid-*.js`）。关掉时是否真的不发请求，**本次没有在浏览器里实测**。
- **网络请求路径**：`/api/copilotkit`（品牌去痕决定保留：库的约定路径）。

### 2.8 浏览器扩展（录制器）

- 已改：扩展名、描述、按钮标题来自 `extension/src/shared/brand.ts`（`extension/src/manifest.ts:74-81`）；选项页文字已是「Connected by XiongBao Work…」（`extension/src/pages/options/options.tsx:46`）；图标已换。
- 构建：`extension/scripts/build.ts:51,69` `sourcemap: false`；内容脚本打成 IIFE，**全局名** `OpenBotRecorderContent`（`:90`）和 `OpenBotRecorderPageNetwork`（`:91-94`，后者是 **MAIN world** 脚本，名字落在客户访问的每个网页的 `window` 上）。按 Vite 库模式推断，未构建验证。
- **企业策略键** `OpenBotUrl`：`extension/public/managed_schema.json:4`，读取在 `extension/src/shared/policy.ts:40`。客户 IT 管理员配组策略时必须写这个名字。
- IndexedDB `openbot-recorder`（`extension/src/shared/database.ts:1`）。
- 注入网页的自定义元素 `openbot-recorder-notice`、`openbot-recorder-mark`（`extension/src/content/notice.ts:9`、`content/indicator.ts:42`）；`Symbol.for("openbot.recorder.configure")`、`Symbol.for("openbot.recorder.stop")`（`main-world/network-hook.ts:44-45`、`background/network/fallback.ts:20,24`）；属性 `data-copilotkit-ignore`（`notice.ts:106`、`indicator.ts:303`，上游 agent 客户端识别用）。
- 与网页的协议值：`openbot.ping`、`openbot.connect`、`openbot.connect.status`、`openbot.state/record/stop`（`extension/src/protocol/messages.ts:401-404`、`shared/recorder-page.ts:14-19,69`）、`openbot-unreachable`、连接来源值 `openbot-browser`（存进数据库：`shared/recorder-api.ts:36`）。
- 原生消息主机 `ai.copilotkit.openbot.recorder`：只有不交付的上游桌面会装，扩展侧不受影响。
- 扩展打包脚本（开发者用）：`extension/scripts/store-package.ts:39,62,255`（`OPENBOT_RECORDER_SIGNING_KEY`、`~/.config/openbot-recorder`、日志「OpenBot Recorder」）。

### 2.9 Bot 浏览器与第三方网页里的痕迹

这一类用户决定里没有单列，但它比开发者工具更「外」：**被访问的第三方网站自己的脚本就能读到**。

| 痕迹 | 写入方 | 依据 |
|---|---|---|
| `data-openbot-secret` | 设备端 runner、服务器侧 agent-computer | `runner/src/browser.ts:120`、`agent-computer/src/secret-masking.ts:35` |
| `data-openbot-person-filled` | agent-computer | `agent-computer/src/secret-masking.ts:41` |
| `data-openbot-login` | agent-computer | `agent-computer/src/sign-in.ts:53` |
| `<openbot-recorder-notice>`、`<openbot-recorder-mark>` | 录制扩展 | 2.8 节 |
| `window.OpenBotRecorderPageNetwork`、`Symbol.for("openbot.recorder.*")` | 录制扩展 MAIN world | 2.8 节 |

### 2.10 网络载荷里的标识符（开发者工具「网络」页看得见）

- JSON 字段名：`runsOnOpenBotModel`、`keyFromOpenBot`（`server/src/agents/routes.ts:598,605`）、`openbotVersion`（`app/src/lib/auth/queries.ts:29`）、`openbotTimeZone`（`shared/person-time-zone.ts:16`）、`openbotWaiting`（`shared/waiting.ts:12`）。
- 值：内置工具引用 `openbot/…`、授权来源 `openbot:always-on` 等、A2UI 目录 id `openbot/ui@1`、Bot 的 `framework` 值 `"OpenBot"`（`shared/harnesses.ts:109`，界面显示时已换成英文产品名）、AG-UI 自定义事件 `openbot.working`（`server/src/delivery/opentag.ts`，OpenTag 对端读取）、2.6 节的错误码。
- 这些大多已**存进数据库**或**与上游/对端共享**（白名单 `persisted-identifier`），改名成本高、收益低。本稿不在第 1 层处理它们，只做分类和计数（见 5.4、5.5 节）；第 9 节第 9 问一并问。

### 2.11 品牌护栏现状

- 文件：`app/tests/brand-leak.test.ts`（49 个用例，本地 `bun test tests/brand-leak.test.ts` 全过）、`app/tests/brand-leak-allowlist.json`（194 条）、`app/tests/product-name-allowlist.json`（0 条）。
- 扫描范围（`scannedFiles()`）：`app/src`、`server/src`、`runner/src`、`shared`、`toolkit/src`、`desktop-device/src-tauri/src`、`desktop-device/src-tauri/*.json`、`app/index.html`、`extension/src`、`extension/public/managed_schema.json`、`mobile/`；后缀 `ts|tsx|js|mjs|cjs|jsx|rs|json|html|css|svg|cs`。**不扫**：`agent-computer/src`（只用于「不改串」断言）、`supervisor/`、`worker/`、Python 框架、`docker/`、`Dockerfile`、`charts/`、文档、构建产物、镜像、安装包。
- 豁免路径（`EXEMPT_PATHS`）：`desktop/`、`server/drizzle/`、`/generated/`、测试与 fixtures、`server/src/brand.ts`。
- 只扫非注释行（`codeLines()`；整行注释跳过，模板字符串里的不算注释）。
- 匹配：`/OpenBot|CopilotKit|copilotkit\.ai|qoder/i`，先用 `RULES` 的 13 条规则抹掉允许的形状，剩下的必须在白名单里按「文件 + 行内包含的文字」找到；白名单条目找不到命中也算失败（只减不增）。
- 白名单条目结构：`{ file, text, reason }`，`reason` 形如 `<分类>: <说明>`，分类取自 `CATEGORIES`（8 个）。
- 另外三组断言：`NEVER_CHANGE` + `SIGNING_DOMAINS` + `WIRE_HEADERS` + `/api/copilotkit` 必须原样存在于源码；规则自测（`MUST_REPORT`/`MUST_ALLOW`）；当前产品名不得写死在 `app/src`、`server/src`（`product-name-allowlist.json`）；设备端不得借用 `desktop/src-tauri/icons`，版权行必须带 MIT 署名。
- CI：**真正运行的是仓库根的 `<根>/.github/workflows/ci.yml`**；`openbot/.github/workflows/*` 是上游副本，不运行（`<根>/.github/workflows/ci.yml:52` 注释原话「openbot/.github's chart job is the upstream copy and does not run here」）。护栏在根 CI 的 `app-test` job 里随全部 app 测试跑（`ci.yml:159-185` → `openbot/scripts/ci/run-tests.sh`：`generate:app-config && bun test`），该 job 已 `fetch-depth: 0`（`ci.yml:166`）。
- 其他品牌相关测试：`app/tests/brand-exit.test.ts`、`brand-web-copy.test.tsx`、`server/tests/brand*.test.ts`、`server/tests/env-alias-dockerfiles.test.ts`、`desktop-device/tests/brand-icons.test.ts`、`docker/tests/env-aliases.test.sh`（`image` job 里跑）。

### 2.12 工作量参考

命令：`git ls-files -z | xargs -0 grep -oicE openbot`，按顶层目录汇总；路径含 `tests/`、`__tests__/`、`fixtures/`、`test-fixtures/` 或文件名含 `.test.`、`_test.`、`test_` 的算测试。单位：行。

| 目录 | 源码行 | 源码文件 | 测试行 | 测试文件 |
|---|---:|---:|---:|---:|
| `server` | 1 448 | 322 | 3 003 | 509 |
| `desktop`（不交付） | 3 449 | 131 | 795 | 40 |
| `app` | 702 | 247 | 1 010 | 182 |
| `extension` | 480 | 55 | 866 | 58 |
| `scripts` | 340 | 51 | 389 | 26 |
| `docs`（上游 + 熊宝） | 696 | 41 | 0 | 0 |
| 根文件（README、CHANGELOG、`.env.example`…） | 683 | 13 | 0 | 0 |
| `charts` | 587 | 38 | 0 | 0 |
| `agent-computer` | 139 | 29 | 365 | 53 |
| `tests`（根集成测试） | 0 | 0 | 392 | 27 |
| `.github`（上游副本） | 241 | 13 | 0 | 0 |
| `shared` | 173 | 31 | 64 | 13 |
| 14 个 `agent-*` 框架合计 | 141 | 27 | 210 | 42 |
| `tools` | 81 | 7 | 5 | 3 |
| `supervisor` | 20 | 6 | 53 | 5 |
| `docker` | 31 | 6 | 16 | 2 |
| `toolkit` | 39 | 9 | 8 | 2 |
| `examples` | 34 | 15 | 0 | 0 |
| `desktop-device` | 29 | 5 | 0 | 0 |
| `runner` | 9 | 2 | 22 | 10 |
| 其他（`.claude`、`worker`、`assets`、`mobile`、`spire`） | 37 | 13 | 4 | 1 |
| **合计** | **9 362** | | **7 206** | |

`server` 源码再拆：`server/src` 1 176 行、`server/recovery` 224、`server/drizzle` 24、`server/scripts` 28。三个词合计（不分大小写，行）：`openbot` 16 568 行 / 2 034 个文件；`copilotkit` 3 006 行 / 621 个文件；`qoder` 47 行 / 24 个文件。

**按「谁的文件」拆**（上游同步点 `e4a73d7b`，`UPSTREAM.md` 表中「当前已同步到」；本地已有这个提交）：
- `openbot/` 下 4 777 个受版本控制的文件里，1 283 个是上游同步点没有的（**熊宝自有**），其中 403 个带上游字样（源码 179、测试 224）；熊宝自有源码里带上游字样的共 1 135 行，大部分是 SQL 里的角色名 `openbot_app`（如 `server/recovery/recovery-20261018-v1/sql/0122_team_tenant.sql` 67 行）。
- 上游文件被熊宝改过的 1 537 个（`git diff --name-only --diff-filter=M e4a73d7b HEAD:openbot`）；熊宝在这些文件里**加的行**中带上游字样的：源码 588 行（`server` 174、`charts` 113、`docs` 53、`CHANGELOG.md` 44、`app` 41…）、测试 352 行。
- 这两组数字就是第 2 层的总盘子；第 2 层不要求一次清完，只要求「不再增加」和「改到哪清到哪」。

---

## 3. 三层设计

### 3.1 第 1 层：交付物可见面先清

每项写明处理方式：**改名**（直接换）、**双认**（新名优先、旧名照收一个窗口期，见第 4 节）、**保留**（进白名单并分类）。

| 编号 | 面 | 处理 | 依据（2 节） |
|---|---|---|---|
| L1-1 | 浏览器存储表二的 9 个键 | **双认**：写新键 `xiongbao…`，读时新键没有就读旧键并**复制**（不删旧键，窗口期结束再删）；`computer-activity-wiped` 的 `storage` 事件监听两个前缀。sessionStorage 的 3 个键同样处理（避免升级瞬间正在进行的分享返回、交接丢失） | 2.3 表二 |
| L1-2 | 默认皮肤 id `openbot` | **双认**：新 id `xiongbao`；读到 `openbot` 视为 `xiongbao`；服务器用户偏好同样 | 2.3 表三 |
| L1-3 | 通知 tag、DOM id/`data-slot`/`data-orb`、CSS 类 `.openbot-*` | **改名**（只在同一个页面生命周期内使用，无持久化，无需双认） | 2.3 |
| L1-4 | 控制台 `console.warn("OpenBot …")` | **改名**，文字走 `appConfig.brand` | 2.3 |
| L1-5 | 界面里「旧名 OPENBOT_* 仍可用」两处 | **改**：只写 `XIONGBAO_*` | 2.6 |
| L1-6 | 服务器启动报错、运维提示约 40 行；runner `--help` 3 行；agent-computer 报错里说出的头名 3 处 | **改**：新增 fork 自有小函数 `envName("PUBLIC_URL")` 返回 `XIONGBAO_PUBLIC_URL`，上游文件里每处改成一次调用；「This OpenBot」改用品牌出口 | 2.6、2.2 |
| L1-7 | 白名单里 `internal-log` 16 条、`internal-error` 5 条（服务器日志与启动报错） | **改**：客户技术人员看 `docker logs`，现在算可见面（第 9 节第 4 问） | 2.1 发现 3 |
| L1-8 | 发到浏览器的错误码 `OPENBOT_MODEL_*` 等 | **双认**：服务器把对端（Python 框架、上游 toolkit）发来的旧码在转发给浏览器前映射成新码 `XIONGBAO_*`；网页两种都认一个窗口期。发送方（Python 框架）**不改**，免得同步上游时冲突 | 2.6 |
| L1-9 | 镜像 `openbot-apt` | **双认**：装 `/usr/local/sbin/xiongbao-apt`；旧路径保留为指向它的链接，sudoers 两条都放行，窗口期后删旧路径。Bot 的记忆、已学技能里可能写着 `sudo openbot-apt`，所以不能直接删 | 2.4 |
| L1-10 | 镜像 ENV `OPENBOT_SELF_HOST_BANNER`、`OPENBOT_RLS_ENFORCE`、`OPENBOT_IN_CONTAINER`、`COPILOTKIT_TELEMETRY_DISABLED` | **改做法**，不是简单改名：这几个是**镜像给的默认值**，客户可能在 `.env.delivery` 里用旧名覆盖。若镜像改成 `ENV XIONGBAO_RLS_ENFORCE=refuse`，别名规则「新名优先」会让镜像默认值**压过**客户显式写的 `OPENBOT_RLS_ENFORCE=warn`。做法：从 `ENV` 挪进 fork 自有的默认值文件（例如 `/etc/xiongbao/defaults.env`），由 s6 的 `env-aliases` 一次性脚本以**最低优先级**写入（新名旧名都没设才写） | 2.4 |
| L1-11 | 镜像 ENV `OPENBOT_BUILD_*` | **改名**为 `XIONGBAO_BUILD_*`（构建参数同步改）。客户不会自己设这几个，别名会抄回旧名，服务器读法不变 | 2.4 |
| L1-12 | 镜像 LABEL | **加**：`org.opencontainers.image.title`、`vendor`（品牌出口的产品名、公司名）；`source` 的去向取决于第 9 节第 1 问 | 2.4 |
| L1-13 | 发布清单 `container-images.json` 的键 `openbot` | **双认**：同时写 `images.xiongbao` 和 `images.openbot` 一个窗口期；文档改用新键 | 2.4 |
| L1-14 | Compose 插值 `OPENBOT_IMAGE`、`OPENBOT_PORT`、`OPENBOT_TAG` | **双认**：`${XIONGBAO_IMAGE:-${OPENBOT_IMAGE:-…}}`（Compose 支持嵌套默认值）；样例与文档只写新名 | 2.4 |
| L1-15 | 客户文档与样例（`<根>/README.md` 部署段、`docs/deployment-xiongbao.md`、`docs/development-environment-xiongbao.md`、`docker/delivery.env.example`） | **改**：只写 `XIONGBAO_*`；不再写「旧名仍可用」（运维迁移说明单独一页，只给我们自己的运维） | 2.4、2.6 |
| L1-16 | Bot 终端 `__openbot_prompt`、`.openbot-shell-*`、`$openbotOut`；`openbot-session-cookies.json` | 终端三项**改名**（每次启动终端重新生成，无持久化）；登录态文件**双认**（读新名，没有就读旧名并改名） | 2.4 |
| L1-17 | 第三方网页里的属性 `data-openbot-secret` / `-person-filled` / `-login` | **改名**为中性名字（不带任何品牌，例如 `data-xb-secret`；第 9 节第 8 问）。写入和读取都在同一进程、同一页面生命周期内，无需双认；runner 与 agent-computer 各自独立发版也不冲突 | 2.9 |
| L1-18 | 设备端 runner 文件 `openbot-snapshots.sqlite` | **双认**：启动时新文件不存在而旧文件存在，就改名过去 | 2.5 |
| L1-19 | runner 二进制 | 构建加 `--minify`；构建前把工作目录路径替换掉（或用 `--define`/打包后检查），保证二进制里没有构建机的 `…/openbot/…` 路径 | 2.5 |
| L1-20 | 设备端开发变量 `OPENBOT_RUNNER_BINARY`、`OPENBOT_AGENT_DESKTOP_BINARY` | **双认**：Rust 侧先读 `XIONGBAO_*` | 2.5 |
| L1-21 | 扩展 MAIN world 全局名、内容脚本全局名 | **改名**为不带品牌的名字；IIFE 改成不挂全局（Vite 库模式 `name` 只影响全局变量） | 2.8 |
| L1-22 | 扩展自定义元素 `openbot-recorder-*`、`Symbol.for("openbot.recorder.*")` | **双认**：新版本注册新标签名，查找时两个名字都查（扩展自动更新期间，老内容脚本还活在已打开的页面里） | 2.8 |
| L1-23 | 扩展企业策略键 `OpenBotUrl` | **双认**：`managed_schema.json` 同时声明 `XiongbaoUrl` 和 `OpenBotUrl`，读时新键优先；文档只写新键 | 2.8 |
| L1-24 | 扩展 IndexedDB `openbot-recorder` | **保留**本阶段（里面是录制中的事件，搬库有丢数据风险）；或在窗口期内做「新库为空且旧库存在则搬」，第 9 节第 9 问 | 2.8 |
| L1-25 | 前端产物 sourcemap | 在 `vite.config.ts` 里**显式**写 `build.sourcemap: false`（今天靠默认值），护栏断言产物里没有 `.map` 和 `sourceMappingURL` | 2.7 |
| L1-26 | 服务器内部头（2.2 表里除已完成的两项外） | 见第 9 节第 3 问 | 2.2 |
| L1-27 | 租户 id `openbot`（产物里 `tenantId:"openbot"`） | **本阶段保留**，先核实（第 9 节第 5 问） | 2.7 |
| L1-28 | 镜像里的源码树 | 见第 9 节第 2 问 | 2.1 |

**保留并进白名单的第 1 层对象**（改了会坏数据或断开对端）：cookie 以外的已持久化值（`granted_by` 标记、`via` 值、Learning 容器 id、审计行里的 `"OpenBot"`）、Recorder 协议消息类型、`/api/copilotkit`、加密版本串、数据库名与角色名、`data-copilotkit-*`（第三方客户端识别用）、MIT 署名。

### 3.2 第 2 层：源码随改随清

规则只有三条：

1. **熊宝自有文件**（上游同步点的树里没有的文件，以及以后新建的文件）里，不能出现上游名字。允许的只有：`RULES` 已经允许的形状（导入上游模块、`@openbot/*` 包名、引用上游标识符、`OPENBOT_*` 兼容读取、不改串）。**注释也算**：写「上游」「原版」，不写 OpenBot。
2. **改到上游文件时，只清自己改动的那几行**：熊宝新增或修改的行，按规则 1 检查；同一个文件里没碰的上游行，一行不动。
3. **不动**：`openbot/` 目录名、`@openbot/*` 包名、上游文件里的类型名和函数名（如 `OpenBotRole`）、上游的注释。

「熊宝自有」怎么判定：以 `UPSTREAM.md` 记录的「当前已同步到」提交为准（现在是 `e4a73d7b`）。为了让程序读得到，新增一个 fork 自有的机器可读文件 `openbot/upstream-sync.json`（`{ "commit": "e4a73d7b…" }`），每次同步上游时和 `UPSTREAM.md` 一起改。

测试代码（`tests/`、`*.test.*`、fixtures）**不在第 2 层范围内**：它们要写旧值来证明兼容（如 `dev@openbot.local`、旧 cookie 名），也不随交付物出去——前提是镜像不再带测试（第 9 节第 2 问、第 7 问）。

第 2 层没有单独的 PR，靠第 3 层的「新增行检查」在每个 PR 上执行。熊宝自有源码里现有的 1 135 行，按「改到哪清到哪」顺手清；其中 SQL 角色名属于保留项。

### 3.3 第 3 层：护栏升级

设计见第 5 节。要点：扫描对象从源码扩展到前端产物、扩展产物、runner 二进制、镜像、安装包、客户文档；新增行检查执行第 2 层；白名单加独立分类字段和处理去向，`RULES` 抹掉的部分改成「预算」计数，二者合起来就是剩余工作量。

---

## 4. 兼容策略

### 4.1 窗口期怎么数

- 「一个版本」= 一个正式发布标签（`v0.x.y`，不算 `-rc`）。
- 某个旧名在版本 **N** 开始双认，则 **N** 和 **N+1** 两个版本都接受旧名，**N+2** 删除旧名（用户原话「新旧名字都接受一个版本，下下个版本再去掉旧名」）。
- 品牌去痕已经引入的双认（组织登录 cookie、`x-openbot-voice/dictation`、表一的 7 个存储键、环境变量别名以外的部分）从 **v0.2.9** 起算。
- **环境变量的 `OPENBOT_*` 兼容读取不受窗口期限制**：京东云的 `.env.delivery` 全是旧名，品牌去痕规格承诺「一个字都不用改」。旧名一直认，只是不再写进任何给客户的东西。

### 4.2 迁移顺序：接收方先，发送方后

| 发送方 → 接收方 | 是否会混跑 | 顺序 |
|---|---|---|
| 网页 → 服务器 | 不会长期混跑：网页由服务器同一镜像提供（`Dockerfile:218`）；只有「升级时没刷新的老标签页」 | 同一版本里服务器双认、网页改发新名即可（`x-xiongbao-voice` 就是这么做的） |
| 服务器 → agent-computer | 单镜像里不会（同一镜像，`Dockerfile:200,345`）；Helm/组件镜像部署里会（两个镜像分别滚动升级） | N：agent-computer 双认；N+1：服务器改发新名；N+2：agent-computer 删旧名 |
| 服务器 ↔ 托管 Bot 框架（Python 等） | 会（组件镜像） | 若决定改（第 9 节第 3 问）：N 服务器双认回调头、框架双认来访头；N+1 两边改发新名；N+2 删旧名 |
| 设备端 runner ↔ 服务器 | 会，且**设备端没有自动更新**（`<根>/.github/workflows/device-release.yml:20`「No updater (D6)」） | 本阶段没有需要改的头（2.2）。以后若有，删旧名的条件是「N+2 **且**服务器上看不到低于 N+1 的设备端连接」，不能只按版本号 |
| 扩展 ↔ 网页 | 会（扩展商店异步更新，已打开的页面里有老内容脚本） | 协议消息类型本阶段**保留**；自定义元素名、策略键按 L1-22、L1-23 双认 |
| 浏览器存储、cookie | 不是两方混跑，是「新代码读老数据」 | 读新名，没有就读旧名并**复制**到新名；写只写新名；N+2 删除读旧名的代码 |
| 磁盘上的文件（`openbot-snapshots.sqlite`、`openbot-session-cookies.json`） | 同上 | 启动时一次性改名；N+2 删除改名代码 |

### 4.3 改动规矩

- 双认的读取写在 fork 自有的小函数里（已有先例：`app/src/lib/storage-migrate.ts`、`server/src/browser-request-marker.ts`），上游文件里只改成一次调用。
- **复制而不是搬走**：以后的迁移保留旧键/旧 cookie 到窗口期结束。现有的 `readMigrated` 会删旧键（`storage-migrate.ts:22`），这会让回退到 v0.2.8 的用户丢掉主题、侧栏偏好；本阶段把它改成只复制、不删，删除放到 N+2 的清理里。
- 每个双认点在白名单里登记为 `legacy-compat` 分类，带 `introducedIn` 和 `removeIn` 两个版本号（见 5.4）。

### 4.4 回退

| 回退到 | 会发生什么 | 对策 |
|---|---|---|
| 同一窗口期内的上一个版本（N+1 → N） | 双方都还认旧名，无影响 | — |
| 双认之前的版本（N → N−1） | ① 浏览器：只读旧键，若 N 已删旧键（现有 `readMigrated` 的做法）则偏好丢失，改成「复制不删」后无影响；② 组织登录 cookie：N−1 只认旧名，而 N 写新名并清旧名 → **组织登录用户要重新登录一次**；③ 设备端文件已改名 → N−1 找不到 `openbot-snapshots.sqlite`，快照计数从零开始（不影响功能） | ① 本稿 4.3 的「复制不删」；② 回退说明里写明；③ 可接受 |
| 别名机制之前的版本（v0.2.8 及更早） | 客户若已按新文档**只写** `XIONGBAO_*`，旧版本不认 → 起不来或行为不对 | 回退说明写明「不能回退到 v0.2.9 之前」；或者回退前把 `.env` 里的 `XIONGBAO_` 改回 `OPENBOT_`。镜像默认值文件（L1-10）同理 |
| 镜像默认值从 ENV 挪到文件后回退 | 旧镜像自带 ENV，无影响 | — |

### 4.5 到期清理由测试强制

新增测试：读当前版本号（`package.json` 的 `version`），对白名单里 `removeIn` 小于等于当前版本的 `legacy-compat` 条目报错，提示「这个旧名到期了，删掉兼容代码和这条白名单」。这样发版 PR 自己就会把清理带出来，不靠人记。

---

## 5. 护栏设计

### 5.1 扫描哪些东西

| 对象 | 怎么得到 | 检查什么 |
|---|---|---|
| A. 源码（现有） | 现有 `scannedFiles()`，**补上** `agent-computer/src`、`supervisor/src`、`worker/src`、`docker/`（脚本）、`Dockerfile` 的非注释行、`extension/scripts/build.ts` | 现有规则；`OPENBOT_\w*` 规则拆分（见 5.5） |
| B. 新增行（新） | `git diff -U0 $(git merge-base HEAD origin/main)...HEAD -- openbot/` 的 `+` 行 | 第 2 层规则：**含注释**；按 5.3 判定是否算熊宝引入 |
| C. 前端产物（新） | `bun run --cwd app build` 后的 `app/dist` | ① 没有 `.map` 文件、没有 `sourceMappingURL`；② 抽取所有带上游字样的「词」（正则 `[A-Za-z0-9_.:/@$-]*(openbot\|copilotkit\|qoder)[A-Za-z0-9_.:/@$-]*`，不分大小写），与产物白名单比对：多出来的词报错，白名单里有但产物里没了的词也报错（只减不增） |
| D. 扩展产物（新） | 扩展构建后的 `extension/dist` | 同 C，外加：MAIN world 脚本不定义带品牌的全局名 |
| E. runner 二进制（新） | `bun desktop-device/scripts/build-sidecar.ts`（只编当前平台） | 同 C 的词表比对（对二进制跑字符串抽取）；不得含构建机路径 |
| F. 镜像（新） | `image` job 已构建的 `openbot:trackb` | ① `docker run --rm --entrypoint sh … -c 'find / -xdev …'` 的文件清单里，路径带上游字样的只能是白名单列出的（`/app/**` 按第 9 节第 2 问的结果定规则）；② `docker inspect` 的 ENV 与 LABEL：不得有 `OPENBOT_*`、`COPILOTKIT_*`（L1-10、L1-11 做完后）；③ 启动日志（`image-smoke.sh` 已保存在 `delivery-evidence`）里不得有上游字样 |
| G. 安装包（新） | `device-bundle-linux` 已产出的 `.deb` | `dpkg-deb -c` 文件清单、`control` 字段、包内二进制的字符串，同 C 比对。Windows NSIS 与 macOS dmg 第二步再加 |
| H. 客户文档与样例（新） | `<根>/README.md` 部署段、`openbot/docs/*-xiongbao.md`、`docker/delivery.env.example`、`docker/compose.delivery.yml` | 不得出现 `OPENBOT_`（L1-14、L1-15 做完后）、`OpenBot`、`copilotkit.ai` 以外的上游名字；指名第三方服务（CopilotKit Intelligence）的句子进白名单 |

### 5.2 在哪个 CI job 里跑（根 CI：`<根>/.github/workflows/ci.yml`）

| 检查 | job | 理由 |
|---|---|---|
| A、B、H、到期清理 | 现有 `app-test`（`ci.yml:159`） | 已有 `fetch-depth: 0`；护栏本来就在这里跑；不用新开机器 |
| C、D、E | **新增 `brand-artifacts` job** | 构建前端约 47 秒（本地实测），扩展、runner 各一两分钟；独立 job 失败时一眼能看出是产物问题。不放进 `e2e-wakerflow`（`ci.yml:191`，虽然它也构建前端），免得 e2e 和品牌问题互相牵连 |
| F | 现有 `image` job（`ci.yml:318`），在 `docker build` 之后加一步 | 镜像只构建一次 |
| G | 现有 `device-bundle-linux`（`ci.yml:792`），在打包之后加一步 | 同上 |
| 新 job 纳入 `verify` 必需检查 | `ci.yml` 末尾汇总 | 否则红了也能合并 |

`openbot/.github/workflows/*` 是上游副本，**不改**（改了也不运行，还会制造同步冲突）。

### 5.3 「新增行」怎么判定

1. 取基线：PR 上用 `git merge-base HEAD origin/main`；推到 main 时用 `HEAD^1`（合并提交的第一个父提交）。
2. 取所有新增行（`+` 行），只看 `openbot/` 下、且不在 5.1-A 的豁免路径（测试、`desktop/`、`server/drizzle/`、`generated/`）里的文件。
3. 对每一行套用 `RULES`（与全量扫描同一份规则），**注释行也检查**。
4. 剩下有上游字样的行，再问一句「它是不是从上游原样搬来的」：读 `openbot/upstream-sync.json` 里的同步点提交，若**同一路径**的上游文件里存在**完全相同（去首尾空白）**的一行，则算上游带来的，不算熊宝引入。这样上游同步 PR 天然通过，熊宝自己写的同样字样仍会被拦住。
5. 仍然剩下的行：要么改掉，要么登记进白名单（受 5.4 的「只减不增」约束）。
6. 同步点提交取不到时（例如 CI 网络问题）：检查**失败**并说明原因，不静默放行。上游仓库公开，`git fetch https://github.com/CopilotKit/OpenBot.git <commit>` 即可；本地已存在该提交时不需要网络。

### 5.4 白名单结构与分类枚举

结构改为（`brand-leak-allowlist.json`，C/D/E/F/G 各一份同结构的产物白名单）：

```json
{
  "file": "app/src/lib/theme.ts",
  "text": "\"openbot-theme\"",
  "category": "legacy-compat",
  "plan": "remove",
  "introducedIn": "0.2.9",
  "removeIn": "0.2.11",
  "note": "旧主题键，readMigrated 读一次后复制到 xiongbao-theme"
}
```

分类（`category`）枚举，按「为什么还留着」分：

| 分类 | 含义 | `plan` 只能是 | 现有分类怎么映射 |
|---|---|---|---|
| `legacy-compat` | 双认窗口期内的旧名（旧键、旧 cookie、旧头、旧文件名、旧策略键） | `remove`（必须带 `removeIn`） | `persisted-identifier` 里写「legacy …」的条目 |
| `persisted-data` | 已写进数据库、客户机器、第三方系统的值，改了会坏数据 | `keep` | `persisted-identifier` 的大部分 |
| `crypto-domain` | 加密、签名、哈希域串与版本串 | `keep` | 现在由 `RULES` 抹掉；改为显式登记 |
| `peer-protocol` | 与上游、第三方、已安装扩展共享的协议值（Recorder 消息类型、OpenTag 路径与事件、A2UI 目录 id、`x-copilotkit-ei-service-token`） | `keep` 或 `rewrite` | `persisted-identifier` 的一部分 |
| `parsed-exact-text` | 别处按原文匹配的文字（旧数据、对端回复） | `keep` 或 `rewrite`（需先改匹配方） | 原样 |
| `operator-visible` | 日志、启动报错、`--help`：客户技术人员看得见 | `rewrite` | `internal-log`、`internal-error` |
| `third-party-name` | 真实的第三方名字（CopilotKit Intelligence、CLI、库自带文字）和 MIT 署名 | `keep` | `external-name` |
| `upstream-shell-only` | 只在不交付的上游桌面里显示 | `keep` | 原样 |
| `developer-only` | 不随交付物出去 | `keep` | 原样 |

规则：
- **只减不增**：熊宝自己的 PR 不得新增条目，只能删；条目找不到命中报错（现有机制）。
- **上游同步 PR 例外**：允许新增，但只能是 `persisted-data`、`crypto-domain`、`peer-protocol`、`parsed-exact-text`、`third-party-name`、`upstream-shell-only` 六类，且每条必须能在上游同步点找到同一行（5.3 第 4 步的同一个判定）；PR 说明里列出新增条目。是否接受这个例外见第 9 节第 7 问。
- 迁移现有 194 条：写一次性脚本把 `reason` 的前缀拆成 `category`，按上表映射，再人工复核 `persisted-identifier` 138 条的去向；**顺手修正 2.1 发现 3 里 10 条写错的理由**。

### 5.5 规则抹掉的部分改成「预算」

`RULES` 抹掉的 1 150 行不在白名单里，白名单长度因此低估工作量（2.1 发现 3）。做法：

- 把 `OPENBOT_\w*` 规则拆成三条：① 已知环境变量名（从 2.6 节的清单生成，放在 fork 自有文件里）在**读取位置**出现；② 加密版本串（并入 `crypto-domain`）；③ 其他 `OPENBOT_` 形状（错误码、出现在人看的字符串里）——第 ③ 条不再抹掉，改为进白名单或预算。
- 新增 `brand-budget.json`：记录每条规则在每个扫描范围里抹掉的行数，例如 `{"rule": "identifier", "scope": "server/src", "lines": 312}`。测试要求实际行数 ≤ 预算；变少时提示「把预算改小」（同一 PR 必须改小，否则失败——棘轮）。上游同步 PR 可以调大，规则同 5.4 的例外。
- 这样「剩余工作量」= 白名单里 `plan` 为 `rewrite`/`remove` 的条数 + 各产物白名单里非 `keep` 的词数；`keep` 类的条数和预算是「永久残留」，单独报告。

### 5.6 每个 PR 自动输出的度量

`brand-artifacts` job 结束时往 job summary 写一张表：各白名单按分类、按 `plan` 的条数；各产物的品牌词个数；预算各项；与 main 相比的增减。用户看这一张表就知道重写进行到哪了。

---

## 6. 分包建议

每个 PR 都要过现有全部测试和新护栏；表里只写本 PR 特有的验收。

| PR | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **R0 本规格** | 本文件 | — | 用户拍板第 9 节 |
| **R1 护栏升级底座** | 白名单新结构与分类迁移（含修正 10 条错理由）；预算文件与 `OPENBOT_` 规则拆分；新增行检查（含 `upstream-sync.json`）；到期清理测试；`brand-artifacts` job（先只做 C：前端产物 + sourcemap 断言；`vite.config.ts` 显式 `sourcemap: false`）；job summary 度量表 | R0 | ① 在 PR 里另开一个临时提交，往熊宝自有文件加一行带 `OpenBot` 的注释、往 `app/src` 加一个 `"openbot-x"` 字符串，CI 必须红，删掉后变绿（截图贴进 PR 说明）；② 拿 `upstream-sync-m5` 分支（`origin/claude/upstream-sync-m5`）的合并提交做一次新增行检查，上游带来的行不报；③ 度量表出现在 job summary |
| **R2 网页与浏览器存储** | L1-1 ～ L1-5、L1-25；`readMigrated` 改为复制不删 | R1 | ① 前端产物词表里 `openbot` 词数下降（度量表）；② 手工：用 v0.2.9 打开过的浏览器升级后，主题、侧栏、教学提示、语音草稿都还在，开发者工具「应用」页只新增 `xiongbao*` 键，旧键仍在；③ 回退到 v0.2.9 后偏好仍在 |
| **R3 运维可见文字** | L1-6、L1-7、L1-15；`envName()` 小函数 | R1 | ① 镜像启动日志（`delivery-evidence`）里没有上游字样；② 用京东云 `.env.delivery` 原文（全旧名）启动，行为与之前一致、不多出警告；③ 故意把 `XIONGBAO_EDITION` 设成非法值，报错文字写的是 `XIONGBAO_EDITION` |
| **R4 镜像** | L1-9 ～ L1-14；扫描 F | R1；第 9 节第 1、2 问 | ① `docker inspect` 无 `OPENBOT_*`、`COPILOTKIT_*`，LABEL 有 title/vendor；② `.env.delivery` 里写 `OPENBOT_RLS_ENFORCE=warn` 时生效（证明默认值文件优先级最低）；③ Bot 终端里 `sudo openbot-apt install jq` 与 `sudo xiongbao-apt install jq` 都能用；④ 文档按新键 `images.xiongbao` 走通一次部署 |
| **R4b（视第 9 节第 2 问）镜像不带源码** | 服务器打包压缩为单文件（或至少不带 `server/tests` 等不运行的文件） | R4 | 镜像内 `/app` 下带上游字样的文件数降到预算以内；`image` job 全部冒烟通过；迁移和 `recovery/` 照常执行 |
| **R5 Bot 浏览器与终端痕迹** | L1-16、L1-17 | R1 | ① 打开任意网站，页面 DOM 里查不到 `openbot`；② 升级前存的网站登录态升级后仍有效 |
| **R6 设备端** | L1-18 ～ L1-20；扫描 E、G | R1 | ① `.deb` 解包后 `grep -ri openbot` 只命中白名单项；② `xiongbao-runner --help` 无上游字样；③ 从 v0.2.9 设备端直接升级，快照计数延续、能连上服务器 |
| **R7 浏览器扩展** | L1-21 ～ L1-23（L1-24 视第 9 节第 9 问）；扫描 D | R1 | ① 在任意网页的控制台里 `Object.keys(window).filter(k => /openbot/i.test(k))` 为空；② 用旧策略键 `OpenBotUrl` 配置的企业浏览器升级后仍连得上；③ 录制中途扩展自动更新，标记元素不重复、不残留 |
| **R8（视第 9 节第 3 问）内部头** | agent-computer 双认 → 服务器改发新名 | R1 | 单镜像与组件镜像混跑（新服务器 + 旧 agent-computer、旧服务器 + 新 agent-computer）各跑一次 `per-bot-users-smoke.sh` |
| **R9 窗口期清理**（每次发版） | 由 4.5 的到期测试触发：删除到期的双认代码和白名单条目 | 前述各包 | 到期测试转绿；白名单条数下降 |

顺序：R1 必须第一个（没有度量和拦截，后面的改动会被上游同步冲掉而没人知道）。R2、R3 风险最低、可见度最高，紧随其后。R4 等第 9 节第 1、2 问有结论再做。R5、R6、R7 互不依赖，可以并行。R8 最后，且可能不做。第 2 层没有单独 PR，R1 合入后在每个 PR 上自动执行。

---

## 7. 风险

| 风险 | 后果 | 对策 |
|---|---|---|
| 仓库保持公开 | 第 1 层做得再干净，客户技术人员顺着部署文档的链接也能看到全部上游痕迹和 `UPSTREAM.md` | 第 9 节第 1 问先定 |
| 镜像默认值改名后压过客户的旧名设置 | 例如 RLS 从 `warn` 变回 `refuse`，客户部署行为改变 | L1-10 用最低优先级的默认值文件，不用 `ENV XIONGBAO_*`；R4 验收第 ② 条 |
| 新增行检查误报上游同步 PR | 同步 PR 卡住 | 5.3 第 4 步按上游同步点逐行比对；R1 验收用历史同步分支回放 |
| 白名单「只减不增」与持续同步上游冲突 | 上游新增一个持久化标记就过不了 | 5.4 的同步例外（需用户同意，第 9 节第 7 问） |
| 回退时组织登录用户被登出、XIONGBAO_-only 配置在旧版本不生效 | 回退变痛 | 4.4 写进发版说明；「复制不删」 |
| 设备端没有自动更新，旧设备长期在外 | 按版本号删旧名会断开旧设备 | 设备相关的删除条件加「服务器上看不到老版本连接」（4.2）；本阶段设备端没有要删的旧协议名 |
| 扩展更新期间老内容脚本仍在页面里 | 标记元素重复或找不到 | L1-22 双认查找 |
| 服务器打包成单文件（R4b）运行时出错 | 迁移、动态导入、读文件路径失效 | 单独 PR，`image` job 的全部冒烟和 `per-bot-users-smoke.sh` 必须过；做不到就退回「只剔除测试」 |
| 第三方库在特定条件下显示「Powered by CopilotKit」 | 客户看见上游公司名 | 只有接入 Intelligence 且无许可时出现（2.7）；交付默认不接，接入时必须配许可；在护栏 C 里把 `Powered by CopilotKit` 列为「出现即报告」的词（库升级时提醒复核条件） |
| 改上游文件的行变多，同步冲突增多 | 合并成本上升 | 第 2 层只碰自己改的行；双认逻辑全部放 fork 自有小函数；上游文件里每处只是一次调用 |
| 白名单分类迁移时把该改的标成 `keep` | 工作量被低估 | `persisted-identifier` 138 条逐条复核；`keep` 条目在度量表里单列，评审时看 |
| 前端产物词表随依赖升级大幅变化 | 每次升级 `@copilotkit/*` 都要改产物白名单 | 产物白名单只登记「词」不登记位置和次数；第三方库的词用 `third-party-name` 一类批量登记 |

---

## 8. 同步上游时的固定动作（在品牌去痕规格 5.2 节基础上）

1. 三方合并（`UPSTREAM.md`「同步方法」），解决冲突时保留熊宝的品牌出口调用和双认函数调用。
2. 更新 `UPSTREAM.md` 表格**和** `openbot/upstream-sync.json`（新增行检查靠它判断「上游带来的行」）。
3. 跑护栏：新增行检查对上游带来的行自动放行；全量扫描列出的新命中逐条决定——接品牌出口，或按 5.4 的同步例外登记白名单。
4. 预算若上涨，在 PR 说明里写清楚是哪条规则、为什么。
5. `brand-artifacts`、`image`、`device-bundle-linux` 的产物检查全过，再合并。

---

## 9. 需要你决定的问题（附建议）

1. **仓库要不要改成私有？客户从哪里拿镜像、安装包和部署脚本？**
   现状：仓库公开（2.1 发现 1），部署文档从 `raw.githubusercontent.com/…/openbot/docker/…` 下载样例、从 GitHub Release 下载清单和设备端安装包，镜像在 `ghcr.io`，OCI 标签指回仓库。
   建议：**改成私有**；给客户的东西放到我们自己的渠道（例如京东云镜像仓库 + 一个下载页），部署文档里的链接全部换成那边；镜像 `source` 标签指向我们的官网或不写。MIT 义务不受影响（声明随镜像 `/licenses/` 和安装包走）。注意：改私有后，`ghcr.io` 镜像和 Release 附件对客户不可见，京东云现有部署脚本里的下载地址要同步换，需要先排一个切换窗口。

2. **交付镜像还带不带 TypeScript 源码？**
   现状：`/app/server` 等整目录在镜像里，含 `server/tests`，上游字样 5 000 多行（2.1 发现 2）。
   选项：A 只剔除不运行的文件（`server/tests`、`docs`、`tsconfig.tests.json` 等），一行代码不改，立刻少 3 637 行；B 服务器打包压缩成单文件（试验能构建，2.65 MB，`openbot` 降到 471 次；运行未验证）；C 不动。
   建议：**先 A（并入 R4），B 作为 R4b 单独验证**。B 做成之前，第 2 层「上游文件里的标识符不动」意味着 `docker exec` 仍能看见大量上游名字——这一点请你知悉并接受。

3. **服务之间的内部头（`x-openbot-agent-token`、`-bot-id`、`-person-id`、`-computer-token`、`-egress`、`-desktop-host-token`）要不要改名？**
   现状：浏览器看得见的两个已改完；剩下的只有在容器里抓包或读源码才看得见；设备端一个都不用（2.2）。品牌去痕规格把它们列为「绝对不改」，护栏 `WIRE_HEADERS` 断言它们存在。
   建议：**服务器 ↔ agent-computer 的四个（`-bot-id`、`-person-id`、`-computer-token`、`-egress`）改**，按 4.2 节顺序双认（R8，排最后）；**`x-openbot-agent-token` 暂不改**（14 个 Python 框架各一份常量，全是上游文件，改了每次同步都冲突，而托管框架镜像不在京东云单镜像里）；**`x-openbot-desktop-host-token` 不改**（`desktop/` 不交付）。若 B 方案（第 2 问）没做，内部头改名的意义不大，可以整体推迟。

4. **服务器日志、启动报错、`--help` 算不算「交付物可见面」？**
   建议：**算**。客户技术人员看 `docker logs` 是常态。白名单里 `internal-log` 16 条、`internal-error` 5 条，以及约 40 行说出 `OPENBOT_*` 的提示，全部改写（R3）。这会推翻品牌去痕规格「内部日志保留」的决定。

5. **租户 id `openbot`（`examples/xiongbao/brand.yaml:4`）改不改？**
   现状：它写进了前端产物（`tenantId:"openbot"`）和数据库；已有 `former_ids` 机制支持改名（`server/src/tenant-package.ts:241-249`）。但凭据加密的附加数据里有 `tenantId`（`server/src/credentials.ts:269-273`），**是否就是这个租户包 id 还没核实**；若是，改 id 会让已加密的凭据解不开。
   建议：**本阶段不改**，先核实 `credentials.tenantId` 的来源；核实为安全后再单独立项。

   **核实结论（Task 6）**：**不是租户包 id，改 id 不影响凭据。**（核实于 2026-11-13，路径相对 `openbot/server/src/`。）

   凭据附加数据里的 `tenantId` 是凭据行自己的 `credentials.tenant_id` 列，值是这一行所属的租户帧：登录用户的 id，或 `system`／`team`。租户包 id（`openbot`）只写进另一张表 `deployment_packages.tenant_id`。两列同名，但不是同一列；代码里没有任何一处把租户包 id 当作租户帧，或写进 `credentials.tenant_id`。调用链：

   - 写入：`credentials.ts:272`（`credentialAad` 取 `binding.tenantId`）← `:310`（`sealCredential`）← 各写入方都只传 `seal` 回调，binding 由 store 给出（如 `credentials.ts:887`、`:967`，`agents/auth-header.ts:92`，`responsibilities/triggers.ts:502`，`models/routes.ts:313`）← `credentials.ts:563`（`sealedRow` 里的 `tenantId: tenant`，同一个值经 `:566` 写进该行的 `tenant_id` 列；`updateSecret` 则在 `:604` 用 `select credentials.tenantId` 读回的列值）← `:542`／`:628`（`credentialTenant(kind, target)`）← `:514`（`currentTenant()`；`target` 为 `team` 时取常量 `TEAM_TENANT`）← `tenant/context.ts:59-65`（AsyncLocalStorage 里的帧）← `tenant/context.ts:144`（`runAsTenant(tenantId)`）← 请求入口 `auth/guards.ts:101`（`runAsTenant(session.user.id, …)`，即 Better Auth 的用户 id）。后台任务由 `runAsClaimedTenant`（`tenant/context.ts:122`，取被认领行上已有的租户戳）进入，或用常量 `system`／`platform`。
   - 解密：`credentials.ts:388`（`openCredential` 用 `requireBinding(row)` 重建附加数据；注释写明 binding 绝不从信封里读）← `row.tenantId` 来自 `readSecret`／`readModelSecret` 的 `select credentials.tenantId`（`credentials.ts:775-787`、`:789-821`），以及 `wakerflows/model.ts:95,163` 读的同一列 ← 也就是写入时那一列的值。
   - 数据库列：`db/schema/core.ts:434`（`credentials.tenantId: tenantId()`）→ `db/schema/tenant.ts:44-47`（默认值 `current_setting('app.tenant_id', true)`，由 `db/client.ts:297`、`:441` 按上面的帧设置）。`db/schema/tenant.ts:4-11` 写明租户与用户一一对应，值等于用户 id，另有 `system`／`platform`／`team` 三个常量。迁移 `drizzle/0052_adorable_hannibal_king.sql:31` 加这一列时，给的也是同一个默认值。迁移里没有把 `'openbot'` 写进任何 `tenant_id`：所有 `drizzle/*.sql` 中，`'openbot'` 只出现在 `0054_app_role.sql:15`，是数据库角色的密码。
   - 租户包 id 的去向：`brand.yaml` 的 `tenant.id` → `tenant-package.ts:759`（解析）→ `TenantPackage.tenantId`（`:239`）。它只用在三处：①`createApplicationConfiguration`（`:334`），即前端产物里的 `tenantId:"openbot"`；②`synchronizeTenantPackage` 写 `deployment_packages` 的一行（`:1171-1199`；表定义在 `db/schema/core.ts:262-270`，`tenant_id` 唯一，主键是随机 uuid；整个同步在 `system` 帧里跑，`:1146-1147`）；③`deploymentNameOf`（`:2255-2277`）→ `index.ts:944-947` 的 `deploymentId`，用于线程 id（`createThreadIdentity`）和 Shared 账号身份（`index.ts:1845`）。这三处都不碰 `credentials`，也不调用 `runAsTenant`。仓库里没有 `tenants` 表；所谓「租户行」就是各表的 `tenant_id` 列，值来自上面的帧。
   - `former_ids`：`tenant-package.ts:1205-1239` 只把 `agents`、`channels`、`skills` 的 `package_id` 从旧 `deployment_packages` 行改指到新行，不改任何 `tenant_id`，也不碰 `credentials`。它和凭据无关，保住凭据也用不到它。

   附带说明（不影响结论）：改租户包 id 的副作用都在 `deployment_packages` 和 `deploymentId`（线程 id、Shared 账号身份）这一侧，这正是 `former_ids` 设计要覆盖的范围，不属于本问。

6. **Helm chart（`charts/openbot/`）交付给客户吗？**
   现状：整套是上游的，名字、描述、维护者、镜像地址都是 OpenBot/CopilotKit（2.4）；京东云用的是 compose。
   建议：**不交付**，护栏整目录豁免。以后要交付 K8s 版本，另做一个 fork 自有的 chart（新目录，零同步冲突），不改上游这份。

7. **白名单「只减不增」是否允许上游同步 PR 例外？**
   现状：上游每次同步都可能带来新的持久化标记、协议值，严格「只增不减」会让同步无法合并。
   建议：**允许**，但限定六个分类、逐行能在上游同步点找到、PR 说明里列出（5.4）。熊宝自己的 PR 严格只减。

8. **改名后的新名字用 `xiongbao` 还是不带品牌的中性名？**
   涉及：请求头（`x-xiongbao-*` 已用）、存储键（`xiongbao-*` 已用）、第三方网页里的属性、扩展注入的元素和全局名。
   建议：开发者工具、镜像、安装包里的用 **`xiongbao`**（与已改的保持一致，以后再改名有品牌出口兜底）；**注入第三方网页的东西用不带品牌的中性名**（如 `data-xb-secret`、去掉全局名），因为被访问的网站能读到，带产品名等于给我们的 Bot 打指纹。

9. **以下残留是否接受为「永久保留」？**
   - 第三方库自带的 CopilotKit 字样（产物里 560 次：类名、`[CopilotKit]` 控制台日志、文档链接、Inspector 代码）；
   - 网络载荷里已持久化或与对端共享的标识符（2.10：`openbotVersion` 等字段名、`openbot/…` 工具引用、`openbot:…` 授权标记、Recorder 消息类型、`/api/copilotkit`）；
   - 数据库名与角色名（`openbot`、`openbot_app`、`openbot_role_writer`）、加密版本串；
   - 扩展的 IndexedDB 名 `openbot-recorder`（搬库有丢录制数据的风险）。
   建议：**接受**，进白名单 `keep` 类，在度量表里单列「永久残留」。理由：要么是第三方的名字（不是上游 OpenBot 的品牌），要么改了会坏数据或断开对端；它们只在开发者工具的网络页或数据库里出现。若你要求连这些也清掉，前三项需要分别立项（换库 / 数据迁移 / 双写字段），工作量远大于本阶段其余部分之和。

10. **窗口期按什么数？**
    建议：按**正式发布标签**数（不含 `-rc`），引入版本 N、N+1 都认旧名，N+2 删除；品牌去痕已有的双认从 **v0.2.9** 起算。环境变量的 `OPENBOT_*` 兼容读取**永久保留**（京东云 `.env.delivery` 不改）。涉及设备端的旧名，删除前再加一个条件：服务器上已看不到低于 N+1 的设备端连接（设备端没有自动更新）。

### 用户决定（2026-11-12）

用户答复「全部按你的建议执行」，即：

1. 仓库改为**私有**，客户拿到的镜像、安装包和部署脚本改由我们自己的渠道分发，部署文档里的链接全部换掉，镜像 `source` 标签不再指回本仓库。**改可见性由用户在 GitHub 仓库设置里操作**；切换前要先排好京东云现有部署脚本里下载地址的切换窗口（并入 R0）。
2. 镜像先剔除不运行的文件（并入 R4）；把服务器打包压缩成单文件作为 R4b 单独验证，跑通后再切换。
3. 服务器 ↔ agent-computer 的四个内部头改名（R8，排在最后）；`x-openbot-agent-token`、`x-openbot-desktop-host-token` 不改。
4. 服务器日志、启动报错、`--help` 算交付物可见面，全部改写（R3）。品牌去痕规格「内部日志保留」的决定作废。
5. 租户 id `openbot` 本阶段不改，先核实 `credentials.tenantId` 的来源。
6. Helm chart 不交付，护栏整目录豁免。
7. 白名单只减不增；上游同步 PR 例外，但只限六个分类，每一行都要能在上游同步点找到。
8. 开发者工具、镜像、安装包里用 `xiongbao`；注入第三方网页的东西用不带品牌的中性名。
9. 第 9 问列出的残留接受为永久保留，进白名单 `keep` 类，在度量表里单列。
10. 窗口期按正式发布标签数：N、N+1 都认旧名，N+2 删除；已有的兼容从 v0.2.9 起算；`OPENBOT_*` 环境变量永久兼容读取；设备端的旧名在删除前，还要确认服务器上已看不到低于 N+1 的旧设备连接。
