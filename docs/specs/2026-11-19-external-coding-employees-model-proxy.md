# 期八：外部编码员工走熊宝的模型代理

日期：2026-11-19 · 状态：**期八·一（模型代理）和期八·二（云电脑里跑，§8.2）已实现，其余分期见 §8**
基线：`main` 3279f261（期九·一 #717 之后）。

## 1. 用户拍板

2026-11-19，原话：「codex、claude code 时候我们封装的能力，不能让用户自己填写 KEY，直接调用熊宝内员工所使用的模型。」

由此定下：

- 用户电脑上的 Codex / Claude Code 不用、也不让用户配 key。
- 它们的模型请求一律经过熊宝服务器，由服务器用这位员工在熊宝里配置的模型和凭据转发。
- 服务器负责计量、计入配额和限流。
- 真实的 key 永远不下发到设备。

同日追加的两条（本期不做，见 §8）：

1. 把 Codex 和 Claude Code **做成两个固定员工**，用户选中就能直接用，不用招入，也不用配置。
2. 运行位置：**默认在这位员工自己的熊宝云电脑里跑**。镜像预装 Codex 和 Claude Code，模型走熊宝代理，不需要配对电脑，关掉网页照样跑。用户配对了自己的电脑、而且电脑在线时，可以**切到本机**跑，直接改本地代码。

本期做的是这两条路都要用的基础：服务器模型代理、短期令牌、计量，加上设备 runner 的注入。

## 2. 现状

- 招入外部员工只存「哪台电脑、哪个智能体、哪个文件夹、权限」，没有模型（`server/src/agents/profile-store.ts` 的 `ExternalAgentRun`）。
- 设备 runner 用固定命令起适配器（`runner/src/acp/manifest.ts`）：Codex 读用户自己的 `~/.codex`，Claude Code 读用户自己的设置，模型和 key 都是用户的。
- 内置员工的模型来自员工档案里的绑定（租户自己的模型库，或平台模型池），每次调用写一行 `model_token_calls`（`server/src/models/runtime-resolver.ts`、`token-metering.ts`）。外部员工以前不经过这条路。
- 仓库里没有通用的模型代理。

## 3. 方案（第一版：透传代理）

```
用户电脑                         熊宝服务器                          模型提供方
Codex / Claude Code  ──令牌──▶  /api/agent-model/v1/…  ──真实 key──▶  DeepSeek 等
(只有短期令牌)                  换 model、换鉴权、读用量、写 model_token_calls
```

### 3.1 代理端点

挂在 `/api/agent-model` 下，不走登录会话（调用方拿的是令牌）：

| 端点 | 格式 | 给谁用 |
|---|---|---|
| `POST /api/agent-model/v1/responses` | OpenAI Responses | Codex |
| `POST /api/agent-model/v1/messages` | Anthropic Messages | Claude Code |
| `GET /api/agent-model/v1/models` | 这位员工的那一个模型 | 两者列模型时用 |

**透传**：提供方原生支持这种格式时，请求体原样转给上游，只改三处——

1. `model` 换成这位员工在熊宝配置的模型；
2. 鉴权换成这位员工的真实凭据（租户模型库里的 key，或平台模型池的 key）；
3. 从响应里读用量（非流式读 JSON，流式边转边读 SSE，不留正文），写进 `model_token_calls`。

当前支持：

| 员工的模型 | Responses（Codex） | Messages（Claude Code） |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/responses` | `https://api.deepseek.com/anthropic/v1/messages` |
| OpenAI（官方地址或自填地址） | `…/v1/responses` | 不支持 |
| Anthropic | 不支持 | `…/v1/messages` |
| 其他 | 不支持 | 不支持 |

不支持时返回 400 和中文说明，例如「这位员工的模型（zhipu/glm-4）不支持 Codex 接入，请换成 DeepSeek 等兼容模型。」；员工没有可用的模型时说「这位员工还没有可用的模型，请在员工设置里为它选一个模型。」。错误体按调用方客户端能读的形状给（Responses 是 `{error:{message,…}}`，Messages 是 `{type:"error",error:{…}}`）。

### 3.2 令牌

每次 `acp.open` 为这位员工、这个线程签发一个令牌，**12 小时有效**。无状态：租户、员工、线程和起止时间用部署的加密密钥派生出的专用密钥签名（`server/src/agents/model-proxy/token.ts`），不进数据库，库被拖走也没有一个能用的令牌。

令牌只能用在这个代理：签名标签与登录、运行断言等其他签名值互不通用；代理只认它，不认任何别的凭据。

### 3.3 下发

`acp.open` 帧增加可选的 `model: { baseUrl, token, model, wire, expiresAt? }`（`shared/acp.ts`）：

- 只在员工是 Codex / Claude Code、并且在熊宝里有自己的模型、部署有对设备可达的公开地址时才带；否则不带这个字段，runner 照旧用用户自己的配置（老 runner 忽略这个字段，行为不变）。
- 帧里是令牌，不是 key。令牌随 `acp.open` 下发，不进 `acp_turns`、不写日志，也不出现在后续的 `acp.prompt` 里。
- 关于「帧不带秘密」：仓库里没有断言帧里不能有令牌的测试或注释。令牌短期、只通往代理、绑定一位员工，丢了的损失上限是 12 小时内的这位员工的用量，并受限流和配额约束。

### 3.4 runner 注入

只作用于这个适配器子进程，**不碰用户自己的配置**（`runner/src/acp/manifest.ts`、`host.ts`）：

- **Codex**：为这个进程在系统临时目录生成一个只属于它的 `CODEX_HOME`（权限 700），里面只有 `config.toml`：`model_provider="xiongbao"`，`[model_providers.xiongbao]` 的 `base_url` 为代理地址加 `/v1`，`env_key="XIONGBAO_AGENT_MODEL_TOKEN"`，`wire_api="responses"`，`requires_openai_auth=false`。令牌放在子进程环境变量里，不写进文件。进程退出（空闲超时、被替换、runner 关闭）时递归删除这个目录。用户的 `~/.codex` 一个字节都不动。
- **Claude Code**：子进程环境带 `ANTHROPIC_BASE_URL=<代理地址>`、`ANTHROPIC_AUTH_TOKEN=<令牌>`、`ANTHROPIC_MODEL` 和三档默认模型、`ANTHROPIC_SMALL_FAST_MODEL`；同时取消继承 `ANTHROPIC_API_KEY` 和三个切云平台的开关。不改用户的 settings。
- **令牌换新**：令牌在进程的环境里，改不了。一个空闲、令牌只剩不到 1 小时的进程，会被下一次带新令牌的 `acp.open` 换成新进程。
- 帧里没有 `model`、或格式不对（缺字段、地址不是 http(s)、格式和这个智能体不符）：按没有处理，行为和以前一样。

**适配器版本核对**（查了 npm 包内容，没有真跑）：

- `@agentclientprotocol/codex-acp@2.6.0` 依赖 `@openai/codex ^0.166.0`，npm 上 0.166.x 只有 0.166.0，所以内置的是 **Codex 0.166.0**。适配器自己的代码里处理 `model_provider`、`model_providers.<id>.base_url`、`wire_api`，自定义 provider 和 `wire_api="responses"` 都支持；`readAuthRequirement` 走 Codex 的账号读取，provider 不要求 OpenAI 登录时不会要求登录。评测 run 44461106077 用同一个 Codex 版本、同样的 `wire_api="responses"` 配置接 DeepSeek 跑通。
- `@agentclientprotocol/claude-agent-acp@0.107.0` 把自己的整个环境交给 Claude Code 进程（`env = {...process.env, …}`），所以 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL` 都认；选模型时 `ANTHROPIC_MODEL` 优先于 settings。

### 3.5 计量、配额、限流

- **计量**：每次调用写一行 `model_token_calls`，和内置员工同一套：租户是模型绑定所属的租户（租户自己的模型库按那一行的租户，平台模型池按付费租户），线程是令牌里的线程，用量是提供方报的数，提供方没报的字段是 null，不写成 0。非流式读 JSON；流式读 `response.completed`（Responses）或 `message_start` / `message_delta`（Messages）。流被中途掐断记 `stopped`，上游报错或没读到结尾记 `unknown`。Messages 格式把缓存命中的 token 单独算，入口 token 记为三者之和（和内置员工用的口径一致）。
- **配额**：沿用现有的套餐额度判断（每月任务数）：租户本月任务数超过套餐上限，返回 429 和中文说明。注意这套额度是按「任务」计的，没有 token 上限，所以代理不另造一个 token 配额（见 §7）。
- **限流**：每位员工每分钟最多 300 次调用（`XIONGBAO_AGENT_MODEL_RATE_PER_MINUTE` 可改），超出返回 429 和 `retry-after`。进程内计数。

### 3.6 出站

上游地址只来自熊宝自己的模型配置（租户模型库里那一行的地址，或平台模型池的地址，或提供方模板的默认地址），请求里的任何东西（请求头、查询串、请求体字段）都不能指定地址。出站走现有的 `guardedFetch`：地址必须过出站检查（云元数据地址一律拒绝，内网地址按部署开关），解析到内网的拒绝，3xx 一律不跟随，密钥不会随跳转带出去。

## 4. 安全边界

| 项 | 边界 |
|---|---|
| 令牌范围 | 只能用于 `/api/agent-model`；绑定租户、员工、线程；签名用专用派生密钥 |
| 有效期 | 12 小时；每次 `acp.open` 新签一个 |
| 作废时机 | ① 到期；② 员工被删除、不再是外部员工、不属于该租户时，**下一次请求就 403**（代理每次都查员工，无需主动作废）；③ `revoke()` 可在本进程内作废某员工此前签发的全部令牌；④ 令牌所在的适配器进程退出时，runner 删掉它的 `CODEX_HOME` |
| key 不出服务器 | 真实 key 只在代理里读出、只发给提供方；`acp.open` 帧、runner、设备日志、`model_token_calls` 里都没有；`model_token_calls` 只存 key 的摘要 |
| 跨租户 / 跨员工 | 令牌里的租户和员工是签名的，代理在令牌租户的行级安全范围里查员工，查不到就 403；内置员工即使绑了模型也不能用这个入口 |
| 客户端指定上游 | 无效，见 §3.6 |

## 5. 配置

| 变量 | 作用 | 默认 |
|---|---|---|
| `XIONGBAO_AGENT_MODEL_PROXY` | `off` / `0` / `false` 关掉代理，所有外部员工回到用户自己的配置 | 开 |
| `XIONGBAO_AGENT_MODEL_PUBLIC_URL` | 设备访问本服务器的地址（和部署的公开地址不同时才设） | 部署的公开地址 |
| `XIONGBAO_AGENT_MODEL_RATE_PER_MINUTE` | 每位员工每分钟调用上限 | 300 |
| `XIONGBAO_AGENT_MODEL_COMPUTER_URL` | 云电脑访问本服务器的地址（和设备用的不同时才设，§8.2） | 同上一行的设备地址 |
| `XIONGBAO_ACP_ADAPTERS_DIR` | 云电脑镜像里装适配器的目录（镜像里已设，§8.2） | `/opt/xiongbao-acp` |
| `XIONGBAO_ACP_STATE_DIR` | 云电脑里适配器的启动目录和各员工 agent 的家目录（镜像里已设） | 系统临时目录下 `xiongbao-acp` |

没有公开地址（本机单机部署没设）时不带 `model`，行为同以前。

## 6. 测试

- `server/tests/agent-model-proxy.test.ts`：假上游覆盖两种格式、流式与非流式；`model`、鉴权被替换；用量被记；令牌无效 / 过期 / 被改 / 跨租户 / 跨员工 / 员工被删返回 401 或 403；超额 429；限流 429；不支持的格式给中文错误；客户端塞别的地址无效；出站检查拒绝内网和跳转。
- `server/tests/agent-model-proxy.integration.test.ts`：真实表——员工、模型库绑定、凭据库里的 key、签发的令牌、用量真的进 `model_token_calls`、真实套餐额度、删除员工后令牌作废。
- `server/tests/acp-open-model.test.ts`：`acp.open` 带 / 不带 `model`；不带时和以前一字不差。
- `runner/tests/acp-host.test.ts`（新增的几例）：Codex 的临时 `CODEX_HOME` 和 `config.toml`、进程结束后删除、不碰 `~/.codex`；Claude Code 的环境变量；无 `model` 或格式不对时和以前一样；令牌将尽时换进程。

## 7. 第一版不做的事

- **格式转换**：Responses ↔ Chat Completions ↔ Messages 互转不做。员工的模型提供方不支持某个智能体的格式，就明确报错。
- **非兼容提供方**：智谱、月之暗面、OpenRouter 等只有 Chat Completions 的，Codex 和 Claude Code 暂时接不了。
- **token 配额**：套餐里没有 token 额度这个指标，代理只看现有的每月任务额度。要不要加 token 额度，是产品决定，不在本期。
- **跨进程作废、会话级作废**：作废靠到期和「员工还在不在」的实时检查；`revoke()` 只在本进程内有效。
- **每线程一个令牌**：一位员工在一台电脑上是一个适配器进程，几个线程共用，令牌记的是这个进程被打开时的那个线程，用量也记在这个线程下。
- Hermes 和用户自己的智能体（`custom`）不接代理。

## 8. 后续分期

2026-11-19 追加的两条拍板，分成两期做。本期的代理、令牌、计量和 runner 注入，是它们共同的基础。

### 8.2 云电脑里跑 Claude Code（期八·二，已实现）

目标：Claude Code 默认在员工自己的熊宝云电脑里跑，不需要配对电脑，关掉网页照样跑。

**拍板（用户，2026-11-19）：云电脑里先只有 Claude Code。** 镜像只预装 Claude Code 和 `@agentclientprotocol/claude-agent-acp@0.107.0`，不预装 Codex 和 codex-acp。Codex 员工只能在用户自己配对的电脑上跑（runtime 为 `device`）。落实：

- 服务器：harness 为 `codex` 时不允许 runtime 为 `cloud`。写入时（`externalConfiguration`，创建和修改都经它）直接拒绝，说「Codex 员工暂时只能在你自己的电脑上跑。」（`ACP_CODEX_CLOUD_REFUSAL`，路由里是 409）。已有数据里若出现 codex 加 cloud，读取时**不改按 device 处理，而是报同一句中文、不运行**（`externalRefusalReason`，`copilot.ts`）：改按 device 会让一个存着云设备号的员工去找一台不存在的电脑，或在语义上悄悄换了运行位置，报错更安全。
- 云电脑里 Codex 的代码（`cloudCodexConfigToml`、`cloudCodexRules`、`writeCloudCodexHome`、权限档和 `CLOUD_ASK_PREFIXES`）连同对应测试已删干净；云电脑的宿主收到 Codex 的 `acp.open` 一律以 `start_failed` 收尾、不起进程。设备端的 Codex 启动和 `writeCodexHome` 不动。

**运行位置**。员工配置 `agents.configuration.runtime` 取 `cloud` 或 `device`，缺省视为 `device`（`acpRuntimeFrom`，`shared/acp.ts`）。存在 JSON 里，没改任何表结构和迁移。`device` 员工的配置、发布给界面的字段、发给设备的帧都和以前一字不差；只有 `cloud` 员工多一个 `runtime: "cloud"`。`cloud` 员工没有设备和文件夹可选：它的 `deviceId` 在创建时由它自己的 id 生成（`cloud:<agentId>`，`acpCloudDeviceId`），文件夹是固定引用 `cloud:workspace`，读取时一律按 id 重算，不信存的值。`ExternalAgentRun.runtime`（`profile-store.ts`）带这个值，`PATCH /api/agents/external/:id` 不改它，也拒绝给云员工改电脑和文件夹。（招聘入口和界面是 8.3，本期没有对外的创建入口，用 `profiles.create(..., {external: {runtime: "cloud", …}})` 创建。）

**服务器到云电脑的通道**。关系层不动：relay 只向它的 channel 问三件事（写帧、通不通、走哪条连接），`cloud:<agentId>` 当作一台「设备」，所以云员工的轮次队列、泳道、对账、接管（adopt）、审批桥全部沿用 relay 的原有逻辑。`server/src/agents/acp/cloud-link.ts` 在真实 channel 前面回答 `cloud:` 开头的设备，其余设备原样交给真实 channel：

- **找电脑**：用电脑网关已有的做法，`seatFor(员工, 雇主)` → `locate`（电脑没起来就拉起来，并先推出站策略）→ `tokenFor`，带上电脑令牌和席位请求头。不走配对，没有第二条路。
- **往下**：`POST /acp/frame`，每位员工一条链按顺序发，先保证上行流已打开。发不出去时，按设备的说法补两种帧给 relay：`acp.open` 失败是这个开的 `acp.error`，`acp.prompt` 失败是该轮的 `acp.error` 加 `stopReason: "error"` 的 `acp.turn.end`，所以这一轮会以一句中文收尾，泳道不会卡。
- **往上**：每位员工一条长连接 `GET /acp/events`（一行一个 JSON）。第一行 `acp.stream`，然后是宿主的 `acp.inventory` 和它留着的所有帧，之后是新帧；每 4 秒一个 `acp.beat`。收到 beat 后服务器等 relay 把此前的帧都收进去（`drain`），再 `POST /acp/ack`，和设备心跳的 ack 完全同一套规则；收不进去就不 ack、断开重连，宿主会重发。
- **连接多久**：该员工在电脑上有轮次时一直开着，没有轮次且安静 10 分钟后关；断了而电脑上还有轮次就带退避重连。服务器重启后链是空的，由下一次发给它的帧、或一件排在旧轮次后面的活（`resume` → `ensure`）重新打开，盘点和重放再由 relay 对账（电脑上还在跑的接管，电脑丢了的标 interrupted）。**没有启动时的全库扫描**，所以重启之后没人再找它的云轮次要等到下一次互动才恢复。
- 新轮次入队之前先把流打开并收完盘点（`prepare` → `open`），否则先到的盘点会把还没发出去的轮次当成电脑丢了的。

**云电脑里的接口**。`agent-computer/src/acp-cloud.ts`，路由 `/acp/frame`、`/acp/events`、`/acp/ack`，在 `index.ts` 里排在电脑令牌检查、席位检查和「个人浏览器 id」检查之后，所以：没有令牌或令牌不对一律 401，不带可用员工 id 400，个人浏览器 id 403；`agentId` 和席位不一致 400（一位员工的路由只能替它自己说话）；`/acp/events` 关掉 Bun 的空闲超时。每位员工一个 runner 的 ACP 宿主（`runner/src/acp/host.ts`，同一份代码），一个宿主一条连接，新流替换旧流。`roots` 固定成这位员工的工作目录（和它的文件工具、shell 用同一个目录：`<WORKSPACE_DIR>/computers/<席位>`，没有分席位时就是工作区根），`apps` 恒为空；有自己 Linux 用户的员工（`COMPUTER_PER_BOT_USERS`）返回 409 拒绝，避免适配器用本进程的用户跑进那位员工的目录。

**镜像**（`agent-computer/Dockerfile`）。新加的独立一步，在拷源码之前：`docker/acp-adapters/package.json` 只钉 `@agentclientprotocol/claude-agent-acp@0.107.0`（自带 Claude Code），`bun.lock` 锁全部传递依赖（已不含任何 Codex），`bun install --frozen-lockfile --production` 装进 `/opt/xiongbao-acp`，装完当场检查适配器版本 `0.107.0`，不对就构建失败。启动时不再 `npx`、不下载任何东西。预计体积约 **0.43 GB**（本机实测 `node_modules` 425 MB：Claude Code 二进制 346 MB，其余是依赖；去掉 Codex 后比原来的约 0.9 GB 少约 0.45 GB）。另外拷入 `runner/src/acp/`、`runner/src/idle.ts`、`runner/src/mcp-client.ts`、`runner/src/bundled-runtime.ts` 和 `shared/acp.ts`；`IDLE_MS` 挪到 `runner/src/idle.ts`，宿主不再经 `app-host.ts` 带进整个 MCP 桥。**根 `Dockerfile`（服务器镜像，里面也跑一台电脑，CI 的 per-bot-users-smoke 用的就是它）同样要拷这几个 runner 文件到 `/app/runner/src`**：电脑从 `/app/agent-computer/src` 按 `../../runner/src/acp/host` 找宿主，缺了进程启动即崩（PR #722 第一次 image job 的根因）；这个镜像里没有适配器，云员工的 open 只会 `start_failed`。`tests/acp-adapters-image.test.ts` 检查版本钉死且和 `ACP_MANIFEST` 一致、锁文件含这个版本且不含 Codex、这一步用冻结安装并排在源码之前，顺着 import 检查宿主运行时依赖的每个模块都拷进了电脑镜像，并检查根 Dockerfile 拷了同一批文件。

**模型怎么注入**。和设备端是同一套：设备端的 Codex 用临时 `CODEX_HOME` 里的 `config.toml`（令牌放进环境变量不写文件），云电脑里的 Claude Code 用 `ANTHROPIC_*` 环境变量，令牌是同一种短期令牌（`acp.open.model`）。区别只有代理地址：云电脑在部署自己的网络里，用 `XIONGBAO_AGENT_MODEL_COMPUTER_URL`（例如 `http://server:3001`；不设就用设备用的地址，即 `XIONGBAO_AGENT_MODEL_PUBLIC_URL`，再不然部署的公开地址），`createAcpModelAccess` 对云员工发这个地址。云员工**必须有自己的模型**：电脑上没有登录，也从不读主人的设置，没有模型的云员工这一轮直接以「还没有可用的模型，请在员工设置里为它选一个模型」结束，不发任何帧，轮次标 cancelled。适配器进程的环境是白名单（和 shell 命令一样的变量，加上出站过滤器的代理变量，`HOME` 指向员工自己的家目录 `XIONGBAO_ACP_STATE_DIR/homes/<席位>`，不在工作文件夹里），本进程的其余变量（电脑令牌、带密码的代理）全部取消继承；Claude Code 的自动更新和非必要流量都关掉。

**出站**。适配器进程走出站过滤器，和员工的命令受同一份网络策略管。企业控制在推给每个员工电脑的策略里，对「列出目的地」的两种模式（`allowlist_only`、`defaults_plus_allowlist`）自动加上代理地址的 host:port（`withDestinations`）；`allow_all` 本来就能到，`deny_all`（管理员或能力开关说什么都不许出）保持不变，那时云员工没有模型可用。注意这条规则放行的是这台熊宝服务器的整个来源（host:port），不止代理路径。

**沙箱结论**。Codex 在云电脑里的沙箱、权限档和执行策略规则的实测与做法，随 2026-11-19 的拍板和代码一起删除（Codex 不在云电脑里跑）。

**Claude Code**：不用动，会话切到 `default`（先问再做），每个请求都经 ACP 权限请求到审批桥，和设备端一样；它自己的沙箱默认关、保持关。容器以 root 运行，Claude Code 在 root 下只拒绝 `--dangerously-skip-permissions`，本方案从不使用。

**测试**。`agent-computer/tests/acp-cloud.test.ts`（宿主、Claude Code 的启动命令和环境、Codex 的 open 被拒、流和 ack）、`agent-computer/tests/acp-cloud-http.test.ts`（真进程，未带令牌、令牌不对、查询串令牌、无席位、员工 id 不符都拒绝）、`runner/tests/acp-cloud-launch.test.ts`（Claude Code 的启动规格，设备端启动不变）、`server/tests/acp-cloud.test.ts`（真 relay、内存轮次库、真云电脑通道：云员工的 `acp.open` 走电脑网关、设备员工不变、缺省视为设备、codex 加 cloud 写入被拒、已存的 codex 加 cloud 读取时不运行、电脑够不着时的收尾、无模型、空闲关流、重开）、`server/tests/computer-policy-destinations.test.ts`、`tests/acp-adapters-image.test.ts`。

**没有真跑过的**：真实 Docker 里的镜像构建和启动（交给 CI 的 image job；本机按镜像的拷贝布局在临时目录里起过电脑进程，缺 runner 文件时复现了崩溃，补上后正常，适配器目录不存在时进程照常启动）；Claude Code 适配器在容器里的一整轮（没有真实模型）。

**许可证**。Claude Code 的二进制和 SDK 是 Anthropic 的专有许可（「SEE LICENSE」，使用受其法律条款约束），不是开源许可。用户已知晓这一点，并决定把它预装进云电脑镜像（2026-11-19）；把镜像对外再分发之前，仍需有人确认再分发条款。Codex 不再预装，其 LGPL 动态库的顾虑随之不适用于云电脑镜像。

### 8.3 两个固定员工本身

- 租户包里预设 Codex 和 Claude Code 两个固定员工：Claude Code 默认跑在云电脑；Codex 只能在本机跑，需要配对电脑（2026-11-19 拍板，见 8.2）。Claude Code 选中就能直接用，不用招入、不用配置、不用填 key；Codex 要先配对一台自己的电脑。它们的模型取自租户包里指定的平台模型池行（DeepSeek 等兼容模型），经本期的代理。
- 员工设置里的「云电脑 / 本机」切换：只对 Claude Code 有，默认云电脑；用户配对了自己的电脑、且电脑在线时可以切到本机，直接改本地代码。切到本机时走本期做好的 runner 注入，切回云电脑时走 8.2。Codex 员工没有这个切换，运行位置固定为本机；界面和接口都不得让它选云电脑。
- 招入外部员工的现有流程（`POST /api/agents/external`）保留，给用户自己招的外部员工用。
- 界面部分要截图给用户确认后再推。
