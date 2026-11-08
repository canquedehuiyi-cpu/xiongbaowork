# 本机应用自动发现 实施计划

> **给执行代理：** 必须配合以下子技能之一使用：superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。按任务逐个实施，步骤用复选框（`- [ ]`）跟踪。

**目标**：员工在对话里列出主人 Windows 电脑上可用的本机应用（已启用 / 可启用 / 已安装无 MCP），用户在审批卡片上点一次「允许」就能启用其中一个，全程不填表单。

**架构**：
- runner 侧：新模块 `discover*.ts` 只读扫描三类来源（其他 AI 工具的 MCP 配置、内置清单、注册表里的已安装程序），产出只含名称、来源、类型、状态和不透明编号的候选。编号是 `cand_<签发秒>_<HMAC>`，用本机密钥签名，10 分钟内有效，跨进程可验证（设备端窗口的命令行调用也能用）。新增设备动作 `apps.discover`（第 1 期）和 `apps.enable`（第 2 期），都走 `durable:false` 直连通道，不排队、不产生「结果不明」。npm 类候选启用时改写成自带 Bun 运行时（runner 自身 + `BUN_BE_BUN=1`，不行就随包附带 bun）。
- 服务器侧：新模块 `computer/app-discovery.ts` 读取并收紧设备上报的发现结果；`computer_apps` 增加「可启用」「已安装」两组；新工具 `computer_app_enable` 一律审批，摘要只绑定候选编号和应用名，来源放在 `display`；启用成功后立即记入设备记录并预填工具列表缓存，员工紧接着就能 `computer_app_call`。
- 设备端窗口：「本机应用」改为发现列表加启用开关，原表单收进「高级：手动添加」。

**技术栈**：Bun + TypeScript（runner、server）、Hono、Drizzle、Tauri（Rust）加原生 JS 界面、React（app）。

**设计文档**：`docs/specs/2026-11-08-device-app-discovery.md`（上游：`docs/specs/2026-11-07-device-mcp-bridge.md`，其计划 `docs/plans/2026-11-07-device-mcp-bridge.md`）

## 全局约束

- 面向用户和员工的文案一律中文；工具 `description` 沿用现有英文写法。
- 每个 PR 最多改 8 个文件，按下文分组，叠在集成分支 `claude/magical-archimedes-8a6ljj` 上。
- 不运行 `bun install`，不改任何 lockfile，不新增 npm 依赖（JSONC 解析、注册表读取都自己写）。
- 不跳过、不放宽任何已有测试。
- 只有员工主人本人的运行能用（沿用 `localAppsAllowed` 和 `appsOf` 的主人检查）。
- 命令行、参数、环境变量值、文件路径、工作目录**永不离开本机**：动作输出、命令行输出、服务器、审计、审批卡片里只有名称、来源文字、类型、状态、说明和不透明编号。环境变量值只在启用时复制进本机 `runner-apps.json`。
- 候选编号有效期 `CANDIDATE_TTL_MS = 600_000`（10 分钟），过期提示「这个候选应用已过期或不存在，请重新查看本机应用。」
- 发现只做 Windows：其他平台 `apps.discover` 返回空候选和空已安装列表，什么也不读。
- 已安装软件最多返回 200 个（`INSTALLED_LIMIT`），候选最多 50 个（`MAX_CANDIDATES`），沿用 `MAX_APPS = 20`。
- 只接受回环地址（`127.0.0.1`、`localhost`、`[::1]`），复用 `apps.ts` 的判断。
- 每种配置格式（Claude Desktop、Claude Code `~/.claude.json`、Cursor、VS Code `mcp.json` 与 `settings.json` 的 `mcp.servers`、Windsurf）都有固定样例测试；注册表读取经可注入的读取函数，Linux 上可测，真 Windows 由 WIN1 探针检查。
- 内置清单（第 3 期）每一条都要先过真机验证这道人工关卡才能收录，代码里不猜。
- 第 1 期必须能单独发布：新服务器对旧 runner、新 runner 对旧服务器都要正常工作。
- 假设 `fix/runner-win-cmd-shim-path` 先合入：`mcp-client.ts` 会经 PATH/PATHEXT 把命令解析成绝对路径。本计划把它的解析函数称为 `resolveCommand(command, platform, env): string | undefined`；若合入时名字不同，用合入的那个，不要另写一份。
- 与「桌面操控」子项目并行：发现逻辑全部放在新文件里，共享文件只做下文「共享文件」一节列出的、用注释 `// --- app discovery (sub-project 3) ---` 圈起来的小插入。

## 共享文件（与桌面操控并行改动，只做圈定的插入）

| 文件 | 插入内容 | 任务 |
|---|---|---|
| `openbot/runner/src/execute.ts` | 第 6 个参数 `extras?: { discovery?: DiscoverActions }`；`switch` 之前一行转交 `DISCOVER_ACTIONS` | 5 |
| `openbot/runner/src/index.ts` | `APP_FLAGS` 加 `discover-apps`、`enable-candidate`；`main` 里共用一个 `createAppHost` 并创建发现动作 | 5、9 |
| `openbot/runner/src/mcp-client.ts` | `launchSpec` 对 `runtime: "bundled"` 的分支，返回值多一个 `env` | 8 |
| `openbot/server/src/computer/gateway.ts` | `listApps` 合并发现结果；新方法 `enableApp`；`govern` 的 `subject.enable` 分支；`write` 的 `app` 类型放宽 | 6、11 |
| `openbot/server/src/computer/headless-tools.ts` | `computer_apps` 说明文字；新工具 `computer_app_enable` | 6、11 |
| `openbot/server/src/computer/runner-transport.ts` | `actionFor` 两个映射；`apps.discover`、`apps.enable` 走 `durable:false` | 6、11 |
| `openbot/server/src/approvals/policy.ts` | `computer_app_enable` 底线；`isRunnerCommand` 加一项 | 10 |
| `openbot/server/src/approvals/types.ts` | `approvalArgsPreview` 加启用卡片分支 | 10 |
| `openbot/server/src/index.ts` | 网关选项 `deviceReachable`、`rememberDeviceApp` 的接线 | 11 |
| `openbot/desktop-device/ui/index.html`、`ui/main.js` | 「本机应用」区块改版 | 12 |

## 审查重点

1. **中文软件名乱码**：`reg.exe` 按 OEM 代码页（中文系统是 GBK）输出，`DisplayName` 会变成乱码进入模型上下文。读取必须用 PowerShell 并把输出设成 UTF-8 JSON（Task 3 有测试，WIN1 探针在 Task 5 断言没有 `\uFFFD`）。
2. **配置文件不是严格 JSON**：VS Code 的 `mcp.json`、`settings.json` 允许注释和尾逗号；记事本保存的文件开头有 UTF-8 BOM；`~/.claude.json` 可能有几十 MB。应当照常解析或只跳过这一个来源，不能让整次发现失败（Task 2 有测试）。
3. **编号被重放、伪造或配置已变**：超过 10 分钟、HMAC 不对、或签发后配置被改过的编号，启用时什么也不写，并提示重新查看（Task 4、Task 9、Task 11 有测试）。
4. **启用半途失败**：重名、已满 20 个、测试连接失败时，不留下半条登记，也不暂停设备；同一候选启用两次得到同一个应用（Task 9 有测试）。
5. **密钥和路径外泄**：样例配置里的 `sk-test-secret` 和 `C:\Users\…` 不能出现在动作输出、命令行输出、`computer_apps` 结果、审计行或审批卡片里（Task 4、Task 6、Task 11 有测试）。

---

## 第 0 步：早期验证

### Task 1：验证 `BUN_BE_BUN=1` 能否让编译后的 runner 充当 `bun x`（PR-0）

**文件：**
- 修改：`openbot/runner/tests/runner-package.test.ts`（在已编译的二进制上补离线检查）
- 新建：`openbot/scripts/ci/bunx-spike.ts`（编译 runner 并做联网检查，导出供探针复用）
- 修改：`openbot/scripts/ci/windows-runner-probe.ts`（在末尾调用同一检查）

**接口：**
- 产出：
  ```ts
  // bunx-spike.ts
  export const SPIKE_PACKAGE: string; // "@modelcontextprotocol/server-filesystem@<精确版本>"，实现时用 npm view 查当前版本写死
  export async function compileRunner(outDir: string): Promise<string>; // 用 build-sidecar.ts 的 compileArgs(host, host, outfile)，不需要 rustc
  export async function runBunxSpike(runner: string, workDir: string): Promise<{ check: string; passed: boolean; detail?: string }[]>;
  ```
  三项检查：`BUN_BE_BUN=1 <runner> --version` 输出版本号；`BUN_BE_BUN=1 <runner> <脚本>` 能运行一个 `.ts` 脚本；用 `connectApp({kind:"stdio", command: runner, args:["x","--bun",SPIKE_PACKAGE,workDir], env:{BUN_BE_BUN:"1"}})` 列出的工具含 `read_text_file`。直接运行 `bun scripts/ci/bunx-spike.ts` 时打印每项一行 JSON，全过时打印 `BUNX_SPIKE_PASS`。

- [ ] **Step 1：写失败测试** `runner-package.test.ts` 新用例 `BUN_BE_BUN=1 makes the compiled runner act as bun: --version and a script`：断言 `--version` 的 stdout 匹配 `/^\d+\.\d+\.\d+/`，脚本打印的标记出现在 stdout，且不带 `BUN_BE_BUN` 时同一二进制仍按 runner 处理（打印 usage 或参数错误）。联网的 `x --bun` 不放进单元测试。
- [ ] **Step 2：运行** `cd openbot/runner && bun test tests/runner-package.test.ts`。预期：要么通过（当前 Bun 支持），要么失败并给出原因；两种结果都记下来。
- [ ] **Step 3：实现 `bunx-spike.ts`**，并在 `windows-runner-probe.ts` 末尾（`WINDOWS_PROBE_PASS` 之前）调用 `compileRunner` 和 `runBunxSpike`，每项结果用现有的 `assert` 打印。
- [ ] **Step 4：在 Linux 上运行** `cd openbot && bun scripts/ci/bunx-spike.ts`，预期 `BUNX_SPIKE_PASS`；推分支后 CI 的 `WIN1 device CLI probe` 预期通过。
- [ ] **Step 5：定分支。** 两个平台三项都通过：Task 8 走「自带 runner」分支，Task 8b 不做。任何一项失败：Task 8 走「随包附带 bun」分支，并且要做 Task 8b；同时把 `runner-package.test.ts` 的新用例改成断言附带的 bun 可用（不能删掉或跳过）。把结论和两个平台的日志摘录写进 PR 描述，并在本计划 Task 8 标题后注明所走分支。
- [ ] **Step 6：提交并开 PR-0**，提交信息 `验证：编译后的 runner 能否用 BUN_BE_BUN 充当 bun x`。

---

## 第 1 期：发现与列出

### Task 2：AI 工具配置解析（runner/src/discover-configs.ts）

**文件：**
- 新建：`openbot/runner/src/discover-configs.ts`
- 测试：`openbot/runner/tests/discover-configs.test.ts`（各格式样例写成测试文件里的字符串常量）
- 修改：`openbot/runner/src/apps.ts`：只把 `isLoopbackUrl` 改为 `export`

**接口：**
- 产出：
  ```ts
  export type ConfigSource = "claude-desktop" | "claude-code" | "cursor" | "vscode" | "windsurf";
  export type DiscoveredSpec =
    | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
    | { kind: "http"; url: string };
  export type FoundServer = { source: ConfigSource; name: string; spec: DiscoveredSpec };
  export const SOURCE_LABELS: Record<ConfigSource, string>;
  // "Claude Desktop 的配置" "Claude Code 的配置" "Cursor 的配置" "VS Code 的配置" "Windsurf 的配置"
  export const SOURCE_SHORT: Record<ConfigSource, string>; // 重名时的后缀："Claude Desktop" … "Windsurf"
  export function parseJsonc(text: string): unknown;       // 去 BOM、去字符串外的 // 与 /* */ 注释、去尾逗号；不合法则抛错
  export function configFiles(env: Record<string, string | undefined>): { source: ConfigSource; path: string; read: (json: unknown) => unknown[] }[];
  export function serversFromConfig(source: ConfigSource, entries: Record<string, unknown>): FoundServer[];
  export function readConfigServers(opts: { env: Record<string, string | undefined>; readText: (path: string) => string | undefined }): FoundServer[];
  ```
- 路径（`win32.join`）与字段，照设计文档 §2.1：
  - `%APPDATA%\Claude\claude_desktop_config.json` → `mcpServers`
  - `%USERPROFILE%\.claude.json` → `mcpServers`，以及 `projects.*.mcpServers`（项目路径只用来遍历，不进入结果）
  - `%USERPROFILE%\.cursor\mcp.json` → `mcpServers`
  - `%APPDATA%\Code\User\mcp.json` → `servers`；`%APPDATA%\Code\User\settings.json` → `["mcp"]["servers"]` 或键名 `"mcp.servers"`
  - `%USERPROFILE%\.codeium\windsurf\mcp_config.json` → `mcpServers`
- 每一项的取舍：`command` 是非空字符串时为 stdio，`args` 缺省为 `[]`、不是字符串数组则丢弃该项，`env` 只保留字符串值，`cwd` 可选；否则取 `url` 或 `serverUrl`，只接受回环地址；其余字段一律忽略。名称取键名去空白、截到 40 个字，空名丢弃。
- `readText` 由调用方注入；某个文件读不到、解析失败，只跳过这个文件。

- [ ] **Step 1：写失败测试**，包含以下用例：
  - `claude desktop: mcpServers stdio and loopback url entries`
  - `claude code: top-level and per-project mcpServers; no project path appears in the result`（断言 `JSON.stringify(result)` 不含样例里的项目路径）
  - `cursor: mcpServers with url and with command`
  - `vscode: mcp.json servers and settings.json mcp.servers, with comments and trailing commas`
  - `windsurf: mcpServers with serverUrl`
  - `a non-loopback url, a missing command and non-string args are dropped; unknown fields are ignored`
  - `a UTF-8 BOM parses; a broken file skips only its own source`
  - `configFiles builds the five Windows paths from APPDATA and USERPROFILE, and none when both are missing`
- [ ] **Step 2：运行** `cd openbot/runner && bun test tests/discover-configs.test.ts`，预期失败（模块不存在）。
- [ ] **Step 3：实现 `discover-configs.ts`。** `parseJsonc` 逐字符扫描，记住是否在字符串里（处理 `\"` 转义），再用 `/,\s*([}\]])/g` 去掉字符串外的尾逗号，最后 `JSON.parse`。
- [ ] **Step 4：运行**，预期全部通过。
- [ ] **Step 5：提交**，提交信息 `runner：解析其他 AI 工具的 MCP 配置`。

### Task 3：已安装程序列表（runner/src/discover-installed.ts）

**文件：**
- 新建：`openbot/runner/src/discover-installed.ts`
- 测试：`openbot/runner/tests/discover-installed.test.ts`

**接口：**
- 产出：
  ```ts
  export type UninstallEntry = { DisplayName?: unknown; SystemComponent?: unknown; ParentKeyName?: unknown; ReleaseType?: unknown };
  export const INSTALLED_LIMIT = 200;
  export const UNINSTALL_SCRIPT: string;
  export function installedNames(entries: UninstallEntry[]): string[];
  export function readInstalledWindows(
    run?: (command: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>,
  ): Promise<UninstallEntry[]>;
  ```
- `UNINSTALL_SCRIPT`：先 `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)`，再对 `HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*`、`HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*`、`HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*` 执行 `Get-ItemProperty -ErrorAction SilentlyContinue`，只选 `DisplayName, SystemComponent, ParentKeyName, ReleaseType`，`ConvertTo-Json -Compress`。
- 默认 `run`：`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <脚本>`，`windowsHide`，15 000 ms 超时。退出码非 0、超时、输出不是 JSON 都返回 `[]`。`ConvertTo-Json` 只有一项时输出对象而不是数组，要统一成数组。
- `installedNames` 的过滤（设计文档 §2.3）：`SystemComponent === 1`、`ParentKeyName` 非空、名称匹配 `/\bKB\d{6,8}\b/i`、`ReleaseType` 属于 `Update`/`Hotfix`/`Security Update`/`Update Rollup` 的都去掉；去首尾空白，空名去掉；不区分大小写去重；按 `localeCompare(…, "zh-CN")` 排序；最多 200 个。

- [ ] **Step 1：写失败测试**：
  - `drops system components, child updates, KB patches and update release types`
  - `dedupes case-insensitively, keeps 中文 names intact, sorts and caps at 200`
  - `readInstalledWindows accepts one object or an array; a failed, timed-out or non-JSON run gives []`（注入假 `run`）
  - `the script reads both HKLM views and HKCU and sets UTF-8 output`（断言脚本含三个路径和 `UTF8Encoding`）
- [ ] **Step 2：运行** `bun test tests/discover-installed.test.ts`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**，预期通过。
- [ ] **Step 5：提交**，提交信息 `runner：读取 Windows 已安装程序列表`。

### Task 4：发现与候选编号（runner/src/discover.ts）

**文件：**
- 新建：`openbot/runner/src/discover.ts`
- 测试：`openbot/runner/tests/discover.test.ts`

**接口：**
- 读入：Task 2 的 `readConfigServers`、`DiscoveredSpec`、`SOURCE_LABELS`；Task 3 的 `installedNames`、`UninstallEntry`；`apps.ts` 的 `AppEntry`。
- 产出：
  ```ts
  export const CANDIDATE_TTL_MS = 600_000;
  export const MAX_CANDIDATES = 50;
  export const CANDIDATE_REF: RegExp; // /^cand_[0-9a-z]{1,10}_[A-Za-z0-9_-]{22}$/
  export const DISCOVER_KEY_FILE = "runner-discover.key";
  export type CandidateStatus = "ready" | "needs_uv" | "missing_command" | "unsupported";
  export type Candidate = {
    ref: string; name: string; source: ConfigSource | "catalog"; sourceLabel: string;
    kind: "stdio" | "http"; enabled: boolean; app?: string; // app：已登记时的 app_ 编号
    status: CandidateStatus; note?: string;
  };
  export type DiscoverResult = { platform: NodeJS.Platform; candidates: Candidate[]; installed: string[] };
  export type DiscoverDeps = {
    platform: NodeJS.Platform; env: Record<string, string | undefined>; dataDir: string;
    registry: { list(): AppEntry[] };
    readText: (path: string) => string | undefined;
    readInstalled: () => Promise<UninstallEntry[]>;
    resolveCommand: (command: string) => string | undefined;
    now: () => number;
  };
  export function identityOf(spec: DiscoveredSpec): string;
  export function identityOfEntry(entry: AppEntry): string;
  export function discoverApps(deps: DiscoverDeps): Promise<DiscoverResult>;
  export function findCandidate(deps: DiscoverDeps, ref: string): Promise<{ candidate: Candidate; spec: DiscoveredSpec } | { error: string }>;
  export const CANDIDATE_EXPIRED = "这个候选应用已过期或不存在，请重新查看本机应用。";
  ```
- **身份（去重和「已启用」判断）**：http 为规范化后的 URL；stdio 为命令的小写文件名（去掉 `.cmd/.exe/.bat`）加参数。`npx`（去掉开头的 `-y`/`--yes`）、`bunx`、`bun x` 归一为 `x:<包名> <其余参数>`。环境变量和工作目录不算身份。
- **编号**：`cand_<签发秒的 36 进制>_<HMAC-SHA256(密钥, 签发秒 \n 来源 \n 身份 \n env 与 cwd 的规范 JSON) 的 base64url 前 22 位>`。密钥是 `<dataDir>/runner-discover.key` 里的 32 个随机字节，第一次用时创建，权限 0o600（写法照 `apps.ts` 的 `save`）。`findCandidate` 先解析签发秒：早于 `now - CANDIDATE_TTL_MS` 或晚于 `now + 60 s` 即过期；然后用同一签发秒重扫，用 `timingSafeEqual` 比对；找不到一律返回 `CANDIDATE_EXPIRED`。
- **状态**：
  - http：`ready`；
  - 任一字符串含 `${`：`unsupported`，说明「配置里用到了变量（${…}），请在设备端「高级：手动添加」里填写实际值」；
  - npx / bunx / bun x：`ready`（启用时改写成自带运行时）；包名前有 `-y`/`--yes` 以外的选项：`unsupported`，说明「启动参数无法改写为自带运行时，请在「高级：手动添加」里添加」；
  - uvx / uv：`resolveCommand` 找得到为 `ready`，否则 `needs_uv`，说明「需要先安装 uv」；
  - 其他命令：`resolveCommand` 找得到为 `ready`，否则 `missing_command`，说明「找不到启动这个应用的程序，请先安装它」。说明里不写命令名。
- **顺序与重名**：按 Task 2 的来源顺序，同一身份只保留第一条；身份不同但名称相同时，后来者改名为 `名称（Cursor）` 这样带 `SOURCE_SHORT` 的形式。最多 50 个候选。
- **已启用**：登记里有同身份的项时带上 `app`，并且 `enabled` 等于该项的 `enabled`。
- 非 win32 平台直接返回 `{ platform, candidates: [], installed: [] }`，什么也不读、不创建密钥。`readInstalled` 抛错时 `installed` 为 `[]`，候选照常返回。

- [ ] **Step 1：写失败测试**（`platform: "win32"` 与 `env`、`readText`、`readInstalled`、`resolveCommand`、`now` 全部注入）：
  - `non-Windows platforms return nothing and read nothing`（`readText` 被调用次数为 0，数据目录里没有密钥文件）
  - `the same command and args in two tools is one candidate from the first source`
  - `npx -y pkg, bunx pkg and bun x pkg are one identity`
  - `a registered app with the same identity is enabled with its ref; a disabled one carries its ref but is not enabled`
  - `same name, different identity: the later one is renamed 名称（Cursor）`
  - `status: npx is ready; uvx without uv is needs_uv with 需要先安装 uv; a missing program is missing_command; ${input:key} is unsupported`
  - `refs: CANDIDATE_REF shape, distinct per candidate; findCandidate accepts at 9 min 59 s and refuses at 10 min 1 s, a forged mac, and a candidate whose env changed after issue`
  - `nothing secret leaves: the result JSON has no env value, command, arg, cwd or path from the fixtures`（样例里放 `sk-test-secret`、`C:\\Users\\me\\proj`）
  - `a throwing readInstalled gives installed [] and candidates still come back`
  - `the key file is created with mode 0o600 and reused by a second discovery`（非 Windows 宿主上 chmod 断言照 `apps.test.ts` 的写法）
- [ ] **Step 2：运行** `bun test tests/discover.test.ts`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**，预期通过；再运行 `cd openbot/runner && bun test`，全部通过。
- [ ] **Step 5：提交并开 PR-1**（Task 2–4，共 7 个文件），PR 标题 `runner：本机应用发现（AI 工具配置与已安装程序）`。

### Task 5：runner 接线（apps.discover、--discover-apps、WIN1）

**文件：**
- 新建：`openbot/runner/src/discover-actions.ts`
- 修改：`openbot/runner/src/execute.ts`（圈定插入，见「共享文件」）
- 修改：`openbot/runner/src/index.ts`（`--discover-apps`；`main` 里创建一个 `createAppHost(apps)`，同时交给执行器和发现动作）
- 修改：`openbot/scripts/ci/windows-runner-probe.ts`
- 测试：`openbot/runner/tests/discover-actions.test.ts`（新建）、`openbot/runner/tests/apps-cli.test.ts`（补用例）

**接口：**
- 读入：Task 4 的 `discoverApps`、`findCandidate`、`DiscoverDeps`。
- 产出：
  ```ts
  export const DISCOVER_ACTIONS: ReadonlySet<string>; // 本任务 {"apps.discover"}；Task 9 加 "apps.enable"
  export type DiscoverActions = (action: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<ActionOutcome>;
  export function createDiscoverActions(opts: {
    dataDir: string; registry: ReturnType<typeof createAppRegistry>;
    host?: ReturnType<typeof createAppHost>; deps?: Partial<DiscoverDeps>;
  }): DiscoverActions;
  ```
- 动作载荷：
  - `apps.discover {}` → `{ ok: true, output: { platform, candidates, installed } }`
  - `apps.discover { candidate }` → `{ ok: true, output: { platform, candidates: [那一个] 或 [] } }`，不读已安装列表
  - 出错为 `{ ok: false, error }`，**从不**带 `outcomeUnknown`。
- 默认 `deps`：`readText` 用 `statSync` 先看大小，超过 20 MB 返回 undefined，否则 `readFileSync(…, "utf8")`；`readInstalled = readInstalledWindows`；`resolveCommand` 用 shim 修复分支导出的那个；`now = Date.now`；`platform`、`env` 取 `process`。
- `execute.ts`：`createRunnerExecutor(workspaceDir, browser?, roots?, git?, apps?, extras?: { discovery?: DiscoverActions })`，在 `switch (action)` 之前：`if (extras?.discovery && DISCOVER_ACTIONS.has(action)) return extras.discovery(action, body, signal);`。没有 `extras` 时仍落到默认分支的「Nothing on this machine handles」。
- 命令行：`--discover-apps`（不带值，与其他 app 参数互斥）输出一行 `{ ok: true, platform, candidates, installed }`。

- [ ] **Step 1：写失败测试**：
  - `discover-actions.test.ts`：
    - `apps.discover answers candidates and installed through the executor`
    - `apps.discover with a candidate ref answers only that candidate, or none once expired`
    - `an executor without discovery still answers Nothing on this machine handles "apps.discover"`
  - `apps-cli.test.ts`：
    - `--discover-apps prints one JSON line with candidates and installed and no command or env value`
    - `--discover-apps cannot be combined with another app flag`
- [ ] **Step 2：运行** `cd openbot/runner && bun test tests/discover-actions.test.ts tests/apps-cli.test.ts`，预期新用例失败。
- [ ] **Step 3：实现上述接线。**
- [ ] **Step 4：WIN1 探针。** 在 `windows-runner-probe.ts` 里加两项：
  - 真注册表：`installedNames(await readInstalledWindows())` 至少 1 项，没有一项匹配 `/\bKB\d{6,8}\b/i`，`JSON.stringify` 结果不含 `\uFFFD`；
  - 真文件：在探针工作目录里建 `appdata\Claude\claude_desktop_config.json`，写一个名为 `fixture` 的服务器（`command` 为 `process.execPath`，`args` 为假 MCP 夹具路径），用 `createDiscoverActions({ …, deps: { env: { ...process.env, APPDATA: <它>, USERPROFILE: <工作目录> } } })` 交给执行器跑 `apps.discover`，断言得到 `fixture`、状态 `ready`，并且输出不含夹具路径。
- [ ] **Step 5：运行** runner 全部测试和 `cd openbot && bunx biome lint --error-on-warnings`，预期通过。
- [ ] **Step 6：提交并开 PR-2**（6 个文件），PR 标题 `runner：apps.discover 动作、--discover-apps 与 WIN1 探针`。CI 的 `WIN1 device CLI probe` 必须通过。

### Task 6：服务器 computer_apps 返回三组

**文件：**
- 新建：`openbot/server/src/computer/app-discovery.ts`
- 修改：`openbot/server/src/computer/gateway.ts`（`listApps` 合并发现结果；`ListAppsResult` 加字段）
- 修改：`openbot/server/src/computer/runner-transport.ts`（`apps/discover` → `apps.discover`，走 `durable:false`）
- 修改：`openbot/server/src/computer/headless-tools.ts`（`computer_apps` 的说明）
- 测试：`openbot/server/tests/app-discovery.test.ts`（新建，不需要 PG）、`openbot/server/tests/device-apps.integration.test.ts`（补用例）
- 修改：`openbot/scripts/ci/server-tests.list.txt`（`cd openbot && bun scripts/ci/server-shards.mjs --write` 生成）

**接口：**
- 读入：Task 5 的 `apps.discover` 输出。
- 产出：
  ```ts
  export const CANDIDATE_REF: RegExp; // 与 runner 相同
  export type DiscoveredCandidate = { candidate: string; name: string; source: string; kind: "stdio" | "http"; status: "ready" | "needs_uv" | "missing_command" | "unsupported"; note?: string };
  export type DiscoveryRead = { candidates: (DiscoveredCandidate & { enabled: boolean })[]; installed: string[] };
  export function readDiscovery(output: unknown): DiscoveryRead | undefined;
  export function discoveryGroups(read: DiscoveryRead, enabledNames: string[]): { available: DiscoveredCandidate[]; installed: string[] };
  export const AVAILABLE_HINT: string;
  export const INSTALLED_HINT = "这些软件已安装，但没有本机 MCP。需要操作它们时，可以考虑用桌面操控。";
  export const OLD_RUNNER = "主人电脑上的设备端版本较旧，更新后才能查看可启用的应用。";
  ```
  - 第 1 期 `AVAILABLE_HINT = "这些是在主人电脑上发现、但还没启用的应用。可以请主人在设备端窗口的「本机应用」里打开它的开关。"`（Task 11 改为启用工具的说法）。
  - `readDiscovery` 把设备输出当作不可信输入：编号要匹配 `CANDIDATE_REF`；名称 1–40 个字；来源文字 ≤ 60 个字（字段 `sourceLabel` 映射为 `source`）；`kind`、`status` 必须是列出的值；`note` ≤ 120 个字；最多 50 个候选；`installed` 最多 200 个、每个 ≤ 120 个字；`app` 等其余字段一律丢掉。不是对象时返回 undefined。
  - `discoveryGroups`：`available` 是 `enabled === false` 的候选；`installed` 去掉与已启用应用名或可启用候选名相同（不区分大小写）的名字。
- `ListAppsResult` 变为：
  ```ts
  { apps: …; available?: DiscoveredCandidate[]; installed?: string[]; hints?: { available: string; installed: string }; discoveryError?: string }
  ```
  只在不带 `app` 参数时做发现：`listApps` 的 `run` 里列完已登记应用后，`transport.post(runnerAddress(machine), botId, "/apps/discover", {}, signal, DISCOVER_BACKSTOP_MS)`，`DISCOVER_BACKSTOP_MS = 30_000`。失败不影响 `apps`：错误信息以 `Nothing on this machine handles` 开头时 `discoveryError = OLD_RUNNER`，其他错误为 `这次没能查看主人电脑上的其他应用：<原因>`。`withUntrustedNotice` 的字段改为 `["apps", "available", "installed"]`。
- `computer_apps` 说明末尾追加：`Without app, it also lists apps found on the computer that are not enabled yet (available) and installed software that has no local app (installed); follow the hints that come with them.`

- [ ] **Step 1：写失败测试**：
  - `app-discovery.test.ts`：
    - `readDiscovery keeps ref, name, source label, kind, status and note; drops bad refs, long names, unknown statuses, extra fields and the app ref`
    - `discoveryGroups leaves enabled candidates out of available and known names out of installed`
    - `caps: 50 candidates, 200 installed names`
  - `device-apps.integration.test.ts`（真实 runner 加 `createDiscoverActions`，注入 `platform: "win32"`、样例 `APPDATA`、假的 `readInstalled`）：
    - `computer_apps lists enabled, available and installed groups, and the result carries no command, path or env value`
    - `computer_apps with app lists that one app and sends no apps.discover frame`
    - `a runner without discovery still lists enabled apps and says the device app needs updating`
    - 现有的 `with the team's cap at never, listing local apps is refused before any app is started` 和 `only the Bot's owner may use the owner's local apps`：补断言「没有发出 `apps.discover` 帧」。
- [ ] **Step 2：运行**：`cd openbot/server && bun test tests/app-discovery.test.ts`；在本地 PG 环境（同上游计划的 `main-run-tests.sh` 方式）运行 `tests/device-apps.integration.test.ts`。预期新用例失败。
- [ ] **Step 3：实现。** 运行 `cd openbot && bun scripts/ci/server-shards.mjs --write`。
- [ ] **Step 4：运行**，预期通过；再运行设备、runner、computer、approval 相关测试，失败数不多于 `docs/acceptance/BASELINE-FAILURES.md` 记录的基线；`bunx biome lint --error-on-warnings` 无问题。
- [ ] **Step 5：提交并开 PR-3**（7 个文件），PR 标题 `服务器：computer_apps 增加可启用与已安装两组`。

### Task 7：第 1 期发版检查点

**文件：**
- 修改：`openbot/package.json`（版本升到 main 当时版本的下一个补丁号，计划写作时为 `0.2.4`）、`openbot/CHANGELOG.md`、`openbot/README.md`、`openbot/delivery.env.example`、`openbot/docs/deployment-qoderwake.md` 中的默认版本号（README 是 CRLF，按字节替换）
- 修改：`docs/acceptance/HUMAN-STEPS.md`：新增「15. 本机应用发现：真机验收」，本任务先写第 1 期部分

- [ ] **Step 1**：PR-1 到 PR-3 合入集成分支，集成分支合入 main，CI 全绿。
- [ ] **Step 2**：请用户推设备端 rc 标签和服务器标签，两条发布流水线通过后升级京东云服务器、覆盖安装设备端。
- [ ] **Step 3**：真机上说「我电脑上有哪些可以用的应用」，预期员工列出三组；在服务器日志和审计里确认没有命令、路径、密钥。结果写进 `HUMAN-STEPS.md` 并提交。

---

## 第 2 期：一句话启用

### Task 8：自带运行时（分支：Task 1 定）（PR-4）

**文件：**
- 新建：`openbot/runner/src/bundled-runtime.ts`
- 修改：`openbot/runner/src/apps.ts`：stdio 项加可选 `runtime?: "bundled"`，`readEntry` 和 `add` 只接受这一个值
- 修改：`openbot/runner/src/mcp-client.ts`（圈定插入）：`launchSpec` 返回值加 `env?: Record<string, string>`；`entry.runtime === "bundled"` 时返回 `{ command: rt.command, args: [...rt.prefix, ...entry.args], env: rt.env }`，**不经** `cmd.exe`；拿不到运行时抛 `McpAppError("start", …)`，中文说明「设备端自带的运行时不可用，请重新安装设备端。」；`StdioTransport` 把 `spec.env` 叠在 `childEnv(...)` 之上
- 测试：`openbot/runner/tests/bundled-runtime.test.ts`（新建）、`openbot/runner/tests/mcp-client.test.ts`、`openbot/runner/tests/apps.test.ts`（补用例）

**接口：**
- 产出：
  ```ts
  export type BundledRuntime = { command: string; prefix: string[]; env: Record<string, string> };
  export function bundledRuntime(opts?: { execPath?: string; platform?: NodeJS.Platform; exists?: (path: string) => boolean }): BundledRuntime | undefined;
  export function toBundledArgs(spec: { command: string; args: string[] }): string[] | undefined;
  ```
  - 自带 runner 分支：`{ command: execPath, prefix: ["x", "--bun"], env: { BUN_BE_BUN: "1" } }`（开发时 `execPath` 就是 bun，同样可用）。
  - 随包 bun 分支：`execPath` 同目录下的 `bun` / `bun.exe` 存在时 `{ command: 它, prefix: ["x", "--bun"], env: {} }`，否则 undefined。
  - `toBundledArgs`：`npx -y pkg a` → `["pkg","a"]`；`npx --yes pkg`、`bunx pkg`、`bun x pkg` 同理；包名前有其他选项、或命令不是这三种时返回 undefined。
  - 登记里存的是 `{ command: "bunx", runtime: "bundled", args: [包名, …] }`，运行时路径每次启动时现算，设备端升级换路径也不受影响。

- [ ] **Step 1：写失败测试**：
  - `bundled-runtime.test.ts`：
    - `npx -y, npx --yes, bunx and bun x rewrite to the package and its args; npx -p x y and node script.js do not`
    - `bundledRuntime: the runner itself with BUN_BE_BUN=1`（随包 bun 分支改为 `the bun beside the runner, and none when it is missing`）
  - `mcp-client.test.ts`：`launchSpec: a bundled entry starts the bundled runtime with x --bun on win32 and linux, never through cmd.exe, and carries its env`
  - `apps.test.ts`：`runtime "bundled" persists across instances; any other runtime value is refused`
- [ ] **Step 2：运行** `cd openbot/runner && bun test tests/bundled-runtime.test.ts tests/mcp-client.test.ts tests/apps.test.ts`，预期新用例失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行** runner 全部测试，预期通过。
- [ ] **Step 5：提交并开 PR-4**（6 个文件），PR 标题 `runner：npm 类本机应用使用设备端自带的 Bun 运行时`。

### Task 8b：随设备端附带 bun（只在 Task 1 失败时做）（PR-4b）

**文件：**
- 修改：`openbot/desktop-device/scripts/build-sidecar.ts`：新增 `bunSidecarFile(triple)` = `bun-<triple>[.exe]`；主机三元组等于目标时把 `process.execPath` 复制过去；交叉编译时报错说明「附带的 bun 必须在目标平台上构建」（Windows 安装包本来就在 `windows-latest` 上构建）
- 修改：`openbot/desktop-device/src-tauri/tauri.bundle.conf.json`：`externalBin` 加 `binaries/bun`
- 修改：`openbot/desktop-device/tests/build-sidecar.test.ts`
- 修改：`.github/workflows/ci.yml` 的 `device-bundle-linux` 检查一步：断言包里有 `usr/bin/bun`

- [ ] **Step 1：写失败测试** `bunSidecarFile names bun-<triple> with .exe on windows`、`the bundle config ships binaries/bun beside the runner`。
- [ ] **Step 2：运行** `cd openbot/desktop-device && bun test`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**，预期通过；CI 的 deb 和 NSIS 两个打包任务通过，安装包体积增加约 50 MB，写进 PR 描述。
- [ ] **Step 5：提交并开 PR-4b**，PR 标题 `设备端：随安装包附带 bun 运行时`。

### Task 9：runner 启用候选（apps.enable、--enable-candidate）（PR-5）

**文件：**
- 修改：`openbot/runner/src/discover-actions.ts`：`DISCOVER_ACTIONS` 加 `apps.enable`
- 修改：`openbot/runner/src/index.ts`：`--enable-candidate <ref>`
- 修改：`openbot/scripts/ci/windows-runner-probe.ts`
- 测试：`openbot/runner/tests/discover-actions.test.ts`、`openbot/runner/tests/apps-cli.test.ts`（补用例）

**接口：**
- 读入：Task 4 的 `findCandidate`、`CANDIDATE_EXPIRED`；Task 8 的 `toBundledArgs`；`createAppHost` 的 `tools()` 和 `AppHostError`。
- 产出：
  - `apps.enable { candidate }` → `{ ok: true, output: { app: { ref, name }, tools: McpTool[] } }`；出错 `{ ok: false, error }`，**从不**带 `outcomeUnknown`（启用可以安全重试）。
  - `--enable-candidate <ref>` 输出 `{ ok: true, app, tools: [工具名…], apps: AppEntry[]（env 打码） }`。
- 流程：
  1. `findCandidate` 失败 → `CANDIDATE_EXPIRED`；`status !== "ready"` → `「名称」暂时不能启用：<note>`。
  2. 候选带 `app`：已启用则直接 `host.tools(app)` 返回（同一候选启用两次得到同一个应用）；已停用则 `setEnabled(app, true)`。
  3. 否则组 `AppInput`：http 为 `{ kind:"http", name, url }`；`toBundledArgs` 有结果时为 `{ kind:"stdio", name, command:"bunx", runtime:"bundled", args, env, cwd }`；否则原样 stdio。名称已被占用时依次试 `名称（2）`…`名称（9）`，截到 40 个字。`registry.add` 抛的 `AppRegistryError`（例如已满 20 个）原样返回。
  4. `host.tools(ref)` 测试连接。失败时回滚（新加的删掉，重新打开的再关上），返回 `AppHostError.userMessage`。

- [ ] **Step 1：写失败测试**（注入 `deps` 与假 MCP 夹具）：
  - `apps.enable writes the candidate, tests it and answers its tools`
  - `apps.enable stores npx -y pkg as the bundled runtime, with the env value copied only into runner-apps.json`（断言文件里有 `runtime:"bundled"` 和真实值，动作输出里没有）
  - `apps.enable twice answers the same app; a disabled registered app is switched back on, not added again`
  - `a taken name becomes 名称（2）`
  - `a failed connection test removes what was written and answers the host's 中文 error without outcomeUnknown`
  - `an expired, forged or needs_uv candidate writes nothing and says why`
  - `with 20 apps registered the registry's 中文 refusal comes back and nothing is written`
  - `apps-cli.test.ts`：`--enable-candidate enables a discovered app and prints masked apps`
- [ ] **Step 2：运行** `cd openbot/runner && bun test tests/discover-actions.test.ts tests/apps-cli.test.ts`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：WIN1 探针**：用 Task 5 的 `fixture` 候选跑 `apps.enable`，断言工具为 `echo,write_note,wipe`，再启用一次得到同一个 `ref`。
- [ ] **Step 5：运行** runner 全部测试和 biome，预期通过；CI 的 WIN1 通过。
- [ ] **Step 6：提交并开 PR-5**（5 个文件），PR 标题 `runner：apps.enable 启用发现的本机应用`。

### Task 10：审批底线、卡片与权限项（PR-6）

**文件：**
- 修改：`openbot/server/src/approvals/policy.ts`（圈定插入）
- 修改：`openbot/server/src/approvals/types.ts`（圈定插入）
- 测试：`openbot/server/tests/approvals-policy.test.ts`
- 修改：`openbot/app/src/components/bot-profile/permissions.tsx`：加 `{ ref: "computer_app_enable", label: "启用本机应用" }`
- 修改：`openbot/app/src/lib/approvals.ts`：`POLICY_SOURCE_LABELS` 加 `app_enable: "启用本机应用"`
- 测试：`openbot/app/tests/employee-permissions.test.tsx`

**接口：**
- 产出（`policy.ts`）：
  ```ts
  export const APP_ENABLE_TOOL = "computer_app_enable";
  export function appEnableReason(name: string, source: string): string; // `允许员工使用本机应用「${name}」？来源：${source}`
  ```
  - 底线：`candidate.toolRef === APP_ENABLE_TOOL` 时 `{ source: "app_enable", reason: appEnableReason(target.name, display.description ?? "本机") }`，放在 `app_tool` 底线之后；没有任何设置能关掉它。
  - `isRunnerCommand` 加 `computer_app_enable`，团队上限 `never` 直接拒绝，`ask` 照样审批。
- 产出（`types.ts`）：`approvalArgsPreview` 对 `computer_app_enable` 返回 `{ app: target.name, source: display.description }`。摘要不改：`target` 是 `{ candidate, name }`，来源只在 `display` 里（C1）。

- [ ] **Step 1：写失败测试**：
  - `approvals-policy.test.ts`：
    - `computer_app_enable always asks: an allow rule, auto review and the person's run-directly default still ask, with 允许员工使用本机应用「Figma」？来源：内置清单`
    - `team cap never and a disabled tool deny computer_app_enable`
    - `the enable card shows app and source; two candidates that differ only in display.description have the same actionDigest`（用 `approvalAction` 和 `approvalArgsPreview`）
  - `employee-permissions.test.tsx`：`the permissions page lists 启用本机应用`
- [ ] **Step 2：运行** `cd openbot/server && bun test tests/approvals-policy.test.ts`、`cd openbot/app && bun test tests/employee-permissions.test.tsx`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**，预期通过；biome 无问题。
- [ ] **Step 5：提交并开 PR-6**（6 个文件），PR 标题 `审批：启用本机应用一律审批；权限页加「启用本机应用」`。

### Task 11：computer_app_enable 工具与网关（PR-7）

**文件：**
- 修改：`openbot/server/src/computer/app-discovery.ts`：候选缓存；`AVAILABLE_HINT` 改为启用说法
- 修改：`openbot/server/src/computer/gateway.ts`（圈定插入）
- 修改：`openbot/server/src/computer/headless-tools.ts`（圈定插入）
- 修改：`openbot/server/src/computer/runner-transport.ts`（`apps/enable` → `apps.enable`，走 `durable:false`）
- 修改：`openbot/server/src/devices/store.ts`：`rememberApp`
- 修改：`openbot/server/src/index.ts`（圈定插入）
- 测试：`openbot/server/tests/app-discovery.test.ts`、`openbot/server/tests/device-apps.integration.test.ts`

**接口：**
- 读入：Task 6 的 `readDiscovery`；Task 9 的 `apps.enable` 输出；Task 10 的 `APP_ENABLE_TOOL`。
- 产出：
  ```ts
  // app-discovery.ts
  export function createCandidateCache(now: () => number): {
    remember(machine: { tenantId: string; deviceId: string }, candidates: DiscoveryRead["candidates"]): void;
    find(machine: { tenantId: string; deviceId: string }, ref: string): (DiscoveredCandidate & { enabled: boolean }) | undefined;
  }; // 有效 600_000 ms，最多 1000 台设备，按插入顺序淘汰
  export const AVAILABLE_HINT = "这些是在主人电脑上发现、但还没启用的应用。要用其中一个，调用 computer_app_enable 并传入它的 candidate；主人批准后就能调用它的工具。";
  export const DEVICE_OFFLINE_ENABLE = "设备不在线，无法启用本机应用。请等主人的电脑连上后再试。";
  export function readEnabled(output: unknown): { app: { ref: string; name: string }; tools: unknown[] } | undefined; // ref 匹配 app_ 形状，名称 1–40 字
  // gateway.ts
  enableApp(botId: string, actor: ActionActor, input: { candidate: string }, signal?: AbortSignal): Promise<{ enabled: { name: string; tools: AppTool[] }; next: string }>;
  // 网关选项
  deviceReachable?: (machine: { tenantId: string; deviceId: string }) => boolean;
  rememberDeviceApp?: (machine: { tenantId: string; deviceId: string }, app: { ref: string; name: string }) => Promise<void>;
  // store.ts
  rememberApp(tenantId: string, deviceId: string, app: DeviceApp): Promise<void>; // 读出 apps，ref 不在则追加，经 reportedApps 收紧后写回
  ```
- `enableApp` 的顺序（每一步失败都不弹卡片、不排队）：
  1. `appsOf`（只有主人）。
  2. `options.approvalRefusal({ toolRef: APP_ENABLE_TOOL, effect: "write", scope: input.candidate, … , subject: { runner: true } })` 有结果就抛 `ApprovalRefusedError`：团队上限 `never` 或工具被禁用时，连设备都不问。
  3. `deviceReachable(machine) === false` → 经 `govern` 的 `refusal` 记一行审计，文案 `DEVICE_OFFLINE_ENABLE`。
  4. 找候选：先查 `listApps` 记下的缓存，没有就 `apps.discover { candidate }`；找不到 → `refusal` 为 `CANDIDATE_EXPIRED` 的服务器同文；`status !== "ready"` → `「名称」暂时不能启用：<note>`；已启用 → `「名称」已经启用了，可以直接用 computer_app_call 调用。`
  5. `govern(APP_ENABLE_TOOL, botId, actor, { device: machine, enable: { candidate, name, source } }, run)`，`govern` 的 `enable` 分支：`effect: "write"`，`scope: name`，`target: { candidate, name }`，`display: { description: source }`，`subject: { runner: true }`；审计行的 `app` 为 `{ name, source }`（`write` 的 `app` 类型放宽为 `{ name: string; tool?: string; source?: string }`）。
  6. `run`：`transport.post(runnerAddress(machine), botId, "/apps/enable", { candidate }, signal, APP_ENABLE_BACKSTOP_MS)`，`APP_ENABLE_BACKSTOP_MS = 60_000`（20 s 启动 + 20 s 列工具，有余量）。`DeviceOfflineError` 换成 `DEVICE_OFFLINE_ENABLE`。
  7. 成功后 `rememberDeviceApp(machine, app)`，并用 `readAppTools(tools)` 预填 `appTools` 缓存（键 `tenant/device/ref`），返回 `withUntrustedNotice({ enabled: { name, tools }, next: "现在可以用 computer_app_call 调用「名称」的工具了。" }, "local app", ["enabled"])`。
- `listApps` 每次读到发现结果时 `remember` 进缓存。
- `computer_app_enable`（在 `onDevice && options.apps` 块里）：参数 `z.strictObject({ candidate: z.string().regex(CANDIDATE_REF) })`，说明：`Enable one app found on the person's own paired computer, listed under available by computer_apps, so its tools can be called. Pass its candidate exactly as listed. The person must approve; if refused say so rather than retrying. A candidate older than 10 minutes must be listed again with computer_apps.`
- `index.ts`：`deviceReachable: (machine) => deviceChannel.isReachable(machine)`，`rememberDeviceApp: (machine, app) => deviceStore.rememberApp(machine.tenantId, machine.deviceId, app)`。
- 已知小窗口：一次在启用前组好的心跳若晚于 `rememberApp` 落库，会把新应用暂时盖掉，下一次心跳（20 秒内）自愈；不为此加锁。

- [ ] **Step 1：写失败测试**：
  - `app-discovery.test.ts`：`the candidate cache finds a ref for 10 minutes, per machine, and forgets the oldest past 1000 machines`；`readEnabled drops a bad app ref or name`
  - `device-apps.integration.test.ts`：
    - `computer_app_enable asks with 允许员工使用本机应用「fixture」？来源：Claude Desktop 的配置; after approve the app is written, tested and callable at once`（批准后不等心跳直接 `computer_app_call echo` 成功，设备记录的 `apps` 里有它）
    - `rejected: nothing is written on the device`
    - `offline device: 设备不在线, no approval card, nothing queued`
    - `approved, then the device went away before it ran: 设备不在线, nothing queued, the device is not paused`
    - `an expired or unknown candidate: 请重新查看本机应用, no card`
    - `team cap never or the tool disabled: refused before any frame reaches the device`
    - `a teammate cannot enable the owner's apps`
    - `the enable's audit rows carry the app name and source and no command, path or env value`
- [ ] **Step 2：运行**：`cd openbot/server && bun test tests/app-discovery.test.ts`；本地 PG 环境运行 `tests/device-apps.integration.test.ts`。预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**，预期通过；再跑设备、runner、computer、approval 相关测试（不多于基线失败数）和 biome。
- [ ] **Step 5：提交并开 PR-7**（8 个文件），PR 标题 `服务器：computer_app_enable 一句话启用本机应用`。

### Task 12：设备端窗口「发现的应用」（PR-8）

**文件：**
- 修改：`openbot/desktop-device/src-tauri/src/apps.rs`：`AppCommand::Discover`（`--discover-apps`）、`AppCommand::EnableCandidate(String)`（`--enable-candidate <ref>`）；`candidates_of(reply) -> Vec<Value>`
- 修改：`openbot/desktop-device/src-tauri/src/main.rs`：注册 `discover_apps`、`enable_candidate`
- 新建：`openbot/desktop-device/ui/discover.js`
- 修改：`openbot/desktop-device/ui/index.html`、`openbot/desktop-device/ui/main.js`（圈定插入）
- 测试：`openbot/desktop-device/tests/discover.test.ts`（新建）

**接口：**
- 产出（`discover.js`，纯函数，写法照 `apps.js`）：
  ```js
  export function describeCandidates(reply) // → { items: [{ ref, app, name, source, on, disabled, note }], empty?: string, installedCount: number }
  export async function toggleCandidate(item, on, invoke) // on 且未登记 → enable_candidate；on 且已登记 → set_app_enabled(app, true)；off → set_app_enabled(app, false)
  ```
  - `disabled = status !== "ready"`，开关灰掉并显示 `note`。
  - 非 Windows 或没有候选时 `empty`：`没有发现可用的本机应用。可以在下面「高级：手动添加」里自己添加。`
- 界面（设计文档 §1 第 5 条）：
  - 「本机应用」区块顶部是「发现的应用」列表，每项：名称、来源文字、开关；打开开关前不弹确认（这是主人本人在自己电脑上的操作），打开后显示「已启用，员工可以使用」或测试失败的中文原因。
  - 「重新查看」按钮再跑一次 `discover_apps`。
  - 原来的应用列表（测试连接、删除）和添加表单整体放进 `<details>`，标题「高级：手动添加」，默认收起；说明文字保留。

- [ ] **Step 1：写失败测试**：
  - `discover.test.ts`：
    - `describeCandidates: a needs_uv candidate is greyed out with 需要先安装 uv; an enabled one is on`
    - `toggleCandidate: enabling a new candidate calls enable_candidate; switching a registered one calls set_app_enabled`
    - `an empty reply shows the 高级：手动添加 hint`
  - Rust（`apps.rs` 内）：`discover_apps passes --discover-apps and enable_candidate passes --enable-candidate with the ref, nothing on stdin`
- [ ] **Step 2：运行** `cd openbot/desktop-device && bun test`、`cd src-tauri && cargo test`（本地没有 Rust 工具链就交给 CI），预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**，预期通过；CI 的 `device shell tests` 两个平台通过。
- [ ] **Step 5：提交并开 PR-8**（6 个文件），PR 标题 `设备端窗口：发现的应用与启用开关，手动表单收进「高级」`。

### Task 13：第 2 期发版与真机验收

**文件：**
- 修改：Task 7 列出的版本文件（再升一个补丁号）、`openbot/CHANGELOG.md`
- 修改：`docs/acceptance/HUMAN-STEPS.md` 第 15 节补第 2 期部分

- [ ] **Step 1**：PR-4 到 PR-8 合入集成分支并进 main，CI 全绿；请用户推两个标签，升级服务器、覆盖安装设备端。
- [ ] **Step 2**：按设计文档 §1 第 6 条在用户的 Windows 电脑上验收，**全程不打开设备端窗口**：
  1. 说「我电脑上有哪些可以用的应用」，员工列出三组；
  2. 说「启用 <可启用组里的某一项>」（优先选来自 Claude Desktop / Cursor 配置的 npm 类应用，以验证自带运行时；`文件助手` 在子项目一验收时已手动登记，会出现在「已启用」组，不能用来验收启用），弹出审批，卡片写着「允许员工使用本机应用「…」？来源：…」；
  3. 批准后员工直接调用它的一个只读工具，结果回到对话；
  4. 用户电脑上若没装 Node.js，这一项同时证明 `npx` 改写成功。
- [ ] **Step 3**：再打开设备端窗口，确认刚启用的应用开关是开的，关掉后员工再调用会提示应用已停用。结果写进 `HUMAN-STEPS.md` 并提交。

---

## 第 3 期：内置清单

### Task 14：内置清单匹配（代码，清单为空）（PR-9）

**文件：**
- 新建：`openbot/runner/src/discover-catalog.ts`
- 新建：`openbot/runner/src/discover-catalog.json`，内容 `{ "entries": [] }`
- 修改：`openbot/runner/src/discover.ts`：把清单作为第六个来源，排在配置来源之后；被清单条目匹配到的已安装程序名从 `installed` 里去掉
- 测试：`openbot/runner/tests/discover-catalog.test.ts`（新建）、`openbot/runner/tests/discover.test.ts`（补用例）

**接口：**
- 产出：
  ```ts
  export type CatalogEntry = {
    id: string; name: string;
    detect: { installed?: string; paths?: string[]; port?: { url: string } }; // installed 是正则源码；paths 支持 %VAR%
    launch: { bunx: { package: string; args?: string[] } } | { url: string };
    verified: string; // 真机验证记录：日期、机器、软件版本
  };
  export function matchCatalog(entries: CatalogEntry[], ctx: {
    env: Record<string, string | undefined>; installed: string[];
    exists: (path: string) => boolean; probe: (url: string) => Promise<boolean>;
  }): Promise<{ found: FoundServer[]; matchedInstalled: string[] }>;
  ```
  - 条目成为候选的条件：`installed` 匹配某个已安装名，或 `paths` 有一个存在；只有 `port` 时必须探测成功。
  - 来源文字：探测成功为 `内置清单，检测到 <名称> 正在运行`，否则 `内置清单，检测到已安装 <名称>，使用前请先打开它`。
  - `launch.bunx` 转成 `{ kind:"stdio", command:"bunx", args:[package, ...args] }`，启用时走 Task 9 的改写；`args` 里的 `%VAR%` 用 `env` 展开。
  - 默认 `probe`：用 `connectApp({ kind:"http", url })` 做一次 `initialize`，1 500 ms 超时，然后关闭。
  - `FoundServer.source` 扩成 `ConfigSource | "catalog"`，`SOURCE_LABELS` 不含 `catalog`（来源文字由上面规则生成）。

- [ ] **Step 1：写失败测试**（清单用测试里的样例条目，不读真 JSON）：
  - `an installed-name match makes a candidate; a port-only entry needs a successful probe`
  - `the source label says 正在运行 after a probe and 请先打开它 otherwise`
  - `bunx launches become stdio bunx specs with %USERPROFILE% expanded in args`
  - `a config source with the same identity wins over the catalogue`
  - `names matched by the catalogue leave the installed list`
  - `every shipped entry has a verified note and pins an exact package version (@x.y.z)`（这一条读真 `discover-catalog.json`，空清单也必须通过）
- [ ] **Step 2：运行** `cd openbot/runner && bun test tests/discover-catalog.test.ts tests/discover.test.ts`，预期失败。
- [ ] **Step 3：实现。** JSON 用 `import catalog from "./discover-catalog.json" with { type: "json" }`，随 `bun build --compile` 打进二进制，不从网络下载。
- [ ] **Step 4：运行** runner 全部测试（含 `runner-package.test.ts`），预期通过。
- [ ] **Step 5：提交并开 PR-9**（5 个文件），PR 标题 `runner：内置常用软件清单的匹配（清单暂空）`。

### Task 15：逐条真机验证后收录（人工关卡）

每一条单独一个 PR，只改 `openbot/runner/src/discover-catalog.json`、`openbot/runner/tests/discover-catalog.test.ts`（加这一条的匹配样例，用真机上看到的原文）、`docs/acceptance/HUMAN-STEPS.md`。

候选（设计文档 §2.2）：Figma 桌面版 Dev Mode MCP（本机地址）、JetBrains IDE 自带的 MCP、npm 类常用工具（文件系统、Excel/Office 文件读写）。

- [ ] **Step 1：在用户的 Windows 电脑上取事实**，不靠记忆：
  - 已安装名：`openbot-runner --discover-apps` 的 `installed` 里该软件的原文；
  - 本机地址：软件打开时，用「高级：手动添加」登记该地址并「测试连接」成功，记下地址和工具数；
  - npm 包：用 `--add-app -` 以 `bunx` 登记精确版本并 `--test-app` 成功，记下版本号和工具数。
- [ ] **Step 2：取不到、测不通的条目不收录**，在 `HUMAN-STEPS.md` 里记「未收录：原因」。文件系统类条目要用户先决定开放哪个目录，没有决定之前不收录。
- [ ] **Step 3：写入条目**，`verified` 填日期、机器和软件版本；补匹配样例测试；运行 `bun test tests/discover-catalog.test.ts`，预期通过。
- [ ] **Step 4：发 rc 后复验**：在对话里说「我电脑上有哪些可以用的应用」能看到这一条，说「启用 <名称>」并批准后能调用。结果写进 `HUMAN-STEPS.md`。
- [ ] **Step 5：提交并开 PR**，PR 标题 `内置清单：收录 <名称>（已真机验证）`。
