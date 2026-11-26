# 需要人工完成的步骤

这些步骤要用仓库管理员身份在 GitHub 网页上操作，或要用真机和密钥。自动化流程不能代做：没有对应权限，也按约束不创建 environment、secret 和 tag。按下面的顺序做，前一步是后一步的前提。

仓库：`canquedehuiyi-cpu/xiongbaowork`。`main` 已包含集成分支的全部工作，最近一次合并是 canquedehuiyi-cpu/xiongbaowork#275。

## 进度（2026-11-06）

| 步骤 | 状态 | 证据 |
| --- | --- | --- |
| 1 默认分支 | 已完成 | 仓库默认分支是 `main` |
| 2 分支保护 | 未核实 | 本会话读不到仓库规则设置，请在网页上自查 |
| 3 Environment `model-e2e` | 已完成 | 含 `DEEPSEEK_API_KEY`，第 6 步已用它跑通 |
| 4 Environment `release` | 已完成 | 第 8 步的发布在它里面跑通 |
| 5 删除 `codex/*` 分支 | 未做 | 不影响发布 |
| 6 G6 | **已完成** | 「模型 E2E 计量对账」运行 41952789605：供应商 8/1 token，计量行 8/1，`mismatches=[]` |
| 7 准备首个发布 | 已完成 | canquedehuiyi-cpu/xiongbaowork#246：`package.json` 0.2.0，CHANGELOG `## 0.2.0` |
| 8 打 tag | **已完成（正式版）** | `v0.2.0` → 「熊宝发布」运行 41989346546 全绿，正式 Release `v0.2.0` 已发，镜像 `ghcr.io/canquedehuiyi-cpu/xiongbaowork@sha256:b76702a4…6686b1`。此前预发布 `v0.2.0-rc.1`（运行 41952108367） |
| 9 GHCR 公开 | 已完成 | 发布的 digest 能匿名取到 manifest（HTTP 200） |
| 10 G7 | Linux 已完成（CI 与真实服务器），Windows 待做（2026-11-20 已按已知偏离 KD-1 签字接受，见 `STORIES.md`） | `v0.2.0` 发布运行 41989346546 里 `g7-linux` 内置库、外部库两个 job 都通过。2026-11-06 在京东云 Ubuntu 22.04 上用正式镜像 `v0.2.0` 单容器部署：健康检查 200，注册并用 `grant-admin.ts` 设首位管理员（命令已在 #274 修正），部署级模型接 DeepSeek 后「我的分身」正常回答。踩到的坑写进 `xiongbao/docs/deployment-qoderwake.md` §5.1（#277）。Windows 需要一台 Win10/11 真机：手头的 Windows Server 2025 云主机不支持 WSL2/Docker |
| 11 G5 真机 | 通过（6 项全部通过，含 v0.2.1 上的批准执行；中文输出随设备端 `device-v0.2.1-rc.1` 修复并复测通过） | 设备端 `device-v0.2.0-rc.2` 装在 Windows 11 25H2（「峰哥工作站」）上，先配对到京东云 v0.2.0，2026-11-07 升级到 v0.2.1 复测；逐项记录见第 11 节「2026-11-06 实测」与「2026-11-07 v0.2.1 复测」 |
| 12 F2 设备端 | 未签名内测版已发；全新机器安装检查已在 CI 自动通过；签名：已决定暂不购买（D3，见 12.7）；真人电脑证据待人工（2026-11-20 已按已知偏离 KD-2 签字接受，见 `STORIES.md`） | `device-v0.2.0-rc.1` 的 Windows job 失败，已由 canquedehuiyi-cpu/xiongbaowork#250 修复；`device-v0.2.0-rc.2` → 「熊宝设备端发布」运行 41963394570 全绿，预发布「熊宝数字员工 设备端 0.2.0（未签名内测版）」含 Windows 安装包、Linux deb 和 `SHA256SUMS`（下载复核通过）。签名身份（D3，12.2/12.4）和两台干净机器证据（12.6）待人工。全新托管机器（Ubuntu、Windows）上的安装、配对、启动退出、卸载检查已在 #266 的 CI 上首次实跑通过，此后每个 PR 和每次设备端发布都会跑。2026-11-07 `device-v0.2.1-rc.1`（含 #295 中文输出修复）→ 运行 42369464470 全绿，已在「峰哥工作站」覆盖安装并复测通过 |
| 13 百度网盘来源 | 本人通过；第二人隔离待测 | 2026-11-07 在京东云部署（v0.2.1）实测：百度网盘开放平台应用「xiongbao」（软件 · 个人使用，已上线）已建，回调地址已填；AppKey/SecretKey 已登记；本人百度账号已授权；员工「我的分身」依次调用 `list_files`、`search_files`、`read_file_content`，读出只有本人网盘里才有的测试文件暗号。登记和授权当时因 `team:<key>` 编号缺陷走的是浏览器控制台，修复见 #315、#316。还差换另一个人验证读不到，见第 13 节「验收记录」。Google Drive 已决定暂不启用（2026-11-06） |
| 14 本机 MCP 真机 | 待测（v0.2.2 + device-v0.2.2） | 设备端本机 MCP 桥接已合入：设计 `docs/specs/2026-11-07-device-mcp-bridge.md`，计划 `docs/plans/2026-11-07-device-mcp-bridge.md`，PR #300–#311。见第 14 节 |
| 16 桌面查看（只读）真机 | 待核实 | 见第 16 节；仓库记录里没有留下验收结果 |
| 17 员工独立电脑（京东云） | 待核实 | 见第 17 节；仓库记录里没有留下验收结果 |
| 18 桌面操作第 2 期（macOS / Linux / 多显示器） | 待做（macOS 部分暂缓） | 需要服务器 `v0.2.10` 和同版本设备端；2026-11-13 决定苹果系统暂缓，先只做 Linux 和多显示器，macOS 各项与 Apple 证书一起以后再做，见第 18 节 |
| 19 桌面操作第 2 期：Windows（引擎开关） | 待做 | 需要服务器和设备端都是 `v0.2.10`（含 Task 28）；验收通过并回复「Windows 验收通过」后才把 Windows 默认切到 agent-desktop，见第 19 节 |
| 20 招入外部智能体（Codex、Claude Code）真机验收 | 待做 | 需要服务器 `v0.2.15` 和设备端 `device-v0.2.15-rc.1`（预发布，由你推标签）；Windows 一台为主，macOS 可选，见第 20 节 |
| 21 v0.2.16 改名升级（京东云） | 待做 | 发布 `v0.2.16` 并同步到京东云仓库后，在服务器上按第 21 节逐步执行并回报；设备端重装 `device-v0.2.16` |

## 1. 把 `main` 设为默认分支

Settings → General → Default branch，切到 `main`。

- 为什么：`model-e2e.yml` 只在 `github.ref == 'refs/heads/main'` 时运行；`release.yml` 要求打 tag 的提交已在 `origin/main` 上。
- 怎么确认：仓库首页默认显示 `main`，新开 PR 的默认 base 是 `main`。

## 2. 给 `main` 加分支保护

Settings → Rules → Rulesets（或 Branches → Add rule），目标分支选 `main`：

- 合并前必须通过 PR；
- 必须通过的状态检查：`熊宝交付 CI` 的全部 job。最少要有 `static`、`app-test`、`server-test (1)`–`(6)`、`image`、各 `workspace tests (…)`、`chart`、WakerFlow 生命周期 E2E；
- 禁止 force push 和删除分支；
- 合并方式只开 "Create a merge commit"，与目前的做法一致。

怎么确认：直接往 `main` 推送会被拒绝，未通过 CI 的 PR 不能合并。

## 3. 创建 GitHub Environment `model-e2e`

Settings → Environments → New environment，名称填 `model-e2e`：

- Deployment branches and tags：只允许 `main`；
- Environment secrets：新增 `DEEPSEEK_API_KEY`，值是 DeepSeek 的 key。**这个 key 只放在这里**，不要放进仓库级 secret、`.env` 或任何文件；
- 建议勾选 Required reviewers（填你自己），每次运行都要你批准，因为它会真实调用模型并产生少量费用。

## 4. 创建 GitHub Environment `release`

同一处新建 `release`：

- Deployment branches and tags：只允许 tag `v*.*.*` 和 `v*.*.*-rc.*`；
- 建议勾选 Required reviewers；
- 不需要额外 secret：推送 GHCR 用的是工作流自带的 `GITHUB_TOKEN`（`packages: write`）。

## 5. 归档并删除 `codex/*` 分支

一共 146 个，都是 Codex 早期产出、已被前移或替代的分支。

- 删除前先确认它们都不在任何未关闭的 PR 上（目前开着的只有 #54）。
- 想留档的话，先把分支名和 head SHA 导出成列表，再删除。

## 6. G6：从 `main` 手动跑一次 model-e2e

Actions → 「模型 E2E 计量对账」→ Run workflow，分支选 `main`，如果第 3 步开了 Required reviewers，还要在运行页批准。

- 会用真实 key 调用 DeepSeek，产生少量费用。
- 通过标准：计量对账 job 成功；平台用量页和 token 面板里出现这次运行的记录，数字与供应商返回的一致。

## 7. 准备首个发布

1. 定版本号，例如 `0.2.0-rc.1`。
2. 改 `xiongbao/package.json` 的 `version`，填**不带** `-rc` 的基础版本（如 `0.2.0`）。
3. 在 `xiongbao/CHANGELOG.md` 里把 `## Unreleased` 改名为 `## 0.2.0`（与基础版本一致），内容不能为空。需要写进去的升级提醒：
   - **`TENANT_RUNTIME` 生产默认改为 `device`（F6）。** Helm 升级后会切到 `device`；要保留原行为，设 `config.tenantRuntime=cloud`。
   - **新增迁移 0130（`avatar_sources`）和 0131（`agent_security_settings`，规则多了 `deny`）。**
   - **员工所有者设的收紧类规则现在对其他使用者也生效（SEC1 D9）。**
4. 通过 PR 把这两处改动合进 `main`，等 CI 全绿。

## 8. 打 tag 发布

在 `main` 上已合并的那个提交打 tag 并推送：

```bash
git fetch origin main
```

```bash
git tag v0.2.0-rc.1 origin/main
```

```bash
git push origin v0.2.0-rc.1
```

- 推送后 `熊宝发布` 自动运行。它会依次：检查 tag 格式、版本号、CHANGELOG 和祖先关系 → 在 tag 上重跑完整 CI → 构建镜像 → 推送 GHCR（`release` environment）。
- tag 一旦推送就不要移动：工作流会拒绝 tag 与提交对不上的运行。

## 9. 把 GHCR 包设为公开

首次发布推送镜像后：GitHub 个人或组织页 → Packages → 对应的包 → Package settings → Change visibility → Public。

- 不公开的话，客户和 G7 的匿名 `docker pull` 会失败。`clean-deploy.yml` 会在这一步失败，这是预期的。

## 10. G7：干净机器部署

- **Linux**：包公开后，Actions → 「熊宝干净部署（G7 Linux）」→ Run workflow，`tag` 填刚发布的版本。内置数据库和外部数据库两个 job 都要通过。
- **Windows**：找一台从没装过的 Windows 机器，按 `docs/deployment-qoderwake.md` 安装并启动，登录后创建一个员工跑一次任务。把截图和日志归档进 release 说明。

## 11. G5：真机设备验证

在一台真实电脑上验证设备端和权限：

1. 在「我的设备」里生成配对码，在那台电脑上运行 runner 完成配对（F2 阶段 1 合入后改用桌面安装包），页面显示设备在线。
2. 让员工在设备上执行一个普通命令，能成功。
3. 让员工执行 `rm -rf` 一类危险命令，必须先出现审批；拒绝后什么都不执行，批准后只执行一次（SEC1）。
4. 读 `.env` 一类敏感文件也要先审批。
5. 断开设备再发任务：任务进入等待；设备回线后继续执行（F4）。
6. 分身详情页添加一个信息来源，再问分身相关问题，回答里能体现这条来源（F1）。

每一步记录结果，有失败就开 issue，写清复现步骤。

### 2026-11-06 实测（京东云 v0.2.0 + Windows 11 设备端）

| 项 | 结果 | 证据与发现 |
| --- | --- | --- |
| 1 配对在线 | 通过 | 「我的设备」显示「峰哥工作站 · 在线 · win32」。配对页原先只给源码命令，用户把整行粘进设备端被拒为「配对码不对」；#279 改为分开显示服务器地址和配对码 |
| 2 普通命令 | 通过 | 本人分身 `computer_run_command hostname` 在设备上执行，退出码正常返回。发现并修复：品牌包「我的分身」其实是无主公共员工 `general-assistant`，设备模式下用不了任何人的电脑（#283 起改为本人分身）；工具说明写着「bash / apt-get」让模型以为在自己的容器里（#280）；`$env:COMPUTERNAME` 为空、stderr 混入 CLIXML 进度（#281）。原生程序中文输出（GBK）乱码仍未修 |
| 3 危险命令审批 | 拒绝通过；批准待复测 | `Remove-Item -Recurse -Force C:\xiongbao-test2` 弹审批，拒绝后目录仍在。批准 `C:\xiongbao-test` 后从未执行：日志 `approval-resume-gated / root_release_not_attested`，生产从无 Root 证明。#282 改为服务器在审批行上结算、只执行一次，随 v0.2.1 发布后复测 |
| 4 敏感文件审批 | 拒绝通过；批准待复测 | `Get-Content C:\xiongbao-test\.env` 先弹审批，拒绝后未读出内容。批准后读取同第 3 项，待 v0.2.1 |
| 5 离线排队 | 通过 | 设备离线时命令返回 `queued: true`；回线后 32 秒内取出执行一次（`work_items` 记录 finished、attempts=1）。所选的 `C:\xiongbao-queue.txt` 因 Windows 不允许普通用户在 C 盘根目录建文件而失败（退出码 1、UnauthorizedAccess），属测试路径选择问题。体验缺口：排队结果不回到对话 |
| 6 信息来源 | 待测 | — |

### 2026-11-07 v0.2.1 复测（京东云 v0.2.1 + 同一台 Windows 11 设备）

服务器从南京大学镜像 `ghcr.nju.edu.cn` 拉取 v0.2.1（摘要 `sha256:b82fe0c7…ad7d`），重建容器后 `/health` 返回 200。

| 项 | 结果 | 证据与发现 |
| --- | --- | --- |
| 默认会话 | 通过 | 「我的分身」默认会话直接用本人设备执行 `hostname`，不再报 `general-assistant does not belong to a tenant with machines`（#283 起） |
| 3 危险命令批准 | 通过 | `Remove-Item -LiteralPath 'C:\xiongbao-test' -Recurse -Force` 弹审批，点「允许」后执行一次并回到对话，`Test-Path` 为 `False`（#282） |
| 4 敏感文件批准 | 通过 | `Get-Content -LiteralPath 'C:\xiongbao-test2\.env' -Raw` 弹审批，点「允许」后读出 `DEMO=1` |
| 5 排队结果回对话 | 通过 | 设备离线时 `Get-Date`、`echo ping` 和建目录命令排队；回线后逐条执行，结果以「之前排队的命令…已在设备重新连上后执行完成」回到原对话（#292） |
| 中文输出 | 通过（设备端 `device-v0.2.1-rc.1`） | 新版设备端上 `hostname` 直接返回「峰哥工作站」，`ipconfig` 的「Windows IP 配置」「未知适配器」「本地链接 IPv6 地址」等中文正常，不再有 CLIXML。修复前的诊断：`[Console]::OutputEncoding.CodePage` 为 65001，脚本里的中文正常，`(hostname)` 却含 4 个 U+FFFD：内置程序按 GBK 输出，被当成 UTF-8 解码。另见每条命令 stderr 仍带 `#< CLIXML` 的「正在准备首次使用模块」。canquedehuiyi-cpu/xiongbaowork#295 修复两处，WIN1 探针在 Windows 上实测 |
| 6 信息来源 | 通过 | 分身详情页（卡片上的「打开」，不是「装配」）添加文字声明「测试项目说明」后，问「熊宝测试项目的代号、负责人和截止日期」，回答「蓝鲸 / 峰哥 / 12月20日」，并说明来自这条声明、未读原文件 |
| 设备暂停 | 按设计 | 重装设备端时有一项动作被打断，设备进入「1 项结果不明，已暂停自动执行」；在「设置 › 我的设备 › 核查并恢复」保存核查后恢复。暂停提示原为英文，canquedehuiyi-cpu/xiongbaowork#298 改为中文，随下一次服务器发版生效 |
| 附带发现 | 待用户处理 | 设备时钟比服务器慢约一小时，会话列表出现「58分钟后」；请在 Windows 里同步时间 |

## 12. F2 设备端：签名身份、发布和第 7 道门

设备端「熊宝数字员工 设备端」由 `.github/workflows/device-release.yml`（「熊宝设备端发布」）发布。它和服务端的 `release.yml` 是两条线：只认 `device-v*` 标签，只发安装包，不碰镜像。

签不签名完全由下面的配置决定，工作流不替人做决定：

- **配了签名**：安装包签名并校验通过后，才会发成正式版。
- **没配签名**：只能发成预发布，标题带「未签名内测版」，说明里会写明哪个安装包没签名。
- **不会出现**"没签名的正式版"。

CI 里一直有三个未签名包可以下载试装：`device app unsigned deb`、`device app unsigned NSIS installer`、`device app unsigned dmg`。Windows 那个 job 还会用一张只在 CI 机器上受信的一次性证书，把签名流程完整演练一遍。

### 12.1 先拍板的决定

| 编号 | 要定的事 | 对配置的影响 |
| --- | --- | --- |
| D3 | 谁申请签名身份，密钥放在哪。**已决定（2026-11-07）：暂不购买代码签名证书**，先只在团队内部使用，见 12.7 | **不要设** `DEVICE_WINDOWS_SIGNING`。设备端继续以「未签名内测版」预发布。12.2–12.4 先不做。以后准备对外分发时，提前 1–2 周买 OV 代码签名证书，见 12.7 末尾 |
| D4 | 首个版本是否必须已签名。**已决定（2026-11-04）：允许先发未签名内测版** | **不要设** `DEVICE_RELEASE_REQUIRE_SIGNED`：没签名的构建发成「未签名内测版」预发布，正式版仍必须签名。（若以后改成必须签名：设仓库变量 `DEVICE_RELEASE_REQUIRE_SIGNED=true`，没签名的构建会直接失败、不发布） |
| D5 | 首发平台。**已决定（2026-11-04）：首发 Windows + Linux** | **不要设** `DEVICE_RELEASE_MACOS`，只发 Windows 和 Linux；暂不需要 Apple 身份，跳过 12.3。（以后加 macOS：设仓库变量 `DEVICE_RELEASE_MACOS=true`，只有 Apple 芯片的 dmg） |
| D6 | 自动更新 | **已决定（2026-11-04）：首版不做。** 没接 `tauri-plugin-updater`。发布说明会写"没有自动更新，新版需重新下载安装"，不需要 updater 密钥 |
| D8 | 产品名和 identifier | **已决定（2026-11-04）：定为 `com.xiongbao.device`，不再是占位。** macOS 的签名和公证都绑在 identifier 上，首个签名版之后不要再改 |

**不能用** `xiongbao/desktop/signing/azure-federation.json`：它指向上游仓库的签名身份。

### 12.2 申请 Windows 代码签名身份（A、B 二选一）

**A. Azure Artifact Signing（原名 Trusted Signing），推荐**

1. 在 Azure 订阅里创建一个 Artifact Signing 账户，记下它的 endpoint（例如 `https://eus.codesigning.azure.net`）和账户名。
2. 完成组织身份验证（Identity validation，要营业执照等材料，可能要等几天）。
3. 新建一个 Public Trust 证书配置文件，记下配置文件名。记下证书主题里的 CN（通常就是公司名）。

**B. 自购 OV 或 EV 证书，放进 Azure Key Vault**

1. 证书私钥必须生成在 Key Vault 的 HSM 里，且不可导出。不要生成或保存 `.pfx`。
2. 记下 Key Vault 的 URL（例如 `https://xxx.vault.azure.net`）、证书在 Key Vault 里的名字，以及证书主题的 CN。

**A、B 都要做：用 OIDC 免密登录（仓库里不放任何 Windows 密钥）**

1. 在 Entra ID 新建一个应用注册，记下 Client ID 和 Tenant ID。
2. 给它添加 Federated credential：
   - Issuer：`https://token.actions.githubusercontent.com`
   - Audience：`api://AzureADTokenExchange`
   - Subject：`repo:canquedehuiyi-cpu/xiongbaowork:environment:device-release`
   - 如果第一次运行时 `azure/login` 报 AADSTS70021，说明 GitHub 发的 subject 是带数字 ID 的新格式。把报错里显示的 subject 原样填进去。
3. 授权：
   - A：给这个应用分配该证书配置文件上的 "Artifact Signing Certificate Profile Signer" 角色（旧名 "Trusted Signing Certificate Profile Signer"）。
   - B：给它这个 Key Vault 的 Key Sign、Certificate Get、Secret Get 权限，例如 RBAC 的 Key Vault Crypto User 加 Key Vault Certificate User。

### 12.3 申请 Apple 签名身份（暂不需要（D5：首发 Windows + Linux））

D5 已定首发不含 macOS，这一节现在不用做。以后要发 macOS 时再按下面办：

1. 用组织身份加入 Apple Developer Program，需要 D-U-N-S 编号，记下 Team ID。
2. 创建一张 **Developer ID Application** 证书，连私钥一起导出成 `.p12` 并设导出密码。在钥匙串里看到的证书全名（如 `Developer ID Application: 公司名 (TEAMID)`）就是签名身份。
3. 在 App Store Connect → Users and Access → Integrations 新建一个 Team API Key（角色 Developer）。下载 `.p8`，只能下载一次。记下 Key ID 和 Issuer ID。

### 12.4 创建 GitHub Environment `device-release`，填变量和密钥

Settings → Environments → New environment，名称填 `device-release`：

- Deployment branches and tags：选 Selected，只加标签规则 `device-v*`；
- 建议勾选 Required reviewers：每次发布都要你批准；
- 下面的 Environment variables 和 Environment secrets 都**只放在这个 Environment 里**，不要放成仓库级，也不要写进任何文件。

**Windows：Environment variables（全部是标识，不是密钥）**

| 名称 | 值 |
| --- | --- |
| `DEVICE_WINDOWS_SIGNING` | A 填 `trusted-signing`，B 填 `azure-key-vault`；不设或填 `none` 就是不签名 |
| `DEVICE_WINDOWS_PUBLISHER` | 证书主题的 CN，和 Windows「数字签名」页显示的完全一致，校验会逐字比对 |
| `DEVICE_AZURE_CLIENT_ID` | 12.2 应用注册的 Client ID |
| `DEVICE_AZURE_TENANT_ID` | Tenant ID |
| `DEVICE_TRUSTED_SIGNING_ENDPOINT` | 只用于 A：账户的 endpoint |
| `DEVICE_TRUSTED_SIGNING_ACCOUNT` | 只用于 A：账户名 |
| `DEVICE_TRUSTED_SIGNING_PROFILE` | 只用于 A：证书配置文件名 |
| `DEVICE_AZURE_KEY_VAULT_URL` | 只用于 B：Key Vault URL |
| `DEVICE_AZURE_KEY_VAULT_CERTIFICATE` | 只用于 B：证书在 Key Vault 里的名字 |

**macOS：Environment variables**

| 名称 | 值 |
| --- | --- |
| `DEVICE_MACOS_SIGNING` | `developer-id`；不设或填 `none` 就是不签名，只有 ad-hoc 签名 |
| `DEVICE_APPLE_SIGNING_IDENTITY` | 12.3 第 2 步的证书全名 |
| `DEVICE_APPLE_TEAM_ID` | Team ID |
| `DEVICE_APPLE_API_KEY_ID` | API Key 的 Key ID |
| `DEVICE_APPLE_API_ISSUER` | API Key 的 Issuer ID |

**macOS：Environment secrets**

| 名称 | 值 |
| --- | --- |
| `DEVICE_APPLE_CERTIFICATE` | `.p12` 文件的 base64：`base64 -i cert.p12 \| pbcopy` |
| `DEVICE_APPLE_CERTIFICATE_PASSWORD` | `.p12` 的导出密码 |
| `DEVICE_APPLE_API_KEY_P8` | `.p8` 文件的全部文本，包括 BEGIN 和 END 两行 |

**Repository variables**（Settings → Secrets and variables → Actions → Variables，不放在 Environment 里）

| 名称 | 值 |
| --- | --- |
| `DEVICE_RELEASE_MACOS` | 发 macOS 时填 `true`。D5 已定首发 Windows + Linux：**现在不设** |
| `DEVICE_RELEASE_REQUIRE_SIGNED` | D4 定为"必须签名"时填 `true`。D4 已定允许先发未签名内测版：**现在不设** |

签名模式一旦打开，配置不全时工作流会直接失败，并报出缺的变量或密钥名，不会悄悄退回成未签名。

### 12.5 打首个设备端标签 `device-v0.1.0`

设备端的版本号取自 `xiongbao/package.json` 的 `version`，现在是 `0.1.0`，和服务端共用。标签的版本必须和打标签那个提交里的 `package.json` 一致。如果第 7 步已经把它改成了 `0.2.0`，标签就要打 `device-v0.2.0`。

1. 先演练（建议）：推一个 `device-v0.1.0-rc.1`，它总是发成预发布。或者在 Actions → 「熊宝设备端发布」→ Run workflow 里，对一个已存在的设备端标签手动运行，`dry_run` 保持勾选。这样会把构建、签名、校验、SHA256SUMS 全跑一遍，只是不发布，产物在运行页的 `device-release-dist` 里。
2. 正式打标签：
   ```bash
   git fetch origin main
   ```
   ```bash
   git tag device-v0.1.0 origin/main
   ```
   ```bash
   git push origin device-v0.1.0
   ```
3. 工作流依次做这些事：
   - 检查标签格式、版本号，以及提交是否已在 `origin/main` 上；
   - 在标签上重跑完整 CI；
   - 构建 Linux deb、Windows 安装包，以及 macOS dmg（如果开了）；
   - 签名、公证和校验：Windows 用 `verify-windows-signatures.ps1`，macOS 用 `verify-macos.sh`，后者包含 `stapler validate` 和 `spctl --assess`；
   - 生成 `SHA256SUMS`，在 `device-release` Environment 里发布 GitHub Release。
4. 结果：
   - 全部签名：正式版。
   - 有没签名的：预发布「熊宝数字员工 设备端 0.1.0（未签名内测版）」。
   - 设了 `DEVICE_RELEASE_REQUIRE_SIGNED=true` 又没签名：失败，什么都不发布。
5. 标签一旦推送就不要移动。要重发同一个标签，先在网页上删掉那个 Release（不要删标签），再对这个标签重新运行。

### 12.6 第 7 道门：两台干净机器的证据

找两台从没装过设备端的干净机器：一台 Windows 10/11 x64，一台 Ubuntu 22.04/24.04 x64。如果发 macOS，再加一台 Apple 芯片的 Mac。每台都从 Release 页下载安装包，按顺序做下面这些并留证据：

1. **校验和**：Linux 用 `sha256sum -c SHA256SUMS --ignore-missing`；Windows 用 `Get-FileHash <文件> -Algorithm SHA256`，与 `SHA256SUMS` 对照。保存命令输出。
2. **签名**：
   - Windows：在 PowerShell 运行 `Get-AuthenticodeSignature <安装包>`，状态必须是 `Valid`，发布者就是 `DEVICE_WINDOWS_PUBLISHER`。另外截图安装包「属性 → 数字签名」页。如果是未签名内测版，就截 SmartScreen 的提示。
   - macOS：在终端运行 `spctl --assess -vv "/Applications/熊宝数字员工 设备端.app"`，输出必须是 `accepted` 和 `source=Notarized Developer ID`。
3. 安装后打开「熊宝数字员工 设备端」，在 Web 端「我的设备」生成配对码并填入，截图页面显示设备在线和设备名。
4. 让一个员工在这台设备上执行一个普通命令，截图结果。
5. 从托盘退出应用，确认进程列表里没有 `xiongbao-runner`：Windows 看任务管理器并截图；Linux 和 macOS 保存 `ps -e | grep xiongbao-runner` 的空输出。
6. 重启电脑，不重新配对，设备自动上线，截图。
7. 卸载。

把截图、命令输出和系统版本整理好，编辑这个 Release 上传为附件，然后在 `docs/acceptance/STORIES.md` 的 F2 行写上链接。拿到已签名的产物和这份两台机器的证据之后，F2 才能改成 implemented。

**流水线现在自动做的部分**：「熊宝设备端发布」在 `assemble` 之后、`publish` 之前加了 `clean-linux`（`ubuntu-latest`）和 `clean-windows`（`windows-latest`）两个 job，每次都在全新的 GitHub 托管机器上用 `device-release-dist` 里**将要发布的那几个文件**做检查；任何一项不过，Release 就不会发。两份记录 `device-clean-linux-evidence.txt`、`device-clean-windows-evidence.txt`（系统版本、文件 SHA256、签名状态、每项 PASS，最后一行 `RESULT: PASS`）会作为附件跟 Release 一起上传（不进 `SHA256SUMS`），也在运行页的 `device-clean-<os>-evidence` 制品里。同样的检查（同一份 `scripts/ci/device-clean-linux.sh` 和 `scripts/ci/device-clean-windows.ps1`）也在每个 PR 的「熊宝交付 CI」里对 CI 构建的未签名 deb 和 NSIS 安装包跑一遍（job `device clean-machine install (ubuntu-latest)`、`device clean-machine install (windows-latest)`，记录在 `device-clean-<os>-ci-evidence` 制品里）。

- 第 1 步校验和：两台都自动做（Linux `sha256sum -c --ignore-missing`，Windows `Get-FileHash` 对照 `SHA256SUMS`）。
- 第 2 步签名：Windows 自动跑 `Get-AuthenticodeSignature`，已签名的发布必须是 `Valid` 且发布者与 `windows` job 校验过的一致；未签名内测版只记录 `NotSigned`，不因此失败。Linux deb 只核对校验和。
- 第 3 步安装和配对：Linux 用 `sudo apt-get install -y ./xiongbao-device_*_amd64.deb` 安装（依赖从软件源装），检查 `/usr/bin/xiongbao-device`、`/usr/bin/xiongbao-runner` 和桌面入口；再在同一台机器上起真实服务端和 PostgreSQL，通过 API 注册、在「我的设备」生成配对码，用**已安装的** `xiongbao-runner` 配对，确认设备在线、配对码不能用第二次。Windows 用 `/S` 静默安装（Tauri 默认按当前用户装到 `%LOCALAPPDATA%\熊宝数字员工 设备端`，实际的安装方式和目录从卸载项读出并写进记录），检查 `xiongbao-device.exe`、`xiongbao-runner.exe`、卸载项和版本；Windows 上没有带 pgvector 的 PostgreSQL，所以不配对，只跑 runner 自检（`--help`、`--add-root`/`--list-roots`/`--remove-root`）。
- 第 4 步执行命令：Linux 由服务器给设备下发一条不经过模型的命令（`projects.branches`，设备上运行 `git ls-remote`），确认返回结果。Windows 不做。
- 第 5 步退出后无残留：Linux 按 PID 停掉 runner，再两次启动已安装的应用、用 SIGTERM 退出（与托盘「退出」走同一个 `quit()`），每次都确认没有 `xiongbao-runner` 进程、服务器显示离线。Windows 启动已安装的应用，确认它拉起安装目录里的 `xiongbao-runner.exe`，再强制结束应用（比托盘退出更粗暴），确认 `Get-Process` 里没有 `xiongbao-runner`。
- 第 6 步重启后自动上线：Linux 用「不重新配对、重新启动应用、设备重新在线」代替，不是真实重启。
- 第 7 步卸载：Linux `sudo apt-get remove -y xiongbao-device`，Windows `uninstall.exe /S`，都确认程序文件（和 Windows 卸载项）已删除、没有残留进程。

**仍然要人来做的部分**：在真实用户自己的电脑上（不是托管 CI 机器）按上面 1–7 步走一遍；Windows「属性 → 数字签名」页或 SmartScreen 提示的截图；真机重启后不重新配对、设备自动上线（含开机自启）；用真实模型驱动的员工在设备上执行一个普通命令并截图；macOS（若发布）的 `spctl --assess`。托管机器预装了很多软件，也不是普通用户的桌面环境，所以自动记录只能替代"文件对不对、装得上、跑得起来、退得干净、卸得掉"这部分，不能替代真机证据。

### 12.7 暂不签名时怎么安装、怎么减少误报（D3，2026-11-07）

**为什么暂不买**：
- 现阶段只给自己和团队内部用。不签名也能正常安装和运行，真机已验证（第 14 节、G5）。
- 本部署只能用国内云。12.2 的 A、B 两种方式都要用国际版 Azure，现在都用不了。

**不签名的影响**：
- 浏览器下载时可能提示「此文件不常被下载」。
- Windows 会弹蓝色的「Windows 已保护你的电脑」。管理员授权框里的发布者显示「未知」。
- 杀毒软件更容易误报。设备端会运行 PowerShell、常驻后台，以后做桌面操控还会模拟输入，这些都容易被当成可疑行为。
- 只允许运行已签名程序的企业电脑装不上。
- 发版规则不变：未签名的构建只发「未签名内测版」预发布，不会出现没签名的正式版。

**安装说明（发给内部用户）**：
1. 从 GitHub Release 下载 `*-setup.exe`。浏览器提示时点「保留」。
2. 双击后如果出现「Windows 已保护你的电脑」，点「更多信息」，再点「仍要运行」。
3. 管理员授权框显示「发布者：未知」时点「是」。
4. 杀毒软件拦截时，选「信任 / 允许」，或把安装目录加入白名单。

**减少误报（免费，每次发新版后做一次）**：
- **Windows Defender**：在 Microsoft Security Intelligence 的「Submit a file」页面提交安装包，选 Software developer → Incorrectly detected。
- **360、火绒、腾讯电脑管家**：在各自官网的「误报反馈 / 软件白名单申请」入口提交安装包和软件说明。
- 提交时附上 GitHub Release 页面链接和 `SHA256SUMS`，方便核对文件来源。

**以后要对外分发时**：
- 提前 1–2 周购买 **OV 代码签名证书**。EV 自 2024 年起也不能直接跳过 SmartScreen，买 OV 就够。
- 本部署只能用国内云，买的时候选**带云签名服务**的产品，并确认它有命令行工具、能在 GitHub Actions 里调用。另一个选择是用 USB Key 在本人电脑上签名。
- 买好后需要改造发版流水线，新增一种签名方式。12.2 的 A、B 都依赖 Azure，用不上。

## 13. F1：上架百度网盘信息来源

「我的分身」可以把百度网盘当作信息来源（F1 的 S4 连接器来源）。代码：目录条目 `baidu-netdisk`（`server/src/plugins/catalogue.ts`），走百度网盘 xpan REST 接口（`server/src/plugins/baidu-netdisk-rest.ts`），只提供读取类工具（搜索、列目录、查文件信息、读文本文件、查账号），每个人连自己的百度账号。缺的是一个 **百度网盘开放平台应用**：它属于部署方的百度开发者账号，只能由人在百度那边建，然后在管理后台登记。

> Google Drive：已决定暂不启用（2026-11-06，用户决定：团队主要用百度网盘）。目录条目 `google-drive` 仍在代码里；原来的上架步骤（Google Cloud 建 OAuth 客户端、在「插件」页登记）见本文件的 git 历史。

1. **建应用**（用部署方自己的百度账号）：
   1. 打开百度网盘开放平台 `https://pan.baidu.com/union`，登录后按页面提示注册成为开发者（个人或企业，需要实名认证）。
   2. 在控制台「创建应用」，应用名填「熊宝数字员工」，类别按页面选项选（例如「软件」）。
   3. 创建后在应用详情里记下 **AppKey** 和 **SecretKey**。SecretKey 只填到下一步的页面里，不要发给任何人、不要写进仓库或聊天。
   4. 在应用设置里找到授权回调地址一栏（页面上可能叫「授权回调页」或「回调地址」，以页面为准），填：`<你的部署地址>/api/plugins/oauth/callback`（就是 `OPENBOT_PUBLIC_URL` 加这个路径，例如 `https://xiongbao.example.com/api/plugins/oauth/callback`，地址必须完全一致）。
   5. 授权范围是 `basic,netdisk`，由代码在授权时自动带上，不用在平台上另填。如果平台要求提交审核、或在审核前限制可授权的账号，按平台说明处理。
2. **在管理后台登记**（用管理员账号登录部署）：管理后台 → 「员工能做什么 → 插件」→ 找到 **百度网盘** → 添加 → 在「连接」一节的「OAuth 客户端」里，**客户端 ID 填 AppKey，客户端密钥填 SecretKey**，保存后状态显示「已登记」。再按「插件」页的提示把它上架给个人安装。
3. **每个人连自己的账号**：先在「设置 › 已连接的账号」里连接百度网盘，用自己的百度账号授权；再到「我的分身」详情页的「信息来源」里添加一条「连接器」来源，选百度网盘并保存。分身只看得到这个人自己网盘里的文件。
4. **怎么算完成**：一个测试用户连上百度网盘后，在自己网盘里放一份只有自己有的文本文件（`.txt`、`.md`、`.csv` 等），问分身一个只有这份文件才答得出的问题，回答里能看到引用了那份文件；换另一个没有这份文件的人问，答不出来。截图存档，然后告诉我，我把证据写进 `STORIES.md` 的 F1 行。
5. 已知限制：只按文本读取 `.txt`、`.md`、`.csv`、`.json` 这类文件，PDF、Word、图片等只返回文件名、路径、大小等信息；单个文件只读开头一段（与 Google Drive 连接器同样的上限）。在「已连接的账号」里断开，只删除本部署保存的令牌；要让百度那边也撤销授权，需要本人在百度账号的授权管理里取消这个应用。

**验收记录（2026-11-07，京东云部署 `http://111.228.49.160:3772`，服务端 v0.2.1）**

- 百度网盘开放平台应用「xiongbao」：类别为「软件 · 个人使用」，状态「已上线，仅限个人场景使用」；回调地址 `http://111.228.49.160:3772/api/plugins/oauth/callback`。
- 管理后台启用百度网盘后，插件行编号是 `team:baidu-netdisk`。v0.2.1 的插件页因此认不出它的目录条目：页面显示「访问令牌」而不是「OAuth 客户端」，「已连接的账号」里也看不到百度网盘。前端修复是 #315，服务端连接路由修复是 #316。当时的变通做法：
  - 在浏览器控制台调用 `POST /api/plugins/servers/team%3Abaidu-netdisk/oauth-client` 登记客户端，返回 200；
  - 调用 `POST /api/plugins/servers/baidu-netdisk/connect` 进入百度授权页，授权后跳回「已连接的账号」；
  - `GET /api/plugins/connections` 返回 `team:baidu-netdisk`，scope 为 `basic netdisk`。
- 授予员工「我的分身」5 个只读工具后：
  - 问「列出我网盘根目录」，员工调用 `list_files`，列出 25 个文件夹，名称和修改时间与网盘一致；
  - 本人上传 `熊宝测试.txt`，内容是一句暗号；问「找到熊宝测试并读出暗号」，员工先后调用 `search_files` 和 `read_file_content`，答出暗号原文。
- 还没做：用另一个账号问同一个问题，确认读不到本人的网盘。注意：这个应用是「个人使用」类型，百度可能只允许开发者本人授权；要给团队其他人用，需要先在百度开放平台申请企业或公开应用。
- 升级到包含 #315、#316 的版本后，上面的控制台步骤都改从正常页面操作：「插件 › 百度网盘 › OAuth 客户端」和「设置 › 已连接的账号 › 百度网盘 › 连接」。
- **v0.2.3 上线复核（2026-11-08）**：京东云已从南大镜像拉取 v0.2.3，重建容器后 `/health` 返回 200。在「管理后台 › 插件」里，百度网盘只在「已连接」下出现一次，显示「5 个工具 · 1 位员工」，「发现插件」里不再重复出现；链接是 `/admin/plugins/baidu-netdisk`，不带 `team:` 前缀。

OneDrive 不在平台目录里，这一步只涉及百度网盘。

## 14. 本机 MCP：真机验收

员工可以调用你电脑上软件提供的 MCP 工具（设计见 `docs/specs/2026-11-07-device-mcp-bridge.md`）。需要服务器 `v0.2.2` 和设备端 `device-v0.2.2`（或更新）。

1. **准备一个本机 MCP**：在设备端窗口「本机应用（MCP）」里添加（填的命令和密钥只保存在这台电脑上）：
   - 名称：`文件助手`
   - 启动命令：`bunx`（电脑上没有 bun 就用 `npx`）
   - 参数（一行一个）：`@modelcontextprotocol/server-filesystem`、`C:\xiongbao-test2`
   点「测试连接」，应列出 `read_text_file` 等工具。网页「设置 › 我的设备」里这台设备下应显示「本机应用：文件助手」。
2. **列出**：在「我的分身」对话里说「列出本机应用和工具」，应看到文件助手和它的工具。
3. **只读不审批**：说「用文件助手读 C:\xiongbao-test2\.env」，应直接返回 `DEMO=1`（工具声明了只读；本机 MCP 的参数不受 `.env` 敏感路径规则约束，这是设计里写明的取舍）。
4. **写入要审批**：说「用文件助手在 C:\xiongbao-test2 新建 note.txt 写入 hello」，应弹审批；点「允许」后文件出现，只执行一次；再试一次点「拒绝」，文件不会被写。
5. **离线排队**：关掉设备端，**等 5 分钟以上**再重复第 4 步并批准，然后打开设备端：请求应排队，回线后执行，结果回到对话（验证离线/过期后批准仍能执行）。
6. **软件关掉不暂停设备**：把一个本机地址类 MCP（如果有）对应的软件关掉后再调用，应提示「连不上…请确认软件已打开」，「我的设备」不应出现「结果不明，已暂停」。
7. **团队上限**：在团队设置把「电脑上运行命令」设为「从不」，再让分身列出本机应用，应被拒绝且文件助手不被启动；改回原设置。

每一步截图，结果记在本节下面。

## 15. 本机应用发现：真机验收

员工能自己找出你电脑上可用的应用，不用你手动填命令（设计见 `docs/specs/2026-11-08-device-app-discovery.md`）。分两期上线，本节先写第 1 期。

### 第 1 期：员工能列出三组应用

需要服务器 `v0.2.4` 和设备端 `device-v0.2.4-rc.1`（或更新），只支持 Windows。

1. **升级**：京东云服务器按惯例拉取 `v0.2.4` 并重建容器，`/health` 返回 200；电脑上覆盖安装 `device-v0.2.4-rc.1`，设备端窗口显示在线。
2. **列出三组**：在「我的分身」对话里说「我电脑上有哪些可以用的应用」。应看到三组：
   - **已启用**：设备端窗口「本机应用」里已经加过的（例如文件助手）。
   - **可启用**：Claude Desktop、Cursor、VS Code 等软件里配置过、但还没在设备端启用的 MCP，只显示名称和来源（如「Claude Desktop 配置」）。
   - **已安装**：电脑上装了、但没有本机 MCP 的软件（最多 200 个），并提示可以考虑用桌面操控。
3. **不外泄**：在回答、服务器日志（`docker logs xiongbao --since 10m`）和管理后台审计里搜索你的用户名、`C:\Users`、`npx`、配置里的密钥值，应都搜不到。
4. **旧设备端兼容**：如果手边还有一台装旧版设备端的电脑，同样提问，应只列出已启用的应用，并提示「主人电脑上的设备端版本较旧，更新后才能查看可启用的应用。」
5. **带名称只列一个**：说「列出文件助手的工具」，应只回答文件助手，不再列另外两组。

每一步截图，结果记在本节下面。

### 第 2 期：一句话启用

同样需要服务器 `v0.2.4` 和设备端 `device-v0.2.4-rc.1`。**全程先不打开设备端窗口。**

1. **列出**：说「我电脑上有哪些可以用的应用」，员工列出三组。
2. **启用**：说「启用 <可启用组里的某一项>」（优先选 Claude Desktop / Cursor 配置里的 npm 类应用，以验证自带运行时；`文件助手` 已在 §14 手动登记，会出现在「已启用」组，不能用来验收启用）。应弹审批，卡片写着「允许员工使用本机应用「…」？来源：…」。
3. **立即可用**：批准后，员工直接调用它的一个只读工具，结果回到对话（不用等心跳）。
4. **无 Node.js**：如果这台电脑没装 Node.js，第 3 步同时证明 `npx` 改写成自带 Bun 成功。
5. **拒绝**：再启用另一项并点「拒绝」，设备端什么都不写。
6. **设备端窗口**：现在打开设备端窗口，「本机应用」顶部的「发现的应用」里刚启用的那一项开关是开的；关掉后，员工再调用会提示应用已停用；这时再说「启用」它，员工会先向设备重新确认，应再次弹审批，而不是回答「已经启用了」。原来的手动表单在「高级：手动添加」里，默认收起。

每一步截图，结果记在本节下面。

### 第 3 期：内置清单（人工关卡）

内置清单目前为空。每收录一条，都要先在这台电脑上取事实：已安装名、本机地址或 npm 包的精确版本与工具数。取不到或测不通的条目不收录，记作「未收录：原因」。收录的条目单独开 PR。

## 16. 桌面查看（只读）：真机验收

员工能列出并读取你 Windows 电脑上的窗口，但**不能点击、输入或按键**（设计见 `docs/specs/2026-11-07-desktop-control.md`，第 2、3 期按 2026-11-08 的决定暂缓）。需要服务器 `v0.2.4` 和设备端 `device-v0.2.4-rc.1`。

1. **记事本**：新建 `C:\xiongbao-test2\note2.txt`，写一段中文并用记事本打开。对分身说「列出我电脑上的窗口」，应看到「note2.txt - 记事本」；再说「读一下记事本里写了什么」，应读出原文。
2. **计算器**：用计算器算 12×34，让分身读计算器窗口，应读出 408。
3. **资源管理器**：打开 `C:\xiongbao-test2`，让分身读这个窗口，应读出文件列表。
4. **微信**（UIA 覆盖有限）：让分身读微信窗口并附截图，结构树加截图应能读到会话列表。
5. **敏感窗口**：用浏览器打开一个标题含「银行」的页面，让分身读这个窗口，应弹审批，卡片理由里有窗口标题。点「拒绝」不读；再试一次点「允许一次」，只读一次。
6. **开关**：在员工权限页把「查看桌面」设为「禁用」，分身不再有这个工具，硬调也被拒绝；改回原设置。
7. **只有主人**：让团队里另一个人使用同一个员工，看不到桌面工具。
8. **不能操作**：让分身「在记事本里输入你好」，分身应说明自己只能查看、不能操作桌面，记事本内容不变。
9. **浏览器在 Windows 真机上**：按本文件第 11 节（G5 真机设备验证）的步骤在这台 Windows 电脑上复测一遍，结果记在这里。此前设备端用 Bun 1.3.14 编译，在 Windows 上驱动不了 Chrome；本版改用 Bun 1.4.4，CI 上 Windows 有界面探针已全部通过，这一步应能正常打开网页并读取。
10. **非 Windows 设备**（如果有 Linux 或 macOS 设备）：让分身列窗口，应回「这台设备不是 Windows，暂不支持桌面操作。」

须知（不是验收项）：
- 敏感标题认中文词（密码、银行、支付）和英文词（password、bank、paypal，不分大小写）。英文按包含匹配，标题里带 bank 的其它词也会触发审批，宁可多问。
- 没有配置任何审批规则时，敏感窗口和拿不到标题的窗口照样要先审批。
- 截图可能带进盖在目标窗口上的置顶窗口（通知、悬浮窗）。
- 你批准读取的敏感窗口，其控件树文字会随审批记录保存在服务器上，用于恢复对话；截图本身不保存，只留宽高。设备端本机动作日志同样不留截图。服务重启后从审批记录恢复时，员工需要重新读取才能看到图，敏感窗口会再问你一次。
- 桌面读取的审计记录不带最后浏览的网页地址，按网站域名写的规则不作用于桌面读取。
- 必须使用本版设备端；旧版设备端会回复「设备端版本太旧，不支持查看桌面，请先更新设备端。」

每一步截图，结果记在本节下面。任何一项不通过，先查根因，不改验收标准。

## 17. 员工独立电脑（京东云）

每个数字员工的命令以它自己的 Linux 用户（`xb-<12 位十六进制>`）运行，文件只在 `/workspace/bots/<同一串>` 里，员工之间读不到对方的文件。所有真实员工（包括每个人的「我的分身」）都是这样。只有不带员工请求头的调用（例如健康检查）走默认员工，仍用 `/workspace`，以 `pwuser` 运行。设计见 `docs/specs/2026-11-09-per-employee-computer-user.md`。

隔离的单位是员工，不是使用者：多个租户共用的公共员工（例如 `general-assistant`）仍然共用同一个用户和目录。

**交付镜像默认开启**（`COMPUTER_PER_BOT_USERS=on`），升级镜像后不需要另加配置。注意：

- 不要给容器加 `--security-opt no-new-privileges`，它和本功能互斥，加了以后员工电脑会报未就绪。确实需要它时，同时设 `-e COMPUTER_PER_BOT_USERS=off`，回到所有员工共用一个用户的旧行为。
- **员工不能再用 sudo 装系统包**（`sudo apt-get install` 会失败）。镜像已预装 git、jq、python3（含 venv）。员工可以在自己目录里用 `npm install`（不带 `-g`）、`bun add`，或 `python3 -m venv .venv` 后用 `.venv/bin/pip install` 装用户级工具；还缺的系统包请提需求，预装进镜像。
- **旧文件不会自动归到员工名下**。升级前所有员工共用 `/workspace`，升级后旧文件仍留在 `/workspace` 根目录，只有默认员工（不带员工请求头的调用）看得到，真实员工都从自己的空目录开始。京东云目前用的是设备模式，云端 `/workspace` 通常是空的，一般不需要处理。确实要把某些旧文件交给某个员工时，见下面「手工迁移旧文件」。
- 已有数据卷照常挂载。容器每次启动都会收紧 `/workspace`、`/workspace/bots`、`/profiles` 的权限，并按 `/workspace/.xb-users` 恢复员工用户，同一员工的 uid 和文件归属不变。

**升级后确认已生效**（任选其一）：

1. 看健康检查，`perBotUsers.ready` 应为 `true`：
   ```sh
   docker exec <容器名> curl -s http://127.0.0.1:4100/health
   ```
   输出里应有 `"perBotUsers":{"enabled":true,"ready":true}`，`status` 为 `ok`。
2. 在两个不同员工的对话里，各让员工执行 `id -un`：两个结果都应形如 `xb-` 加 12 位十六进制，且互不相同。「我的分身」也是真实员工，结果同样形如 `xb-…`，不是 `pwuser`。

**遇到未就绪怎么排查**：健康检查返回 HTTP 503、`status` 为 `unready`，或员工执行命令时提示「员工独立电脑未就绪：…」。

1. 看收紧失败的原因（文件不存在说明启动时的收紧没有失败）：
   ```sh
   docker exec <容器名> cat /run/xb-bot/unready
   ```
   常见原因是数据卷不支持 ACL 或 root 无法 chown（例如 NFS root_squash）。换成支持 ACL 的本地卷后重启容器。
2. 看健康检查里的 `perBotUsers.reason`：「辅助程序不可用」多半是加了 `no-new-privileges`，或镜像不是交付镜像；「要求工作目录为 /workspace」说明改了 `WORKSPACE_DIR`。
3. 看容器日志里以 `xb-bot:` 开头的行：`docker logs <容器名> 2>&1 | grep 'xb-bot:'`。
4. 未就绪时只有非默认员工受影响（命令和文件工具返回 503），默认员工和网页照常可用。修不好又急用时，可临时加 `-e COMPUTER_PER_BOT_USERS=off` 重建容器，回到共用一个用户的旧行为。

**手工迁移旧文件**（只在确实需要时做，以 root 在容器里执行）：

1. 算出员工的 botKey：员工 id（形如 `agent_<uuid>` 或 `avatar-<租户 id>`）做 sha256，取前 12 位十六进制。
   ```sh
   key=$(printf %s '<员工 id>' | sha256sum | cut -c1-12); echo "$key"
   ```
2. 先让这个员工执行一次任意命令（例如 `pwd`），系统会建好 `xb-$key` 用户和 `/workspace/bots/$key` 目录。
3. 把文件搬过去，交给该员工，并补上文件工具（pwuser）需要的 ACL：
   ```sh
   docker exec -u root <容器名> sh -c '
     key=<第 1 步的 key>; name=<要搬的文件或目录名>
     mv "/workspace/$name" "/workspace/bots/$key/"
     chown -R "xb-$key:xbcomp" "/workspace/bots/$key/$name"
     setfacl -R -m "u:xb-$key:rwX,u:pwuser:rwX,o::---" "/workspace/bots/$key/$name"
     find "/workspace/bots/$key/$name" -type d -exec setfacl -d -m "u:xb-$key:rwx,u:pwuser:rwx,o::---" {} +
   '
   ```
4. 让该员工执行 `ls -l` 确认能看到这些文件，属主是 `xb-$key`。

验收：按「升级后确认已生效」两项各做一次，再让员工 A 写一个文件，让员工 B 去读，B 应读不到。结果记在本节下面。

## 18. 桌面操作第 2 期：macOS / Linux / 多显示器真机验收

员工能在你的 macOS 电脑上点击、输入、按键、切换和启动应用、等待控件、读写剪贴板；Linux 只能查看（试用）；Windows 仍只能查看（设计见 `docs/specs/2026-11-12-desktop-write-agent-desktop.md`）。需要服务器 `v0.2.10` 和同版本的设备端。macOS 安装包目前是未签名内测版（Apple 证书和公证尚未完成），首次打开要在「系统设置 → 隐私与安全性」里放行。

**macOS**
- [ ] 1. 第一次运行：全新安装后，按引导开启辅助功能；验证「未授权时的提示 → 开启 → 自动变成已允许」，以及更新一个版本后**不用**重新授权。
- [ ] 2. 备忘录或文本编辑：写一段中文并保存，读回一致。
- [ ] 3. 微信：读出会话列表；在输入框写一句话；按 Enter 发送时弹出逐次审批，拒绝后确实没发出去。
- [ ] 4. 一个 Electron 应用（如 VS Code、飞书或钉钉）：能读出主要按钮并点击一次。
- [ ] 5. 叫停：会话中动一下鼠标、按一次停止键，各自都能立即停下，且必须重新审批。

**多显示器**（任一平台）
- [ ] 窗口在副屏时能列出、能读、能截图；需要真实鼠标点击的控件在副屏上点得准。

**Linux**（可选）
- [ ] 在 GNOME 桌面上能列窗口和读取；写动作得到「只能查看」的提示。

**真机待确认项**（实现时留下的疑点，每项记下实际现象）
- [ ] 删除键 `forwarddelete`：在文本框里用 key 工具按它，确认真的删掉光标后一个字符。
- [ ] `textarea`、`searchfield`、`combobox` 三种控件角色都能输入。
- [ ] 长文本在有头模式（headed）下输入：不超时；超时的话记下多长的文本、等了多久。
- [ ] `--wait-for` 只给名字、或只给类型时的写法：两种各试一次，记下哪种写法被接受。
- [ ] 等待超时的实际错误码：等一个不会出现的控件，记下返回的错误码和中文提示。
- [ ] `clipboard-get` 的返回格式：复制一段文字和一个文件，记下各自返回什么。
- [ ] 名字里带 `:` 的控件：点击或输入，确认能按名字找到。
- [ ] 两个会话下的停止热键：同时有两个桌面会话时按 Ctrl+Alt+Esc（⌃⌥⎋），确认两个都停。
- [ ] 退出时不死锁：会话进行中退出设备端，确认能正常退出、不卡住。

**终审补充**（最终整分支评审的修复，每项都必须弹出逐次审批）
- [ ] 熊宝自己的界面：会话中让员工去点熊宝网页上的「允许一次」，必须被逐次审批拦下；拒绝后那张审批卡片仍未被批准。
- [ ] 熊宝自己的界面：会话中让员工去改团队敏感词表（输入并点保存），必须被逐次审批拦下；拒绝后词表没有变化。
- [ ] 熊宝自己的界面：会话中让员工点设备端窗口或熊宝桌面客户端里的按钮，必须被逐次审批拦下。
- [ ] 终端：会话中让员工在「终端」（Windows 上为 PowerShell / Windows Terminal）里输入一条命令，必须逐次审批；拒绝后命令没有执行。
- [ ] 中文 macOS 的终端：在中文系统上列出窗口，记下「终端」窗口实际的进程名（`app_name`，预期为「终端」或 `Terminal`），并确认在它里面的写动作逐次审批。
- [ ] 批准后再问：会话中让员工点一个完整名字很长、「删除」在第 120 个字之后的按钮，批准第一张卡后，按钮绝不能直接被点下去：这次调用失败，员工收到中文提示「设备发现了确认卡上没写的情况：……请再调用一次……」。员工再调用一次时，第一张卡要写明「删除」和完整控件名，批准后才点下去，只点一次；拒绝则不点。
- [ ] 带换行的输入：在微信输入框用追加方式（`append`）输入带换行的文字，必须弹逐次审批；拒绝后消息没有发出去。
- [ ] 改名后的部署：换一个租户包（产品名不同）后，网页标签标题含新产品名时同样被逐次审批拦下。
- [ ] 永久删除快捷键（macOS）：在访达里选中一个测试文件按 `cmd+backspace`，必须逐次审批；拒绝后文件还在。
- [ ] 永久删除快捷键（Windows（引擎开关打开时））：在资源管理器里选中一个测试文件按 `shift+delete`，必须逐次审批；拒绝后文件还在。
- [ ] 助记键（Windows（引擎开关打开时））：在带「发送(S)」按钮的窗口里按 `alt+s`，必须逐次审批。
- [ ] 长控件名（I1）：点一个完整名字很长、「删除」在第 120 个字之后的按钮（网页或 Electron 应用里找），批准会话卡后，设备端必须再弹一张写明完整控件名的审批卡。

每一步截图，结果记在本节下面。任何一项不通过，先查根因，不改验收标准。

## 19. 桌面操作第 2 期：Windows 真机验收（引擎开关）

Windows 默认仍是旧的读取器，只能查看。本节在你自己的 Windows 电脑上，用环境变量把引擎切到 agent-desktop，逐项验收写动作。全部通过并回复「Windows 验收通过」之后，下一版才会把 Windows 默认切过去；有没通过的项，请把编号和现象发回来。

前提：服务器和设备端都升级到 `v0.2.10`（含「Windows 在引擎开关下操作桌面」，PR-9）。

- [ ] 1. 在 PowerShell 里运行 `setx XIONGBAO_DESKTOP_ENGINE agent-desktop`，然后彻底退出设备端（托盘里选退出），再重新打开。
- [ ] 2. 两个引擎读取对比：
  - 先运行 `& "<安装目录>\xiongbao-runner.exe" --desktop-compare --desktop-helper "<安装目录>\agent-desktop.exe"`；
  - 打开记事本、资源管理器、微信和一个 Electron 应用（如 VS Code、飞书或钉钉）后再运行一次；
  - 把两次输出都贴回来。两边都要能读出关键控件，「agent-desktop 缺少」一栏列出的控件请特别留意。
- [ ] 3. 记事本写中文（走 set-value）并按 Ctrl+S 保存，再打开文件核对内容一致；计算器算 12×34，结果是 408。
- [ ] 4. 微信：让员工在输入框写一句话，按发送时弹出逐次审批；拒绝后确实没有发出去。
- [ ] 5. 打开中文输入法，让员工用真实键盘方式输入一段中文：结果不乱码、不被输入法吞字。**请截图。**
- [ ] 6. 让员工用真实鼠标点击一次：提示条显示「正在移动鼠标」；点击后你一动鼠标，会话立即停下，之后要重新审批。**请截图。**
- [ ] 7. 打开一个以管理员身份运行的窗口，让员工去操作：得到明确的「需要管理员权限」提示。
- [ ] 8. 验收结束后，如果想恢复旧引擎：运行 `setx XIONGBAO_DESKTOP_ENGINE ""`，再彻底退出并重开设备端。
**终审补充（Windows）**（每项都必须弹出逐次审批；与第 18 节同名项一致）
- [ ] 熊宝自己的界面：会话中让员工去点浏览器里熊宝网页上的「允许一次」、去改团队敏感词表，都必须被逐次审批拦下。
- [ ] 终端：会话中让员工在 PowerShell 或 Windows Terminal 里输入一条命令，必须逐次审批；拒绝后命令没有执行。
- [ ] 永久删除：在资源管理器里选中一个测试文件按 `shift+delete`，必须逐次审批；拒绝后文件还在。
- [ ] 助记键：在带「发送(S)」按钮的窗口里按 `alt+s`，必须逐次审批。
- [ ] 带换行的输入：在微信输入框用追加方式输入带换行的文字（Windows 上追加总是用真实键盘），必须逐次审批；拒绝后消息没有发出去。

- [ ] 9. 回复「Windows 验收通过」，或者列出没通过的项。

另请顺带留意：如果 `XIONGBAO_DESKTOP_ENGINE` 写错（例如大小写不对），runner 会按未设置处理（仍是旧引擎、只能查看），并在设备端日志里记一行「桌面引擎「…」不认识」。遇到写动作一直被拒绝时，先看这一行。

## 20. 招入外部智能体（Codex、Claude Code）真机验收

「外部员工」是把你电脑上已经装好的 Codex、Claude Code 招成熊宝员工：它在你的电脑上、你指定的文件夹里干活，干活过程实时出现在对话里，需要你点头的操作（比如推送代码）进「等你确认」，你可以在手机网页上批准。设计见 `docs/specs/2026-11-15-external-agents.md`，计划见 `docs/plans/2026-11-15-external-agents.md`。

本节以一台 Windows 电脑加一部手机为主；macOS 单列在最后，有 Mac 再做。需要服务器 `v0.2.15` 和设备端 `device-v0.2.15-rc.1`（或更新）。旧版设备端（如 `device-v0.2.10-rc.1`）不含这个功能，「从我的电脑招」找不到任何智能体，不要用旧版验。

每一步一旦和「期望」不一样，截整个屏幕（含任务栏的时间），并把设备端窗口「日志」里最后 30 行复制下来；报错的中文原文请原样截下来。首次验收出问题是预期内的（适配器还没有在真机上跑过），问题另开修复任务，不改验收标准。

### 20.1 服务器一侧的前提（由部署的人核对，不用在电脑上做）

- [ ] 服务器已升到 `v0.2.15`。
- [ ] 部署的公网地址已设置：环境变量 `OPENBOT_PUBLIC_URL`（没设就取 `BETTER_AUTH_URL`），而且是**电脑和手机都能打开**的地址。外部员工用的「模型代理」地址就是它加 `/api/agent-model`；两个都没设，模型代理地址不会下发，外部员工会改用你电脑上自己的 Codex、Claude Code 登录。
- [ ] 模型代理保持默认开启：不要把 `XIONGBAO_AGENT_MODEL_PROXY` 设成 `off`、`0` 或 `false`。
- [ ] 手机能打开这个地址：云服务器的安全组和防火墙放行了对应端口。验收可以先用 HTTP，但 HTTP 下登录信息和模型代理令牌是明文传输，不要把它当成正式形态。
- [ ] 外部员工没有绑定模型时，会用租户的默认模型；这个默认模型必须是 DeepSeek、OpenAI（Codex 用）或 Anthropic（Claude Code 用）这一类。智谱、各种中转等不兼容，员工会报中文提示（例如「这位员工的模型不支持 Codex 接入」），这时请换默认模型再试。
- [ ] 核对办法：在服务器上用 `docker exec <容器名> env` 查看上面几项的名字是否已设置（只看有没有，不要把密钥值发给任何人或写进文档）。

### 20.2 事先准备（约 30 分钟，一次性）

1. 一个 GitHub 账号，新建一个**私有**空仓库，名字随意，例如 `xiongbao-practice`。Claude 会给你一个练习用小项目（几个文件、一条命令能跑测试、README 里有错别字），你把它传到这个仓库里。
2. 安装 **Git for Windows**（https://git-scm.com ，一路下一步）。在「开始」菜单搜 PowerShell 打开，输入 `git --version`，能看到版本号就行。
3. 把仓库下载到电脑：`git clone https://github.com/你的账号/xiongbao-practice.git C:\xiongbao-practice`。第一次会弹窗让你登录 GitHub，按提示登录。
4. 确认推送不用再输密码：`cd C:\xiongbao-practice`，改一个字，`git commit -am 试一下`，`git push`；成功后按 Claude 给你的命令撤回这次提交。这一步是为了排除「推送本身要登录」对验收的干扰。
5. 安装 **Node.js**（LTS 版本，https://nodejs.org ，一路下一步）。装完**重新打开** PowerShell，输入 `npx --version`，要能看到版本号。熊宝用它下载「适配器」；缺它的话，「招进来」按钮是灰的，提示先装 Node.js。
6. 安装 Codex 和 Claude Code 两个命令行程序（只为让熊宝找得到它们；你不用登录、不用填任何密钥，模型走熊宝服务器）：在 PowerShell 里依次运行 `npm install -g @openai/codex` 和 `npm install -g @anthropic-ai/claude-code`，再各运行一次 `codex --version`、`claude --version`，都能看到版本号。
7. 国内网络下 npm 很慢或失败时：在 PowerShell 里运行 `setx XIONGBAO_NPM_REGISTRY https://registry.npmmirror.com/`（镜像地址以 Claude 给你的为准），然后**彻底退出设备端再重新打开**。熊宝下载适配器用的就是这个源；不设时默认是 `https://registry.npmjs.org/`。安装上面两个命令行时也可以加 `--registry` 参数用同一个镜像。
8. 手机准备好：能打开熊宝网页（地址同电脑浏览器用的那个），并已登录你的账号。

### 20.3 下载并安装设备端（Windows）

1. 电脑浏览器打开仓库的 Releases 页，找到「熊宝数字员工 设备端 0.2.15（未签名内测版）」（预发布，标签 `device-v0.2.15-rc.1`），下载 `xiongbao-device_0.2.15_x64-setup.exe`。
2. 双击安装。出现蓝色「Windows 已保护你的电脑」时点「更多信息」→「仍要运行」；杀毒软件拦截就先放行（未签名版的已知情况）。
3. 安装完成后打开「熊宝数字员工 设备端」。
   - 期望：出现一个小窗口，标题「熊宝数字员工 设备端」，有「服务器地址」「配对码」两个输入框。
   - 失败截图：安装报错对话框；窗口打不开则截任务管理器里有没有 `xiongbao-device`。

### 20.4 配对

1. 浏览器登录熊宝网页，进「设置 → 我的设备」，点「生成配对码」。以前配对过旧版的，也建议重新配一次。
2. 在设备端窗口填入页面上显示的服务器地址和配对码，点「配对」。
   - 期望：设备端窗口状态变成「在线」；网页「我的设备」里出现这台电脑，显示「在线」。
   - 失败截图：设备端窗口加网页「我的设备」页。
3. 在设备端窗口找到「本地文件夹」，路径填 `C:\xiongbao-practice`，点「添加文件夹」。
   - 期望：列表里出现这个文件夹。

### 20.5 招 Codex

1. 熊宝网页 → 通讯录 → 「招一位新同事」→ 页签「从我的电脑招」，选这台电脑，点「重新查找」。
   - 期望：看到 Codex、Claude Code 两张卡，带「已安装」标签，「招进来」按钮是亮的（可点）。「已登录」标签可能是未知或未登录，忽略即可。没装的 Hermes 会显示没装，也忽略。
   - 失败截图：这一页整屏；按钮是灰的就把卡片上的红字或黄字提示截下来。
2. 点 Codex 的「招进来」：名字用默认或叫「小码」，部门随便，工作文件夹选 `xiongbao-practice`，「哪些事要先问你」保持默认，确认招入。
   - 期望：通讯录里出现新员工，带「外部员工 · Codex」标记，状态点是绿色；名片里写着「在 <你的电脑名> 上」。
3. 进入和它的单聊，发这句话：「请把 README 里的错别字改掉，改完运行测试，测试通过后把改动提交并推送到 GitHub。」
   - 期望（按顺序出现）：
     a. 对话里出现「进度」卡，步骤逐条打勾；
     b. 出现「改动」卡，列出改了哪些文件和加减行数，可展开看；
     c. 出现测试命令的运行结果（通过）；
     d. 出现一张「请求许可」卡，内容是 `git push ...` 命令原文，有「批准」「拒绝」等按钮；员工显示「等你确认」，看板卡片是「需要操作」。
   - 首次启动适配器要联网下载，可能等 1 到 3 分钟，这期间显示「正在启动」属正常；超过 5 分钟没动静就截图。
   - 失败截图：对话整屏；设备端窗口「日志」末尾；员工直接报错时，把中文报错原样截下来。
4. 拿手机打开熊宝网页并登录，进「我的 → 等你确认」，或在地址栏服务器地址后面加 `/approvals`，点开那条审批。
   - 期望：看到命令原文 `git push`、员工名、在哪台电脑上、说明；屏幕底部固定一个大的「批准」按钮，旁边有「拒绝」。（目前没有自动推送到手机，要自己打开网页看。）
   - 点「批准」。期望：电脑上对话里的卡片变成「已由你批准」，员工接着做完，最后说已推送；在 GitHub 网页上打开仓库，看到一条新提交。
   - 失败截图：手机审批页整屏；对话整屏；GitHub 提交列表页。
5. 成功标准：Codex 完成「改代码 → 跑测试 → 请求推送 → 手机批准 → 推送成功」。

### 20.6 招 Claude Code（必须在本机跑）

Claude Code 在熊宝里有两种跑法：默认在熊宝云电脑里，和你这台电脑无关；本节要验的是设备端，所以必须把「运行位置」切到「本机」。

1. 招法一（推荐，和 20.5 一样）：通讯录 → 招一位新同事 →「从我的电脑招」→ 点 Claude Code 的「招进来」，名字可叫「小克」，工作文件夹同样选 `xiongbao-practice`。
   招法二：在「固定员工」页签一键启用 Claude Code，再到它的员工设置里把「运行位置」切到「本机」，选这台电脑和工作文件夹。
   - 期望：新员工带「外部员工 · Claude Code」标记，名片里写「在 <你的电脑名> 上」。如果写的是「云电脑」，说明没切到本机，重来。
2. 先在 PowerShell 里 `cd C:\xiongbao-practice` 再 `git pull`，避免和上一步的提交冲突。然后发：「请把 README 里的第一个标题加上你的名字，改完运行测试，通过后提交并推送。」
3. 之后的期望、手机批准、成功标准与 20.5 的第 3 到 5 步相同。
   - 失败截图同 20.5；首次下载适配器失败时，截日志。
4. 附带（不依赖设备端，另算一项）：再招一位默认「云电脑」位置的 Claude Code，让它做一件不涉及你本机文件的小事，记录能否正常回复；若没有模型，请部署的人核对 `XIONGBAO_AGENT_MODEL_COMPUTER_URL`（云电脑访问服务器的地址）。

### 20.7 断网再恢复（用 Codex 或 Claude Code 之一）

1. 在对话里先发「你好，报个到」，确认员工能回。
2. 拔掉网线或关 Wi-Fi，让电脑完全断网，等 1 分钟。
   - 期望：用手机打开网页（手机仍有网络），员工状态点变灰，显示「离线 · 0 件排队中」。
3. 手机上给它发一件新活：「在 README 末尾加一行『离线测试』并提交，不要推送」。
   - 期望：状态变成「离线 · 1 件排队中」，对话里这件活显示排队，可以取消。
4. 恢复电脑网络，等 1 到 2 分钟。
   - 期望：状态点回到绿色；排队的活自动开始并做完，对话里出现进度和改动卡。
   - 失败截图：手机上的离线条整屏；恢复后对话整屏；设备端「日志」。
5. （选做）一件活正在做时断网：期望网络恢复后这一轮继续并补上之前的进度；如果出现许可请求，也只有一条「等你确认」，不会重复出现两条。

### 20.8 macOS（可选，有 Mac 再做）

- 需要先把仓库变量 `DEVICE_RELEASE_MACOS` 设为 `true` 并重跑设备端发布，才会出 `..._aarch64.dmg`（Apple 芯片、未签名）；Intel 的 Mac 没有安装包。
- 前置：Node.js、`codex`、`claude`、Git。第一次打开应用要「按住 Control 点按应用 → 打开」，或在「系统设置 → 隐私与安全性」里点「仍要打开」。
- 其余步骤同 20.4 到 20.7，路径换成 `~/xiongbao-practice`，git 命令在「终端」里执行。macOS 的桌面操作授权（辅助功能）与本节无关，不用管。

### 20.9 收尾

- 在网页「我的设备」里把这台电脑留着就行，不用解除配对。
- 把所有截图发给 Claude，并回复 20.5、20.6、20.7（以及 20.8 如果做了）各是「通过 / 不通过 / 没做」。Claude 据此更新 `docs/acceptance/STORIES.md` 的外部员工条目，问题另开修复任务。

## 21. v0.2.16 改名升级（京东云交付容器，从 v0.2.15）

v0.2.16 把系统里剩下的旧名字统一换成熊宝自己的名字：数据库的超级用户、库、两个应用角色、数据库函数与触发器、系统写进数据库的标记、对话历史里系统写的名字、已存凭据的加密格式（重新加密，内容不变）、配置名前缀 `OPENBOT_` → `XIONGBAO_`。这些都在 v0.2.16 **第一次启动时自动完成**：先把数据库完整备份到数据库卷上，再在一个事务里改业务库，最后改超级用户和库名，然后才启动服务。之后每次启动都不再做，也不再备份。

- **浏览器扩展已经删除**（「教员工做事」录制和熊宝浏览器一起删了）。浏览器里装过旧扩展的，卸掉即可，不用装新的。
- **设备端要重装 v0.2.16**（第 ⑥ 步）。服务器先升、设备端后升也没关系：旧设备端在这段时间照常能连上干活。
- 这台服务器的现状（2026-11-24 摸底）：库约 107 MB，卷上可用约 37 GB，备份空间足够；改名要重新加密的凭据 3 条；自动化钩子签名、OpenTag、学习/Intelligence、共享账号身份都是 0，web-bot-auth 没开，所以**没有要重新连接的东西**（第 ⑦ 步升级当天复查一次）。
- 停服时间：备份加迁移大约一两分钟，加上拉镜像之外的操作，网站中断约 5 分钟。
- 这台用的是内置数据库，外接库、Helm、自己写了 `DATABASE_URL` / `ROLE_WRITER_DATABASE_URL` 的部署才要做的事（连接串里的角色名改新名、md5 口令重设、迁移环境带 `KEY_ENCRYPTION_KEY`、先停旧副本、自己做实例快照、Helm 加 `nameOverride`）这里都不涉及；那些写在部署手册第 4 节和 6.3 第 8 条。
- **回滚**和以前不一样：改名完成后，v0.2.15 登录不了改过名的库，不能再「换回旧镜像」了事。回滚 = 用升级前的备份还原到一个新卷 + v0.2.15 镜像，升级之后写进去的数据会丢（见本节末尾「回滚」）。所以升级后先按第 ⑤ 步核对清楚，再放开使用。

下面的命令都在京东云服务器上以 root 执行，原样复制即可。网页终端断开也没关系：每一步要用的东西都存在 `/opt/xiongbao/upgrade-v0.2.16` 里，重连后从断开的那一步接着做。命令里不含任何口令或密钥，输出里也不会打印。

前提：`v0.2.16` 的发布流水线成功，镜像已同步到京东云仓库，发布记录 `container-images.json` 已传到 Release（发布后由 Claude 确认）。新镜像按发布记录里的 digest 拉取，不用人工比对。

### 21.0 准备：下载自查脚本和发布记录、按 digest 拉新镜像、记下新旧镜像

1. 下载升级要用的三个脚本（都只读或只改 env 文件，后面几步用）和 v0.2.16 的发布记录 `container-images.json`：

<!-- v0216:fetch:begin -->
```bash
(
  set -eu
  D=/opt/xiongbao/upgrade-v0.2.16
  mkdir -p "$D"
  chmod 700 "$D"
  for f in pre-upgrade-check.sh prod-inspect.sh rewrite-env.sh; do
    curl --fail --silent --show-error --location -o "$D/$f" \
      "https://raw.githubusercontent.com/canquedehuiyi-cpu/xiongbaowork/v0.2.16/xiongbao/scripts/rebrand/$f"
  done
  curl --fail --silent --show-error --location -o "$D/container-images.json" \
    "https://github.com/canquedehuiyi-cpu/xiongbaowork/releases/download/v0.2.16/container-images.json"
  ls -l "$D"
)
```
<!-- v0216:fetch:end -->

2. 从发布记录取新镜像（发布流水线同步到京东云仓库的那份，按 digest，不靠可以移动的标签），并记下现在跑的 v0.2.15 镜像（回滚时用）。
   `jq` 用正在运行的 v0.2.15 容器里自带的，服务器上不用装：

<!-- v0216:images:begin -->
```bash
(
  set -eu
  D=/opt/xiongbao/upgrade-v0.2.16
  NEW_IMAGE=$(docker exec -i xiongbao jq -er '.images.xiongbao.reference' < "$D/container-images.json")
  if ! printf '%s\n' "$NEW_IMAGE" | grep -Eqx 'xiongbao-work-cn-north-1\.jcr\.service\.jdcloud\.com/xiongbao@sha256:[0-9a-f]{64}'; then
    echo "发布记录里的镜像不是京东云仓库按 digest 的引用：$NEW_IMAGE。先把这一行发给 Claude，这次什么都没写。"
    exit 1
  fi
  OLD_IMAGE=$(docker inspect --format '{{.Config.Image}}' xiongbao)
  printf 'NEW_IMAGE=%s\nOLD_IMAGE=%s\n' "$NEW_IMAGE" "$OLD_IMAGE" > "$D/images.env"
  cat "$D/images.env"
)
```
<!-- v0216:images:end -->

`NEW_IMAGE` 就是发布记录里的那一个（发布流水线核对过它的 digest），`OLD_IMAGE` 应该是 v0.2.15 那次用的 `…/xiongbao@sha256:19f8151c…`。把这两行发给 Claude 留底。

3. 登录京东云仓库：在京东云控制台注册表 `xiongbao-work` 那一行点「获取临时令牌」，把它给出的 `docker login …` 命令复制到服务器上执行，看到 `Login Succeeded` 就行。这条命令带着临时密码，只在服务器上执行，不要发给别人。

4. 按 digest 拉新镜像（放在后台跑，网页终端断开也不影响）：

<!-- v0216:pull:begin -->
```bash
(
  . /opt/xiongbao/upgrade-v0.2.16/images.env
  setsid nohup sh -c 'for i in 1 2 3 4 5; do docker pull "$1" && echo PULL_OK && exit 0; sleep 20; done; echo PULL_FAILED' sh "$NEW_IMAGE" \
    > /opt/xiongbao/upgrade-v0.2.16/pull.log 2>&1 < /dev/null &
)
```
<!-- v0216:pull:end -->

隔一两分钟看一次，显示 `PULL_OK` 就是拉好了：

```bash
tail -n 2 /opt/xiongbao/upgrade-v0.2.16/pull.log
```

### 21.① 升级前自查（还在 v0.2.15 上，只读）

先在网页里把「待审批」全部批准或拒绝，等已批准的任务续跑完，并确认这几分钟里没有正在执行的对话或任务。然后：

<!-- v0216:check:begin -->
```bash
(
  D=/opt/xiongbao/upgrade-v0.2.16
  sh "$D/pre-upgrade-check.sh" xiongbao
  echo '--- 第 ⑦ 步的几项与凭据（升级前）'
  sh "$D/prod-inspect.sh" xiongbao /opt/xiongbao/.env.delivery |
    grep -E '^(automation_hooks_signed|opentag_chat_bindings|learning_[a-z_]+|shared_account_[a-z_]+|web_bot_auth_env_named|approval_exact_input_[a-z]+|credentials_[a-z0-9_]+)='
  echo '--- 现在这个容器的卷和端口'
  docker inspect xiongbao --format '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}'
  docker inspect xiongbao --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}:{{.HostPort}}->{{$p}} {{end}}{{end}}'
  echo '--- 现在这个容器的其它启动参数'
  docker inspect xiongbao --format 'shm={{.HostConfig.ShmSize}} memory={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} restart={{.HostConfig.RestartPolicy.Name}} network={{.HostConfig.NetworkMode}} security={{.HostConfig.SecurityOpt}} capadd={{.HostConfig.CapAdd}} devices={{len .HostConfig.Devices}}'
  echo '--- 本机所有容器'
  docker ps -a --format '{{.Names}}  {{.Status}}  {{.Image}}'
)
```
<!-- v0216:check:end -->

看这几处：

- 最后一行是「结论：可以升级」。不是的话按它打印的办法处理（待审批、续跑、空间），处理完再跑一次这一步。
- `automation_hooks_signed`、`opentag_chat_bindings`、`learning_…`、`shared_account_…`、`web_bot_auth_env_named`、`approval_exact_input_…` 都是 `0`（不是 0 的，先别升级，把输出发给 Claude）。
- `credentials_…` 只是记一下：`credentials_live_kid_k1` 就是升级时要重新加密的在用凭据数（摸底时是 3）。
- 卷是 `xiongbao-db:/var/lib/postgresql`、`xiongbao-workspace:/workspace`、`xiongbao-profiles:/profiles`，端口是 `3772->3001/tcp` 与 `3773->3773/tcp`（顺序可以不同）。不一样的话先别往下做，把输出发给 Claude：第 ③ 步的命令是按这几个名字写的。
- 其它启动参数一行应是 `shm=67108864 memory=0 cpus=0 restart=unless-stopped network=default security=[] capadd=[] devices=0`（`network` 也可能显示 `bridge`，一样）。有别的值说明当初建容器时多加了参数，第 ③ 步的命令里没有，先发给 Claude。
- 容器列表里除了 `xiongbao`（运行中）和以前切换留下的、停着的 `xiongbao-v0212-rollback`、`xiongbao-v0214-rollback`，如果还有别的员工框架镜像在跑（名字里带 `agent-` 的），告诉 Claude：它们要和服务器一起升级。

再确认要重新加密的凭据都能用现在的 `KEY_ENCRYPTION_KEY` 解开（只读：只查库、在容器里试着解开，不改任何东西，不打印密钥和凭据内容）。有解不开的，v0.2.16 的迁移会整体回滚、拒绝启动（数据不动，可以按回滚 A 回来），所以先在这里查清：

<!-- v0216:credcheck:begin -->
```bash
(
  printf '%s\n' "SET default_transaction_read_only = on;" \
    "SELECT coalesce(json_agg(json_build_object('id', id, 'tenant', tenant_id, 'kind', kind, 'value', encrypted_value) ORDER BY id), '[]') FROM credentials WHERE encrypted_value LIKE '{\"version\":2,%' AND encrypted_value LIKE '%\"kid\":\"k1\"%';" |
    docker exec -i xiongbao sh -c 'url=$(cat /run/s6/container_environment/MIGRATION_DATABASE_URL); exec /usr/lib/postgresql/16/bin/psql "$url" -X -q -A -t' |
    docker exec -i xiongbao sh -c 'OPEN_KEY=$(cat /run/s6/container_environment/KEY_ENCRYPTION_KEY) exec bun -e "$0"' '
const frame = (p) => { const b = Buffer.from(p, "utf8"); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return [n, b]; };
const key = await crypto.subtle.importKey("raw", Buffer.from(process.env.OPEN_KEY, "base64"), { name: "AES-GCM" }, false, ["decrypt"]);
const rows = JSON.parse((await Bun.stdin.text()).trim() || "[]");
const bad = [];
for (const r of rows) {
  try {
    const e = JSON.parse(r.value);
    const aad = Buffer.concat(["openbot.vault.credential.v2", r.tenant, r.id, r.kind].flatMap(frame));
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(e.iv, "base64"), additionalData: aad }, key, Buffer.from(e.ciphertext, "base64"));
  } catch { bad.push(`${r.id}（租户 ${r.tenant}，种类 ${r.kind}）`); }
}
console.log(`要重新加密的旧格式凭据 ${rows.length} 条，能解开 ${rows.length - bad.length} 条` + (bad.length ? `，解不开 ${bad.length} 条：${bad.join("、")}` : "。"));
'
)
```
<!-- v0216:credcheck:end -->

应打印「要重新加密的旧格式凭据 N 条，能解开 N 条。」（N 是 3 或 4，含已停用的）。有「解不开」的先别升级，把这一行发给 Claude。

### 21.② 改写 env 文件里的旧配置名

<!-- v0216:rewrite-env:begin -->
```bash
sh /opt/xiongbao/upgrade-v0.2.16/rewrite-env.sh /opt/xiongbao/.env.delivery
ls -l /opt/xiongbao/.env.delivery*
grep -c '^OPENBOT_' /opt/xiongbao/.env.delivery
```
<!-- v0216:rewrite-env:end -->

它会列出改了哪几个名字（摸底时是 `OPENBOT_PUBLIC_URL`、`OPENBOT_RLS_ENFORCE`、`OPENBOT_SELF_HOST_BANNER`、`OPENBOT_SINGLE_USER` 四个）和备份文件 `/opt/xiongbao/.env.delivery.bak-<时间>`（0600），最后一行打印 `0`。生效的值一个都没变，只是名字换了；正在跑的 v0.2.15 容器不受影响（它启动时就读好了配置）。

### 21.③ 切换到 v0.2.16

这条命令先检查新镜像在本机、没有残留的同名回滚容器，任何一项不满足就什么都不做，服务不会停：

<!-- v0216:switch:begin -->
```bash
(
  set -eu
  . /opt/xiongbao/upgrade-v0.2.16/images.env
  docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || { echo '新镜像不在本机：先做 21.0 的第 2 到 4 步。这次什么都没动。'; exit 1; }
  if docker inspect xiongbao-v0215-rollback >/dev/null 2>&1; then
    echo '已经有一个 xiongbao-v0215-rollback 容器（上一次切换留下的），先把情况发给 Claude。这次什么都没动。'
    exit 1
  fi
  docker stop -t 30 xiongbao
  docker rename xiongbao xiongbao-v0215-rollback
  docker update --restart=no xiongbao-v0215-rollback
  docker run -d --name xiongbao --restart unless-stopped --env-file /opt/xiongbao/.env.delivery \
    -p 0.0.0.0:3772:3001 -p 0.0.0.0:3773:3773 \
    -v xiongbao-db:/var/lib/postgresql -v xiongbao-workspace:/workspace -v xiongbao-profiles:/profiles \
    "$NEW_IMAGE"
)
```
<!-- v0216:switch:end -->

### 21.④ 等服务起来，看迁移摘要和备份

<!-- v0216:health:begin -->
```bash
(
  deadline=$((SECONDS + 300))
  until curl -fsS --max-time 3 http://127.0.0.1:3772/health; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo
      echo '5 分钟还没起来：先不要做别的，把下一步的输出发给 Claude。'
      break
    fi
    sleep 3
  done
  echo
)
```
<!-- v0216:health:end -->

<!-- v0216:summary:begin -->
```bash
docker logs xiongbao 2>&1 | grep -E 'rebrand-|credentials-rekeyed|migrations-applied|OPENBOT_ prefix|业务库|PostgresError' | tail -n 40
```
<!-- v0216:summary:end -->

正常时依次能看到：

- `rebrand-preflight: 正在备份数据库到 /var/lib/postgresql/backup/pre-rebrand-<时间>.dump ……`
- `rebrand-preflight: 升级前备份已写好：/var/lib/postgresql/backup/pre-rebrand-<时间>.dump（… MB，权限 0600）。改名迁移开始。`
- `{"type":"credentials-rekeyed","rekeyed":3}`（数字是 3 或 4：现网 4 条凭据里 3 条是在用的旧格式，另一条若是已停用的旧格式也一起重新加密）
- `rebrand-superuser: 数据库超级用户与库已改名为 xiongbao（口令不变）。`
- `rebrand-preflight: 改名迁移全部完成。升级前的备份保留在 …，确认一切正常后可以删除。`

不应该出现 `These settings still use the old OPENBOT_ prefix`（第 ② 步已改完）。如果出现「这一步失败」：先不要动，把输出发给 Claude，按本节末尾「回滚」里 Claude 指定的那一种处理。

服务起来后，把备份拷一份到宿主机（数据库卷之外再留一份）：

<!-- v0216:backup:begin -->
```bash
(
  set -eu
  D=/opt/xiongbao/upgrade-v0.2.16
  docker exec xiongbao ls -l /var/lib/postgresql/backup
  f=$(docker exec xiongbao sh -c 'ls /var/lib/postgresql/backup/pre-rebrand-*.dump | tail -n 1')
  docker cp "xiongbao:$f" "$D/"
  chmod 600 "$D/$(basename "$f")"
  ls -l "$D"
)
```
<!-- v0216:backup:end -->

备份文件在卷里是 `-rw------- postgres postgres`，在宿主机上是 `-rw-------`。

### 21.⑤ 核对

先在服务器上：

<!-- v0216:verify:begin -->
```bash
(
  printf '%s\n' "select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user;" |
    docker exec -i xiongbao sh -c 'url=$(cat /run/s6/container_environment/DATABASE_URL); exec /usr/lib/postgresql/16/bin/psql "$url" -At'
  sh /opt/xiongbao/upgrade-v0.2.16/prod-inspect.sh xiongbao /opt/xiongbao/.env.delivery |
    sed -n '/^# database$/,/^database_size_bytes/p;/^\(credentials_live_kid_k1\|deployment_packages_tenant_old_brand\|plugin_grants_granted_by_old_brand\|user_skin_old_brand\)=/p'
)
```
<!-- v0216:verify:end -->

第一行应是 `xiongbao_app|f|f`；四个「old brand」名单（角色、库、函数、触发器）下面都是空的；最后四个数都是 `0`。

再在浏览器里（**已经开着的网页先刷新一次**，升级时连接断过）：

1. 登录。
2. 打开一个升级前的历史对话，内容、卡片、审批记录都在。
3. 用到已存凭据的地方能用：模型库里正在用的模型点「测试连接」，以及平时用的连接器（如百度网盘）读一次文件。
4. 新建一个对话，和「我的分身」说一句话，能正常回答。

### 21.⑥ 设备端与浏览器扩展

- 设备端：从 Release `device-v0.2.16`（由你推标签，做法同 12.5）下载安装包，直接覆盖安装，不用解除配对；装完在网页「我的设备」里看到这台电脑在线即可。
- 浏览器扩展：这一版已经删除，不用装新的；以前装过的，在浏览器的扩展管理里移除。

### 21.⑦ 需要重新连接的项

按 Task 23 列出的项（带签名的自动化钩子、OpenTag、学习/Intelligence、共享账号身份、web-bot-auth）：**现网均为 0，无需操作**；升级当天第 ① 步已经复查过一次，升级后可以再复查：

<!-- v0216:recheck:begin -->
```bash
sh /opt/xiongbao/upgrade-v0.2.16/prod-inspect.sh xiongbao /opt/xiongbao/.env.delivery |
  grep -E '^(automation_hooks_signed|opentag_chat_bindings|learning_[a-z_]+|shared_account_[a-z_]+|web_bot_auth_env_named)='
```
<!-- v0216:recheck:end -->

都应是 `0`（`learning_…` 那几行可能是 `n/a`，表示没有这张表，同样不用管）。万一某项不是 0：

- `automation_hooks_signed`：在网页里给这些自动化钩子重新生成签名密钥，把新密钥交给调用方（签名域换了名字，旧密钥算出的签名对不上）。
- `web_bot_auth_env_named=1` 且没设 `WEB_BOT_AUTH_KEY`：公钥和 keyid 变了，按 `xiongbao/docs/configuration.md`「Registering with Cloudflare」重新登记。
- `opentag_chat_bindings`：对端要换成认 `/xiongbao/membership`、`/xiongbao/deliver` 和 `xiongbao.sender` 的版本。
- `shared_account_…`：存量的共享账号照常可用，不用动。

### 21.⑧ 观察两天

每天看一次，有异常把输出发给 Claude：

```bash
curl -fsS http://127.0.0.1:3772/health; echo
docker logs --since 24h xiongbao 2>&1 | grep -E 'rls-not-enforced|Credential envelope|凭据|PostgresError|OPENBOT_ prefix' | tail -n 20
```

第一行是健康检查的结果；第二条正常时什么都不打印。
两天都正常再说一声，就可以准备 v0.2.17。在那之前**不要删**：卷里和 `/opt/xiongbao/upgrade-v0.2.16` 里的 `pre-rebrand-*.dump`、`.env.delivery.bak-*`、停着的 `xiongbao-v0215-rollback`（回滚要用它记下的镜像）。以前留下的 `xiongbao-v0212-rollback`、`xiongbao-v0214-rollback` 连的是改名前的库，已经用不上了，可以 `docker rm` 掉。

### 21.9 回滚

先看第 ④ 步的日志属于哪一种，**拿不准就先问 Claude**：

- **A. 升级没成功，日志里说「业务库没有改动」（或「数据没有改动」）**：业务数据没动过，直接换回 v0.2.15 用原来的卷，什么数据都不丢。
- **B. 升级已经成功（或日志说「业务库已经改动」「已经改成新名字」），但还是要回到 v0.2.15**：用第 ④ 步之前自动做的备份还原到一个**新卷**，再用 v0.2.15 镜像起来。**升级之后写进去的数据（新对话、新审批、改过的设置）都会丢**；还原后要重新发起在途的事。

**A. 直接换回 v0.2.15**（这条命令会先核对日志：日志里有任何「已经改动」的字样，或者失败后自动重启又改名成功了——有「已改名为 xiongbao」「改名迁移全部完成」——就什么都不做，那时要走 B）：

<!-- v0216:rollback-a:begin -->
```bash
(
  set -eu
  docker inspect xiongbao-v0215-rollback >/dev/null 2>&1 || { echo '找不到 xiongbao-v0215-rollback：不能走 A，先把情况发给 Claude。'; exit 1; }
  log=$(docker logs xiongbao 2>&1)
  if ! printf '%s\n' "$log" | grep -qE '业务库没有改动|数据没有改动' ||
    printf '%s\n' "$log" | grep -qE '业务库已经改动|已经改成新名字|无法确认|已经改动了|已改名为 xiongbao|改名迁移全部完成'; then
    echo '日志不是「业务库没有改动」这一种：不能走 A，先把第 ④ 步的输出发给 Claude。这次什么都没动。'
    exit 1
  fi
  docker rm xiongbao-v0216-failed >/dev/null 2>&1 || true
  docker stop -t 30 xiongbao
  docker rename xiongbao xiongbao-v0216-failed
  docker update --restart=no xiongbao-v0216-failed
  # 删掉卷上的「改名进行中」记录：以后再升级时才会重新备份（备份文件本身留着）。
  docker run --rm --volumes-from xiongbao-v0216-failed --user root --entrypoint rm \
    "$(docker inspect -f '{{.Config.Image}}' xiongbao-v0216-failed)" -f /var/lib/postgresql/backup/rebrand-in-progress
  docker rename xiongbao-v0215-rollback xiongbao
  docker update --restart=unless-stopped xiongbao
  docker start xiongbao
)
```
<!-- v0216:rollback-a:end -->

然后用第 ④ 步的第一条命令等它起来。env 文件不用换回：v0.2.15 同样认 `XIONGBAO_` 开头的名字（它是按改写前的配置建的容器，这次只是重新启动）。

**B. 用备份还原到新卷**，分三步。

B1. 停掉 v0.2.16（留着别删，改过名的库还在它的卷里），把备份和还原脚本拷出来，env 文件换回改写前的那份：

<!-- v0216:rollback-b-stop:begin -->
```bash
(
  set -eu
  D=/opt/xiongbao/upgrade-v0.2.16
  if docker inspect xiongbao-v0216-stopped >/dev/null 2>&1; then
    echo '已经有 xiongbao-v0216-stopped：上一次回滚做到一半，先把情况发给 Claude。这次什么都没动。'
    exit 1
  fi
  docker stop -t 30 xiongbao
  docker rename xiongbao xiongbao-v0216-stopped
  docker update --restart=no xiongbao-v0216-stopped
  rm -rf "$D/backup-from-volume"
  docker cp xiongbao-v0216-stopped:/var/lib/postgresql/backup "$D/backup-from-volume"
  docker cp xiongbao-v0216-stopped:/etc/s6-overlay/scripts/rebrand-restore.sh "$D/rebrand-restore.sh"
  chmod -R go-rwx "$D"
  ls -l "$D/backup-from-volume"
  envb=$(ls -t /opt/xiongbao/.env.delivery.bak-* 2>/dev/null | head -n 1 || true)
  if [ -n "$envb" ]; then
    cp -p /opt/xiongbao/.env.delivery "$D/env.delivery.v0216"
    cp -p "$envb" /opt/xiongbao/.env.delivery
    echo "env 文件已换回改写前的 $envb（改写后的那份留在 $D/env.delivery.v0216）"
  fi
)
```
<!-- v0216:rollback-b-stop:end -->

B2. 用 v0.2.15 镜像和一个新的数据库卷 `xiongbao-db-v0215-restore` 起容器（员工文件和浏览器登录的两个卷照旧用）：

<!-- v0216:rollback-b-start:begin -->
```bash
(
  set -eu
  . /opt/xiongbao/upgrade-v0.2.16/images.env
  docker image inspect "$OLD_IMAGE" >/dev/null
  docker volume create xiongbao-db-v0215-restore
  docker run -d --name xiongbao --restart unless-stopped --env-file /opt/xiongbao/.env.delivery \
    -p 0.0.0.0:3772:3001 -p 0.0.0.0:3773:3773 \
    -v xiongbao-db-v0215-restore:/var/lib/postgresql -v xiongbao-workspace:/workspace -v xiongbao-profiles:/profiles \
    "$OLD_IMAGE"
)
```
<!-- v0216:rollback-b-start:end -->

用第 ④ 步的第一条命令等它起来（这是一个全新的空库，v0.2.15 首次启动会建好表和角色）。

B3. 停掉刚起来的 v0.2.15 容器，用 v0.2.15 镜像起一个**只跑还原**的一次性容器，挂同一个新卷和拷出来的备份目录，把备份还原进去（用的是最新的那份 `pre-rebrand-*.dump`，就是这次升级前做的），完了再启动完整容器。不能在运行中的容器里还原：v0.2.15 的网站服务一停，整个容器就跟着停机。

<!-- v0216:rollback-b-restore:begin -->
```bash
(
  set -eu
  D=/opt/xiongbao/upgrade-v0.2.16
  . "$D/images.env"
  f=$(cd "$D/backup-from-volume" && ls pre-rebrand-*.dump | tail -n 1)
  echo "用这份备份还原：$f"
  docker stop -t 30 xiongbao
  if ! docker run --rm -i --user root --entrypoint sh \
    -v xiongbao-db-v0215-restore:/var/lib/postgresql -v "$D/backup-from-volume:/restore:ro" \
    "$OLD_IMAGE" -s "/restore/$f" < "$D/rebrand-restore.sh"; then
    echo '还原没有完成（原因见上方），容器先停着：按提示处理后原样再执行一次 B3。'
    exit 1
  fi
  docker start xiongbao
)
```
<!-- v0216:rollback-b-restore:end -->

还原脚本先核对：备份完整可读、这是 v0.2.15 起过一次的新卷（不是原来那个卷、库里还没有对话）、盘上放得下一份副本（按备份旁边记下的库大小，含索引）、库上没有任何连接；任何一项不满足就什么都不动并说明原因。然后它用镜像自己的初始化步骤写好连接信息、只启动数据库，把备份灌进一个临时库，成功后在一个事务里换上，打印「还原完成」，再把数据库停掉。中途断了就原样再执行一次 B3，它会从断开的地方接着做。

再用第 ④ 步的第一条命令等它起来，然后核对：

<!-- v0216:rollback-b-check:begin -->
```bash
printf '%s\n' "select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user;" \
  "select has_table_privilege(current_user, 'public.user_roles', 'UPDATE');" |
  docker exec -i xiongbao sh -c 'url=$(cat /run/s6/container_environment/DATABASE_URL); exec /usr/lib/postgresql/16/bin/psql "$url" -At'
```
<!-- v0216:rollback-b-check:end -->

应打印 `openbot_app|f|f` 和 `f`（应用角色是 v0.2.15 的名字、不是超级用户、不能改身份角色表）。再登录网页，打开历史对话核对。

回滚 B 之后：数据库在新卷 `xiongbao-db-v0215-restore` 上，原来的卷 `xiongbao-db` 与停着的 `xiongbao-v0216-stopped` 先都留着；以后再升级时，第 ③ 步的卷名要换，先找 Claude 改命令。
