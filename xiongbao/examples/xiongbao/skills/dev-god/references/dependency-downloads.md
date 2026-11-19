# 下载与备用源

GitHub、依赖仓库、工具链或安装器下载失败时读取。以下是候选源与选择方法，不是永久可用承诺；地址及服务范围核对于 2026-10-08，执行时仍核实所需版本和当前服务说明。只读本次生态的小节。

## 先定位，再换源

1. 从错误中确认失败阶段与域名：Git 克隆、包索引、包文件、安装脚本另下二进制、工具链还是容器。DNS/连接超时与 401/403 权限或限流、404 缺失、证书错误分别处理；不要仅凭用户在中国就修改正常可用的源。
2. 优先沿用项目或组织的可信源、缓存与已有网络配置。确认为公开资源的网络问题时，可在任务授权内尝试对应备用源，无需为单次可逆切换反复确认。私有包、私有仓库和企业代理继续走原授权渠道；不把名称、Token、认证头或签名 URL 转发给公共镜像。
3. 先以小请求检查精确版本或文件，再进行正常下载。设合理连接/总超时；HEAD 被拒绝不等于文件不存在，可小量 GET 核实。镜像首页返回 200 不代表目标文件可下载。连续出现相同失败时改变取证路径，不轮询一长串未知代理。
4. 优先单命令参数或临时环境变量；需要配置文件时使用任务专用文件并保留现有配置。不要为了本次下载改全局 registry、Git `insteadOf`、系统 hosts 或 shell 启动文件。长期换源确属任务要求时，记录原值、范围与恢复方法。
5. 保持锁定版本、commit、平台和架构，保留完整性/签名校验。不删锁文件、不改 hash、不静默降级，不用关闭 TLS 或 SSH 主机校验来“修复”网络。镜像给出的哈希只能帮助校验传输，优先对照原锁文件、上游签名或独立可信的摘要。

下面 shell 示例面向 bash/zsh；Windows 使用相应工具参数，临时环境变量在子进程中设置或执行后恢复。命令需按现有包管理器、锁文件和任务替换，不能逐条全部运行。

## npm、pnpm、Yarn：公开包仓库

[npmmirror](https://npmmirror.com/) 提供公开 npm 包的只读镜像，候选 registry 为 `https://registry.npmmirror.com`。无需为换源另装 cnpm；保留项目指定的包管理器。

```bash
# 已有 package-lock.json 且本任务需要重建依赖时
npm ci --registry=https://registry.npmmirror.com
# 已有 pnpm-lock.yaml，按项目锁定的 pnpm 版本使用
pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com
```

没有锁文件时，按任务使用原管理器的正常安装命令；不能为了套示例先造一个锁文件。Yarn 1 与 Yarn 2+ 配置不同：前者使用 `registry`/`--frozen-lockfile`，后者使用 `npmRegistryServer`/`--immutable`，按当前版本帮助选择单次设置。

先确认默认 registry 没有承担无 scope 的私包或企业统一代理，否则不能直接覆盖 `--registry`。只替换公共源，保留私有 scope 的 registry 和按主机绑定的认证。锁文件中的显式 tarball/Git URL 及 postinstall 下载未必随 registry 改变；换源后仍失败时看实际请求域名，不能批量替换锁文件中的 URL 或 integrity。镜像缺少刚发布版本时检查同步状态，不能自行选择旧版。发布仍使用上游或项目指定的发布仓库。

配置依据：[npm registry](https://docs.npmjs.com/cli/using-npm/registry)、[npm 认证作用域](https://docs.npmjs.com/cli/configuring-npm/npmrc)、[Yarn 配置](https://yarnpkg.com/configuration/yarnrc)。

## Python：PyPI

公开包的候选索引：

- 清华：`https://pypi.tuna.tsinghua.edu.cn/simple/`，或其文档所列同服务路径。
- 阿里云：`https://mirrors.aliyun.com/pypi/simple/`。

```bash
# 使用当前项目解释器/虚拟环境，requirements.txt 取项目已有文件
python -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple/ -r requirements.txt
```

保持已有的版本、约束和 hash。`--extra-index-url` 会参与同一次候选选择，不是“主源失败才用备用”，尤其不能用它混接私有包与公共镜像。已有配置、环境变量或 requirements 可能另带索引，切换前只检查脱敏后的相关项，不能转储含凭据的完整配置。uv、Poetry 等继续使用原工具，按其当前版本配置索引，不用 pip 绕开锁定环境。

依据：[清华 PyPI 帮助](https://mirrors.tuna.tsinghua.edu.cn/help/pypi/)、[阿里云 PyPI 帮助](https://developer.aliyun.com/mirror/pypi)、[pip 索引行为](https://pip.pypa.io/en/stable/cli/pip_install/)。即使旧教程提供 HTTP 或 `trusted-host`，此处仍使用 HTTPS 和正常证书校验。

## GitHub：仓库、源码与 Release 分开

| 需要的内容 | 备用路径与边界 |
| --- | --- |
| Git 仓库 | 若仅 SSH 22 端口受限，可用原站 HTTPS；已具备 GitHub SSH 认证时也可试官方 `ssh.github.com:443`。这是端口备用方式，不是中国镜像，不保证可达。项目官方明确提供的国内同步仓库也可用，核对 commit、同步状态、子模块和 LFS |
| 源码快照 | 原站可达时，可用上游固定 commit 的源码归档减少下载；这是原站另一种下载方式，不保证解决阻断。归档不含完整 Git 历史，子模块及 LFS 内容需另核对，不能代替完整 clone 或编译好的 Release |
| Release 二进制 | 先查项目官方分发地址；再查清华的 GitHub Release 目录是否收录精确项目、版本、平台与架构，不能直接拼接一个“通用镜像 URL” |

已有 SSH 认证时的单次端口测试：

```bash
ssh -T -o BatchMode=yes -o ConnectTimeout=10 -p 443 git@ssh.github.com
```

按 [GitHub SSH 443 文档](https://docs.github.com/en/authentication/troubleshooting-ssh/using-ssh-over-the-https-port)核对主机指纹；首次连接尚无可信主机记录时，先按官方指纹完成登记，`BatchMode` 拒绝未知主机不属于网络故障。认证成功但不提供 shell 的提示不能仅按退出码误判失败，`Permission denied (publickey)` 也不能归因于网络。此方式不适用于所有 GitHub Enterprise 部署。

[清华 Release 帮助](https://mirrors.tuna.tsinghua.edu.cn/help/github-release/)与[目录](https://mirrors.tuna.tsinghua.edu.cn/github-release/)只覆盖部分项目；[github-raw](https://mirrors.tuna.tsinghua.edu.cn/help/github-raw/)仅为其他镜像服务，不是任意 Raw 代理。不能仅凭 Gitee 同名仓库认定官方同步，也不内置维护方和完整性无法核实的 ghproxy 节点列表。用户已有可信代理时沿用其配置，保持凭据隔离。

## Node、Electron、Playwright 等二进制

npm 包下载完成而安装仍超时，先看是否在下载另一个二进制。[npmmirror 运营方配置](https://github.com/cnpm/binary-mirror-config/blob/master/package.json)列有以下产品专用候选；只选择安装器当前版本支持的变量，不一次性注入所有变量：

| 下载器 | 临时变量与候选值 |
| --- | --- |
| nvm 的 Node 分发 | `NVM_NODEJS_ORG_MIRROR=https://cdn.npmmirror.com/binaries/node` |
| Electron | `ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/` |
| Playwright 浏览器 | `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright` |
| Prisma 引擎 | `PRISMA_ENGINES_MIRROR=https://cdn.npmmirror.com/binaries/prisma` |

先核实该版本、平台、架构及安装器要求的目录布局。Electron 另见[官方镜像说明](https://www.electronjs.org/zh/docs/latest/tutorial/installation)；Playwright 按[官方说明](https://playwright.dev/docs/browsers#download-from-artifact-repository)使用项目已安装、锁定的 CLI 下载对应浏览器 revision。不能用裸 `npx` 无意拉入最新版，也不能跳过二进制下载后声称安装或浏览器测试通过。

## Maven / Gradle：按仓库分别设置

[阿里云 Maven 服务](https://maven.aliyun.com/mvn/guide)提供 Central、Google 等不同仓库。Central 的候选为 `https://maven.aliyun.com/repository/central`；Google Maven 的候选为 `https://maven.aliyun.com/repository/google`，二者不能相互替代；地址另见[官方仓库代理文档](https://help.aliyun.com/zh/yunxiao/user-guide/repository-agent-settings)。

Maven 需要临时设置时，在任务专用 settings 文件中合并以下镜像项，用 `mvn -s <任务设置文件> <原目标>` 调用；保留原有 profiles、servers 等设置，凭据仍由工具读取，不能把完整 settings 输出给模型：

```xml
<mirror>
  <id>cn-central</id>
  <mirrorOf>central</mirrorOf>
  <url>https://maven.aliyun.com/repository/central</url>
</mirror>
```

先识别已有匹配 `central` 的镜像与企业通配镜像，不能直接追加另一个条目导致无效或绕过企业统一代理。不要新设 `mirrorOf=*` 接管企业私库。Maven 对同一仓库选择一个匹配镜像，不把多个镜像项当顺序容错列表，详见[官方镜像规则](https://maven.apache.org/guides/mini/guide-mirror-settings.html)。

Gradle 先辨认普通依赖、`pluginManagement` 插件、Google Android 依赖、Gradle Wrapper 分发包还是 Android SDK；按[仓库配置](https://docs.gradle.org/current/userguide/declaring_repositories.html)只替换受影响仓库，保留内容过滤和验证元数据。Maven 镜像不能自动解决 Wrapper、SDK 下载。鸿蒙 ohpm 与 SDK 同样按原工具链官方源处理，不能视作 npm/Maven 换域名。

## Go、Rust、Homebrew

| 生态 | 候选与单次用法 | 保留的边界 |
| --- | --- | --- |
| Go Modules | [goproxy.cn](https://goproxy.cn/)；`GOPROXY=https://goproxy.cn,direct go mod download` | 保留 `go.sum`、校验数据库和 `GOPRIVATE`/`GONOPROXY` 的私有边界；`direct` 仍可能访问不可达的原站 |
| Rust 工具链 | [清华 rustup](https://mirrors.tuna.tsinghua.edu.cn/help/rustup/)；仅对所需 rustup 命令设置 `RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup` | 使用项目指定 toolchain，不借换源升级到 stable/latest；旧 nightly 可能已不保留 |
| Cargo 依赖 | [RsProxy](https://rsproxy.cn/)；Cargo 1.68+ 可用 `sparse+https://rsproxy.cn/index/` | 这是 crates.io 源替换，不解决 Git 依赖，也不是仅设置 rustup 变量；保留 Cargo.lock 与校验 |
| Homebrew | [清华 bottles](https://mirrors.tuna.tsinghua.edu.cn/help/homebrew-bottles/)；单次设置 `HOMEBREW_API_DOMAIN=https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api` 和 `HOMEBREW_BOTTLE_DOMAIN=https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles` | API、bottle、brew 自身 Git 仓库及 cask 上游下载不同；后二者按实际失败另处理 |

Go 的逗号只在 404/410 时转下一个源，超时不会自动 fallback；竖线表示任意错误都继续，不能用它绕开企业代理拒绝。官方规则见 [Go Modules](https://go.dev/ref/mod#goproxy-protocol)。不设置 `GOSUMDB=off` 来绕过失败。

Cargo 确认没有冲突的现有源替换且已有锁文件时，可用[官方单命令配置](https://doc.rust-lang.org/cargo/reference/config.html#command-line-overrides)：

```bash
cargo --config 'source.crates-io.replace-with="rsproxy-sparse"' \
  --config 'source.rsproxy-sparse.registry="sparse+https://rsproxy.cn/index/"' \
  fetch --locked
```

Homebrew 的 Git 索引/自身仓库另见[清华 Homebrew 帮助](https://mirrors.tuna.tsinghua.edu.cn/help/homebrew/)，不能为了安装一个依赖执行全局更新或替换所有 tap。

## Docker 与其他来源

不要把 Docker CE 软件安装源与 Docker Hub 容器仓库混为一谈。截至本页核对日，[阿里云 ACR 文档](https://help.aliyun.com/zh/acr/user-guide/accelerate-the-pulls-of-docker-official-images)明确提示旧镜像加速已停止同步最新镜像，且加速地址有访问和用途限制；不写死旧教程的公共加速地址。

优先项目发布者公布的可达容器仓库或组织已有制品仓库，核对镜像 digest、平台及来源。需要订阅海外制品等云服务时按实际账号、费用及授权处理；不能因下载失败擅自开通服务、重启 Docker 或替换宿主全部 registry 配置。下载完成再验证运行，`latest` 标签不能证明新鲜度。

本页未列出的生态，从上游与[清华帮助目录](https://mirrors.tuna.tsinghua.edu.cn/help/)、[阿里云镜像目录](https://developer.aliyun.com/mirror/)查是否真实提供该资源。系统包按发行版、版本与架构选择源，保留签名验证；不根据相似域名猜路径。

## 完成或仍被阻塞时

记录原失败域名、采用的备用来源、版本/commit、完整性核对与实际安装/构建结果。临时切换不要遗留持久配置；必要的项目配置修改单独说明。如果可信候选都缺文件或不可达，继续不依赖该下载的工作，并留下精确资源与错误类别；不能以换源命令执行成功代替下载、安装或功能验证。
