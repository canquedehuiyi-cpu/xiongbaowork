# 期八：外部编码员工走熊宝的模型代理

日期：2026-11-19 · 状态：**已实现（本期范围），后续分期见 §8**
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

### 8.2 云电脑里跑这两个员工

目标：Codex 和 Claude Code 默认在员工自己的熊宝云电脑里跑，不需要配对电脑，关掉网页照样跑。

- `agent-computer` 镜像预装两个 ACP 适配器（按 `ACP_MANIFEST` 里钉死的版本）；Codex 的 CLI 随 codex-acp 一起装，Claude Code 的 CLI 随它的 SDK 一起装。
- 在云电脑里起 ACP 宿主，复用 `runner/src/acp/` 的宿主、客户端和启动清单（见下面「能否复用」）；模型走本期的代理，令牌随 `acp.open` 注入。
- 云电脑的出站策略放行熊宝代理地址和 npm 源（预装则只需前者）。
- 服务器侧新增一条「到云电脑」的 `acp.*` 通道。

**runner 的 ACP 宿主能不能在 agent-computer 容器里复用**：宿主本身能复用，差三处，外加一个要先验证的风险。

1. 宿主、客户端、启动清单（`host.ts`、`client.ts`、`manifest.ts`、`paths.ts`、`login-path.ts`）都是纯 Bun / Node 代码，依赖全部可注入（`roots`、`apps`、`adapterDir`、`processEnv`、`spawn`、`tempRoot`），`shared/acp.ts` 只被类型引用。容器里是 Ubuntu 24.04、自带 node 24 和 bun，`npx` 可用。
2. 差一（打包）：`host.ts` 为了一个常量 `IDLE_MS` 引了 `runner/src/app-host.ts`，后者又引整个 MCP 客户端。镜像里不该带这一串，8.2 要把常量挪到不带依赖的文件里（一行改动）。镜像目前只拷了 `agent-computer/src` 和几个 `shared/` 文件，还要加上 `runner/src/acp/` 和 `shared/acp.ts`。
3. 差二（传输）：传输不同。runner 是设备**向外**拨熊宝的设备 socket，靠设备配对、`registeredDevices` 和令牌认身份；云电脑是服务器通过 supervisor 和 HTTP 去找它（4100 端口）。8.2 要么让容器里的宿主也当一台「设备」拨回来（需要给云电脑发设备身份），要么在 agent-computer 里加一个收 `acp.*` 帧的接口。后者更贴合现有的云电脑通道，也避开配对。
4. 差三（引用）：文件夹和智能体的引用。宿主靠 `fld_…`、`app_…` 查路径，这些来自桌面端共享的文件夹和用户登记的智能体；云电脑只有一个固定工作目录 `/workspace`，没有自定义智能体，`roots` 写死成这一个、`apps` 返回空即可。
5. 风险（需要在 8.2 先验证，我没有真跑）：Codex 自带的沙箱（Linux 上依赖 Landlock / seccomp）在非特权容器里可能起不来；`INITIAL_AGENT_MODE=read-only` 下的写入要靠熊宝自己的权限审批，不靠 Codex 沙箱。容器以 root 运行，Claude Code 在 root 下不允许跳过权限的模式，但本方案用的是「先问再做」的 `default` 模式，不受影响。

### 8.3 两个固定员工本身

- 租户包里预设 Codex 和 Claude Code 两个员工：用户选中就能直接用，不用招入、不用配置、不用填 key。它们的模型取自租户包里指定的平台模型池行（DeepSeek 等兼容模型），经本期的代理。
- 员工设置里的「云电脑 / 本机」切换：默认云电脑；用户配对了自己的电脑、且电脑在线时可以切到本机，直接改本地代码。切到本机时走本期做好的 runner 注入，切回云电脑时走 8.2。
- 招入外部员工的现有流程（`POST /api/agents/external`）保留，给用户自己招的外部员工用。
- 界面部分要截图给用户确认后再推。
