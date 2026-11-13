# 逐步重写（按可见度分层）实施计划

> **给执行代理：** 必须配合以下子技能之一使用：superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。按任务逐个实施，步骤用复选框（`- [ ]`）跟踪。

**目标**：客户和客户的技术人员在交付物里（开发者工具、镜像、安装包、扩展、部署文档、日志）看不到上游名字；护栏改为扫交付物，剩余工作量从白名单和度量表直接读出来；同时照常同步上游。

**架构**：
- 先升级护栏（第 3 层）：扫描核心抽到 fork 自有的 `openbot/scripts/brand/guard/`；白名单加分类和去向；规则抹掉的部分改成预算；新增行检查；只减不增的棘轮；前端、扩展、runner、镜像、安装包、客户文档各一份「词表」。
- 再清第 1 层：每个任务按「改名 / 双认 / 保留」处理一组可见面，验收就是白名单条目删掉了哪些、度量降了多少。
- 双认逻辑放在 fork 自有的小函数里，上游文件里每处只改成一次调用。旧名留在原文件、原行，让原有白名单条目继续命中，只改它的分类。
- 第 2 层（源码随改随清）没有单独任务，由 Task 3 的新增行检查在每个 PR 上执行。

**技术栈**：Bun + TypeScript（server、app、runner、shared、extension、agent-computer、护栏脚本）；Rust + Tauri 2（desktop-device）；s6-overlay 与 Dockerfile（镜像）；GitHub Actions（只改仓库根的 `.github/workflows/*`）。

**设计文档**：`docs/specs/2026-11-12-gradual-rewrite.md`（2026-11-12 用户同意；第 9 节末「用户决定」为最终裁定）。前序：`docs/specs/2026-11-11-brand-removal.md`、`docs/plans/2026-11-12-brand-removal.md`。

## 全局约束

**项目约束**
- biome 只在 `openbot/` 里用 `npx --no-install` 跑：`cd openbot && npx --no-install biome check <改动的文件>`。
- 新增的 server 测试文件要登记：`cd openbot && bun scripts/ci/server-shards.mjs --write`，提交 `scripts/ci/server-tests.list.txt`。用到数据库的测试在最后一个 `afterAll` 里关连接池。
- server 类型检查：`cd openbot/server && NODE_OPTIONS=--max-old-space-size=8192 npx --no-install tsc --noEmit`。
- 品牌护栏测试是 `openbot/app/tests/brand-leak.test.ts`，白名单是 `openbot/app/tests/brand-leak-allowlist.json`。
- 每个提交信息末尾带这两行 trailer：
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MJUqVcFToyopKbNJ4sEoWY
  ```
- 只改仓库根的 `.github/workflows/*`；`openbot/.github/workflows/*` 是上游副本，不运行，不改。

**已有测试**
- 已有测试的断言不改、不删。只允许往已有的精确相等断言里追加本计划新增的值（例如扩展策略键列表里加 `XiongbaoUrl`）。
- `brand-leak.test.ts` 只允许改 `import`（Task 1 把扫描核心抽出去）；它的每个 `test(...)`、`expect(...)` 以及 `MUST_REPORT`、`MUST_ALLOW`、`NEVER_CHANGE`、`SIGNING_DOMAINS`、`WIRE_HEADERS` 数组都原样保留。新护栏测试写在新文件里。
- **断言冲突怎么办**：改名前先跑 `cd openbot && git grep -n -F -- '<旧值>' -- '*tests/*' '*.test.*' '*test.sh' 'scripts/ci/*.test.mjs'`。如果某个已有断言要求旧值**仍被写出或发出**，这一项在本任务里**不改**：旧值原样留着，白名单条目改成 `plan: "rewrite"`，并在 note 里写「待批：附录 A 第 N 行」。再把它追加到本文件附录 A，PR 说明里列出。获批后由 Task 19 落地。已知的冲突见附录 A。

**不改的东西**（规格 1.2 节、第 9 节）
- 目录 `openbot/`、`@openbot/*` 包名、根 `package.json` 的 `"name"`、上游文件里的类型名、函数名、变量名、上游注释。
- 加密、签名域串，持久化标记，数据库名与角色名，`server/drizzle/`，`recovery/` 里的 SQL，K8s 标签，`/api/copilotkit`。
- `x-openbot-agent-token`、`x-openbot-desktop-host-token`；14 个 Python 框架和上游 `toolkit` 的发送方代码。
- 租户 id `openbot`（Task 6 只核实）；Helm chart `charts/openbot/`（不交付，护栏整目录豁免）；上游桌面 `desktop/`。
- 第 9 问列出的永久残留：第三方库自带的 CopilotKit 字样、已持久化或与对端共享的载荷标识符、数据库名与角色名、加密版本串、扩展 IndexedDB `openbot-recorder`。白名单里分类为 `keep`，度量表单列「永久残留」。

**白名单只减不增**
- Task 1、2、4、5 建立基线：只有它们可以**新增**白名单条目、预算行和产物词。Task 3 合入后，棘轮在每个 PR 上强制执行：条目数不增；每条的 `text` 必须等于 base 白名单里某条的 `text` 或是它的子串；预算每行不增；产物词表不增。
- 例外：上游同步 PR（改了 `openbot/upstream-sync.json` 的 `commit`）可以新增，只限 `persisted-data`、`crypto-domain`、`peer-protocol`、`parsed-exact-text`、`third-party-name`、`upstream-shell-only` 六类，而且每一行都能在同步点的同一路径里找到（用户决定第 7 条）。
- 每个清理任务都写明它删掉哪些条目或产物词，或者哪一项预算降多少。分类变更（例如 `persisted-data` → `legacy-compat`）不算新增。

**兼容窗口**（规格第 4 节；用户决定第 10 条）
- 一个版本 = 一个正式发布标签（`vX.Y.Z`，不算 `-rc`）。N、N+1 都认旧名，N+2 删除。
- 发布顺序以 `openbot/CHANGELOG.md` 的 `## X.Y.Z` 标题为准（`release-tag.mjs` 要求每个正式版都有这个标题）。
- `introducedIn` 填本 PR 合入后第一个包含它的正式版本：`git tag -l "v$(jq -r .version openbot/package.json)"` 为空就用当前 `version`，否则用下一个补丁号。`removeIn` 填 `introducedIn` 之后第二个补丁号，只作提示。
- 已有的双认（组织登录 cookie、`x-openbot-voice/dictation`、表一的 7 个存储键）从 `0.2.9` 起算。
- `OPENBOT_*` 环境变量**永久**兼容读取，不进窗口期，不写 `legacy-compat`。
- 设备端的旧名删除前，用户还要确认服务器上已看不到低于 N+1 的旧设备（Task U7）。服务器目前不记设备端版本（`server/src/db/schema/devices.ts` 没有版本字段），所以这一步由用户确认，本计划不新增版本上报。

**新名字**（用户决定第 8 条）
- 开发者工具、镜像、安装包里：`xiongbao`（与已改的 `x-xiongbao-*`、`xiongbao-*` 存储键一致）。
- 注入第三方网页的东西用 `xb` 前缀（按规格第 9 问第 8 条的例子 `data-xb-secret`）：`data-xb-secret`、`data-xb-person-filled`、`data-xb-login`、`<xb-recorder-notice>`、`<xb-recorder-mark>`、`Symbol.for("xb.recorder.configure")`、`Symbol.for("xb.recorder.stop")`；扩展不再往 `window` 上挂全局名。

**执行档位**
- 建议执行模型：haiku = 给出了完整取值、照做加测试；sonnet = 默认；opus = 牵涉安全、审批或兼容协议。
- 评审方式：「无需单独评审」= 文档、文案、改名、配置，靠 CI 和护栏验收；「sonnet 一轮」= 中风险；「完整评审」= 安全相关。
- 「需要用户」的任务不阻塞代码任务。每个任务都写明前置条件；没写的就可以和别的任务并行。

## 审查重点

1. **遮罩属性改名后，密码框照样被遮住**：runner 和 agent-computer 各自写、各自读遮罩属性，改名必须两头一起改，截图和快照里密码框仍然打码。→ Task 12 测试「改名后快照与截图仍遮住密码框」；Task 19 处理 runner 那一半。
2. **镜像默认值不能压过客户的旧名设置**：`.env.delivery` 里只写 `OPENBOT_RLS_ENFORCE=warn` 时必须是 `warn`；新旧名都没设时才是 `refuse`。→ Task 11 测试「只设旧名时默认值不写入」「两个都没设时写入」。
3. **回退到 v0.2.9 偏好仍在**：新代码把旧键的值复制到新键，但不删旧键；升级瞬间没刷新的老标签页继续读写旧键也不丢。→ Task 7 测试「只有旧键：读到旧值、新键已写、旧键仍在」。
4. **上游同步 PR 不被误报；同步点取不到时失败**：上游带来的行按同一路径逐行比对放行；拿不到同步点提交就失败并说明原因，不静默放行。→ Task 3 测试「上游原样的行不报」「同步点缺失时报错」，以及用 `64a8f7d1` 回放。
5. **内部头混跑**：新服务器 + 旧 agent-computer、旧服务器 + 新 agent-computer 都要能用；令牌头双认不能变成「两个都不验」。→ Task 16 测试「只带新头」「只带旧头」「新旧不一致时以新头为准且仍要验令牌」；Task 20 混跑冒烟。

---

## 文件结构

| 文件 | 职责 | 建立于 |
|---|---|---|
| `openbot/scripts/brand/guard/scan.ts` | 从 `brand-leak.test.ts` 抽出的扫描核心：`BRAND`、带 `id` 的 `RULES`、`NEVER_CHANGE`、`SIGNING_DOMAINS`、`WIRE_HEADERS`、`EXEMPT_PATHS`、`walk`、`scannedFiles`、`codeLines`、`masked`、`findings` | Task 1 |
| `openbot/scripts/brand/guard/allowlist.ts` | 新分类枚举、`plan` 规则、条目校验、到期判定 | Task 1 |
| `openbot/scripts/brand/guard/env-names.ts` | 已知环境变量名、加密版本名（规则拆分用） | Task 2 |
| `openbot/scripts/brand/guard/budget.ts` | 按规则、按范围统计抹掉的行数 | Task 2 |
| `openbot/scripts/brand/guard/new-lines.ts` | 取新增行，判定是否上游带来 | Task 3 |
| `openbot/scripts/brand/guard/ratchet.ts` | 与 base 比较白名单、预算、词表 | Task 3 |
| `openbot/scripts/brand/guard/artifact-words.ts` | 抽词、与词表比对（Task 4 加二进制取字符串） | Task 2 |
| `openbot/scripts/brand/scan-artifact.ts` | 命令行：扫一个产物并写 job summary 片段 | Task 4 |
| `openbot/scripts/brand/metrics.ts` | 度量表（与 `origin/main` 对比） | Task 4 |
| `openbot/upstream-sync.json` | 机器可读的上游同步点 | Task 3 |
| `openbot/app/tests/brand-budget.json` | 预算 | Task 2 |
| `openbot/app/tests/brand-artifacts/{docs,web,extension,runner,image-files,image-config,deb}.json` | 各产物词表 | Task 2、4、5 |
| `openbot/shared/env-aliases.ts`（已有） | 新增 `envName()` | Task 8 |
| `openbot/app/src/lib/storage-compat.ts` | 复制不删的存储双认 | Task 7 |
| `openbot/server/src/wire-codes.ts` | 发往浏览器的错误码改新名 | Task 9 |
| `openbot/docker/defaults.env`、`openbot/docker/xiongbao-apt` | 镜像默认值文件、改名后的 apt 助手 | Task 11 |

## 任务一览

| Task | 内容 | 前置 | 建议执行模型 | 评审方式 | 需要用户 |
|---|---|---|---|---|---|
| 1 | 护栏核心抽取、白名单新字段、分类迁移、到期测试 | — | sonnet | sonnet 一轮 | |
| 2 | 规则拆分、预算、扫描范围扩大、客户文档词表 | 1 | sonnet | sonnet 一轮 | |
| 3 | 新增行检查、只减不增棘轮、`upstream-sync.json` | 2 | sonnet | sonnet 一轮 | |
| 4 | 产物扫描（前端、扩展、runner）、`brand-artifacts` job、度量表、显式关 sourcemap | 1 | sonnet | sonnet 一轮 | |
| 5 | 镜像与 `.deb` 扫描 | 4 | haiku | 无需单独评审 | |
| U1 | 把 `brand-artifacts` 设为必需检查 | 4 | — | — | **需要用户** |
| U2 | 批准修改已有断言（附录 A） | — | — | — | **需要用户** |
| U3 | 自有分发渠道选型与开通（含账号、凭据） | — | — | — | **需要用户** |
| 6 | 核实 `credentials.tenantId` 来源（只出结论） | — | opus | 无需单独评审 | |
| 7 | 浏览器存储与默认皮肤双认（L1-1、L1-2） | 3、4 | opus | sonnet 一轮 | |
| 8 | 网页与运维可见文字（L1-3～L1-7） | 3、4 | sonnet | 无需单独评审 | |
| 9 | 发到浏览器的错误码改新名（L1-8） | 3 | opus | sonnet 一轮 | |
| 10 | 镜像瘦身、构建标识、标签、发布清单（R4-A、L1-11～L1-13） | 5 | sonnet | sonnet 一轮 | |
| 11 | 镜像兼容：`xiongbao-apt`、默认值文件（L1-9、L1-10） | 5 | opus | 完整评审 | |
| 12 | Bot 浏览器与终端痕迹（L1-16、L1-17） | 3 | opus | 完整评审 | |
| 13 | 设备端（L1-19、L1-20） | 5 | sonnet | sonnet 一轮 | |
| 14 | 录制扩展（L1-21～L1-23） | 4 | opus | sonnet 一轮 | |
| 15 | R4b：服务器打包成单文件（验证任务） | 10 | sonnet | sonnet 一轮 | |
| 16 | 内部头第一步：agent-computer 双认（R8a） | 3 | opus | 完整评审 | |
| 17 | 发布流水线接入自有渠道 | 10 | opus | 完整评审 | |
| 18 | 交付文档、样例、compose：新名与自有渠道（L1-14、L1-15） | 17、U2、U3 | haiku | 无需单独评审 | |
| U4 | 京东云部署脚本下载地址切换窗口 | 17、18、U3 | — | — | **需要用户** |
| U5 | 仓库改为私有 | U4 | — | — | **需要用户** |
| 19 | 落地获批的断言冲突项 | U2 + 各原任务 | sonnet | sonnet 一轮 | |
| U6 | 手工验收 | 各任务合入后 | — | — | **需要用户** |
| 20 | 内部头第二步：服务器改发新名（R8b） | 触发条件见任务 | opus | 完整评审 | |
| U7 | 到期清理前的用户确认 | 触发条件见 Task 21 | — | — | **需要用户** |
| 21 | 到期清理（N+2，每次发版） | 触发条件见任务；U7 | sonnet | 无需单独评审 | |

依赖：1 → 2 → 3；1 → 4 → 5。7、8、9、12、14、16 在 3（以及要用的扫描）合入后可以并行。10、11、13 等 5。15 等 10。17 等 10，代码可以先写，真跑等 U3。18 等 17、U2、U3。U4 等 17、18 都合入，并且自有渠道上已经有一个正式版本。U5 等 U4 完成。U1、U2、U3、6 随时可做。

规格分包与本计划的对应：R1 → Task 1–5；R2 → Task 7、8（L1-3～L1-5）、4（L1-25）；R3 → Task 8（L1-6、L1-7）、18（L1-15）；R4 → Task 10、11、18（L1-14）；R4b → Task 15；R5 → Task 12；R6 → Task 13（L1-18 → Task 19）；R7 → Task 14；R8 → Task 16、20；R9 → Task 21；R0 的切换窗口 → U4、U5。L1-8 没有归入规格的任何分包，本计划单列为 Task 9。

---

## 阶段 A：护栏升级（最先做）

### Task 1：护栏核心抽取、白名单新字段、分类迁移、到期测试

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**文件：**
- 新建：`openbot/scripts/brand/guard/scan.ts`、`openbot/scripts/brand/guard/allowlist.ts`
- 修改：`openbot/app/tests/brand-leak.test.ts`：删掉本地定义，改成从 `../../scripts/brand/guard/scan` 导入同名常量和函数。`test`、`expect`、各数组一行不改。
- 修改：`openbot/app/tests/brand-leak-allowlist.json`：194 条全部加 `category`、`plan`；`legacy-compat` 另加 `introducedIn`、`removeIn`。`file`、`text` 不变；`reason` 保留（已有测试按它的前缀校验旧分类），只修正第 2.1 节发现 3 的 10 条错误说明。
- 测试（新建）：`openbot/app/tests/brand-allowlist-fields.test.ts`、`openbot/app/tests/brand-expiry.test.ts`

**接口：**
- 产出（`scan.ts`）：`export type Rule = { id: string; pattern: RegExp; reason: string }`。`RULES` 的顺序和正则与现在完全相同，按顺序加 `id`：`copilotkit-package`、`openbot-package`、`runtime-path`、`openbot-env`、`wire-dom`、`never-change`、`mit-attribution`、`identifier`、`copilotkit-handle`、`openbot-camel`、`import-close`、`import-path`、`declaration`。`REPO` 改为由本文件位置推出（`new URL("../../..", import.meta.url)`，指向 `openbot/`）。另导出 `type Finding = { file: string; number: number; line: string }`。
- 产出（`allowlist.ts`）：
  ```ts
  export const CATEGORIES = ["legacy-compat", "persisted-data", "crypto-domain", "peer-protocol", "parsed-exact-text", "operator-visible", "third-party-name", "upstream-shell-only", "developer-only"] as const;
  export type Category = (typeof CATEGORIES)[number];
  export type Plan = "keep" | "rewrite" | "remove";
  export const PLANS: Record<Category, Plan[]>; // legacy-compat:[remove]；persisted-data:[keep,rewrite]；crypto-domain:[keep]；peer-protocol:[keep,rewrite]；parsed-exact-text:[keep,rewrite]；operator-visible:[rewrite]；third-party-name、upstream-shell-only、developer-only:[keep]
  export type AllowEntry = { file: string; text: string; reason: string; category: Category; plan: Plan; introducedIn?: string; removeIn?: string; notBefore?: string; device?: true };
  export function entryProblems(entry: AllowEntry): string[];
  export function releasesAfter(version: string, changelog: string, current: string): string[];
  export function isExpired(entry: AllowEntry, changelog: string, current: string): boolean;
  ```
  - `entryProblems`：分类不在枚举里；`plan` 不在 `PLANS[category]` 里；`legacy-compat` 缺 `introducedIn` 或 `removeIn`；版本号不是 `X.Y.Z`；`persisted-data` 或 `peer-protocol` 用 `rewrite`，但 `reason` 没写 `L1-` 编号。
  - `releasesAfter`：从 CHANGELOG 的 `## X.Y.Z` 标题（跳过 `Unreleased`）加上 `current`，去重后返回比 `version` 新的版本，按版本号排序。
  - `isExpired`：`legacy-compat` 且 `releasesAfter(introducedIn).length >= 2`，并且没有 `notBefore` 或 `current >= notBefore`。
- 分类迁移规则（一次性脚本放在草稿目录，不提交）：
  - `internal-log`、`internal-error` → `operator-visible` / `rewrite`。
  - `external-name` → `third-party-name` / `keep`。
  - `developer-only`、`upstream-shell-only`、`parsed-exact-text` 照旧，`plan` 取 `keep`。
  - `persisted-identifier` 138 条逐条复核：
    - 已经双认的旧名 → `legacy-compat`，`introducedIn: "0.2.9"`，`removeIn: "0.2.11"`。包括：`app/src/lib/theme.ts`、`app/src/skins/store.ts`、`app/src/lib/sidebar.ts`、`app/src/components/app-sidebar/app-sidebar.tsx`、`app/src/components/notifications/notify-prompt.tsx`、`app/index.html` 的两个旧键，以及服务器上 `openbot.organization-session` 的条目（如果有）。
    - Recorder 消息类型、`openbot-browser`、`openbot-unreachable`、A2UI 目录 `openbot/ui@1`、`<<openbot:*>>`、`ai.copilotkit.openbot.recorder`、`data-copilotkit-*` → `peer-protocol` / `keep`。
    - 第 1 层要改的 → `persisted-data` / `rewrite`，`reason` 写上 `L1-` 编号。包括：表二的 10 条、皮肤 id 的 5 条、L1-3 的 DOM 和通知 tag、扩展的元素名和 Symbol、`runner/src/browser.ts` 的 `"openbot-snapshots.sqlite"`。
    - `extension/src/shared/database.ts`、`extension/src/offscreen/streamer.ts` 的 `"openbot-recorder"`（IndexedDB，第 9 问）→ `persisted-data` / `keep`。
    - 其余 → `persisted-data` / `keep`。
  - 修正 10 条错误说明：`reaching-you.tsx`、`link-conversation-dialog.tsx`、`teach-steps.tsx`、`wakerflows.ts`、`handoff.ts`、`activity.ts`、`outbox.ts`、`carry-on.ts`、`check-in-offer-tool.tsx`、`bot-thread.ts`。前缀保留 `persisted-identifier:`，说明改成「仍在用旧键读写，L1-1 待双认（Task 7）」。

- [ ] **Step 1：写失败测试** `brand-allowlist-fields.test.ts`：
  - `every entry has a category and a plan the category allows`：`ALLOWLIST.flatMap(entryProblems)` 等于 `[]`。
  - `no entry still claims readMigrated where the file never calls it`：对 `reason` 含 `readMigrated` 的条目，断言 `file` 的内容含 `readMigrated(`。
  - `entryProblems names each fault`：用构造的坏条目断言，分别得到含 `category`、`plan`、`introducedIn`、`L1-` 的提示。
- [ ] **Step 2：写失败测试** `brand-expiry.test.ts`：
  - `releasesAfter counts formal releases from the changelog and the current version`：CHANGELOG 有 `## Unreleased`、`## 0.2.10`、`## 0.2.9`、`## 0.2.8`，`current` 为 `0.2.10`，则 `releasesAfter("0.2.9", …)` 为 `["0.2.10"]`。
  - `two releases after N expire it, one does not`：`introducedIn: "0.2.9"`；`current` 为 `0.2.10` 时不到期，为 `0.2.11` 时到期；跳到 `0.3.0` 时也只算一次发布。
  - `notBefore holds a device entry back`
  - `no legacy-compat entry is past its window`：读真实的 `openbot/CHANGELOG.md` 和 `openbot/package.json`，`ALLOWLIST.filter((e) => isExpired(e, changelog, version))` 等于 `[]`。失败信息逐条写「这个旧名到期了：删掉兼容代码和这条白名单（Task 21）」，带 `file`、`text`；`device` 条目另加「先完成 Task U7」。
- [ ] **Step 3：运行** `cd openbot/app && bun test tests/brand-allowlist-fields.test.ts tests/brand-expiry.test.ts`，预期失败（模块不存在）。
- [ ] **Step 4：实现** `scan.ts`、`allowlist.ts`，改 `brand-leak.test.ts` 的导入，迁移白名单。
- [ ] **Step 5：运行** `cd openbot/app && bun test tests/brand-leak.test.ts tests/brand-allowlist-fields.test.ts tests/brand-expiry.test.ts`，全部通过。`brand-leak.test.ts` 的用例数仍是 49。`git diff openbot/app/tests/brand-leak.test.ts` 只有 `import` 和删除的定义。
- [ ] **Step 6：提交** `护栏：扫描核心抽到 scripts/brand/guard，白名单加分类与去向，到期测试`。白名单条数不变（194）；10 条错误说明已修正。

### Task 2：规则拆分、预算、扫描范围扩大、客户文档词表

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**文件：**
- 新建：`openbot/scripts/brand/guard/env-names.ts`、`openbot/scripts/brand/guard/budget.ts`、`openbot/scripts/brand/guard/artifact-words.ts`、`openbot/app/tests/brand-budget.json`、`openbot/app/tests/brand-artifacts/docs.json`
- 修改：`openbot/scripts/brand/guard/scan.ts`
- 修改：`openbot/app/tests/brand-leak-allowlist.json`（建立基线，见下）
- 测试（新建）：`openbot/app/tests/brand-rules-split.test.ts`、`openbot/app/tests/brand-budget.test.ts`、`openbot/app/tests/brand-docs.test.ts`

**接口：**
- `env-names.ts`：
  - `UPSTREAM_ENV_NAMES: readonly string[]`：规格 2.6 节「真正的环境变量」一栏的全部名字，外加 `server/src`、`shared`、`runner/src`、`agent-computer/src`、`supervisor/src`、`worker/src` 里实际经 `process.env` / `env.` / `optional(` 读取的 `OPENBOT_*`。以 `_` 结尾的项按前缀匹配（如 `OPENBOT_POOL_`）。
  - `THIRD_PARTY_ENV_NAMES = ["COPILOTKIT_TELEMETRY_DISABLED", "COPILOTKIT_LICENSE_TOKEN"]`
  - `CRYPTO_NAMES`：`OPENBOT_APPROVAL_EXACT_AEAD_V1`、`OPENBOT_APPROVAL_EXACT_HEADER_V1`、`OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1`、`OPENBOT_APPROVAL_EXACT_WIRE_V1`、`OPENBOT_EXACT_INPUT_JSON_V1`。
- 规则拆分（`scan.ts`）：
  - `openbot-env` 拆成两条：`env-name`（已知环境变量名）和 `crypto-name`（加密版本名）。
  - 字符串字面量里的大写 `OPENBOT_X` / `COPILOTKIT_X`，只有两种情况被抹掉：它是已知名字，**并且**所在字面量不含空白；或者它是加密版本名。其他情况都留给白名单或预算。`identifier` 规则不再抹掉字符串字面量里的这类大写名字。字面量外的照旧算标识符。
- 扫描范围加上：`agent-computer/src`、`supervisor/src`、`worker/src`、`docker/`（不含 `docker/tests/`）、`Dockerfile`、`extension/scripts/build.ts`。
  - `codeLines` 增加「`#` 起头是注释」的模式，只用于 `Dockerfile`、`*.sh`、`docker/s6/**` 里的无后缀脚本、`*.yml`。已有后缀的行为不变。
  - `TEXT_FILE` 不放宽；新范围里的文件按路径显式列出。
  - `EXEMPT_PATHS` 追加 `charts/`（用户决定第 6 条）。
- `budget.ts`：`export type BudgetRow = { rule: string; scope: string; lines: number }`；`export function countBudget(files: string[]): BudgetRow[]`。
  - 一行代码在依次应用规则时，若某条规则在它那一步匹配到，就记这条规则一行。
  - `scope` 取路径前两段（`server/src`、`app/src`、`agent-computer/src`…）；单文件取文件名（`Dockerfile`）。
  - 结果按 `rule`、`scope` 排序。
- 白名单基线：拆分和扩范围后新冒出的命中，逐条写进白名单，带 `category`、`plan`、旧格式 `reason`。同一文件里同一短语用一个 `text` 覆盖多行。运维提示里的 `OPENBOT_*` 一律 `operator-visible` / `rewrite`；发到浏览器的错误码一律 `peer-protocol` / `rewrite`，`reason` 写 `L1-8`。
- `artifact-words.ts`（Task 4、5 和棘轮都用它）：
  ```ts
  export const WORD = /[A-Za-z0-9_.:\/@$-]*(?:openbot|copilotkit|qoder)[A-Za-z0-9_.:\/@$-]*/gi; // 规格 5.1-C
  export type ArtifactEntry = { word?: string; prefix?: string; category: Category; plan: Plan; note: string }; // word、prefix 二选一；prefix 只允许 third-party-name
  export function wordsIn(text: string): Map<string, number>;
  export function compareWords(found: Map<string, number>, allow: ArtifactEntry[]): { extra: string[]; stale: string[] };
  ```
  `extra` 是找到了但词表里没有的词；`stale` 是词表里有、产物里已经没有的 `word` 条目（`prefix` 条目一个都没命中也算）。
- `docs.json`：`ArtifactEntry[]`。范围：`<根>/README.md`、`openbot/docs/*-xiongbao.md`、`openbot/docker/delivery.env.example`、`openbot/docker/compose.delivery.yml`。

- [ ] **Step 1：写失败测试** `brand-rules-split.test.ts`：
  - 必须放行（`BRAND.test(masked(line))` 为 `false`）：`optional(environment, "OPENBOT_PUBLIC_URL")`、`env.OPENBOT_RLS_ENFORCE`、`const OPENBOT_TOOL_LIMIT = 1;`、`"OPENBOT_APPROVAL_EXACT_AEAD_V1"`、`OPENBOT_POOL_MAX`、`process.env.COPILOTKIT_TELEMETRY_DISABLED`。
  - 必须报告：`"Set OPENBOT_PUBLIC_URL to the address"`、`` `OPENBOT_EDITION is "${value}"` ``、`code: "OPENBOT_MODEL_AUTH_REQUIRED",`、`"XIONGBAO_PUBLIC_URL（旧名 OPENBOT_PUBLIC_URL 仍可用）"`。
  - `# OpenBot, whole, in one container.` 在 `Dockerfile` 里算注释；`ENV OPENBOT_IN_CONTAINER=true` 不算注释。
  - `the new scopes are scanned`：`scannedFiles()` 含 `Dockerfile`、`agent-computer/src/index.ts`、`docker/openbot-apt`。
- [ ] **Step 2：写失败测试** `brand-budget.test.ts`：
  - `the budget equals what the rules erase today`：`countBudget(scannedFiles())` 与 `brand-budget.json` 精确相等。行数变少时的失败信息为「把 brand-budget.json 里 <rule>/<scope> 改成 <n>」。
- [ ] **Step 3：写失败测试** `brand-docs.test.ts`：
  - `wordsIn` 从 `a="openbot.ping";console.warn("OpenBot couldn't")` 得到 `openbot.ping`、`OpenBot` 各 1 次。
  - `compareWords` 的多词、缺词、`prefix` 命中三种情况。
  - `customer docs carry only listed words`：比对结果 `{ extra: [], stale: [] }`。
  - `customer docs never point at the upstream`：四个文件不含 `github.com/CopilotKit`、`copilotkit.ai`（`third-party-name` 词表条目除外）。
- [ ] **Step 4：运行**这三个测试，预期失败。
- [ ] **Step 5：实现**；按实际结果生成 `brand-budget.json`、`docs.json`，补白名单基线。
- [ ] **Step 6：运行** `cd openbot/app && bun test tests/brand-*.test.ts`，全部通过；`brand-leak.test.ts` 的 `MUST_ALLOW` 里 `OPENBOT_PUBLIC_URL` 仍放行。
- [ ] **Step 7：提交** `护栏：OPENBOT_ 规则按用途拆分，规则抹掉的部分记预算，扫描范围补上 agent-computer、镜像脚本与客户文档`。PR 说明列出新增条目数，按分类统计（这是唯一一次建立源码基线）。

### Task 3：新增行检查、只减不增棘轮、`upstream-sync.json`

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**文件：**
- 新建：`openbot/upstream-sync.json`：`{ "commit": "e4a73d7bfe2c30276779c8d1473a9818e5ee1ae0", "repository": "https://github.com/CopilotKit/OpenBot.git" }`
- 新建：`openbot/scripts/brand/guard/new-lines.ts`、`openbot/scripts/brand/guard/ratchet.ts`
- 修改：`openbot/UPSTREAM.md`：「同步方法」末尾加一句「同步后同时更新 `upstream-sync.json` 的 `commit`」。
- 测试（新建）：`openbot/app/tests/brand-new-lines.test.ts`、`openbot/app/tests/brand-ratchet.test.ts`

**接口：**
- `new-lines.ts`：
  ```ts
  export type AddedLine = { file: string; number: number; line: string }; // file 相对 openbot/
  export function addedLines(diff: string): AddedLine[];            // 解析 `git diff -U0 <base>...HEAD -- openbot/` 的输出
  export function baseRef(env: Record<string, string | undefined>): { base: string; head: string }; // 先读 BRAND_BASE / BRAND_HEAD（回放用）；GITHUB_EVENT_NAME=push 时 base 为 HEAD^1；否则 `git merge-base HEAD origin/main`；head 默认 HEAD
  export function forkIntroduced(lines: AddedLine[], upstreamFile: (file: string) => string | undefined): AddedLine[];
  export function newLineFindings(lines: AddedLine[]): Finding[];   // 含注释行；同 RULES；跳过 EXEMPT_PATHS
  ```
  - 上游路径映射：fork 的 `openbot/<p>` 对应同步点提交里的 `<p>`（上游仓库根下没有 `openbot/` 这一层）。
  - 「上游原样」：上游同一路径的文件里有一行去掉首尾空白后完全相同。
  - 同步点提交不在本地 origin 上（`git branch -r --contains e4a73d7b` 只有 `upstream/*`），CI 里按需 `git fetch --depth=1 <repository> <commit>`。取不到就抛错，信息含 `upstream-sync.json` 和提交号。
- `ratchet.ts`：
  ```ts
  export type RatchetInput = { base: AllowEntry[]; head: AllowEntry[]; baseBudget: BudgetRow[]; headBudget: BudgetRow[]; baseWords: Record<string, ArtifactEntryKey[]>; headWords: Record<string, ArtifactEntryKey[]>; syncPr: boolean; inUpstream: (entry: AllowEntry) => boolean };
  export function ratchetProblems(input: RatchetInput): string[];
  ```
  - 普通 PR：`head.length <= base.length`；每条 head 的 `text` 等于 base 某条的 `text`，或是它的子串（文件可以不同，也就是允许「挪」和「缩短」）；每行预算不增；每份词表不增。base 上不存在的词表文件视为建立基线，只限文件结构表里列出的文件名。
  - `syncPr`（`upstream-sync.json` 的 `commit` 与 base 不同）：新增条目只限六类，并且 `inUpstream` 为真；预算可以增，增了的行在失败信息之外打印出来，供写进 PR 说明。
  - `ArtifactEntryKey` 是 `word` 或 `prefix:<前缀>` 字符串。

- [ ] **Step 1：写失败测试** `brand-new-lines.test.ts`，纯函数部分用构造的 diff：
  - `a fork comment naming OpenBot is reported`：`+// OpenBot does this` 在 `server/src/x.ts` → 报告。
  - `an upstream line that came with a sync is not reported`：上游文件同路径有同一行 → 不报。
  - `a test file is not checked`
  - `a missing sync commit fails with the file and the commit named`
  - `this branch adds no unexplained upstream name`：真实执行。`base = baseRef(process.env)`，同步点取不到时测试失败（不跳过）。
- [ ] **Step 2：写失败测试** `brand-ratchet.test.ts`：
  - 构造用例：新增一条 → 报；改分类 → 不报；从 A 文件挪到 B 文件、条数不变 → 不报；`text` 从 `"openbot",` 缩成 `"openbot"` → 不报；`text` 换成 base 里没有的 → 报；预算增 1 → 报；同步 PR 新增 `peer-protocol` 且在上游 → 不报；同步 PR 新增 `operator-visible` → 报。
  - `this branch does not grow any allowlist, budget or word list`：真实执行，base 文件用 `git show <base>:openbot/<path>` 读。
- [ ] **Step 3：运行** `cd openbot/app && bun test tests/brand-new-lines.test.ts tests/brand-ratchet.test.ts`，预期失败。
- [ ] **Step 4：实现。**
- [ ] **Step 5：运行**同上，通过。
- [ ] **Step 6：回放**：`cd openbot/app && BRAND_BASE=64a8f7d1^1 BRAND_HEAD=64a8f7d1 bun test tests/brand-new-lines.test.ts`。`64a8f7d1` 是 `claude/upstream-sync-m5`（#428）的合并提交，同步到 `e4a73d7b`。`baseRef` 先读 `BRAND_BASE`、`BRAND_HEAD`。上游带来的行不报；如果报了，逐条看清是熊宝自己写的行，写进 PR 说明。
- [ ] **Step 7：验红**：在 PR 上另推一个临时提交，往 `server/src/brand.ts` 以外的熊宝自有文件加一行 `// OpenBot`，往 `app/src` 加 `"openbot-x"`。确认 `app-test` 变红，删掉后变绿。截图贴进 PR 说明。
- [ ] **Step 8：提交** `护栏：新增行检查（含注释，按上游同步点放行原样行）与白名单只减不增棘轮`。

### Task 4：产物扫描（前端、扩展、runner）、`brand-artifacts` job、度量表

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**文件：**
- 新建：`openbot/scripts/brand/scan-artifact.ts`、`openbot/scripts/brand/metrics.ts`
- 修改：`openbot/scripts/brand/guard/artifact-words.ts`（Task 2 建立）：加 `printableStrings`、`ALWAYS_REPORT`。
- 新建：`openbot/app/tests/brand-artifacts/{web,extension,runner}.json`（基线）
- 修改：`openbot/app/vite.config.ts`：`build` 里显式写 `sourcemap: false`（L1-25）。
- 修改：`.github/workflows/ci.yml`：新增 job `brand-artifacts`。
- 测试（新建）：`openbot/app/tests/brand-artifact-words.test.ts`

**接口：**
- 消费：Task 2 的 `WORD`、`ArtifactEntry`、`wordsIn`、`compareWords`。
- 产出（加进 `artifact-words.ts`）：
  ```ts
  export function printableStrings(bytes: Uint8Array, min?: number): string; // 二进制里长度 ≥ 4（默认）的可打印 ASCII/UTF-8 片段，换行连接
  export const ALWAYS_REPORT = ["Powered by CopilotKit"];
  ```
- `scan-artifact.ts` 命令行：`bun scripts/brand/scan-artifact.ts --kind <web|extension|runner|image-files|image-config|deb> --input <路径> --allowlist <json> [--summary <md 文件>]`。
  - `web`：`--input app/dist`；另外断言没有 `*.map`，也没有 `sourceMappingURL`。
  - `extension`：`--input extension/dist`。
  - `runner`：`--input <二进制>`，用 `printableStrings`；另外断言不含仓库根目录的绝对路径（`process.cwd()` 推出），也不含 `/home/runner/work/`。
  - 退出码：有 `extra` 或 `stale` 为 1。失败信息每行写 `<kind>: <词> （多出来的｜已经没了）`。`ALWAYS_REPORT` 出现时只写进 summary，不失败。
- `metrics.ts`：`bun scripts/brand/metrics.ts --base origin/main >> "$GITHUB_STEP_SUMMARY"`，输出 Markdown 表：
  - 白名单按分类 × `plan` 的条数，并单列「剩余工作量」（`rewrite` + `remove`）和「永久残留」（`keep`）；
  - 预算各行；
  - 各词表的词数和总出现次数；
  - 每项与 base 的增减。
- `brand-artifacts` job（`ubuntu-latest`，`timeout-minutes: 30`，`fetch-depth: 0`，`working-directory: openbot`，与其他 job 用同一组固定 SHA 的 actions）：
  1. `bun install --frozen-lockfile`；
  2. `bun run generate:app-config && bun run --cwd app build`；
  3. `bun run --cwd extension build`；
  4. `bun desktop-device/scripts/build-sidecar.ts`；
  5. 三次 `scan-artifact.ts`（各带 `--summary "$GITHUB_STEP_SUMMARY"`）；
  6. `metrics.ts`（`if: always()`）。

- [ ] **Step 1：写失败测试** `brand-artifact-words.test.ts`：
  - `printableStrings` 从含 `\0` 的字节里取出 `/home/runner/work/x/openbot/node_modules`。
  - `vite build keeps sourcemaps off explicitly`：读 `app/vite.config.ts`，断言含 `sourcemap: false`。
- [ ] **Step 2：运行** `cd openbot/app && bun test tests/brand-artifact-words.test.ts`，预期失败。
- [ ] **Step 3：实现**；本地构建三个产物，用 `scan-artifact.ts` 的输出写三份基线词表。`copilotkit` 一类第三方词按 `third-party-name` 批量登记；产物里的 `openbot` 词按 2.7 节逐个分类。
- [ ] **Step 4：运行**测试通过；本地三次 `scan-artifact.ts` 退出码都是 0。
- [ ] **Step 5：推送**：`brand-artifacts` 通过，job summary 里有度量表。再推一个临时提交，往 `app/src` 加 `"openbot-x"`，`brand-artifacts` 变红，删掉后变绿。
- [ ] **Step 6：提交** `护栏：前端、扩展、runner 产物扫描与度量表；构建显式关闭 sourcemap`。

### Task 5：镜像与 `.deb` 扫描

**建议执行模型**：haiku　**评审方式**：无需单独评审

**文件：**
- 修改：`.github/workflows/ci.yml`：`image` job 在 `docker build` 之后加一步；`device-bundle-linux` 在 `Check the package installs and carries the runner` 之后加一步。
- 新建：`openbot/app/tests/brand-artifacts/{image-files,image-config,deb}.json`（基线）
- 修改：`openbot/scripts/brand/scan-artifact.ts`：加三种 `kind`。

**接口：**
- `image-files`：`--input <文件清单>`，清单由 `docker run --rm --entrypoint sh openbot:trackb -c 'find / -xdev \( -path /proc -o -path /sys \) -prune -o -print'` 产生；只对路径抽词。
- `image-config`：`--input <docker inspect 的 JSON>`，只对 `Config.Env` 和 `Config.Labels` 抽词。
- `deb`：`--input <.deb>`。对 `dpkg-deb -c` 的清单、`dpkg-deb -f` 的全部字段、`dpkg-deb -x` 解出的每个文件的 `printableStrings` 抽词。
- 启动日志：在 `image` job 最后对 `"$RUNNER_TEMP/delivery-evidence/startup.log"` 跑一次 `--kind web --input <日志>`（只抽词，不查 sourcemap），词表 `image-logs.json`。
- `image` job 的新步骤（照这个写）：
  ```yaml
  - name: Brand scan - image files, env, labels
    run: |
      docker run --rm --entrypoint sh openbot:trackb -c 'find / -xdev \( -path /proc -o -path /sys \) -prune -o -print' > "$RUNNER_TEMP/image-files.txt"
      docker inspect openbot:trackb > "$RUNNER_TEMP/image-config.json"
      bun scripts/brand/scan-artifact.ts --kind image-files --input "$RUNNER_TEMP/image-files.txt" --allowlist app/tests/brand-artifacts/image-files.json --summary "$GITHUB_STEP_SUMMARY"
      bun scripts/brand/scan-artifact.ts --kind image-config --input "$RUNNER_TEMP/image-config.json" --allowlist app/tests/brand-artifacts/image-config.json --summary "$GITHUB_STEP_SUMMARY"
  ```
- `.deb` 的步骤照同样写法，`working-directory: openbot`，`--input` 指向 `desktop-device/src-tauri/target/release/bundle/deb/*.deb`。

- [ ] **Step 1：** 加 `kind` 和两个 workflow 步骤；本地用 `docker build -f Dockerfile -t openbot:trackb .` 跑一遍，生成三份基线词表。
- [ ] **Step 2：** 在 `scripts/ci/device-release-workflow.test.mjs` 里加 `image and deb are brand-scanned`：`ci.yml` 的 `image` job 有一步含 `--kind image-files`，排在 `per-bot-users-smoke.sh` 之前；`device-bundle-linux` 有一步含 `--kind deb`。运行 `cd openbot/scripts/ci && bun test device-release-workflow.test.mjs`，通过。
- [ ] **Step 3：** 推送后 `image`、`device-bundle-linux` 通过，summary 有两张表。
- [ ] **Step 4：提交** `护栏：镜像文件清单、ENV 与 LABEL、启动日志、deb 包内容的品牌词表`。

### Task U1（需要用户）：把 `brand-artifacts` 设为必需检查

**前置**：Task 4 合入。

根 CI 没有汇总 job（规格 5.2 节说的「`verify` 必需检查」在 `ci.yml` 里不存在）。必需检查只能在 GitHub 分支保护里设。

- [ ] **Step 1（用户）**：GitHub 仓库 Settings → Branches → `main` 的保护规则 → Require status checks，加入 `brand-artifacts`（以及已有的 `app-test`、`image`、`device-bundle-linux`，如果还没加）。
- [ ] **Step 2（用户）**：回复「已设为必需」。

---

## 阶段 B：核实与只有用户能做的事（可以和阶段 A 并行）

### Task 6：核实 `credentials.tenantId` 的来源（只出结论）

**建议执行模型**：opus　**评审方式**：无需单独评审（结论交用户裁定，不改代码）

**范围**：规格第 9 节第 5 问。凭据加密的附加数据里有 `tenantId`（`server/src/credentials.ts:269-273`、`:292-296`）。要回答：它是不是租户包 id（`examples/xiongbao/brand.yaml:4` 的 `tenant.id: openbot`，经 `server/src/tenant-package.ts` 的 `TenantPackage.tenantId`）。如果是，改 id 会不会让已加密的凭据解不开；`former_ids`（`tenant-package.ts:241-249`）能不能覆盖这种情况。

**文件：**
- 修改：`docs/specs/2026-11-12-gradual-rewrite.md`：第 9 节第 5 问之后加一段「核实结论（Task 6）」。

- [ ] **Step 1**：从 `credentials.ts` 写入和解密两处往上追：`binding.tenantId` 从哪里来，经过哪些函数，最终取自数据库的哪一列、请求的哪个字段，还是租户包。每一跳记 `文件:行`。
- [ ] **Step 2**：再查数据库里 `tenant_id` 列的值和租户包 id 的关系（迁移、`synchronizeTenantPackage`）。
- [ ] **Step 3**：写结论，三选一：
  - 「不是租户包 id，改 id 不影响凭据」；
  - 「是，改 id 会让凭据解不开，`former_ids` 不能覆盖」；
  - 「是，但 `former_ids` 能覆盖」。
  每条附调用链。**不写改 id 的方案，不改代码。**
- [ ] **Step 4：提交** `规格：核实 credentials.tenantId 的来源（第 9 节第 5 问）`。

### Task U2（需要用户）：批准修改已有断言

**前置**：无。各代码任务**不等**这一步：被断言卡住的项先保留旧值，获批后由 Task 19 落地。

- [ ] **Step 1（用户）**：逐行看附录 A。每行回复「批准」或「不批」。批准的意思是：允许把那条已有断言的期望值从旧名改成新名，或者改成「新旧都在」；不删断言，不跳过，不放宽。
- [ ] **Step 2（用户）**：执行过程中附录 A 会追加新行（各任务发现的冲突）；每次发版前看一遍新行。

### Task U3（需要用户）：自有分发渠道选型与开通

**前置**：无。Task 17 的代码可以先写，真跑要等这一步。

客户以后从这里拿镜像、`container-images.json`、`delivery.env.example`、`compose.delivery.yml`、设备端安装包（用户决定第 1 条）。

- [ ] **Step 1（用户）**：选定镜像仓库（例如京东云容器镜像仓库）和下载页的存放位置。本计划假定下载页是兼容 S3 接口的对象存储（京东云对象存储兼容 S3）。如果选了别的，告诉执行者，Task 17 只改上传那一步。
- [ ] **Step 2（用户）**：开通账号，建一个只给 CI 用的推送账号。在 GitHub 仓库里配置：
  - Variables：`XB_REGISTRY`（如 `xxx.jcr.jdcloud.com`）、`XB_IMAGE_REPOSITORY`（如 `xiongbao/digital-employee`）、`XB_DOWNLOAD_ENDPOINT`（`https://` 开头）、`XB_DOWNLOAD_REGION`（对象存储所在区域，如 `cn-north-1`，签名要用）、`XB_DOWNLOAD_BUCKET`、`XB_DOWNLOAD_BASE_URL`（客户看到的下载页地址，`https://` 开头）。
  - Secrets：`XB_REGISTRY_USERNAME`、`XB_REGISTRY_PASSWORD`、`XB_DOWNLOAD_ACCESS_KEY_ID`、`XB_DOWNLOAD_SECRET_ACCESS_KEY`。
  - 凭据只进 Secrets，不发在对话里。
- [ ] **Step 3（用户）**：决定客户拉镜像要不要登录。如果要，给客户发只读账号的方式由用户定，文档里只写「用我们发给你的账号登录」。
- [ ] **Step 4（用户）**：回复「渠道已开通」，附上 `XB_DOWNLOAD_BASE_URL` 和镜像仓库地址（不含凭据）。

---

## 阶段 C：第 1 层清理（阶段 A 合入后）

### Task 7：浏览器存储与默认皮肤双认（L1-1、L1-2）

**建议执行模型**：opus　**评审方式**：sonnet 一轮

**文件：**
- 新建：`openbot/app/src/lib/storage-compat.ts`
- 修改（每处只改成一次调用，旧键字面量留在原文件、原行）：`app/src/components/delivery/reaching-you.tsx:66-77`、`app/src/components/reachability/link-conversation-dialog.tsx:34-45`、`app/src/lib/wakerflows.ts:1315-1331`、`app/src/lib/computers/handoff.ts:17-44`、`app/src/components/browser/teach-steps.tsx:31-47`、`app/src/lib/computers/activity.ts:117-218`、`app/src/lib/voice/outbox.ts:5-21`、`app/src/lib/copilot/carry-on.ts:40-59`、`app/src/lib/copilot/check-in-offer-tool.tsx:50-62`、`app/src/lib/copilot/bot-thread.ts:25-43`
- 修改（皮肤）：`app/src/skins/registry.ts:12-21`、`shared/user-preferences.ts`（`DEFAULT_SKIN`）、`app/index.html:30`、服务器读用户偏好的地方
- 修改：`openbot/app/tests/brand-leak-allowlist.json`：下面 15 条改为 `legacy-compat` / `remove`，`introducedIn`、`removeIn` 按全局约束填。
- 测试（新建）：`openbot/app/tests/storage-compat.test.ts`、`openbot/app/tests/skin-compat.test.ts`；服务器偏好的测试（若新建，登记 `server-tests.list.txt`）。

**接口：**
- `storage-compat.ts`（不碰已有的 `readMigrated`，它的「搬走」行为由附录 A 第 1 行另行处理）：
  ```ts
  export type CompatStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
  /** 读新键；没有就读旧键，并把值复制到新键，不删旧键。存储抛错按「没有」处理。 */
  export function readCompat(key: string, legacyKey: string, storage?: CompatStorage): string | null;
  /** 只写新键。 */
  export function writeCompat(key: string, value: string, storage?: CompatStorage): void;
  /** 删新键，同时删旧键（用户主动清除时，两边都要清掉）。 */
  export function removeCompat(key: string, legacyKey: string, storage?: CompatStorage): void;
  /** 前缀键：列出新前缀和旧前缀下的全部后缀，去重。 */
  export function compatSuffixes(prefix: string, legacyPrefix: string, storage?: CompatStorage): string[];
  ```
- 新键名：`xiongbao.reachability.pendingSms`、`xiongbao.wakerflow-share-return`、`xiongbao:pending-handoff:<botId>`、`xiongbao.teach-a-bot.introduced`、`xiongbao:computer-activity-wiped:<id>`、`xiongbao:voice-outbox:<…>`、`xiongbao:carried-on:<id>`、`xiongbao:check-in-declined:<id>`、`xiongbao.bot-thread.<agentId>`。
- `activity.ts` 的 `storage` 事件监听两个前缀。清除标记不按「新键优先」：同一台电脑新旧两个键都在时取较新的那条并写回新键；`storage` 监听收到旧前缀事件时也把较新的值持久化到新键（否则没刷新的旧标签页再清除一次后，新标签页刷新会读到新键里较旧的记录，被清掉的活动又出现）。
- 皮肤：新 id `xiongbao`。`shared/user-preferences.ts` 导出 `normalizeSkinId(id: string): SkinId`，把 `"openbot"` 映射成 `"xiongbao"`；读偏好（服务器、网页 store、`index.html` 内联脚本）都先经过它。写只写新 id。
- 删除或改类的条目（15 条）：
  - 表二的 10 条，改为 `legacy-compat`；
  - `app/src/skins/registry.ts` 的 `id: "openbot"`、`openbot,`；
  - `shared/user-preferences.ts` 的 `"openbot",`、`DEFAULT_SKIN: SkinId = "openbot"`；
  - `app/index.html` 的 `skin !== "openbot"`。
  皮肤这 5 条：原行改写后，旧字面量只留在 `shared/user-preferences.ts` 的 `normalizeSkinId` 映射里。该文件的条目 `text` 缩成 `"openbot"`（棘轮允许缩短），其余 4 条所在行不再含品牌词，条目删除。

- [ ] **Step 1：写失败测试** `storage-compat.test.ts`：
  - `only the legacy key: read, copied to the new key, legacy kept`
  - `both keys: the new one wins, nothing is written`
  - `writeCompat writes only the new key`
  - `removeCompat clears both`
  - `compatSuffixes lists both prefixes without duplicates`
  - `a throwing storage reads null and never throws`
  - 再加一条集成用例 `activity wipes under the old prefix are still honoured`：先写旧前缀的键，再触发 `storage` 事件，断言视图按「已清除」处理。
  - 再加一条 `a later wipe from an old tab survives a reload`：新旧两个键都已存在，旧标签页再清除一次（只写旧键并触发 `storage` 事件），再模拟新标签页刷新重新读取，断言按最新那次清除处理。
- [ ] **Step 2：写失败测试** `skin-compat.test.ts`：
  - `normalizeSkinId("openbot")` 为 `"xiongbao"`；`DEFAULT_SKIN` 为 `"xiongbao"`。
  - `index.html` 内联脚本在 `xiongbao-skin` 为 `"openbot"` 时不设 `data-skin`。
  - 已有测试里 `skin: "openbot"` 的偏好输入（如 `app/tests/app-shell-parity.test.tsx:186`）照常通过。
- [ ] **Step 3：运行** `cd openbot/app && bun test tests/storage-compat.test.ts tests/skin-compat.test.ts`，预期失败。
- [ ] **Step 4：实现**；对 9 个键各跑一次全局约束里的冲突检查。已知不冲突：`reachability-parity.test.tsx:368`、`computer-activity-wipe-survives-reload.test.ts:156,205`、`voice-outbox.test.ts:61-63` 都只是**写入旧键做输入**，双认后照常通过。
- [ ] **Step 5：运行** `cd openbot/app && bun run --cwd .. generate:app-config && bun test`，全部通过；`brand-artifacts` 的 `web` 词表不变（旧键仍在，等 N+2）。
- [ ] **Step 6：提交** `网页：9 个浏览器存储键与默认皮肤改新名，旧名复制不删、照读一个窗口期`。度量：白名单 `rewrite` 减 15，`legacy-compat` 加 10；皮肤 4 条删除、1 条挪进映射。

### Task 8：网页与运维可见文字（L1-3～L1-7）

**建议执行模型**：sonnet　**评审方式**：无需单独评审

**文件：**
- 修改：`openbot/shared/env-aliases.ts`：加 `export function envName(suffix: string): string`，返回 `` `XIONGBAO_${suffix}` ``。
- L1-3（改名，不双认）：
  - `app/src/components/browser/learning-next.tsx:244`（通知 tag `openbot-learned-*` → `xiongbao-learned-*`）；
  - `app/src/lib/notifications/show.ts`（`openbot-<channelId>` → `xiongbao-<channelId>`）；
  - `app/src/components/computer/computer-view.tsx:931,937`（`id="openbot-secret"` → `xiongbao-secret`）；
  - `app/src/components/layout/openbot-version.tsx:17`（`data-slot` → `xiongbao-version`）。
  - 文件名、组件名不改。
- L1-4：`app/src/lib/copilot/stopped-turn.ts:65` 的 `console.warn` 文字改为 `` `${productName}连不上后端。` ``，产品名取 `appConfig.brand`。
- L1-5：`app/src/routes/_authed/_app/responsibilities.tsx:978` 只写 `XIONGBAO_*`，去掉「旧名 OPENBOT_* 仍可用」。`plugin-page.tsx:1417` 被 `brand-web-copy.test.tsx:45` 卡住，见附录 A 第 5 行。
- L1-6：`server/src` 里说出 `OPENBOT_*` 的启动报错和运维提示（规格 2.6 节列出的 `config.ts:613,742,754,1476,1809,1959-1979,2001`、`edition.ts:79`、`auth/dev-actor.ts:158`、`auth/role-writer-lifecycle.ts:27`、`web-bot-auth.ts:153`、`browser/bot-browser.ts:99`、`browser/routes.ts:286`，以及 Task 2 白名单里所有 `operator-visible` 且含 `OPENBOT_` 的条目）。每处改成 `${envName("X")}`；「This OpenBot」改用 `server/src/brand.ts` 的 `productName()`。
  - `config.ts:1604` 的默认路径 `/etc/openbot/sandbox-template.json` **不改**：它是 `COMPUTER_SANDBOX_TEMPLATE_FILE` 没设时的默认值，Helm chart 按它挂载（chart 不交付，单镜像不走这条路）。白名单条目归 `persisted-data` / `keep`。
  - runner `--help`：`runner/src/index.ts:203,220-221` 改写 `XIONGBAO_RUNNER_DATA_DIR`、`XIONGBAO_DESKTOP_HELPER`、`XIONGBAO_DESKTOP_ENGINE`。
  - agent-computer 报错里说出的头名：`agent-computer/src/bot-browser-host.ts:79`、`browser-host.ts:460`、`real-browser.ts:406` 改为「在请求头里带上员工的浏览器 id」，不写头名。
- L1-7：白名单 `operator-visible` 的 21 条（原 `internal-log` 16、`internal-error` 5，见 Task 1）改写。写到第三方的地方保留第三方名字（如「CopilotKit Intelligence」），条目改成 `third-party-name` / `keep`。
- 测试（新建）：`openbot/server/tests/env-name.test.ts`（登记 `server-tests.list.txt`）、`openbot/app/tests/web-visible-names.test.ts`

**接口：**
- 产出：`envName(suffix: string): string`（`shared/env-aliases.ts`）。runner、agent-computer、server 都从这里取。

- [ ] **Step 1：写失败测试**：
  - `env-name.test.ts`：`envName("PUBLIC_URL")` 为 `"XIONGBAO_PUBLIC_URL"`。
  - `env-name.test.ts`：`loadConfig` 遇到非法 `XIONGBAO_EDITION` 时抛错，信息含 `XIONGBAO_EDITION`，不含 `OPENBOT_`（规格 R3 验收 ③）。
  - `env-name.test.ts`：只设旧名 `OPENBOT_EDITION=bad` 时同样报错，信息照样只写新名。
  - `web-visible-names.test.ts`：对 L1-3 的四个文件，断言新值存在、旧值不存在。
- [ ] **Step 2：运行**，预期失败。
- [ ] **Step 3：实现**；逐项做冲突检查。已知冲突：`data-orb`、通知 tag `openbot-attention-*` / `openbot-ping-*`、`.openbot-markdown` / `.openbot-breakdown`、`plugin-page.tsx` 提示、`arcade-config.test.ts`、`browser-routes.integration.test.ts`。这些不改，见附录 A 第 2–6 行。新发现的追加到附录 A。
- [ ] **Step 4：运行**：`cd openbot/app && bun run --cwd .. generate:app-config && bun test`；`cd openbot/server && bun test tests/env-name.test.ts tests/config.test.ts tests/edition.test.ts`，以及改到的文件对应的测试；server tsc；biome。
- [ ] **Step 5**：本地用规格 R3 验收 ② 的方式自查：用 `git show v0.2.8:openbot/docker/delivery.env.example` 的原文（全旧名）跑 `bun test tests/config.test.ts`，行为不变、不多出警告。
- [ ] **Step 6：提交** `网页与运维文字：通知 tag、DOM 名、控制台、启动报错与 --help 只写新名`。度量：
  - 删除白名单条目 `learning-next.tsx`、`computer-view.tsx`、`openbot-version.tsx`、`show.ts` 的 `openbot-${channelId}`、`stopped-turn.ts`，共 5 条；
  - `operator-visible` 降到只剩附录 A 卡住的条目；
  - `web` 词表删掉 `openbot-learned-`、`openbot-secret`、`openbot-version`、`OpenBot`（若再无其他出现）；
  - `image-logs` 词数下降。

### Task 9：发到浏览器的错误码改新名（L1-8）

**建议执行模型**：opus　**评审方式**：sonnet 一轮

网页（`app/src`）不按错误码分支（`git grep OPENBOT_MODEL -- app/src` 为空），所以浏览器端不需要双认。服务器内部的读取方（`server/src/desktop-connection-failure.ts`、`agents/plan-model.ts`）读的是映射之前的码，不变。发送方（Python 框架、上游 `toolkit`、`provider-refusal.ts`、`provider-error.ts`、`learning/remote.ts`、`threads/postgres-runner.ts`）**不改**。

**文件：**
- 新建：`openbot/server/src/wire-codes.ts`
- 修改：`openbot/server/src/copilot.ts`：每个交给 CopilotRuntime 的 agent，事件流套一层 `withBrowserWireCodes`。构造点多于一个时，抽成一个包装函数，每个构造点一次调用。
- 测试（新建）：`openbot/server/tests/wire-codes.test.ts`（登记 `server-tests.list.txt`）

**接口：**
- ```ts
  export const BROWSER_CODE_SUFFIXES: readonly string[]; // 只列规格 2.6 节第二类的后缀：MODEL_AUTH_REQUIRED、MODEL_REFUSED、MODEL_BILLING、PROVIDER_REQUEST_REFUSED、LEARNED_SKILLS_ERROR、AP_LOCAL_STREAM_ERROR、AP_LOCAL_TERMINAL_MISSING、HARNESS_START_FAILED、HEADLESS_TOOL_ERROR、TOOL_LIMIT_EXCEEDED
  export function browserWireCode(code: string): string; // LEGACY_PREFIX + 后缀 → NEW_PREFIX + 后缀；不在表里的原样返回
  export function withBrowserWireCodes<T extends { type: string; code?: string }>(events: Observable<T>): Observable<T>; // 只改 RUN_ERROR 的 code
  ```
- 前缀不在 `wire-codes.ts` 里拼写：给 `shared/env-aliases.ts:1-2` 已有的 `NEW_PREFIX`、`LEGACY_PREFIX` 加上 `export`，从那里导入。这样那一行原文不变，Task 2 为它建立的条目继续命中，`wire-codes.ts` 不需要新条目。
- 加密版本名（`OPENBOT_APPROVAL_EXACT_*` 等）不在表里，永远原样。
- Task 2 为这些码建立的 `peer-protocol` / `rewrite` 条目（发送方文件里的），因为发送方不改，改为 `peer-protocol` / `keep`，`reason` 写「对端发送，服务器出口改名（Task 9）」。

- [ ] **Step 1：写失败测试** `wire-codes.test.ts`：
  - `each listed code maps to XIONGBAO_`
  - `an unlisted code and an approval version string pass unchanged`
  - `only RUN_ERROR events are touched`
  - `the runtime stream a browser reads carries XIONGBAO_MODEL_AUTH_REQUIRED when the agent sent the old code`：用 `copilot.ts` 现有测试的同一套假 agent 搭起来，断言浏览器收到的事件里是新码。
- [ ] **Step 2：运行**，预期失败。
- [ ] **Step 3：实现。** 冲突检查：`server/tests/desktop-connection-failure.test.ts:55`、`learning-model-endpoint.test.ts:325` 给的是**输入**，读取方在映射之前，照常通过。若某个已有测试断言浏览器侧收到旧码，追加到附录 A。
- [ ] **Step 4：运行**新测试、`desktop-connection-failure.test.ts`、`learning-model-endpoint.test.ts`、`copilot*.test.ts`；server tsc。
- [ ] **Step 5：提交** `服务器：发往浏览器的错误码改为 XIONGBAO_*，对端照旧发旧码`。度量：`server/src` 里 `peer-protocol` / `rewrite` 条目降到 0；`web` 词表不变（网页本来就不含这些码）。

### Task 10：镜像瘦身、构建标识、标签、发布清单（R4-A、L1-11～L1-13）

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**文件：**
- 修改：`openbot/Dockerfile:196-201`：运行镜像不带 `server/tests`、`server/docs`、`server/tsconfig.tests.json`、`shared/**/*.test.ts`、`toolkit/tests`、`agent-computer/src/**/*.test.ts`、`examples` 里非租户包的目录。做法：在 `deps` 之后加一个 `runtime-src` 阶段，用 `COPY` 拿全目录，再 `RUN find … -delete`；运行阶段从它 `COPY`。删掉的每一类都有一条理由注释。
- 修改：`openbot/Dockerfile:385-394`：`ARG`/`ENV OPENBOT_BUILD_*` 改为 `XIONGBAO_BUILD_*`（L1-11）。别名会抄回旧名，服务器读法不变。
- 修改：`.github/workflows/release.yml`：
  - 构建参数改用 `XIONGBAO_BUILD_*`；
  - `labels`（`:142-145`、`:177-179`）加 `org.opencontainers.image.title=<产品名>`、`org.opencontainers.image.vendor=<公司名>`，值由一步 `bun -e` 从 `openbot/examples/xiongbao/brand.yaml` 读出（`product_name`、`company_name`）；
  - **去掉** `org.opencontainers.image.source`（用户决定第 1 条）；`revision`、`version` 保留（`verify-digest` 读 `revision`）；
  - `container-images.json`（`:345-360`）同时写 `images.xiongbao` 和 `images.openbot`，内容相同（L1-13）。Task 17 再让 `images.xiongbao` 指向自有仓库。
- 修改：`openbot/app/tests/brand-artifacts/image-files.json`、`image-config.json`：删掉消失的词。
- 测试：
  - `openbot/scripts/ci/device-release-workflow.test.mjs` 加 `release labels carry title and vendor, not the repository`、`container-images.json carries images.xiongbao alongside images.openbot`。
  - 新建 `openbot/server/tests/dockerfile-runtime-tree.test.ts`（登记）：`Dockerfile` 运行阶段不再整目录 `COPY server server`；`ARG XIONGBAO_BUILD_VERSION` 存在，`ARG OPENBOT_BUILD_` 不存在。

- [ ] **Step 1：写失败测试**（上面三处），运行，预期失败。
- [ ] **Step 2：实现。** 冲突检查：`server/tests/release-status.test.ts`、`onboarding-routes.test.ts` 对 `OPENBOT_BUILD_*` 是**输入**，别名下照常通过；`tests/promote-kubernetes*.test.ts` 读 `images.openbot`，保留旧键所以照常通过。
- [ ] **Step 3：** 本地 `docker build -f Dockerfile -t openbot:trackb .`，再跑 `sh docker/tests/env-aliases.test.sh`、`bash scripts/ci/per-bot-users-smoke.sh openbot:trackb`、`bash scripts/ci/image-smoke.sh openbot:trackb`，全部通过。迁移和 `server/recovery/` 照常执行（`image-smoke.sh` 覆盖）。
- [ ] **Step 4：** 推送后 `image` job 全过。
- [ ] **Step 5：提交** `镜像：不带测试与文档，构建标识改 XIONGBAO_BUILD_*，标签加名称与厂商、去掉仓库地址，发布清单加 images.xiongbao`。度量：
  - `image-files` 词表里 `/app/server/tests/**` 一类的路径词全部删除（规格 2.1 节：`server/tests` 3 637 行），PR 说明给出删前删后的词数；
  - `image-config` 删掉 `OPENBOT_BUILD_VERSION`、`OPENBOT_BUILD_COMMIT`、`OPENBOT_BUILD_DISTRIBUTION_ID`、`OPENBOT_BUILD_REPOSITORY`、`OPENBOT_BUILD_CHANNEL` 五个词；
  - 预算 `env-name/Dockerfile` 下降。

### Task 11：镜像兼容：`xiongbao-apt` 与默认值文件（L1-9、L1-10）

**建议执行模型**：opus　**评审方式**：完整评审（sudoers、RLS 默认值）

**文件：**
- `git mv openbot/docker/openbot-apt openbot/docker/xiongbao-apt`；用法提示（原 `:5-6,43-44`）改写 `sudo xiongbao-apt`。
- 修改：`openbot/Dockerfile:279-287`：
  - 装 `/usr/local/sbin/xiongbao-apt`；
  - `/usr/local/sbin/openbot-apt` 做成指向它的符号链接；
  - sudoers 两条都放行：`pwuser ALL=(root) NOPASSWD: /usr/local/sbin/xiongbao-apt, /usr/local/sbin/openbot-apt`；
  - `visudo -cf` 照旧。
- 新建：`openbot/docker/defaults.env`，内容三行：`RLS_ENFORCE=refuse`、`SELF_HOST_BANNER=false`、`IN_CONTAINER=true`（后缀，不带前缀）。
- 修改：`openbot/docker/s6/scripts/env-aliases.sh`：在抄名字**之前**，对 `defaults.env` 的每个后缀 `X` 检查：`/run/s6/container_environment/XIONGBAO_X` 与 `OPENBOT_X` 都不存在，才写 `XIONGBAO_X`。然后照旧抄成 `OPENBOT_X`。
- 修改：`openbot/Dockerfile`：删掉 `ENV OPENBOT_SELF_HOST_BANNER=false`（`:227`）、`ENV OPENBOT_RLS_ENFORCE=refuse`（`:381`）、`ENV OPENBOT_IN_CONTAINER=true`（`:400`）；`COPY docker/defaults.env /etc/xiongbao/defaults.env`。
  - `COPILOTKIT_TELEMETRY_DISABLED=1`（`:404`）**不动**：`server/tests/brand-third-party.test.ts:192` 断言 Dockerfile 里有这行 ENV，见附录 A 第 7 行。
- 修改：`openbot/docker/tests/env-aliases.test.sh`：**只追加**用例，已有用例和断言不动。
- 修改：`openbot/docker/tests/xb-bot.test.sh`：**只追加**对 `xiongbao-apt` 的同样四条检查；原有对 `openbot-apt` 的检查不动（它们照常通过，正好证明旧路径仍能用）。

**接口：**
- 默认值文件格式：每行 `后缀=值`，`#` 起头的是注释。`env-aliases.sh` 读 `${XB_DEFAULTS_FILE:-/etc/xiongbao/defaults.env}`（变量只给测试用），文件不存在就跳过。
- 优先级（从高到低）：客户写的 `XIONGBAO_X` > 客户写的 `OPENBOT_X` > `defaults.env`。

- [ ] **Step 1：写失败测试**（追加到 `env-aliases.test.sh`）：
  - `only OPENBOT_RLS_ENFORCE=warn set: XIONGBAO_RLS_ENFORCE is not written, OPENBOT_RLS_ENFORCE stays warn`（审查重点 2）
  - `neither set: both become refuse`
  - `XIONGBAO_RLS_ENFORCE=warn set: stays warn, OPENBOT_ copied to warn`
  - `defaults.env missing: nothing written, no error`
- [ ] **Step 2：写失败测试**（追加到 `xb-bot.test.sh`）：`pwuser may sudo xiongbao-apt`、`employee A may not sudo xiongbao-apt`、`openbot-apt is a link to xiongbao-apt`、`sudoers grants an employee nothing`（已有，保持通过）。
- [ ] **Step 3：运行** `sh docker/tests/env-aliases.test.sh`，预期新用例失败。
- [ ] **Step 4：实现。** 冲突检查：`server/tests/config.test.ts`、`health.test.ts`、`request-trust.integration.test.ts`、`server-readiness-gates.test.ts` 里的 `OPENBOT_*` 都是**输入**，照常通过；`scripts/ci/image-smoke.sh:133` 只是注释。
- [ ] **Step 5：运行**：本地构建镜像；跑 `sh docker/tests/env-aliases.test.sh`、`docker run --rm --user root --entrypoint /bin/sh -v "$PWD/docker/tests:/t:ro" openbot:trackb /t/xb-bot.test.sh`、`image-smoke.sh`（就绪门照常拒绝没有 owner URL 的启动，证明 `refuse` 生效）。推送后 `image` job 全过。
- [ ] **Step 6：提交** `镜像：apt 助手改名 xiongbao-apt（旧路径保留为链接），默认值从 ENV 挪进最低优先级的 defaults.env`。度量：
  - `image-config` 删掉 `OPENBOT_SELF_HOST_BANNER`、`OPENBOT_RLS_ENFORCE`、`OPENBOT_IN_CONTAINER` 三个词；
  - `image-files` 的 `openbot-apt` 改为 `legacy-compat`（`introducedIn` 按全局约束）；
  - Dockerfile 的 `openbot-apt` 白名单条目改为 `legacy-compat`。

### Task 12：Bot 浏览器与终端痕迹（L1-16、L1-17）

**建议执行模型**：opus　**评审方式**：完整评审（遮罩属性关系到密码是否泄露）

**文件：**
- 修改：`agent-computer/src/secret-masking.ts:35,41`：`data-openbot-secret` → `data-xb-secret`，`data-openbot-person-filled` → `data-xb-person-filled`。
- 修改：`agent-computer/src/sign-in.ts:53`：`data-openbot-login` → `data-xb-login`。
- 修改：`agent-computer/src/live-shell.ts:420`：临时目录 `.openbot-shell-` → `.xiongbao-shell-`。`__openbot_prompt`（`:209-220`）和 `shell.ts:1030` 的 `$openbotOut` 被已有断言卡住，见附录 A 第 8 行。
- 修改：`agent-computer/src/session-cookies.ts:28`：新文件名 `xiongbao-session-cookies.json`。读时新文件不存在而旧文件存在，就改名过去（双认，磁盘文件按规格 4.2 节「启动时一次性改名」）。导出 `LEGACY_SESSION_COOKIES_FILE`。
- `runner/src/browser.ts:120` 的 `data-openbot-secret` **不改**：`server/tests/runner-browser.test.ts:450` 断言遮罩选择器里有它，见附录 A 第 9 行。runner 和 agent-computer 各自写、各自读，两边可以不同步。
- 测试（新建）：`openbot/agent-computer/tests/neutral-page-marks.test.ts`、`openbot/agent-computer/tests/session-cookies-rename.test.ts`

**接口：**
- `secret-masking.ts` 的导出名 `SECRET_ATTRIBUTE`、`PERSON_FILLED_ATTRIBUTE` 不变，只改值。所有读取方必须经这两个常量，不得再拼字面量（`git grep -n 'data-openbot-' agent-computer/src` 应为空）。
- `session-cookies.ts`：`migrateSessionCookiesFile(dir: string): void`，在第一次读之前调用。改名失败（只读卷）时退回读旧文件，不抛错。

- [ ] **Step 1：写失败测试** `neutral-page-marks.test.ts`：
  - `the page mark names carry no product name`：`SECRET_ATTRIBUTE` 为 `data-xb-secret`；三个属性名都不匹配 `/openbot|xiongbao/i`。
  - `a password field is still masked in the snapshot and the screenshot after the rename`（审查重点 1）：用 agent-computer 现有的遮罩测试同一套假页面，断言快照文字里密码框值被打码，截图遮罩选择器含 `[data-xb-secret]`。
  - `no source spells a data-openbot- attribute`：`agent-computer/src` 下 grep 为空。
- [ ] **Step 2：写失败测试** `session-cookies-rename.test.ts`：只有旧文件 → 改名后读到原内容；两个都有 → 用新的，旧的不动；目录只读 → 读旧文件，不抛错。
- [ ] **Step 3：运行** `cd openbot/agent-computer && bun test tests/neutral-page-marks.test.ts tests/session-cookies-rename.test.ts`，预期失败。
- [ ] **Step 4：实现**；冲突检查后跑 agent-computer 全部测试：`cd openbot/agent-computer && bun test`。
- [ ] **Step 5：提交** `Bot 浏览器：注入第三方网页的属性改中性名，登录态文件改名并兼容旧名`。度量：
  - 预算 `wire-dom/agent-computer/src` 降 3 行；
  - 白名单里 `session-cookies.ts` 的条目改为 `legacy-compat`；
  - `image-files` 不变（路径在运行时卷里，不在镜像里）。

### Task 13：设备端（L1-19、L1-20）

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**文件：**
- 修改：`openbot/desktop-device/scripts/build-sidecar.ts:52-63`：`compileArgs` 加 `--minify`。构建在一个与品牌无关的临时工作目录里进行：把 `runner/`、`shared/` 和所需的 `node_modules` 用符号链接放到 `<tmp>/src/` 下，再从那里编译，让产物里的绝对路径不含 `openbot`。
  - 如果 Bun 跟随符号链接后仍写入真实路径，改用 `--define` 把 `__dirname` 相关常量定死。两种都不行就停下来，在 PR 说明里写清楚，只保留 `--minify`。
- 修改：`openbot/desktop-device/src-tauri/src/sidecar.rs:392-414,952-968`：先读 `XIONGBAO_RUNNER_BINARY` / `XIONGBAO_AGENT_DESKTOP_BINARY`，没有再读旧名。抽一个 `fn dev_override(new: &str, legacy: &str) -> Option<OsString>`。
- `runner/src/browser.ts:695` 的 `openbot-snapshots.sqlite`（L1-18）被 `server/tests/runner-browser.test.ts` 卡住，见附录 A 第 10 行。
- 修改：`openbot/app/tests/brand-artifacts/runner.json`、`deb.json`：删掉消失的词。
- 测试：`openbot/desktop-device/tests/build-sidecar.test.ts` **只追加** `compile args minify`；`sidecar.rs` 里照现有单测写法加 `dev_override_prefers_the_new_name`、`dev_override_falls_back_to_the_legacy_name`。

- [ ] **Step 1：写失败测试**，运行 `cd openbot/desktop-device && bun test tests/build-sidecar.test.ts` 和 `cd openbot/desktop-device/src-tauri && cargo test dev_override`，预期失败。
- [ ] **Step 2：实现。**
- [ ] **Step 3：运行**同上通过；本地编译一次 runner，跑 `bun scripts/brand/scan-artifact.ts --kind runner …`，不含构建机路径。
- [ ] **Step 4：** 推送后 `brand-artifacts`、`device-bundle-linux`、`device-bundle-windows`、`device-bundle-macos` 通过；runner 包测试（`runner/tests` 里的 `bun build --compile` 用例）通过。
- [ ] **Step 5：提交** `设备端：runner 打包压缩并去掉构建机路径，开发变量认 XIONGBAO_ 新名`。度量：
  - `runner` 词表删掉构建机路径词（含 `…/openbot/node_modules/…` 的 2 个）和 `shared/openbot-browser.ts` 注释词；PR 说明给出 `openbot` 出现次数的前后对比（规格 2.5 节基线：28 次）；
  - `deb` 词表同步下降。

### Task 14：录制扩展（L1-21～L1-23）

**建议执行模型**：opus　**评审方式**：sonnet 一轮

**文件：**
- 修改：`openbot/extension/scripts/build.ts:90-94`：内容脚本和 MAIN world 脚本不再挂全局名。Vite 库模式的 IIFE 要求 `name`，改为在 `rollupOptions.output` 里设 `extend: false`，并把入口包成不导出任何东西的自执行模块；或者在打包后去掉 `var <name>=` 前缀。以 Step 1 的测试为准。
- 修改：`extension/src/content/notice.ts:9`、`content/indicator.ts:42`：注册并创建 `xb-recorder-notice`、`xb-recorder-mark`。查找、移除时两个名字都查（老内容脚本还活在已打开的页面里）。导出 `NOTICE_TAGS = [NOTICE_TAG, LEGACY_NOTICE_TAG]`、`INDICATOR_TAGS`。
  - 已有测试 `extension/tests/content-port.test.ts:482,488` 断言新版本画出的是 `openbot-recorder-notice`，见附录 A 第 11 行。**在获批前，`NOTICE_TAG` 保持旧名**，只加「查找两个名字」的逻辑和新名常量；`indicator.ts` 没有冲突，直接用新名。
- 修改：`extension/src/main-world/network-hook.ts:44-45`：在 `globalThis` 上同时定义 `Symbol.for("xb.recorder.configure")` 和旧 Symbol；`background/network/fallback.ts:20,24` 先调新的，没有再调旧的。
- 修改：`extension/public/managed_schema.json`：加 `XiongbaoUrl`（描述同 `OpenBotUrl`）；`extension/src/shared/policy.ts:40`：新键优先，没有再读 `OpenBotUrl`。
  - `extension/tests/policy.test.ts:73` 的键列表只**追加** `"XiongbaoUrl"`（全局约束允许）。
- 测试（新建）：`openbot/extension/tests/no-page-globals.test.ts`、`openbot/extension/tests/recorder-marks-compat.test.ts`、`openbot/extension/tests/policy-new-key.test.ts`

- [ ] **Step 1：写失败测试**：
  - `no-page-globals.test.ts`：构建 `extension/dist` 后，`page-network.js`、`content.js` 在空 `window` 上执行，`Object.keys(window).filter((k) => /openbot|xiongbao|recorder/i.test(k))` 等于 `[]`（规格 R7 验收 ①）。
  - `recorder-marks-compat.test.ts`：页面里已有老脚本画的 `<openbot-recorder-mark>` 时，新脚本不再画第二个；停止时两种都移除；只有 `Symbol.for("openbot.recorder.configure")` 时 fallback 仍能配置。
  - `policy-new-key.test.ts`：只设 `XiongbaoUrl` → 用它；两个都设 → 用 `XiongbaoUrl`；只设 `OpenBotUrl` → 用它。
- [ ] **Step 2：运行** `cd openbot/extension && bun test`，新测试失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行** `cd openbot/extension && bun test` 全过；`bun run build` 后 `scan-artifact.ts --kind extension` 退出 0。
- [ ] **Step 5：提交** `录制扩展：不再往网页挂全局名，标记元素与 Symbol 改中性名并兼容旧名，策略键加 XiongbaoUrl`。度量：
  - `extension` 词表删掉 `OpenBotRecorderContent`、`OpenBotRecorderPageNetwork`；
  - 白名单 `indicator.ts` 的 `"openbot-recorder-mark"`、`network-hook.ts` 与 `fallback.ts` 的两个 Symbol 改为 `legacy-compat`；
  - `managed_schema.json` 的 `OpenBotUrl` 条目改为 `legacy-compat`。

### Task 15：R4b 服务器打包成单文件（验证任务）

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**前置**：Task 10 合入。**验证通过才切换；不通过就记录原因并停止，不做替代方案。**

**文件（只在验证通过时提交）：**
- 修改：`openbot/Dockerfile`：`app-build` 之后加 `server-bundle` 阶段，执行 `bun build server/src/index.ts --target=bun --minify --packages=external --outfile /out/server.js`；运行阶段只带 `server.js`、`server/drizzle/`、`server/recovery/`，以及按文件读取的其他目录（Step 1 列出）。s6 的 `api`、`migrate` 服务改为运行它。
- 修改：`openbot/docker/s6/s6-rc.d/api/run`、`migrate` 相关脚本（以 Step 1 的清单为准）。
- 修改：`openbot/app/tests/brand-artifacts/image-files.json`。

- [ ] **Step 1：列清单**：在 `server/src` 里 grep `readFileSync`、`readdirSync`、`import(`、`new URL(…, import.meta.url)`、`__dirname`、`import.meta.dir`，列出运行时按路径读取的文件和动态导入。`migrate.sh` 怎么调迁移，`recovery/` 怎么被读，也一并列出。清单写进 PR 说明。
- [ ] **Step 2：在分支上改 Dockerfile 并构建**；跑全部镜像检查：`env-aliases.test.sh`、`xb-bot.test.sh`、`per-bot-users-smoke.sh`、`image-smoke.sh`；在 CI 上跑 `image` job。
- [ ] **Step 3：判定**：
  - **全部通过**：进入 Step 4。
  - **任何一项失败**：停止。不提交 Dockerfile 改动，只提交一份结论：在本文件附录 B 写明失败的检查、报错原文、原因分析。提交 `R4b 验证：单文件打包未通过，记录原因`。任务结束。
- [ ] **Step 4：度量**：`image-files` 词表里 `/app/server/src/**` 的路径词全部删除；PR 说明给出 `/app` 下带上游字样的文件数前后对比（规格 R4b 验收）。
- [ ] **Step 5：提交** `镜像：服务器打包成单文件运行，不再带 TypeScript 源码`。

### Task 16：内部头第一步：agent-computer 双认（R8a）

**建议执行模型**：opus　**评审方式**：完整评审（`computer-token` 是鉴权头）

范围：`x-openbot-bot-id`、`x-openbot-person-id`、`x-openbot-computer-token`、`x-openbot-egress`（用户决定第 3 条）。这一版（N）只让**接收方** agent-computer 双认；服务器照旧发旧名。N+1 由 Task 20 让服务器改发新名。

**文件：**
- 新建：`openbot/agent-computer/src/wire-headers.ts`
- 修改：`agent-computer/src/index.ts:270,274`、`agent-computer/src/authorisation.ts:38`：改为经 `wire-headers.ts` 读取。
- 修改：`agent-computer/src/egress.ts:831,1015`：拒绝响应同时带 `x-xiongbao-egress: refused` 和 `x-openbot-egress: refused`（没有代码读它，只有 Bot 浏览器的开发者工具能看到；旧名要留着，`WIRE_HEADERS` 断言它存在）。
- 测试（新建）：`openbot/agent-computer/tests/wire-headers.test.ts`

**接口：**
- ```ts
  export const HEADER = { botId: "x-xiongbao-bot-id", personId: "x-xiongbao-person-id", computerToken: "x-xiongbao-computer-token", egress: "x-xiongbao-egress" } as const;
  export const LEGACY_HEADER = { botId: "x-openbot-bot-id", personId: "x-openbot-person-id", computerToken: "x-openbot-computer-token", egress: "x-openbot-egress" } as const;
  export function readWireHeader(headers: Headers, name: keyof typeof HEADER): string | undefined; // 新名非空就用新名，否则用旧名；都去首尾空白
  ```
- 令牌：`authorisation.ts` 用 `readWireHeader(headers, "computerToken")` 取值，再走**原有**的比较。两个头都有但值不同时，以新头为准，**不得**因为旧头匹配就放行。
- 白名单：`x-openbot-*` 由 `wire-dom` 规则抹掉，不在白名单里。本任务**不改预算**（旧名还在）。在 `LEGACY_HEADER` 一行上方写注释「legacy-compat：introducedIn <N>，removeIn <N+2>，Task 20/21」，Task 21 按它清理。

- [ ] **Step 1：写失败测试** `wire-headers.test.ts`：
  - `only the new header`、`only the old header`、`both, new wins`、`blank new falls back to old`
  - `a request with a wrong new token and a right old token is refused`（审查重点 5）
  - `egress refusal carries both header names`
- [ ] **Step 2：运行** `cd openbot/agent-computer && bun test tests/wire-headers.test.ts`，预期失败。
- [ ] **Step 3：实现。** 已有的 29 个带 `x-openbot-bot-id`、26 个带 `x-openbot-computer-token` 的测试都发**旧头**，双认下照常通过。
- [ ] **Step 4：运行** `cd openbot/agent-computer && bun test`；推送后 `image` job 的 `per-bot-users-smoke.sh` 通过（它发旧头）。
- [ ] **Step 5：提交** `agent-computer：内部请求头认 x-xiongbao-* 新名，旧名照收`。PR 说明写明：Task 20 的触发条件是「含本提交的正式版本已发布」。

---

## 阶段 D：分发切换

### Task 17：发布流水线接入自有渠道

**建议执行模型**：opus　**评审方式**：完整评审（推送凭据、发布物完整性）

**前置**：Task 10 合入。代码现在就写；Task U3 完成前，所有新步骤因变量未设而跳过，并在 summary 里写「未配置自有渠道」。

**文件：**
- 修改：`.github/workflows/release.yml`：
  - `promote` 之后加 job `mirror`：
    - 登录 `vars.XB_REGISTRY`；
    - 用 `crane copy <ghcr 引用>@<linux/amd64 清单 digest> <XB_REGISTRY>/<XB_IMAGE_REPOSITORY>:<tag>`，只拷平台清单，不拷 provenance、SBOM 附件（附件里有仓库地址和 `openbot` 包名）；
    - 输出自有仓库的 digest。
  - `github-release` 生成的 `container-images.json` 里，`images.xiongbao` 改为自有仓库的引用（变量未设时仍等于 `images.openbot`）。
  - 上传 `container-images.json`、`openbot/docker/delivery.env.example`、`openbot/docker/compose.delivery.yml` 到 `s3://<XB_DOWNLOAD_BUCKET>/<tag>/`（`aws s3 cp --endpoint-url "$XB_DOWNLOAD_ENDPOINT"`）。
- 修改：`.github/workflows/device-release.yml`：发布安装包后，同样上传到 `s3://<bucket>/<tag>/device/`。
- 修改：`.github/workflows/clean-deploy.yml:96,170`：变量已设时，`container-images.json` 和 `delivery.env.example` 从 `XB_DOWNLOAD_BASE_URL/<tag>/` 取，模拟客户；未设时照旧。同时把期望镜像的选取（现为第 97 行 `.images.openbot.reference`）和第 199–209 行「运行中的镜像及其仓库 digest 必须等于该引用」的核对改为：变量已设时读 `.images.xiongbao.reference`，并按自有仓库校验（不再要求是 GHCR）；未设时照旧读 `images.openbot`。否则镜像拷贝正确时验收也会因仓库不同而失败。
- 修改：`openbot/scripts/ci/device-release-workflow.test.mjs`：加测试。

**接口：**
- 变量与密钥名照 Task U3 Step 2。所有新步骤的 `if:` 写 `vars.XB_REGISTRY != ''`（下载页步骤写 `vars.XB_DOWNLOAD_BUCKET != ''`）。
- 新 actions 和工具一律钉提交 SHA 或固定版本（与现有 job 一致）；`crane` 用 `imjasonh/setup-crane` 的固定 SHA。
- 凭据只经 `env:` 传入，不写进命令行参数，不 `echo`。

- [ ] **Step 1：写失败测试**（`device-release-workflow.test.mjs`）：
  - `mirror copies only the platform manifest to our registry`：`mirror` job 的 `crane copy` 一步引用的是平台清单 digest 变量，不是 index digest；没有 `--all-tags`。
  - `our channel steps skip cleanly when unconfigured`：每个新步骤都有上面的 `if:`。
  - `credentials never appear on a command line`：新步骤的 `run` 里不出现 `secrets.`。
  - `clean-deploy fetches from our download page when configured`
  - `every action is pinned to a commit SHA`（已有，保持通过）。
- [ ] **Step 2：运行** `cd openbot/scripts/ci && bun test device-release-workflow.test.mjs`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行**通过；用 `release.yml` 的 `dry_run` 输入跑一次，新步骤跳过、summary 有提示。
- [ ] **Step 5：提交** `发布：镜像只拷平台清单到自有仓库，清单、样例、安装包上传自有下载页；干净部署按客户路径取`。
- [ ] **Step 6（Task U3 完成后）**：发一个 `-rc` 标签，核对：
  - 自有仓库里有镜像，`docker buildx imagetools inspect` 只有一个平台清单，没有附件；
  - 下载页上有这一版的三个文件和安装包；
  - `container-images.json` 的 `images.xiongbao.reference` 指向自有仓库；
  - `clean-deploy.yml` 通过。
  结果写进 PR 评论。

### Task 18：交付文档、样例、compose：新名与自有渠道（L1-14、L1-15）

**建议执行模型**：haiku　**评审方式**：无需单独评审

**前置**：Task 17 合入；Task U2 批准附录 A 第 12 行；Task U3 给出 `XB_DOWNLOAD_BASE_URL` 和镜像仓库地址。

**文件与取值**（照抄）：
- `openbot/docker/compose.delivery.yml:5,10`：`${XIONGBAO_IMAGE:-${OPENBOT_IMAGE:-xiongbao-digital-employee:local}}`、`127.0.0.1:${XIONGBAO_PORT:-${OPENBOT_PORT:-3772}}:3001`。
- `openbot/docker/delivery.env.example:1-9`：改成只写 `XIONGBAO_IMAGE`、`XIONGBAO_TAG`。删掉「旧前缀仍然可用」「例外：OPENBOT_IMAGE / OPENBOT_TAG」两句。镜像示例写 `<镜像仓库地址>/<XB_IMAGE_REPOSITORY>@sha256:<digest>`（地址取 U3 的回复）。`:26-32` 的 CopilotKit Intelligence 介绍保留（第三方服务，属实）。
- `<根>/README.md` 部署段（约 `:60-90`）：
  - `OPENBOT_TAG` → `XIONGBAO_TAG`，`OPENBOT_IMAGE` → `XIONGBAO_IMAGE`；
  - `raw.githubusercontent.com/canquedehuiyi-cpu/xiongbaowork/$OPENBOT_TAG/openbot/docker/delivery.env.example` → `$XB_DOWNLOAD_BASE_URL/$XIONGBAO_TAG/delivery.env.example`（写成 U3 给的实际地址）；
  - `ghcr.io/canquedehuiyi-cpu/xiongbaowork` → 自有仓库地址。
- `openbot/docs/deployment-xiongbao.md`：
  - `:3,30,35,41-43,112,117,218,225-237,254` 同上替换；
  - `jq -r .images.openbot.reference` → `jq -r .images.xiongbao.reference`；
  - `gh release download …`、`gh attestation verify … -R canquedehuiyi-cpu/xiongbaowork` 改成从下载页 `curl` 取，删掉 attestation 一段（客户看不到仓库）；
  - 只写 `XIONGBAO_*`，不写「旧名仍可用」。
- `openbot/docs/development-environment-xiongbao.md`：10 处 `OPENBOT_` → `XIONGBAO_`。
- 新建：`openbot/docs/operator-migration-xiongbao.md`：只给我们自己的运维，写「旧名 `OPENBOT_*` 永久可用」「不能回退到 v0.2.9 之前，或回退前把 `XIONGBAO_` 改回 `OPENBOT_`」（规格 4.4 节）。它不在 H 扫描范围（文件名不是客户文档清单里的）。
- 修改：`openbot/scripts/ci/manual-blocks.test.mjs:243-283,312,430-452`：只按附录 A 第 12 行获批的内容改期望值（新名、新地址），不删断言。
- 修改：`openbot/app/tests/brand-artifacts/docs.json`：删掉消失的词。

- [ ] **Step 1**：照上表替换。
- [ ] **Step 2：运行** `cd openbot/scripts/ci && bun test manual-blocks.test.mjs`、`cd openbot/app && bun test tests/brand-docs.test.ts`，通过。
- [ ] **Step 3**：照新 README 在一台干净机器（或 `clean-deploy.yml`）上走一遍部署（规格 R4 验收 ④）。
- [ ] **Step 4：提交** `交付文档：只写 XIONGBAO_ 新名，镜像与样例改从自有渠道取`。度量：`docs` 词表删掉所有 `OPENBOT_*` 词、`raw.githubusercontent.com/…/openbot/…`、`images.openbot`；剩下的只有 `third-party-name`。

### Task U4（需要用户）：京东云部署脚本下载地址切换窗口

**前置**：Task 17、18 合入；自有渠道上已经发布过一个正式版本（Task 17 Step 6 用正式标签再走一次）。

- [ ] **Step 1（用户）**：和京东云现场约一个切换窗口（不在业务高峰）。
- [ ] **Step 2（用户）**：在窗口内，把京东云现有部署脚本里的三个地址换成自有渠道：
  - 镜像引用（`ghcr.io/…` → 自有仓库）；
  - `container-images.json` 的下载地址（GitHub Release → 下载页）；
  - `delivery.env.example` 的下载地址（`raw.githubusercontent.com` → 下载页）。
  `.env.delivery` 本身一个字不用改（旧名永久可用）。
- [ ] **Step 3（用户）**：按新脚本重拉一次当前版本，确认能启动、能登录、老数据都在。
- [ ] **Step 4（用户）**：如果还有别的客户或环境从 GitHub 拉，逐个同样切换。全部切完后回复「切换完成」。

### Task U5（需要用户）：仓库改为私有

**前置**：Task U4 回复「切换完成」。

- [ ] **Step 1（用户）**：确认 GitHub Actions 在私有仓库下的分钟数够用（私有仓库按分钟计费）。
- [ ] **Step 2（用户）**：仓库 Settings → General → Danger Zone → Change visibility → Private。
- [ ] **Step 3（用户）**：GitHub → Packages → 本仓库的容器镜像 → Package settings，把可见性改为 Private（客户已改从自有仓库拉）。
- [ ] **Step 4**（执行者，用户改完后）：重新跑一次 `ci.yml`、`release.yml` 的 `dry_run`、`clean-deploy.yml`，确认在私有仓库下都通过。上游同步点的 `git fetch`（Task 3）走的是公开的上游仓库，不受影响。结果写进本文件附录 B。

---

## 阶段 E：获批之后与后续

### Task 19：落地获批的断言冲突项

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**前置**：Task U2 对附录 A 的某几行回复「批准」，并且那一行对应的原任务已经合入。可以分批做，每批一个 PR。附录 A 第 12 行由 Task 18 处理，不在这里。

**文件**：附录 A 每个批准行的「源码」列和「已有断言」列。

**每一行的做法：**
- 第 1 行：`readMigrated` 改为复制不删（规格 4.3 节）。`app/index.html` 内联脚本同步改。
- 第 2–4 行：照 Task 8 L1-3 改名。通知 tag：`xiongbao-attention-*`、`xiongbao-ping-*`；`data-orb="xiongbao"`；CSS 类 `.xiongbao-markdown`、`.xiongbao-breakdown`（`styles.css`、`a2ui-markdown.tsx`、`a2ui-breakdown.tsx` 一起改）。
- 第 5、6 行：照 Task 8 L1-5、L1-6 改写。
- 第 7 行：`COPILOTKIT_TELEMETRY_DISABLED=1` 挪进 `docker/defaults.env`（照 Task 11，第三方变量名不加前缀，`env-aliases.sh` 对它单独处理：没设才写）。
- 第 8 行：`__openbot_prompt` → `__xiongbao_prompt`；`$openbotOut`、`$openbotErr`、`$openbotCommandSucceeded`、`$openbotCommandExit` → `$xbOut`、`$xbErr`、`$xbCommandSucceeded`、`$xbCommandExit`。
- 第 9 行：runner `data-openbot-secret` → `data-xb-secret`（runner 自己写、自己读）。
- 第 10 行：runner `openbot-snapshots.sqlite` → `xiongbao-snapshots.sqlite`，启动时一次性改名。不能只照 `migrateSessionCookiesFile` 改主文件：`runner/src/browser.ts` 开了 WAL，上次非正常退出时已提交的计数可能还在 `-wal` 里。做法：新文件不存在且旧文件存在时，先以独占方式打开旧库执行 `PRAGMA wal_checkpoint(TRUNCATE)` 并关闭，确认没有残留的 `-wal`/`-shm` 后再改名；改名失败照旧读旧名。测试加一条「旧库带未 checkpoint 的 WAL 时升级不丢计数」，不只测干净关闭的库。条目改为 `legacy-compat`，并加 `"device": true`。（控制者裁定：旧库先 checkpoint 后改为「复制」而不是改名，旧文件保留，N−1 回退时仍能读到；旧文件存在期间每次发号双写，打开取两边较大值；到期随 legacy-compat 条目一并删除（Task 21）；见规格 4.4）
- 第 11 行：扩展 `NOTICE_TAG` 改为 `xb-recorder-notice`。
- 新追加的行：按该行「要改成」一列。

**测试**：每一行把已有断言的期望值改成获批的新值，只改值，断言个数和种类不变；再加一条「旧值仍被认得」的用例（适用于双认项）。

- [ ] **Step 1**：按批准的行改断言期望值，运行，确认失败。
- [ ] **Step 2**：改源码。
- [ ] **Step 3**：运行相关包的全部测试、护栏、产物扫描。
- [ ] **Step 4：提交** `落地获批改名：<行号列表>`。提交说明逐行列出被改的已有断言（文件:行，旧期望 → 新期望）。度量：每行对应的白名单条目删除，或改为 `legacy-compat`；产物词表删掉对应的词。

### Task U6（需要用户）：手工验收

**前置**：对应任务合入并发布到可以试用的环境。每一项可以单独做。

- [ ] **Task 7**：用 v0.2.9 打开过的浏览器升级后，主题、侧栏、教学提示、语音草稿都还在；开发者工具「应用」页只多出 `xiongbao*` 键，旧键仍在。再回退到 v0.2.9，偏好仍在（规格 R2 验收 ②③）。
- [ ] **Task 8、11**：用京东云 `.env.delivery` 原文（全旧名）启动新镜像，行为与之前一致，不多出警告；`.env.delivery` 里写 `OPENBOT_RLS_ENFORCE=warn` 时生效（规格 R3 验收 ②、R4 验收 ②）。
- [ ] **Task 11**：在 Bot 终端里 `sudo openbot-apt install jq` 与 `sudo xiongbao-apt install jq` 都能用（规格 R4 验收 ③）。
- [ ] **Task 12**：打开任意网站，页面 DOM 里查不到 `openbot`；升级前存的网站登录态升级后仍有效（规格 R5 验收）。
- [ ] **Task 13**：从 v0.2.9 设备端直接升级，能连上服务器；`xiongbao-runner --help` 没有上游字样（规格 R6 验收 ②③）。
- [ ] **Task 14**：
  - 在任意网页的控制台里 `Object.keys(window).filter(k => /openbot/i.test(k))` 为空；
  - 用旧策略键 `OpenBotUrl` 配置的企业浏览器，升级扩展后仍连得上；
  - 录制中途扩展自动更新，标记元素不重复、不残留（规格 R7 验收）。
  - 新版扩展发布到商店由用户操作。
- [ ] **Task 20**：混跑验收见 Task 20 Step 5。
- [ ] 每项回复「通过」或列出问题。

### Task 20：内部头第二步：服务器改发新名（R8b）

**建议执行模型**：opus　**评审方式**：完整评审

**触发条件**：含 Task 16 的正式版本（N）已经发布（`git tag -l 'v*'` 里有，不算 `-rc`）。本任务进入 N+1。

**文件：**
- 修改：`server/src/computer/client.ts:264-265,314`、`computer/provider.ts:209-211,237`、`computer/policy-network.ts:108,221-223`、`browser/routes.ts:470`：改发 `x-xiongbao-*`，头名从 fork 自有的 `shared/wire-headers.ts` 取（把 Task 16 的常量挪到 `shared/`，agent-computer 改为从这里导入）。
- 修改：`scripts/ci/per-bot-users-smoke.sh:47`：**不改**（它发旧头，正好验证 agent-computer 仍收旧头）。只追加一组发新头的同样检查。
- 修改：`openbot/app/tests/brand-budget.json`：`wire-dom/server/src` 下降。

- [ ] **Step 1：写失败测试**：服务器侧（`server/tests/computer-gateway.test.ts` 同类的新文件，登记）断言发出的是 `x-xiongbao-bot-id` 等新头，不再带旧头。冲突检查：`server/tests/bot-browser-routes.integration.test.ts`、`browser-routes.integration.test.ts`、`computer-gateway.test.ts` 若断言服务器**发出**旧头，追加到附录 A，等批准；获批前本任务停在这里。
- [ ] **Step 2：实现。**
- [ ] **Step 3：运行** server 相关测试、agent-computer 全部测试；本地镜像跑 `per-bot-users-smoke.sh`（旧头）和新追加的新头检查。
- [ ] **Step 4：混跑**（审查重点 5，规格 R8 验收）：用 Helm/组件镜像方式各起一次，跑 `per-bot-users-smoke.sh`：
  - 新服务器（本分支）+ 旧 agent-computer（N 版镜像）；
  - 旧服务器（N 版）+ 新 agent-computer（本分支）。
  两种都要通过。单镜像由 `image` job 覆盖。
- [ ] **Step 5：提交** `服务器：内部请求头改发 x-xiongbao-*`。度量：预算 `wire-dom/server/src` 降 8 行（`client.ts` 3、`provider.ts` 3、`policy-network.ts` 3 中的发送行、`browser/routes.ts` 1，以实际为准）。

### Task U7（需要用户）：到期清理前的用户确认

**触发条件**：发版 PR 上 `brand-expiry.test.ts` 的「no legacy-compat entry is past its window」变红。

到期清理一定会删掉证明旧名可用的已有测试断言（例如旧 cookie 仍能登录、旧存储键仍被读）。按全局约束，这需要用户逐次批准。

- [ ] **Step 1（用户）**：看测试列出的到期条目，以及执行者列出的「将被删除的兼容断言」（文件:行）。回复「批准删除」或「推迟」。
- [ ] **Step 2（用户，只对 `device: true` 的条目）**：确认客户那边已经没有低于 N+1 的设备端在用（服务器不记设备版本，只能由用户问现场）。
  - 确认没有 → 回复「设备已全部升级」。
  - 还有 → 回复「推迟到 X.Y.Z」。执行者把该条的 `notBefore` 设成那个版本，`reason` 写上日期和用户原话。
- [ ] **Step 3（用户，只对内部头）**：Task 21 删除 `x-openbot-bot-id`、`x-openbot-computer-token`、`x-openbot-egress` 的读取会让 `brand-leak.test.ts` 的 `WIRE_HEADERS` 断言失败。批准时要同时批准：把这三个从 `WIRE_HEADERS` 断言里**拿掉**；或者不批，让这三个旧名的读取永久保留。

### Task 21：到期清理（N+2，每次发版）

**建议执行模型**：sonnet　**评审方式**：无需单独评审

**触发条件**：发版 PR（`openbot/package.json` 的 `version` 升了，CHANGELOG 加了新的 `## X.Y.Z`）上，`brand-expiry.test.ts` 列出到期条目。并且 Task U7 已经对这些条目回复「批准删除」（设备条目还要有「设备已全部升级」）。

**第一批预计**（`introducedIn: 0.2.9`，在 `0.2.11` 的发版 PR 上到期）：
- 组织登录 cookie 旧名（`server/src/auth/organization.ts:8-12,196,323,381`、`server/src/recorder/wiring.ts:209-210`）；
- `x-openbot-voice`、`x-openbot-dictation`（`server/src/browser-request-marker.ts:11`）；
- 表一的 7 个存储键（`readMigrated` 的调用点和 `app/index.html` 内联脚本）。

**文件**：到期条目的 `file`，以及读取旧名的兼容代码；对应的兼容测试（只删 U7 批准的断言）。

- [ ] **Step 1**：对每个到期条目，删掉读旧名的分支，删掉白名单条目；产物词表删掉对应的词。
- [ ] **Step 2**：删 U7 批准的兼容断言，提交说明逐条列出（文件:行）。
- [ ] **Step 3**：运行全部测试、护栏、`brand-artifacts`；`brand-expiry.test.ts` 转绿。
- [ ] **Step 4：提交** `到期清理：删除 <版本> 起双认的旧名（<条目数> 条）`。度量：白名单 `legacy-compat` 减去到期条数；`web` 等词表对应下降。

---

## 附录 A：已有断言冲突登记表

执行者发现新的冲突时，在表尾追加一行，并在 PR 说明里列出。用户在 Task U2 里逐行批准。

**批准记录**：第 1–12 行，用户 2026-11-12 批准；第 13–33 行，用户 2026-11-13 批准（原话「附录 A 第 13–33 行批准」）；第 34 行，用户 2026-11-13 批准（原话「附录 A 第 34 行批准」）；第 35 行，用户 2026-11-13 批准（原话「附录 A 第 35 行批准」）；第 36 行，用户 2026-11-13 批准（原话「附录 A 第 36 行批准」）。

**棘轮放行**：第 7、35 行获准的棘轮增长（预算新增一行、词表换词）以机器可读的形式记在 `openbot/scripts/brand/guard/ratchet-approvals.json`，每条必须写明所依据的已批准行（`appendixRow`），并且要与本分支的真实改动逐项相符（kind、key、from、to），对不上的条目算过期，棘轮报红。只有相对 ratchet base 新增的条目才生效；base 里已有的条目是惰性历史，既不放行也不算过期，由之后的清理 PR 一次性删除（删条目不算增长）。改 `ratchet-approvals.json` 必须在 PR 说明里列出新增的条目。

| # | 项 | 源码 | 已有断言（文件:行） | 要改成 | 处理任务 |
|---|---|---|---|---|---|
| 1 | `readMigrated` 复制不删（规格 4.3） | `app/src/lib/storage-migrate.ts:21-22`、`app/index.html:14-29` | `app/tests/storage-migrate.test.ts`「only the legacy key present…legacy key removed」：`[...storage.data]` 精确等于 `[["xiongbao-theme","dark"]]` | 等于 `[["openbot-theme","dark"],["xiongbao-theme","dark"]]`（按插入顺序） | 19 |
| 2 | `data-orb` | `app/src/components/onboarding/demo-orb.tsx:27` | `app/tests/onboarding-name-step.test.tsx:192` `toBe("openbot")` | `toBe("xiongbao")` | 19 |
| 3 | 通知 tag | `app/src/components/bot-profile/attention.tsx` | `app/tests/bots-nav-badge.test.tsx:196,289,314,349`；`app/tests/desktop-notify-prompt.test.tsx`（`openbot-attention-`） | `xiongbao-attention-*`、`xiongbao-ping-*` | 19 |
| 4 | CSS 类 | `app/src/styles.css`、`lib/copilot/a2ui-markdown.tsx`、`a2ui-breakdown.tsx` | `app/tests/a2ui-markdown.test.tsx:396`（选择器含 `.openbot-markdown`） | `.xiongbao-markdown` | 19 |
| 5 | 「旧名仍可用」提示 | `app/src/components/manage/plugin-page.tsx:1417` | `app/tests/brand-web-copy.test.tsx:45` `toContain("XIONGBAO_PUBLIC_URL（旧名 OPENBOT_PUBLIC_URL 仍可用）")` | `toContain("XIONGBAO_PUBLIC_URL")`，并断言不含「旧名」 | 19 |
| 6 | 运维报错文字 | `server/src/config.ts:613`、`server/src/browser/routes.ts:286` 等 | `server/tests/arcade-config.test.ts`（`OPENBOT_BROKER_PROVIDER 只能…`）；`server/tests/browser-routes.integration.test.ts`（`This OpenBot has no address`、`Set OPENBOT_PUBLIC_URL`） | 新文字（`XIONGBAO_*`、产品名） | 19 |
| 7 | 第三方遥测开关挪出 ENV | `openbot/Dockerfile:404` | `server/tests/brand-third-party.test.ts:192` `toMatch(/^ENV COPILOTKIT_TELEMETRY_DISABLED=1$/m)` | 断言 `docker/defaults.env` 含 `COPILOTKIT_TELEMETRY_DISABLED=1` | 19 |
| 8 | Bot 终端变量名 | `agent-computer/src/live-shell.ts:209-220`、`agent-computer/src/shell.ts:1030` | `agent-computer/tests/live-shell-command.test.ts:55` `toContain("__openbot_prompt")`；`agent-computer/tests/shell.test.ts:128` `toContain("[Console]::SetOut($openbotOut)")` | `__xiongbao_prompt`；`$xbOut` | 19 |
| 9 | runner 遮罩属性（审查更正：runner 只读不写该属性，改名不影响 runner 遮罩） | `runner/src/browser.ts:120` | `server/tests/runner-browser.test.ts:450`（遮罩选择器含 `[data-openbot-secret]`） | `[data-xb-secret]` | 19 |
| 10 | runner 快照计数文件 | `runner/src/browser.ts:695` | `server/tests/runner-browser.test.ts:37,713,786-856`（`COUNTER_FILE = "openbot-snapshots.sqlite"`） | `xiongbao-snapshots.sqlite`，另加「旧文件被改名」用例 | 19 |
| 11 | 扩展提示元素 | `extension/src/content/notice.ts:9` | `extension/tests/content-port.test.ts:482,488` `querySelector("openbot-recorder-notice")` | `xb-recorder-notice` | 19 |
| 12 | 交付文档、样例、compose 的旧名与仓库地址 | `<根>/README.md`、`docs/deployment-xiongbao.md`、`docker/delivery.env.example`、`docker/compose.delivery.yml` | `scripts/ci/manual-blocks.test.mjs:243-283,312,430-452`（`$OPENBOT_TAG`、`$OPENBOT_IMAGE`、`raw.githubusercontent.com/…`、`.images.openbot.reference`、`gh attestation verify … -R canquedehuiyi-cpu/xiongbaowork`、`image: ${OPENBOT_IMAGE:-`、`IMAGE = "ghcr.io/…"`） | Task 18 列出的新名与自有渠道地址 | 18 |
| 13 | 默认皮肤 id `openbot` 改为 `xiongbao`（L1-2，Task 7 发现） | `shared/user-preferences.ts`（`SKIN_IDS`、`DEFAULT_SKIN`，经 `DEFAULT_USER_PREFERENCES` 成为服务器应答的默认值）、`server/src/user-preferences.ts`、`server/src/user-preferences-routes.ts`、`app/src/skins/registry.ts:12-21`、`app/index.html:30` | `server/tests/user-preferences-routes.test.ts:58,72,81,140,149,170,214`（GET/PATCH 应答 `toEqual` 含默认 `skin: "openbot"`）；`server/tests/user-preferences.integration.test.ts:53,60,67,76,122,153`（`store.read`/`patch` 的默认 `skin: "openbot"`；「a stored skin this build does not ship reads as the default」`toBe("openbot")`） | 默认值改为 `"xiongbao"`；另加「库里存的 `openbot` 读出为 `xiongbao`」「PATCH `skin: "openbot"` 存为 `xiongbao`」用例；然后落地 Task 7 简报的皮肤部分（`normalizeSkinId`、`skin-compat.test.ts`、白名单皮肤 5 条：4 条删除、1 条缩成 `"openbot"` 进映射） | 19 |
| 14 | Task 8 发现（原 C1） | `app/src/lib/notifications/show.ts:21`（`conversationTag`） | `app/tests/component-reply-notice.test.tsx:579,592,612,647` `tag: \`openbot-${channel.id}\`` | `xiongbao-${channel.id}` | 19 |
| 15 | Task 8 发现（原 C2） | `server/src/config.ts:742`（单用户 + 公网地址） | `server/tests/config.test.ts:625,655,672` `toThrow("OPENBOT_SINGLE_USER")` | `toThrow("XIONGBAO_SINGLE_USER")` | 19 |
| 16 | Task 8 发现（原 C3） | `server/src/auth/dev-actor.ts:158`、`config.ts:1968`（个人版缺单用户） | `server/tests/config.test.ts:1523` `toThrow("OPENBOT_SINGLE_USER=true")` | `XIONGBAO_SINGLE_USER=true` | 19 |
| 17 | Task 8 发现（原 C4） | `server/src/edition.ts:79` | `server/tests/config.test.ts:1518` `/OPENBOT_EDITION.*"team".*"personal"/` | `/XIONGBAO_EDITION.*…/` | 19 |
| 18 | Task 8 发现（原 C5） | `server/src/config.ts:1266` | `server/tests/entra-obo-config.test.ts:100` `…里有 OpenBot 自己的 client id` | 新产品名 | 19 |
| 19 | Task 8 发现（原 C6） | `server/src/config.ts:1476` | `server/tests/agent-on-this-machine.test.ts:38,376` `SETTING = "OPENBOT_THIS_MACHINE_HOST"`，`toThrow(SETTING)` | `XIONGBAO_THIS_MACHINE_HOST` | 19 |
| 20 | Task 8 发现（原 C7） | `server/src/config.ts:1809` | `server/tests/config-github-app.test.ts:81` 整句含 `OPENBOT_PUBLIC_URL` | `XIONGBAO_PUBLIC_URL` | 19 |
| 21 | Task 8 发现（原 C8） | `server/src/auth/role-writer-lifecycle.ts:27` | `server/tests/server-readiness-gates.test.ts:375` `toThrow("OPENBOT_RLS_ENFORCE")` | `XIONGBAO_RLS_ENFORCE` | 19 |
| 22 | Task 8 发现（原 C9） | `server/src/tenant-package.ts:497` | `server/tests/tenant-package.test.ts:433` `/person's OpenBot browser/` | 新文字 | 19 |
| 23 | Task 8 发现（原 C10） | `server/src/plugins/broker.ts:763` | `server/tests/composio-broker-seam.test.ts:99` `toContain("OPENBOT_APP_URL")` | `XIONGBAO_APP_URL` | 19 |
| 24 | Task 8 发现（原 C11） | `server/src/plugins/broker.ts:883` | `server/tests/provider-selection.test.ts:107,157` `OPENBOT_BROKER_PROVIDER=composio` / `=arcade` | `XIONGBAO_BROKER_PROVIDER=…` | 19 |
| 25 | Task 8 发现（原 C12） | `server/src/plugins/provider-wiring.ts:81` | `server/tests/provider-selection.test.ts:295` `/OPENBOT_BROKER_PROVIDER=arcade.*ARCADE_API_KEY/` | `XIONGBAO_BROKER_PROVIDER=…` | 19 |
| 26 | Task 8 发现（原 C13） | `server/src/plugins/provider-wiring.ts:160,162`（`storedProvider`） | `server/tests/provider-undecided.test.ts:71` `/OPENBOT_BROKER_PROVIDER/`；同函数 86 行（两把 key 都设）见 `provider-selection.test.ts` 同名用例 | `/XIONGBAO_BROKER_PROVIDER/` | 19 |
| 27 | Task 8 发现（原 C14） | `server/src/plugins/provider-wiring.ts:196` | `server/tests/arcade-verifier-notice.test.ts:57` `toContain("OPENBOT_PUBLIC_URL")` | `XIONGBAO_PUBLIC_URL` | 19 |
| 28 | Task 8 发现（原 C15） | `server/src/plugins/routes.ts:2344` | `server/tests/plugin-routes.test.ts:2186` `toContain("OPENBOT_APP_URL")` | `XIONGBAO_APP_URL` | 19 |
| 29 | Task 8 发现（原 C16） | `agent-computer/src/recorder.ts:53` | `agent-computer/tests/person-browser-rules.test.ts:101`、`person-browser.test.ts:349` `not a built OpenBot Recorder` | 新产品名 | 19 |
| 30 | Task 8 发现（原 C17） | `agent-computer/src/bot-browser-host.ts:87` | `agent-computer/tests/bot-browser-computer.test.ts:1017` `the OpenBot Recorder is not installed` | 新产品名 | 19 |
| 31 | Task 8 发现（原 C18） | `agent-computer/src/egress.ts:449` | `agent-computer/tests/egress-policy.test.ts:712` `which OpenBot never opens` | 新产品名 | 19 |
| 32 | Task 8 发现（原 C19） | `agent-computer/src/egress.ts:844,999`（`realm="OpenBot"`） | `agent-computer/tests/egress-policy.test.ts:291` `realm="openbot"` | `realm="xiongbao"` | 19 |
| 33 | Task 9 发现：浏览器收到的模型认证错误码 | `server/src/wire-codes.ts`（`BROWSER_CODE_SUFFIXES` 暂不含 `MODEL_AUTH_REQUIRED`） | `server/tests/provider-refusal.test.ts:583` `expect(failure.code).toBe("OPENBOT_MODEL_AUTH_REQUIRED")`（读的是 runtime 发给浏览器的流） | `XIONGBAO_MODEL_AUTH_REQUIRED`，并把该后缀加回映射表、补回原名测试 `…carries XIONGBAO_MODEL_AUTH_REQUIRED…` | 19 |
| 34 | Task 11 发现：apt 助手源文件改名 | `openbot/docker/xiongbao-apt`（原 `docker/openbot-apt`，已 `git mv`）；仓库里暂留 `docker/openbot-apt` → `xiongbao-apt` 的符号链接，只为让下列断言照常通过，镜像不复制它 | `app/tests/brand-rules-split.test.ts:55`「the new scopes are scanned」`expect(files).toContain("docker/openbot-apt")` | `toContain("docker/xiongbao-apt")`，并删掉仓库里的 `docker/openbot-apt` 符号链接（镜像里的 `/usr/local/sbin/openbot-apt` 兼容链接不受影响，按 legacy-compat 到期再删） | 19 |
| 35 | Task 13 发现：`--minify` 暂不开（控制者裁定）。开启后产物里的 `openbotUrl:` 会变成 `openbotUrl:_` | `desktop-device/scripts/build-sidecar.ts`（`sidecarArgs`） | `app/tests/brand-ratchet.test.ts`「this branch does not grow any allowlist, budget or word list」：词表不许出现新词，`openbotUrl:_` 会被当成新词 | 开启 `--minify`，同时把 runner/deb 词表里的 `openbotUrl:` 改为 minify 后的写法 `openbotUrl:_`（棘轮会把它当新词）；同时删掉 `shared/openbot-browser.ts`（runner）、`openbot-browser.ts`（deb）两个注释词。Task 19 落地时，同一个提交里把词表的 `openbotUrl:` 换成 `openbotUrl:_`，这一处棘轮增长按已获批的本行放行，提交说明里注明。状态：已批准（2026-11-13） | 19 |
| 36 | Task 14 发现：内容脚本在隔离环境里的两个全局标志。它们只在扩展的隔离环境里，网页控制台看不到（规格 R7 验收 ① 已满足），但扩展词表还登记着，`no-page-globals.test.ts` 跑 `content.js` 时也看得到 `__openbotRecorderContent`。两个标志都由同一版本的 service worker 和 `content.js` 读写，不跨版本，改名不需要双认（审查更正：「不跨版本」没有证据。Task 19 落地时，新内容脚本要同时读老标志，以防老版本扩展仍在同一页面） | `extension/src/content/index.ts:8-22,103`（`__openbotRecorderContent`、`__openbotRecorderActive`）、`extension/src/background/content-scripts.ts:8-11`（写 `__openbotRecorderActive`） | `extension/tests/content-port.test.ts:455` `expect(globals.__openbotRecorderContent).toBe(true)`；同文件 `:438,499,524` 把旧名 `__openbotRecorderActive` 当作「一加载就开始捕获」的信号写进去（`:425-426` 用旧名清理） | 两个标志改用 `Symbol.for("xb.recorder.content")`、`Symbol.for("xb.recorder.active")` 作键（`Object.keys(window)` 看不到），上面几处断言和输入改用新键；`no-page-globals.test.ts` 的 `PENDING_ROW_36` 改为 `[]`；扩展词表删掉 `_.__openbotRecorderActive`、`_.__openbotRecorderContent`、`globalThis.__openbotRecorderActive` | 19 |
| 37 | Task 19 发现（行 13 的衍生）：`UserPreferences.skin` 的类型不再含 `openbot`，类型夹具里的字面量让 tsc 报错。用户 2026-11-13 已批准 | `shared/user-preferences.ts`（`SKIN_IDS`） | `app/tests/app-shell-parity.test.tsx:186`、`app-sidebar-shell.test.tsx:202`、`channel-pagination.test.tsx:179,265`、`check-in-row.test.tsx:110`、`check-ins-settings.test.tsx:57`、`conversation-workspace.test.tsx:194`、`narrow-sidebar-sheet.test.tsx:129`、`parity/fixtures.ts:1333`、`self-host-banner.test.tsx:36,94`、`sidebar-roster-narrow.test.tsx:114`、`sidebar-roster.test.tsx:185`、`sidebar-shortcuts.test.tsx:135`、`user-preferences.test.tsx:118,151`（`skin: "openbot"`，共 15 处）；另 `server/tests/user-preferences-routes.test.ts:225`（错误信息里的皮肤清单）、`app/tests/skins-account.test.tsx:157,270`、`app/tests/avatar-skin.test.tsx:72`（`SKINS.openbot`） | `skin: "xiongbao"`；清单 `"xiongbao, openduet, opendots, openmuse"`；`SKINS.xiongbao` | 19（代码已改，提交 6c196a47；待批准后合并） |
| 38 | Task 19 发现（行 14 的衍生）：`conversationTag` 改名后，其他用例里写死的同源 tag。用户 2026-11-13 已批准 | `app/src/lib/notifications/show.ts:21` | `app/tests/desktop-notify-prompt.test.tsx:196,213`（`openbot-channel-plan`）、`bots-nav-badge.test.tsx:223`（同）、`reply-notice.test.tsx:280,393,478`（`openbot-march-receipts`） | `xiongbao-channel-plan`、`xiongbao-march-receipts` | 19（代码已改，提交 727932ce；待批准后合并） |
| 39 | Task 19 发现（行 11 的衍生）：`NOTICE_TAG` 改为新名后，常量比较的断言。用户 2026-11-13 已批准 | `extension/src/content/notice.ts:17` | `extension/tests/recorder-marks-compat.test.ts:77` `expect(NOTICE_TAG).toBe(LEGACY_NOTICE_TAG)` | `toBe(XB_NOTICE_TAG)` | 19（代码已改，提交 0b4c2474；待批准后合并） |
| 40 | Task 19 发现（行 8 的衍生）：`shell.test.ts:128` 的另一半。用户 2026-11-13 已批准 | `agent-computer/src/shell.ts:1030` | `agent-computer/tests/shell.test.ts:129` `toContain("[Console]::SetError($openbotErr)")` | `toContain("[Console]::SetError($xbErr)")` | 19（代码已改，提交 4165a2b3；待批准后合并） |
| 41 | Task 19 发现（行 35 的衍生）：开 `--minify` 后，现有断言要求不含它。用户 2026-11-13 已批准 | `desktop-device/scripts/build-sidecar.ts`（`compileArgs`） | `desktop-device/tests/build-sidecar.test.ts:66` `expect(args).not.toContain("--minify")` | `expect(args).toContain("--minify")` | 19（行 35 尚未做，随行 35 一起落地） |

## 附录 B：验证与切换记录

（Task 15 不通过时的原因、Task U5 之后的 CI 复跑结果写在这里。）

---

## 自检

**规格覆盖**（规格第 3.1 节逐项）：
- L1-1、L1-2 → Task 7；L1-3、L1-4、L1-5、L1-6、L1-7 → Task 8（被卡住的部分 → 附录 A 第 2–6 行 → Task 19）；L1-8 → Task 9。
- L1-9、L1-10 → Task 11（`COPILOTKIT_TELEMETRY_DISABLED` → 附录 A 第 7 行）；L1-11、L1-12、L1-13 → Task 10；L1-14、L1-15 → Task 18。
- L1-16、L1-17 → Task 12（终端变量名、runner 属性 → 附录 A 第 8、9 行）；L1-18 → 附录 A 第 10 行 → Task 19；L1-19、L1-20 → Task 13。
- L1-21、L1-22、L1-23 → Task 14（提示元素 → 附录 A 第 11 行）；L1-24 → 保留（Task 1 归 `persisted-data` / `keep`）；L1-25 → Task 4。
- L1-26 → Task 16、20；L1-27 → Task 6；L1-28 → Task 10（A）、15（B）。
- 护栏 5.1 A–H → Task 2（A、H）、3（B）、4（C、D、E）、5（F、G）；5.4 白名单结构 → Task 1；5.5 预算 → Task 2；5.6 度量表 → Task 4；4.5 到期测试 → Task 1；5.3 新增行 → Task 3。
- 第 8 节同步上游的固定动作 → Task 3（`upstream-sync.json`、`UPSTREAM.md` 一句话）。
- 用户决定：第 1 条 → U3、17、18、U4、U5；第 2 条 → 10、15；第 3 条 → 16、20；第 4 条 → 8；第 5 条 → 6；第 6 条 → Task 2 豁免 `charts/`；第 7 条 → Task 3；第 8 条 → 全局约束「新名字」；第 9 条 → Task 1 分类；第 10 条 → 全局约束「兼容窗口」、U7、21。

**接口一致性**：`AllowEntry`、`Category`、`Plan` 定义于 Task 1，Task 2、3、4 引用同名；`WORD`、`ArtifactEntry`、`wordsIn`、`compareWords` 定义于 Task 2，Task 3、4、5 引用；`printableStrings` 由 Task 4 加入；`NEW_PREFIX`、`LEGACY_PREFIX` 由 Task 8 或 Task 9（先做的那个）在 `shared/env-aliases.ts` 加 `export`；`envName` 定义于 Task 8，只在 Task 8 和 Task 19 使用；`HEADER` / `LEGACY_HEADER` 在 Task 16 定义于 agent-computer，Task 20 挪到 `shared/wire-headers.ts`；`migrateSessionCookiesFile` 定义于 Task 12，Task 19 第 10 行照它写。

**审查重点**：五条各有测试归属（Task 12、11、7、3、16/20）。

**篇幅**：任务步骤只给签名、测试名与断言、命令和取值；没有写函数体。
