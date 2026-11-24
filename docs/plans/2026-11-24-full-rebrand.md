# 彻底去掉上游品牌 + 迁到干净新仓库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新仓库 `canquedehuiyi-cpu/xiongbao` 的源码、构建产物、运行中对外暴露的名字里搜不到上游品牌，京东云现网数据一条不丢，以后仍能把上游仍公开的目录自动改名后合并进来。

**Architecture:** 一张改名表（变体 + 保护清单 + 跳过路径）驱动全部机械改名；R1 用它分目录改「不落数据、不出进程」的名字，R2 对用户手里已有的状态（环境变量、设备端、扩展身份）做新旧双认或换新，R3 在 v0.2.16 启动时一次性把数据库、密文、历史改成新名（迁移前自动备份、在途项未清空就拒绝），R4 在 v0.2.17 删光旧名、把迁移压成基线、护栏改成「出现即失败」，R5 把树导出成新仓库的单个首次提交。改名表与上游同步工具最后搬到产品仓库之外。

**Tech Stack:** Bun、TypeScript、bun:test、Drizzle + Postgres（RLS，overlay 迁移在 `server/recovery/recovery-20261018-v1/sql/`）、s6 启动脚本（sh）、Chrome MV3 扩展、Tauri 设备端、GitHub Actions。

**Spec:** `docs/specs/2026-11-24-full-rebrand.md`（用户 2026-11-24「设计稿没问题，按这个执行」）；摸底 `docs/specs/2026-11-24-full-rebrand-recon.md`。

## 分期与关口

| 期 | 任务 | 合入方式 | 关口 |
|---|---|---|---|
| R0 工具与现网核对 | 1–3 | 1 个 PR | 用户在京东云跑 Task 1 脚本、把输出贴回；Task 14、20、23 依赖它 |
| R1 代码层改名 | 4–14 | 每任务 1 个 PR | CI 全绿合入；有可见文案变化的截图给用户 |
| R2 用户手里的状态 | 15–17 | 每任务 1 个 PR | Task 17 需要用户先生成扩展新密钥 |
| R3 数据迁移 | 18–23 | 每任务 1 个 PR，opus 审查 | 迁移演练（用现网结构的空库）通过 |
| 发 v0.2.16 | 24 | 版本 PR，用户推标签 | 用户按升级单在京东云升级、改 `.env`、重装设备端与扩展、重连第三方；观察至少两天 |
| R4 删旧名 | 25–29 | 每任务 1 个 PR，Task 26 opus 审查 | 用户提供现网 `--schema-only`；发 v0.2.17、京东云升级验证 |
| R5 新仓库 | 30 | 推新仓库（经用户同意） | 用户确认 docs 去留清单、配置新仓库 secrets、旧仓库归档 |

## Global Constraints

- 改名变体（按此顺序、区分大小写、子串替换）：`@openbot/`→`@xiongbao/`、`OPENBOT`→`XIONGBAO`、`OpenBot`→`XiongBao`、`Openbot`→`Xiongbao`、`openBot`→`xiongBao`、`openbot`→`xiongbao`。
- 验收搜索词（不分大小写）：`openbot|open-bot|open_bot|open\.bot|copilotkit`。放行只有：依赖声明（`package.json` 的依赖名、`bun.lock`、导入路径里的 `@copilotkit/`）与许可证文件里的 `Copyright (c) 2026 CopilotKit` 加 MIT 原文。
- 许可证文件只一个（`THIRD-PARTY-NOTICES.md`），不出现 OpenBot 这个词，不写「derived from …」。
- `@copilotkit/*` 依赖不改、不换。
- 界面英文名走 `server/src/brand.ts` / `app` 的品牌出口（`english_name: XiongBao Work`），不把句子里的 `OpenBot` 机械替换成 `XiongBao`；`server/src`、`app/src` 里不写字面「熊宝」（brand-leak 规则）。
- 新代码、注释、测试名不出现上游品牌词，除非它是保护清单里的旧名（R1–R3 期间）且带 `legacy-compat：introducedIn 0.2.16，removeIn 0.2.17` 注释。
- R1–R3 期间不发服务器版本，也不从含 R1 改动的提交发设备端版本；服务器、网页、扩展、设备端、runner 一起在 v0.2.16 换名。`device-v0.2.15-rc.1` 只能打在 R1 首个合入之前的提交上。
- 跳过路径（任何阶段都不改内容和文件名）：`archives/`、`xiongbao/server/drizzle/`、`xiongbao/server/recovery/**/sql/`、`xiongbao/server/recovery/**/meta/`（R4 基线化时整体替换）、`node_modules/`、`bun.lock`（只能 `bun install` 重生成）。
- 不改测试断言去迁就改名：断言里的旧名随源码一起改成新名；故意证明旧名仍可用的测试保留旧名并登记保护清单，到 R4 随兼容代码一起删除。
- 只对改动文件 `bunx biome check --write <files>`，绝不对目录或仓库根；`xiongbao/` 下 `bunx biome lint --error-on-warnings --diagnostic-level=warn .`、`bun run typecheck`、`bun run typecheck:tests` 通过；新增或改名 server/app 测试文件后 `bun run test:shards`。
- 中文提交，结尾两行：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`、`Claude-Session: https://claude.ai/code/session_01MJUqVcFToyopKbNJ4sEoWY`。
- 品牌护栏的预算 `app/tests/brand-budget.json` 与白名单 `app/tests/brand-leak-allowlist.json`、产物词表 `app/tests/brand-artifacts/*.json` 只许变少；每个改名任务用 Task 3 的 `refresh-guards` 同步它们，不手写数字。
- 迁移前备份路径（容器内，落在数据库卷上）：`/var/lib/postgresql/backup/pre-rebrand-<UTC 时间 YYYYMMDDTHHMMSSZ>.dump`，权限 0600，属主 postgres。
- 超级用户角色名 `openbot` 在 R4 基线化（Task 26）之前全仓不改（历史迁移 0054 引用它）；交付容器里已有卷的超级用户与库在 v0.2.16 迁移后改名（Task 19）。
- 新名字：数据库超级用户与库 `xiongbao`、角色 `xiongbao_app`/`xiongbao_role_writer`、凭据 kid `k2` 的 AAD `xiongbao.vault.credential.v2`、扩展原生宿主 `xiongbao.recorder`、扩展 IndexedDB `xiongbao-recorder`、发布记录键 `images.xiongbao`（已有）、Helm 目录 `charts/xiongbao`、K8s 标签前缀 `xiongbao.dev/`。

## Review Focus

1. 京东云 `.env.delivery` 同时写着 `OPENBOT_X` 和 `XIONGBAO_X` 且值不同：新名赢，启动日志点名冲突，服务照常起来（Task 15 测试 `conflicting old and new names keep the new value and report the old name`）。
2. v0.2.16 迁移中途失败（例如第 37 条凭据解不开）：整个迁移回滚，数据库与升级前逐字节一致的业务数据，服务拒绝启动并打印哪一步、哪类数据失败、备份文件在哪（Task 21 测试 `a credential that fails to decrypt rolls back every re-encrypted row`、Task 18 测试 `migration failure leaves the backup and prints its path`）。
3. 升级后重启第二次：迁移检测到已是新名，什么都不做，不再备份（Task 19 测试 `second start after rename is a no-op`、Task 20 测试 `migration applied twice changes nothing`）。
4. 迁移前备份盘不够：不迁、不启动，提示需要多少空间（Task 18 测试 `insufficient space refuses before touching data`）。
5. 用户先升服务器、隔一会儿才升设备端：旧设备端在这段时间仍能连上并干活（Task 16 测试 `v0.2.15 runner frames are accepted by the v0.2.16 server`）。

---

## R0：工具与现网核对

### Task 1: 现网只读核对脚本

**Files:**
- Create: `xiongbao/scripts/rebrand/prod-inspect.sh`
- Test: `xiongbao/scripts/rebrand/prod-inspect.test.ts`

**Interfaces:**
- Produces: 用户在京东云服务器上运行 `sh prod-inspect.sh <容器名> <.env.delivery 路径>`，标准输出一份纯文本报告（只有名字与计数，没有任何值）；Task 14、18、20、21、23 按报告里的数字决定分支。

- [ ] **Step 1: 写失败测试**

测试把一个假的 `docker` 放到 `PATH` 最前（记录收到的参数，对 `psql` 调用按 SQL 返回预置结果），运行脚本，断言：
- `report contains only names and counts`：输出每一行匹配 `^(# .*|[A-Za-z0-9_.:-]+(=[0-9]+)?|)$`，不含 `=` 后跟非数字；
- `every SQL statement is a count or a catalog name query`：假 docker 记下的每条 SQL 匹配 `^SELECT (count\(\*\)|rolname|datname|proname|tgname|pg_size_pretty|pg_database_size)` 且整个会话以 `SET default_transaction_read_only = on` 开头；
- `env names are listed without values`：给 `.env.delivery` 放 `OPENBOT_PUBLIC_URL=http://x`、`XIONGBAO_RLS_ENFORCE=warn`、`KEY_ENCRYPTION_KEY=abc`，输出含 `OPENBOT_PUBLIC_URL`、`XIONGBAO_RLS_ENFORCE`，不含 `http://x`、`warn`、`abc`、`KEY_ENCRYPTION_KEY`；
- `missing container exits 2 with a hint`：`docker inspect` 失败时退出码 2，标准错误含「docker ps」。

- [ ] **Step 2: 运行确认失败**

Run: `cd xiongbao && bun test scripts/rebrand/prod-inspect.test.ts`
Expected: FAIL（脚本不存在）

- [ ] **Step 3: 实现 `prod-inspect.sh`**

POSIX sh，`set -eu`。报告分节（`# ` 开头的节标题）：
1. `# env-file`：`.env.delivery` 里匹配 `^(OPENBOT|XIONGBAO|COPILOTKIT|CPK)_[A-Z0-9_]*=` 的名字（`sed 's/=.*//'`）。
2. `# container-env`：`docker exec <容器> ls /run/s6/container_environment` 里同样前缀的名字。
3. `# database`：经 `docker exec <容器> sh -c 'psql "$(cat /run/s6/container_environment/MIGRATION_DATABASE_URL)" …'` 执行（连接串不进命令行参数、不打印）：含 `openbot` 的角色名、库名、函数名、触发器名；库大小；`df -k /var/lib/postgresql` 的可用 KB。
4. `# rows`：以下每项 `名字=行数`。实现者从 `xiongbao/server/src/db/schema/` 找准表与条件，每项写成一个 `count(*)`：两张审批精确输入表；待审批的审批；未完成的续跑（continuation target）；未过期的运行断言（若入库）；按 kid 分组的凭据行数；用了自动化钩子签名的钩子；web-bot-auth 是否开启（管理控制里的开关，存在即 1）；OpenTag 投递配置；学习容器 / Intelligence 配置；Composio/Arcade 共享账号身份；`deployment_packages` 里 `tenant_id='openbot'`；`plugin_grants` 里 `granted_by` 或 `updated_by` 以 `openbot:` 开头；记忆默认值键以 `openbot:` 开头；用户偏好里皮肤为 `openbot`。
5. `# copilotkit-usage`：上面第 1、2 节里 `COPILOTKIT_`/`CPK_` 名字的个数，以及学习容器配置行数（重复列出便于看）。

- [ ] **Step 4: 运行确认通过**

Run: `cd xiongbao && bun test scripts/rebrand/prod-inspect.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add xiongbao/scripts/rebrand/prod-inspect.sh xiongbao/scripts/rebrand/prod-inspect.test.ts
git commit -m "去品牌 R0：现网只读核对脚本（只出名字与行数）"
```

### Task 2: 改名表与改名工具

**Files:**
- Create: `xiongbao/scripts/rebrand/rename-map.ts`、`xiongbao/scripts/rebrand/protect.json`、`xiongbao/scripts/rebrand/apply.ts`
- Test: `xiongbao/scripts/rebrand/rename-map.test.ts`、`xiongbao/scripts/rebrand/apply.test.ts`

**Interfaces:**
- Produces:
  - `type Phase = "R1" | "R2" | "R3" | "R4"`
  - `type ProtectEntry = { text?: string; pattern?: string; until: Phase | "forever"; reason: string }`（`pattern` 是正则源码；`until` 是负责改掉它的阶段，当前阶段早于 `until` 时保护）
  - `VARIANTS: ReadonlyArray<readonly [string, string]>`（Global Constraints 的 6 条）
  - `SKIP_PATHS: readonly string[]`（Global Constraints 的跳过路径，相对仓库根）
  - `loadProtect(phase: Phase): RegExp`（把生效条目合成一个带 `g` 的正则）
  - `renameText(text: string, protect: RegExp): string`
  - `renamePath(path: string): string`（对路径每一段套变体）
  - `isSkipped(path: string): boolean`
  - CLI：`bun xiongbao/scripts/rebrand/apply.ts --phase <Phase> [--dry-run] [--review-out <file>] <路径...>`，对路径下 `git ls-files` 的文件改内容并 `git mv` 改名；标准输出一行 JSON `{ files: number, lines: number, moved: number, collisions: string[], review: number }`。
  - `collisions`：改名后得到的标识符（`\b[A-Za-z_$][\w$]*\b`）里，改名前就已在同一路径范围内存在的那些。
  - `--review-out`：写出「`OpenBot` 被替换在含空格的字符串字面量或 JSX 文本里」的行（`文件:行号: 新行`），供人工把界面句子改走品牌出口。

- [ ] **Step 1: 写失败测试**

`rename-map.test.ts`：
```ts
const p = loadProtect("R1");
expect(renameText('from "@openbot/shared"', p)).toBe('from "@xiongbao/shared"');
expect(renameText("normaliseOpenBotOrigin", p)).toBe("normaliseXiongBaoOrigin");
expect(renameText("openBotRun OPENBOT_ openbotUrl", /$^/g)).toBe("xiongBaoRun XIONGBAO_ xiongbaoUrl");
expect(renameText("OPENBOT_PUBLIC_URL", p)).toBe("OPENBOT_PUBLIC_URL");
expect(renameText('"openbot.vault.credential.v2", openbotUrl', p)).toBe('"openbot.vault.credential.v2", xiongbaoUrl');
expect(renameText("Copyright (c) 2026 CopilotKit", p)).toBe("Copyright (c) 2026 CopilotKit");
expect(renameText('import "@copilotkit/react-core"', p)).toBe('import "@copilotkit/react-core"');
expect(renameText("https://open.bot/errors/x", p)).toBe("https://open.bot/errors/x");
expect(renamePath("xiongbao/shared/openbot-actor.ts")).toBe("xiongbao/shared/xiongbao-actor.ts");
expect(renamePath("xiongbao/charts/openbot/templates/_helpers.tpl")).toBe("xiongbao/charts/xiongbao/templates/_helpers.tpl");
expect(isSkipped("xiongbao/server/drizzle/0054_app_role.sql")).toBe(true);
expect(isSkipped("archives/x.md")).toBe(true);
```
另加：`renaming twice equals renaming once`（对一段混合文本）；`protect entries expire by phase`（`until: "R2"` 的条目在 `loadProtect("R1")` 里生效、在 `loadProtect("R2")` 里不生效）；`every protect text exists verbatim in the tree`（遍历 `protect.json` 的 `text` 条目，`git grep -F` 至少命中一处，防止保护清单写错字）。

`apply.test.ts`：在临时 git 仓库里放 3 个文件（一个含 `openbotModel` 且同目录已有 `xiongbaoModel` 声明；一个文件名含 `openbot`；一个在 `server/drizzle/`），运行 CLI，断言 JSON 的 `moved: 1`、`collisions: ["xiongbaoModel"]`、drizzle 文件未变；`--dry-run` 时工作区无改动；`--review-out` 文件含 `<p>Welcome to OpenBot</p>` 那一行。

- [ ] **Step 2: 运行确认失败**

Run: `cd xiongbao && bun test scripts/rebrand/`
Expected: FAIL

- [ ] **Step 3: 实现**

`renameText`：先用保护正则把命中片段换成占位符（`\u0000<序号>\u0000`），按 `VARIANTS` 顺序 `replaceAll`，再还原占位符。
`protect.json` 初始内容由一次性生成得到（生成脚本不入库，生成结果入库并在 PR 描述里说明来源）：
- `until: "R2"`：正则 `OPENBOT_[A-Z0-9_]+`（环境变量与错误码，由 Task 15 处理）；设备端 ↔ 服务器之间传输的名字（实现者 grep `desktop-device/`、`runner/`、`xiongbao/server/src` 里 runner 网关的帧与头，逐个列出；由 Task 16 处理）；扩展身份类（扩展 id、`ai.copilotkit.openbot.recorder`、`openbot-recorder`、`OpenBotUrl`；由 Task 17 处理）。
- `until: "R3"`：`scripts/brand/guard/scan.ts` 的 `NEVER_CHANGE`、`SIGNING_DOMAINS`；`env-names.ts` 的 `CRYPTO_NAMES`（覆盖在上面的正则之前，`until: "R3"`）；`app/tests/brand-leak-allowlist.json` 里 `category` 为 `persisted-data` 或 `peer-protocol` 的 `text`；迁移 SQL 里出现的数据库对象名（`git grep -ohE 'openbot[a-z_]*' -- xiongbao/server/drizzle xiongbao/server/recovery | sort -u`）；`openbot.audit_retention_days`、`openbot_work_offered`、`openbot:apply-migrations`；连接串与启动脚本里的超级用户与库名（`postgres://openbot`、`-U openbot`、`/openbot'`）；租户 id（`examples/xiongbao/brand.yaml` 的 `id: openbot`）；Composio/Arcade 身份前缀 `openbot-deployment:`；学习容器 id；`plugin_grants` 标记 `openbot:staffing-default|personal-defaults|always-on`；记忆默认值键前缀 `openbot:defaults:`；皮肤值 `"openbot"`（以引号形式）；`images.openbot`。
- `until: "R4"`：`desktop-device` 的 `LEGACY_SIDECAR` 值 `openbot-runner`；`shared/env-aliases.ts`、`docker/s6/scripts/env-aliases.sh` 里的 `LEGACY_PREFIX` 值；以及 R2/R3 新写的兼容代码里出现的旧名（各任务自己追加条目）。
- `until: "forever"`：`Copyright (c) 2026 CopilotKit`。

- [ ] **Step 4: 运行确认通过**

Run: `cd xiongbao && bun test scripts/rebrand/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add xiongbao/scripts/rebrand/
git commit -m "去品牌 R0：改名表、保护清单与改名工具"
```

### Task 3: 剩余旧词报告与护栏同步

**Files:**
- Create: `xiongbao/scripts/rebrand/report.ts`、`xiongbao/scripts/rebrand/refresh-guards.ts`
- Test: `xiongbao/scripts/rebrand/report.test.ts`、`xiongbao/scripts/rebrand/refresh-guards.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `loadProtect`、`renamePath`、`isSkipped`、`Phase`。
- Produces:
  - `type Leftover = { file: string; line: number; word: string; protected: boolean }`
  - `findLeftovers(files: string[], phase: Phase): Leftover[]`（按验收搜索词，排除依赖声明、许可证段与跳过路径；保护清单命中的标 `protected: true`）
  - CLI `bun xiongbao/scripts/rebrand/report.ts --phase <Phase> [--scope <路径>] [--fail-on-unprotected] [--fail-on-any]`：打印按顶层目录汇总的表（未保护 / 已保护），`--fail-on-unprotected` 有未保护命中时退出 1，`--fail-on-any` 有任何命中时退出 1。
  - CLI `bun xiongbao/scripts/rebrand/refresh-guards.ts`：① 重算 `app/tests/brand-budget.json`（用 `scripts/brand/guard/budget.ts` 的 `countBudget`），任何一行变大就退出 1 并列出；② 白名单条目的 `file` 套 `renamePath`，`text` 在文件里已不存在的条目删除；③ 名字白名单（`NAME_ALLOWLIST`）同样处理。产物词表不在这里改（要构建产物才知道）。

- [ ] **Step 1: 写失败测试**

- `report.test.ts`：临时树含 `package.json` 依赖 `"@copilotkit/react-core"`、`THIRD-PARTY-NOTICES.md` 的版权行、一个 `openbotUrl`、一个 `"openbot.vault.credential.v2"`；`findLeftovers(…, "R1")` 只返回两条，`openbotUrl` 那条 `protected: false`，加密串那条 `protected: true`；`findLeftovers(…, "R4")` 两条都 `protected: false`；`--fail-on-unprotected` 退出 1。
- `refresh-guards.test.ts`：给一份预算与白名单夹具；把一个文件里的旧词改掉后运行，预算对应行变小、白名单失效条目被删、路径被改；人为把一行预算改大后运行退出 1。

- [ ] **Step 2: 运行确认失败**

Run: `cd xiongbao && bun test scripts/rebrand/report.test.ts scripts/rebrand/refresh-guards.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现两个 CLI**

`refresh-guards` 要能在真实仓库上运行：运行后 `bun test app/tests/brand-budget.test.ts app/tests/brand-leak.test.ts` 应通过（本任务在未改名的树上运行它应当零改动）。

- [ ] **Step 4: 运行确认通过**

Run: `cd xiongbao && bun test scripts/rebrand/ && bun scripts/rebrand/refresh-guards.ts && git diff --exit-code app/tests/ && bun scripts/rebrand/report.ts --phase R1`
Expected: 测试 PASS；`git diff` 无输出；报告打印各目录计数（记进台账作为 R1 起点）。

- [ ] **Step 5: 提交并开 R0 PR**

```bash
git add xiongbao/scripts/rebrand/
git commit -m "去品牌 R0：剩余旧词报告与护栏同步工具"
```

**给用户的一步（R0 合入后）：** 把 `prod-inspect.sh` 的下载与运行命令发给用户（`docker ps` 找容器名 → `sh prod-inspect.sh <容器名> /opt/xiongbao/.env.delivery`，路径以用户实际为准），请用户贴回输出；控制方把结果写进台账「R0 现网事实」。

---

## R1：代码层改名

每个 R1 任务都按同一套步骤做（下面每个任务只写它的范围、特有决定与特有测试）：

1. `bun xiongbao/scripts/rebrand/apply.ts --phase R1 --review-out <台账目录>/task-N-review.txt <范围>`；
2. 改其它目录里的引用：本范围改了导出名、文件名或包内路径时，全仓 `bun run typecheck` 报出的其它目录里的导入方（只改引用行），在本任务一并改掉，以 typecheck 报错清单为准；
3. 处理 `collisions`：同义的合并成一个声明，不同义的给新名加区分词（在报告里逐个写理由）；
4. 处理 review 文件：界面句子改走品牌出口，开发者可见的英文句子写 `XiongBao`；
5. `bun install`（凡动了 `package.json`）、`bun xiongbao/scripts/rebrand/refresh-guards.ts`；
6. 构建受影响的产物并更新词表：`app` → `bun run --cwd app build` 后 `bun scripts/brand/scan-artifact.ts --kind web …`；`extension` 同理；镜像类词表（image-files、image-config、image-logs）以 CI 输出的「已经没了」为准删除；
7. 手工处理工具不改的：`open.bot`、`open-bot`、`open_bot` 等写法（变体表不含，按语义改写或删除）；上游自有地址（`github.com/CopilotKit/OpenBot`、`ghcr.io/copilotkit/openbot-*` 等，保护清单冻结到 R4）不改名，属于本范围且不再需要的删除；`brand-new-lines` 报出的「被改名改到、但行里仍有上游词」的行（多为注释），把该行的上游词一并去掉或改写；测试里漏保护的持久化/兼容旧名，给 `protect.json` 补带文件作用域的条目。
8. 验证：`bun xiongbao/scripts/rebrand/report.ts --phase R1 --scope <范围> --families openbot --fail-on-unprotected` 退出 0（`--scope` 相对仓库根；护栏自身文件 `GUARD_PATHS` 与工具目录已自动跳过）；`cd xiongbao && bun test scripts/rebrand/` 通过；Global Constraints 里的 lint、typecheck、typecheck:tests 通过；范围内的测试全部通过（server 用分片命令或按目录 `bun test`）；
9. 提交（`去品牌 R1：<范围>`），开 PR，CI 全绿合入。

### Task 4: 删除上游整栈桌面 `desktop/`

**Files:**
- Delete: `xiongbao/desktop/`（264 个文件）、`xiongbao/Tauri-signing-SKILL.md`（若只服务于 `desktop/`）
- Modify: 引用 `desktop/` 的工作流与脚本（`.github/workflows/ci.yml`、`.github/workflows/device-release.yml` 中确属 `desktop/` 的步骤）、`xiongbao/package.json` workspaces、`biome.json`、`scripts/brand/guard/scan.ts` 的 `desktop/` 豁免、`shared/desktop-control.ts` 里只为整栈存在的 `openbot-desktop` 常量、`app` 里只服务整栈的 `openbot://open` 返回逻辑

**特有决定：** `desktop-device/` 是熊宝自己的设备端，不动。`desktop/scripts/signing-workflows.test.ts` 若被发布测试引用，把仍有意义的断言移到 `xiongbao/scripts/ci/` 下的新测试，不删断言。整栈桌面相关的 `brand-leak-allowlist.json` 条目随之删除（`refresh-guards` 处理）。

**特有测试：** `git grep -n "desktop/" -- .github xiongbao ':!xiongbao/desktop-device'` 只剩与 `desktop-device` 无关的合法用法（例如 `app/src/lib/desktop` 这类网页里的目录名），在 PR 描述列出。

### Task 5: 包名与导入路径

**范围：** 全仓所有 `package.json` 的 `name`（`@openbot/*` 10 个、根 `openbot`、`openbot-mobile`）与所有 `@openbot/` 导入、`tsconfig*.json` 路径别名、`biome.json`、`bunfig.toml`、Python `pyproject.toml` 包名、CI 里 `--filter @openbot/...`。

**特有决定：** 只跑 `@openbot/` 这一条变体（给 `apply.ts` 加 `--only "@openbot/"` 选项，默认全部变体），其它标识符留给后续目录任务，避免一个 PR 太大。`bun.lock` 由 `bun install` 重生成，PR 里 lockfile 的差异只应是包名。

**特有测试：** `git grep -n "@openbot/" -- . ':!archives'` 为空；`bun install --frozen-lockfile` 在 CI 通过。

### Task 6: `xiongbao/shared/`

**特有决定：** `openbot-actor.ts`、`openbot-browser.ts` 改名；JSON 字段 `openbotUrl` 若在设备端 ↔ 服务器之间传输，它在保护清单里（Task 16 处理），扩展 ↔ 网页之间的照常改（扩展在 v0.2.16 换新身份，一起升级）。`env-aliases.ts` 不在本任务（Task 15）。

### Task 7: `xiongbao/server/`（`src/` 与 `tests/`，跳过迁移目录）

**特有决定：** 测试里域名样例（`openbot.test`、`dev@openbot.local`）随源码一起改；种子数据里的开发者邮箱若被测试库之外的东西持久化（开发库），可以直接改（开发库每次新建）。`server/src/computer/sandbox.ts` 的 K8s 标签留给 Task 11 与 chart 一起改。

**特有测试：** 服务器分片测试全部通过（`bun scripts/ci/server-shards.mjs` 列出的分片逐个跑）。

### Task 8: `xiongbao/app/`

**特有决定：** DOM id 与类名（`openbot-secret`、`.openbot-markdown`、`.openbot-breakdown`、`data-slot="openbot-version"`、`data-orb="openbot"`）直接改，同时改对应 CSS 与测试选择器。浏览器存储键 `openbot-voice-chat`、`openbot-voice-context`、`openbot-unreachable` 改新键，读取走现有 `app/src/lib/storage-migrate.ts` 的 `readMigrated`（新键没有就搬旧键），旧键名登记保护清单 `until: "R4"`。皮肤值 `"openbot"` 在保护清单里（Task 20 迁数据库里的值）；本任务只让读取端把 `"openbot"` 映射到新皮肤 id 并写回本地存储。

**特有测试：** `app` 全部测试与 `app-status-shots` 通过；若 review 文件里有界面文案变化，截图（暗色、1440 与 390 宽）给用户确认后再合入。

### Task 9: `xiongbao/extension/`（代码层）

**提醒：** 全仓保护的 `openbot-recorder` 会顺带冻结注入页面的 DOM id（`openbot-recorder-mark`、`-notice`、`-stall-`），它们随 Task 17 一起改。

**特有决定：** 扩展 id、签名密钥、原生宿主名、IndexedDB 库名、策略键在保护清单里，留给 Task 17。消息类型 `openbot.ping/connect/state/record/stop/connect.status` 与网页那一侧同一个 PR 一起改（扩展会整体换新）。`openbot-client.ts`、`openbot-page.ts` 改名。

### Task 10: 其余代码目录

**范围：** `agent-*/`（14 个框架目录，含 Python）、`examples/`、`mobile/`、`runner/`、`supervisor/`、`worker/`、`toolkit/`、`agent-computer/`、`spire/`、`docker/`（环境变量与连接串不动，在保护清单里）、`desktop-device/`（`LEGACY_SIDECAR` 不动）。

**特有决定：** 托管 Bot 头 `x-openbot-agent-token` 与 `forwardedProps.openbotModel` 现网没有托管 Bot 镜像在跑，服务器与 14 个框架同一 PR 直接改名，不做双认（控制方裁定，见文末「裁定」1）；本任务删除 protect.json 里 `x-openbot-agent-token` 的作用域条目。`openbotRun`、`openbotTimeZone`、`openbotWaiting` 会随审批续跑快照与 `thread_run_events` 落库，保护到 R3，由 Task 22 处理（Task 6 审查裁定）。SPIRE 信任域 `openbot.local` 改 `xiongbao.local`。

### Task 11: Helm chart

**范围：** `xiongbao/charts/openbot/` → `xiongbao/charts/xiongbao/`、模板函数 `openbot.*`、标签 `openbot.dev/*` → `xiongbao.dev/*`、`app.kubernetes.io/managed-by`；`server/src/computer/sandbox.ts` 按标签找电脑 pod 的代码同步改；`scripts/brand/guard/scan.ts` 的 `charts/` 豁免删除。

**特有测试：** chart 现有测试（`helm template` 或仓库里的 chart 测试）通过；`sandbox` 相关服务器测试通过。

### Task 12: 脚本、CI 与仓库配置

**提醒：** `xiongbao/docker-compose.yml:29` 注释「as `openbot` on `openbot`」改名后用户名会被错改，手工修正（超级用户仍是 `openbot`）。

**范围：** `xiongbao/scripts/`（不含 `scripts/brand/` 与 `scripts/rebrand/`）、根 `.github/`、`xiongbao/.github/`、`xiongbao/tools/`、`xiongbao/tests/`、`xiongbao/patches/`（只改补丁文件名与说明，不改补丁内容里第三方代码）、`Dockerfile` 注释、`capability-*.yaml`、`release-policy.json`、`renovate.json`、`xiongbao/.claude/skills/openbot-*`（目录改名）、CI 测试库名 `openbot_test`、`openbot:ci-owner`、`openbot-release:dry-run`。

**特有决定：** `xiongbao/.github/workflows/upstream-upgrade.yml`、`scripts/integrate-upstream.ts`、`UPSTREAM.md`、`upstream-sync.json` 不在本任务（Task 27/28 搬走）。`release.yml` 里 `images.openbot` 在保护清单里（Task 23）。

### Task 13: 文档

**提醒：** `xiongbao/docs/deployment.md:123`「0054's public `openbot`」讲的是口令，给它加作用域保护条目（until R4）；`xiongbao/README.md:233` 的版权说明句改写，不再引用版权行原文。

**范围：** `xiongbao/docs/`、`xiongbao/README.md`、`xiongbao/**/*.md`（不含 `CHANGELOG.md`、`UPSTREAM.md`、`NOTICE`、`LICENSE`、`THIRD-PARTY-NOTICES.md`、跳过路径）、`docs/assets/openbot-stack-*.svg`。

**特有决定：** 英文句子里的产品名写 `XiongBao Work`，中文句子写「熊宝」；讲上游渊源的段落删掉而不是改名（逐段在 PR 描述列出）；`brand-docs.test.ts` 的词表同步删减。部署文档里的 `OPENBOT_*` 留给 Task 15（它们在保护清单里）。

### Task 14: CopilotKit 非依赖痕迹

**依赖：** Task 1 的现网报告（`copilotkit-usage` 节与学习容器行数）。

**范围：** CopilotKit 自家云服务接入（Intelligence / 学习容器、`copilotkit.ai`、`api.intelligence.copilotkit.ai`）、`COPILOTKIT_*`/`CPK_*` 环境变量、`ai.copilotkit.*` 标识、代码与注释里的 `copilotkit` 字样（依赖导入除外）。

**特有决定：** 现网报告显示没在用的：删除整条接入（代码、配置、设置页入口、测试、文档）。在用的：改中性名字（如 `XIONGBAO_LEARNING_*`），旧环境变量名并入 Task 15 的双认，并在 PR 描述列出给用户。删除功能前在 PR 描述列出受影响的界面入口，有界面变化截图给用户确认。

**特有测试：** R1 收尾检查 `bun xiongbao/scripts/rebrand/report.ts --phase R1 --fail-on-unprotected --scope xiongbao .github`，并排除留给 R4 的路径：`xiongbao/CHANGELOG.md`、`xiongbao/UPSTREAM.md`、`xiongbao/NOTICE`、`xiongbao/upstream-sync.json`、`xiongbao/scripts/integrate-upstream.ts`、`xiongbao/.github/workflows/upstream-upgrade.yml`、`xiongbao/docs/upstream-upgrades.md`（若 `report.ts` 不支持排除 pathspec，本任务给它加 `--exclude <路径>` 选项并配测试）；根 `docs/` 不进新仓库，不在检查范围。退出 0。

---

## R2：用户手里的状态

### Task 15: 环境变量方向翻转

**Files:**
- Modify: `xiongbao/shared/env-aliases.ts`、`xiongbao/docker/s6/scripts/env-aliases.sh`、`xiongbao/docker/tests/env-aliases.test.sh`、`xiongbao/docker/compose.delivery.yml`、`xiongbao/docker/delivery.env.example`、所有读 `OPENBOT_*` 的代码（`apply.ts --phase R2` 去掉 `OPENBOT_` 正则保护后处理，`CRYPTO_NAMES` 仍保护到 R3）、部署与配置文档
- Create: `xiongbao/scripts/rebrand/rewrite-env.sh`
- Test: `xiongbao/shared/tests/env-aliases.test.ts`（已有则改）、`xiongbao/scripts/rebrand/rewrite-env.test.ts`

**Interfaces:**
- Produces: `applyEnvironmentAliases(env): { conflicts: string[]; legacy: string[] }`——方向反过来：`OPENBOT_X` 有值且 `XIONGBAO_X` 没有时复制成 `XIONGBAO_X`；两个都有且不同，新名赢，旧名进 `conflicts`；用到的旧名进 `legacy`。服务器启动时对 `legacy` 打一行警告（列名字，不列值）。`NEW_PREFIX`/`LEGACY_PREFIX` 常量保留，旧前缀登记保护清单 `until: "R4"`。
- Produces: `rewrite-env.sh <文件>`：先复制 `<文件>.bak-<时间>`（0600），把 `OPENBOT_X=` 行改成 `XIONGBAO_X=`；若同名新行已存在，旧行注释掉并在标准错误提示；`OPENBOT_IMAGE/TAG/PORT` 同样处理；不打印任何值。

- [ ] **Step 1: 写失败测试**：`old-only deployment reads the new name`、`conflicting old and new names keep the new value and report the old name`、`new-only deployment reports nothing`；shell 版对应三条；`rewrite-env` 的 `renames old lines, keeps a backup, never prints values`、`comments out an old line when the new one exists`；compose 用 `${XIONGBAO_IMAGE:-${OPENBOT_IMAGE:-xiongbao-digital-employee:local}}` 与 `${XIONGBAO_PORT:-${OPENBOT_PORT:-3772}}`，由 `docker compose config` 在两种 env 下解析出同一镜像（现有 compose 测试位置照写）。
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**；代码里的读取统一改成 `XIONGBAO_*`；`envName()` 返回新名。
- [ ] **Step 4: 运行确认通过**（含 `sh docker/tests/env-aliases.test.sh`）
- [ ] **Step 5: 提交**（`去品牌 R2：环境变量改读新名，旧名双认并告警`）

### Task 16: 设备端 ↔ 服务器的名字与设备端数据目录

**Files:**
- Modify: `xiongbao/desktop-device/src-tauri/src/`（数据目录、原生宿主名清单若在此）、`xiongbao/runner/`、服务器 runner 网关（实现者定位）、Task 2 保护清单里 `until: "R2"` 的设备端条目
- Test: 网关测试与 `desktop-device` 的 Rust 测试

**Interfaces:**
- Produces: 服务器接受 v0.2.15 设备端发来的旧名帧/头与新名，只发新名（若服务器发给设备端的名字也带旧词，v0.2.16 服务器对旧设备端版本——由设备端上报的版本号判断——继续发旧名，`legacy-compat` 注释 removeIn 0.2.17）。设备端 v0.2.16 启动时若旧数据目录存在、新目录不存在，整体移动到新目录；移动失败继续用旧目录并在日志与设备端界面状态里报警。

- [ ] **Step 1: 写失败测试**：`v0.2.15 runner frames are accepted by the v0.2.16 server`（用旧名帧夹具跑网关）、`server talks old names to a v0.2.15 runner`；Rust：`moves the old data directory once`、`second start after move is a no-op`、`move failure keeps the old directory and reports`。
- [ ] **Step 2–4:** 失败 → 实现 → 通过
- [ ] **Step 5: 提交**（`去品牌 R2：设备端名字新旧双认、数据目录改名`）

### Task 17: 扩展换新身份

**前置用户步骤：** 用户在自己电脑上按控制方给的命令生成新的扩展签名私钥（`openssl genrsa` 2048 位），私钥只放进 GitHub `release` Environment 的新 secret（名字由实现者从现有发布流程里对应旧 secret 的位置定，改成新名），把公钥（`openssl rsa -pubout -outform DER | base64`）贴给控制方。私钥不进会话。

**Files:**
- Modify: 扩展 manifest 的 `key`、`xiongbao/shared/recorder-extension.json`（扩展 id、原生宿主 `xiongbao.recorder`）、`extension/src/shared/database.ts`（库名 `xiongbao-recorder`）、`extension/src/shared/policy.ts` 与 `extension/public/managed_schema.json`（只留 `XiongbaoUrl`）、服务器认可的扩展 id 列表、设备端原生宿主清单、发布流程读的 secret 名、`extension/scripts/store-package*` 里的密钥路径
- Test: 现有扩展与 store-package 测试改成新值；新增 `extension id matches the manifest key`（由公钥算出 id 与 `recorder-extension.json` 一致）

- [ ] **Step 1–4:** 失败 → 实现 → 通过
- [ ] **Step 5: 提交**（`去品牌 R2：扩展换新 id、密钥、原生宿主与存储名`）

---

## R3：数据迁移（v0.2.16，opus 审查）

所有迁移代码在 platform 帧里运行，单事务；任一步失败整体回滚、服务拒绝启动并打印「哪一步、哪类数据、备份文件路径」，数据不动。迁移代码与兼容读取一律带 `legacy-compat：introducedIn 0.2.16，removeIn 0.2.17` 注释。

### Task 18: 前置检查、自动备份、升级前自查命令

**Files:**
- Create: `xiongbao/docker/s6/scripts/rebrand-preflight.sh`（启动迁移前调用）、`xiongbao/scripts/rebrand/pre-upgrade-check.sh`（用户在 v0.2.15 上升级前运行，只读）
- Modify: `xiongbao/docker/s6/scripts/migrate.sh`（迁移前调用 preflight 与备份）
- Test: `xiongbao/docker/tests/rebrand-preflight.test.sh`、`xiongbao/scripts/rebrand/pre-upgrade-check.test.ts`

**Interfaces:**
- Produces: 「需要改名」的判定 `needs_rebrand`：库里存在角色 `openbot` 或 `openbot_app`。需要时：① 在途检查——待审批数、未完成续跑数、未过期运行断言数（表与条件同 Task 1 第 4 节）任一大于 0 即拒绝，打印各项数字与处理办法；② 空间检查——`/var/lib/postgresql/backup` 所在盘可用空间 ≥ 库大小 × 2，否则拒绝并打印需要多少；③ `pg_dump -Fc` 到 Global Constraints 的备份路径，0600。不需要时什么都不做。

- [ ] **Step 1: 写失败测试**：`pending approvals refuse the upgrade and leave data untouched`、`insufficient space refuses before touching data`、`backup is written 0600 before any rename`、`already renamed database skips preflight and backup`、`migration failure leaves the backup and prints its path`（让后续步骤桩失败）。测试用 CI 里现有的真实 Postgres 服务（照 `docker/tests/` 现有 shell 测试的起库方式）。
- [ ] **Step 2–4:** 失败 → 实现 → 通过
- [ ] **Step 5: 提交**

### Task 19: 超级用户与库改名

**Files:**
- Modify: `xiongbao/docker/s6/scripts/postgres-init.sh`、`xiongbao/docker/s6/scripts/migrate.sh`（连接串、`ALTER ROLE … PASSWORD` 的角色名）
- Test: `xiongbao/docker/tests/rebrand-superuser.test.sh`

**Interfaces:**
- Produces: 历史迁移 `server/drizzle/0054_app_role.sql` 有 `ALTER DEFAULT PRIVILEGES FOR ROLE openbot`，R4 基线化之前空库跑迁移必须有 `openbot` 角色。因此新装卷仍 `initdb -U openbot`、`createdb openbot`、跑完迁移；然后新装卷与已有卷走同一段改名：（已有卷先经 Task 18 备份）连 `postgres` 库执行 `ALTER ROLE openbot RENAME TO xiongbao`、`ALTER DATABASE openbot RENAME TO xiongbao`（库上不能有其它连接：迁移之后、服务进程启动之前执行），然后写新连接串文件。SCRAM 口令不重设。之后每次启动，迁移以 `xiongbao` 连接。

- [ ] **Step 1: 写失败测试**：`fresh volume ends with the new names after migrations`、`existing volume is renamed and the old password still works`、`second start after rename is a no-op`、`rename failure keeps the old names and stops`。
- [ ] **Step 2–4:** 失败 → 实现 → 通过
- [ ] **Step 5: 提交**

### Task 20: 数据库对象与标记改名迁移

**依赖：** Task 1 报告里两张审批精确输入表的行数。为 0：只改约束与常量；不为 0：停下，把行数与选项报给用户（规格 §12.9）。

**Files:**
- Create: `xiongbao/server/recovery/recovery-20261018-v1/sql/0240_rebrand_names.sql`（编号以实现时最新为准顺延）与对应 meta
- Modify: 服务端 SQL 引用的函数名（如 `server/src/channels/routes.ts` 的 `public.openbot_team_channel_creator`）、`NOTIFY` 通道 `openbot_work_offered`（5 处）、迁移锁名、GUC `openbot.audit_retention_days`（8 处）、审批精确输入版本串常量（`CRYPTO_NAMES` 5 个）、`server/src/db/schema/approval-exact-input-objects.ts` 的 CHECK、`plugin_grants` 标记常量、记忆默认值键常量、租户 id 常量与 `examples/xiongbao/brand.yaml`
- Test: `xiongbao/server/tests/rebrand-migration.test.ts`

**Interfaces:**
- Produces: 迁移内容——`ALTER ROLE openbot_app RENAME TO xiongbao_app`、`openbot_role_writer` 同理（`migrate.sh` 的 `ALTER ROLE … PASSWORD` 同步）；全部 `openbot_*` 函数与触发器 `ALTER … RENAME`；`set_config` 旧 GUC 的库级设置拷到新名；CHECK 约束换成新串（行数为 0 时）；`plugin_grants.granted_by/updated_by`、记忆默认值键、用户偏好皮肤值、`deployment_packages.tenant_id` 的 `openbot` 前缀/值改新名；在 `deployment_packages`（或实现者选的元数据表）记下旧部署名的摘要，`deploymentNameOf` 在 `DEPLOYMENT_ID` 为空时用这个摘要算线程 id 前缀，使新线程 id 前缀与升级前一致（只存摘要，不存旧名明文）。
- NOTIFY：v0.2.16 同时 `LISTEN` 新旧两个通道，只 `NOTIFY` 新通道。

- [ ] **Step 1: 写失败测试**：在按 v0.2.15 迁移到最新的库里插入带旧标记的行，跑迁移后断言：`roles, functions and triggers carry the new names`、`RLS policies still evaluate after the function rename`（以 app 角色读写一张受 `xiongbao_team_row_guard` 保护的表）、`markers and preferences are rewritten`、`thread id prefix is unchanged after the tenant rename`、`migration applied twice changes nothing`、`audit_events rows are untouched`。
- [ ] **Step 2–4:** 失败 → 实现 → 通过（服务器分片全绿）
- [ ] **Step 5: 提交**

### Task 21: 凭据换 AAD（kid k2）

**Files:**
- Modify: `xiongbao/server/src/credentials.ts`（`CREDENTIAL_KID`、AAD）、启动迁移入口（实现者选：服务器启动、监听端口之前）
- Test: `xiongbao/server/tests/credential-rekey.test.ts`

**Interfaces:**
- Produces: `rekeyCredentials(tx): Promise<{ rekeyed: number }>`——逐行用 `k1` 的旧 AAD 解密、用 `k2` 的新 AAD `xiongbao.vault.credential.v2` 加密，单事务；读取端 v0.2.16 认 `k1` 与 `k2`，写入只用 `k2`。
- [ ] **Step 1: 写失败测试**：`every k1 row becomes k2 and decrypts to the same plaintext`、`a credential that fails to decrypt rolls back every re-encrypted row`、`rekey applied twice changes nothing`。
- [ ] **Step 2–4:** 失败 → 实现 → 通过
- [ ] **Step 5: 提交**

### Task 22: 对话历史里的旧名

**Files:**
- Modify: 历史读取端（`server/src/approvals/continuation-target-store.ts` 等实现者 grep 到的事件名、标记、工具 id、`openbot/ui@1`、`openbot/share_private_information`，以及落库键 `openbotWaiting`（thread_run_events 的中断元数据）、`openbotTimeZone`、`openbotRun`（审批续跑快照的 forwardedProps）的读取处）、写入端常量
- Create: 历史改写迁移（同 Task 20 的迁移目录，下一编号）
- Test: `xiongbao/server/tests/rebrand-history.test.ts`

**Interfaces:**
- Produces: 迁移只替换这些精确字面量（列表写在迁移文件头注释里，与保护清单 R3 条目一致），只作用于系统写的 JSON 字段（事件类型、标记、工具 id），不碰用户消息、模型回复、记忆正文与 `audit_events`；读取端 v0.2.16 两个都认，写入只写新。
- [ ] **Step 1: 写失败测试**：`event names and markers in stored history are rewritten`、`user text that happens to contain the old marker is untouched`（放在用户消息正文里）、`readers accept both names`、`rewrite applied twice changes nothing`。
- [ ] **Step 2–4:** 失败 → 实现 → 通过
- [ ] **Step 5: 提交**

### Task 23: 签名域、第三方登记名与发布记录

**依赖：** Task 1 报告的自动化钩子、web-bot-auth、OpenTag、学习容器、共享账号行数。

**范围：** `SIGNING_DOMAINS` 7 个换新串（前置检查已保证没有在途运行断言）；Composio/Arcade 身份前缀 `openbot-deployment:`、OpenTag 路径 `/openbot/membership|deliver`、学习容器 id（若 Task 14 没删）、web-bot-auth HKDF 信息串换新；`release.yml` 只写 `images.xiongbao`，`mirror-release.yml` 与部署文档改读新键；`scripts/brand/guard/scan.ts` 的 `NEVER_CHANGE`/`SIGNING_DOMAINS` 换成新串（护栏的意义变成「新串不许再改」）。

**特有决定：** 现网报告里行数大于 0 的项，在 Task 24 的升级单里写「升级后重新连接 / 重新配置」的具体步骤；行数为 0 的项不写。

**特有测试：** 现有签名、令牌、web-bot-auth、release 工作流测试改成新串后全部通过；新增 `release record carries only images.xiongbao`。

---

## 发 v0.2.16

### Task 24: 过渡版发版准备与升级单

**Files:**
- Modify: 版本号（照 #813 的做法）、`xiongbao/CHANGELOG.md`（v0.2.16 条目只写熊宝视角的变化：名字统一、需要重新连接的项、扩展与设备端需重装）、`xiongbao/docs/deployment-xiongbao.md` 的升级节
- Create: `docs/acceptance/HUMAN-STEPS.md` 新节「v0.2.16 改名升级」

**升级单内容（按顺序）：** ① 在 v0.2.15 上跑 `pre-upgrade-check.sh`，处理完在途审批与续跑；② `rewrite-env.sh /opt/xiongbao/.env.delivery`；③ 守护式升级命令（先 `docker image inspect` 新镜像成功再停旧容器，照 v0.2.15 那次）；④ 看启动日志里的迁移摘要与备份路径，健康检查通过；⑤ 核对：登录、打开历史对话、已存凭据的连接器能用、新对话的线程能建；⑥ 重装设备端 v0.2.16、卸旧扩展装新扩展；⑦ 按 Task 23 列出的项重新连接；⑧ 观察两天。回滚：恢复备份 + 回 v0.2.15 镜像（命令写全）。

**特有测试：** 发版前在 CI 跑一次「v0.2.15 镜像建库 → 写入各类数据 → 换 v0.2.16 镜像启动」的升级演练（照 `clean-deploy.yml` 现有起容器方式加一个 job，或在 PR 里手动触发），断言迁移摘要、备份文件存在、数据可读。

用户推标签 → 盯发布流水线与 JCR 同步 → 发升级单 → 用户执行并回报。

---

## R4：删旧名（v0.2.17）

### Task 25: 删除兼容代码与迁移代码

**范围：** 所有 `legacy-compat … removeIn 0.2.17` 的代码与测试（`brand-legacy-compat-expiry` 会在版本号改成 0.2.17 时逼出全部）：环境变量旧名双认（`env-aliases.*` 只留新名或整体删除）、设备端旧名双认与旧目录移动、`LEGACY_SIDECAR` 清理、`readMigrated` 旧键、NOTIFY 旧通道监听、凭据 `k1` 读取、历史旧名读取、Task 18–22 的迁移执行代码（迁移 SQL 本身由 Task 26 处理）、`rewrite-env.sh`、`pre-upgrade-check.sh`。保护清单只剩 `forever` 条目。

**特有测试：** `bun xiongbao/scripts/rebrand/report.ts --phase R4 --fail-on-any` 对 `xiongbao/` 除跳过路径外退出 0。

### Task 26: 迁移压成基线（opus 审查）

**前置用户步骤：** 用户在京东云（已是 v0.2.16）上导出 `pg_dump --schema-only`（命令由控制方给，经 `MIGRATION_DATABASE_URL`，不导数据），把文件发回。

**Files:**
- Create: `xiongbao/server/drizzle/` 下新基线（新名，单文件，等于当前结构）；启动时的结构比对与迁移表改写
- Delete: `xiongbao/server/drizzle/` 旧迁移、`xiongbao/server/recovery/**/sql/` 与 `meta/`（以及按字节冻结它们的 `server/tests/recovery-*.test.ts`，其断言意义由结构比对测试接替，在 PR 描述逐条说明）
- Test: `xiongbao/server/tests/migration-baseline.test.ts`

**Interfaces:**
- Produces: 基线里不再出现 `openbot` 角色；新装卷与 CI、开发 compose、测试辅助的超级用户此后直接用 `xiongbao`（R1–R3 期间它们保持 `openbot`，见保护清单 `until: "R4"` 条目），本任务一并改掉并删除这些保护条目。启动时若迁移表里是旧记录：导出当前 `--schema-only`，与基线预期逐项比对；完全一致则在单事务里把 `drizzle.__drizzle_migrations` 改写为基线一条记录；不一致拒绝启动并打印差异。新装库直接跑基线。
- [ ] **Step 1: 写失败测试**：`fresh database from baseline equals database migrated from v0.2.16 history`（CI 里用 v0.2.16 的迁移链建一个库，与基线库 `--schema-only` 归一化后完全相同）、`production schema dump matches the baseline`（用户提供的结构文件作夹具，归一化后比对；夹具里不含数据）、`mismatched schema refuses to start and prints the difference`、`migration ledger is rewritten once`。
- [ ] **Step 2–4:** 失败 → 实现 → 通过
- [ ] **Step 5: 提交**

### Task 27: 护栏收紧与上游痕迹清理

**范围：**
- 品牌护栏改成单一规则：源码与产物里出现验收搜索词即失败，放行只看依赖声明与 `THIRD-PARTY-NOTICES.md` 的版权段（按文件路径 + 精确文本登记）。删除不再需要的机制：`brand-budget.json` 与其测试、白名单的 `persisted-data`/`peer-protocol` 类、`new-lines.ts` 的上游同路径豁免、`EXEMPT_PATHS` 里的测试整体豁免与 `desktop/`；产物扫描默认全量、词表只剩第三方依赖名。
- 删除 `xiongbao/UPSTREAM.md`、`xiongbao/upstream-sync.json`、`xiongbao/scripts/integrate-upstream.ts`、`xiongbao/.github/workflows/upstream-upgrade.yml`、`xiongbao/docs/upstream-upgrades.md`（移到 Task 28 的运维仓库）。
- `xiongbao/NOTICE` 删除或改写为不提上游名；`THIRD-PARTY-NOTICES.md` 保留 `Copyright (c) 2026 CopilotKit` 与 MIT 原文，作为唯一许可证例外；`LICENSE` 是熊宝自己的许可（与用户确认文本，默认保持现有 MIT 加熊宝版权行）。
- `CHANGELOG.md` 重写为只讲熊宝版本史，删去上游历史条目。
- `scripts/rebrand/` 从产品仓库删除（搬到 Task 28）。

**特有测试：** 护栏测试新增 `old word anywhere outside the licence paragraph fails`（夹具里放一个 `openbot` 与一个 `copilotkit` 字样）、`licence paragraph is the only exception`；全仓 `git grep -niE 'openbot|open-bot|open_bot|open\.bot|copilotkit' -- xiongbao .github ':!**/package.json' ':!**/bun.lock'` 只剩导入 `@copilotkit/` 与许可证段。

### Task 28: 运维仓库与上游同步工具

**前置用户步骤：** 用户新建私有仓库 `canquedehuiyi-cpu/xiongbao-ops`（控制方用 `add_repo` 接入）。若用户不建，工具放旧仓库归档前的一个分支里，并在台账记裁定。

**Files（在运维仓库）：**
- Create: `rebrand/`（Task 2、3 的改名表、保护清单——只剩 `forever` 与「上游自有」排除项、改名工具、报告）、`sync/sync-upstream.ts`、`sync/state.json`（上游地址与同步点，产品仓库里不再出现）、`sync/README.md`
- Test: `sync/sync-upstream.test.ts`

**Interfaces:**
- Produces: `bun sync/sync-upstream.ts --upstream <git 地址> --target <上游提交> --product <产品仓库路径> [--dirs app,extension,shared,mobile,agent-*,api,tokens,management-agent,docs]`：取旧同步点树与目标树中 `--dirs` 范围 → 对两棵树套同一张改名表（内容 + 路径）→ 与产品仓库 `xiongbao/` 对应目录做三方合并（`git merge-file` 逐文件，或 `git merge-tree` 于临时仓库）→ 结果写到产品仓库的新分支 → 打印剩余旧词报告（改名表漏掉的新词）与冲突文件列表 → 更新 `state.json` 的同步点（只在用户确认合并后）。
- [ ] **Step 1: 写失败测试**：用夹具仓库模拟「上游旧点 / 上游新点 / 产品已改名」三棵树：`upstream change in a renamed file merges cleanly`、`upstream new word not in the map is reported`、`paths are renamed before merging`、`directories outside --dirs are ignored`。
- [ ] **Step 2–4:** 失败 → 实现 → 通过
- [ ] **Step 5: 提交到运维仓库**

### Task 29: 清理版发版

照 Task 24 的格式：版本号 0.2.17、CHANGELOG、升级单（v0.2.16 → v0.2.17：先看启动日志的结构比对通过；用户确认稳定后删除 `pre-rebrand-*.dump`、清掉旧回滚容器与旧 GHCR/JCR 标签）。用户推标签 → 盯流水线 → 京东云升级验证。

---

## R5：新仓库

### Task 30: 导出、首发、旧仓库归档

**前置：** v0.2.17 在京东云稳定。

**Files（运维仓库）：**
- Create: `export/export-clean-repo.sh`、`export/manifest.txt`（保留与排除清单）
- Test: `export/export-clean-repo.test.ts`

**Interfaces:**
- Produces: `export-clean-repo.sh <旧仓库路径> <输出目录>`：取旧仓库 main 的树（`git archive`），按 `manifest.txt` 排除（`archives/`、`*-REPORT.md`、`MIGRATION-RECOVERY.md`、`docs/plans/`、`docs/superpowers/`、本次规格与摸底、`CONTEXT.md` 里讲上游的段落另行改写），对结果跑验收搜索词，有命中就退出 1 并列出；全部通过后 `git init`、以用户本人为作者做一个首次提交（作者名与邮箱由用户在运行时以参数给出，不写进脚本）。
- `manifest.txt` 里 `docs/` 的逐文件去留清单先交用户过目。

- [ ] **Step 1: 写失败测试**：`a file with an old word blocks the export`、`excluded paths are absent from the output`、`output is a single commit by the given author`。
- [ ] **Step 2–4:** 失败 → 实现 → 通过
- [ ] **Step 5: 交用户的步骤**（每步都要用户同意再做）：① 用户确认去留清单；② 控制方运行导出并经用户同意推到 `canquedehuiyi-cpu/xiongbao`；③ 新仓库配置清单：Environments `release`、`model-e2e`、`ocr-review` 的 secrets 与变量（名字列全，值用户自己填）、分支保护、GHCR 包、JCR 同步；④ 新仓库全量 CI → 发 rc → 京东云从新镜像升级验证；⑤ 用户把旧仓库改私有并归档，旧 GHCR 包与 Release 资源改私有或删除；⑥ 以后开发在新仓库。

---

## 控制方裁定（实施时可推翻）

1. **只在「用户已有状态」上做双认**：现网只有用户自己一套，服务器、网页、扩展、runner、设备端在 v0.2.16 一起换。因此只有落在用户手里的东西做新旧双认（环境变量、设备端 ↔ 服务器在升级间隙、浏览器本地存储、数据库与历史数据）；托管 Bot 头、错误码、扩展消息等同版本一起发的名字直接改，不双认。规格 §4 写「对外名字写新读双」，此处收窄。若错：某个未同时升级的组件在升级间隙连不上，重新安装同版即可恢复。
2. **备份放数据库卷**：规格 §12.8 写服务器本地 `/opt/xiongbao/backup/`，但迁移在容器里执行、容器只挂了 `database/workspace/profiles` 三个卷；改放 `/var/lib/postgresql/backup/`（数据库卷上，容器替换后仍在），升级单里给 `docker cp` 取出命令。若错：用户要在宿主机另找备份时多一步拷贝。
3. **R1 按目录分 PR、包名单独一个 PR**：`@openbot/` 导入跨所有工作区，必须一次改完才能编译；其它标识符按目录切，每个 PR 自身编译与测试全绿。
4. **工具先放产品仓库 `scripts/rebrand/`，R4 搬到运维仓库**：R1–R3 每个任务都要用它；搬走前它本身就是旧词最多的文件，R4 Task 27 删除时一并处理。
