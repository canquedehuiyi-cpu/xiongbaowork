# 品牌去痕 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户能看到、能摸到的地方（网页、设备端安装包、渠道消息、第三方授权页、移动端、模型的自我介绍）不再出现 OpenBot / CopilotKit / qoder 的名字和图标，同时把开源声明补齐。

**Architecture:** 产品名只从租户包 `brand.yaml` 一个出口取：服务端经新文件 `server/src/brand.ts`，网页经已有的 `appConfig.brand`。环境变量新名 `XIONGBAO_*` 在进程入口和容器启动时抄成旧名 `OPENBOT_*`，所以 748 处旧读取一处不改。代码内部名字、目录、包名、迁移、加密域串一概不动；品牌护栏测试列出漏网字样，合并上游后靠它兜底。

**Tech Stack:** Bun + TypeScript（server / app / runner）、React + TanStack Router（app）、Tauri 2（desktop-device）、Expo（mobile）、s6-overlay（镜像）。

**Spec:** `docs/specs/2026-11-11-brand-removal.md`

## 用户决定（2026-11-12）

用户说「接着做品牌去痕」，规格第 7 节按建议执行：

| # | 问题 | 决定 |
|---|---|---|
| 1 | `desktop/` 整栈安装器交付吗 | 不交付，本阶段不碰，护栏整目录豁免 |
| 2 | 移动端名字 | 显示名「熊宝」，包名 `com.xiongbao.mobile`，scheme `xiongbao`；服务端仍双认旧 scheme |
| 3 | 英文名 / 公司名 | 英文名 `XiongBao Work`；公司名先用「熊宝」占位（`brand.yaml` 的 `company_name`），用户以后改这一处 |
| 4 | 向 CopilotKit 的遥测 | 默认关闭 |
| 5 | 上游文档给客户吗 | 不给，仓库内保持原样 |
| 6 | 演示账号邮箱 | `admin@xiongbao.local`，旧邮箱认一个版本 |
| 7 | 逐步重写 | 另写设计稿，本计划不涉及 |
| 8 | P7 开发者工具痕迹 | 做，排最后 |

另：用户允许改原有测试里**写着要改的品牌字样的期望值**（只改字样，不删、不跳过、不放宽），每处在提交说明里列出。

## Global Constraints

- 不改：目录 `openbot/`、`@openbot/*` 包名、代码标识符、注释、数据库名与角色名、`server/drizzle/*.sql`、Helm chart、容器标签。
- 绝对不改（改了会坏数据）：`openbot.vault.credential.v2`、`openbot:agent-run`、`openbot-bearer`、`openbot-automation-hook-signing:v1`、`openbot.headless.waiting`、`openbot.ap.local-terminal.v1`、`<<openbot:app-access-request>>`、工具 id `openbot:personal-memory`、`x-openbot-agent-token` / `-bot-id` / `-computer-token` / `-desktop-host-token` / `x-openbot-egress`、`/api/copilotkit`、`/openbot/membership`、`/openbot/deliver`、runner 数据目录名。
- 京东云 `.env.delivery`（全是 `OPENBOT_*`）不改一个字也必须照常启动、登录、老数据都在。
- `openbot/LICENSE` 一字不改；版权行写 `Copyright (c) 2026 <公司名>; portions Copyright (c) 2026 CopilotKit (MIT)`，不能把 CopilotKit 换掉。
- 客户可见文字里的产品名只从 `server/src/brand.ts`（服务端）或 `appConfig.brand`（网页）取，不写字面量。
- 新文件尽量放在 fork 自有位置；改上游文件时每处只把字面量换成一次函数调用。
- 不碰 `openbot/desktop/`。
- 安全底线不动：approvals/policy.ts、RLS、审计、凭据只进保险库、管理员门。
- 新增服务端测试文件要加进 `server-tests.list.txt`（`node scripts/ci/server-shards.mjs --write`）；数据库测试最后一个 `afterAll` 关连接池（`database.$client.close()`）。

## Review Focus

1. 只设旧名 `OPENBOT_X` 的部署（京东云现状）：行为与改动前完全一样，启动日志不多出警告。→ Task 2 测试「只设旧名」。
2. 新旧两个名字都设了但值不同：用新名，启动日志提示一次，不报错退出。→ Task 2 测试「两个都设」。
3. 删掉 `OPENBOT_SELF_HOST_BANNER=false` 后网页也不出现推广条；显式设 `true` 才出现，且没配 `support_url` 时链接不出现（推广条整个不显示）。→ Task 7 测试。
4. 单用户模式下旧库里演示账号邮箱还是 `dev@openbot.local`：升级后界面显示新邮箱，按旧邮箱比对的路径（如「这是演示账号吗」）仍认得出它。→ Task 8 测试。
5. `TENANT_PACKAGE_DIR` 显式写成旧路径 `../examples/qoderwake`：改名后仍能加载租户包启动。→ Task 11 测试。

---

### Task 1: 品牌出口

**Files:**
- Modify: `openbot/examples/qoderwake/brand.yaml`（`english_name: XiongBao Work`；新增 `company_name: 熊宝`；`support_url` 不填）
- Modify: `openbot/server/src/tenant-package.ts`（解析 `company_name`、`support_url`，都可选；`support_url` 必须是 `https:` 地址，否则加载失败并说出字段名；`createApplicationConfiguration` 输出带上 `companyName`、`supportUrl`）
- Modify: `openbot/scripts/generate-app-config.ts`（`AppConfig` 类型加 `companyName?: string; supportUrl?: string`）
- Create: `openbot/server/src/brand.ts`
- Modify: `openbot/server/src/index.ts`（加载租户包后调用 `setBrand`）
- Test: `openbot/server/tests/brand.test.ts`、`openbot/server/tests/tenant-package-brand-fields.test.ts`

**Interfaces:**
- Produces（`server/src/brand.ts`）:
  - `setBrand(input: { productName: string; englishName?: string; companyName?: string; supportUrl?: string }): void`
  - `productName(): string` —— 未设置时 `"熊宝数字员工"`
  - `englishName(): string` —— 未设置或缺省时 `"XiongBao Work"`
  - `companyName(): string` —— 缺省时等于 `productName()`
  - `supportUrl(): string | undefined`
  - `copyrightLine(year?: number): string` —— `Copyright (c) 2026 ${companyName()}; portions Copyright (c) 2026 CopilotKit (MIT)`（`year` 只替换前一个 2026）
- Produces（网页）: `appConfig.brand.companyName?: string`、`appConfig.brand.supportUrl?: string`

- [ ] **Step 1: 写测试**：`brand.test.ts` 覆盖未设置时的四个默认值、`setBrand` 后的值、`companyName` 缺省回落到产品名、`copyrightLine()` 原文；`tenant-package-brand-fields.test.ts` 覆盖 `company_name` / `support_url` 解析、`support_url: http://x` 报错信息含 `support_url`、`createApplicationConfiguration` 带出两个字段。
- [ ] **Step 2: 跑测试确认失败**：`cd openbot/server && bun test tests/brand.test.ts tests/tenant-package-brand-fields.test.ts` → FAIL（模块不存在 / 字段缺失）。
- [ ] **Step 3: 实现**上面的文件改动。
- [ ] **Step 4: 跑测试确认通过**，再跑 `bun test tests/qoderwake-package.test.ts tests/config.test.ts` 不回归。
- [ ] **Step 5: 提交** `feat(brand): 品牌出口 brand.ts 与 brand.yaml 新字段`

### Task 2: 环境变量新名优先、旧名兜底

**Files:**
- Create: `openbot/shared/env-aliases.ts`
- Modify: 进程入口第一行调用（`openbot/server/src/index.ts`、`openbot/runner/src/index.ts`、`openbot/worker/src/index.ts`、`openbot/supervisor/src/index.ts`、`openbot/agent-computer/src/index.ts`）
- Create: `openbot/docker/s6/s6-rc.d/env-aliases/{type,up}` + `openbot/docker/s6/scripts/env-aliases.sh`；把 `env-aliases` 加进 `migrate`、`api`、`computer`、`computer-token`、`postgres-init` 的 `dependencies.d`（照 `computer-token` 写 `/run/s6/container_environment` 的先例）
- Test: `openbot/server/tests/env-aliases.test.ts`、`openbot/docker/tests/` 下照现有脚本测试的写法加 `env-aliases.sh` 的测试

**Interfaces:**
- Produces: `applyEnvironmentAliases(environment: Record<string, string | undefined>): { conflicts: string[] }` —— 对每个 `XIONGBAO_<X>` 写入 `OPENBOT_<X>`；旧名已有且值不同时用新名覆盖，并把 `OPENBOT_<X>` 记进 `conflicts`；调用方对每个冲突打一行 `console.warn`。只处理 `XIONGBAO_` 前缀，不反向抄。

- [ ] **Step 1: 写测试**：只设旧名 → 环境不变、`conflicts` 空；只设新名 → 旧名出现同值；两个都设且不同 → 旧名被新值覆盖、`conflicts` 含该名；两个都设且相同 → `conflicts` 空；`XIONGBAO_` 本身（空后缀）不处理。脚本测试：三种情况下 `container_environment` 目录里文件内容对。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 实现**函数、入口调用、s6 oneshot。
- [ ] **Step 4: 跑测试确认通过**；`docker/delivery.env.example` 改写为 `XIONGBAO_*` 新名并注明旧名仍可用；本机用 `docker/delivery.env.example` 原文（旧名版本，取 `git show HEAD~:...`）跑一次 `bun test tests/config.test.ts`。
- [ ] **Step 5: 提交** `feat(brand): 环境变量 XIONGBAO_* 新名优先、OPENBOT_* 兜底`

### Task 3: 开源声明文件

**Files:**
- Create: `openbot/NOTICE`（说明本产品包含基于 MIT 许可的 OpenBot 代码；原版权行 `Copyright (c) 2026 CopilotKit` 与 MIT 全文，直接引 `LICENSE` 内容）
- Create: `openbot/scripts/brand/third-party-notices.ts` —— 读 app、server、runner 的生产依赖（递归，按 `bun.lock` 解析出的已安装包 `package.json`），输出 `openbot/app/src/lib/generated/third-party-notices.json`（`{ name, version, license, licenseText? }[]`，按名字排序，去重）和 `openbot/THIRD-PARTY-NOTICES.md`（同内容的文本版）；两者都是生成物，加进 `.gitignore`
- Modify: `openbot/package.json` 构建脚本里在 `generate-app-config` 旁调用它
- Modify: `openbot/Dockerfile`：生成后把 `LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md` 复制到镜像 `/licenses/`
- Test: `openbot/scripts/tests/third-party-notices.test.ts`（用临时目录里的假 `node_modules` 验证：去重、排序、缺 license 字段写 `UNKNOWN`、`@copilotkit/*` 被收进来）

- [ ] **Step 1: 写测试。** - [ ] **Step 2: 确认失败。** - [ ] **Step 3: 实现。**
- [ ] **Step 4: 确认通过**；本机跑一次脚本，看 JSON 里有 `@copilotkit/react-core`。
- [ ] **Step 5: 提交** `feat(brand): NOTICE 与第三方许可汇总，镜像带 /licenses`

### Task 4: 应用内「关于 / 开源软件声明」页

**Files:**
- Create: `openbot/app/src/routes/_authed/settings/about.tsx`
- Modify: 设置页导航（`settings/route.tsx` 或其侧栏组件）加「关于」入口
- Test: `openbot/app/tests/settings-about.test.tsx`

页面内容（黑白红风格沿用设置页现有组件）：产品名、版本号（沿用应用已有的版本来源）、`© 2026 {companyName}`；一句「本产品使用了以下开源软件」；OpenBot（MIT）：版权行 + MIT 全文（`import license from "../../../../../LICENSE?raw"`，路径按实际层级）；第三方依赖列表（名称、版本、许可类型，点开看全文，读 Task 3 生成的 JSON）。不放上游仓库链接和 logo。

- [ ] **Step 1: 写测试**：渲染后能找到 `Copyright (c) 2026 CopilotKit`、`Permission is hereby granted`、公司名、至少一条第三方依赖；页面里没有 `github.com/CopilotKit`。
- [ ] **Step 2: 确认失败。** - [ ] **Step 3: 实现。** - [ ] **Step 4: 确认通过。**
- [ ] **Step 5: 提交** `feat(brand): 设置里加关于与开源软件声明页`

### Task 5: 设备端图标与版权字段

**Files:**
- Create: `openbot/desktop-device/src-tauri/icons/`（由 `openbot/app/src/assets/brand/xiongbao-logo-256.png` 生成：`32x32.png`、`64x64.png`、`128x128.png`、`128x128@2x.png`、`icon.icns`、`icon.ico`；用 `bunx @tauri-apps/cli icon` 或 Pillow 生成均可，生成命令写进该目录的 `README.md`）
- Modify: `openbot/desktop-device/src-tauri/tauri.conf.json`（`bundle.icon` 指向 `icons/*`；加 `bundle.copyright` 为 Task 1 `copyrightLine()` 的原文，公司名「熊宝」）
- Modify: `openbot/desktop-device/src-tauri/src/main.rs:411`（托盘图标改用 `icons/64x64.png`）
- Modify: `tauri.bundle.conf.json` 的 `resources` 带上 `LICENSE`、`NOTICE`
- Test: `openbot/desktop-device/tests/brand-icons.test.ts`：配置里任何图标路径都不含 `desktop/src-tauri/icons`；`main.rs` 不含该路径；`copyright` 含 `portions Copyright (c) 2026 CopilotKit (MIT)`；列出的图标文件都存在。

- [ ] Step 1–5 同上；提交 `feat(brand): 设备端换熊宝图标并写版权字段`

### Task 6: runner 进程改名 `xiongbao-runner`

**Files:**
- Modify: `openbot/desktop-device/src-tauri/src/sidecar.rs`、`supervise.rs`、`main.rs` 中的 `openbot-runner`；`tauri.bundle.conf.json` 的 `externalBin`；`openbot/desktop-device/scripts/build-sidecar.ts`；`.github/workflows/device-release.yml`、`.github/workflows/ci.yml` 里的二进制名；两个签名校验脚本
- 不改：runner 数据目录名、`OPENBOT_RUNNER_*` 变量（Task 2 已让 `XIONGBAO_RUNNER_*` 可用）
- Modify（经用户同意只改字样）: `openbot/desktop-device/tests/build-sidecar.test.ts` 等断言二进制名的测试；`runner/tests/*` 里若只是数据目录名则不改
- Test: 现有 `build-sidecar.test.ts` 改期望后通过；新增断言：升级后旧二进制 `openbot-runner(.exe)` 若在安装目录里，supervisor 启动前停掉同名旧进程（`supervise.rs` 里加，测试照该文件现有 Rust 单测写法）

- [ ] Step 1–5；提交说明列出每处被改的原有断言。提交 `feat(brand): 设备端 runner 改名 xiongbao-runner`

### Task 7: 网页上的残留

**Files:**
- Modify: `openbot/server/src/config.ts`（`OPENBOT_SELF_HOST_BANNER` 只有显式 `true` 才开）
- Modify: `openbot/app/src/components/layout/self-host-banner.tsx`（链接改读 `appConfig.brand.supportUrl`；没有就整个不显示）
- Modify: `openbot/app/src/lib/copilot/generative-ui.ts:25,27,43`（用 `appConfig.brand.englishName ?? "XiongBao Work"` 插值）
- Modify: `openbot/app/src/main.tsx:20`（报错文字用产品名）
- Modify: `openbot/app/src/components/browser/browser-screen.tsx`（`OpenBotLogo` 换成 `components/layout/brand-logo.tsx`；`app/src/assets/openbot-logo.png` 不再被引用后删除，`components/edition/openbot-logo.tsx` 若无其他引用一并删除）
- Modify: `responsibilities.tsx:861`、`admin/plugins/$key.tsx:950`、`admin/enterprise.tsx:505`（显示 `XIONGBAO_*`，括号注「旧名 `OPENBOT_*` 仍可用」）
- Modify（经同意只改字样）: `app/tests/skins-openmuse.test.tsx` 等断言旧文字的原有测试
- Test: `openbot/app/tests/brand-web-copy.test.tsx` + 服务端 `config` 推广条默认值测试（Review Focus 3）

- [ ] Step 1–5；提交 `feat(brand): 网页推广条默认关、提示词与浏览器页 logo 去上游名`

### Task 8: 服务端发出的客户可见文字 + 演示账号邮箱

**Files:**
- Modify（每处字面量换成 `brand.ts` 调用）: `delivery/opentag-agent.ts`（约 10 处）、`delivery/twilio.ts:121`、`delivery/router.ts:576`、`index.ts:902`、`proactive/engine.ts:263`、`auth/native-browser.ts:44`、`auth/organization.ts:25,273`、`agents/connection-test.ts:82`、`voice/provider.ts:72`、`plugins/tools.ts:110,117`、`copilot.ts:1790-1841,2645`（改分段标题前先 `grep` 确认没有代码按原文解析它们；有就不改那一处并在报告里说明）、`memory/tools.ts` 工具描述（id 不改）、`plugins/broker.ts:677`（`openbot.example.com` → `example.com`）
- Modify: `server/src/auth/dev-actor.ts` 导出 `DEV_ACTOR_EMAIL = "admin@xiongbao.local"` 与 `LEGACY_DEV_ACTOR_EMAILS = ["dev@openbot.local"]`、`isDevActorEmail(email: string): boolean`；`passwords/routes.ts`、`computer/routes.ts`、`agents/routes.ts`、`agents/lifecycle-routes.ts`、`components/routes.ts`、`browser/routes.ts`、`routing/service.ts`、`staffing/executor.ts` 里重复的常量和比较全部改用它们
- Modify（经同意只改字样）: 断言这些文字或 `dev@openbot.local` 的原有测试
- Test: `openbot/server/tests/brand-server-copy.test.ts`（每个改过的出口用非默认品牌 `setBrand({productName:"甲", englishName:"Jia"})` 后输出里含 `Jia`/`甲` 且不含 `OpenBot`）；`dev-actor` 测试覆盖 Review Focus 4

- [ ] Step 1–5；提交 `feat(brand): 服务端客户可见文字走品牌出口，演示账号改 admin@xiongbao.local`

### Task 9: 第三方看到的名字、OTel、遥测

**Files:**
- Modify: `plugins/oauth.ts:488`（`client_name: englishName()`）、`plugins/composio-adapter.ts:2347`（后缀 `(${englishName()})`；先确认按 id 而不是按名字查找已有配置，确认结果写进报告）、`plugins/mcp.ts:507`（`name: "xiongbao"`）、`plugins/catalogue.ts:1528,1549`（`vendor: companyName()`；`docsUrl` 改 `supportUrl()`，没有就不给该字段）
- Modify: `telemetry/otel.ts:163`（默认 `service.name` 为 `"xiongbao"`；属性名 `openbot.*` 不改）
- 遥测：查 `@copilotkit/runtime` 是否默认上报（读它的源码/文档里的 telemetry 开关）；若上报，在创建 runtime 处默认关，并在 `Dockerfile` 设对应环境变量为关；结论写进报告
- Modify（经同意只改字样）: `plugin-oauth.test.ts`、`composio-*.test.ts`、`brokered-multiple-accounts.integration.test.ts`、`plugin-store.integration.test.ts`、`own-app-tools-refresh.integration.test.ts`、`staffing-executor.integration.test.ts`、`otel-exporter-compat.test.ts`、`plugin-catalogue.test.ts` 中对应字样
- Test: 新增断言 `client_name`、厂商名、服务名取自品牌出口

- [ ] Step 1–5；提交 `feat(brand): OAuth 应用名、Composio 后缀、插件厂商与 OTel 服务名改熊宝，默认不上报遥测`

### Task 10: 品牌护栏测试

**Files:**
- Create: `openbot/app/tests/brand-leak.test.ts`（照 `app/tests/glossary-terms.test.ts` 写法）

规则：
- 扫描 `app/src`、`server/src`、`runner/src`、`desktop-device/src-tauri/src`、`desktop-device/src-tauri/*.json`、`mobile/`（Task 12 前先豁免 `mobile/`）、`app/index.html`。
- 非注释行里匹配 `/OpenBot|CopilotKit|copilotkit\.ai|qoder/i` 即失败，除非命中白名单；白名单每条一个理由字符串：`@copilotkit/` 导入与样式；`/api/copilotkit`；Global Constraints 里「绝对不改」的串；`x-openbot-`、`data-openbot-`、存储键（Task 13 后删）；`OPENBOT_` 变量名；标识符（`OpenBot` 后紧跟大写字母或出现在 `import`/`type`/`interface`/`class` 声明里）；整目录 `openbot/desktop/`、`server/drizzle/`、`**/generated/`；`server/src/brand.ts` 本身。
- 第二组断言「必须原样存在」：Global Constraints「绝对不改」里的加密/签名域串各自在源码里至少出现一次。
- 第三组：`desktop-device` 配置和 Rust 源码不引用 `desktop/src-tauri/icons`。

- [ ] **Step 1: 写测试并跑**：此时应通过；若失败，列出的每条要么是前面任务漏掉的（回去修），要么属于白名单类（加白名单并写理由）。
- [ ] **Step 2: 提交** `test(brand): 品牌护栏测试`

### Task 11: `examples/qoderwake` 改名 `examples/xiongbao`

**Files:**
- `git mv openbot/examples/qoderwake openbot/examples/xiongbao`；`brand.yaml` 顶部注释去掉「QoderWake 复刻」
- Modify 默认值：`server/src/config.ts`（约 1377 行）、`openbot/Dockerfile:100,218`、`.env.example`、`docker/delivery.env.example`、`scripts/generate-app-config.ts`、`.github/workflows/*.yml`
- 兜底：加载租户包时若 `TENANT_PACKAGE_DIR` 指向的目录不存在且路径以 `examples/qoderwake` 结尾，改试同级 `examples/xiongbao`，并打一行提示
- `git mv docs/deployment-qoderwake.md docs/deployment-xiongbao.md`（及其他 `*-qoderwake.md`），更新引用（含 `clean-deploy.yml`）
- Modify（经同意只改字样）: 引用该路径的原有测试（`build-cache.test.ts`、`browser-search-guidance.test.ts`、`tenant-package-avatar-channel.test.ts`、`catalogue-bot-grants.integration.test.ts`、`avatar-conversation.integration.test.ts`、`qoderwake-package.test.ts`、`staffing-bot-creator-tools.test.ts`、`config.test.ts`）
- Test: Review Focus 5 —— 显式旧路径仍能加载

- [ ] Step 1–5；提交 `refactor(brand): 租户包目录改名 examples/xiongbao，旧路径兜底`

### Task 12: 移动端白标

**Files:**
- Modify: `openbot/mobile/app.config.ts`（`name: "熊宝"`、`slug: "xiongbao"`、`scheme: "xiongbao"`、`ios.bundleIdentifier` / `android.package` = `com.xiongbao.mobile`、通知渠道 id `xiongbao`）；`mobile/app/**` 里的界面文字与 `openbot-device-id` 存储键
- Modify: `server/src/auth/index.ts:41`（`NATIVE_APP_ORIGIN` 认 `xiongbao://` 和 `openbotmobile://` 两个）、`server/src/delivery/push.ts:56`（发 `xiongbao://`）
- Test: 服务端：两个 scheme 的登录回跳都被接受、推送深链用新 scheme；移动端若有测试，改字样后通过
- 完成后把 `mobile/` 从 Task 10 的豁免里删掉，护栏通过

- [ ] Step 1–5；提交 `feat(brand): 移动端改名熊宝，服务端双认深链 scheme`

### Task 13（P7）: 开发者工具里看得见的痕迹

**Files:**
- 存储键：`app/src/lib/theme.ts`、`lib/sidebar.ts` 等约 10 个 `openbot-*` 键改 `xiongbao-*`；新增 `app/src/lib/storage-migrate.ts` 的 `readMigrated(key: string, legacyKey: string): string | null`（读不到新键就读旧键、写到新键、删旧键）；`app/index.html` 内联脚本里的 `openbot-theme` 同步改并带同样的回退
- Cookie：`server/src/auth/organization.ts:7` 写 `xiongbao.organization-session`，读新旧两个
- 请求头：`x-openbot-voice`、`x-openbot-dictation` 服务端两种都认，网页发 `x-xiongbao-voice`、`x-xiongbao-dictation`
- 护栏白名单删掉对应条目
- Test: 存储搬家（只有旧键 → 读到旧值且新键已写、旧键已删）；cookie 旧名仍能登录；两种请求头都被接受

- [ ] Step 1–5；提交 `feat(brand): 存储键、组织登录 cookie、语音请求头改名并兼容旧名`

---

## 交付

- 分支 `feat/brand-removal`（从 main 拉），一个 PR；Task 1–10 完成后先请审阅一轮，Task 11–13 跟上。
- CHANGELOG 记一条：客户能看到的变化（推广条默认关、图标、进程名、演示邮箱、新环境变量名、关于页），写明「`.env.delivery` 不用改」。
- 验收按规格 6.2 由用户在京东云和设备端执行。
