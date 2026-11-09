# 每员工独立系统用户 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 单容器交付镜像里，每个数字员工的命令和文件工具只能碰到它自己的目录，命令以它自己的 Linux 用户运行。

**Architecture：**
- agent-computer 按请求头 `x-openbot-bot-id` 为每个员工选择 workspace 根目录和 shell。
- 非默认员工的 shell 经 `sudo -n /usr/local/sbin/xb-bot run` 切换到该员工的 Linux 用户。
- 受限的 root 辅助程序 `xb-bot`（POSIX sh）负责三件事：建用户、建目录、设 ACL；切换用户执行；容器重启后按映射恢复用户。
- 开关 `COMPUTER_PER_BOT_USERS` 在交付镜像中默认开启，源码中默认关闭。

**Tech Stack：** Bun + TypeScript（agent-computer）、POSIX sh、sudo / runuser / setfacl、s6-overlay、GitHub Actions。

**Spec：** `docs/specs/2026-11-09-per-employee-computer-user.md`

## Global Constraints

- 用户名格式为 `xb-<botKey>`，其中 `botKey` 取 `sha256(botId)` 十六进制的前 12 位，满足 `^[0-9a-f]{12}$`。
- uid 范围 20000–59999（`SYS_UID_MIN`、`SYS_UID_MAX`），由 `useradd --system` 分配。
- 员工用户各有私有主组 `xb-<botKey>`，统一以附加组加入 `xbbots`；pwuser 是 `xbcomp` 组的唯一成员。
- 目录：
  - `/workspace/bots/<botKey>`：属主 `xb-<botKey>:xbcomp`，权限 `2770`。
  - `/workspace/bots/<botKey>/.tmp`：属主 `xb-<botKey>`，权限 `0700`。
  - 默认 ACL：`u:xb-<botKey>:rwx,u:pwuser:rwx,o::---`。
- 映射文件 `/workspace/.xb-users` 由 root 所有，权限 `600`，每行格式为 `<botKey> <uid>`。
- 顶层目录：
  - `/workspace`：属主 `pwuser:pwuser`，权限 `0711`，默认 ACL `o::---`。pwuser 必须仍可写，agent-computer 启动时的 `assertWritable` 依赖这一点。
  - `/workspace/bots`：属主 `pwuser:pwuser`，权限 `0711`。
  - `/profiles`：属主 `pwuser:pwuser`，权限 `0700`。
  - 以上三项每次启动都由 `restore` 强制设定，已挂载的旧卷也一样。
- 默认员工（`COMPUTER_BOT_ID`，默认 `shared`）以及不带请求头的调用：根目录仍是 `/workspace`，以 pwuser 运行。
- 辅助程序路径 `/usr/local/sbin/xb-bot`，root 所有，权限 `0755`。子命令只有 `ensure`、`run`、`restore`：
  - 参数不合法时退出码为 `64`，`run` 时用户不存在为 `65`。
  - `timeout_s` 是 1–600 的整数。
- sudoers 只放行以下几条，不放行 `restore`：
  - `pwuser ALL=(root) NOPASSWD: /usr/local/sbin/xb-bot ensure *, /usr/local/sbin/xb-bot run *`
  - `%xbbots` 不获得任何 sudo 权限（用户决定，2026-11-09）：员工不能 sudo 安装系统包，可以在自己目录里用 `pip --user`、`npm`、`bun` 安装用户级工具；常用系统包预装进镜像。pwuser 原有的包管理 sudo 保留。
- 开关 `COMPUTER_PER_BOT_USERS` 取 `on`/`off`：源码默认 `off`，交付镜像 `ENV COMPUTER_PER_BOT_USERS=on`。只在 Linux 上生效。
- 开关打开但辅助程序不可用时，`/health` 返回 HTTP 503，`status: "unready"`，并附 `perBotUsers.reason`。非默认员工的 `/exec` 和 `/files/*` 返回 503，**不退回共享模式**。
- 用户可见文案用中文，提交与注释不写模型名。不加 npm 依赖，不改 lockfile。每个任务（PR）改动不超过 8 个文件（测试另计）。
- 每条提交信息末尾加两行：
  - `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  - `Claude-Session: https://claude.ai/code/session_01MJUqVcFToyopKbNJ4sEoWY`

## Review Focus

1. **超长或含特殊字符的 botId**（例如 200 字符、含 `/` 或中文）：botKey 仍是合法的 12 位十六进制，路径中不出现原始 botId。由 Task 1 测试。
2. **员工停止命令**（请求被中止）：经 sudo 启动的命令也必须在 10 秒内停止，不留后台进程。由 Task 5 冒烟测试。
3. **容器重建后同一员工的 uid 不变**，它原有的文件仍归它所有。由 Task 4 辅助程序测试中的 `restore`。
4. **文件工具写入的文件，员工命令能读能改；员工命令写入的文件，文件工具能读。** 由 Task 4 和 Task 5 测试。
5. **默认员工、无请求头的调用行为不变**，现有数据仍在 `/workspace` 根目录。由 Task 2 和 Task 5 测试。

---

### Task 1：botKey 推导与「是否走独立用户」判定

**Files：**
- 新建：`openbot/agent-computer/src/per-bot.ts`
- 测试：`openbot/agent-computer/tests/per-bot.test.ts`

**Interfaces：**
- 产出：
  - `botKeyOf(botId: string): string`：返回 sha256 十六进制的前 12 位。
  - `perBotUsersEnabled(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean`：仅当 `env.COMPUTER_PER_BOT_USERS?.trim().toLowerCase() === "on"` 且 `platform === "linux"` 时为 true。
  - `usesOwnUser(botId: string, defaultBotId: string, enabled: boolean): boolean`：开关打开且 `botId !== defaultBotId` 时为 true。
  - `botHome(workspaceRoot: string, botId: string, defaultBotId: string, enabled: boolean): string`：走独立用户时返回 `${workspaceRoot}/bots/${botKeyOf(botId)}`，否则返回 `workspaceRoot`。

- [ ] **Step 1：写失败测试**，覆盖以下断言：
  - `botKeyOf("bot-a")` 匹配 `/^[0-9a-f]{12}$/`，且等于 `createHash("sha256").update("bot-a").digest("hex").slice(0, 12)`。
  - 200 字符的 botId、`"a/../b"`、`"员工一号"` 都得到合法 botKey。
  - `botHome("/workspace", "a/../b", "shared", true)` 不含 `..`，也不含原始 id。
  - 同一 id 两次调用结果相同，不同 id 结果不同。
  - `usesOwnUser("shared", "shared", true) === false`、`usesOwnUser("bot-a", "shared", false) === false`、`usesOwnUser("bot-a", "shared", true) === true`。
  - `perBotUsersEnabled({COMPUTER_PER_BOT_USERS:" ON "}, "linux") === true`；在 `"win32"` 上为 false；未设置时为 false。
- [ ] **Step 2：** 运行 `cd openbot/agent-computer && bun test tests/per-bot.test.ts`，预期失败（模块不存在）。
- [ ] **Step 3：** 在 `per-bot.ts` 中实现以上四个函数，使用 `node:crypto` 的 `createHash`。
- [ ] **Step 4：** 再跑一次，预期通过。
- [ ] **Step 5：** 提交：`feat(computer): derive a per-employee key and home`。

### Task 2：按员工选择 workspace，接上 HTTP 路由与 /health

**Files：**
- 修改：`openbot/agent-computer/src/per-bot.ts`
- 修改：`openbot/agent-computer/src/index.ts`（约 220–280 行的 workspace / shell 构造；`/files/*` 约 1086–1200 行；`/exec` 约 1141 行；`/health` 约 909 行）
- 测试：`openbot/agent-computer/tests/per-bot.test.ts`

**Interfaces：**
- 用到：Task 1 的全部函数。
- 产出：
  ```ts
  type HelperRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  createPerBotComputer(options: {
    workspaceRoot: string; defaultBotId: string; enabled: boolean;
    helper: HelperRunner;               // 默认实现：spawn("sudo", ["-n", "/usr/local/sbin/xb-bot", ...args])
  }): {
    workspaceFor(botId: string): Promise<ReturnType<typeof createWorkspace>>; // 走独立用户时先 ensure，按 botKey 缓存
    homeFor(botId: string): string;
    ensure(botId: string): Promise<void>;  // 调 helper(["ensure", key])，非 0 抛 PerBotUnavailableError；每个 key 只调一次（缓存成功的 Promise，失败的不缓存）
    status(): Promise<{ enabled: boolean; ready: boolean; reason?: string }>; // enabled 时调 helper(["ensure", botKeyOf("__probe__")])；成功结果永久缓存，失败结果只缓存 30 秒，单次探测超时 5 秒；reason 给通用中文说明，细节只写日志
  }
  class PerBotUnavailableError extends Error {} // message 为中文：「员工独立电脑未就绪：<原因>」
  ```

- [ ] **Step 1：写失败测试**，用假 helper 记录调用参数，断言：
  - 开关关闭：任何 botId 的 `workspaceFor` 都以 `workspaceRoot` 为根，helper 从未被调用。
  - 开关打开：`workspaceFor("bot-a")` 调用一次 `["ensure", botKeyOf("bot-a")]`，再调一次不重复。`workspaceFor("shared")` 不调用 helper。
  - helper 返回 `code: 1` 时，`workspaceFor` 抛出 `PerBotUnavailableError`，下一次调用会重试（失败不缓存）。
  - `status()` 的 `ready` 与 helper 结果一致。
  - 用真实临时目录：A 员工 workspace 写入的 `x.txt`，B 员工 workspace 的 `list` 看不到。
- [ ] **Step 2：** 运行测试，预期失败。
- [ ] **Step 3：** 实现 `createPerBotComputer`。
- [ ] **Step 4：** 修改 `index.ts`：
  - `/files/*` 改用 `await perBot.workspaceFor(botIdOf(request))`。
  - 捕获 `PerBotUnavailableError`，返回 `json({error: e.message}, 503)`。
  - `/health` 增加字段 `perBotUsers: await perBot.status()`。`enabled && !ready` 时 HTTP 503，`status: "unready"`；其余字段不变。
  - `/exec` 本任务不改，留给 Task 3。`DEFAULT_BOT_ID` 用 index.ts 现有常量。
- [ ] **Step 5：** 运行 `bun test`（agent-computer 全部）和 `bunx tsc --noEmit`，预期通过。现有 `workspace.test.ts`、`file-download-http.test.ts` 不需要修改，默认开关是关闭的。
- [ ] **Step 6：** 提交：`feat(computer): give each employee its own file root`。

### Task 3：shell 的「按员工运行」模式

**Files：**
- 修改：`openbot/agent-computer/src/shell.ts`（`createShell` 约 250 行，以及 spawn 处）
- 修改：`openbot/agent-computer/src/index.ts`（`/exec` 使用 `perBot.shellFor`）
- 修改：`openbot/agent-computer/src/per-bot.ts`（增加 `shellFor(botId)`，按 botKey 缓存）
- 测试：`openbot/agent-computer/tests/shell.test.ts`

**Interfaces：**
- 用到：Task 2 的 `createPerBotComputer`、`ensure`、`homeFor`。
- 产出：
  - `createShell(workspaceDir, sourceEnv?, options?: { runAs?: { key: string; launcher?: string[] } })`。`launcher` 默认 `["sudo", "-n", "/usr/local/sbin/xb-bot"]`。
  - `perBot.shellFor(botId): Promise<ReturnType<typeof createShell>>`：先 `ensure`，再返回带 runAs 的 shell；默认员工返回原有的共享 shell。

**协议（写死，Task 4 的辅助程序按此实现）：**
- 实际执行 `spawn(launcher[0], [...launcher.slice(1), "run", key, String(Math.ceil(timeoutMs / 1000))])`，cwd 为员工目录。
- stdin 依次写入：
  1. 若干行 `NAME=VALUE`。来源是 `environmentForCommand(...)` 加 `egressShellEnvironment()`，去掉 `HOME`、`TMPDIR`、`USER`、`LOGNAME`、`SHELL`，也去掉值里含 `\n` 或 `\0` 的项。
  2. 一个空行。
  3. 命令原文。
  写完关闭 stdin。
- 超时、输出上限、停止、进程组终止的语义不变。停止时先向子进程发 `SIGTERM`（sudo 会转发给命令），5 秒后再发 `SIGKILL` 给进程组，并忽略 EPERM。

- [ ] **Step 1：写失败测试。** 在临时目录放一个可执行的假 launcher 脚本 `fake-xb.sh`：打印 `$@`；逐行读 stdin 直到空行，打印 `ENV:` 加每一行；然后 `exec sh -c "$(cat)"`。以 `launcher: [fakePath]` 构造 shell，断言：
  - stdout 含 `run <key> 120`（默认超时）。
  - 含 `ENV:PATH=`，不含 `ENV:HOME=`。
  - 命令 `echo hi` 的输出含 `hi`，exitCode 为 0。
  - 命令里有换行和引号（`printf '%s\n' "a b"`）也能原样执行。
  - `timeoutMs: 1000` 下执行 `sleep 30` 返回 `timedOut: true`，3 秒内结束。
  - 中止 signal 后 `stopped: true`。
- [ ] **Step 2：** 运行 `bun test tests/shell.test.ts`，预期失败。
- [ ] **Step 3：** 实现 runAs 分支。不带 runAs 时的代码路径保持原样，现有用例必须全部通过。
- [ ] **Step 4：** 修改 `index.ts` 的 `/exec`：`const sh = await perBot.shellFor(botIdOf(request))`，捕获 `PerBotUnavailableError` 后返回 503。
- [ ] **Step 5：** 运行 agent-computer 全部测试和 tsc，预期通过。
- [ ] **Step 6：** 提交：`feat(computer): run an employee's commands as its own user`。

### Task 4：辅助程序、镜像与 s6

**Files：**
- 新建：`openbot/docker/xb-bot.sh`，安装为 `/usr/local/sbin/xb-bot`
- 新建：`openbot/docker/s6/s6-rc.d/computer-users/type`（内容为 `oneshot`）和 `up`（`/usr/local/sbin/xb-bot restore`）
- 新建：`openbot/docker/s6/s6-rc.d/user/contents.d/computer-users`（空文件）
- 新建：`openbot/docker/s6/s6-rc.d/computer/dependencies.d/computer-users`（空文件）
- 修改：`openbot/Dockerfile`。内容：安装 `acl`；`groupadd xbcomp`、`groupadd xbbots`；`usermod -aG xbcomp pwuser`；在 login.defs 中设置 `SYS_UID_MIN 20000`、`SYS_UID_MAX 59999`；COPY 辅助程序并 `chmod 0755`；写 sudoers 文件 `/etc/sudoers.d/xb-bot`（0440，`visudo -cf` 校验）；`ENV COMPUTER_PER_BOT_USERS=on`。
- 修改：`openbot/docker/s6/s6-rc.d/computer/run`，在透传名单中加入 `COMPUTER_PER_BOT_USERS`。
- 测试：新建 `openbot/docker/tests/xb-bot.test.sh`，在 CI 中以 root 运行。

**Interfaces：**
- 用到：Task 3 的 stdin 协议，以及 Global Constraints 中的用户名、目录、退出码。
- 产出：辅助程序的三个子命令，行为见下。

**辅助程序行为：**
- 全程 `set -eu`，`PATH=/usr/sbin:/usr/bin:/sbin:/bin`，不读取调用方的环境变量。
- 第一个参数不在 `ensure|run|restore` 中，或 key 不匹配 `^[0-9a-f]{12}$`，退出码 64。
- 辅助程序自身的任何错误（退出码 64、65，以及 ensure 或 restore 失败）都向 stderr 输出一行以 `xb-bot: ` 开头的说明。agent-computer 只在「退出码为 64 或 65，且 stderr 首行以 `xb-bot: ` 开头」时，才判定是辅助程序拒绝并返回 503；否则当作命令自身的退出码。这一条同时修改 `openbot/agent-computer/src/shell.ts` 中 M4 的判定，并补对应测试。
- 用 dash 的写法给进程组发信号：`kill -s TERM -- "-$pid"`。dash 不接受 `kill -TERM -- -$pid`，会静默失败。测试必须断言进程确实已被清掉。
- `ensure <key>`：
  - 映射中已有 uid 就用 `-u <uid>`。
  - 用户不存在时执行 `useradd --system -U -G xbbots --home-dir /workspace/bots/<key> --no-create-home --shell /usr/sbin/nologin xb-<key>`（私有主组，gid 尽量与 uid 相同），并把 uid 追加进映射。
  - mkdir 并 chown、chmod，执行 `setfacl -m` 和 `setfacl -d -m`（ACL 内容见 Global Constraints）。
  - 建 `.tmp`，最后输出 uid。
  - 幂等。setfacl 失败时退出码非 0。
  - 整个 ensure 在 `flock /run/xb-bot/lock` 下串行执行，避免并发 useradd 抢锁失败。`/run/xb-bot/` 为 root 0700、锁文件 0600，员工打不开锁，也就卡不住别人的 ensure。
- `run <key> <timeout_s>`：
  - timeout 不是 1–600 的整数，退出码 64；用户不存在，退出码 65。
  - 读 stdin 直到空行，每行 `NAME=VALUE`。NAME 必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$` 且不在 `HOME TMPDIR USER LOGNAME SHELL` 中，否则跳过该行。合法的行用 `set --` 累积。
  - 余下的 stdin 读进 `cmd`。
  - `cd` 进员工目录后，**不用 exec**，在后台启动：
    ```sh
    timeout --kill-after=5 "$t" runuser -u "xb-$key" -- env -i "$@" HOME="$dir" TMPDIR="$dir/.tmp" USER="xb-$key" LOGNAME="xb-$key" /bin/bash -c "$cmd" &
    ```
    记下 pid（timeout 会自建进程组，组号就是它的 pid）。
  - `trap` 捕获 TERM、INT、HUP（sudo 会把调用方的信号转给辅助程序），收到后依次执行：`kill -s TERM -- "-$pid"`，等 3 秒，`kill -s KILL -- "-$pid"`，只清理本次命令的进程组，不用 `pkill -u`（会误杀同一员工的其他命令）；用 `${pid:-${!:-}}` 补上信号落在 `&` 与 `pid=$!` 之间的窗口。
  - `wait $pid` 拿到退出码后，**无论命令是正常结束还是超时**，都执行 `kill -s KILL -- "-$pid" 2>/dev/null || true`，清掉命令留在组里的后台进程（例如 `sleep 1000 &`）。这样后台进程不会一直占着输出管道。说明：命令结束时连同它的后台进程一起结束，不支持常驻进程。
  - 以命令的退出码退出。超时时 timeout 返回 124 或 137，原样透传。
- `restore`：
  - 若 `/run/s6/container_environment` 存在，强制设为 `root:root 0700`（员工用户不得读取容器环境，例如 COMPUTER_TOKEN 和数据库地址）。
  - 只有 `id -u` 为 0 且 `SUDO_USER` 为空时才执行，否则退出码 64。
  - 先按 Global Constraints 强制设定 `/workspace`、`/workspace/bots`、`/profiles` 的属主、权限和 ACL（目录不存在就先创建）。
  - 再对 `/workspace` 下 `bots` 以外的全部条目执行 `chmod -R o-rwx`。
  - 映射文件不存在时到此退出 0。
  - 对映射中每一行：uid 不在 20000–59999 内，或 key 不合法，就跳过并向 stderr 记一行；用户不存在时按记录的 uid 重新 `useradd`。
  - 开关关闭时 `restore` 照样执行（s6 不看开关）。

- [ ] **Step 1：写失败测试** `docker/tests/xb-bot.test.sh`（POSIX sh，任一断言失败即 `exit 1`），断言：
  - `xb-bot nope` 退出码 64；`xb-bot ensure ABC` 退出码 64；`xb-bot run <key> 0` 退出码 64；未 ensure 的 key 执行 `run` 退出码 65。
  - `ensure` 两次都退出 0，输出的 uid 相同，且在 20000–59999 之间。
  - `printf 'PATH=/usr/bin:/bin\n\nid -u\n' | xb-bot run <keyA> 10` 输出 A 的 uid。
  - `printf '\necho hi; sleep 1000 &\n' | xb-bot run <keyA> 30`：3 秒内返回，输出含 `hi`，之后 `pgrep -u xb-<keyA> sleep` 为空。
  - 后台启动 `printf '\nsleep 1000\n' | xb-bot run <keyA> 600`，1 秒后向这个辅助程序进程发 TERM：8 秒内退出，`pgrep -u xb-<keyA>` 为空。
  - 员工 A 读 `/run/s6/container_environment` 下的文件失败；读 `/proc/1/environ` 失败。
  - 并发执行 4 次 `xb-bot ensure <keyC>`：全部退出 0，uid 相同。
  - A 写的文件，B 执行 `cat` 失败（Permission denied）。
  - A 执行 `ls /profiles` 失败；A 的 `echo $TMPDIR` 等于 `/workspace/bots/<keyA>/.tmp`。
  - 以 `runuser -u pwuser` 写入 A 目录的文件，A 能 `cat` 也能追加；A 写的文件，pwuser 能 `cat`。
  - `HOME=/x` 行被忽略：A 的 `echo $HOME` 仍是 A 的目录。
  - `printf '\nsleep 30\n' | xb-bot run <keyA> 2` 在 8 秒内结束，退出码为 124 或 137。
  - 执行 `userdel xb-<keyA>` 后再 `xb-bot restore`，`id -u xb-<keyA>` 与之前相同，A 的旧文件属主不变。
  - 以 pwuser 执行 `sudo -n /usr/local/sbin/xb-bot restore` 被 sudo 拒绝（非 0）。
  - 先 `chmod 0755 /profiles` 并在 `/workspace` 下放一个 0644 的 `old.txt`，再跑 `restore`：`stat -c %a /profiles` 为 `700`，`/workspace` 为 `711`，`old.txt` 为 `640`，pwuser 仍能在 `/workspace` 下新建文件。
  - 映射里写入一行 `<key> 0` 后跑 `restore`：退出 0，且不会创建 uid 为 0 的用户（`getent passwd xb-<key>` 为空，或其 uid 不是 0）。
- [ ] **Step 2：** 本地构建镜像，以 root 运行测试，预期失败（辅助程序不存在）：
  ```bash
  cd openbot && docker build -f Dockerfile -t openbot:pbu .
  docker run --rm --user root --entrypoint /bin/sh -v "$PWD/docker/tests:/t:ro" openbot:pbu /t/xb-bot.test.sh
  ```
  本地没有 docker 时，这一步和 Step 4 交给 Task 5 的 CI 验证，报告中写明。
- [ ] **Step 3：** 实现辅助程序，修改 Dockerfile 和 s6。对 `xb-bot.sh` 跑 `shellcheck`（若可用）。
- [ ] **Step 4：** 重建镜像后重跑测试，预期通过。
- [ ] **Step 5：** 提交：`feat(image): per-employee users through a narrow root helper`。

### Task 5：CI 冒烟、文档

**Files：**
- 新建：`openbot/scripts/ci/per-bot-users-smoke.sh`
- 修改：`.github/workflows/ci.yml`，在 image job 的 `docker build` 之后加两步：
  1. `docker run --rm --user root --entrypoint /bin/sh -v "$PWD/docker/tests:/t:ro" openbot:trackb /t/xb-bot.test.sh`
  2. `bash scripts/ci/per-bot-users-smoke.sh openbot:trackb`
- 修改：`openbot/docs/configuration.md`，在 `COMPUTER_SHELL_ENV` 一节附近加 `COMPUTER_PER_BOT_USERS` 一行和一小节，写明与 `--security-opt no-new-privileges` 互斥。
- 修改：`docs/acceptance/HUMAN-STEPS.md`，新增一节「员工独立电脑（京东云）」。

**Interfaces：**
- 用到：Task 2 的 `/health.perBotUsers`；Task 3、Task 4 的行为。

**冒烟脚本做的事：**
1. 照 `image-smoke.sh` 的方式起容器，等到 `/health` 返回 200。
2. 在容器内用 `curl` 访问 `http://127.0.0.1:4100`。token 取自容器内 `COMPUTER_TOKEN` 的来源，参照 `computer-token.sh` 的写法；请求头用 `authorization: Bearer <token>` 和 `x-openbot-bot-id`。
3. 断言：
   - `/health` 的 `perBotUsers.ready === true`。
   - bot `smoke-a` 经 `/files/write` 写 `a.txt`；bot `smoke-b` 的 `/files/read a.txt` 返回非 200。
   - `smoke-a` 的 `/exec` 执行 `cat a.txt` 得到内容；`smoke-b` 的 `/exec` 执行 `cat ../<keyA>/a.txt` 的 exitCode 非 0。
   - 不带 bot 头时 `/exec` 执行 `id -un` 输出 `pwuser`（默认员工行为不变）。
   - 用 `curl --max-time 3` 向 `smoke-a` 发 `/exec` 执行 `sleep 60`，curl 超时后 10 秒内，容器里 `pgrep -u xb-<keyA> sleep` 返回空。
4. 结束时删除容器。

- [ ] **Step 1：** 写冒烟脚本，推送分支，让 CI 的 image job 运行。新增的两步应先失败、再通过：如果 Task 4 已合入，就在本地或 CI 中确认脚本确实能断言失败，例如临时把 `COMPUTER_PER_BOT_USERS=off` 传给容器，应当失败。
- [ ] **Step 2：** 修改 ci.yml，补写文档。
- [ ] **Step 3：** CI 的 image job 全部通过。
- [ ] **Step 4：** 提交：`ci(image): prove employees cannot read each other's files`。
