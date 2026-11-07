# 设备端本机 MCP 桥接（数字员工操控本机应用 · 子项目一）

日期：2026-11-07
状态：待用户审阅
上游：数字员工操控电脑上其它应用。用户已定的方向：
- 目标覆盖「任意应用」；
- 路线分两部分：本机 MCP 桥接（本文，先做）和桌面操控（UI Automation，后做，另写设计）；
- 放权方式为按会话授权。

## 1. 目标与范围

**目标**：很多软件自带 MCP 服务器，可能是本机命令启动（stdio），也可能是 `localhost` 地址上的 HTTP 服务。员工应当能通过这台软件所在电脑上的设备端，调用这些 MCP 工具，从而稳定、精确地操作这些软件。

**成功标准**：
1. 用户在设备端窗口添加一个本机 MCP（启动命令或本机地址），点「测试连接」能列出工具。
2. 用户的分身在对话里能用 `computer_apps` 列出这个应用和它的工具，再用 `computer_app_call` 调用其中一个工具，结果回到对话。
3. 工具声明了只读（`readOnlyHint: true` 且不是破坏性）时直接执行。其它工具要先弹审批，批准后只执行一次。
4. 设备离线时调用会排队，回线后执行，结果回到对话。这条复用 #292 的机制。
5. 服务器从头到尾不知道启动命令、参数、环境变量和本机地址，只知道用户起的名称和一个随机编号。

**不做的**：
- 桌面 UI 操控（子项目二）；
- macOS 和 Linux 上的设备端界面入口：runner 的命令行在三个平台上都能用，界面先只验证 Windows；
- 把每个本机工具直接列进员工工具列表的「一等工具」形态；
- MCP 的 resources、prompts、sampling、tools 以外的 notifications；
- 把 MCP 返回的图片交给看图模型（第一期只用文字说明代替）。

## 2. 方案选择

本机工具放在设备工具这一侧（两个通用工具），**不**接入现有的「连接器 / MCP 插件」体系。理由有两点：
- 插件体系按「团队共用、服务器直连」设计，工具列表缓存在服务器上；
- 设备这一侧已经有这些机制：只发往员工主人自己的电脑、离线排队、结果回到对话、审批后只执行一次、结果不明时暂停核查。G5 真机测试已经验证过它们。

代价是员工每次要先列工具再调用。

## 3. 组成部分

### 3.1 设备端：本机应用登记（runner）

新文件 `runner/src/apps.ts`，写法照 `roots.ts`：
- 登记文件是 `<dataDir>/runner-apps.json`，和 `runner-roots.json` 放在一起，权限也一样，只有本人可读。
- 每一项的字段：
  - `ref`：`app_` 加随机串；
  - `name`：用户起的名字，1–40 个字符，不能重名；
  - `kind`：`stdio` 或 `http`；
  - stdio 专有：`command`、`args[]`、`env{}`、`cwd?`；
  - http 专有：`url`，只接受 `http://127.0.0.1`、`http://localhost`、`http://[::1]`，可以带端口和路径，`https` 同样限于这三个主机；
  - `enabled`：默认为 true。
- `reported()` 只返回 `[{ref, name}]`，随心跳上报。
- 登记数量上限 20 个。
- 新增四个命令行参数，供设备端外壳调用，每次只输出一行 JSON：
  - `--list-apps`
  - `--add-app <json>`
  - `--remove-app <name>`
  - `--test-app <name>`：启动或连接后执行 `tools/list`，返回工具名和工具个数，然后关闭。

### 3.2 设备端：精简 MCP 客户端（runner）

新文件 `runner/src/mcp-client.ts`。**不新增依赖、不改 lockfile**：服务器的 MCP SDK 只装在 `server/node_modules`，runner 用不到。

**协议**：JSON-RPC 2.0，只实现以下几个调用：
- `initialize`，协议版本发 `2025-06-18`，对方返回什么版本都接受；
- `notifications/initialized`；
- `tools/list`，支持 `cursor` 翻页，最多翻 10 页；
- `tools/call`；
- `notifications/cancelled`，在用户点停止时发送。

**stdio 方式**：
- 启动子进程时设 `windowsHide`，标准输入输出都用 UTF-8，按行分隔 JSON。
- stderr 只保留最后 4 KB，用于报错。
- 子进程的环境变量 = 当前用户的环境变量，去掉 `XIONGBAO_*` 和 runner 自己的变量，再叠加登记里的 `env`。

**HTTP 方式**（Streamable HTTP）：
- 用 POST 发 JSON-RPC，带上 `Accept: application/json, text/event-stream`。
- 返回 JSON 或 SSE 都能解析，SSE 只取与请求 id 对应的那条结果。
- 收到 `Mcp-Session-Id` 后，之后的请求都带上它。

**生命周期**：
- 第一次用到才启动，闲置 10 分钟自动关闭，runner 退出时全部关闭（Windows 上结束整棵进程树）。
- 同一个应用的调用排队串行执行。

**超时**：初始化 20 秒，`tools/list` 20 秒，`tools/call` 120 秒。

**结果整理**：
- `text` 内容原样保留；
- `image`、`audio` 换成「[图片 12 KB，已省略]」这样的文字说明；
- `resource` 只保留 uri 和文字部分；
- 总长度截断到 1 MB，截断时标记 `truncated`；
- 透传 `isError` 和 `structuredContent`，后者同样受 1 MB 上限约束。

### 3.3 设备端：新动作（runner `execute.ts`）

- `apps.tools {app}`：返回该应用的 `tools`，每个工具带 `name`、`description`、`inputSchema`、`annotations`，`description` 截断到 1 KB。
- `apps.call {app, tool, args}`：返回整理后的结果。
- `app` 指的是 `ref`，由服务器从名称换算得到。名称不存在或应用已停用时，返回中文错误。
- 这两个动作照 `exec` 的方式接入取消、日志和「结果不明」处理。`apps.tools` 是只读动作，重放安全；`apps.call` 视为写入动作。

### 3.4 服务器

**心跳**：设备记录新增 `apps` 字段，形如 `[{ref, name}]`，和 `roots` 一样读写，这一项需要新增一个迁移。

**两个新工具**，写在 `computer/headless-tools.ts`，只在 `machine: "device"` 时提供：
- `computer_apps({ app? })`：
  - 不带参数：列出主人电脑上的应用名称，对每个应用发一次 `apps.tools`，汇总返回各应用的工具；
  - 带 `app`：只返回这一个应用的工具。
  - 单个应用失败时，在它那一栏写错误信息，不影响其它应用。
- `computer_app_call({ app, tool, args })`：按名称换算出 `ref`，经设备网关发送 `apps.call`。

**审批输入**：
- 网关在决定是否审批前，先取这个工具的 annotations。来源是本次请求里**设备端刚返回的**工具列表，按设备和应用在内存里缓存 5 分钟，**绝不读模型提供的参数**。
- 设备离线或取不到列表时，按「未声明」处理，也就是要审批。

**工具说明**：写明「软件有本机 MCP 就优先用它；先用 `computer_apps` 看有哪些工具，再调用」，并说明这是主人自己电脑上的软件。

### 3.5 设备端窗口（Tauri）

- `desktop-device/ui` 新增「本机应用（MCP）」区块，放在「本地文件夹」下面：显示列表，可以添加、删除、测试连接、启用或停用。
- 添加表单有两种：
  - 启动命令：命令、参数（一行一个）、环境变量（一行一个 `KEY=VALUE`，显示时打码）、工作目录（可选）；
  - 本机地址：URL。
- `src-tauri/src/apps.rs` 照 `roots.rs` 的方式调用 sidecar 的四个命令行参数。
- 说明文字：「这里填的命令和密钥只保存在这台电脑上；服务器只知道名称。」

### 3.6 网页

「设置 › 我的设备」里，每台设备显示「本机应用：Excel、Blender」，只显示名称。不改其它页面。

## 4. 权限与审批

1. **谁能用**：和 `computer_*` 一样，只能发往员工主人自己的设备，沿用 `devices/selection.ts`、`bot-owner.ts`。目录员工没有主人，所以用不了。
2. **员工级开关**（SEC1 方案 B）：两个新工具出现在装配页的工具权限里，用户可以设为「从不」来停用。
3. **团队级上限**：「电脑上运行命令」这项团队上限（D5）同样作用于 `computer_app_call`。设为 `never` 时拒绝，设为 `ask` 时一律审批。理由：调用本机 MCP 等同于在这台电脑上执行程序。
4. **安全底线**（新增，`approvals/policy.ts`）：`computer_app_call` 只有在工具同时满足「`readOnlyHint === true`」和「`destructiveHint !== true`」时才不审批，其余全部至少审批。annotations 只采信 3.4 节规定的设备端列表。
5. **审批卡片**：显示应用名、工具名和参数（JSON，截断到 2 KB），以及工具的说明。
6. **只执行一次 / 结果不明**：完全沿用 #282 的服务器结算机制和设备队列的「核查并恢复」流程。

## 5. 出错处理

| 情况 | 返回给员工（中文） |
| --- | --- |
| 没有配对设备或设备离线 | 沿用现有的离线排队和提示 |
| 应用名不存在或已停用 | 「这台电脑上没有名为 X 的本机应用（已有：…）」 |
| stdio 启动失败、提前退出 | 「X 启动失败」，附 stderr 的最后部分 |
| HTTP 连接失败 | 「连不上 X 的本机地址，请确认软件已打开」 |
| 超时 | 「X 在 120 秒内没有返回」，`tools/call` 超时按结果不明处理 |
| MCP 返回 `isError` | 原样转达错误内容，不算设备故障 |
| 工具名不存在 | 「X 没有名为 Y 的工具」，并附上工具名列表 |

## 6. 测试与验收

**单元测试和集成测试**：
- **runner**：
  - 用一个假的 stdio MCP 服务器（`runner/tests/fixtures/fake-mcp.ts`）测试 initialize、list（含翻页）、call、isError、超时、取消、闲置关闭、进程树清理、stderr 截断；
  - 用一个假的本机 HTTP MCP 服务器测试 JSON 和 SSE 两种响应以及 session 头；
  - 登记部分：增删、重名、主机白名单、数量上限、`reported()` 不泄露命令；
  - 心跳帧里带上 apps。
- **服务器**：
  - 两个新工具只在设备模式下出现；
  - 名称换算正确；
  - 审批覆盖四种情况：只读不问、未声明问、破坏性问、离线问；
  - 团队上限 never 和 ask 两档；
  - 只会发往主人自己的设备；
  - 离线时排队，结果回到对话。
  - 最后一项按 `device-safety.integration.test.ts` 的写法，接真实 runner socket 和假 MCP 端到端跑通。
- **Windows CI**：WIN1 探针里加一项，在 Windows 上通过 runner 执行器启动假 stdio MCP，然后完成 list 和 call。
- **设备端外壳**：`apps.rs` 的参数拼装测试，照 `roots.rs` 现有测试的写法。

**真机验收**（用户的 Windows 设备）：
1. 更新设备端后，在「本机应用（MCP）」里添加：
   - 名称：`文件助手`
   - 命令：`bunx`
   - 参数：`@modelcontextprotocol/server-filesystem`、`C:\xiongbao-test2`
   - 用户电脑上已有 bun，否则改用 `npx`。
2. 点「测试连接」，应列出 `read_text_file` 等工具。
3. 在分身对话里依次请求：
   - 「列出本机应用和工具」；
   - 「用文件助手读 C:\xiongbao-test2\.env」：只读工具，按设计不审批；sensitive-path 底线不适用于 MCP 参数，见下文风险一节；
   - 「用文件助手在 C:\xiongbao-test2 新建 note.txt 写入 hello」：要审批，批准后文件出现。
4. 关闭设备端，重复写入请求，确认它排队；重开设备端后，结果回到对话。

## 7. 风险与取舍

- **敏感路径底线管不到 MCP 参数**。SEC1 的 `.env*` 等规则只看命令文字和文件工具的路径。为了不误伤，第一期**不**去猜 MCP 参数里哪个字段是路径。只读的 MCP 工具因此可以读到敏感文件，前提是用户自己把它登记了，并把目录交给了它。界面说明里要写明「添加 MCP 等于把它能访问的内容交给你的员工」。如果用户要求更严，可以改成「本机 MCP 的所有调用都审批」，这只需要动一行判断。
- **工具自我声明不可全信**。`readOnlyHint` 由第三方软件自己声明，如果写错，可能导致免审批的写操作。缓解措施有三条：
  - 声明只能放宽到「只读」这一种情况，任何其它组合都要审批；
  - 员工级开关可以整体停用这两个工具；
  - 团队上限可以设为 `ask`，强制每次审批。
- **密钥以明文保存在本机文件里**。这与 `runner-roots.json` 和设备 token 的处理方式相同，只有本人可读。改用系统钥匙串放到以后。

## 8. 交付拆分（≤ 8 文件 / PR）

1. **PR-1 runner 核心**：`apps.ts`、`mcp-client.ts`、假 MCP 夹具，加上单元测试。
2. **PR-2 runner 接线**：`execute.ts` 的两个动作、命令行参数、心跳，加上测试和 WIN1 探针。
3. **PR-3 服务器**：设备记录迁移和心跳读写，`headless-tools.ts` 的两个新工具，网关取 annotations 和缓存，`policy.ts` 的新底线，加上测试。
4. **PR-4 界面**：Tauri 的 `apps.rs` 和 UI 区块，「我的设备」显示应用名，加上测试和文档。
5. **合入 main 后**：推 `device-v0.2.2-rc.1` 和服务器 `v0.2.2`（含 #298），在真机上按第 6 节验收，结果记进 `HUMAN-STEPS.md`。
