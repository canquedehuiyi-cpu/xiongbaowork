# 契约：模型配置的真实读法，与"这一轮为什么没答"

- 日期：2026-10-09　工作包：WP-1.3（审计 N3、方案 D-5 / WP-0.3）
- 归属：本文件由 A 线写。§1 是**事实**（已读码核对），§2 是 A 线正在实现的服务端形状，§3/§4 是**要 B/C 改的东西**，A 线不碰你们的路径。
- 为什么要有这份文档：审计第一次接真实模型时被 400 拒了，界面上只写着 "network error"。根因是三件事叠在一起，
  每一件单独看都不像 bug——所以把它们写在一处，免得下一个人重新踩。

## 1. 事实：这个部署读哪些环境变量（已全仓 grep 核对）

| 变量 | 读不读 | 说明 |
| --- | --- | --- |
| `BOT_MODEL` | **读** | `server/src/copilot.ts`，且**只在同时设了 `OPENAI_BASE_URL` 时生效** |
| `OPENAI_MODEL` | **不读** | 全仓没有任何代码读它。写进 `.env` 是无效配置 |
| `OPENAI_BASE_URL` | 读 | 自定义网关地址 |
| `OPENAI_API_KEY` | 读 | 凭据；为空时 `agent-bot` / `agent-langgraph` 容器直接退出并说"This Bot cannot answer without a model" |
| 品牌包 `examples/qoderwake/model.yaml` 的 `default_model` | 读 | 现在**写死**了一个 OpenAI 的模型名，见 §3 |

DeepSeek 在 2026-10-09 实测回的句子是"支持的模型名是 …，但你传的是 gpt-5.6-terra"，也就是说：换任何非 OpenAI 厂商，
**第一轮必然失败**，而失败的原因被界面吞掉。

## 2. A 线正在实现的服务端部分（C/B 可以按这个来）

1. `GET /api/capabilities` 多一个布尔字段：

   ```json
   { "mode": "local", "durableHistory": true, "modelConfigured": false }
   ```

   `modelConfigured` 的判据＝"这个部署现在能不能真的发一次模型请求"：有可用凭据（`OPENAI_API_KEY`，或模型库里
   该员工绑定了凭据）**且**有一个明确的模型名（`BOT_MODEL` 或品牌包 `default_model`）。任一缺失就是 `false`。
   它是**给界面看的一条引导开关**，不参与任何授权判断，也不会让请求变成 401/403。

2. 供应商的非 401 拒绝（400 / 402 / 403 / 404 / 429 / 5xx）已经在流上转成中文 `RUN_ERROR`，带 HTTP 码与
   **供应商原话**（截断 300 码点、抹掉 `sk-…`/`Bearer …`），流正常结束，卡片记 `failed`。
   转写里现在能看见真因，不再是 "network error"。401 保持原路径（桌面宿主据此打开凭据页）。

3. `server/src/config.ts` 启动时若发现设了 `OPENAI_MODEL` 而没设 `BOT_MODEL`，打一条 `console.warn`
   说明"本部署读取 `BOT_MODEL`，`OPENAI_MODEL` 不生效"。

## 3. 请 B 线做的两件事（交付形态）

1. **`examples/qoderwake/model.yaml` 的 `default_model` 改成占位**，不再预设具体厂商（方案 D-5）。
   按 D-5 的原话："不预设具体厂商：`model.yaml` 保留占位，首次启动若未配置模型则在界面引导'接入模型'"。
   写死厂商名是 §1 那条必然失败的源头；占位之后，`modelConfigured=false` 才有意义。
2. **`openbot/.env.example` 删掉一切 `OPENAI_MODEL` 字样**，并在 `OPENAI_BASE_URL` 旁边写明"模型名用 `BOT_MODEL`"，
   给 DeepSeek / 通义 / 智谱各一行示例（例如 DeepSeek 2026-10-09 实测可用的名字是 `deepseek-flash`、`deepseek-v4-pro`，
   `deepseek-chat` 不在其支持列表里）。
   另外 `docs/deployment-qoderwake.md` 与根 README 需要把"Windows 宿主不能直接起 server"之外的这条也写清：
   **`OPENAI_MODEL` 是无效配置**，这是用户第一次接自己模型时最容易踩的空坑。

## 4. 请 C 线做的一件事（界面引导）

读 §2 的 `modelConfigured`：为 `false` 时，首页与对话框顶部出一条引导"先接入一个模型"，链到 `/resources` 的模型区
（模型库 BYOK 已存在，spec H1）。同时确认供应商那句中文 `RUN_ERROR` 在转写里**显示出来**而不是被替换成
"network error"——事件字段是 `{type:"RUN_ERROR", message, code:"OPENBOT_PROVIDER_REQUEST_REFUSED"}`，
`message` 已经是给人看的中文，界面**原样渲染即可，不要再自己编一句**。

## 5. 冒烟：手工那遍已经跑过，脚本那遍还没落

2026-10-09 用户授权后手工跑过一遍（命令与 SSE 事件计数在
`.scratch/qoderwake-replica/acceptance-v0.1/wp13-smoke-2026-10-09.md`）：真实 DeepSeek 回了一句话、
看板恰好一张卡、卡的 `open` 落进那段对话。**没跑成自动化的是因为它不在 A 线路径里**——
现有 `bun run test:smoke` 跑的是 `openbot/tests/smoke`（上游 `journey.test.ts` 在那儿，默认员工是 fintech 的
`risk-analyst`，不动它），而 A 线只有 `openbot/server/**` 与 `openbot/server/docs/contracts`。

要谁认领都行，形状就是上面那三条断言：
- 落到 `openbot/server/tests/smoke/qoderwake-chat.test.ts`（`OPENBOT_SMOKE=1` 才跑，默认跳过）→ 需要同时给
  `openbot/package.json` 加一条 `test:smoke:qoderwake`（B 名下）；
- 或直接放 `openbot/tests/smoke/` 复用现有脚本（该目录归属见分工表）。
凭据：只用 `.env` 里那把 key，且**每次跑之前问用户**（会产生真实外部调用）。
