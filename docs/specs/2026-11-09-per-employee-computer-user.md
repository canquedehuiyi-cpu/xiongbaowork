# 规格：每个数字员工一台独立的电脑（单容器内按员工分系统用户）

- 日期：2026-11-09
- 状态：待用户审阅
- 用户决定：「每个数字员工有自己独立的电脑」；隔离方式选「每员工独立系统用户」（2026-11-09）。

## 1. 背景

**上游 #871 的方向与需求相反，不移植。** 上游 #871（9d80da02）把「每个 Bot 一台电脑」改成了「每个人一台电脑，勾选 Isolated 的 Bot 才单独一台」。fork 的基线 63f99cf 早于 #871，配了 supervisor 时本来就是每个 Bot 一台电脑。

**缺口在单容器交付镜像**，也就是京东云正在用的形态（`EMBEDDED_COMPUTER=on`，`AGENT_COMPUTER_URL=http://127.0.0.1:4100`）。这个形态下所有员工、所有租户共用一个 agent-computer 进程：

| 资源 | 现状 |
|---|---|
| 浏览器档案 | 已按员工分开（`profileDirectoryFor(PROFILES_DIR, botId)`） |
| `/files/*` 文件工具 | **共用** `/workspace`，A 员工能读写 B 员工的文件 |
| `/exec` 命令 | **共用**：以 pwuser（uid 1001）在 `/workspace` 运行，能读到所有员工的文件、浏览器档案和 `/tmp` |

服务端每次调用都会在请求头里带 `x-openbot-bot-id`（`server/src/computer/client.ts`），所以 agent-computer 知道是哪个员工在调用。

## 2. 目标与非目标

**目标**
1. 在单容器里，每个员工的命令以它自己的 Linux 用户运行。员工之间读不到对方的工作目录、临时目录和浏览器档案。
2. 每个员工的文件工具只能看到自己的目录。
3. 已有数据可迁移：现有 `/workspace` 下的文件留给原来的默认员工（`COMPUTER_BOT_ID`，默认值 `shared`）。新员工从空目录开始。
4. 配了 supervisor 的形态（每员工一个容器）行为不变。

**非目标**
- 不防内核漏洞，也不防 root 提权。容器内仍允许 `sudo apt-get` 这类包管理命令，装的软件对所有员工可见（系统级共享）。需要更强隔离的部署，仍应使用 supervisor 加 gVisor。
- 设备模式（`TENANT_RUNTIME=device`，命令跑在主人自己的电脑上）不在本规格内。另起一项：设备端给每个员工一个独立工作文件夹。
- 不做网络隔离：各员工共用出站代理和出站策略。

## 3. 设计

### 3.1 员工对应的系统用户

- 用户名：`xb-` 加 `sha256(botId)` 的前 12 位十六进制（满足 Linux 用户名 ≤ 32 字符和字符集要求；botId 本身可能超长或含大写）。
- uid 由 `useradd --system` 自动分配，范围 20000–59999（写入 `/etc/login.defs` 的 `SYS_UID_MIN/MAX`）。
- 不登录，shell 为 `/usr/sbin/nologin`，不加入 sudo 以外的任何组。
- 员工用户映射持久化在 `/workspace/.xb-users`（root 600）。员工用户对 `/workspace` 没有写权限，改不了它。pwuser 是 agent-computer 服务本身，属于可信方，本规格不防它：它本来就能经 `xbcomp` 组读写所有员工目录。服务端的每次调用都带真实员工 id 的请求头，所以以 pwuser 运行的「默认员工」只服务于不带请求头的调用（如健康检查），不对应任何真实员工。容器重建后，辅助程序按映射重建用户，保证 uid 不变，文件属主随之不变。恢复时校验每个 uid 都在 20000–59999 之间，范围外的行跳过并记日志。

### 3.2 目录与权限

```
/workspace/                     pwuser:pwuser  0711   员工只能穿过，不能列出；默认 ACL o::---
/workspace/bots/                pwuser:pwuser  0711
/workspace/bots/<botKey>/       xb-…:xbcomp    2770   该员工的家目录、工作目录
/workspace/bots/<botKey>/.tmp/  xb-…:xbcomp    0700   该员工的 TMPDIR
/profiles/                      pwuser:pwuser  0700   启动时由 restore 强制设定（含已挂载的旧卷）
```

- `botKey` 等于用户名里的哈希部分，不在路径里暴露原始 botId。
- `xbcomp` 组只有 pwuser 一个成员，所以 agent-computer 进程（pwuser）能读写每个员工的目录，供文件工具使用。员工用户之间互不在对方的组里，读不到彼此。
- **双向可写靠默认 ACL**：员工目录设置 `setfacl -d -m u:xb-…:rwx,u:pwuser:rwx,o::---`（镜像加装 `acl` 包）。这样员工命令新建的文件，文件工具能改；文件工具写入的文件，员工命令也能读写。光靠 umask 和 setgid 做不到这一点：文件工具以 pwuser 写入的文件，员工用户只能落在 other 位上。若所在文件系统不支持 ACL，`ensure` 失败，`/health` 报不就绪。
- 默认员工 `shared` 的根目录仍是 `/workspace` 本身，兼容现有数据；它的命令照旧以 pwuser 运行。规则：**只有带了 `x-openbot-bot-id` 且不等于 `COMPUTER_BOT_ID` 的调用，才走独立用户。**

### 3.3 受限的 root 辅助程序

agent-computer 以 pwuser 运行，不能切换用户。新增 `/usr/local/sbin/xb-bot`（root 所有，0755，POSIX sh），只做两件事：

1. `xb-bot ensure <botKey>`：建用户（若不存在）、建目录、设权限，打印 uid。
2. `xb-bot run <botKey> <timeout_s>`：从标准输入读取命令，以 `runuser -u xb-<botKey>` 在该员工目录中执行。环境由调用方经白名单传入：`env -i`，加上 HOME 和 TMPDIR 为员工目录，加上 shell.ts 现有白名单里的变量。

sudoers 只放行这一条：

```
pwuser ALL=(root) NOPASSWD: /usr/local/sbin/xb-bot
```

辅助程序的参数校验：
- `botKey` 必须匹配 `^[0-9a-f]{12}$`。
- 子命令只接受 `ensure` 和 `run`。
- `timeout_s` 是 1–600 的整数。
- 任何不符都以退出码 64 结束，不执行任何操作。

### 3.4 agent-computer 改动

- `shell.ts`：`createShell` 增加可选的「按员工运行」模式。botId 走独立用户时：先调一次 `sudo -n xb-bot ensure`（每个进程每个员工缓存一次），再 `spawn("sudo", ["-n", "/usr/local/sbin/xb-bot", "run", key, timeout])`，命令经 stdin 传入。超时、输出上限、停止、进程组终止等现有语义不变。
- `workspace.ts`：已经是以 root 路径为参数的工厂，改为按员工取根目录（`/workspace/bots/<botKey>`）并缓存实例。现有的三层越界检查不变。
- `index.ts`：`/exec`、`/files/*` 用 `botIdOf(request)` 选择 shell 和 workspace 实例。
- 开关：环境变量 `COMPUTER_PER_BOT_USERS`。交付镜像默认 `on`；源码默认 `off`，保证本地开发和 supervisor 形态不变。开关打开但 `sudo -n xb-bot` 不可用时，`/health` 报不就绪并说明原因，**不静默退回共享模式**。

### 3.5 镜像改动（Dockerfile 和 s6）

- 安装 `xb-bot` 和 sudoers 条目；创建 `xbcomp` 组并把 pwuser 加进去；在 login.defs 里设置 uid 范围。
- 容器启动时，s6 以 root 运行 oneshot `xb-bot restore`。这个子命令只允许 s6 以 root 调用，不进 sudoers。它依次做三件事：
  1. 按 `/workspace/.xb-users` 重建用户。
  2. 强制设定 `/workspace`（0711，并设默认 ACL `o::---`）、`/workspace/bots`（0711）、`/profiles`（0700）的属主和权限。
  3. 对默认员工的旧文件（`/workspace` 下 `bots/` 以外的全部）执行 `chmod -R o-rwx`，只去掉 other 位，不改属主。

  开关关闭时 restore 照样执行，因为收紧 `/profiles` 无论开关如何都是对的。

## 4. 测试

- **agent-computer 单测**
  - 员工 botKey 推导：确定性、格式、超长或非法 botId。
  - 选择规则：无请求头或默认员工 → 共享；其他员工 → 独立用户。
  - workspace 按员工取根目录：越界被拒，其他员工的目录不可见。
  - 开关 off 时行为与现状逐字节一致。
- **辅助程序测试**（CI 的 Linux job，root 容器内跑）
  - 非法参数退出码 64。
  - `ensure` 幂等。
  - `run` 以对应 uid 运行（`id -u`）。
  - A 员工 `cat` B 员工的文件得到 Permission denied。
  - A 员工读不到 `/profiles`。
  - TMPDIR 指向员工自己的目录。
- **镜像级验收**：在 image job 中加一步，起容器后经 HTTP 用两个不同的 `x-openbot-bot-id` 调 `/exec` 和 `/files/write|read`，断言互相读不到。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| sudoers 放行的辅助程序本身成为提权入口 | 参数严格白名单；命令只经 stdin 传给 `runuser`，不拼进 argv；辅助程序不读环境变量（`env -i` 由它自己设）；加 shellcheck；专项安全评审 |
| 包管理 sudo 仍可提权到 root | 已知，属于非目标；文档写明更强隔离要用 supervisor 加 gVisor |
| 平台不允许 setuid（`no-new-privileges`） | 开关打开时 `/health` 明确报不就绪；交付文档说明二者互斥 |
| 旧数据归属 | 默认员工继续使用 `/workspace` 根目录；不搬动、不改属主 |

## 6. 分包（每 PR ≤ 8 个文件）

1. agent-computer：botKey 推导、按员工选 workspace、shell 的「按员工运行」模式与开关（附单测）。
2. 镜像：xb-bot、sudoers、s6 oneshot、login.defs，加辅助程序测试。
3. CI：image job 增加双员工互读验收；补交付文档与 HUMAN-STEPS 一节。
