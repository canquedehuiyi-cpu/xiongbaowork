# agent-desktop v1.2.0 实测事实

本文件配套同目录的样本：`macos.json`、`windows.json`、`linux.json`、`errors.json`。样本来自 GitHub Actions 上三个平台的真实运行，只做了脱敏（见文末「样本处理说明」）。

## 来源运行

| 简称 | 内容 | 链接 |
|---|---|---|
| 第 1 轮 | 三平台完整 artifact。Windows 的 `snapshot` 全部失败（DACL 问题），macOS 的密码框样本失败（`osascript display dialog` 不暴露无障碍树） | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/43181642566 |
| 第 2 轮 | 三平台作业日志。Windows 修好状态目录 DACL 后快照正常；Linux 加测了无 D-Bus 的情形 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/43182009340 |
| 第 3 轮 | macOS 改用 AppKit 样本窗口（含单行、密码、多行输入框、禁用按钮、Send 按钮） | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/43182644610 |

通用事实：三平台信封的 `version` 都是协议版本 `"2.6"`；`data.version`（`version` 命令）才是程序版本 `"1.2.0"`。样本键名在「证据」里写作 `平台.键`，例如 `windows.snapshot-password` 指 `windows.json` 里的 `snapshot-password`。

---

## (a) 密码框如何在快照里表示

答案：三平台都是 `role: "textfield"`，`states` 数组含 `"secure"`。快照里没有 `value` 字段：样本里预填的 `secret123` 在三平台的快照输出中均未出现（日志里 `HAS_SECRET_IN_SNAPSHOT=0`，第 2、3 轮日志检索 `secret123` 也是 0 处）。

- Windows：`role_description: "edit"`，`states: ["secure"]`，`native_id` 为 automation_id `pw`。可用动作 `SetValue`、`SetFocus`。
- macOS：`name: "Password"`，`states: ["secure"]`。可用动作 `Click`、`RightClick`、`SetValue`、`SetFocus`，没有 `TypeText`（单行输入框有）。
- Linux（zenity 密码对话框）：`states: ["secure", "haspopup"]`，没有 `name`。可用动作 `Click`、`SetValue`、`TypeText`、`SetFocus`。
- 对比：非密码的 textfield 会带 `value`（macOS TextEdit `"hello\n"`，Windows 写入后 `"熊宝员工"`，Linux gedit `"hello"`），密码框不带。

证据：`windows.snapshot-password`、`macos.snapshot-password`、`linux.snapshot-password`。来源：第 2 轮（Windows、Linux）、第 3 轮（macOS）。

## (b) 单行与多行输入框能否区分

答案：不能靠 `role` 或某个标记区分。三平台都是 `role: "textfield"`，没有「单行 / 多行」字段。

- Windows：单行、多行都是 `role: "textfield"` + `role_description: "edit"`，只有 `native_id`（automation_id `single` / `multi`）和 `name` 不同；`available_actions` 相同（`SetValue`、`SetFocus`）。
- macOS：多行输入框 `Multi line` 被包在 `role: "scrollarea"` 里（父节点），单行 `Single line` 不在。可用动作也略有不同（单行有 `Click`、`TypeText`；多行只有 `RightClick`、`SetValue`、`SetFocus`、`TypeText`）。这是旁证，不是标记。
- Linux：zenity 的 entry 是 `textfield`（带 `haspopup`）；gedit 正文是 `textfield`（`focused`），外层是 `scrollarea`。
- 因此调用方要靠 `name`、`native_id`，或「父节点是否为 `scrollarea`」自行判断，不能指望协议给出区分。

证据：`windows.snapshot-password`（e1、e3）、`macos.snapshot-password`（e1、e4）、`linux.snapshot`（zenity entry）、`linux.snapshot-editor`（gedit 正文）。来源：第 2 轮、第 3 轮、第 1 轮（gedit 完整快照）。

## (c) 禁用控件如何表示

答案：`states` 数组里的字符串 `"disabled"`，不是单独的布尔字段。

- Windows：`Disabled button`（e4）`states: ["disabled"]`，`available_actions` 仍列出 `Click`、`SetFocus`，也就是说禁用控件的 `available_actions` 不会被清空。
- macOS：`Disabled button`（e5）、窗口的 `Zoom`、`Minimize` 都是 `states: ["disabled"]`；`Zoom` 的 `available_actions` 仍有 `Click`、`RightClick`。
- Linux：zenity 样本窗口没有禁用控件；gedit 里有 `states` 含 `"disabled"` 的节点（按钮、菜单项、scrollbar、column），但这些节点同时带 `offscreen` 或 `hidden`。所以 Linux 的「禁用」证据只来自 gedit，且都在不可见节点上。
- 可见性类状态也在同一个数组里：`offscreen`、`hidden`、`focused`、`modal`、`haspopup`、`selected`。

证据：`windows.snapshot-password`（e4）、`macos.snapshot-password`（e5、e8、e9）、`linux.snapshot-editor`（两个 `menuitem` “No items found”，`states: ["disabled","hidden"]`；完整快照见第 1 轮 artifact `linux-snapshot.json`）。来源：第 2、3、1 轮。

## (d) Windows 无头 `focus-window --window-id` 是否成功

答案：成功。三平台都是 `ok: true`，`data` 为 `{ focused: { 窗口对象 } }`，不会回 `POLICY_DENIED`。加不加 `--headed` 结果相同。

- 窗口对象字段：`accessible`、`app_name`、`bounds`、`id`、`is_focused`、`minimized`（macOS 没有此字段，见 (j)）、`pid`、`process_instance`、`title`、`visible`。
- 关窗之后再 `focus-window` 回 `WINDOW_NOT_FOUND`，message 为 `No matching window found`（注意与 `snapshot` 的 `No window with id …` 措辞不同）。

证据：第 2 轮日志 `windows-focus-window`、`windows-focus-window-headed`；第 3 轮日志 `macos-focus-window`、`macos-focus-window-headed`；第 2 轮日志 `linux-focus-window`、`linux-focus-window-headed`。样本未单独收录 focus-window 信封。

## (e) `screenshot --window-id X` 不给路径的返回

答案：`data` 恰好 5 个键：`data`（base64 PNG）、`format`（`"png"`）、`width`、`height`、`scale_factor`（浮点，三平台实测 `1.0`）。信封键为 `version`、`ok`、`command`、`data`。

- 宽高是窗口像素：Windows 506×353，macOS 785×551，Linux 910×756。
- macOS 需要「屏幕录制」授权（`permissions` 里 `screen_recording: granted`）；Linux、Windows 的 `screen_recording` 是 `not_required`。
- 样本里的 `data` 已替换成 1×1 PNG，其它字段原样。

证据：`windows.screenshot`、`macos.screenshot`、`linux.screenshot`。来源：第 1 轮完整 artifact（第 2、3 轮日志里的截图输出被截到 6000 字符，不完整，但 `SCREENSHOT_KEYS` 汇总行与第 1 轮一致）。

## (f) `version` 命令

答案：信封 `version` 为协议版本 `"2.6"`，`data` 为 `{ os, target, version: "1.2.0" }`。

- `os`：`"windows"`、`"macos"`、`"linux"`；`target`：Windows `x86_64`，macOS `aarch64`，Linux `x86_64`。
- `agent-desktop --version`（全局标志）不是 JSON，只输出纯文本一行 `agent-desktop 1.2.0`。

证据：`windows.version`、`macos.version`、`linux.version`；`--version` 见第 2、3 轮日志 `*-version-flag`。

## (g) `press` 的键名

答案：`press --help` 本身没有键名表，只有一句示例：`Key combo: return, escape, cmd+c, shift+tab ...`。三平台帮助文本逐字相同（Windows 的 `Usage` 行多了 `.exe`）。与协调者预期不符，见「其它发现」。

`press --help` 的选项摘录（原样）：

```
Usage: agent-desktop press [OPTIONS] <COMBO>
  <COMBO>  Key combo: return, escape, cmd+c, shift+tab ...
      --app <APP>                      Target application name; keys go to its process without focusing it (--headed focuses its window first)
      --window-id <WINDOW_ID>          Target the application instance that owns this window (from list-windows); use it when several instances share one name
      --force                          Send the combo even if the adapter flags it as a dangerous shortcut
      --headed                         Prefer physical delivery for natural input commands and permit focus/cursor side effects. Default is strict headless semantic delivery.
```

补充（不是 CI 实测，来自 npm 包 `agent-desktop@1.2.0` 二进制内嵌的技能文档，读自 `registry.npmjs.org` 的 tarball）：

- 通用：`return`、`escape`、`tab`、`space`、`delete`（即退格）、`up`、`down`、`left`、`right`、`f1` 到 `f12`；修饰键 `cmd`/`meta`、`ctrl`、`alt`、`shift`，用 `+` 连接。
- Linux 另有：`home`、`end`、`pageup`、`pagedown`、`insert`、`f1`-`f24`、`forwarddelete`（向前删除）、`backspace`，标点名（`comma`、`period`、`greater`、`leftbracket`），以及 X keysym 名（如 `Page_Up`）。单个字符本身就是一个键；单独的大写字母（`H`）等于 `shift+h`。
- macOS：主修饰键是 `cmd`；标点既可写符号也可写名字（`comma`、`period`、`slash`、`semicolon`、`quote`、`leftbracket`、`rightbracket`、`backslash`、`minus`、`equal`、`grave`）。
- Windows：`cmd` 与 `meta` 指 Windows 键，复制要写 `ctrl+c`。
- 被拦截的危险组合：返回 `POLICY_DENIED`、`not_delivered`，加 `--force` 才发送。实测 `alt+f4`（Windows、Linux）与 `cmd+q`（macOS）都被拦。文档里 Windows 列表为 `alt+f4`、`win+l`、`win+d`、`alt+tab`、`win+r`、`win+x`、`win+e`、`ctrl+shift+esc`；Linux 列表为 `alt+f4`、`alt+tab`、`alt+f2`、`meta+l`、`meta+d`、`meta+tab`、单独的 `super`、`ctrl+alt+t`、`ctrl+alt+delete`、`ctrl+alt+backspace`、`ctrl+alt+l`、`ctrl+alt+f1` 到 `f12`。`ctrl+q` 这类应用快捷键不拦。

证据：第 2、3 轮日志 `*-help-press`；第 1 轮 artifact `*-help-press.json`；`errors.POLICY_DENIED`。

## (h) 未建会话时的状态目录

答案：状态目录（`status` 的 `state_root`）里有：

- `latest_snapshot_id`（文本，内容是最近一个快照 id）；
- `refstore.lock`（空文件）；
- `snapshots/<快照 id>/refmap.json`，每次 `snapshot` 一个目录；
- Linux 另有 `.x11-cursor.lock`（macOS、Windows 没有这个文件）。

没有 trace 目录（三平台日志里 `TRACE_DIR=0`，`status` 里 `tracing: false`）。

`refmap.json` 的形状是 `{"inner": {"@eN": {...}}}`，每个条目含 `pid`、`process_instance`、`role`、`name`、`unique_at_capture`、`bounds_hash`、`states`、`available_actions`、`source_app`、`source_window_id`、`source_window_title`、`source_window_bounds_hash`、`path`，视平台还有 `native_id`、`retained_object`、`bounds`、`value`。

refmap 里有控件名：Linux 5 个快照目录检出（`STATE_HAS_CONTROL_NAMES=5`）、Windows 第 2 轮 4 个、macOS 第 3 轮 2 个；Windows、macOS 第 1 轮是 0，原因是当时快照本身失败，没有生成有内容的 refmap。

密码框在 refmap 里同样没有 `value`（Windows e2、macOS e2 的条目只有 `states: ["secure"]`），但非密码输入框的 `value` 会被存进 refmap（见「其它发现」）。

证据：第 1 轮 artifact `art/{linux,macos}/ad-home/`；第 2 轮日志 Windows 状态目录清单；第 3 轮日志 macOS 清单。`status` 样本见 `*.status`（`state_root` 已改成通用路径）。

## (i) 关窗后用旧编号写动作

答案：全部返回 `ok: false`，`disposition` 为 `{ delivery: "not_delivered", retry: "safe" }`，错误码因平台而异：

| 平台 | 命令 | 错误码 | 说明 |
|---|---|---|---|
| macOS | `click`、`type` | `STALE_REF` | `Saved target belongs to a process instance that is no longer running`；`details.process_state: "exited"`；`recovery.requires_fresh_snapshot: true` |
| Windows | `click`、`type` | `WINDOW_NOT_FOUND` | `No window with id w-66058` |
| Linux（第 2 轮） | `click`、`type` | `APP_NOT_FOUND` | `No running application matches 'zenity'`（zenity 进程已退出），`details.process_state: "exited"` |
| Linux（第 1 轮，gedit） | `click`、`type` | `AMBIGUOUS_TARGET` | `Saved ref was not proven unique when it was captured…`，`details.kind: "identity_not_unique"` |

三平台关窗后 `focus-window` 与 `snapshot` 都是 `WINDOW_NOT_FOUND`（`snapshot` 的 message 带窗口 id，`focus-window` 的是 `No matching window found`）。

证据：`errors.STALE_REF`（macOS）、`errors.WINDOW_NOT_FOUND`（Windows）、`errors.AMBIGUOUS_TARGET`（Linux 第 1 轮）。Linux 的 `APP_NOT_FOUND` 样本没有单独收录，原文见第 2 轮日志 `linux-err-after-close-click`。来源：第 3 轮（macOS）、第 2 轮（Windows、Linux）、第 1 轮（Linux gedit）。

## (j) `list-windows` 的窗口标识

答案：每个窗口的 `id` 唯一，`id + pid` 也唯一（日志汇总：Windows 3/3/3、Linux 3/3/3、macOS 第 3 轮 18/18/18，三项分别是窗口数、唯一 id 数、唯一 id+pid 数）。

- 形状：Windows `w-66058`（数字来自 HWND）；macOS `w-38`（递增整数）；Linux `w-1.4-org-a11y-atspi-accessible-164` 或 `w-1.6-org-gnome-Zenity-a11y-970a0ab7_0650_41e8_ba70_fe5730098f46`（长不透明串，里面带 D-Bus 对象路径，不要解析）。
- 每个窗口对象字段：`accessible`、`app_name`、`bounds`、`id`、`is_focused`、`pid`、`process_instance`、`title`、`visible`，Windows、Linux 另有 `minimized`，macOS 没有。
- `process_instance` 三平台都有，不只是 Windows，格式各异：Windows `windows-proc-v1:<数>:<数>`，macOS `macos-proc-v1:<数>:<数>`，Linux `652afa7b:6387`。与协调者预期不符，见「其它发现」。
- macOS 会列出大量 `accessible: false`、`visible: false` 的辅助窗口（高 30 的 1024 宽条带等），选窗口时要按 `accessible` 与 `visible` 过滤。

证据：`windows.list-windows`、`macos.list-windows`、`linux.list-windows`。来源：第 2 轮（Windows、Linux）、第 3 轮（macOS）。

## (k) Linux 没有 D-Bus 会话总线时

答案：

- `status`：仍然 `ok: true`，`data.permissions.accessibility.state` 为 `"denied"`，带 `suggestion`：`No D-Bus session bus is reachable. Run inside a desktop session, or start one with 'dbus-run-session -- <command>'.`；`supported_surfaces` 为 `[]`（有总线时是 `["window","sheet","alert","menu"]`）。
- `permissions`：同样 `ok: true`、`accessibility.state: "denied"`、带同一条 `suggestion`。
- `list-windows`：`ok: false`，错误码 `PLATFORM_NOT_SUPPORTED`，message `The AT-SPI accessibility bus is not available in this session`，带 `platform_detail`（原始 D-Bus 错误）和 `details: { retryable: false }`，`disposition` 为 `not_delivered` / `safe`。

所以判断「Linux 无障碍可用」不能只看 `ok`，要读 `permissions.accessibility.state`。

证据：第 2 轮日志 `linux-status-no-atspi`、`linux-permissions-no-atspi`、`linux-list-windows-no-atspi`。样本未收录（`linux.status` 是有总线时的正常输出）。

---

## 其它发现

- **`press --help` 没有键名表（与预期不符）**：见 (g)。键名只能靠 npm 包内嵌文档或实测，帮助文本只有示例。
- **`process_instance` 不是 Windows 独有**：三平台的 `list-windows` 与 `focus-window` 窗口对象都有（见 (j)）。macOS 的窗口对象反而缺 `minimized`。
- **Windows 状态目录 DACL**：`AGENT_DESKTOP_HOME` 的 DACL 含非本人主体（例如 `BUILTIN\Users`）时，`snapshot` 回 `INTERNAL`，message `private file DACL grants an untrusted principal`（第 1 轮，三条快照命令全部如此）。把目录设成受保护、只含当前用户 FullControl 的 DACL 之后正常（第 2 轮）。`list-windows` 不受影响。
- **Windows 无头 `type` 回 `POLICY_DENIED`**：message `Target is not actionable: supported_action (semantic action is unavailable and focus fallback is denied)`，带 `recovery.strategy: "request_explicit_policy_then_retry_original"`。同一个输入框用 `set-value` 无头成功（`ValuePattern.SetValue`，`verified: true`）。macOS（`AXSelectedText`）、Linux（`EditableText.InsertText`）无头 `type` 成功。官方文档也写明 Windows 的 `type` 需要 `--headed`。
- **对不支持 Click 的控件 `click` 回 `POLICY_DENIED`**：message `Target is not actionable: supported_action (direct semantic delivery is unavailable and physical fallback is denied)`，`details.checks[]` 列出每项检查（`visible`、`stable`、`enabled`、`supported_action`、`policy`）。样本里对输入框 `click` 的「旧编号」测试在 Windows、macOS、Linux 第 2 轮都得到这个错误，而不是 `STALE_REF`。Linux 那条还多一项 `stable` 失败（`bounds changed since the previous observation`）。
- **裸 `@e1` 回 `INVALID_ARGS`**：message `Invalid ref_id '@e1': expected @<snapshot_id>:e<N>`。编号必须带快照 id，形如 `@s8f3k2p9:e1`。
- **`SNAPSHOT_NOT_FOUND`**：对不存在的快照 id 回此码，三平台信封逐字相同；`recovery.strategy` 为 `refresh_snapshot_then_retry_original`，`requires_fresh_snapshot: true`。
- **macOS 上 `osascript display dialog` 窗口不暴露无障碍树**：`snapshot` 回 `ACTION_NOT_SUPPORTED`，`details.kind: "window_without_accessibility_element"`，suggestion 说该窗口只支持截图与坐标输入（第 1、2 轮）。第 3 轮改用 AppKit 样本窗口后正常。
- **写动作成功信封**：`data` 为 `{ action, details, disposition, post_state, steps }`，`disposition` 是 `{ delivery: "delivered_verified", retry: "unsafe" }`；`details` 里有 `verification_scope: "element_value"`、`application_commit: "not_verified"`、`auto_wait`。macOS `type` 的步骤 `verified` 为 `false`，其余为 `true`。
- **Linux 大窗口的 `AMBIGUOUS_TARGET`**：第 1 轮对 gedit（225 个节点）的 `type`、`set-value`、`click` 旧编号都回 `AMBIGUOUS_TARGET`（`identity_not_unique`），第 2 轮对 zenity 小对话框的 `type`、`set-value` 成功。说明 Linux 上写动作能否成功取决于目标是否在快照里被证明唯一，大窗口的无名 textfield 容易失败。
- **非密码输入框的 `value` 会进快照，也会写进 `refmap.json`**：例如 Windows 写入后快照与 refmap 都有 `"value":"熊宝员工"`。refmap 在用户状态目录下明文保存，处理敏感输入时要留意。
- **`list-displays`**：`data` 是数组，元素 `{ bounds, id, is_primary, scale }`；`id` 形状 Windows `monitor-65537`、macOS `"1"`、Linux `"screen"`。
- **`permissions` 形状**：`{ accessibility, automation, screen_recording }`，每项 `{ state }`；`state` 取值见到 `granted`、`denied`、`not_required`、`unknown`（macOS 的 `automation`）。`status` 的 `data` 另有 `platform`、`ref_count`、`session_id`、`snapshot_id`、`state_root`、`supported_surfaces`、`tracing`、`version`。
- **`PERM_DENIED` 在 CI 里测不到**：见下节。

## 样本处理说明

- 脱敏：`status.data.state_root` 改成通用路径（Windows `C:/Users/user/ad-home`，macOS `/Users/user/ad-home`，Linux `/home/user/ad-home`）；Linux gedit 快照里 `description` 的 `/home/runner/work/…/capture-out` 改成 `/home/user/work`。窗口标题原样保留（含 Linux gedit 标题里的 `~/work/xiongbaowork/xiongbaowork/capture-out`，以及 Windows 里两个宿主窗口的标题）。
- 截图：`data` 换成 1×1 PNG，`format`、`width`、`height`、`scale_factor` 原样。Windows、Linux、macOS 截图来自第 1 轮完整 artifact（窗口分别是 PowerShell 表单、gedit、TextEdit）。
- 各平台 `snapshot` 样本是 `-i --compact`：Windows 是 XB Sample Form（共 10 个编号，未裁剪）；macOS 是 TextEdit 的 `sample.txt`（8 个编号，未裁剪，取自第 3 轮）；Linux 是 zenity 的 `XB Entry Dialog`（3 个编号，未裁剪，取自第 2 轮）。
- `snapshot-password`：Windows、macOS 是样本窗口（含单行、密码、多行输入框、禁用按钮、Send 按钮），均未裁剪。Linux 没有这样的单窗口样本，`linux.snapshot-password` 是 zenity 的密码对话框（非 `-i`，含静态文本），Linux 上单行输入框样本见 `linux.snapshot`，多行输入框见 `linux.snapshot-editor`。
- `linux.snapshot-editor` 是额外的键（brief 未要求）：第 1 轮 gedit 完整快照（`-i --compact`，225 个编号）被裁剪，只保留 `tree.children` 的前两个子树（标题栏与含正文 `textfield` 的编辑区），其余 6 个子树删除。`ref_count: 225`、`snapshot_id` 等其它字段原样，因此与裁剪后的实际节点数不符。
- `errors.json` 的来源（信封本身原样，不加 `_source` 字段）：
  - `STALE_REF`：macOS，关窗后 `click` 旧编号（第 3 轮 `macos-err-after-close-click`）；
  - `WINDOW_NOT_FOUND`：Windows，关窗后 `click` 旧编号（第 2 轮 `windows-err-after-close-click`）；
  - `SNAPSHOT_NOT_FOUND`：Windows，`click @s0000000000zz:e1`（第 2 轮 `windows-err-snapshot-not-found`，三平台逐字相同）；
  - `POLICY_DENIED`：Windows，`press alt+f4`（第 2 轮 `windows-err-policy-press-altf4`）；
  - `AMBIGUOUS_TARGET`：Linux gedit，关窗后 `click` 旧编号（第 1 轮 `linux-err-after-close-click`）；
  - `PERM_DENIED`：**构造，非实测**。CI 的运行器都已授权，无法触发。形状参照上述命令的真实错误信封（`code`、`message`、`suggestion`、`platform_detail`、`disposition`），`platform_detail` 的取值取自 npm 包 `agent-desktop@1.2.0` 内嵌的 Windows 故障排查文档：`COM HRESULT 0x80070005 (E_ACCESSDENIED: Access is denied)`（目标窗口完整性级别高于调用方时写动作返回的错误）。`message`、`suggestion` 为按该文档写的示意文字，`details` 里的 `hresult`、`name` 是为了让 `E_ACCESSDENIED` 也出现在 `details` 里而加的字段，真实输出里是否有这个字段未证实。`disposition` 取 `{ delivery: "not_delivered", retry: "safe" }`，信封 `version` 用实测的 `"2.6"`。使用方应按 `error.code` 判断，不要依赖 `message` 或 `details` 的具体字段。
