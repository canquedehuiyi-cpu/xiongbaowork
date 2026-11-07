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
| 10 G7 | Linux 已完成（CI 与真实服务器），Windows 待做 | `v0.2.0` 发布运行 41989346546 里 `g7-linux` 内置库、外部库两个 job 都通过。2026-11-06 在京东云 Ubuntu 22.04 上用正式镜像 `v0.2.0` 单容器部署：健康检查 200，注册并用 `grant-admin.ts` 设首位管理员（命令已在 #274 修正），部署级模型接 DeepSeek 后「我的分身」正常回答。踩到的坑写进 `openbot/docs/deployment-qoderwake.md` §5.1（#277）。Windows 需要一台 Win10/11 真机：手头的 Windows Server 2025 云主机不支持 WSL2/Docker |
| 11 G5 真机 | 通过（6 项全部通过，含 v0.2.1 上的批准执行；中文输出随设备端 `device-v0.2.1-rc.1` 修复并复测通过） | 设备端 `device-v0.2.0-rc.2` 装在 Windows 11 25H2（「峰哥工作站」）上，先配对到京东云 v0.2.0，2026-11-07 升级到 v0.2.1 复测；逐项记录见第 11 节「2026-11-06 实测」与「2026-11-07 v0.2.1 复测」 |
| 12 F2 设备端 | 未签名内测版已发；全新机器安装检查已在 CI 自动通过；签名与真人电脑证据待人工 | `device-v0.2.0-rc.1` 的 Windows job 失败，已由 canquedehuiyi-cpu/xiongbaowork#250 修复；`device-v0.2.0-rc.2` → 「熊宝设备端发布」运行 41963394570 全绿，预发布「熊宝数字员工 设备端 0.2.0（未签名内测版）」含 Windows 安装包、Linux deb 和 `SHA256SUMS`（下载复核通过）。签名身份（D3，12.2/12.4）和两台干净机器证据（12.6）待人工。全新托管机器（Ubuntu、Windows）上的安装、配对、启动退出、卸载检查已在 #266 的 CI 上首次实跑通过，此后每个 PR 和每次设备端发布都会跑。2026-11-07 `device-v0.2.1-rc.1`（含 #295 中文输出修复）→ 运行 42369464470 全绿，已在「峰哥工作站」覆盖安装并复测通过 |
| 13 百度网盘来源 | 待做 | 代码已加（本 PR，目录条目 `baidu-netdisk`）；需要人在百度网盘开放平台建应用，并把 AppKey/SecretKey 登记到「插件」页，见第 13 节。Google Drive 已决定暂不启用（2026-11-06） |

## 1. 把 `main` 设为默认分支

Settings → General → Default branch，切到 `main`。

- 为什么：`model-e2e.yml` 只在 `github.ref == 'refs/heads/main'` 时运行；`release.yml` 要求打 tag 的提交已在 `origin/main` 上。
- 怎么确认：仓库首页默认显示 `main`，新开 PR 的默认 base 是 `main`。

## 2. 给 `main` 加分支保护

Settings → Rules → Rulesets（或 Branches → Add rule），目标分支选 `main`：

- 合并前必须通过 PR；
- 必须通过的状态检查：`熊宝交付 CI` 的全部 job。最少要有 `static`、`app-test`、`server-test (1)`–`(6)`、`image`、各 `workspace tests (…)`、`desktop tests (windows-latest)`、`chart`、WakerFlow 生命周期 E2E；
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
2. 改 `openbot/package.json` 的 `version`，填**不带** `-rc` 的基础版本（如 `0.2.0`）。
3. 在 `openbot/CHANGELOG.md` 里把 `## Unreleased` 改名为 `## 0.2.0`（与基础版本一致），内容不能为空。需要写进去的升级提醒：
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
| D3 | 谁申请签名身份，密钥放在哪 | 决定走 12.2 的 A 还是 B，以及谁做 12.3 |
| D4 | 首个版本是否必须已签名。**已决定（2026-11-04）：允许先发未签名内测版** | **不要设** `DEVICE_RELEASE_REQUIRE_SIGNED`：没签名的构建发成「未签名内测版」预发布，正式版仍必须签名。（若以后改成必须签名：设仓库变量 `DEVICE_RELEASE_REQUIRE_SIGNED=true`，没签名的构建会直接失败、不发布） |
| D5 | 首发平台。**已决定（2026-11-04）：首发 Windows + Linux** | **不要设** `DEVICE_RELEASE_MACOS`，只发 Windows 和 Linux；暂不需要 Apple 身份，跳过 12.3。（以后加 macOS：设仓库变量 `DEVICE_RELEASE_MACOS=true`，只有 Apple 芯片的 dmg） |
| D6 | 自动更新 | **已决定（2026-11-04）：首版不做。** 没接 `tauri-plugin-updater`。发布说明会写"没有自动更新，新版需重新下载安装"，不需要 updater 密钥 |
| D8 | 产品名和 identifier | **已决定（2026-11-04）：定为 `com.xiongbao.device`，不再是占位。** macOS 的签名和公证都绑在 identifier 上，首个签名版之后不要再改 |

**不能用** `openbot/desktop/signing/azure-federation.json`：它指向上游仓库的签名身份。

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

设备端的版本号取自 `openbot/package.json` 的 `version`，现在是 `0.1.0`，和服务端共用。标签的版本必须和打标签那个提交里的 `package.json` 一致。如果第 7 步已经把它改成了 `0.2.0`，标签就要打 `device-v0.2.0`。

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
5. 从托盘退出应用，确认进程列表里没有 `openbot-runner`：Windows 看任务管理器并截图；Linux 和 macOS 保存 `ps -e | grep openbot-runner` 的空输出。
6. 重启电脑，不重新配对，设备自动上线，截图。
7. 卸载。

把截图、命令输出和系统版本整理好，编辑这个 Release 上传为附件，然后在 `docs/acceptance/STORIES.md` 的 F2 行写上链接。拿到已签名的产物和这份两台机器的证据之后，F2 才能改成 implemented。

**流水线现在自动做的部分**：「熊宝设备端发布」在 `assemble` 之后、`publish` 之前加了 `clean-linux`（`ubuntu-latest`）和 `clean-windows`（`windows-latest`）两个 job，每次都在全新的 GitHub 托管机器上用 `device-release-dist` 里**将要发布的那几个文件**做检查；任何一项不过，Release 就不会发。两份记录 `device-clean-linux-evidence.txt`、`device-clean-windows-evidence.txt`（系统版本、文件 SHA256、签名状态、每项 PASS，最后一行 `RESULT: PASS`）会作为附件跟 Release 一起上传（不进 `SHA256SUMS`），也在运行页的 `device-clean-<os>-evidence` 制品里。同样的检查（同一份 `scripts/ci/device-clean-linux.sh` 和 `scripts/ci/device-clean-windows.ps1`）也在每个 PR 的「熊宝交付 CI」里对 CI 构建的未签名 deb 和 NSIS 安装包跑一遍（job `device clean-machine install (ubuntu-latest)`、`device clean-machine install (windows-latest)`，记录在 `device-clean-<os>-ci-evidence` 制品里）。

- 第 1 步校验和：两台都自动做（Linux `sha256sum -c --ignore-missing`，Windows `Get-FileHash` 对照 `SHA256SUMS`）。
- 第 2 步签名：Windows 自动跑 `Get-AuthenticodeSignature`，已签名的发布必须是 `Valid` 且发布者与 `windows` job 校验过的一致；未签名内测版只记录 `NotSigned`，不因此失败。Linux deb 只核对校验和。
- 第 3 步安装和配对：Linux 用 `sudo apt-get install -y ./xiongbao-device_*_amd64.deb` 安装（依赖从软件源装），检查 `/usr/bin/xiongbao-device`、`/usr/bin/openbot-runner` 和桌面入口；再在同一台机器上起真实服务端和 PostgreSQL，通过 API 注册、在「我的设备」生成配对码，用**已安装的** `openbot-runner` 配对，确认设备在线、配对码不能用第二次。Windows 用 `/S` 静默安装（Tauri 默认按当前用户装到 `%LOCALAPPDATA%\熊宝数字员工 设备端`，实际的安装方式和目录从卸载项读出并写进记录），检查 `xiongbao-device.exe`、`openbot-runner.exe`、卸载项和版本；Windows 上没有带 pgvector 的 PostgreSQL，所以不配对，只跑 runner 自检（`--help`、`--add-root`/`--list-roots`/`--remove-root`）。
- 第 4 步执行命令：Linux 由服务器给设备下发一条不经过模型的命令（`projects.branches`，设备上运行 `git ls-remote`），确认返回结果。Windows 不做。
- 第 5 步退出后无残留：Linux 按 PID 停掉 runner，再两次启动已安装的应用、用 SIGTERM 退出（与托盘「退出」走同一个 `quit()`），每次都确认没有 `openbot-runner` 进程、服务器显示离线。Windows 启动已安装的应用，确认它拉起安装目录里的 `openbot-runner.exe`，再强制结束应用（比托盘退出更粗暴），确认 `Get-Process` 里没有 `openbot-runner`。
- 第 6 步重启后自动上线：Linux 用「不重新配对、重新启动应用、设备重新在线」代替，不是真实重启。
- 第 7 步卸载：Linux `sudo apt-get remove -y xiongbao-device`，Windows `uninstall.exe /S`，都确认程序文件（和 Windows 卸载项）已删除、没有残留进程。

**仍然要人来做的部分**：在真实用户自己的电脑上（不是托管 CI 机器）按上面 1–7 步走一遍；Windows「属性 → 数字签名」页或 SmartScreen 提示的截图；真机重启后不重新配对、设备自动上线（含开机自启）；用真实模型驱动的员工在设备上执行一个普通命令并截图；macOS（若发布）的 `spctl --assess`。托管机器预装了很多软件，也不是普通用户的桌面环境，所以自动记录只能替代"文件对不对、装得上、跑得起来、退得干净、卸得掉"这部分，不能替代真机证据。

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

OneDrive 不在平台目录里，这一步只涉及百度网盘。
