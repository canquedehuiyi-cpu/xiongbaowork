# 设备端桌面操控第 2 期（接入 agent-desktop、写动作、三平台）实施计划

> **给执行代理：** 必须配合以下子技能之一使用：superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。按任务逐个实施，步骤用复选框（`- [ ]`）跟踪。

**目标**：在第 1 期（只读、仅 Windows）之下换上 agent-desktop v1.2.0，让员工在主人的 macOS（随后 Windows）电脑上读界面并动手（点击、输入、按键、切换、启动、等待、剪贴板），Linux 只读（试用）；动作发出之前，由我们自己的会话审批、提示条、停止键、动鼠标即停、逐次审批和审计全部拦一遍。

**架构**：
- 设备端（Tauri，`openbot/desktop-device`）：多带一个随附程序 `agent-desktop`（macOS 再带它的剪贴板助手）；新增「桌面操作」卡片、置顶提示条、Ctrl+Alt+Esc 停止键、每 250 ms 的光标检测；通过 runner 的 stdin/stdout 与 runner 交换控制行。
- runner（`openbot/runner/src/desktop/`）：新的 agent-desktop 适配层（调用层、快照转换与严格编号、写动作、会话、控制通道），旧的 PowerShell 读取器留在 Windows 上作默认（PR-10 前）和回退（PR-10 后一个版本）。
- 服务器（`openbot/server/src/computer/`、`approvals/`）：桌面会话（短期令牌，设备端为准）、写动作网关、两条新底线（`desktop_session`、`desktop_action`）、团队敏感词表、权限页「操作桌面」。
- 协议常量、文案、按键分类、敏感词默认表放在 runner 与服务器共用的 `openbot/shared/desktop-control.ts`。

**技术栈**：Bun + TypeScript（runner、server、shared、app）；Rust + Tauri 2（设备端，唯一新增 crate 见全局约束）；agent-desktop v1.2.0 官方发布包（Apache-2.0，Rust 单文件 CLI）；GitHub Actions。

**设计文档**：`docs/specs/2026-11-12-desktop-write-agent-desktop.md`（2026-11-12 用户同意，§11 七问全部按建议执行）。上游：第 1 期计划 `docs/plans/2026-11-08-desktop-control.md`。

## 全局约束

- **安全底线不动**：`approvals/policy.ts` 只做扩展（新增底线来源 `desktop_session`、`desktop_action`；有效桌面会话只替代「改动前先问」这一默认，见设计决定 6），不改已有规则、底线、拒绝的顺序和含义；RLS、审计、凭据只进保管库、管理员闸门都不变。
- **只限主人本人**，与第 1 期相同：工具层不提供（`localAppsAllowed`），网关再拒一次（`ownersMachine`）。所有新工具同此。
- 不跳过、不放宽任何已有测试；行为按规格有意改变的旧断言，只能换成同样严格的新断言（设计决定 19 列出了全部这类改动）。新增的服务器测试文件用 `cd openbot && bun scripts/ci/server-shards.mjs --write` 登记进 `scripts/ci/server-tests.list.txt`；用到数据库的测试在 `afterAll` 里关闭连接池。
- **许可**：不引入任何 AGPL / GPL / LGPL / SSPL 组件；agent-desktop 锁定 v1.2.0（上游提交 `2b0a7334fc111730454b726e6800aa41cdafc093`），构建时核对压缩包和解出的每个可执行文件的 SHA-256，对不上就构建失败；不改它的源码。
- **agent-desktop 的调用方式**：只走 CLI，从不用 `mcp`；从不传 `--trace`、`--trace-strict`、`--session`、`--screenshots`、`--cdp`、`--no-attach`、`--arg`、`--env`、`--agent-id`；`--force` 只用于审批过的关闭类按键（设计决定 10）；需要文字的命令一律走 `--stdin`，文字不进进程参数。状态目录 `AGENT_DESKTOP_HOME` 设为 runner 数据目录下的 `agent-desktop-state/`（0700），runner 启动时、关闭时、闲置 `600_000` ms 时整个清空。
- **新依赖**：除 Task 15 的 `tauri-plugin-global-shortcut`（MIT OR Apache-2.0）外，不新增 npm 包或 Rust crate，不改 `bun.lock`；`Cargo.lock` 只在 Task 15 改。
- **每个 PR 最多改 8 个文件**（含测试和清单），按下文「PR 分组」依次合入 `main`。
- 面向用户的文案（报错、审批理由、卡片、权限页、提示条）用中文，照规格 §3、§5、§7、§8 和本计划设计决定 13；工具说明（给模型看的）沿用英文。`app/src`、`server/src` 里不写死产品名（品牌护栏 `app/tests/brand-leak.test.ts`），设备端界面沿用 Tauri 配置里的产品名常量。
- 平台下限：macOS 13（`bundle.macOS.minimumSystemVersion: "13.0"`）；Windows 10 1809；Linux 只保证 Ubuntu 24.04 + X11，Wayland 不保证。Linux 不做任何写动作。
- 数值（写进 `shared/desktop-control.ts` 的 `DESKTOP_LIMITS`）：沿用第 1 期全部数值；新增单条命令超时 `adCommandTimeoutMs: 20_000`、快照 `--timeout-ms 10000`（`adSnapshotTimeoutMs`）、状态目录闲置清空 `adIdleWipeMs: 600_000`、runner 记住的窗口编号 `windowIdsKept: 200`、写入文字上限 `textMaxBytes: 9_000`（UTF-8 字节）、读剪贴板返回上限 `clipboardReadMaxChars: 8_000`、`waitMaxSec: 30`、会话闲置 `sessionIdleMs: 900_000`、会话总长 `sessionMaxMs: 3_600_000`、真实输入前等设备端确认 `headedAckMs: 1_000`、光标检测间隔 `mousePollMs: 250`、光标移动阈值 `mouseMovePx: 3`。
- **只有用户能做的事是单独的任务，标「需要用户」**：Task 5（Apple 证书与公证凭据）、Task 27（macOS / Linux / 多显示器真机验收）、Task 29（Windows 真机验收）。**Task 30（Windows 默认切换）只在用户报告 Task 29 通过之后开始。**
- 审计：每个桌面动作一行，带窗口标题、程序、控件类型和名称、动作、按键组合、是否用了真实鼠标键盘、结果、耗时；**输入文字和剪贴板内容只记长度**；截图不保存。

## 审查重点

1. **提示条抢前台**：显示或更新提示条时，如果它拿到焦点，`press` 会发到提示条或设备端自己的窗口，`--headed` 点击也会先切走目标窗口。提示条窗口一律不可聚焦、忽略鼠标、不进任务栏；按键之前设备端用 `list-windows` 当场确认目标是前台，不是就拒绝，不替模型切换。（Task 14 测窗口参数；Task 21 测「不在前台」拒绝；Task 27、29 真机验。）
2. **跨副本缺状态时只能多问，不能漏问**：服务器有多个副本，会话令牌和「编号 → 控件名」缓存可能在另一个副本上。缺会话时向设备查（设备为准）；缺控件名时按「没能确认要操作的控件」要求审批；设备端再用同一份敏感词核对一遍，没有 `approved` 的敏感动作直接拒绝。（Task 16、17、21、22 有测试。）
3. **写到一半超时或被叫停**：结果一律标「结果未知」，不自动重试，避免重复发送、重复付款。只有 agent-desktop 明确回 `not_delivered`（`disposition.retry` 为 `safe`）的无头失败，才允许在会话内改用 `--headed` 再试一次；其它失败一次都不重试。（Task 7、21 有测试。）
4. **重新签名后的随附程序**：签名会改变可执行文件的字节，所以上游 SHA-256 只在构建时核对，运行时只核对 `version`；macOS 剪贴板助手必须和 `agent-desktop` 同目录、同名、无组写权限，否则剪贴板失败。（Task 2、4 核对；Task 27 真机验。）
5. **中文、换行和长文字**：中文、emoji、`\r\n` 必须原样经 `--stdin` 送到，超过 `9_000` 字节在服务器就拒绝；单行输入框收到带换行的文字算「提交」要审批；输入法开着时的真实键盘输入交给真机验收。（Task 17、21 有测试；Task 29 第 4 步。）

## 设计决定与规格缺口

规格没写死、或照字面做会出问题的地方，本计划这样定（执行时照此实现，评审时请确认）：

1. **已核实的 agent-desktop v1.2.0 事实**（离线核对 npm 包 `agent-desktop@1.2.0` 及其内嵌文档，npm 带 SLSA 来源证明）：
   - 发布包名为 `agent-desktop-v1.2.0-<目标三元组>.tar.gz`，同目录有 `checksums.txt`。官方包覆盖六个目标：`aarch64-apple-darwin`、`x86_64-apple-darwin`、`x86_64-unknown-linux-gnu`、`aarch64-unknown-linux-gnu`、`x86_64-pc-windows-msvc`、`aarch64-pc-windows-msvc`。规格 §6 的「待核实」由此关闭：Intel Mac、Windows ARM、Linux ARM 都有官方包；本计划不新增发布架构，只让下载脚本认这六个。
   - 压缩包内容：macOS 为 `agent-desktop` 加 `agent-desktop-macos-helper`（剪贴板助手，必须和 CLI 在同一目录）；Linux 为 `agent-desktop` 加 `agent-desktop-linux-clipboard-owner`；Windows 只有 `agent-desktop.exe`。
   - 命令：`snapshot`（`--window-id`、`--max-depth`、`--compact`、`-i`、`--root`、`--timeout-ms`、`--wait-for`、`--wait-timeout`）、`click`、`type`、`set-value`、`clear`、`press`、`focus-window`、`launch`、`list-windows`（`{id,title,app_name,pid,bounds,is_focused,accessible}`）、`list-displays`（`{id,bounds,is_primary,scale}`）、`screenshot`、`clipboard-get`、`clipboard-set`、`permissions`、`status`、`version`。全局参数 `--headed` 写在命令之前。
   - 输出：每条命令只打印一个 JSON 信封，形如 `{version, ok, command, data | error}`；退出码 0 成功、1 结构化错误、2 参数错误。错误带 `code`、`details`、`disposition.{delivery,retry}`。错误码有 `STALE_REF`、`WINDOW_NOT_FOUND`、`SNAPSHOT_NOT_FOUND`、`POLICY_DENIED`、`AMBIGUOUS_TARGET`、`PERM_DENIED`、`ACTION_FAILED`、`ACTION_NOT_SUPPORTED`、`ELEMENT_NOT_FOUND`、`APP_NOT_FOUND`、`APP_UNRESPONSIVE`、`TIMEOUT`、`INVALID_ARGS`、`PLATFORM_NOT_SUPPORTED`、`INTERNAL`。
   - 状态根目录默认 `~/.agent-desktop`，由 `AGENT_DESKTOP_HOME`（必须是绝对路径、私有目录）改位置。快照的 refmap 记着控件的角色、名称和描述，**所以状态目录里确实有控件文字**，按全局约束放进私有目录并清空。不建会话就没有 trace。
   - Windows 上：`type`、`focus`（控件）、`right-click` 无头会回 `POLICY_DENIED`，`set-value` 无头可用；`press` 在所有平台都是真实键盘输入，只发给前台窗口；`alt+f4`、`win+l`、`win+d`、`alt+tab`、`win+r`、`win+x`、`win+e`、`ctrl+shift+esc` 不带 `--force` 就被拒；写高完整性级别的窗口会回 `PERM_DENIED`，详情含 `E_ACCESSDENIED`。macOS 上：`cmd+q` 等退出键不带 `--force` 被拒。
   - 离线拿不到的值（六个压缩包的 SHA-256、各平台快照的实际 JSON、密码框标记、单行输入框的角色名、`focus-window` 在 Windows 上是否需要 `--headed`、`screenshot` 的返回字段）由 **Task 1** 在 CI 上抓取并记录。后文写「Task 1 记录的值」的地方，执行时一律用那份记录，不要猜。
2. **解出的可执行文件 SHA-256**（来自 npm 包，Task 1 核对它们与 GitHub 压缩包里的一致）：
   - `aarch64-apple-darwin`：`agent-desktop` `dec75e0bba0d1f9b589bdb88188770ad1a199cde9e02cf0a5b94175491f738e9`；`agent-desktop-macos-helper` `4a795a40ba7fc93b726b0834342f0225779c30d83e28f1f219db479860c38a78`。
   - `x86_64-apple-darwin`：`5dae755fee4af37d1a245f058139b262d358352cce15aeb49d0100ff46b12156`；助手 `bdf060658b93f326efa06ac24d521e88025bf88109cecc257fa7fa40e65801cd`。
   - `x86_64-unknown-linux-gnu`：`da52a1eb2152cdc21b756ab20e6208d242da8062c73cd20bc8a8ae2a0384392c`；`agent-desktop-linux-clipboard-owner` `3e96f92b805c0d1f9de309935d62f4189b8e11e1385ad022bb878487bb3942ec`。
   - `aarch64-unknown-linux-gnu`：`915de59a8b3d22c9ad33023740bbcc5fe0b4fa830de9587bbf761237eafeb76f`；剪贴板助手 `a6bfde6778dadcf9fd04ba94de17cdf205eb0b23b643c3f34073d264d2117cc3`。
   - `x86_64-pc-windows-msvc`：`agent-desktop.exe` `d274667031322e50b9c2b1ab81c2ca46835d52cc932769a5c34bd4d481fd94c3`。
   - `aarch64-pc-windows-msvc`：`f1577d9f8cb6c9b1e767584fed96c72fbe1591fefbd67100965607d1a337a2fb`。
3. **随附哪些文件**：三个平台都带 `agent-desktop`；macOS 另带 `agent-desktop-macos-helper`（剪贴板要用）；Linux 不带剪贴板助手，因为 Linux 只读，不用剪贴板。安装后的名字沿用上游的 `agent-desktop`，不加品牌前缀：macOS 剪贴板助手按固定的名字和位置去找 CLI，改名就找不到。
4. **macOS 签名流水线已经在了**：`device-release.yml` 的 `macos` job 已有 Developer ID 签名和公证（`DEVICE_MACOS_SIGNING=developer-id`，缺凭据时只做临时签名），规格 §6 说的「S7 还没做」已经过时。所以 PR-2 只做两件事：让新程序被签名、被核对（Task 4），以及由用户配凭据（Task 5）。Tauri 会给所有 `externalBin` 用同一份 `Entitlements.plist`，所以 agent-desktop 也会带上 runner 需要的三项 JIT 例外。这是多给了，但 Tauri 不能按文件分开配；本计划接受，并让核对脚本把它实际带的权限记进证据。
5. **桌面会话以设备端为准**。服务器在审批通过后生成令牌（`randomBytes(32)` 的十六进制），用 `desktop.session_start` 交给设备端，每个写动作都带上它。设备端只认自己当前那一个会话，自己管 15 分钟闲置、60 分钟总长和叫停。服务器各副本只在内存里缓存令牌；缓存缺失时先用 `desktop.session_status` 问设备，设备说没有就重新审批。所以不需要数据库迁移，多副本也不会漏问。同一台设备同时只有一个会话；开新会话会结束旧的。
6. **会话内的写动作怎样不再逐个问**：网关给写动作的 `subject.desktopWrite.session` 填 `"active"` 或 `"none"`（只来自服务器自己的会话状态，从不来自模型参数）：
   - `"none"`：底线 `desktop_session` 把动作抬成询问，卡片只给「允许一次 / 拒绝」。批准后网关先开会话，再执行这一步。
   - `"active"`：只当规则层的结论来自「改动前先问」这一默认（`source: "default"`）时，改为放行，来源记 `desktop_session`。团队、主人或本人明确设的「询问」照样问；逐次审批的底线照样抬高。
   - 一个动作既要开会话、又命中逐次审批时，只出一张卡，来源记 `desktop_action`，理由把两句接起来。
7. **权限页「操作桌面」**：这一行的 toolRef 是 `computer_desktop_session`，只提供「询问 / 禁用」两个选项。选「直接」由服务器拒绝，因为会话审批是底线，任何设置都不能跳过它。「禁用」时所有写工具都不提供，硬调也在网关被拒。读工具「列出桌面窗口」「查看桌面」照旧。规格说的「Linux 标试用」落在两处：权限页桌面这几行下方加一行提示「Linux 电脑目前只能查看（试用）。」；读工具的说明里也写明。
8. **窗口编号**：agent-desktop 的窗口编号在各平台形状不同（`w-4521`，或 Linux 上 34～70 个字符的不透明地址），所以 runner 另发自己的编号 `a` + 16 位十六进制，取 `sha256(进程前缀 + 窗口编号 + pid)` 的前 16 位。runner 在内存里记最近 `200` 个，runner 重启后旧编号全部作废。`DESKTOP_WINDOW_ID` 同时接受第 1 期的旧形状，旧读取器照旧可用。控件编号沿用第 1 期的 `六位前缀-序号:下标`。
9. **真实鼠标键盘（`--headed`）和「动鼠标即停」怎么配合**：
   - runner 在每个 `--headed` 动作之前，先往 stdout 写 `headed-begin`，等设备端在 stdin 回 `headed-ack`（最多 `1_000` ms）才执行；动作结束写 `headed-end`。
   - 设备端收到 `headed-begin` 就暂停光标检测，提示条加上「正在移动鼠标」；收到 `headed-end` 后以当前光标位置为新起点，恢复检测。
   - 等不到确认就不执行，报「设备端没有确认暂停『动鼠标即停』，为安全起见没有执行这一步。」
   - `press` 是键盘输入，不动光标，所以按键期间检测不暂停，但审计照记「真实键盘」。
   - runner 不是由设备端应用启动的（没有 `--desktop-control stdio`）时，一切写动作都拒绝：没有提示条和停止键，就不能动手。
10. **按键分类**（`shared/desktop-control.ts` 的 `classifyDesktopKeys`，服务器和设备端用同一份）：
    - **系统键**：`win+r`、`win+l`、`win+d`、`win+x`、`win+e`、`alt+tab`、`ctrl+shift+esc`、`ctrl+alt+delete`、`cmd+space`、`ctrl+cmd+q`、`cmd+shift+q`、`cmd+alt+shift+q`，以及它们加了修饰键的超集。一律拒绝，不给审批。
    - **关闭类**：`alt+f4`、`ctrl+f4`、`cmd+q`、`cmd+w`、`ctrl+w`。算「删除」类，逐次审批；其中 `alt+f4` 和 `cmd+q` 批准后才带 `--force` 发出，`--force` 只用在这两个键上。
    - **提交类**：`enter`（`return`），不带修饰键，或者带 `ctrl`、`cmd`、`alt`。逐次审批。只带 `shift` 的 Enter 是换行，不算提交。
    - 其它算普通按键。
    - 语法：小写，`+` 连接，最多 3 个修饰键（`ctrl`、`alt`、`shift`、`cmd`、`win`；`meta`、`super` 视同 `win`）加 1 个键。实际发给 agent-desktop 的键名按 Task 1 记录的 `press --help` 列表转换。
11. **敏感词怎样匹配**（窗口标题、控件名）：中文词按子串匹配；纯 ASCII 词按整词匹配，不分大小写（`\bpay\b`，所以 `Display` 不命中）。窗口标题沿用第 1 期的 `DESKTOP_WINDOW_WORDS`。控件动作词的默认表照规格 §3：发送、删除、付款、支付、提交、确认支付、转账、购买、下单、发布、撤回、注销、send、delete、pay、submit、purchase。团队表存在 `approval_team_settings.desktop_action_words`（`text[]`，为空表示用默认表），由管理员在「审批」团队设置里改。
12. **输入的实现顺序**：
    - `mode: "replace"`：先 `set-value --stdin`。只有回 `not_delivered` 时（例如不支持或策略拒绝），才 `clear` 后 `--headed type --stdin`。
    - `mode: "append"`：先无头 `type --stdin`（macOS 可以）。回 `not_delivered` 时改用 `--headed type --stdin`（Windows 会走到这一步）。
    - 目标是密码框时，一律拒绝。
    - 输入之后这个窗口的编号全部作废（规格 §4 第 5 条）。
13. **规格没有的文案**（照抄）：
    - `unsupported_platform`：「这台设备的系统不支持桌面操作。」
    - `mac_permission`：「这台 Mac 还没有允许设备端操作界面，请在设备端的『桌面操作』里开启。」（规格原文含产品名，这里改用「设备端」，理由见全局约束的品牌一条。）
    - `linux_bus`：「这台 Linux 电脑没有开启无障碍总线（AT-SPI），看不到窗口。请在系统设置里打开辅助功能后重新登录。」
    - `read_only_windows`（PR-10 之前的 Windows）：「这台 Windows 电脑暂时只能查看，操作界面的功能还在验收。」
    - `session_expired`：「桌面会话已结束（15 分钟没有操作或已满 60 分钟），需要重新获得授权。」
    - `password_field`：「这是密码框，员工不能往里输入。请用 computer_request_secret 让主人自己输入。」
    - `system_keys`：「这个组合键（<keys>）是系统级的，员工不能按。」
    - `not_foreground`：「这个窗口不在前台，请先用 computer_desktop_focus 把它切到前台。」
    - `needs_approval`：「这一步需要先获得批准（<原因>）。请重新读取窗口后再试。」
    - `no_control_channel`：「只有在设备端应用里运行时才能操作桌面（需要提示条和停止键）。」
    - `headed_unconfirmed`：照设计决定 9。
    - `not_actionable`：「这个控件不能直接操作，请换一个控件或用快捷键。」
    - 规格 §8 已有的文案照原样用：`policy_denied`、`ambiguous`、`read_only_linux`、`stopped`、`outcome_unknown`、`elevated`、`stale`、`no_window`。
    - 审批理由（`desktopActionReason`）：
      - 开会话：「员工要开始操作你的电脑（最长 60 分钟，15 分钟没有操作自动结束），必要时会移动你的鼠标。屏幕顶部会显示提示条，按 Ctrl+Alt+Esc（Mac 上 ⌃⌥⎋）或移动鼠标即可停止。」
      - 点击：「在窗口「<标题>」里点击「<控件名>」：控件名含「<词>」，需要你批准。」
      - 敏感窗口：「窗口「<标题>」的标题含「<词>」，在里面<动作>需要你批准。」
      - 提交键：「在窗口「<标题>」里按 <keys>，可能会把内容提交或发送出去，需要你批准。」
      - 关闭键：「在窗口「<标题>」里按 <keys>，会关闭程序，需要你批准。」
      - 单行加换行：「往窗口「<标题>」的单行输入框「<控件名>」里输入带换行的文字，相当于提交，需要你批准。」
      - 读剪贴板：「读取你的剪贴板（里面可能有刚复制的密码或验证码），需要你批准。」
      - 控件不明：「没能确认要操作的控件，在窗口「<标题>」里执行前需要你批准。」
14. **审批被拒**：沿用现有的「本人拒绝」结果（`shared/approval-outcomes.ts`），它已经告诉模型「不要再试这个动作或等价的动作」。规格 §8 的「主人没有同意这一步。」不另加。
15. **截图缩放**：agent-desktop 的 `screenshot` 没有缩放参数，所以 runner 自己缩。新文件 `png-scale.ts` 只用 `node:zlib`：只处理 8 位 RGB / RGBA 的 PNG，用盒式滤波缩到长边 ≤ `1280`。其它格式不附图，`imageError` 写「这张截图的格式无法缩小，没有附上。」
16. **Windows 引擎开关**：
    - runner 参数 `--desktop-engine legacy|agent-desktop`，对应环境变量 `OPENBOT_DESKTOP_ENGINE`；现有的别名机制让 `XIONGBAO_DESKTOP_ENGINE` 同样生效。
    - 设备端应用启动时读 `XIONGBAO_DESKTOP_ENGINE`，原样传给 runner。用户真机对比时按 Task 29 的步骤用 `setx` 设置。
    - win32 的默认值：PR-10 之前是 `legacy`，之后是 `agent-desktop`；`legacy` 再保留一个版本。
    - macOS 和 Linux 只有 `agent-desktop`；其它系统回 `unsupported_platform`。
17. **在服务器提前拒绝，免得白弹一张卡**：网关在审批之前先问 `desktop.session_status`，它回 `{ writable, reason?, platform, session? }`。Linux、PR-10 之前的 Windows、没有控制通道的 runner、未授权的 Mac，都由这一步直接拒绝，不弹会话审批。团队上限为 `never`、「操作桌面」为禁用时，网关连设备都不问。
18. **结果未知**：写动作超时、被叫停、或 agent-desktop 回的 `delivery` 不是 `not_delivered` 的失败，runner 返回 `outcomeUnknown: true` 和 `outcome_unknown` 文案，沿用现有的结果未知处理，和浏览器写动作一样。读动作（包括 `wait`）从不 `outcomeUnknown`。
19. **按规格有意改动的旧断言**（不是放宽）：
    - `runner/tests/desktop-actions.test.ts` 的「非 Windows 一律 not_windows」：改为 `platform: "freebsd"` 时回 `unsupported_platform`，并且什么都不启动。Linux 和 macOS 现在可以读，由新测试覆盖。
    - `shared/desktop-control.test.ts` 的「只有两个读动作」：改为下文每个任务给出的完整动作集合，仍然是精确相等。
    - 读工具说明里的「Windows」改成三平台的说法。
20. **CI 的前提**：
    - macOS 探针假定 `macos-latest` 已预授权辅助功能（spike 第 1～4 轮都是 granted）。
    - Linux 探针用 `xvfb-run` + `dbus-run-session` + openbox + AT-SPI + gedit，与 spike 相同。
    - 探针报告没有授权或没有总线时，**停下来报告给用户**，不能改成跳过。
    - 提权窗口、多显示器、输入法、真实提示条和停止键都测不了，交给真机验收。

## 共享文件与插入点

| 共享文件 | 本计划的插入（Task） |
|---|---|
| `openbot/shared/desktop-control.ts` | 新常量、文案、按键分类、敏感词（Task 6、13、17、21、24），不删第 1 期导出 |
| `openbot/runner/src/execute.ts` | 无改动：`extras.desktop` 已有，由 `actions.ts` 内部选择引擎 |
| `openbot/runner/src/index.ts` | 参数 `--desktop-helper`、`--desktop-engine`（Task 9），`--desktop-control`、心跳字段 `desktopStopped`（Task 13） |
| `openbot/server/src/computer/gateway.ts` | 接口加写方法、`intentOf` 加 case、`desktopRow` 加写字段、展开 `createDesktopWriteMethods`（Task 16、22、25） |
| `openbot/server/src/approvals/policy.ts` | `floor` 链尾加 `?? desktopSessionFloor ?? desktopActionFloor`；会话替代默认（Task 16）；团队上限认桌面写动作（Task 17） |
| `openbot/server/src/approvals/types.ts` | `ApprovalSubject.desktopWrite`、`source` 加两项（Task 16、17） |
| `openbot/server/src/devices/socket.ts` | 心跳的 `desktopStopped` 交给注入的回调（Task 16） |
| `openbot/desktop-device/src-tauri/src/{main,sidecar,supervise}.rs` | Task 9、11、14、15 |
| `.github/workflows/ci.yml`、`device-release.yml` | 取 agent-desktop（Task 2）、许可 job（Task 3）、三平台探针 job（Task 10） |

## PR 分组

| PR | 任务 | 标题 | 文件数 |
|---|---|---|---|
| PR-1a | Task 1 | `设备端：记录 agent-desktop v1.2.0 的锁定值与样本` | ≤ 8 |
| PR-1b | Task 2 | `设备端：构建时下载并核对 agent-desktop，放进安装包` | 8 |
| PR-1c | Task 3 | `设备端：agent-desktop 第三方许可清单与许可证检查` | ≤ 7 |
| PR-2 | Task 4 | `设备端：签名与核对覆盖 agent-desktop；macOS 13 起` | ≤ 6 |
| — | Task 5 | 「需要用户」配置 Apple 凭据 | 0 |
| PR-3a | Task 6–7 | `runner：agent-desktop 调用层与共享协议` | ≤ 7 |
| PR-3b | Task 8 | `runner：快照转换、严格编号、截图缩放` | ≤ 6 |
| PR-3c | Task 9 | `runner/设备端：按平台选引擎，macOS 与 Linux 开放查看` | ≤ 7 |
| PR-3d | Task 10 | `CI：三平台桌面探针` | ≤ 4 |
| PR-4 | Task 11–12 | `设备端：「桌面操作」权限卡片、关于与第三方许可` | ≤ 8 |
| PR-5a | Task 13 | `runner：桌面会话与控制通道` | ≤ 7 |
| PR-5b | Task 14 | `设备端：提示条与控制通道` | ≤ 7 |
| PR-5c | Task 15 | `设备端：停止键与动鼠标即停` | ≤ 5 |
| PR-5d | Task 16 | `服务器：桌面会话审批与令牌` | ≤ 8 |
| PR-6a | Task 17 | `审批：桌面逐次审批、按键分类、团队上限` | 7 |
| PR-6b | Task 18 | `数据库：团队桌面敏感词表` | ≤ 6 |
| PR-6c | Task 19 | `服务器/管理页：团队桌面敏感词表` | ≤ 6 |
| PR-6d | Task 20 | `权限页：操作桌面；审批来源标签` | 7 |
| PR-7a | Task 21 | `runner：点击、输入、按键、切换窗口` | ≤ 6 |
| PR-7b | Task 22 | `服务器：桌面写动作网关与审计` | ≤ 7 |
| PR-7c | Task 23 | `服务器：四个桌面写工具；三平台探针写动作` | ≤ 6 |
| PR-8a | Task 24 | `runner：等待、启动、剪贴板、多显示器` | ≤ 5 |
| PR-8b | Task 25 | `服务器：等待、启动、剪贴板工具` | ≤ 7 |
| PR-8c | Task 26 | `发版：macOS 操作桌面、Linux 查看（试用）` | ≤ 7 |
| — | Task 27 | 「需要用户」macOS / Linux / 多显示器真机验收 | 1 |
| PR-9 | Task 28 | `runner：Windows 引擎开关下的写动作与引擎对比` | ≤ 6 |
| — | Task 29 | 「需要用户」Windows 真机验收 | 1 |
| PR-10a | Task 30 | `Windows 默认改用 agent-desktop；发版`（等用户报告 Task 29 通过） | ≤ 7 |
| PR-10b | Task 31 | `删除旧 PowerShell 读取器`（再下一个版本） | ≤ 8 |

依赖：1 → 2 → 3、4；2 → 6 → 7 → 8 → 9 → 10；9 → 11；13 → 14 → 15；16 依赖 13 的动作名；17 → 18 → 19；16、17 → 22；21 → 22 → 23 → 24 → 25 → 26 → 27；23 → 28 → 29 → 30 → 31。Task 12、20 可以随时合。

---

## PR-1：打包

### Task 1：核实 agent-desktop v1.2.0，记录锁定值与样本

GitHub 发布页在离线环境里取不到，所以本任务在 CI 上跑一次，只为抓数。这个工作流只在分支 `spike/agent-desktop-capture` 上运行，**不合入**；合入的只是它产出的锁文件和样本。

**文件：**
- 新建：`openbot/desktop-device/agent-desktop.lock.json`
- 新建：`openbot/runner/tests/fixtures/agent-desktop/{macos,windows,linux}-{list-windows,snapshot,snapshot-password,list-displays,screenshot,version,permissions,status}.json`。这些是真实输出；标题以外的个人信息替换成「熊宝员工」，图片只留 1×1 的 PNG。
- 新建：`openbot/runner/tests/fixtures/agent-desktop/errors.json`：`STALE_REF`、`WINDOW_NOT_FOUND`、`SNAPSHOT_NOT_FOUND`、`POLICY_DENIED`、`AMBIGUOUS_TARGET`、`PERM_DENIED`（Windows 提权测不到，用文档原文构造并注明）的真实信封各一份。
- 新建：`openbot/runner/tests/fixtures/agent-desktop/FACTS.md`：逐条记录下面 Step 2 的答案，以及每条答案的来源运行链接。
- 临时（只在 spike 分支上）：`.github/workflows/spike-agent-desktop-capture.yml`。以 spike 的 `.github/workflows/spike-agent-desktop.yml`（`origin/spike/agent-desktop`）为底稿。

**接口：**
- 产出：锁文件的形状，Task 2 读：
  ```json
  { "version": "1.2.0", "commit": "2b0a7334fc111730454b726e6800aa41cdafc093",
    "targets": { "<triple>": { "archive": "agent-desktop-v1.2.0-<triple>.tar.gz", "archiveSha256": "<64 hex>",
      "entries": [ { "name": "agent-desktop", "sha256": "<64 hex>" }, { "name": "agent-desktop-macos-helper", "sha256": "…" } ] } } }
  ```
  六个目标都填；`entries` 照设计决定 1、2（Windows 的名字是 `agent-desktop.exe`）。
- 产出：`FACTS.md` 必须回答以下问题，后续任务按「Task 1 记录的值」引用：
  - (a) 密码框在快照里的标记：三平台各自的角色或状态，以及值是否已被打码；
  - (b) 单行输入框的角色名，以及多行的角色名；
  - (c) `disabled` 在 `states` 里的写法；
  - (d) `focus-window` 在 Windows 无头时是否回 `POLICY_DENIED`；
  - (e) `screenshot --window-id X`（不给路径）返回的字段名；
  - (f) `version` 的 `data` 形状；
  - (g) `press --help` 的键名表；
  - (h) 没有建会话时状态目录里会出现哪些文件，其中是否含控件名，有没有 `trace` 目录；
  - (i) 关窗之后用旧编号写，各平台回的错误码；
  - (j) `list-windows` 能否用 `--window-id` 和 `pid` 唯一定位窗口；
  - (k) Linux 上 AT-SPI 没开时 `status` 的输出。

- [ ] **Step 1：写抓取工作流**。matrix 同 spike（windows-latest / macos-latest / ubuntu-latest + xvfb + openbox + at-spi + gedit）。每个平台：
  1. 用 `curl -fsSL` 下载本平台的压缩包和 `checksums.txt`。
  2. 在日志里打印：压缩包的 `sha256sum`、`checksums.txt` 里对应的行、`tar -tzf` 的条目清单、解出的每个文件的 `sha256sum`。
  3. 另外五个目标只下载并打印压缩包和条目的 SHA-256，不解出运行。
  4. 再跑 FACTS 各项要用的命令，把输出存成 artifact，同时打印到日志。
  - 密码框：Windows 用 PowerShell 打开一个 WinForms `TextBox`（`UseSystemPasswordChar = $true`）；macOS 用 `osascript -e 'display dialog "x" default answer "" with hidden answer'`；Linux 用 `zenity --password`。
- [ ] **Step 2：推送 spike 分支并跑一次**。核对两件事：
  - 每个平台日志里，压缩包的 SHA-256 等于 `checksums.txt` 里对应的值；
  - 解出的可执行文件的 SHA-256 等于设计决定 2 里的值。
  任何一项对不上就**停下来报告用户**，不往下做。
- [ ] **Step 3：写锁文件、样本和 `FACTS.md`**（值全部来自 Step 2 的日志）。
- [ ] **Step 4：在本地检查**：`cd openbot && jq -e '.targets | length == 6' desktop-device/agent-desktop.lock.json`，以及 `jq -e '[.targets[].archiveSha256 | test("^[0-9a-f]{64}$")] | all' desktop-device/agent-desktop.lock.json`，两条都应输出 `true`。
- [ ] **Step 5：提交并开 PR-1a**，提交信息为 `设备端：记录 agent-desktop v1.2.0 的锁定值与三平台样本`。spike 分支保留，不合入，由协调者关闭。

### Task 2：构建时下载、核对，放进安装包

**文件：**
- 新建：`openbot/desktop-device/scripts/fetch-agent-desktop.ts`
- 测试：`openbot/desktop-device/tests/fetch-agent-desktop.test.ts`
- 修改：`openbot/desktop-device/src-tauri/tauri.bundle.conf.json`：`externalBin` 改为 `["binaries/xiongbao-runner", "binaries/agent-desktop"]`。
- 新建：`openbot/desktop-device/src-tauri/tauri.agent-desktop-macos.conf.json`：`bundle.externalBin` 为 `["binaries/xiongbao-runner", "binaries/agent-desktop", "binaries/agent-desktop-macos-helper"]`。macOS 构建时作为第二个 `--config` 叠在 `tauri.bundle.conf.json` 之后。
- 修改：`.github/workflows/ci.yml`：`device-bundle-linux`、`device-bundle-windows`、`device-bundle-macos` 三个 job 在 `Compile the runner sidecar` 之后加一步 `Fetch and verify agent-desktop`；macOS 的 `tauri build` 加 `--config src-tauri/tauri.agent-desktop-macos.conf.json`；deb 检查加 `grep -Eq 'usr/bin/agent-desktop$'`。
- 修改：`.github/workflows/device-release.yml`：`linux`、`windows`、`macos` 三个 job 同上。
- 修改：`openbot/scripts/ci/device-release-workflow.test.mjs`：新增测试。

**接口：**
- 读入：Task 1 的锁文件。
- 产出（`fetch-agent-desktop.ts`）：
  ```ts
  export type AgentDesktopLock = { version: string; commit: string; targets: Record<string, { archive: string; archiveSha256: string; entries: { name: string; sha256: string }[] }> };
  export function archiveUrl(lock: AgentDesktopLock, triple: string): string; // https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0/<archive>
  /** 要放进 src-tauri/binaries 的文件：`agent-desktop` → `agent-desktop-<triple>[.exe]`；macOS 再加 `agent-desktop-macos-helper` → `agent-desktop-macos-helper-<triple>`；Linux 只放 CLI。 */
  export function sidecarFiles(triple: string): { entry: string; file: string }[];
  export async function fetchAgentDesktop(opts: { triple: string; lock: AgentDesktopLock; outDir: string; download?: (url: string) => Promise<Uint8Array>; tar?: string }): Promise<string[]>;
  ```
  - 命令行用法：`bun desktop-device/scripts/fetch-agent-desktop.ts [--triple <t>] [--out <dir>]`。不给 `--triple` 时，照 `build-sidecar.ts` 的 `hostTriple` 取本机；`--out` 默认 `src-tauri/binaries`（文件按 `sidecarFiles` 命名），探针用它取到临时目录。
- 规则：
  1. 下载到临时目录，核对压缩包的 SHA-256；
  2. 用 `tar -tzf` 列条目，必须与锁文件里的条目集合完全相等（不多不少，没有子目录、没有链接）；
  3. 解到临时目录，逐个核对 SHA-256；
  4. 只把 `sidecarFiles` 列出的文件复制进 `outDir`，权限 0755；
  5. 任何一步不符就抛错，错误信息里带上期望值和实际值，并且不留下半成品。
  - Windows 上用 `%SystemRoot%\System32\tar.exe`，与上游 postinstall 相同。

- [ ] **Step 1：写失败测试** `fetch-agent-desktop.test.ts`。用假的 `download`：本地造一个 tar.gz，再写一份与它对应的锁文件。
  - `archiveUrl names the v1.2.0 release asset`：`x86_64-pc-windows-msvc` 的地址以 `/releases/download/v1.2.0/agent-desktop-v1.2.0-x86_64-pc-windows-msvc.tar.gz` 结尾。
  - `sidecarFiles: macOS brings its clipboard helper, Linux the CLI only, Windows an .exe`：三种目标的结果分别精确相等。
  - `a wrong archive checksum fails and leaves nothing in outDir`
  - `an extra or missing entry in the archive fails before extracting`
  - `an entry whose bytes differ from the lock fails`
  - `a good archive installs exactly the sidecar files, executable`
  - `the committed lock pins six targets and the binaries of design decision 2`：读真锁文件，断言 `aarch64-apple-darwin` 里 `agent-desktop` 的 sha256 等于 `dec75e0b…f738e9`（写全值）、`x86_64-pc-windows-msvc` 的等于 `d2746670…fd94c3`（写全值）。
- [ ] **Step 2：写失败测试**：在 `device-release-workflow.test.mjs` 里加 `every device bundle fetches and verifies agent-desktop before tauri build`。对 ci.yml 的三个 `device-bundle-*` job 和 device-release.yml 的 `linux`、`windows`、`macos` job 分别断言：
  - 有一步的 `run` 含 `fetch-agent-desktop.ts`，并且排在含 `tauri build` 的那一步之前；
  - macOS 的 `tauri build` 一步含 `tauri.agent-desktop-macos.conf.json`；
  - deb 检查一步含 `usr/bin/agent-desktop$`。
- [ ] **Step 3：运行** `cd openbot/desktop-device && bun test tests/fetch-agent-desktop.test.ts` 与 `cd openbot && bun test scripts/ci/device-release-workflow.test.mjs`。预期新测试失败。
- [ ] **Step 4：实现**脚本、两个 Tauri 配置和两个工作流的改动。
- [ ] **Step 5：运行**：同上两条命令，预期全部通过（包括「every action is pinned to a commit SHA」）。推送后看 CI 的三个 `device-bundle-*` job 全部通过，`verify-macos.sh --unsigned` 照旧通过。
- [ ] **Step 6：提交并开 PR-1b**（8 个文件），提交信息为 `设备端：构建时下载并核对 agent-desktop v1.2.0，随安装包附带`。

### Task 3：第三方许可清单与许可证检查

**文件：**
- 新建：`openbot/desktop-device/licenses/agent-desktop/about.toml`
  - `accepted = ["Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "Unicode-3.0", "Unicode-DFS-2016", "CC0-1.0", "0BSD", "BSL-1.0", "MPL-2.0"]`
  - `targets` 为六个三元组
  - `ignore-build-dependencies = true`
  - `ignore-dev-dependencies = true`
- 新建：`openbot/desktop-device/licenses/agent-desktop/about.hbs`：Markdown 模板，按许可证分组，列出每个 crate 的名字、版本和许可全文。
- 新建（生成后提交）：`openbot/desktop-device/licenses/agent-desktop/THIRD-PARTY.md`、`LICENSE`（上游 Apache-2.0 全文）、`COPYRIGHT`（上游 `LICENSE` 与 `Cargo.toml` 里的版权行原文）。
- 修改：`openbot/desktop-device/src-tauri/tauri.bundle.conf.json`：`resources` 加 `"../licenses/agent-desktop/LICENSE": "licenses/agent-desktop/LICENSE"`、`THIRD-PARTY.md` 和 `COPYRIGHT` 三项。
- 修改：`.github/workflows/ci.yml`：新 job `agent-desktop-licenses`。
- 测试：`openbot/desktop-device/tests/licenses.test.ts`

**接口：**
- `agent-desktop-licenses` job（ubuntu-latest，`timeout-minutes: 30`）：
  1. 用固定提交 SHA 的 `actions/checkout`，`repository: vercel-labs/agent-desktop`，`ref: 2b0a7334fc111730454b726e6800aa41cdafc093`，`path: upstream`；
  2. 用 rust-toolchain（与现有 job 同一个 SHA）装工具链；
  3. `cargo install cargo-about --locked --version <X>`。`<X>` 取实施当天 crates.io 上 cargo-about 的最新稳定版，写死在 job 里，并记进 PR 描述；
  4. 在 `upstream` 目录用我们的 `about.toml` 和 `about.hbs` 运行 `cargo about generate`；
  5. 把输出和仓库里的 `THIRD-PARTY.md` 比对，有差别就失败；`cargo about` 遇到不在 `accepted` 里的许可证本身也会失败。
  - 不加 `continue-on-error`。

- [ ] **Step 1：写失败测试** `licenses.test.ts`：
  - `the agent-desktop notices ship with the bundle`：`tauri.bundle.conf.json` 的 `resources` 含上面三项。
  - `no copyleft licence appears in the agent-desktop notice`：`THIRD-PARTY.md` 里每个许可证标题都在 `about.toml` 的 `accepted` 中，并且全文不匹配 `/\b(A?GPL|LGPL|SSPL)-/`。
  - `LICENSE is the Apache-2.0 text and COPYRIGHT is not empty`
  - `the licence job pins the upstream commit of the lock`：ci.yml 的 `agent-desktop-licenses` job 里 checkout 的 `ref` 等于锁文件的 `commit`。
- [ ] **Step 2：运行** `cd openbot/desktop-device && bun test tests/licenses.test.ts`，预期失败。
- [ ] **Step 3：在本机或 CI 上生成**三个文件（命令同 job），并加上 `about.toml`、`about.hbs`、配置和 job。
- [ ] **Step 4：运行**：同一测试预期通过；推送后 `agent-desktop-licenses` job 通过。如果检查报出许可证不在接受表里，**停下来报告用户**，不能把它加进接受表了事。
- [ ] **Step 5：提交并开 PR-1c**，提交信息为 `设备端：agent-desktop 第三方许可清单，CI 拒绝 GPL 类许可证`。

## PR-2：签名与公证

### Task 4：签名与核对覆盖 agent-desktop；macOS 13 起

**文件：**
- 修改：`openbot/desktop-device/scripts/verify-macos.sh`
- 修改：`openbot/desktop-device/scripts/verify-windows-signatures.ps1`
- 修改：`openbot/desktop-device/src-tauri/tauri.macos.conf.json`：加 `"minimumSystemVersion": "13.0"`。
- 修改：`openbot/scripts/ci/device-release-workflow.test.mjs`
- 测试：`openbot/desktop-device/tests/verify-scripts.test.ts`（静态检查两个脚本的文本）

**接口：**
- `verify-macos.sh` 新增检查（签名和未签名两种模式都做）：
  - `Contents/MacOS/agent-desktop` 和 `Contents/MacOS/agent-desktop-macos-helper` 存在、可执行，组和其他人都不可写；
  - 在包内运行 `agent-desktop version`，返回的 `data.version` 为 `1.2.0`（返回形状照 Task 1 FACTS (f)）。
  - 签名模式下，两个文件的 `codesign -dv` 都带 `TeamIdentifier=<team>` 和 `flags=…runtime`；它们实际带的权限写进证据目录的 `agent-desktop.entitlements.plist`。
- `verify-windows-signatures.ps1`：从安装包里同样用 7z 取出 `agent-desktop.exe`。签名模式下要求它的 Authenticode 状态为 `Valid`、发布者与期望一致；未签名模式下要求它没有我们的签名（上游本来就不签）。最后一行的说明加上它。
- 签名本身不用改：Tauri 用 `signCommand`（Windows）和签名身份（macOS）签所有 `externalBin`，见设计决定 4。

- [ ] **Step 1：写失败测试** `verify-scripts.test.ts`：
  - `verify-macos checks agent-desktop and its helper, version 1.2.0, team and runtime`：脚本文本含 `Contents/MacOS/agent-desktop-macos-helper`、`version`、`1.2.0`、`TeamIdentifier`。
  - `verify-windows-signatures extracts and checks agent-desktop.exe`：脚本文本含 `'agent-desktop.exe'`，并且在签名模式的分支里检查它。
  - `macOS 13 is the floor`：`tauri.macos.conf.json` 的 `bundle.macOS.minimumSystemVersion` 为 `"13.0"`。
- [ ] **Step 2：运行** `cd openbot/desktop-device && bun test tests/verify-scripts.test.ts`，预期失败。
- [ ] **Step 3：实现**。
- [ ] **Step 4：运行**：同一测试，再加 `cd openbot && bun test scripts/ci/device-release-workflow.test.mjs`，预期通过。推送后：CI 的 `device-bundle-macos`（未签名核对）通过；`device-bundle-windows` 的「Signing rehearsal」三步通过，说明一次性证书签到了 `agent-desktop.exe`。
- [ ] **Step 5：提交并开 PR-2**，提交信息为 `设备端：签名与核对覆盖 agent-desktop；macOS 最低 13`。

### Task 5：配置 Apple 证书与公证凭据（需要用户）

**这一步只有用户能做**（需要 Apple 开发者账号）。执行代理把下面的清单原样交给用户，等用户回复「已配好」。

- [ ] **Step 1（用户）**：在 Apple 开发者账号里准备一张「Developer ID Application」证书（导出 `.p12` 和它的密码），以及一个 App Store Connect API 密钥（`.p8`、Key ID、Issuer ID）。
- [ ] **Step 2（用户）**：在 GitHub 仓库的 `device-release` Environment 里配置：
  - 变量：`DEVICE_MACOS_SIGNING=developer-id`、`DEVICE_APPLE_SIGNING_IDENTITY`（形如 `Developer ID Application: 名字 (TEAMID)`）、`DEVICE_APPLE_TEAM_ID`、`DEVICE_APPLE_API_KEY_ID`、`DEVICE_APPLE_API_ISSUER`；
  - 密钥：`DEVICE_APPLE_CERTIFICATE`（`.p12` 的 base64）、`DEVICE_APPLE_CERTIFICATE_PASSWORD`、`DEVICE_APPLE_API_KEY_P8`（`.p8` 的全文）；
  - 仓库变量：`DEVICE_RELEASE_MACOS=true`。
- [ ] **Step 3（用户）**：推一个 `device-v<下一个版本>-rc.1` 标签。执行代理看 `device-release` 的 `macos` job：「Bundle the app and dmg (Developer ID, notarized)」「Sign, notarize and staple the dmg」「Verify the bundle」三步都通过，证据里 agent-desktop 带我们的 Team ID。不通过时把日志交给用户，不改核对标准。
- 没有凭据时 PR-2 仍然可以合入：工作流照旧按未签名内测版发布，macOS 写动作要等到这一步完成后才对外发布（见 Task 26）。

## PR-3：适配层（读）

### Task 6：共享协议扩展（读）

**文件：**
- 修改：`openbot/shared/desktop-control.ts`
- 修改：`openbot/shared/desktop-control.test.ts`

**接口（新增，第 1 期的导出全部保留）：**
```ts
export const AGENT_DESKTOP_VERSION = "1.2.0";
export type DesktopEngine = "legacy" | "agent-desktop";
export type DesktopPlatform = "windows" | "macos" | "linux";
export function desktopPlatformOf(nodePlatform: string): DesktopPlatform | undefined; // win32/darwin/linux
/** 第 1 期的 w<hwnd>-<pid>，或 agent-desktop 引擎的 a<16 hex>。 */
export const DESKTOP_WINDOW_ID: RegExp; // /^(?:w-?[1-9]\d{0,19}-[1-9]\d{0,9}|a[0-9a-f]{16})$/
export function isAgentWindowId(id: string): boolean;
export type DesktopWindow = { windowId: string; title: string; process: string; focused: boolean; minimized: boolean;
  /** 所在显示器在 list-displays 里的下标（0 为主屏），agent-desktop 引擎才有。 */ display?: number;
  bounds?: { x: number; y: number; width: number; height: number } };
export type DesktopElement = { /* 第 1 期字段 */ singleLine?: true };
// DesktopErrorCode 加："unsupported_platform" | "mac_permission" | "linux_bus" | "policy_denied" | "ambiguous" | "not_actionable"
// DESKTOP_LIMITS 加：adCommandTimeoutMs、adSnapshotTimeoutMs、adIdleWipeMs、windowIdsKept（数值见全局约束）
```
- 文案：照设计决定 13 和规格 §8。`policy_denied` 用「这个控件不支持直接操作，请换一种方式（例如用快捷键）。」，`ambiguous` 用「这个控件没有可识别的名字，无法确定要操作哪一个。」。

- [ ] **Step 1：写失败测试**（加在 `desktop-control.test.ts`）：
  - `new codes carry the spec's copy`：上面 6 个新代码逐个和原文比对，精确相等。
  - `window ids: the legacy and the agent-desktop forms both pass, junk does not`：`a0123456789abcdef` 通过；`a0123456789abcde`（15 位）、`A0123456789ABCDEF`、`w0-1` 都不通过。
  - `desktopPlatformOf maps win32, darwin, linux and nothing else`
  - 现有的 `only the two read actions exist` 保持不变（本任务不加动作）。
- [ ] **Step 2：运行** `cd openbot && bun test shared/desktop-control.test.ts`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**同一命令，再跑 `cd openbot/server && bun test tests/desktop-gateway.test.ts`，预期通过（服务器侧只靠正则，旧形状照旧通过）。

### Task 7：agent-desktop 调用层

**文件：**
- 新建：`openbot/runner/src/desktop/agent-desktop.ts`
- 新建：`openbot/runner/tests/fixtures/fake-agent-desktop.ts`：一个假的 CLI，读环境变量 `FAKE_AD_SCRIPT`（JSON：每种命令回哪份 Task 1 样本、退出码、延时），并把收到的参数、stdin 和环境变量追加写进 `FAKE_AD_LOG`。
- 测试：`openbot/runner/tests/agent-desktop-cli.test.ts`

**接口：**
```ts
export type AdError = { code: string; message: string; details?: Record<string, unknown>;
  disposition?: { delivery?: string; retry?: string }; platform_detail?: string };
export class AgentDesktopError extends Error {
  readonly code: string; readonly exitCode: number; readonly notDelivered: boolean; // delivery === "not_delivered"
  readonly detail?: string; // details.kind 或 platform_detail
}
export type AdRunOptions = { stdin?: string; headed?: boolean; force?: boolean; timeoutMs?: number; signal?: AbortSignal };
export type AgentDesktopCli = {
  /** 跑一条命令，返回信封里的 data；ok:false 抛 AgentDesktopError；超时或中止抛 DesktopHelperError（code timeout / AbortError）。 */
  run(args: readonly string[], opts?: AdRunOptions): Promise<unknown>;
  /** 第一次用时核对 version 和状态目录（0700），只做一次。 */
  ensureReady(signal?: AbortSignal): Promise<void>;
  wipeState(): Promise<void>;
  close(): Promise<void>;
};
export function createAgentDesktopCli(opts: { binary: string; stateDir: string; platform?: string;
  spawn?: typeof Bun.spawn; now?: () => number; idleWipeMs?: number; onIdleWipe?: () => void }): AgentDesktopCli;
/** 子进程只拿到这些环境变量：PATH、HOME、USER、USERPROFILE、SystemRoot、windir、TEMP、TMP、TMPDIR、LANG、LC_ALL、DISPLAY、WAYLAND_DISPLAY、XDG_RUNTIME_DIR、DBUS_SESSION_BUS_ADDRESS，以及 AGENT_DESKTOP_HOME=stateDir。其它 AGENT_DESKTOP_* 一律不传。 */
export function agentDesktopEnv(base: NodeJS.ProcessEnv, stateDir: string): Record<string, string>;
export const FORBIDDEN_AD_ARGS: ReadonlySet<string>; // mcp、--trace、--trace-strict、--session、--screenshots、--cdp、--no-attach、--arg、--env、--agent-id
```
- 规则：
  - 参数顺序为 `[--headed] <command> ...args [--force]`。`args` 里出现 `FORBIDDEN_AD_ARGS` 的任何一项就直接抛错，不启动进程。
  - 所有命令串行执行（同一时刻只跑一个子进程），满足「一台设备同时只执行一个桌面动作」。
  - 输出：只取 stdout 里唯一的一个 JSON 信封；解析失败按 `failed` 处理。
  - 退出码 2（参数错误）按 `failed` 处理，详情为 `INVALID_ARGS`。
  - 超时和中止：结束整棵进程树（照 `host.ts` 的写法）。
  - `ensureReady`：
    - 建 `stateDir`（0700）。Linux 和 macOS 上，如果它已经存在而权限不是 0700，就先清空再建。
    - 跑 `version`，版本不等于 `AGENT_DESKTOP_VERSION` 时抛 `start_failed`，详情为「版本不对：<实际版本>」。
    - 可执行文件不存在时抛 `start_failed`，详情为「没有找到 agent-desktop」。
    - 失败不缓存：下次调用再试，但同一个错误不会自动重试。
  - 闲置 `idleWipeMs` 没有任何命令时，清空 `stateDir`，并调用 `onIdleWipe`（Task 8 用它让全部编号作废）。

- [ ] **Step 1：写失败测试** `agent-desktop-cli.test.ts`（spawn 用 `bun fake-agent-desktop.ts`）：
  - `the first call checks version 1.2.0 once; a wrong version is 桌面助手启动失败：版本不对`
  - `a missing binary is 桌面助手启动失败：没有找到 agent-desktop and nothing is retried in a loop`
  - `the child sees AGENT_DESKTOP_HOME = stateDir (0700) and no other AGENT_DESKTOP_* variable`：外层环境里设 `AGENT_DESKTOP_SESSION=x`、`AGENT_DESKTOP_AGENT_ID=y`，假 CLI 的日志里看不到这两个。
  - `forbidden arguments never start a process`：`run(["mcp"])`、`run(["snapshot","--trace","x"])` 都抛错，日志为空。
  - `--headed goes before the command, --force after, text only through stdin`：`run(["type","@s:e1","--stdin"], { stdin: "熊宝员工\r\n😀", headed: true })` 的参数等于 `["--headed","type","@s:e1","--stdin"]`，stdin 按字节原样到达。
  - `an error envelope becomes AgentDesktopError with code, notDelivered and detail`：用 `errors.json` 里的 `POLICY_DENIED` 样本，`notDelivered` 为 true；用一个 `delivery: "delivered_unverified"` 的样本，`notDelivered` 为 false。
  - `commands never overlap`：两个并发调用，假 CLI 延时 200 ms，日志里两次启动时间相差 ≥ 200 ms。
  - `timeout kills the child tree and rejects with timeout`
  - `idle wipes the state directory and calls onIdleWipe`
- [ ] **Step 2：运行** `cd openbot/runner && bun test tests/agent-desktop-cli.test.ts`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**同一命令，再跑 `cd openbot/runner && bun test && bun run typecheck`，预期通过。
- [ ] **Step 5：提交并开 PR-3a**（Task 6–7，5 个文件），提交信息为 `runner：agent-desktop 调用层（串行、受限参数、私有状态目录、版本核对）`。

### Task 8：快照转换、严格编号、截图缩放

**文件：**
- 新建：`openbot/runner/src/desktop/ad-read.ts`
- 新建：`openbot/runner/src/desktop/png-scale.ts`
- 测试：`openbot/runner/tests/ad-read.test.ts`、`openbot/runner/tests/png-scale.test.ts`

**接口：**
```ts
// ad-read.ts
export type DesktopControl = { type: string; name: string; password?: true; singleLine?: true };
export type ResolvedRef = { adRef: string; windowId: string; adWindowId: string; control: DesktopControl };
export type AgentDesktopReader = {
  readonly prefix: string; // 6 位十六进制，每个 reader 新生成
  windows(signal?: AbortSignal): Promise<{ platform: DesktopPlatform; windows: DesktopWindow[] }>;
  snapshot(body: { windowId: string; from?: string; screenshot?: boolean; allowSensitive?: boolean }, signal?: AbortSignal): Promise<DesktopSnapshot & { platform: DesktopPlatform }>;
  /** 写动作用：只认这个窗口最新一次快照里的编号，其它一律 "stale"；指向没有 ref_id 的节点时为 "not_actionable"。 */
  resolveRef(ref: string): ResolvedRef | "stale" | "not_actionable";
  adWindow(windowId: string): { adWindowId: string; pid: number } | undefined;
  /** 写动作成功后、闲置清空后调用：这个窗口（或全部窗口）的编号作废。 */
  invalidate(windowId?: string): void;
};
export function createAgentDesktopReader(opts: { cli: AgentDesktopCli; platform: DesktopPlatform }): AgentDesktopReader;
/** agent-desktop 的嵌套树压成第 1 期的扁平元素表（深度优先），并给出每个下标对应的 ref_id（没有就是 undefined）。 */
export function flattenTree(tree: unknown, snapshotId: string, limits: typeof DESKTOP_LIMITS): { elements: DesktopElement[]; adRefs: (string | undefined)[]; truncated: boolean };
// png-scale.ts
export function scalePngToMaxEdge(png: Uint8Array, maxEdge: number): { png: Uint8Array; width: number; height: number } | "unsupported";
```
- 规则：
  - `windows`：
    - 跑 `list-windows` 和 `list-displays`，只留 `accessible !== false` 的窗口。
    - `windowId` 照设计决定 8 发。`display` 取窗口中心点落在哪个显示器的 `bounds` 里（下标）。标题、程序名截到 `200`，最多 `50` 个。
    - Linux 上如果 `list-windows` 为空，再跑 `status`；按 Task 1 FACTS (k) 判断总线没开时，抛 `linux_bus`。
  - `snapshot`：
    1. 先核对编号：`windowId` 不在本 reader 的映射里，回 `no_window`；`from` 的前缀不等于 `prefix`、或者不是这个窗口最新一次的快照号，回 `stale`；
    2. 读树之前，用 `list-windows` 当场取这个窗口的标题。没有 `allowSensitive` 而标题命中 `DESKTOP_WINDOW_WORDS` 时，回 `sensitive`，什么都不读；
    3. 跑 `snapshot --window-id <adWindowId> --compact --max-depth 12 --timeout-ms 10000`；带 `from` 时改为 `--root <它对应的 adRef>`；
    4. 压平：`type` 取 `role`；`name` 截到 `120`；`value` 截到 `200`；`disabled` 照 FACTS (c)；密码框照 FACTS (a) 认出，标 `password: true` 并删掉值（不管上游给了什么）；`singleLine` 照 FACTS (b)；超过 `800` 个节点就截断，标 `truncated`；上游的 `complete: false` 也算截断；
    5. 只为这个窗口保留最新一次的映射（最多 `16` 个窗口，超出就丢最早的）；
    6. 截图：跑 `screenshot --window-id <id>`，取 FACTS (e) 记录的字段，再按 `scalePngToMaxEdge(…, 1280)` 缩；回 `"unsupported"` 时 `imageError` 用设计决定 15 的文案；`PERM_DENIED` 时 `imageError` 为「没有屏幕录制权限，截不到图。」，结构树照常返回。
  - 错误映射（`AgentDesktopError` 转成中文）：
    - `WINDOW_NOT_FOUND`、`APP_NOT_FOUND` → `no_window`；
    - `STALE_REF`、`SNAPSHOT_NOT_FOUND`、`ELEMENT_NOT_FOUND` → `stale`；
    - macOS 上的 `PERM_DENIED` → `mac_permission`；Windows 上详情含 `E_ACCESSDENIED` 或 `0x80070005` 的 `PERM_DENIED` → `elevated`；
    - `AMBIGUOUS_TARGET` → `ambiguous`；`POLICY_DENIED`、`ACTION_NOT_SUPPORTED` → `policy_denied`；
    - 其它 → `failed`，详情经第 1 期的 `scrub` 去掉路径和用户名。
  - 读动作从不 `outcomeUnknown`。

- [ ] **Step 1：写失败测试** `ad-read.test.ts`（`cli` 用 Task 7 的假 CLI，回放三平台样本）：
  - `windows: each platform's sample lists windows with a<16 hex> ids, titles cut to 200, display index from bounds`
  - `the same window keeps its id across listings; a new reader gives a new id and refuses the old one as 找不到这个窗口`
  - `snapshot flattens the nested tree depth-first with refs <snapshotId>:<index>`：拿 macOS 样本，比对前 5 个元素的 `type`、`name`、`depth`。
  - `a password field never carries a value, on every platform's sample`：用 `*-snapshot-password.json`。
  - `singleLine follows the role Task 1 recorded`
  - `only the latest snapshot of a window resolves; an older one, another reader's and a static node do not`：`resolveRef` 依次返回 `ResolvedRef`、`"stale"`、`"stale"`、`"not_actionable"`。
  - `invalidate(windowId) makes that window's refs stale and leaves the others`
  - `a title that turned sensitive is refused before any snapshot command runs`：假 CLI 的日志里没有 `snapshot`。
  - `errors map to the Chinese copy`：上面映射表每一行各一个用例。
  - `linux with an empty window list and no bus is linux_bus`
  - `no read outcome is outcomeUnknown`
- [ ] **Step 2：写失败测试** `png-scale.test.ts`：
  - `a 3000x1000 RGBA PNG becomes 1280x427 and decodes back`：用 zlib 自己造一张图，再自己解码校验尺寸和 IHDR。
  - `an image already within the edge is returned unchanged (same bytes)`
  - `16-bit and palette PNGs are unsupported`
  - `a corrupt PNG is unsupported, never a throw`
- [ ] **Step 3：运行** `cd openbot/runner && bun test tests/ad-read.test.ts tests/png-scale.test.ts`，预期失败。
- [ ] **Step 4：实现。**
- [ ] **Step 5：运行**同一命令，再跑 `bun test && bun run typecheck`，预期通过。
- [ ] **Step 6：提交并开 PR-3b**（4 个文件），提交信息为 `runner：agent-desktop 快照转成扁平表，严格编号，截图缩到 1280`。

### Task 9：按平台选引擎，macOS 与 Linux 开放查看

**文件：**
- 修改：`openbot/runner/src/desktop/actions.ts`
- 修改：`openbot/runner/src/index.ts`
- 修改：`openbot/runner/tests/desktop-actions.test.ts`（按设计决定 19 改一个断言，加新用例）
- 修改：`openbot/desktop-device/src-tauri/src/sidecar.rs`
- 修改：`openbot/server/src/computer/desktop-tools.ts`：两个说明改成三平台的说法。

**接口：**
```ts
// actions.ts
export function desktopEngineFor(nodePlatform: string, asked: string | undefined): DesktopEngine | undefined;
//   win32：asked === "agent-desktop" ? "agent-desktop" : "legacy"（Task 30 改默认）；darwin、linux："agent-desktop"；其它：undefined
export function createDesktopActions(opts?: {
  platform?: string; engine?: DesktopEngine;
  host?: ReturnType<typeof createDesktopHost>;   // legacy
  reader?: AgentDesktopReader;                    // agent-desktop，测试注入
  helper?: string; stateDir?: string;             // 默认 reader 用
}): DesktopActions;
// index.ts：parseArgs 认 --desktop-helper PATH（环境变量 OPENBOT_DESKTOP_HELPER）、--desktop-engine legacy|agent-desktop（OPENBOT_DESKTOP_ENGINE）；
//   不给 --desktop-helper 时，取 runner 自己可执行文件同目录下的 agent-desktop[.exe]。stateDir = <dataDir>/agent-desktop-state。
//   main 把 createDesktopActions({...}) 经 extras.desktop 交给执行器；shutDown 照旧调用 closeDesktop（会清空状态目录）。
```
- `desktop.windows` 的结果加上 `platform` 字段。agent-desktop 引擎下，`desktop.snapshot` 走 reader；旧引擎完全不变。
- `sidecar.rs`：
  - `runner_args` 加参数 `desktop_helper: Option<&Path>`，有值时追加 `--desktop-helper <path>`；
  - 新函数 `pub fn agent_desktop_path() -> io::Result<PathBuf>`：与 `sidecar_path` 同目录，文件名 `agent-desktop` 加平台后缀；debug 构建认环境变量 `OPENBOT_AGENT_DESKTOP_BINARY`；
  - `RunnerLauncher` 加字段 `desktop_helper: Option<PathBuf>`。
- 工具说明（英文，给模型看）：
  - `DESKTOP_WINDOWS_DESCRIPTION`：把「Windows computer」改为「computer (Windows, macOS, or Linux as a trial)」，并加一句「The result names the platform.」
  - `DESKTOP_SNAPSHOT_DESCRIPTION`：「Windows」改为「computer」，其余照旧；本任务里仍然写「Read-only」。

- [ ] **Step 1：写失败测试**（`desktop-actions.test.ts`）：
  - 把 `on a non-Windows platform every desktop action refuses…` 改为 `on an unsupported platform every desktop action refuses with unsupported_platform and starts nothing`（`platform: "freebsd"`）。
  - `darwin and linux read through agent-desktop`：注入假 reader，`desktop.windows` 的结果带 `platform: "macos"`。
  - `win32 stays on the PowerShell reader unless OPENBOT_DESKTOP_ENGINE is agent-desktop`：`desktopEngineFor("win32", undefined)` 为 `"legacy"`，`desktopEngineFor("win32", "agent-desktop")` 为 `"agent-desktop"`。
  - `parseArgs takes --desktop-helper and --desktop-engine, and refuses an unknown engine`：放在 `runner/tests` 里现有的 parseArgs 测试文件中，未知值报错。
  - Rust（`sidecar.rs` 的 `#[cfg(test)]`）：`the desktop helper is passed when known`、`agent_desktop_path_is_next_to_the_app`。
- [ ] **Step 2：运行** `cd openbot/runner && bun test tests/desktop-actions.test.ts`、`cd openbot/desktop-device/src-tauri && cargo test --locked`，预期新用例失败。
- [ ] **Step 3：实现**；`main.rs` 构造 `RunnerLauncher` 时传入 `agent_desktop_path().ok()`（只改一行，算在 `sidecar.rs` 这一改动里；如果需要改 `main.rs`，本 PR 合计 6 个文件）。
- [ ] **Step 4：运行**：上面两条命令，再加 `cd openbot/server && bun test tests/desktop-tools.integration.test.ts`（需要本地 PG）与 `cd openbot && bunx biome lint --error-on-warnings .`，预期全部通过。
- [ ] **Step 5：提交并开 PR-3c**，提交信息为 `runner/设备端：按平台选择桌面引擎，macOS 与 Linux 可以查看桌面`。

### Task 10：三平台 CI 探针

**文件：**
- 新建：`openbot/scripts/ci/desktop-probe.ts`
- 修改：`.github/workflows/ci.yml`：新 job `desktop-probe`
- 修改：`openbot/scripts/ci/device-release-workflow.test.mjs`

**接口：**
```ts
export async function probeAgentDesktop(assert: (ok: unknown, label: string, seen?: unknown) => void,
  opts: { root: string; helper: string; platform: DesktopPlatform; execute: RunnerExecutor }): Promise<void>;
// 直接运行：bun scripts/ci/desktop-probe.ts <root> --helper <path>；全部通过时最后一行打印 DESKTOP_PROBE_PASS
```
- `desktop-probe` job：
  - matrix 三个平台：`windows-latest`（环境变量 `OPENBOT_DESKTOP_ENGINE=agent-desktop`）、`macos-latest`、`ubuntu-latest`（装 `xvfb gedit openbox at-spi2-core dbus-x11 libatspi2.0-0`，用 `xvfb-run -a dbus-run-session --` 包着运行，与 spike 相同）；
  - 步骤：checkout、setup-bun、frozen install、`bun desktop-device/scripts/fetch-agent-desktop.ts --out <tmp>`（Task 2 的脚本），然后跑探针；
  - 日志里没有 `^DESKTOP_PROBE_PASS$`，或者出现 `"passed":false`，就失败；
  - 上传日志 artifact `desktop-probe-<os>-log`；不加 `continue-on-error`。
- 本任务的读检查（每项用 `assert` 打印，标签照写）：
  1. 在 `root` 里写 `熊宝员工.txt`（内容为「熊宝员工-桌面探针」），用 notepad / TextEdit / gedit 打开。标签：`agent-desktop lists the editor with its Chinese title`。
  2. `desktop.snapshot` 读回的某个元素的 `value` 含「熊宝员工-桌面探针」，每个 `ref` 都匹配 `DESKTOP_REF`。标签：`the editor's text reads back in Chinese`。
  3. 再读一次，用第一次的编号作 `from`，回 `stale`。标签：`an older snapshot's ref is stale`。
  4. 关掉执行器的桌面动作再重建，用旧窗口编号去读，回 `no_window`。标签：`ids from an earlier runner process are refused`。
  5. 再打开 `银行-探针.txt`：不带 `allowSensitive` 回 `sensitive`；带上则成功。标签：`a sensitive title is read only when allowed`。
  6. `screenshot: true`：有 `image` 时，长边 ≤ 1280、是 PNG；macOS 上如果 `permissions` 报屏幕录制不是 granted，就要求 `imageError` 等于 Task 8 的文案。标签：`a window screenshot is a PNG within 1280 px, or says why not`。
  7. 状态目录权限为 0700，并且从未出现过 `trace` 目录；`closeDesktop()` 之后状态目录为空。标签：`the state directory is private, untraced and wiped on close`。

- [ ] **Step 1：写失败测试**：在 `device-release-workflow.test.mjs` 里加 `the desktop probe runs on three platforms, fetches the pinned binary and must print DESKTOP_PROBE_PASS`。断言：matrix 含三个 OS；Linux 的运行命令含 `xvfb-run` 和 `dbus-run-session`；Windows 设了 `OPENBOT_DESKTOP_ENGINE: agent-desktop`；有一步含 `fetch-agent-desktop.ts`；检查 `DESKTOP_PROBE_PASS` 和 `"passed":false`；没有 `continue-on-error`。
- [ ] **Step 2：运行** `cd openbot && bun test scripts/ci/device-release-workflow.test.mjs`，预期失败。
- [ ] **Step 3：实现**探针和 job。
- [ ] **Step 4：运行**同一测试，预期通过；推送后三个平台的 `desktop-probe` 全部通过。没有授权或没有总线时，照设计决定 20 停下来报告。
- [ ] **Step 5：提交并开 PR-3d**，提交信息为 `CI：agent-desktop 三平台桌面探针（只读）`。

## PR-4：macOS 权限引导

### Task 11：「桌面操作」卡片

**文件：**
- 新建：`openbot/desktop-device/src-tauri/src/desktop_permissions.rs`
- 修改：`openbot/desktop-device/src-tauri/src/main.rs`：`mod`、三个命令，以及把 `Signal::DesktopPermission` 接到「显示主窗口并滚到卡片」。
- 修改：`openbot/desktop-device/src-tauri/src/supervise.rs`：`classify` 认 `runner: desktop {"event":"permission-needed"}`，产出新的 `Signal::DesktopPermission`。
- 修改：`openbot/desktop-device/ui/index.html`：新 `<section id="desktop">`。
- 新建：`openbot/desktop-device/ui/desktop.js`
- 新建：`openbot/desktop-device/ui/mac-accessibility.svg`：示意图，画出「隐私与安全性 → 辅助功能」列表里「熊宝数字员工 设备端」的开关处于打开状态。
- 测试：`openbot/desktop-device/tests/desktop-card.test.ts`

**接口：**
```rust
#[derive(Serialize, Clone, Copy, PartialEq, Debug)] pub enum PermState { Granted, Denied, NotRequired, Unknown }
#[derive(Serialize)] pub struct DesktopPermissionView { pub platform: &'static str, pub accessibility: PermState, pub screen_recording: PermState, pub at_spi: Option<bool> }
pub fn parse_permissions(json: &str) -> Option<(PermState, PermState)>; // 读 agent-desktop permissions 的 data.accessibility.state、data.screen_recording.state
pub fn settings_url(kind: &str) -> Option<&'static str>; // "accessibility" → x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility；"screen" → …?Privacy_ScreenCapture
#[tauri::command] fn desktop_permissions() -> Result<DesktopPermissionView, String>; // 用 sidecar::agent_desktop_path() 跑 `permissions`（Linux 跑 `status`），5 秒超时
#[tauri::command] fn open_desktop_settings(kind: String) -> Result<(), String>;     // macOS 上 `open <url>`；别的平台报错
#[tauri::command] fn restart_app(app: AppHandle);                                    // app.restart()
```
- 卡片（`desktop.js`）：
  - macOS：两行，「辅助功能（读界面和动手都要）」「屏幕录制（只有截图要，不给也能用）」，状态显示「已允许 / 未允许」，未允许的那一行有「去开启」按钮，下面放示意图和一句「找到熊宝数字员工设备端，打开开关」；
  - 卡片可见时每 3 秒刷新一次；
  - 底部固定一句「开启后仍显示未允许时，」加按钮「重新打开设备端」（调用 `restart_app`）；
  - Windows：一行「Windows 不需要授权。」；
  - Linux：标题加「（试用，只能查看）」，`at_spi` 为 false 时显示设计决定 13 的 `linux_bus` 文案。
- runner：遇到 `mac_permission` 时，在 stdout 写 `runner: desktop {"event":"permission-needed"}`。Task 13 的控制通道建好之前，先直接 `console.log`；Task 13 再改为走通道。

- [ ] **Step 1：写失败测试**：
  - Rust：`parse_permissions_reads_the_two_states`（用 Task 1 的 `macos-permissions.json`）；`settings_urls_are_the_two_privacy_panes`；`a_permission_line_is_classified`。
  - `desktop-card.test.ts`（照 `tests/folders.test.ts` 的写法，DOM 用 happy-dom，Tauri 的 `invoke` 用假的）：
    - `macOS shows both rows and a 去开启 button only for the one not allowed`
    - `the card polls every 3 seconds while visible and stops when hidden`
    - `Linux without a bus shows the AT-SPI hint`
- [ ] **Step 2：运行** `cd openbot/desktop-device/src-tauri && cargo test --locked` 与 `cd openbot/desktop-device && bun test tests/desktop-card.test.ts`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**同上两条命令，再看 CI 的 `device-shell` 三个平台全部通过。

### Task 12：关于与第三方许可

**文件：**
- 修改：`openbot/desktop-device/ui/index.html`：`<section id="about">`，五个 `<details>`：本软件许可、NOTICE、第三方许可、agent-desktop 许可、agent-desktop 的第三方许可。
- 修改：`openbot/desktop-device/src-tauri/src/main.rs`：命令 `read_bundled_text(name: String) -> Result<String, String>`。只认白名单里的五个名字：`LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md`、`licenses/agent-desktop/LICENSE`、`licenses/agent-desktop/THIRD-PARTY.md`；从 `app.path().resource_dir()` 读。
- 修改：`openbot/desktop-device/ui/desktop.js`：展开某一项时读取对应文本，放进 `<pre>`。

- [ ] **Step 1：写失败测试**（Rust）：`only_the_five_bundled_notices_can_be_read`：`"../device.json"`、`"/etc/passwd"`、`"licenses/agent-desktop/../../x"` 都回 `Err`。
- [ ] **Step 2：运行** `cargo test --locked`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**同一命令，预期通过。
- [ ] **Step 5：提交并开 PR-4**（Task 11–12，8 个文件），提交信息为 `设备端：「桌面操作」权限卡片（macOS 引导、Linux 试用），关于与第三方许可`。

## PR-5：安全外壳

### Task 13：设备端会话与控制通道（runner）

**文件：**
- 新建：`openbot/runner/src/desktop/control.ts`
- 新建：`openbot/runner/src/desktop/session.ts`
- 修改：`openbot/runner/src/desktop/actions.ts`：加三个会话动作，`permission-needed` 改走通道。
- 修改：`openbot/runner/src/index.ts`：`--desktop-control stdio`；心跳加 `desktopStopped`。
- 修改：`openbot/shared/desktop-control.ts`：`DESKTOP_ACTIONS` 加 `desktop.session_start`、`desktop.session_status`、`desktop.session_end`；加错误码 `stopped`、`session_expired`、`no_session`、`no_control_channel`、`headed_unconfirmed`、`read_only_linux`、`read_only_windows`，以及会话相关的三个数值。
- 测试：`openbot/runner/tests/desktop-session.test.ts`、`openbot/shared/desktop-control.test.ts`

**接口：**
```ts
// control.ts
export const CONTROL_LINE_PREFIX = "runner: desktop ";
export type ControlEvent =
  | { event: "session-started"; label: string }   // label：令牌 sha256 的前 8 位，不写令牌本身（stdout 会进日志）
  | { event: "session-ended"; reason: "stopped" | "expired" | "ended" | "replaced" }
  | { event: "headed-begin"; seq: number } | { event: "headed-end"; seq: number }
  | { event: "permission-needed" };
export type ControlInput = { control: "stop"; reason: "hotkey" | "mouse" | "button" } | { control: "headed-ack"; seq: number };
export type ControlChannel = { readonly available: boolean; emit(event: ControlEvent): void; onStop(listener: (reason: string) => void): void;
  /** 发 headed-begin，等 headed-ack（最多 headedAckMs），执行 run，最后不管成败都发 headed-end。等不到确认时抛 headed_unconfirmed，run 不执行。 */
  headed<T>(run: () => Promise<T>): Promise<T> };
export function createControlChannel(opts: { lines: AsyncIterable<string>; write: (line: string) => void; ackMs?: number }): ControlChannel;
export const NO_CONTROL: ControlChannel; // available: false；headed 一律抛 no_control_channel
// session.ts
export type DesktopSessions = {
  start(input: { token: string; botId: string; actorId: string }): void;   // 已有会话就先以 "replaced" 结束
  status(botId: string, actorId: string): { token: string } | undefined;
  check(token: unknown, botId: string, actorId: string): "ok" | "stopped" | "expired" | "none"; // ok 时续期闲置时间
  end(token: string): void;
  /** 当前会话期间的中止信号：叫停时中止，让在途动作立即停下。 */
  readonly signal: AbortSignal | undefined;
  /** 最近一次叫停，等下一次心跳带走后清除。 */
  takeStopped(): { botId: string; actorId: string; reason: string; at: number } | undefined;
};
export function createDesktopSessions(opts: { control: ControlChannel; now?: () => number; idleMs?: number; maxMs?: number }): DesktopSessions;
```
- 三个动作：
  - `desktop.session_status { botId, actorId }` 回 `{ writable, reason?, platform, session? }`。`writable` 为 false 的情况，按以下顺序判断：
    1. Linux：`read_only_linux`；
    2. win32 且引擎为 legacy：`read_only_windows`；
    3. `!control.available`：`no_control_channel`；
    4. macOS 上辅助功能未允许：`mac_permission`（跑一次 `permissions`，结果缓存 10 秒）。
  - `desktop.session_start { token, botId, actorId }`：`writable` 为 false 时回对应文案；`token` 必须是 64 位十六进制；成功后发 `session-started`。
  - `desktop.session_end { token }`
  - 三个动作都不 `outcomeUnknown`。
- 叫停：`onStop` 收到时，结束会话（发 `session-ended: stopped`），中止 `signal`，记下 `takeStopped`，并立即补发一次心跳。
- 心跳：`heartbeatFrame` 新增可选参数 `desktopStopped?: { botId; actorId; reason; at }`，写进 JSON 帧。
- `index.ts`：`--desktop-control stdio` 时，用 `process.stdin` 的行（UTF-8，按 `\n` 分行）和 `console.log` 建通道；否则用 `NO_CONTROL`。

- [ ] **Step 1：写失败测试** `desktop-session.test.ts`（通道用内存里的行队列）：
  - `status is writable only on macOS (or Windows on agent-desktop) with a control channel`：Linux、legacy Windows、没有通道、Mac 未授权四种情况，各自回对应的文案。
  - `a started session checks ok, renews on use, expires after 15 idle minutes and after 60 minutes in all`：用假时钟，分别在 14:59、15:01 闲置和 59:59、60:01 总长处断言。
  - `a stop from the channel ends the session, aborts its signal, and is reported once on the next heartbeat`
  - `a second start replaces the first, which then checks "none"`
  - `stdout carries a short label, never the token`：捕获的 stdout 里没有 64 位令牌。
  - `headed waits for the ack; without one in 1 s nothing runs and the error is headed_unconfirmed`
  - `without --desktop-control every session_start is no_control_channel`
  - `shared`：`DESKTOP_ACTIONS` 精确等于两个读动作加三个会话动作；七个新错误码的文案逐个比对。
- [ ] **Step 2：运行** `cd openbot/runner && bun test tests/desktop-session.test.ts` 与 `cd openbot && bun test shared/desktop-control.test.ts`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**同上，再跑 `bun test && bun run typecheck`（runner），预期通过。
- [ ] **Step 5：提交并开 PR-5a**（7 个文件），提交信息为 `runner：桌面会话（闲置 15 分钟、最长 60 分钟）与设备端控制通道`。

### Task 14：设备端应用：提示条与控制通道

**文件：**
- 新建：`openbot/desktop-device/src-tauri/src/desktop_guard.rs`
- 修改：`openbot/desktop-device/src-tauri/src/sidecar.rs`：stdin 改为管道，加 `--desktop-control stdio`，`RunnerLauncher` 保存子进程的 stdin，新增 `pub fn send_control(&self, line: &str) -> io::Result<()>`。
- 修改：`openbot/desktop-device/src-tauri/src/supervise.rs`：`Signal::Desktop(DesktopEvent)`；`Observer` 加 `fn desktop(&self, _event: DesktopEvent) {}`。
- 修改：`openbot/desktop-device/src-tauri/src/main.rs`：提示条窗口、托盘菜单项「停止桌面操作」、把守卫的动作接到窗口和 stdin 上。
- 新建：`openbot/desktop-device/ui/banner.html`（内联脚本只监听事件 `desktop-banner`，载荷为 `{ headed: boolean }`）。

**接口：**
```rust
pub enum DesktopEvent { SessionStarted { label: String }, SessionEnded { reason: String }, HeadedBegin { seq: u64 }, HeadedEnd { seq: u64 }, PermissionNeeded }
pub fn parse_desktop_line(line: &str) -> Option<DesktopEvent>; // 前缀 "runner: desktop " 加 JSON
#[derive(Debug, PartialEq)] pub enum GuardAction { ShowBanner { headed: bool }, HideBanner, SendAck(u64), Stop(&'static str), RegisterHotkey, UnregisterHotkey }
pub struct Guard { /* active, headed, baseline: Option<(f64, f64)> */ }
impl Guard {
  pub fn new() -> Self;
  pub fn on_event(&mut self, event: &DesktopEvent, cursor: Option<(f64, f64)>) -> Vec<GuardAction>;
  /** 有会话、不在真实输入期间、相对起点在任一方向移动 ≥ 3 px 时，回 Stop("mouse")。 */
  pub fn on_cursor(&mut self, pos: (f64, f64)) -> Option<GuardAction>;
  pub fn is_polling(&self) -> bool; // 有会话且不在 headed 期间
}
pub fn control_line(action: &GuardAction) -> Option<String>; // {"control":"stop","reason":"mouse"} / {"control":"headed-ack","seq":7}
pub const BANNER_TEXT: &str = "熊宝员工正在操作你的电脑 · 按 Ctrl+Alt+Esc（Mac 上 ⌃⌥⎋）或移动鼠标即可停止";
pub const BANNER_HEADED_SUFFIX: &str = " · 正在移动鼠标";
```
- 提示条窗口：标签 `desktop-banner`，内容 `banner.html`，启动时就建好但隐藏。参数：`always_on_top(true)`、`decorations(false)`、`skip_taskbar(true)`、`focused(false)`、`focusable(false)`、`resizable(false)`、`visible_on_all_workspaces(true)`，尺寸 620×36，放在主显示器顶部居中。显示后调用 `set_ignore_cursor_events(true)`。显示时从不调用 `set_focus`。
- 事件与动作：
  - `SessionStarted` → 显示提示条（`headed: false`）并注册停止键；
  - `HeadedBegin` → 提示条改为 `headed: true`，回 `SendAck`；
  - `HeadedEnd` → 提示条改回普通，以当前光标位置为新起点；
  - `SessionEnded` → 隐藏提示条，注销停止键。
  - 托盘菜单「停止桌面操作」→ `Stop("button")`。
- runner 重启时，守卫回到初始状态，提示条隐藏。

- [ ] **Step 1：写失败测试**（`desktop_guard.rs` 的 `#[cfg(test)]`）：
  - `lines_parse_into_events_and_junk_is_ignored`
  - `a_session_shows_the_banner_and_registers_the_hotkey_then_hides_and_unregisters`
  - `headed_pauses_the_mouse_check_acks_and_rebaselines_after`：`HeadedBegin` 期间光标移动不产生 `Stop`；`HeadedEnd` 之后以新位置为起点，移动 2 px 不停，移动 3 px 回 `Stop("mouse")`。
  - `no_session_no_polling`
  - `control_lines_are_the_runner_s_json`
  - `the_banner_text_is_the_spec_s`：`BANNER_TEXT` 等于规格 §5 原文。
  - `sidecar.rs`：`the_runner_gets_a_piped_stdin_and_the_control_flag`。
- [ ] **Step 2：运行** `cd openbot/desktop-device/src-tauri && cargo test --locked`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**同一命令；推送后 CI 的 `device-shell`（三个平台）和 `device-bundle-*` 全部通过。
- [ ] **Step 5：提交并开 PR-5b**（5 个文件），提交信息为 `设备端：桌面会话的置顶提示条与 runner 控制通道`。

### Task 15：设备端应用：停止键与动鼠标即停

**文件：**
- 修改：`openbot/desktop-device/src-tauri/Cargo.toml`：`tauri-plugin-global-shortcut = "=<与锁里的 tauri 2.11.5 兼容的 2.x 版本>"`，写明 `# MIT OR Apache-2.0`。
- 修改：`openbot/desktop-device/src-tauri/Cargo.lock`
- 修改：`openbot/desktop-device/src-tauri/src/main.rs`：注册插件；`RegisterHotkey` 和 `UnregisterHotkey` 接到插件上；光标检测线程。
- 修改：`openbot/desktop-device/src-tauri/src/desktop_guard.rs`：`pub const STOP_SHORTCUT`，以及 `pub fn stop_shortcut() -> Shortcut`（`Modifiers::CONTROL | Modifiers::ALT` 加 `Code::Escape`）。

**接口与规则：**
- 停止键只在有会话时注册，会话结束就注销，平时不占用 Ctrl+Alt+Esc。按下时发 `Stop("hotkey")`。注册失败（被别的程序占用）时，结束会话，托盘提示「停止键被占用，桌面操作已停止。」
- 光标检测：一个线程，`is_polling()` 为真时每 `250` ms 用 `AppHandle::cursor_position()` 读一次光标，交给 `on_cursor`；为假时睡 250 ms 什么都不做。Linux 上不启动这个线程（Linux 没有写动作）。
- 版本选择：先用 `cargo search tauri-plugin-global-shortcut` 和 `cargo tree` 确认它不会把锁里的 `tauri` 升到别的版本；`cargo metadata` 确认它和它新带进来的依赖全部是 MIT / Apache-2.0 / BSD / ISC / Zlib 之一，结果写进 PR 描述。

- [ ] **Step 1：写失败测试**（Rust）：`the_stop_shortcut_is_ctrl_alt_escape`；`polling_runs_only_during_a_session_outside_headed`（用 `Guard` 和假光标序列，确认 `on_cursor` 只在应当检测时被调用）。
- [ ] **Step 2：运行** `cargo test --locked`，预期失败。
- [ ] **Step 3：实现**，用 `cargo update -p tauri-plugin-global-shortcut --precise <版本>` 只更新这一个包。
- [ ] **Step 4：运行** `cargo test --locked`；推送后 CI 的 `device-shell` 和三个 `device-bundle-*` 都通过；`git diff --stat Cargo.lock` 只多出这个插件和它的依赖，`tauri` 版本不变。
- [ ] **Step 5：提交并开 PR-5c**（4 个文件），提交信息为 `设备端：桌面会话的停止键（Ctrl+Alt+Esc）与动鼠标即停`。

### Task 16：服务器：桌面会话审批与令牌

**文件：**
- 新建：`openbot/server/src/computer/desktop-session.ts`
- 新建：`openbot/server/src/computer/desktop-write.ts`：写动作的公共闸门，本任务只有闸门，具体写动作在 Task 22。
- 修改：`openbot/server/src/approvals/desktop-policy.ts`：`desktopSessionFloor`。
- 修改：`openbot/server/src/approvals/policy.ts`、`types.ts`（插入点见「共享文件」）。
- 修改：`openbot/server/src/devices/socket.ts`：心跳里的 `desktopStopped` 交给 `options.onDesktopStopped?.(target, info)`。
- 测试：`openbot/server/tests/desktop-session.test.ts`
- 修改：`openbot/scripts/ci/server-tests.list.txt`

**接口：**
```ts
// types.ts
export type DesktopWriteAction = "click" | "type" | "key" | "focus" | "launch" | "clipboard_read" | "clipboard_write";
export type ApprovalSubject = { /* 现有字段 */
  /** 桌面写动作（第 2 期），只来自网关。session 为服务器所知的会话状态，从不来自模型参数。 */
  desktopWrite?: { session: "active" | "none"; action: DesktopWriteAction; title?: string; process?: string;
    control?: { type: string; name: string } | null /* null：没能确认 */; keys?: string; newlineInSingleLine?: boolean } };
// ApprovalPolicyOutcome.source 加 "desktop_session" | "desktop_action"
// desktop-policy.ts
export const DESKTOP_SESSION_TOOL = "computer_desktop_session";
export const DESKTOP_SESSION_REASON: string; // 设计决定 13 的「开会话」原文
export function desktopSessionFloor(candidate: ApprovalCandidate): { source: "desktop_session"; reason: string } | undefined; // desktopWrite.session === "none"
export function activeDesktopSession(candidate: ApprovalCandidate): boolean;
// desktop-session.ts
export type DesktopSessionStatus = { writable: boolean; reason?: string; platform?: DesktopPlatform; session?: { token: string } };
export type DesktopSessionCache = { get(key: string): string | undefined; set(key: string, token: string): void; touch(key: string): void; drop(key: string): void };
export function createDesktopSessionCache(opts?: { now?: () => number }): DesktopSessionCache; // 闲置 900_000、总长 3_600_000 后视为没有
export function mintDesktopSessionToken(): string; // randomBytes(32).toString("hex")
// desktop-write.ts
export type DesktopWriteGate = {
  /** 先早拒（禁用、团队上限 never）；再问 session_status（不可写就拒）；带 subject.desktopWrite 走 govern；
   *  放行后：会话为 none 就生成令牌并发 session_start；最后 send(token, approved)。approved 表示这一步是被底线抬成询问之后批准的。 */
  run<T>(toolName: string, botId: string, actor: ActionActor, input: { action: DesktopWriteAction; windowId?: string; ref?: string;
    subject: Omit<NonNullable<ApprovalSubject["desktopWrite"]>, "session">; signal?: AbortSignal },
    send: (session: string, approved: boolean) => Promise<T>): Promise<T>;
};
export function createDesktopWriteGate(deps: { resolveDevice; approvalRefusal; govern; post: DesktopPost; sessions: DesktopSessionCache }): DesktopWriteGate;
```
- `policy.ts`：
  - `floor` 链尾在 `desktopFloor(candidate)` 之后接 `?? desktopSessionFloor(candidate)`；
  - `decideByRules` 之后加一步：`decided.behaviour === "ask" && decided.source === "default" && activeDesktopSession(candidate)` 时，改为 `{ behaviour: "allow", source: "desktop_session", reason: "桌面会话进行中。" }`；
  - 其它都不动。
- 设备回 `stopped`、`session_expired` 或 `no_session` 的文案时：闸门清掉缓存，原样把错误交给调用方，不自动开新会话。
- `socket.ts` 的回调由组装处接到网关：清掉对应的会话缓存，并写一行审计，`action` 为 `computer_desktop_session`，`decision` 为拒绝，`reason` 为「用户已停止桌面操作」，带叫停方式。

- [ ] **Step 1：写失败测试** `desktop-session.test.ts`（照 `approvals-desktop-policy.test.ts` 和 `desktop-gateway.test.ts` 的搭法）：
  - 策略：
    - `with no session a desktop write asks once only, naming the mouse`：`behaviour: "ask"`，`source: "desktop_session"`，`reason` 含「必要时会移动你的鼠标」（只给「允许一次」由 Task 17 的 `ONCE_ONLY_SOURCES` 保证并测试）。
    - `in a session the ask-before-changes default lets a write through`：来源为 `desktop_session`。
    - `in a session an explicit ask rule still asks; a team deny still refuses outright`
    - `desktopWrite in the model's args is ignored`
  - 闸门（`send` 是测试动作）：
    - `the first write asks, then mints a 64-hex token and starts the session before sending`：`post` 的顺序依次为 `/desktop/session_status`、`/desktop/session_start`、动作；`send` 收到的令牌就是 `session_start` 里那个。
    - `a second write in the session sends at once with the same token, no card`
    - `a replica that does not know the session asks the device and uses its token`
    - `a non-writable device is refused before any card`：Linux 的文案；`approvalGate` 没有收到任何请求。
    - `a device that answers stopped drops the cache and the next write asks again`
    - `someone other than the owner is refused and nothing is sent`
    - `a heartbeat's desktopStopped drops the session and writes one audit row`
- [ ] **Step 2：运行** `cd openbot/server && bun test tests/desktop-session.test.ts`，预期失败。
- [ ] **Step 3：实现**，然后 `cd openbot && bun scripts/ci/server-shards.mjs --write`。
- [ ] **Step 4：运行**同一测试，再跑 `tests/approvals-policy.test.ts`、`tests/approvals-desktop-policy.test.ts`、`tests/desktop-gateway.test.ts`、`bun run typecheck`、`cd openbot && bunx biome lint --error-on-warnings .`。预期通过，失败数不多于 `docs/acceptance/BASELINE-FAILURES.md` 的基线。
- [ ] **Step 5：提交并开 PR-5d**（8 个文件），提交信息为 `服务器：桌面会话审批与短期令牌（设备端为准）`。

## PR-6：服务器策略

### Task 17：逐次审批、按键分类、团队上限

**文件：**
- 修改：`openbot/shared/desktop-control.ts`：
  - `DEFAULT_DESKTOP_ACTION_WORDS`（设计决定 11 的 17 个词）；
  - `desktopWordHit(text, words)`（中文按子串、ASCII 按整词）；
  - `classifyDesktopKeys(keys)`；
  - `DESKTOP_KEYS` 语法正则；
  - `textMaxBytes`；
  - 错误码 `system_keys`、`needs_approval`、`password_field`、`not_foreground`。
- 修改：`openbot/shared/desktop-control.test.ts`
- 修改：`openbot/server/src/approvals/desktop-policy.ts`：`desktopActionFloor`、`desktopActionReason`。
- 修改：`openbot/server/src/approvals/policy.ts`：链尾接 `?? desktopActionFloor(candidate, input.desktopActionWords ?? DEFAULT_DESKTOP_ACTION_WORDS)`；`decideAction` 的输入加 `desktopActionWords?: readonly string[]`；`isRunnerCommand` 认 `subject.desktopWrite`（团队上限：`never` 直接拒，`ask` 至少问）。
- 修改：`openbot/shared/standing-rule.ts`：`ONCE_ONLY_SOURCES` 加 `desktop_session`、`desktop_action`。
- 测试：`openbot/server/tests/approvals-desktop-write.test.ts`

**接口：**
```ts
export type DesktopKeyClass = { kind: "system" | "close" | "submit" | "plain"; normalized: string; force: boolean };
export function classifyDesktopKeys(keys: string): DesktopKeyClass | undefined; // 语法不对回 undefined；规则见设计决定 10
export function desktopWordHit(text: string, words: readonly string[]): string | undefined;
export function desktopActionFloor(candidate: ApprovalCandidate, words: readonly string[]): { source: "desktop_action"; reason: string } | undefined;
```
- `desktopActionFloor` 依次判断，命中第一条就回（理由照设计决定 13；会话为 none 时，理由前面接上开会话那句）：
  1. 标题命中 `DESKTOP_WINDOW_WORDS`（任何写动作）；
  2. `clipboard_read`；
  3. `control === null`（控件不明）；
  4. `click` 的控件名命中动作词；
  5. `key` 为 `close` 或 `submit`；
  6. `type` 带 `newlineInSingleLine`。
- 系统键不进审批：网关在调用 `govern` 之前就用 `system_keys` 拒绝（Task 22）。本任务只提供分类。

- [ ] **Step 1：写失败测试**：
  - shared：
    - `classifyDesktopKeys`：`win+r`、`WIN+R`、`ctrl+win+r`、`cmd+space`、`ctrl+alt+delete` 为 system；`alt+f4` 为 close，`force: true`；`cmd+w` 为 close，`force: false`；`enter`、`ctrl+enter`、`cmd+return` 为 submit；`shift+enter`、`ctrl+s`、`pagedown` 为 plain；`ctrl+alt+shift+cmd+x`（4 个修饰键）、`ctrl+`、`f13` 为 undefined。
    - `desktopWordHit`：「发送(S)」命中「发送」；`Display` 不命中 `pay`；`Pay now` 命中 `pay`；`DELETE` 命中 `delete`。
  - server：
    - `clicking 发送 asks once only, naming window and control`：`reason` 等于「在窗口「微信」里点击「发送」：控件名含「发送」，需要你批准。」
    - `every write in a window titled 招商银行 asks, even in a session`
    - `reading the clipboard always asks`
    - `an unknown control asks`
    - `enter asks; shift+enter does not`
    - `alt+f4 asks as closing a program`
    - `a newline into a single-line field asks as a submit`
    - `with no session and a word hit there is one card, source desktop_action, both reasons`
    - `the team cap: never refuses every desktop write outright, ask asks`
    - `a team word list replaces the default`：传 `desktopActionWords: ["归档"]` 时，「归档」问，「发送」不问。
  - server：`both desktop sources are once only`：`offersStandingRule({ policy: { source: "desktop_session" } })` 与 `desktop_action` 都为 false。
- [ ] **Step 2：运行** `cd openbot && bun test shared/desktop-control.test.ts`、`cd openbot/server && bun test tests/approvals-desktop-write.test.ts`，预期失败。
- [ ] **Step 3：实现**；用 `server-shards.mjs --write` 登记测试。
- [ ] **Step 4：运行**：上面两条命令，再加 `tests/approvals-policy.test.ts`，预期全部通过。
- [ ] **Step 5：提交并开 PR-6a**（7 个文件），提交信息为 `审批：桌面逐次审批（敏感控件、提交键、关闭键、剪贴板）、系统键分类、团队上限`。

### Task 18：团队敏感词表：存储

**文件：**
- 新建：`openbot/server/recovery/recovery-20261018-v1/sql/<下一个空号，目前为 0202>_desktop_action_words.sql`：`ALTER TABLE approval_team_settings ADD COLUMN desktop_action_words text[]`，可空，不加默认值。
- 修改：同目录 `meta/` 下的快照和日志（按仓库现有迁移流程生成，不手写）。
- 修改：`openbot/server/src/db/schema/approvals.ts`：`desktopActionWords: text("desktop_action_words").array()`。
- 修改：`openbot/server/src/approvals/store.ts`：团队设置的读写带上 `desktopActionWords: string[] | null`。
- 测试：`openbot/server/tests/approvals-team-desktop-words.integration.test.ts`

**规则：**
- 写入前规范化：去掉首尾空白、去掉空串和重复项；每个词 1～20 个字符，最多 50 个，超出就拒绝；`null` 表示用默认表。
- 不新增表，不改 RLS 策略：列在已有的团队设置表上，沿用它的策略。

- [ ] **Step 1：写失败测试**（真实 PostgreSQL，`afterAll` 关连接池）：
  - `a fresh team has no list (null) and uses the default`
  - `a list is saved normalised and read back`
  - `more than 50 words or a 21-character word is refused`
  - `another tenant cannot read or write this team's list`（照现有团队设置 RLS 测试的写法）
- [ ] **Step 2：运行** `cd openbot/server && bun test tests/approvals-team-desktop-words.integration.test.ts`，预期失败。
- [ ] **Step 3：实现**，然后 `server-shards.mjs --write`。
- [ ] **Step 4：运行**同一测试，再跑迁移检查（与现有迁移 PR 相同的命令），预期通过。
- [ ] **Step 5：提交并开 PR-6b**，提交信息为 `数据库：团队桌面逐次审批敏感词表（可空，空为默认表）`。

### Task 19：团队敏感词表：接口与管理页

**文件：**
- 修改：`openbot/server/src/approvals/routes.ts`：团队设置的 PATCH 加 `desktopActionWords: z.array(z.string().min(1).max(20)).max(50).nullable().optional()`，沿用现有的管理员闸门。
- 修改：`openbot/server/src/approvals/service.ts`：三处调用 `decideAction`（`hostCommandsCap` 出现的地方）同时传 `desktopActionWords: team.desktopActionWords ?? undefined`。
- 修改：`openbot/app/src/components/approvals/team-settings.tsx`：新增「桌面逐次审批的词」，一个多行文本框（每行一个词），下面有「恢复默认」按钮，并说明「员工在电脑上点击名字含这些词的按钮时，每次都要你批准」。
- 测试：`openbot/server/tests/approvals-team-desktop-words.integration.test.ts`（追加）、`openbot/app/tests/team-settings.test.tsx`（追加；没有这个文件就新建）

- [ ] **Step 1：写失败测试**：
  - `only an admin can change the list; a member gets 403`
  - `a saved list reaches the gate: clicking 归档 asks after saving ["归档"]`
  - app：`the box shows the default words when none is saved, and 恢复默认 sends null`
- [ ] **Step 2–4：运行、实现、再运行**（命令同上，加 `cd openbot/app && bun test tests/team-settings.test.tsx`）。
- [ ] **Step 5：提交并开 PR-6c**，提交信息为 `服务器/管理页：团队可改桌面逐次审批的词`。

### Task 20：权限页「操作桌面」

**文件：**
- 修改：`openbot/app/src/components/bot-profile/permissions.tsx`：
  - `BUILT_IN_TOOLS` 的条目类型加 `modes?: EmployeeToolMode[]`；
  - 在「查看桌面」之后加 `{ ref: "computer_desktop_session", label: "操作桌面", modes: ["ask", "disabled"] }`；
  - 桌面三行下面加提示「Linux 电脑目前只能查看（试用）。」
- 修改：`openbot/app/tests/employee-permissions.test.tsx`
- 修改：`openbot/server/src/approvals/service.ts`：`setEmployeeToolMode` 对 `computer_desktop_session` 选 `direct` 时，抛 `ApprovalRefusedError("操作桌面每次开始前都要你批准，不能设为直接。")`。
- 修改：`openbot/server/src/computer/headless-tools.ts`：`disabled("computer_desktop_session")` 为真时，桌面写工具一个都不加（Task 23 加工具时依赖这条）。
- 测试：`openbot/server/tests/approvals-desktop-write.test.ts`（追加）
- 修改：`openbot/app/src/lib/approvals.ts`：`POLICY_SOURCE_LABELS` 加 `desktop_session: "桌面会话"`、`desktop_action: "桌面操作"`。
- 修改：`openbot/app/tests/approvals-rules.test.tsx`

- [ ] **Step 1：写失败测试**：
  - app：`操作桌面 offers only 询问 and 禁用; 禁用 sends { toolRef: "computer_desktop_session", mode: "disabled" }`
  - app：`the Linux trial hint is shown under the desktop rows`
  - app：`desktop requests name 桌面会话 and 桌面操作`（照 `ownerAsked` 的写法，断言页面出现 `（来源：桌面会话）`）
  - server：`direct is refused for computer_desktop_session`
  - server：`a disabled session row disables every desktop write`：`decideAction` 对写动作的 candidate，经早拒检查得到拒绝。
- [ ] **Step 2–4：运行、实现、再运行。**
- [ ] **Step 5：提交并开 PR-6d**，提交信息为 `权限页：操作桌面（询问 / 禁用），Linux 标试用`。

## PR-7：macOS 写动作

### Task 21：设备端：点击、输入、按键、切换窗口

**文件：**
- 新建：`openbot/runner/src/desktop/ad-write.ts`
- 修改：`openbot/runner/src/desktop/actions.ts`：接上四个写动作。
- 修改：`openbot/shared/desktop-control.ts`：`DESKTOP_ACTIONS` 加 `desktop.click`、`desktop.type`、`desktop.key`、`desktop.focus`；加错误码 `outcome_unknown`；加载荷类型。
- 修改：`openbot/runner/tests/fixtures/fake-agent-desktop.ts`：能按脚本回写动作的信封。
- 测试：`openbot/runner/tests/ad-write.test.ts`、`openbot/shared/desktop-control.test.ts`

**接口：**
```ts
// shared
export type DesktopWriteCommon = { session: string; botId: string; actorId: string; approved: boolean; actionWords: string[] };
export type DesktopWritePayload = DesktopWriteCommon & (
  | { ref: string }                                          // desktop.click
  | { ref: string; text: string; mode: "replace" | "append" } // desktop.type
  | { windowId: string; keys: string }                       // desktop.key
  | { windowId: string } );                                  // desktop.focus
export type DesktopWriteOutput = { physical: boolean; durationMs: number; delivery: "verified" | "unverified";
  window: { windowId: string; title: string; process: string }; control?: { type: string; name: string } };
// ad-write.ts
export function createAgentDesktopWriter(opts: { cli: AgentDesktopCli; reader: AgentDesktopReader; sessions: DesktopSessions;
  control: ControlChannel; platform: DesktopPlatform; now?: () => number }): (action: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<ActionOutcome>;
```
- 一个写动作的步骤，按顺序：
  1. 平台：Linux 回 `read_only_linux`；legacy Windows 回 `read_only_windows`，都不调用随附程序。
  2. 会话：`sessions.check` 不是 `ok` 时，回对应文案（`stopped` / `session_expired` / `no_session`）。
  3. 编号：`reader.resolveRef(ref)` 回 `stale` 时，回「界面已变化，请重新读取窗口。」；回 `not_actionable` 时，回 `not_actionable` 的文案。
  4. 当场核对：用 `list-windows` 取实时标题。没有 `approved` 时，以下任何一条命中就回 `needs_approval`，详情写原因：
     - 标题命中窗口词；
     - 控件名命中 `actionWords`（只看 click）；
     - 按键为 close 或 submit；
     - 单行框里的文字带换行；
     - 窗口在这次读取之后才刚变成敏感标题（规格 §5）。
  5. 限制：type 的目标是密码框，回 `password_field`；按键为 system，回 `system_keys`；按键语法不对，回 `failed`；文字超过 `9_000` 字节，回 `failed`，详情「文字太长」。
  6. 执行（全部用 `sessions.signal` 加调用方的 `signal`）：
     - click：先 `click <adRef>`；只有 `notDelivered` 时，才经 `control.headed` 执行 `--headed click <adRef>`。
     - type：照设计决定 12。
     - key：先用 `list-windows` 确认目标的 `is_focused`，不是就回 `not_foreground`；然后 `press <转换后的键> --window-id <adWindowId>`。只有分类结果 `force: true` 且 `approved` 时才带 `--force`。`physical` 记 true。
     - focus：`focus-window --window-id <id>`；回 `POLICY_DENIED` 时，按 Task 1 FACTS (d) 改用 `--headed`。
  7. 成功：`reader.invalidate(windowId)`，`sessions.check` 续期，结果为 `DesktopWriteOutput`，并带一句给模型的提示：「The window may have changed: read it again before the next step.」
  8. 失败：`notDelivered` 的失败照 Task 8 的错误映射；超时、中止、或者已送达而无法确认的失败，回 `outcome_unknown`，并带 `outcomeUnknown: true`，不重试。

- [ ] **Step 1：写失败测试** `ad-write.test.ts`（假 CLI、内存会话、假通道）：
  - `linux and legacy windows refuse without running anything`
  - `no session, a stopped one or an expired one is refused with its copy`
  - `a ref from an older snapshot is stale and never reaches the binary`
  - `the device refuses a sensitive click it was not told was approved`：控件名「发送」、`approved: false`，回 `needs_approval`，假 CLI 的日志里没有 `click`。
  - `a title that turned sensitive since the read is refused`
  - `a password field is refused for type`
  - `click falls back to --headed only after not_delivered, inside headed-begin/ack/end`：假通道里事件的顺序为 begin、ack、end；输出的 `physical` 为 true。
  - `click after a delivered-but-unverified failure is outcome_unknown and never retried`：日志里只有一条 `click`。
  - `type replace uses set-value --stdin with the exact bytes; append uses type then --headed type`
  - `type with CR LF into a single-line field needs approval; approved, it goes through`
  - `key: enter without approval is needs_approval; alt+f4 approved carries --force; ctrl+s never does; win+r is system_keys`
  - `key to a window that is not in front is not_foreground and nothing is pressed`
  - `a stop during the action aborts it and the outcome is unknown`
  - `success invalidates that window's refs`
  - `writes are serial with reads`：读和写并发调用时，假 CLI 的日志里两个进程不重叠。
  - shared：`DESKTOP_ACTIONS` 精确等于 9 个动作。
- [ ] **Step 2–4：运行**（`cd openbot/runner && bun test tests/ad-write.test.ts`）、实现、再运行，然后跑 `bun test && bun run typecheck`。
- [ ] **Step 5：提交并开 PR-7a**（6 个文件），提交信息为 `runner：桌面点击、输入、按键、切换窗口（会话内、严格编号、设备端再核对）`。

### Task 22：服务器：写动作网关与审计

**文件：**
- 修改：`openbot/server/src/computer/desktop-write.ts`：四个方法。
- 修改：`openbot/server/src/computer/desktop-state.ts`：控件缓存。
- 修改：`openbot/server/src/computer/desktop-gateway.ts`：读到快照后交给控件缓存。
- 修改：`openbot/server/src/computer/gateway.ts`（插入点见「共享文件」）。
- 测试：`openbot/server/tests/desktop-write.test.ts`

**接口：**
```ts
// desktop-state.ts
export type DesktopControlEntry = { windowId: string; type: string; name: string; password?: true; singleLine?: true };
export type DesktopControlCache = { rememberSnapshot(key: string, snapshot: DesktopSnapshot): void; control(key: string, ref: string): DesktopControlEntry | undefined; forgetWindow(key: string, windowId: string): void };
export function createDesktopControlCache(options?: { now?: () => number; ttlMs?: number /* 300_000 */; limit?: number /* 1000 */ }): DesktopControlCache;
// desktop-write.ts
export type DesktopWriteResult = { ok: true; physical: boolean; window: { windowId: string; title: string; process: string }; control?: { type: string; name: string }; note: string };
export function createDesktopWriteMethods(deps: { gate: DesktopWriteGate; windows: DesktopWindowCache; controls: DesktopControlCache; actionWords: () => Promise<readonly string[]>; post: DesktopPost }): {
  clickDesktop(botId: string, actor: ActionActor, input: { ref: string }, signal?: AbortSignal): Promise<DesktopWriteResult>;
  typeDesktop(botId: string, actor: ActionActor, input: { ref: string; text: string; mode: "replace" | "append" }, signal?: AbortSignal): Promise<DesktopWriteResult>;
  pressDesktopKey(botId: string, actor: ActionActor, input: { windowId: string; keys: string }, signal?: AbortSignal): Promise<DesktopWriteResult>;
  focusDesktopWindow(botId: string, actor: ActionActor, input: { windowId: string }, signal?: AbortSignal): Promise<DesktopWriteResult>;
};
```
- 规则：
  - 进 `gate.run` 之前就拒绝的情况（各写一行拒绝审计）：
    - 按键语法不对、或者是系统键：`system_keys`；
    - 文字超过 `9_000` 字节：「文字太长，最多 9000 字节。」
  - `subject.desktopWrite` 的来源：`title`、`process` 来自窗口缓存，缺失时重取一次窗口列表；`control` 来自控件缓存，缺失时为 `null`；`newlineInSingleLine` 为 `/[\r\n]/.test(text) && control?.singleLine`。
  - 发给设备的载荷 `actionWords` 来自 `deps.actionWords()`（团队表，没有就是默认表）。
  - 成功后：`controls.forgetWindow`，`sessions.touch`。
  - `intentOf`：四个写工具回 `"write"`。
- 审计行（`gateway.ts` 的 `desktopRow` 扩展）：
  - 写字段 `desktop: { windowId, title, process, control?: {type,name}, action, keys?, textLength?, physical?, delivery?, durationMs? }`；
  - **不带 `text`**：`args` 交给 `govern` 时，把 `text` 换成 `textLength`。
  - 审批卡片的 `args` 保留文字，主人要看到要发出去的内容（设计决定 14 的同一处）。

- [ ] **Step 1：写失败测试** `desktop-write.test.ts`（照 `desktop-gateway.test.ts` 搭网关，传假 transport 和假 approvalGate）：
  - `a click on a control read in a snapshot reaches the gate with its window and control`
  - `a ref this replica never saw asks as 控件不明`
  - `win+r is refused before any card or frame`
  - `typed text never reaches audit_events, only its length; the approval card shows it`
  - `success forgets the window's controls: the next click on an old ref asks as 控件不明`
  - `the device's outcomeUnknown comes back as 不确定这一步是否已经生效…, and nothing is retried`
  - `the team's word list is sent to the device as actionWords`
  - `only the owner; a teammate is refused and nothing is sent`
  - `text over 9000 bytes is refused before any frame`
- [ ] **Step 2–4：运行**（`cd openbot/server && bun test tests/desktop-write.test.ts`）、实现、`server-shards.mjs --write`、再运行，加上 `tests/desktop-gateway.test.ts`、`tests/computer-gateway.test.ts` 和 typecheck。
- [ ] **Step 5：提交并开 PR-7b**，提交信息为 `服务器：桌面写动作网关（会话、逐次审批、只记长度的审计）`。

### Task 23：四个写工具、集成测试与探针

**文件：**
- 修改：`openbot/server/src/computer/desktop-tools.ts`：加四个工具。
- 修改：`openbot/server/src/computer/headless-tools.ts`：写工具与读工具同一处加入，并遵守 Task 20 的禁用规则。
- 新建：`openbot/server/tests/desktop-write-tools.integration.test.ts`
- 修改：`openbot/scripts/ci/desktop-probe.ts`：加写检查。
- 修改：`openbot/scripts/ci/server-tests.list.txt`

**接口：**
- 参数（`z.strictObject`）：
  - `computer_desktop_click`：`{ ref: DESKTOP_REF }`；
  - `computer_desktop_type`：`{ ref, text: z.string().min(1), mode: z.enum(["replace","append"]).default("replace") }`，再用 refine 限制字节数 ≤ `9_000`；
  - `computer_desktop_key`：`{ windowId: DESKTOP_WINDOW_ID, keys: DESKTOP_KEYS }`；
  - `computer_desktop_focus`：`{ windowId }`。
- 说明（英文），四个都写明：
  - 「Needs a desktop session: the first call asks the person, who sees a banner and can stop it by moving the mouse or pressing Ctrl+Alt+Esc. A refusal or a stop is final for that step: do not retry it in other words.」
  - 「After any change, read the window again; refs from before are refused.」
  - 「Linux computers are read-only.」
  - click：「Clicking a control named like Send, Delete or Pay asks every time.」
  - type：「Never types Enter for you; a newline into a one-line field counts as submitting. Password fields are refused: use computer_request_secret.」
  - key：「Use cmd on macOS and ctrl on Windows. Enter and Ctrl+Enter ask every time; closing a program (Alt+F4, Cmd+Q) asks; system shortcuts (Win+R, Cmd+Space, Ctrl+Alt+Del, lock, log out) are refused. The window must be in front: call computer_desktop_focus first.」
  - 读工具的说明去掉「Read-only: you cannot click…」那一句。

- [ ] **Step 1：写失败测试** `desktop-write-tools.integration.test.ts`（照现有 `desktop-tools.integration.test.ts` 搭：真实 PG、真实 socket、runner 执行器；桌面动作用假 CLI，`platform: "darwin"`，控制通道用会自动回 ack 的假通道）：
  - `the owner's run gets the four write tools; a teammate's and a catalogue Bot's get none`
  - `操作桌面 disabled: no write tool is offered and a call anyway is refused before the device`
  - `first click asks for a session; approve → session_start then click; the second click needs no card`
  - `clicking 发送 in the session asks again, once only; reject → nothing reaches the fake binary`
  - `a stop on the device makes the next write 用户已停止桌面操作…`
  - `on a Linux device the write is refused before any card`
- [ ] **Step 2：探针写检查**（只在 macOS 上执行；Linux 和 Windows 断言写动作被拒）：
  1. 通过会话动作直接开一个会话（假的控制通道由探针自己回 ack）；
  2. TextEdit 里 `desktop.type`（replace）写入「熊宝员工 写入 abc 123」，读回一致。标签：`macOS: typing Chinese reads back`。
  3. 用写之前的编号再写一次，回 `stale`。标签：`a write makes the window's refs stale`。
  4. `desktop.key cmd+s`：TextEdit 当时在前台时成功；不在前台时回 `not_foreground`。标签：`a key needs the window in front`。
  5. Linux：`desktop.type` 回「这台 Linux 电脑目前只能查看，不能操作界面。」；Windows（legacy）：回 `read_only_windows`。
- [ ] **Step 3–4：运行、实现、再运行**：集成测试（需要本地 PG）、`cd openbot/app && bun test`、server typecheck、biome；推送后 `desktop-probe` 三个平台通过。
- [ ] **Step 5：提交并开 PR-7c**，提交信息为 `服务器：computer_desktop_click / type / key / focus；探针在 macOS 上写入并读回`。

## PR-8：等待、启动、剪贴板、多显示器

### Task 24：设备端：等待、启动、剪贴板、多显示器

**文件：**
- 修改：`openbot/runner/src/desktop/ad-write.ts`（launch、两个剪贴板动作）、`ad-read.ts`（wait、显示器）。
- 修改：`openbot/shared/desktop-control.ts`：`DESKTOP_ACTIONS` 加 `desktop.wait`、`desktop.launch`、`desktop.clipboard_read`、`desktop.clipboard_write`；加 `DESKTOP_APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,63}$/u`。
- 测试：`openbot/runner/tests/ad-write.test.ts`、`ad-read.test.ts`（追加）

**规则：**
- `desktop.wait { windowId, name?, type?, timeoutSec }`：
  - 是读动作，不需要会话，读窗口的敏感词规则同 snapshot；
  - `timeoutSec` 取 1～30；
  - 命令为 `snapshot --window-id X --compact --max-depth 12 --wait-for "<type>:<name>" --wait-timeout <ms>`；
  - 成功时回一个新快照，照 Task 8 转换；超时回「等了 N 秒，没有等到这个控件。」，不是 `outcomeUnknown`。
- `desktop.launch { app }`：
  - 需要会话；`app` 必须匹配 `DESKTOP_APP_NAME`（不能带路径、参数，不能以 `-` 开头）；
  - 命令为 `launch <app>`，不带 `--activate`、`--arg`、`--env`、`--cdp`；
  - Windows 上只认 System32 或 Windows 目录下的程序名（上游规则），`APP_NOT_FOUND` 回「没有找到这个应用：<app>」。
- `desktop.clipboard_read`：
  - 需要会话；必须带 `approved: true`，否则回 `needs_approval`；
  - 命令为 `clipboard-get --format text`；返回的文字截到 `8_000` 个字符，带 `truncated`。
- `desktop.clipboard_write { text }`：需要会话；命令为 `clipboard-set --stdin`；不超过 `9_000` 字节。
- 多显示器：`windows` 已经带 `display` 和 `bounds`（Task 8）；本任务只补测试：主屏下标为 0，副屏窗口中心落在第二块屏上时为 1。

- [ ] **Step 1：写失败测试**：
  - `wait returns a fresh snapshot whose refs are the latest; timeout is not outcome-unknown`
  - `launch refuses paths and flags (/bin/sh, -x, ../a) without running anything`
  - `clipboard read without approval is needs_approval; approved returns text cut to 8000`
  - `clipboard write sends the exact bytes through stdin`
  - `a window on the second display has display 1`
  - shared：`DESKTOP_ACTIONS` 精确等于 13 个动作。
- [ ] **Step 2–4：运行、实现、再运行**（runner 全部测试加 typecheck）。
- [ ] **Step 5：提交并开 PR-8a**，提交信息为 `runner：桌面等待控件、启动应用、剪贴板读写、窗口所在显示器`。

### Task 25：服务器：等待、启动、剪贴板工具

**文件：**
- 修改：`openbot/server/src/computer/desktop-write.ts`：`launchDesktopApp`、`readDesktopClipboard`、`writeDesktopClipboard`。
- 修改：`openbot/server/src/computer/desktop-gateway.ts`：`waitDesktop`，走读的那套规则。
- 修改：`openbot/server/src/computer/gateway.ts`：接口、`intentOf`（`wait` 和 `clipboard_read` 回 `"read"`，另外两个回 `"write"`）。
- 修改：`openbot/server/src/computer/desktop-tools.ts`：四个工具。
- 测试：`openbot/server/tests/desktop-write.test.ts`、`desktop-write-tools.integration.test.ts`（追加）
- 修改：`openbot/scripts/ci/desktop-probe.ts`：macOS 上用剪贴板写、读，用 `wait` 等 TextEdit 的保存对话框出现。

**规则：**
- `computer_desktop_wait` 的参数 `{ windowId, name?: z.string().max(120), type?: z.string().max(60), timeoutSec: z.number().int().min(1).max(30) }`，`name`、`type` 至少给一个。
- `computer_desktop_clipboard_read` 的结果标为不可信内容（`withUntrustedNotice`）；审计只记 `textLength`。
- `launch` 和两个剪贴板工具都走 `gate.run`。读剪贴板总是被 `desktopActionFloor` 抬成询问。

- [ ] **Step 1：写失败测试**：
  - `reading the clipboard asks every time, even in a session, and the row has only its length`
  - `launch is governed by the team cap like a command`
  - `wait on a window titled 银行 asks like a snapshot`
  - `wait needs a name or a type`
- [ ] **Step 2–4：运行、实现、再运行**；推送后 `desktop-probe` 三个平台通过。
- [ ] **Step 5：提交并开 PR-8b**，提交信息为 `服务器：computer_desktop_wait / launch / clipboard_read / clipboard_write`。

### Task 26：发版 A（macOS 操作桌面、Linux 查看试用）

**文件：** `openbot/package.json`（下一个补丁号）、`openbot/CHANGELOG.md`、版本号所在的文件（照上一次发版）、`docs/acceptance/HUMAN-STEPS.md`（新增「桌面操作第 2 期：macOS / Linux / 多显示器真机验收」小节，步骤照规格 §10 的 macOS、多显示器和 Linux 部分原样写成可勾选的清单）。

- [ ] **Step 1**：CHANGELOG 写明：
  - Mac 上员工能点击、输入、按键、切换和启动应用、等待控件、读写剪贴板；
  - Linux 能查看（试用）；
  - 有桌面会话审批、提示条、Ctrl+Alt+Esc / ⌃⌥⎋ 和动鼠标即停；
  - 发送、删除、付款等逐次审批；团队可改敏感词表；权限页新增「操作桌面」；
  - **Windows 仍只能查看**。
- [ ] **Step 2**：提交并开 PR-8c，提交信息为 `发版：macOS 操作桌面、Linux 查看（试用）`。合入后请用户推 `device-v<版本>-rc.1` 和 `v<版本>` 两个标签。如果 Task 5 还没完成，macOS 安装包是「未签名内测版」，**不对外宣布 macOS 写动作**，在 PR 描述里写明这一点。

### Task 27：macOS / Linux / 多显示器真机验收（需要用户）

**这一步需要用户在自己的电脑上做**：按 `HUMAN-STEPS.md` 新小节逐项验收，每步截图，结果记在小节下面。

- [ ] **Step 1（用户）**：macOS 第 1～5 项照规格 §10。第 1 项包括升级一个版本之后**不用**重新授权，前提是 Task 5 已经完成，安装包是签名并公证过的。
- [ ] **Step 2（用户）**：多显示器：窗口在副屏时能列出、能读、能截图；需要真实鼠标点击的控件在副屏上点得准。
- [ ] **Step 3（用户，可选）**：Linux（GNOME，X11）上能列出窗口、能读；写动作得到「只能查看」的提示。
- [ ] **Step 4（执行代理）**：把用户的结果写进 `HUMAN-STEPS.md` 并提交。任何一项不通过，先按 superpowers:systematic-debugging 找根因再修，不改验收标准。

## PR-9：Windows 在开关后面

### Task 28：Windows：引擎开关下的写动作与引擎对比

**文件：**
- 修改：`openbot/runner/src/desktop/actions.ts`：`--desktop-compare` 用到的对比函数。
- 修改：`openbot/runner/src/index.ts`：子命令 `--desktop-compare`，会读 `--desktop-helper`。
- 修改：`openbot/desktop-device/src-tauri/src/sidecar.rs`：读环境变量 `XIONGBAO_DESKTOP_ENGINE`（再兜底 `OPENBOT_DESKTOP_ENGINE`），原样作为 `--desktop-engine` 传给 runner。
- 修改：`openbot/scripts/ci/desktop-probe.ts`：Windows 写检查。
- 修改：`openbot/scripts/ci/windows-desktop-probe.ts`：加一项两个引擎读同一个记事本窗口的对比。
- 测试：`openbot/runner/tests/desktop-compare.test.ts`

**接口：**
```ts
export type EngineComparison = { title: string; process: string; legacy: { count: number; names: string[] } | { error: string };
  agentDesktop: { count: number; names: string[] } | { error: string }; missingInAgentDesktop: string[] };
export async function compareDesktopEngines(opts: { legacy: DesktopActions; agentDesktop: DesktopActions; maxWindows?: number }): Promise<EngineComparison[]>;
// `xiongbao-runner --desktop-compare [--desktop-helper PATH]`：对当前可见的前 10 个窗口逐个读，打印一张中文表（标题、两边控件数、agent-desktop 缺少的有名字的可操作控件），不写任何文件。
```
- `missingInAgentDesktop`：旧引擎读到的、类型属于 Button / Edit / Document / MenuItem / CheckBox 且有名字的控件，在 agent-desktop 的结果里按名字找不到的那些。
- Windows 写检查（`OPENBOT_DESKTOP_ENGINE=agent-desktop`）：
  1. 记事本里用 `desktop.type`（replace，走 `set-value`）写中文，读回一致；
  2. `desktop.key ctrl+s` 之后，磁盘上的文件内容一致；
  3. 计算器里依次点击 1、2、×、3、4、=，读出 408；
  4. 记事本的 `desktop.type`（append）走 `--headed`，事件顺序为 begin、ack、end。

- [ ] **Step 1：写失败测试** `desktop-compare.test.ts`：两个假引擎，一个少一个「保存」按钮，结果的 `missingInAgentDesktop` 等于 `["保存"]`；任一边出错时，那一边是 `{ error }`，另一边照常返回。
- [ ] **Step 2–4：运行、实现、再运行**；推送后 `desktop-probe`（Windows）和 `win1-windows` 都通过。
- [ ] **Step 5：提交并开 PR-9**，提交信息为 `runner：Windows 在引擎开关下操作桌面（set-value 优先），两引擎读取对比`。

### Task 29：Windows 真机验收（需要用户）

**这一步需要用户在自己的 Windows 电脑上做。** 执行代理先在 `HUMAN-STEPS.md` 里写好小节（随 Task 30 的 PR 一起提交，或者单独提交一个只改这一个文件的提交）。

- [ ] **Step 1（用户）**：在 PowerShell 里运行 `setx XIONGBAO_DESKTOP_ENGINE agent-desktop`，然后彻底退出并重新打开设备端。
- [ ] **Step 2（用户）**：规格 §10 Windows 第 1 项：先运行 `& "<安装目录>\xiongbao-runner.exe" --desktop-compare --desktop-helper "<安装目录>\agent-desktop.exe"`，打开记事本、资源管理器、微信和一个 Electron 应用之后再运行一次，把输出贴回来。两边都要能读出关键控件。
- [ ] **Step 3（用户）**：规格 §10 Windows 第 2～6 项逐项做。第 4 项（中文输入法开着时用真实键盘输入）和第 5 项（提示条显示「正在移动鼠标」、点击后一动鼠标就停）务必截图。
- [ ] **Step 4（用户）**：明确回复「Windows 验收通过」，或者列出没通过的项。**没有这句回复，Task 30 不开始。**

## PR-10：Windows 默认切换

### Task 30：Windows 默认改用 agent-desktop；发版 B

**前提：用户已回复「Windows 验收通过」（Task 29 Step 4）。**

**文件：**
- 修改：`openbot/runner/src/desktop/actions.ts`：win32 的默认引擎改为 `agent-desktop`；`OPENBOT_DESKTOP_ENGINE=legacy` 仍然选旧读取器，旧读取器上写动作回 `read_only_windows`。
- 修改：`openbot/runner/tests/desktop-actions.test.ts`：把默认值的断言改为新值（规格要求的行为变化，设计决定 19），并加一条 `legacy is still selectable for one version`。
- 修改：`.github/workflows/ci.yml`：`desktop-probe` 的 Windows 那一行去掉 `OPENBOT_DESKTOP_ENGINE`；`win1-windows` 改为显式设 `OPENBOT_DESKTOP_ENGINE=legacy`，继续测旧读取器。
- 修改：`openbot/scripts/ci/device-release-workflow.test.mjs`：同步上一条。
- 修改：`openbot/package.json`、`openbot/CHANGELOG.md`（写明：Windows 上员工能动手；旧读取器还保留这一个版本，设置 `XIONGBAO_DESKTOP_ENGINE=legacy` 可以退回；下一版删除）、`docs/acceptance/HUMAN-STEPS.md`（记下 Task 29 的结果）。

- [ ] **Step 1–4**：照前面任务的节奏：先改断言，跑出失败，再实现，再跑 runner 全部测试和 workflow 测试；推送后 `desktop-probe`（Windows，默认引擎）和 `win1-windows`（legacy）都通过。
- [ ] **Step 5**：提交并开 PR-10a，提交信息为 `Windows 默认改用 agent-desktop 操作桌面；发版`。合入后请用户推两个标签，并提醒用户运行 `setx XIONGBAO_DESKTOP_ENGINE ""` 清掉验收时设的开关。

### Task 31：删除旧 PowerShell 读取器（再下一个版本）

**前提：Task 30 的版本已经发布，并且之后至少又发布过一个版本。**

**文件：**
- 删除：`openbot/runner/src/desktop/host.ts`、`helper.cs`、`cs.d.ts`、`openbot/runner/tests/desktop-host.test.ts`、`desktop-helper.test.ts`、`fixtures/fake-desktop-helper.ts`。
- 修改：`openbot/runner/src/desktop/actions.ts`：去掉 legacy 分支；`--desktop-engine legacy` 改为报「旧的桌面读取器已删除」。
- 修改：`openbot/scripts/ci/windows-desktop-probe.ts` 和 `windows-runner-probe.ts`：去掉旧读取器那部分检查；WIN1 的其它检查保留。

- [ ] **Step 1**：先把被删文件里的测试逐条对照，确认每一条行为在 `ad-read.test.ts`、`ad-write.test.ts` 或 `desktop-probe.ts` 里都有对应的检查（密码框不读值、旧编号作废、敏感标题、截图上限、中文往返）。缺的先补上，再删文件。
- [ ] **Step 2**：删除并修改；跑 runner 全部测试和 typecheck；推送后 WIN1 和 `desktop-probe` 都通过。
- [ ] **Step 3**：提交并开 PR-10b，提交信息为 `runner：删除旧的 PowerShell 桌面读取器`。
