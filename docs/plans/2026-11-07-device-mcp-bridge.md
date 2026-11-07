# 设备端本机 MCP 桥接 实施计划

> **给执行代理：** 必须配合以下子技能之一使用：superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。按任务逐个实施，步骤用复选框（`- [ ]`）跟踪。

**目标**：员工通过主人电脑上的设备端，列出并调用这台电脑上软件提供的 MCP 工具（stdio 或本机 HTTP）。

**架构**：
- runner 侧：在本机登记应用，用零依赖的精简 MCP 客户端连接这些应用，并负责懒启动和闲置回收。新增两个设备动作 `apps.tools` 和 `apps.call`，应用列表随心跳上报。
- 服务器侧：设备记录新增 `apps` 列，新增 `computer_apps` 和 `computer_app_call` 两个工具，走现有的设备网关。审批由一条新底线决定：只有设备端自己列出的、声明只读的工具才免审批。
- Tauri 窗口和网页：增加登记和展示。

**技术栈**：Bun + TypeScript（runner 和 server）、Drizzle 与 SQL 迁移、Hono、Tauri（Rust）加原生 JS 界面、React（app）。

**设计文档**：`docs/specs/2026-11-07-device-mcp-bridge.md`

## 全局约束

- runner **不新增任何依赖**，不运行 `bun install`，不改 `bun.lock`。MCP 客户端自己实现。
- 本机 HTTP 地址只接受这三个主机：`127.0.0.1`、`localhost`、`[::1]`，协议为 http 或 https。
- 应用名长度 1–40 个字符，不能重名，最多登记 20 个应用。引用格式为 `app_` 加 22 位 base64url 字符。
- 超时：初始化 20 000 ms，`tools/list` 20 000 ms，`tools/call` 120 000 ms。闲置 600 000 ms 后关闭。
- 结果上限 1 MB，`description` 上限 1 KB，stderr 只保留最后 4 KB，`tools/list` 最多翻 10 页。审批卡片里的参数截断到 2 KB。
- 协议版本发送 `2025-06-18`。
- 服务器从不接收命令、参数、环境变量和 URL，只接收 `{ref, name}`。
- annotations 缓存按「设备 + 应用」区分，有效期 300 000 ms。
- 免审批的条件只有一个：`readOnlyHint === true && destructiveHint !== true`。
- 团队「电脑上运行命令」上限（D5）同样作用于 `computer_app_call`。
- 每个 PR 最多改 8 个文件。先合入集成分支 `claude/magical-archimedes-8a6ljj`。
- 面向用户的错误文案一律用中文，用词照设计文档 §5。

## 审查重点

1. **stdio 服务器把日志写到 stdout**，比如在 JSON 之前打印横幅。不是 JSON 的行应当丢弃，不能让解析器崩溃（Task 2 有测试覆盖）。
2. **Windows 上的启动命令是 `npx` 或 `bunx`**，它们其实是 `.cmd` 文件。直接 spawn 会报 ENOENT，需要经 `cmd.exe /d /s /c` 启动（Task 2 有测试，WIN1 探针在 Task 4 覆盖）。
3. **调用进行中设备掉线或 runner 退出**：子进程要整棵结束，`apps.call` 按「结果不明」处理（Task 3、Task 6 有测试覆盖）。
4. **同一个应用被并发调用**：必须串行，响应不能串号，也就是请求 id 要和响应对应（Task 3 有测试覆盖）。
5. **模型在参数里伪造 annotations，或者给出一个不存在的工具名**：审批只看设备端列表。工具名不在列表里时直接拒绝，不发给设备（Task 6 有测试覆盖）。

---

### Task 1：本机应用登记（runner/src/apps.ts）

**文件：**
- 新建：`openbot/runner/src/apps.ts`
- 测试：`openbot/runner/tests/apps.test.ts`

**接口：**
- 产出：
  ```ts
  export type AppEntry =
    | { ref: string; name: string; kind: "stdio"; command: string; args: string[]; env: Record<string,string>; cwd?: string; enabled: boolean }
    | { ref: string; name: string; kind: "http"; url: string; enabled: boolean };
  export type AppInput = Omit<AppEntry, "ref" | "enabled"> & { enabled?: boolean };
  export const APP_REF: RegExp; // /^app_[A-Za-z0-9_-]{22}$/
  export function createAppRegistry(opts: { dataDir: string }): {
    list(): AppEntry[];                         // 含命令，仅本机打印用
    reported(): { ref: string; name: string }[]; // 只含 enabled 的项
    add(input: AppInput): AppEntry;             // 校验失败抛中文 Error
    remove(target: string): boolean;            // 按 ref 或 name
    setEnabled(target: string, enabled: boolean): AppEntry;
    byRef(ref: string): AppEntry | undefined;
    byName(name: string): AppEntry | undefined;
  };
  ```
- 文件为 `<dataDir>/runner-apps.json`，写入方式和权限照 `roots.ts`：先写临时文件再 rename，chmod 0o600。

- [ ] **Step 1：写失败测试** `apps.test.ts`，包含以下用例：
  - `adds a stdio app and reports only ref and name`：断言 `reported()` 的结果中没有 `command`、`env`、`url` 这几个键，`ref` 匹配 `APP_REF`。
  - `refuses a duplicate name, an empty or 41-char name, and a 21st app`：断言错误信息分别包含「重名」「1–40」「20」。
  - `accepts only loopback http urls`：`http://127.0.0.1:3845/mcp`、`http://localhost/mcp`、`http://[::1]:9/x` 通过；`http://192.168.1.2/mcp`、`http://example.com`、`ftp://localhost` 抛错，错误信息包含「只能填本机地址」。
  - `remove by name or ref; disabled apps are not reported`
  - `persists across registry instances`

- [ ] **Step 2：运行**：`cd openbot/runner && bun test tests/apps.test.ts`，预期失败（模块不存在）。
- [ ] **Step 3：实现 `apps.ts`**，按上面的接口写。
- [ ] **Step 4：运行**：同一命令，预期全部通过。
- [ ] **Step 5：提交**，提交信息为 `runner：本机应用（MCP）登记`。

### Task 2：精简 MCP 客户端（runner/src/mcp-client.ts）

**文件：**
- 新建：`openbot/runner/src/mcp-client.ts`
- 新建：`openbot/runner/tests/fixtures/fake-mcp-stdio.ts`
- 新建：`openbot/runner/tests/fixtures/fake-mcp-http.ts`
- 测试：`openbot/runner/tests/mcp-client.test.ts`

**接口：**
- 读入：Task 1 的 `AppEntry`。
- 产出：
  ```ts
  export type McpTool = { name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown } };
  export type McpCallOutcome = { content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError: boolean; truncated: boolean };
  export interface McpConnection {
    listTools(signal?: AbortSignal): Promise<McpTool[]>;
    callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallOutcome>;
    close(): Promise<void>;
    readonly closed: boolean;
  }
  export function connectApp(entry: AppEntry, opts?: { timeouts?: { initMs?: number; listMs?: number; callMs?: number } }): Promise<McpConnection>;
  export class McpAppError extends Error { kind: "start" | "connect" | "timeout" | "protocol" | "unknown_tool"; stderrTail?: string }
  ```
- 假服务器：
  - `fake-mcp-stdio.ts` 由 `bun` 运行，读环境变量 `FAKE_MCP_MODE`，取值为 `ok`、`banner`、`slow`、`exit`、`paged`。
  - 它提供 3 个工具：
    - `echo`，带 `readOnlyHint: true`；
    - `write_note`，没有 annotations；
    - `wipe`，带 `destructiveHint: true`。
  - `fake-mcp-http.ts` 导出 `startFakeHttpMcp({sse:boolean}) => {url, stop}`，返回 `Mcp-Session-Id` 头，并检查后续请求都带上了它。

- [ ] **Step 1：写失败测试** `mcp-client.test.ts`，包含以下用例：
  - `stdio: initialize, list three tools with annotations, call echo returns its text`
  - `stdio: non-JSON lines on stdout before and between messages are ignored`（banner 模式）
  - `stdio: paged tools/list follows nextCursor and stops after 10 pages`
  - `stdio: a server that exits early rejects with kind "start" and the last ≤4096 bytes of stderr`
  - `stdio: callTool past callMs rejects with kind "timeout"; abort sends notifications/cancelled and rejects`
  - `stdio: image and resource content become text placeholders; a 2 MB text result is cut to 1 MB with truncated: true`
  - `stdio: env from the entry reaches the child; XIONGBAO_* from the parent does not`
  - `http: json and sse responses both parse; the session id is echoed on later requests`
  - `http: connection refused rejects with kind "connect"`
  - `windows command shim: on win32 a bare command such as npx or bunx is launched as cmd.exe /d /s /c "npx ..."`：
    - 把平台判断和命令解析写成纯函数 `launchSpec(entry, platform, env)`，单独测试；
    - 再断言一点：在非 win32 平台上，原命令原样执行。
- [ ] **Step 2：运行**：`cd openbot/runner && bun test tests/mcp-client.test.ts`，预期失败。
- [ ] **Step 3：实现。**
  - **stdio**：按 `\n` 分行，`JSON.parse` 失败的行直接丢弃；用 `Map<id, resolver>` 把请求和响应对应起来。spawn 时设 `windowsHide`、`stdio: pipe`，并且 `detached: process.platform !== "win32"`。
  - **close()**：在 Windows 上用 `taskkill /pid N /T /F` 结束进程，在其它平台上 kill 整个进程组。参照 `agent-computer/src/shell.ts` 里的 stop 写法。
  - **HTTP**：用 `fetch` 发 POST。若 content-type 是 `text/event-stream`，按 `data:` 行解析，直到收到与请求 id 对应的那条。
- [ ] **Step 4：运行**：同一命令，预期全部通过。
- [ ] **Step 5：提交**，提交信息为 `runner：零依赖 MCP 客户端（stdio 与本机 HTTP）`。

### Task 3：应用托管（runner/src/app-host.ts）

**文件：**
- 新建：`openbot/runner/src/app-host.ts`
- 测试：`openbot/runner/tests/app-host.test.ts`

**接口：**
- 读入：`createAppRegistry`（Task 1）、`connectApp`、`McpAppError`（Task 2）。
- 产出：
  ```ts
  export function createAppHost(registry: ReturnType<typeof createAppRegistry>, opts?: { idleMs?: number; connect?: typeof connectApp }): {
    tools(ref: string, signal?: AbortSignal): Promise<McpTool[]>;   // description 截到 1024
    call(ref: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallOutcome>;
    closeAll(): Promise<void>;
  };
  ```
- 错误文案（中文，照设计文档 §5）：
  - `这台电脑上没有这个本机应用，或它已停用。`
  - `「X」启动失败：<stderrTail>`
  - `连不上「X」的本机地址，请确认软件已打开。`
  - `「X」在 120 秒内没有返回。`
  - `「X」没有名为「Y」的工具（已有：a、b）。`

- [ ] **Step 1：写失败测试**，使用注入的假 `connect`，包含以下用例：
  - `lazy: nothing is started until the first tools() call`
  - `reuses one connection; closes it after idleMs of no use and reconnects next time`
  - `serialises calls per app: two concurrent calls never overlap`（用计数器断言最大并发数为 1）
  - `unknown tool name is refused before callTool reaches the connection`
  - `a dead connection (closed) is replaced on the next call`
  - `closeAll closes every open connection`
- [ ] **Step 2：运行**：`bun test tests/app-host.test.ts`，预期失败。
- [ ] **Step 3：实现。** 每个 ref 维护一个 Promise 链，用来串行。`call` 之前先按缓存的工具列表校验工具名；如果还没有工具列表，就先执行一次 `tools()`。
- [ ] **Step 4：运行**，预期通过。然后运行 `bun test` 跑完 runner 全部测试，同样应当通过。
- [ ] **Step 5：提交并开 PR-1**（包含 Task 1–3，共 8 个文件），PR 标题为 `runner：本机应用登记、MCP 客户端与托管`。

### Task 4：runner 接线（动作、命令行、心跳、WIN1）

**文件：**
- 修改：`openbot/runner/src/execute.ts`
  - `createRunnerExecutor` 新增可选参数 `apps?: ReturnType<typeof createAppHost>`；
  - `switch` 中新增 `case "apps.tools"` 和 `case "apps.call"`；
  - `closeBrowser` 旁边新增 `closeApps`。
- 修改：`openbot/runner/src/index.ts`
  - 新增参数 `--list-apps`、`--add-app <json>`、`--remove-app <name|ref>`、`--test-app <name|ref>`、`--enable-app <name>`、`--disable-app <name>`，写法照 `parseRootCommand` 和 `runRootCommand`；
  - `heartbeatFrame(roots, apps)` 改为输出 `{type:"heartbeat", roots, apps}`；
  - `main` 里创建 registry 和 host，退出时调用 `closeAll()`。
- 修改：`openbot/scripts/ci/windows-runner-probe.ts`：在 Windows 上登记假的 stdio MCP（`bun <fixture>`），然后执行 `apps.tools` 和 `apps.call echo`。
- 测试：`openbot/runner/tests/apps-cli.test.ts`（新建），`openbot/server/tests/runner-dispatch.test.ts`（这个文件已经在测 executor 时，在这里补用例）。

**接口：**
- 动作载荷：
  - `apps.tools {app: ref}` → `{ ok: true, output: { tools: McpTool[] } }`
  - `apps.call {app: ref, tool: string, args: object}` → `{ ok: true, output: McpCallOutcome }`
  - 出错时返回 `{ ok:false, error }`。`apps.call` 在调用中途被取消或连接断开时，返回 `{ ok:false, error, outcomeUnknown:true }`。
- 命令行输出一行 JSON：
  - `--test-app` 输出 `{ok:true, tools:[name...], count}`；
  - 其它参数输出 `{ok:true, apps: AppEntry[]}`，但 `env` 的值要打码成 `"••••"`。

- [ ] **Step 1：写失败测试。**
  - `heartbeat carries apps as ref and name only`
  - `--add-app then --list-apps masks env values`
  - `--test-app lists the fake server's tools`
  - `apps.tools and apps.call reach the fake server through the executor`
  - `apps.call with an unknown ref answers the 中文 error`
  - `apps.call aborted mid-call answers outcomeUnknown`
- [ ] **Step 2：运行** `cd openbot/runner && bun test`，并在本地 PG 环境运行 `cd openbot/server && bun test tests/runner-dispatch.test.ts`。预期新用例失败。
- [ ] **Step 3：实现上述接线。**
- [ ] **Step 4：运行** 同样两组命令，预期全部通过。另外运行 `bunx biome lint --error-on-warnings`，预期没有问题。
- [ ] **Step 5：提交并开 PR-2**，PR 标题为 `runner：本机应用动作、命令行与心跳；WIN1 探针`。CI 中 `WIN1 device CLI probe` 必须通过。

### Task 5：服务器保存设备上报的应用

**文件：**
- 新建：`openbot/server/recovery/recovery-20261018-v1/sql/0143_device_apps.sql`，内容照 `0132_device_roots.sql`：新增 `apps jsonb DEFAULT '[]' NOT NULL` 和一个检查约束（必须是数组，且长度 ≤ 50）。同时在 `meta/_journal.json` 里登记这个迁移。
- 修改：`openbot/server/src/db/schema/devices.ts`：新增 `apps` 列，类型为 `DeviceApp[] = {ref,name}`。
- 修改：`openbot/server/src/devices/store.ts`：新增 `reportedApps(value)`，最多保留 20 项，`ref` 必须匹配 `^app_[A-Za-z0-9_-]{22}$`，名称长度 ≤ 40，去重。`heartbeat()` 改为同时写 `apps`，读设备时返回 `apps`。
- 修改：`openbot/server/src/devices/socket.ts`：把 `reportedApps(frame.apps)` 传给 `store.heartbeat`。
- 测试：补到现有的设备 store 或 socket 集成测试里，即 `openbot/server/tests/device-*.integration.test.ts` 中测试 roots 的那一个。

**接口：**
- 产出：`DeviceStore` 读到的设备对象新增 `apps: {ref:string; name:string}[]`；`store.heartbeat(tenantId, deviceId, roots, apps)`。

- [ ] **Step 1：写失败测试。**
  - `a heartbeat's apps are stored and listed for the owner`
  - `malformed apps (bad ref, 41-char name, 21st entry, duplicate) are dropped`
  - `an older runner without apps keeps []`
- [ ] **Step 2：运行**：在本地 PG 环境用 `main-run-tests.sh` 运行这个测试文件，预期失败。
- [ ] **Step 3：实现**，并跑迁移脚本，确认新库能迁移成功。
- [ ] **Step 4：运行**，预期通过。
- [ ] **Step 5：提交并开 PR-3**，PR 标题为 `服务器：保存设备上报的本机应用`。

### Task 6：两个工具、网关与审批底线

**文件：**
- 修改：`openbot/server/src/computer/headless-tools.ts`：在 `onDevice` 为真时，新增 `computer_apps({app?})` 和 `computer_app_call({app, tool, args})`，工具说明照设计文档 §3.4。
- 修改：`openbot/server/src/computer/gateway.ts`：
  - 新增 `listApps(botId, actor, input, signal)` 和 `callApp(botId, actor, input, signal)`；
  - `intentOf` 中，`computer_apps` 返回 `"read"`，`computer_app_call` 返回 `"app_call"`；
  - annotations 缓存为 `Map<"tenant/device/ref", {tools, at}>`，有效期 300 000 ms；
  - `callApp` 先取工具列表。工具名不在列表里时，抛出中文的 `ActionRefusedError`。然后按列表判断 `readOnly`。
- 修改：`openbot/server/src/computer/runner-transport.ts`：`actionFor` 中，`apps/tools` 映射为 `apps.tools`，`apps/call` 映射为 `apps.call`。
- 修改：`openbot/server/src/approvals/policy.ts`：
  - candidate 的 `subject` 新增 `appTool?: { readOnly: boolean }`；
  - 新底线：`toolRef === "computer_app_call" && subject.appTool?.readOnly !== true` 时，至少审批，理由为「这个本机应用操作可能修改数据，需要你批准后再执行。」；
  - `runnerCommand` 的判断扩展到 `computer_app_call`，使 D5 的 never 和 ask 两档对它同样生效。
- 修改：`openbot/app/src/components/bot-profile/permissions.tsx`：新增两项，`{ref:"computer_apps", label:"查看本机应用"}` 和 `{ref:"computer_app_call", label:"使用本机应用"}`。
- 测试：
  - `openbot/server/tests/approvals-policy.test.ts`（或现有的 policy 测试文件）：四种组合，以及 D5 上限；
  - `openbot/server/tests/device-apps.integration.test.ts`（新建）：真实 runner socket 加假 stdio MCP，写法照 `device-safety.integration.test.ts`。

**接口：**
- 读入：Task 4 的动作载荷、Task 5 的 `device.apps`。
- `computer_apps` 返回：`{ apps: [{ name, tools?: McpTool[], error?: string }] }`
- `computer_app_call` 返回：`McpCallOutcome`，输出带上 `withUntrustedNotice`；或者在设备离线时返回 `{queued:true,key}`。

- [ ] **Step 1：写失败测试。**
  - policy：
    - `readOnly app tool runs without asking`
    - `unannotated and destructive app tools ask`
    - `annotations in the model's args are ignored`
    - `team cap never denies computer_app_call; ask asks`
  - 集成：
    - `computer_apps lists the owner's device apps and their tools`
    - `computer_app_call echo runs once without approval`
    - `computer_app_call write_note waits for approval, runs once after approve, never after reject`
    - `an unknown tool is refused without a frame being sent`
    - `a catalogue Bot (no owner) has no apps tools`
    - `offline device: call is queued and its result is posted to the conversation`
    - `a call cut off by a socket drop becomes outcome unknown and pauses the device`
- [ ] **Step 2：运行**：在本地 PG 环境运行上述测试文件，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**，预期通过。然后运行设备、runner、computer、approval 相关的全部测试，失败数不能多于 main 上的 4 项（那 4 项是本机 IPv6 和 playwright 环境问题）。再运行 `bunx biome lint`。
- [ ] **Step 5：提交并开 PR-4**，PR 标题为 `服务器：computer_apps / computer_app_call 与审批底线`。

### Task 7：设备端窗口与网页展示

**文件：**
- 新建：`openbot/desktop-device/src-tauri/src/apps.rs`：照 `roots.rs`，把 `AppCommand::{List, Add(json), Remove, Test, Enable, Disable}` 拼成 sidecar 参数，含参数拼装的单元测试。
- 修改：`openbot/desktop-device/src-tauri/src/main.rs`：注册 `list_apps`、`add_app`、`remove_app`、`test_app`、`set_app_enabled` 这几个命令。
- 新建：`openbot/desktop-device/ui/apps.js`：照 `folders.js` 写表单和列表的纯函数，例如 `parseArgsLines`、`parseEnvLines`、`maskEnv`、`validateUrl`。
- 修改：`openbot/desktop-device/ui/index.html` 和 `main.js`：新增「本机应用（MCP）」区块，文案照设计文档 §3.5。
- 测试：`openbot/desktop-device/tests/apps.test.ts`（新建，测 `apps.js` 的纯函数）。
- 修改：`openbot/app/src/components/settings/my-devices.tsx`：设备行显示「本机应用：A、B」，加上 `app/tests/my-devices.test.tsx` 中的用例。

- [ ] **Step 1：写失败测试。**
  - `apps.js`：
    - `parseEnvLines("A=1\nB = x=y") → {A:"1",B:"x=y"}`
    - `validateUrl` 的放行和拒绝情况与 Task 1 一致
    - `maskEnv` 返回 `"••••"`
  - Rust：
    - `add_app passes --add-app with the JSON and --data-dir`
  - 网页：
    - `a device with apps shows 本机应用：Excel、Blender`
- [ ] **Step 2：运行** `cd openbot/desktop-device && bun test`、`cd src-tauri && cargo test`（如果本地没有 Rust 工具链，就交给 CI 跑）、`cd openbot/app && bun test tests/my-devices.test.tsx`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**，预期通过。
- [ ] **Step 5：提交并开 PR-5**，PR 标题为 `设备端窗口：本机应用（MCP）；我的设备显示应用名`。如果文件数超过 8 个，就把网页改动拆成单独的 PR。

### Task 8：发版与真机验收

**文件：**
- 修改：`openbot/package.json`，版本改为 `0.2.2`。
- 修改：`openbot/CHANGELOG.md`，新增 `## 0.2.2`，内容包括本机 MCP 桥接、#298 的中文提示，以及设备端 0.2.1-rc.1 的中文输出修复。
- 修改：`openbot/README.md`、`openbot/delivery.env.example`、`openbot/docs/deployment-qoderwake.md` 中的默认版本号。README 是 CRLF 换行，要按字节替换，保持原来的换行格式。
- 修改：`docs/acceptance/HUMAN-STEPS.md`：新增「本机 MCP 真机验收」小节，步骤照设计文档 §6。

- [ ] **Step 1**：集成分支合入 main，CI 全部通过。
- [ ] **Step 2**：请用户推 `device-v0.2.2-rc.1` 和 `v0.2.2` 两个标签，等两条发布流水线都通过。
- [ ] **Step 3**：用户在京东云上升级服务器（用 NJU 镜像拉取，命令和 v0.2.1 那次相同，只改版本号），并覆盖安装设备端。
- [ ] **Step 4**：按设计文档 §6 在真机上逐项验收，把结果写进 `HUMAN-STEPS.md`，然后提交。
