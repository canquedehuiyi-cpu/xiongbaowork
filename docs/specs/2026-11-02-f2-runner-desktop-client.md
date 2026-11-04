# F2 runner 桌面客户端设计规格

- 日期：2026-11-02
- 状态：**草案，含待决策项**。动工前需要产品和发布负责人拍板，本文不含代码。
- 故事：`docs/acceptance/STORIES.md` F2（D11），原文见 `docs/specs/2026-10-06-qoderwake-replica.md` 第 127 行。
- 相关故事：F3（设备网关，缺陷 #12）、F4（离线排队）、WIN1（原生 Windows CLI）、DEV1（结果不明时暂停）、第 7 道门（Windows/Linux 干净部署证据）。

> 故事原文：将 `agent-computer`（Chromium + workspace + shell + 录屏）打包为 Tauri 客户端。安装后**出站** WebSocket 连接中心 server（设备发起，无需公网 IP 或端口映射），注册 `device_id`（machineId，UUID 持久化在本机配置）。一个租户可注册多台设备并命名。

---

## 1. 现状（基线：`claude/magical-archimedes-8a6ljj`）

### 1.1 runner（`openbot/runner`）：一个 Bun 命令行程序，协议部分已经可用

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 入口、参数、配对 | `runner/src/index.ts`：`parseArgs`、`pair()`（`POST /api/runner/register`）、`main()` | 用户必须在终端输入 `bun runner/src/index.ts --server … --pair CODE`。这行命令由 `app/src/components/settings/my-devices.tsx:26` 生成，前提是本机装了 Bun 并有仓库源码 |
| 出站长连 | `index.ts`：`connect()` 连 `…/api/runner/ws?token=`，带心跳（`DEFAULT_INTERVAL_MS = 20_000`）和指数退避（最长 30s） | 本机不监听任何端口，满足"设备发起" |
| 设备身份 | `index.ts`：`deviceIdFor()` 生成 `${hostname()}-${randomUUID().slice(0, 8)}`；`readState`/`writeState` 把状态写进 `runner-state.json`（权限 0600） | 不是纯 UUID，令牌以明文 JSON 存放 |
| 执行 | `runner/src/execute.ts`：`createRunnerExecutor()` 直接 import `agent-computer/src/shell` 的 `createShell` 和 `agent-computer/src/workspace` 的 `createWorkspace` | **shell 和文件这两块已经复用 agent-computer**，三层路径约束是同一份代码 |
| 浏览器 | `runner/src/browser.ts`：`createRunnerBrowser()` 基于 `playwright-core`，驱动本机已安装的 Chrome、Edge 或 Chromium（`DEFAULT_BROWSER_CHANNEL = "chrome"`），`MAX_LIVE_BROWSERS = 2`，按 `tenantId + botId` 隔离 profile（`browserIdentityOf`）；只复用了 `agent-computer/src/live-page.ts` 的 `chooseLivePage` 和 `aria-snapshot.ts` 的 `parseAriaSnapshot`/`cutAtCodeUnits` | **没有**复用 `agent-computer/src/browser-runtime.ts`（启动模式判定，已有 `local-chrome` 后端）、`profiles.ts`、`browser-eviction.ts`、`screencast.ts`、`virtual-display.ts` |
| 幂等与日志 | `runner/src/journal.ts`：`createActionJournal()`（bun:sqlite，`<state>.actions.sqlite`）；`dispatch.ts`：`createRunnerDispatcher()` | 重复投递的同一动作不会执行两次 |
| 工作目录 | `index.ts:35` `WORKSPACE_DIR = resolve(cwd, "runner-workspace")` | 跟着启动目录走。打包成应用后启动目录不固定，必须改 |

服务端：`server/src/devices/routes.ts` 的 `createDeviceRoutes` 负责配对码和设备列表，`createRunnerRoutes` 负责 register；`devices/socket.ts` 的 `runnerOpen`/`runnerMessage`/`runnerClose` 和 `devices/store.ts` 的 `authenticateDeviceToken`/`createDeviceStore` 负责鉴权与在线状态；下发在 `devices/channel.ts` 的 `createDeviceChannel`/`runnerAddress`，排队在 `devices/queue.ts`。网关在 `server/src/computer/gateway.ts:343` 用 `resolveDevice(botId)` 把动作改投到 runner。
测试已覆盖配对、重新配对、租户隔离、心跳和下发：`server/tests/devices.test.ts`、`runner-channel.test.ts`、`runner-dispatch.test.ts`、`runner-browser.test.ts`、`device-safety.integration.test.ts`、`app/tests/my-devices.test.tsx`。

### 1.2 Tauri 桌面应用（`openbot/desktop`）：用途完全不同的一个壳

- 它是"在自己电脑上自托管整套 OpenBot"的安装器和守护进程：`src-tauri/src/install.rs` 安装 Podman 和 Compose，`stack.rs` 拉起 Compose 服务（postgres、supervisor、agent-computer）以及 app、server、worker 三个宿主进程，`supervise.rs` 负责重启、退避和随窗口退出，`tray.rs` 是托盘，`host_access.rs` 是本机 host-access broker（原生审批对话框见 `desktop_host_access.rs`）。
- `src-tauri/tauri.conf.json` 里 `productName: "OpenBot"`，`identifier: "ai.copilotkit.openbot.desktop"`，`bundle.targets: ["dmg","nsis","appimage","deb","rpm"]`。`Cargo.toml` 只引入了 shell、single-instance、opener、dialog 四个插件，**没有 updater，也没有 autostart**。
- 签名：Windows 有 `scripts/sign-windows.ps1`（AzureSignTool）和 `verify-windows-signatures.ps1`，但 `signing/azure-federation.json` 的 subject 指向上游仓库 `CopilotKit/OpenBot` 的 `windows-signing` environment，**本仓库拿不到这个签名身份**。macOS 只验证过 ad-hoc 签名（`MACOS_MICROPHONE.md` 原文："does not verify Developer ID signing or notarization"）。
- 对 `desktop/` 做 `git grep runner`，只命中一个 CI 脚本里的英文单词，**桌面端与 runner 没有任何集成**。

### 1.3 agent-computer（`openbot/agent-computer`）：面向容器的服务端组件

- `src/index.ts` 是一个 HTTP 服务，跑在 `Dockerfile` 构建的容器里，依赖完整的 `playwright@1.62.1`（自带浏览器下载）和 `spiffe`（容器身份）。
- `src/screencast.ts` 的 `startScreencast()` 通过 CDP `Page.startScreencast` 把**实时画面推流**到 WebSocket，并转发鼠标键盘输入（用于人工接管）；`src/demonstration.ts` 的 `gestureForRecording()` 只记录手势种类。**仓库里没有任何代码把画面录成文件**（`git grep -i recordVideo` 无结果）。
- `src/virtual-display.ts` 的 `startVirtualDisplay()` 依赖 Xvfb，只适用于 Linux 容器。

---

## 2. 差距

| # | 故事要求 | 现状 | 差距 |
| --- | --- | --- | --- |
| G1 | 打包成 Tauri 客户端并能安装 | 只能在终端用 Bun 跑源码 | 需要独立二进制、安装包、开机自启和托盘；配对要能在图形界面里完成 |
| G2 | 复用 agent-computer | shell、文件、aria 快照和 live-page 已复用；浏览器启动与 profile 是 runner 自己写的 `playwright-core` 实现 | screencast（实时画面加接管）没有接到 runner；profile（`profiles.ts`）和驱逐（`browser-eviction.ts` 的 `chooseEvictions`，对应 runner 的 `MAX_LIVE_BROWSERS`）两边各有一套 |
| G3 | 录屏 | 不存在 | "录屏"指什么需要先定义（见 D1）。CDP 推流可以复用，落盘录制要新写 |
| G4 | machineId 是 UUID，并持久化在本机配置 | `hostname-xxxxxxxx`，默认放在启动目录下的 `runner-state.json`（可用 `--state` 改路径，但工作区 `WORKSPACE_DIR` 不能改） | 改 ID 格式会影响已配对设备；令牌应改用受保护存储 |
| G5 | 签名、公证、分发 | 没有可用的签名身份，没有 updater | 和发布决策绑定（D3、D4） |
| G6 | 多设备与命名 | 已实现并有测试 | 无 |

---

## 3. 方案

### 方案 A：Bun 编译成 sidecar，用一个新的轻量 Tauri 壳承载（推荐）

- 用 `bun build --compile` 把 `runner/src/index.ts` 编译成每个平台一个可执行文件，作为 Tauri `externalBin` sidecar。`bun:sqlite` 在编译产物里可以用。
- 新建一个独立的 Tauri 应用，例如 `openbot/runner-desktop/`（目录名待定），或者在 `desktop/` 里加第二个 bundle 配置（选哪个见 D2）。壳负责四件事：配对界面（输入配对码，或通过深链接 `openbot-runner://pair?code=` 自动填入）、托盘里显示在线和离线状态、开机自启（`tauri-plugin-autostart`）、用 `supervise.rs` 那一套模式守护 sidecar 进程。
- runner 需要改的地方：`WORKSPACE_DIR` 和状态文件路径改为平台应用数据目录（由壳通过参数或环境变量传入）；令牌改用受保护存储，可以照搬 `desktop/src-tauri/src/vault.rs` 的做法（macOS/Linux 用仅属主可读的文件，Windows 用 DPAPI；要不要换成系统钥匙串可以以后再定）；新设备的 `deviceIdFor` 生成纯 UUID，旧设备的 ID 保持不变。
- 浏览器继续用本机已装的 Chrome，不随包附带 Chromium（**待决策 D9**），安装包可以控制在大约 100MB 以内。
- 工作量：**M–L**。壳和 sidecar 约 1–1.5 周，三平台 CI 构建约 0.5 周，签名不计入（取决于 D3）。
- 风险：Bun 编译产物在 Windows 上会被 Defender 或 SmartScreen 误报，未签名时更严重；macOS 上 sidecar 也要单独签名；本机没装 Chrome 时浏览器动作不可用，需要在界面上明确提示。
- 依赖：runner 进入 CI（第 3 道门列出 runner 尚未进 CI）；WIN1 的 Windows 子进程树清理。

### 方案 B：把现有 `openbot/desktop` 扩展出"设备模式"

- 在现有应用里新增一个模式：不安装 Podman，也不拉起 stack，只守护 runner sidecar。
- 好处是复用现有的签名脚本、托盘、single-instance 和遥测（`desktop_telemetry.rs`）。
- 坏处：`stack.rs` 有 7910 行，`install.rs` 有 2725 行，两种模式共用一个安装包，安装体积、权限（Linux deb/rpm 依赖 `pkexec`）和 entitlements 都会按自托管模式的最大需求来；`identifier` 和产品名也很难同时适合两类用户。
- 工作量：**L**。风险：改动自托管路径时容易回归（`release_transaction.rs`、`deployment.rs` 的发布事务）。

### 方案 C：直接分发 runner 二进制，不用 Tauri

- 只交付 `bun build --compile` 产物，加上 Windows 服务 / launchd / systemd 的安装脚本，界面完全在 Web 端（My Devices 页面）。
- 工作量：**S–M**。但这**不满足**故事里"Tauri 客户端"的字面要求，没有托盘和本机审批对话框，非技术用户很难装好。只适合作为过渡或开发者通道。

### 录屏的子方案（无论选 A、B、C 都要定）

| 选项 | 实现 | 成本 |
| --- | --- | --- |
| R-a 只做实时画面和人工接管 | runner 调用 `agent-computer/src/screencast.ts` 的 `startScreencast`，帧通过现有 runner WebSocket 中转给 Web 端查看器 | M；需要在 `shared/` 增加帧类型，并评估带宽和背压；`screencast.ts` 的类型来自 `playwright`，runner 用的是 `playwright-core`，接入时要核对 `Page`/`CDPSession` 类型兼容 |
| R-b 每个任务一个回放 | 在 R-a 的基础上，把帧（JPEG 序列）按任务落盘到本机，或上传到服务端附件 | L；涉及存储配额、保留期和隐私（屏幕上可能有用户的其他信息） |
| R-c 整个桌面录屏 | 调用操作系统录屏 API | XL；需要系统权限弹窗，隐私风险最高，**不推荐** |

---

## 4. 待决策

| 编号 | 问题 | 选项 | 建议 |
| --- | --- | --- | --- |
| D1 | **待决策**："录屏"的含义 | R-a / R-b / R-c | v1.0 只做 R-a，R-b 放到 v1.0 之后 |
| D2 | **待决策**：做独立应用还是在现有 desktop 里加模式 | 方案 A / 方案 B | A |
| D3 | **待决策**：签名身份（Windows 代码签名证书、Apple Developer ID）由谁申请，密钥放在哪 | 自购 EV/OV 证书或 Azure Trusted Signing；Apple 组织账号 | 必须由人来办；上游的 `azure-federation.json` 不能用 |
| D4 | **已决定（2026-11-04）：先发未签名内测版**。首个收费版本是否要求安装包已签名并已公证 | 已签名才发布 / 先发未签名内测版 | 用户选"先发未签名内测版"。流水线保持现状：没签名只发成「未签名内测版」预发布，正式版必须签名；不设仓库变量 `DEVICE_RELEASE_REQUIRE_SIGNED`（`HUMAN-STEPS.md` 12.1） |
| D5 | **已决定（2026-11-04）：首发 Windows + Linux**。首发支持哪些平台 | Windows 和 macOS / 再加 Linux | 用户选 Windows + Linux，与第 7 道门一致；macOS 不在首发：不设仓库变量 `DEVICE_RELEASE_MACOS`，暂不需要 Apple 签名身份（`HUMAN-STEPS.md` 12.3） |
| D6 | 已决定（2026-11-04）：首版不做自动更新，新版从 Release 页重新下载安装；不引入 `tauri-plugin-updater`，不需要 updater 密钥 | 是否在首发就上 | 以后再议 |
| D7 | **待决策**：已配对设备的 ID 是否迁移成纯 UUID | 不迁移 / 强制重新配对 | 不迁移，只对新设备生效 |
| D8 | 已决定（2026-11-04）：产品名「熊宝数字员工 设备端」，identifier 定为 `com.xiongbao.device`（不再是占位） | 例如在 `examples/qoderwake/brand.yaml` 的 `product_name: 熊宝数字员工` 后加"设备端" | 首个签名版之后不再改（改了会破坏升级和开机自启） |
| D9 | **待决策**：是否随包附带 Chromium | 只用本机 Chrome/Edge / 附带 Chromium（体积约 +150MB） | 不附带；未检测到浏览器时在托盘和 My Devices 上提示 |

---

## 5. 推荐的分阶段计划（以方案 A 加 R-a 为前提）

### 阶段 0：runner 可打包（不碰 Tauri）
- 工作目录和状态路径可配置；令牌存储做成可替换的接口；新设备 ID 用 UUID；runner 测试进入 CI。
- 验收：
  1. 用 `--data-dir X` 启动时，所有文件只落在 `X` 下，启动目录里不产生任何文件。
  2. 新配对设备的 ID 匹配 UUID v4 格式；带旧格式 ID 的状态文件仍能正常连上。
  3. `bun build --compile` 的产物能在干净容器里连上测试服务端、完成配对、执行一次 `files.list`（新增一个 runner 包内测试）。

### 阶段 1：Tauri 壳与安装包（未签名）
- 新应用：配对界面、托盘状态、开机自启、守护 sidecar、退出时清理子进程。
- 验收：
  1. 在干净的 Windows 和 Linux 虚拟机上安装，输入配对码后 My Devices 页面显示该设备在线，并显示设备名。
  2. 杀掉 sidecar 后它会自动重启；连续崩溃 N 次后停止重启，并在托盘上显示错误。
  3. 退出应用后进程树里不再有 runner（对应 WIN1）。
  4. 重启电脑后自动上线，不需要重新配对。

### 阶段 2：实时画面与接管（R-a）
- 在 runner 浏览器中接入 `startScreencast`；Web 端复用现有查看器。
- 验收：
  1. Waker 在设备上打开页面时，Web 端能看到实时画面，帧延迟 P95 小于 1 秒（局域网条件下）。
  2. 人工接管期间，Waker 的动作会被网关拒绝，并且不会产生任何副作用。
  3. 其他租户订阅同一个 `deviceId` 的画面时被拒绝（租户隔离测试）。

### 阶段 3：签名、公证与发布（依赖 D3；D4、D5 已决定）
- 接入签名流水线，生成校验和，发布页可以下载。
- 验收：
  1. Windows 安装包通过 `verify-windows-signatures.ps1` 校验。
  2. macOS 包通过 `spctl --assess` 和 `stapler validate`（D5：macOS 不在首发，等 macOS 上线时再验）。
  3. 第 7 道门：两台干净机器的完整安装、配对、执行记录作为证据归档。

---

## 6. 不在本规格范围内

- F3 网关下发的正确性（缺陷 #12）、F4 离线排队、DEV1 结果不明时暂停：本规格只保证客户端能承载这些能力。
- 服务端 Docker 电脑降级（F6）。
