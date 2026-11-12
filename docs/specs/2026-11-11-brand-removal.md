# 熊宝「品牌去痕」阶段设计稿

状态：用户 2026-11-12 同意（「接着做品牌去痕」），第 7 节按建议执行，公司名先用「熊宝」占位；实施计划见 `docs/plans/2026-11-12-brand-removal.md`
日期：2026-11-11
依据：用户决定（2026-11-11）——当前设计工作完成后去掉 OpenBot 的痕迹，产品要对外销售，必须看起来是原创；路线定为「先品牌去痕，再逐步重写」；团队要继续同步上游 OpenBot 的更新；MIT 许可的义务照常履行。
盘点来源：`brand-inventory.md`（只读盘点，数字为近似值）。

---

## 0. 一句话

这一阶段只做一件事：**客户能看到、能摸到的地方不再出现 OpenBot / CopilotKit / qoder 的名字和图标**；代码内部的名字一概不动，好让以后合并上游时几乎不打架；同时把开源声明补齐，做到「看不出上游，但版权声明一条不少」。

---

## 1. 目标与不做的事

### 1.1 目标

1. 客户在**网页、设备端安装包、渠道消息（Slack/Telegram/短信/推送）、第三方授权页、移动端**上看不到上游名字和上游图标。
2. 模型拿到的提示词里不再自称 OpenBot（否则模型会把这个名字说给客户听）。
3. 产品名只有**一个出口**：以后要改名，改一处即可。
4. 运维配置可以用 `XIONGBAO_*` 新名字，**旧的 `OPENBOT_*` 名字继续有效**，京东云现有的 `.env.delivery` 一个字都不用改。
5. 补齐开源声明：仓库根、镜像里、应用里的「关于 / 开源软件声明」页面。
6. 加一道「品牌护栏测试」，每次合并上游后自动列出新冒出来的上游字样。

### 1.2 不做的事（以及为什么）

| 不动的东西 | 为什么不动 |
|---|---|
| 目录名 `openbot/` | 全部 CI 和上游的每个文件路径都挂在它下面。一改，以后每次合并上游都会变成「整棵树改名」，冲突无法收拾。 |
| 内部包名 `@openbot/*`、根 `package.json` 的 `"name": "openbot"` | 都是 `private`，不对外发布，客户看不到；改了每次合并都冲突。 |
| 依赖 `@copilotkit/*`（`react-core`、`a2ui-renderer`、`runtime`） | 这是我们实际使用的第三方库，名字是库作者的，不是我们的品牌；换名就等于换库。 |
| 代码里的类型名、函数名（如 `OpenBotRole`）、注释、测试 | 客户看不到；改动量约 1 900 行测试 + 几百处标识符，全是合并冲突来源。留给「逐步重写」阶段顺手处理。 |
| 数据库名 `openbot`、角色 `openbot_app` / `openbot_role_writer`、迁移 SQL、`pg_notify('openbot_work_offered')` | 已部署的库已经执行过这些迁移；历史迁移按规矩不能改；改名还会和上游以后的迁移冲突。 |
| 加密/签名用的「域串」：`openbot.vault.credential.v2`、`openbot:agent-run`、`openbot-bearer`、`openbot-automation-hook-signing:v1` | **改了会让已加密的凭据解不开、已签发的令牌全部失效**。绝对禁止。 |
| 已写进历史记录的事件名和标记：`openbot.headless.waiting`、`openbot.ap.local-terminal.v1`、`<<openbot:app-access-request>>` | 老对话、老线程里已经存着这些字样，程序靠它们识别；客户界面上显示的是渲染后的卡片，不是原文。 |
| 容器/K8s 标签（`openbot.bot-id` 等）、Helm chart 目录 | 程序靠标签找到已有的容器；改名会让升级后的旧容器变「孤儿」。 |

**判断原则**：客户看得见 → 这一阶段改；只有开发者打开工具才看得见 → 放到第 6 节的可选包里；看不见、或者改了会坏数据 → 不动，写进护栏白名单。

---

## 2. 分层清单（按客户接触面）

处理方式三种：
- **改名**：直接换成熊宝的名字。
- **双认**：新名字优先，旧名字仍然接受（为了不打断已有部署、已安装的客户端、已存的数据）。
- **保留**：不动，列入护栏白名单。

### 2.1 网页（SPA，`openbot/app/src`）——已基本干净，剩 3 处

| 位置 | 现状 | 处理 |
|---|---|---|
| `components/layout/self-host-banner.tsx:13` + `server/src/config.ts:1262-1265` | 「自行部署」推广条链到 `copilotkit.ai`；**代码默认是开的**，现在只靠京东云配置 `OPENBOT_SELF_HOST_BANNER=false` 压住 | **改**：代码默认改为关（只有显式写 `true` 才开）。推广链接改为读品牌出口里的「联系我们」地址，没配就不显示。 |
| `lib/copilot/generative-ui.ts:25,27,43` | 发给模型的说明里写「OpenBot's chat transcript」等 | **改名**：用 `appConfig.brand.englishName` 插值（一个常量，三处一起改）。 |
| `main.tsx:20` | 报错文字「OpenBot could not find…」 | **改名**（一行）。 |
| 管理页里提到 `OPENBOT_PUBLIC_URL` 等变量名（`responsibilities.tsx:861`、`admin/plugins/$key.tsx:950`、`admin/enterprise.tsx:505`） | 管理员可见 | **改**：显示新名字 `XIONGBAO_*`，括号注明「旧名 `OPENBOT_*` 仍可用」。随第 3 节一起做。 |

### 2.2 设备端安装包（`desktop-device/`）——最显眼的漏网项

| 位置 | 现状 | 处理 |
|---|---|---|
| `desktop-device/src-tauri/tauri.conf.json` 的 `bundle.icon` | 直接引用 `../../desktop/src-tauri/icons/*`，即**上游的彩色渐变球**；安装包、任务栏、Dock、托盘看到的都是它 | **改**：在 `desktop-device/src-tauri/icons/` 用熊宝 logo 生成全套图标（`.icns/.ico/.png`、各尺寸），配置改指向这里。该目录是本 fork 独有，零合并冲突。 |
| 安装包「属性/关于」里的版权字段 | 设备端没有 `copyright` 字段 | **加**：`Copyright (c) 2026 <公司名>; portions Copyright (c) 2026 CopilotKit (MIT)`。 |
| sidecar 进程名 `openbot-runner(.exe)` | 客户在任务管理器、安装目录里能看到 | **改名**为 `xiongbao-runner`。涉及 `sidecar.rs:18`、`tauri.bundle.conf.json`、`scripts/build-sidecar.ts`、`device-release.yml`、两个签名校验脚本。自动升级时旧文件由安装器覆盖删除；实现时确认升级路径能清掉旧进程。 |
| `OPENBOT_RUNNER_BINARY` / `OPENBOT_RUNNER_DATA_DIR` | 运维可见 | **双认**（随第 3 节）。数据目录名本身**保留**，否则已安装设备的数据会「失联」。 |

### 2.3 服务端发出的客户可见文字（约 25 处，全是散落的英文字面量）

全部**改名**，统一改成从品牌出口取名字（第 3 节）：

- 渠道消息：`delivery/opentag-agent.ts`（约 10 处机器人回话）、`delivery/twilio.ts:121`（短信）、`delivery/router.ts:576`（推送标题）、`index.ts:902`（审批通知）、`proactive/engine.ts:263`。
- 登录落地页：`auth/native-browser.ts:44`（「Sign in to OpenBot」）；`auth/organization.ts:25,273` 报错。
- 模型可见：`agents/connection-test.ts:82`（发给客户模型的连通测试语）、`voice/provider.ts:72`、`plugins/tools.ts:110,117`、`copilot.ts:1790-1841,2645` 的系统提示分段标题、`memory/tools.ts` 的工具**描述**（工具 id `openbot:personal-memory` **保留**）。
  - 注意：`copilot.ts` 的分段标题改前要确认没有别处按原文去解析它们。
- 示例域名：`plugins/broker.ts:677` 的 `openbot.example.com` → `example.com`。
- 演示账号邮箱 `dev@openbot.local`：**京东云交付用的是单用户模式（`OPENBOT_SINGLE_USER=true`），这个邮箱会显示在界面上**。处理：先把 6 个文件里重复的常量合并到 `auth/dev-actor.ts` 一处，再改成 `admin@xiongbao.local`（或用户定）。该账号按固定 id 写库、启动时会覆盖邮箱，旧库升级安全；比较逻辑统一用新常量，同时认旧邮箱一个版本（**双认**）。

内部日志、内部错误（约 160 处）**保留**，进白名单。

### 2.4 第三方会看到的我们的名字

| 位置 | 客户在哪看到 | 处理 |
|---|---|---|
| `plugins/oauth.ts:488` `client_name: "OpenBot"` | **第三方 OAuth 授权同意页**上的应用名 | **改名**为英文产品名（第 7 节待定）。只影响新注册的客户端；已注册的保持原样直到重新连接。 |
| `plugins/composio-adapter.ts:2347` 后缀 `(OpenBot)` | Composio 后台的连接配置名 | **改名**。已有配置的名字不动（程序按 id 查找，不按名字）；实现时确认这一点。 |
| `plugins/mcp.ts:507` `name: "openbot"` | 外部 MCP 服务端日志里我们的自报名 | **改名**（一行）。 |
| `plugins/catalogue.ts:1528,1549` `vendor: "OpenBot"` + GitHub 文档链接 | 插件目录界面 | **改**：厂商写公司名；文档链接改为我们自己的帮助页，没有就去掉链接。 |

### 2.5 移动端（`openbot/mobile/`，Expo，尚未白标）

| 项 | 现状 | 处理 |
|---|---|---|
| App 名 / slug | `OpenBot` / `openbot` | **改名**。 |
| 包名 `ai.openbot.mobile`（iOS bundle id、Android package） | | **改名**，例如 `com.xiongbao.mobile`。**上架后永远不能改**，必须首次上架前定（第 7 节）。 |
| 深链 scheme `openbotmobile://` | 与服务端 `auth/index.ts:41`（`NATIVE_APP_ORIGIN`）、`delivery/push.ts:56` 成对 | 移动端**改名**为新 scheme；服务端**双认**：登录回跳两个 scheme 都接受，推送深链发新 scheme。若确认从未有人装过旧版，可直接改名不双认。 |
| 界面文字、通知渠道名 `"openbot"`、`openbot-device-id` 存储键 | | **改名**（App 未发布，无老数据包袱）。 |

### 2.6 自托管整栈安装器（`openbot/desktop/`）——先问要不要交付

现状：英文界面满屏「Install OpenBot / Connect to CopilotKit」（约 60 行）、窗口 `<title>OpenBot</title>`、装到 `~/OpenBot`、`copyright: "CopilotKit"`、报错页链到上游 GitHub、**默认向 `telemetry.copilotkit.ai` 上报使用数据**，并依赖 CopilotKit Intelligence 云服务登录。CI 里**没有它的发布流程**，目前对客户发的只有设备端和服务端镜像。

处理：
- **如果不交付客户（推荐）**：本阶段不做，只把它的图标与设备端解绑（2.2 已做到），并在护栏白名单里整目录豁免。
- **如果要交付**：单独立项，第一件事是**默认关闭向 CopilotKit 的遥测**（这是隐私合规问题，优先于改名），再处理界面、安装目录（双认旧目录）、CopilotKit Intelligence 依赖。工作量远大于本阶段其余部分之和。

### 2.7 协议层（客户只有打开浏览器开发者工具才看得见）

| 面 | 处理 | 理由 |
|---|---|---|
| `x-openbot-voice`、`x-openbot-dictation`（浏览器→服务端） | 本阶段**保留**；可选包 P7 里**双认**改名 | 普通客户看不见；网页和服务端同版发布，改起来不难，但牵涉上游文件和测试。 |
| `x-openbot-agent-token`、`-bot-id`、`-computer-token`、`-desktop-host-token`、`x-openbot-egress` | **保留** | 服务之间的内部暗号；Python 里还硬写了 12 份；已装在客户电脑上的旧设备端会因此连不上。 |
| Cookie `openbot.organization-session` | 可选包 P7：**双认**（写新名、读新旧两个） | 单文件改动；旧名直接改会把所有已登录的人踢下线。 |
| 浏览器本地存储键（`openbot-theme`、`openbot-sidebar` 等约 10 个） | 可选包 P7：**改名 + 一次性搬家**（读不到新键就读旧键并搬过去） | 否则用户的主题、侧栏偏好会丢。`app/index.html` 内联脚本里的 `openbot-theme` 必须同步改。 |
| 接口路径 `/api/copilotkit` | **保留** | 这是 CopilotKit 库的约定路径，库本身就是我们公开使用的依赖；改它要动 70+ 处测试，收益几乎为零。 |
| `/openbot/membership`、`/openbot/deliver`（对 OpenTag 的出站接口） | **保留** | 对方系统也要认这个路径，不归我们单方面改。 |
| `data-openbot-*` 页面属性、`__OPENBOT_WS_PORT__` | **保留**（进白名单） | 检查元素才看得见，两端成对，收益低。 |
| `<<openbot:app-access-request>>` 标记 | **保留** | 已存进历史消息；界面显示的是卡片而不是这串字。 |
| OTel `service.name` 默认 `"openbot"`、属性名 `openbot.*` | 默认 `service.name` **改名**（一行，可被配置覆盖）；属性名**保留** | 客户接自己的监控系统会看到服务名；属性名改了会打断客户已有的查询和告警。 |

### 2.8 文档与其他 fork 自有文件（零合并冲突，可直接改）

- `openbot/examples/qoderwake/` → `openbot/examples/xiongbao/`；`docs/deployment-qoderwake.md` 等改名；同步改 `TENANT_PACKAGE_DIR` 的默认值（`config.ts:1377`、`Dockerfile:86,169`、`.env.example`、`docker/delivery.env.example`、CI）。**京东云 `.env.delivery` 里若写死了旧路径，旧路径保留一个兼容软链接或在启动时回退**，不能让现有部署启动失败。
- `docker-compose.yml` 里开发用镜像名、根 README 的镜像地址：可选，属于开发者可见。
- 上游的 `openbot/README.md`、`openbot/docs/*`、`CHANGELOG.md`、`prompt.txt`、架构图：**不随交付物给客户**（第 7 节确认）；仓库里保留原样，便于合并。

---

## 3. 一个品牌出口

### 3.1 产品名：复用已有的租户包流水线

已经有的：`examples/<租户>/brand.yaml`（`product_name`、`english_name`、`tagline`）→ `server/src/tenant-package.ts` 解析 → 构建期写出 `app/src/lib/generated/application-config.ts` → 网页用 `appConfig.brand`。

要补的：
- `brand.yaml` 增加几个字段：`company_name`（公司名，用于版权、厂商、OAuth）、`support_url`（替代推广条和 GitHub 链接）、`mobile_scheme`（可选）。
- 新增 `server/src/brand.ts`：从已加载的租户包里读，导出 `productName()`、`englishName()`、`companyName()`、`supportUrl()`。**服务端所有客户可见文字只从这里取名字**，不再写字面量。
- 网页侧继续用 `appConfig.brand`，不另造。
- 这个文件是 fork 新增文件，上游不会碰；上游文件里每处只改成一次函数调用，冲突面小。

以后改名：改 `brand.yaml` 一处 + 换图标目录，结束。（移动端包名、深链 scheme 例外：它们写进安装包，上架后不能改。）

### 3.2 环境变量：新名优先、旧名兜底

- 规则：读 `X` 时先找 `XIONGBAO_X`，没有再找 `OPENBOT_X`。两个都设了且不一样时，用新名并在启动日志里提示一次。
- 落点两处，保证所有进程（服务端、runner、supervisor、容器里的脚本）一致：
  1. 服务端 `config.ts` 的 `optional()` 函数（95 处读取都经过它）加上这条规则；
  2. 容器启动时（s6 初始化阶段）加一个 fork 自有的小脚本：把每个 `XIONGBAO_*` 抄成对应的 `OPENBOT_*`，这样不经过 `config.ts` 的组件也自动认新名。具体落点实现时核实。
- **不做**全局把 `OPENBOT_` 替换成 `XIONGBAO_`：118 个变量名、748 处引用，会让每次合并上游都冲突。
- 京东云：`.env.delivery` 用的都是 `OPENBOT_*`，**不需要改，也不应该在这一阶段改**。新交付的客户文档写新名字。
- 客户可见的样例文件（`docker/delivery.env.example`）改写为新名字，并注明旧名仍可用。

---

## 4. 开源声明与合规

MIT 许可只要求一件事：**在软件的所有副本或实质部分里保留原版权声明和许可全文**。它不要求在界面上宣传上游，也不禁止改名。所以「去痕」和「合规」不矛盾——去掉的是品牌露出，保留的是版权声明。

要做的：
1. **保留** `openbot/LICENSE` 原文（`Copyright (c) 2026 CopilotKit` + MIT 全文），一个字不改。根 `README.md:161-166` 的上游声明保留（仓库内部文件，不随交付物）。
2. **仓库根新增** `NOTICE`：说明本产品包含基于 MIT 许可的 OpenBot 代码，附原版权声明和许可全文；另生成 `THIRD-PARTY-NOTICES`（第三方依赖许可汇总，用脚本从依赖清单生成，含 `@copilotkit/*` 等）。
3. **镜像内**：Dockerfile 把 `NOTICE`、`THIRD-PARTY-NOTICES`、`openbot/LICENSE` 复制到 `/licenses/`。设备端安装包也带上这几个文件。
4. **应用内「关于 / 开源软件声明」页**（设置里一个入口）显示：
   - 产品名、版本号、`© 2026 <公司名>`；
   - 一句话：「本产品使用了以下开源软件」；
   - OpenBot（MIT）：版权行 `Copyright (c) 2026 CopilotKit` + MIT 许可全文；
   - 第三方依赖列表：名称、版本、许可类型，可展开看全文；
   - 不放上游仓库链接、不放上游 logo（许可不要求）。
5. **安装包版权字段**：`Copyright (c) 2026 <公司名>; portions Copyright (c) 2026 CopilotKit (MIT)`，不要简单把 CopilotKit 换掉。
6. 第三方供应商 logo（Google、Slack 等，`desktop/src/marks/`）属于他们的商标，保持原样。

> 说明：以上是工程上的通行做法，不是法律意见。若产品合同对开源有特别条款，建议请法务过一遍声明页文字。

---

## 5. 跟进上游

### 5.1 品牌护栏测试

新增 `openbot/app/tests/brand-leak.test.ts`，照抄 `app/tests/glossary-terms.test.ts` 的写法：
- 扫描范围：`app/src`、`server/src`、`desktop-device/`、`mobile/`（以及 `app/index.html`、`tauri.conf.json` 等清单文件）。
- 查找：`/OpenBot|CopilotKit|copilotkit\.ai|qoder/i` 出现在**非注释**行。
- 白名单（每条写明理由）：
  - `@copilotkit/*` 的 import 和样式引用；
  - `/api/copilotkit` 路径；
  - 第 1.2 节列出的加密/签名域串、事件名、标记、数据库角色名；
  - `x-openbot-*` 请求头、`data-openbot-*` 属性、存储键（P7 做完后从白名单删掉）；
  - `OPENBOT_` 环境变量名（作为兜底读取）；
  - 代码标识符（`OpenBot` 后跟大写字母的类型名等）；
  - 整目录豁免：`openbot/desktop/`（若决定不交付）、`server/drizzle/`、测试目录、`generated/`；
  - `server/src/brand.ts` 自身。
- 另加一条图标检查：设备端 `tauri.conf.json` 的图标路径不得指向 `desktop/src-tauri/icons`。

### 5.2 合并上游的固定步骤

1. `git fetch upstream` → 合并到一个合并分支；
2. 解决冲突（预期集中在约 30–40 个上游文件，每处 1–3 行，基本都是「字面量 vs 品牌函数调用」，保留我们这边即可）；
3. 跑护栏测试；
4. 失败列表 = 上游这次新加的品牌字样，逐条决定：接品牌出口，或加进白名单并写理由；
5. 跑全量测试，合并。

### 5.3 为什么这样合并成本低

- 不改目录、包名、标识符、迁移，所以上游的大部分改动**原样落地**；
- 我们的改动绝大多数在 fork 自有文件里（`brand.ts`、`brand.yaml`、图标目录、`NOTICE`、启动脚本、护栏测试），上游根本不碰；
- 在上游文件里的改动是「一处字面量 → 一次函数调用」，冲突小且一眼能看懂；
- 漏网的新字样不靠人眼找，靠测试自动列出来。

---

## 6. 分包、顺序、验收、风险

### 6.1 分包（每个包可独立上线，按顺序做）

| 包 | 内容 | 主要改哪里 | 合并冲突 |
|---|---|---|---|
| P1 合规底座 | `NOTICE`、`THIRD-PARTY-NOTICES`、镜像 `/licenses/`、应用内「关于 / 开源软件声明」页、安装包版权字段 | fork 自有为主 + Dockerfile 一行 + 设置页一个入口 | 极小 |
| P2 品牌出口 + 护栏 | `brand.yaml` 新字段、`server/src/brand.ts`、环境变量双认（`optional()` + 启动脚本）、护栏测试（先把现有残留全部列为「待修」清单） | fork 自有 + `config.ts` 一个函数 | 小 |
| P3 设备端 | 熊宝图标全套、设备端版权字段、`xiongbao-runner` 改名 | `desktop-device/`（fork 自有）+ 发布流程 | 零 |
| P4 网页与服务端文案 | 推广条默认关、generative-ui 文字、2.3 的约 25 处文字、演示账号邮箱、OAuth 应用名、Composio 后缀、MCP 名、目录厂商与链接、OTel 默认服务名 | 上游文件，每处 1–3 行 | 中（这是要长期维护的「品牌补丁」） |
| P5 fork 自有改名 | `examples/qoderwake` → `examples/xiongbao`、`docs/*-qoderwake.md`、各处默认值（旧路径兜底） | fork 自有 | 零 |
| P6 移动端 | App 名、包名、scheme、文字；服务端双认 scheme | `mobile/` + 服务端 2 处 | 小。**等第 7 节定名后再做** |
| P7（可选）开发者工具里的痕迹 | 存储键改名+搬家、组织登录 cookie 双认、语音/听写请求头双认 | 网页 + 服务端约 15 处 | 中 |

`desktop/` 整栈安装器不在以上包内，待第 7 节决定。

### 6.2 验收方式（用户自己能检查的）

在京东云（部署 P1–P5 后）：
- 打开网页，各主要页面、设置、管理页、插件目录：看不到 OpenBot / CopilotKit / qoder 字样，看不到「自行部署」推广条（**哪怕把 `.env.delivery` 里那行关推广条的配置删掉也不出现**）；
- 右上角/设置里能找到「关于 / 开源软件声明」，里面有 CopilotKit 版权行和 MIT 全文；
- 问数字员工「你是谁 / 你叫什么」：回答熊宝，不提 OpenBot；
- 连接一个第三方 OAuth 插件：授权同意页显示的应用名是我们的名字；
- 从 Slack/Telegram/短信收到的通知里没有 OpenBot；
- 京东云的 `.env.delivery` 不做任何修改，升级后照常启动、照常登录、老数据都在（**这是最重要的一条**）。

在设备端（安装 P3 新版）：
- 安装包图标、桌面快捷方式、任务栏/Dock、托盘：都是熊宝 logo；
- 任务管理器里进程叫 `xiongbao-runner`，没有 `openbot-runner`；
- 安装包「属性」里的版权写的是公司名 + portions CopilotKit；
- 从旧版本直接升级，设备仍能连上服务端，原有数据还在。

工程侧：护栏测试通过，且白名单每条都有理由。

### 6.3 风险

| 风险 | 后果 | 对策 |
|---|---|---|
| 误改了加密/签名域串或持久化事件名 | 凭据解不开、令牌失效、老对话里卡片消失 | 第 1.2 节清单写进护栏测试的「禁止改」检查：这些字符串必须原样存在。 |
| 环境变量双认写错 | 京东云升级后起不来 | 加测试：只设旧名、只设新名、两个都设三种情况；上线前用 `.env.delivery` 原文启动一遍。 |
| 推广条默认值翻转 | 若有人依赖它默认开（上游行为） | 只影响我们自己的产品；在 CHANGELOG 注明。 |
| runner 改名后旧进程残留 | 设备上同时跑两个 runner | 升级流程里显式停旧进程、删旧文件；在两台旧版设备上实测升级。 |
| 移动端包名定错 | 上架后无法更改 | 第 7 节先拍板，再做 P6。 |
| 上游大改某个文件 | 品牌补丁冲突增多 | 补丁每处都是一次函数调用，冲突时按「保留函数调用」处理；护栏测试兜底。 |
| `@copilotkit/runtime` 库自身可能默认上报遥测 | 客户数据流向第三方 | 实现 P2 时核实；若确实上报，交付镜像里默认关闭（第 7 节）。 |
| 声明页写法不符合合同要求 | 合规争议 | 请法务过一遍 P1 的文字。 |

---

## 7. 需要用户拍板的问题（每条附建议）

1. **`desktop/` 自托管整栈安装器要不要交付给客户？**
   建议：**不交付**。客户只拿到服务端镜像（京东云）和设备端安装包。这样本阶段不碰它，省下最大一块工作量；以后真要交付再单独立项。
2. **移动端的最终名字**：App 显示名、包名（bundle id）、深链 scheme。
   建议：显示名「熊宝」；包名 `com.xiongbao.mobile`（与设备端 `com.xiongbao.device` 一致）；scheme `xiongbao://`。另外请确认：移动端是否已经给任何客户装过？没有的话可以直接改名，不用双认。
3. **英文产品名和公司名**（用于版权行、OAuth 授权页、插件目录厂商、声明页）。
   建议：英文产品名用 `brand.yaml` 里已有的 `XiongBao Work`（现写作 `xiongbao work`，建议规范大小写）；公司名请用户提供营业执照上的中英文全称。OAuth 授权页上用英文产品名。
4. **默认关闭向 CopilotKit 的遥测上报吗？**
   建议：**关闭**。我们的交付物默认不向任何第三方上报使用数据（包括 `telemetry.copilotkit.ai`，以及若核实存在的 `@copilotkit/runtime` 库上报）。这是对客户的隐私承诺，比改名更重要。
5. **上游文档（`openbot/README.md`、`docs/`、`CHANGELOG.md`、架构图）会不会给客户？**
   建议：**不给**。仓库里保持原样方便合并，客户文档另写中文版（根 `README.md` 和 `docs/` 下我们自己的文档）。
6. **演示账号邮箱改成什么？**
   建议：`admin@xiongbao.local`。
7. **「逐步重写」怎么安排？**
   建议：**另写一份设计稿**，本阶段不涉及。本阶段的品牌出口和护栏测试会成为重写的基础：重写一块，就从白名单里删掉一块。
8. **可选包 P7（开发者工具里看得见的痕迹）做不做？**
   建议：**做，但排在最后**。卖给企业客户时，对方技术人员可能会打开开发者工具看；成本不高，但不急。
