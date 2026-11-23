# 交付即可用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 员工做完活，人在单聊和群聊里点一下就能下载、在侧栏预览产物，网页和运行中的程序能直接打开用，「交付了」必有实物。

**Architecture:** 电脑端新增 stat、一轮快照对比、Office 转 PDF、端口转发；服务器每轮首尾调快照，差异存成一条自定义运行事件，并按单聊本人、群成员、交付卡三种规则放行下载预览；网页和程序只由独立「内容源」提供，令牌换 HttpOnly cookie；证据门经网关查实物。

**Tech Stack:** Bun + Hono + drizzle（server）、Bun（agent-computer）、React + TanStack Router（app）、bun test、Playwright（评测）。

**Spec:** `docs/specs/2026-11-23-deliverables-ready.md`（先读规格；路径相对 `xiongbao/`，`docs/`、`.github/` 在上一级仓库根）。

## Global Constraints

- 提交信息用中文，结尾两行：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`、`Claude-Session: https://claude.ai/code/session_01MJUqVcFToyopKbNJ4sEoWY`。各 Task 的「提交」步骤都按此办。
- 新增代码和注释不出现 "copilotkit"/"openbot" 字样，不新增 `@openbot/...` 导入行（`shared/` 用相对路径导入），品牌预算不涨。
- 全仓必须过：`bunx biome lint --error-on-warnings --diagnostic-level=warn .`、`bun run typecheck:tests`、server tsc（`NODE_OPTIONS=--max-old-space-size=8192`）。
- 不改现有断言，除非规格要求；要改的只有 Task 1 列出的期望（及用户批准后的提示预算上限）。
- 给模型看的文字用中文，守 `server/tests/prompt-budget.test.ts`。
- 需要数据库的测试用 initdb 临时实例（照 `server/tests/delivery-tools.integration.test.ts` 开头）。新增 server、app 测试文件后跑 `bun run test:shards` 更新清单并一并提交。
- 规格定死的值：`XIONGBAO_CONTENT_PORT`、`XIONGBAO_CONTENT_DOMAIN`；令牌 30 分钟、打开状态下自动续；`/__open/<令牌>`；快照最多扫 20,000 个文件、只记前 200 个产物、超了注明截断；交付项 `{ kind: "app", port, path?, title }`；转发端口 1024–65535；文本预览前 1MB；Office 转 PDF 缓存在工作区隐藏目录、按源文件修改时间失效；下载保持 `attachment` 不放宽；所有访问需登录，只有能看这段对话的人能看。
- 每期末先跑一遍上面的 lint、`typecheck:tests`、server tsc 与 `bun run test:shards`，再合成一个 PR、CI 全绿合入。测试从仓库根 `xiongbao/` 跑 `bun test <路径>`；app 测试 `cd app && bun test tests/<文件>`。

## Review Focus

规格没点名、各 Task 测试之外最可能咬到人的情形（括号为落测试的 Task）：

1. 文件名带空格、中文、`#`、`?`、`%`：下载、预览、打开的地址编码后路径一致，不 404（Task 7、8、15）。
2. 符号链接指向工作区外或别的员工目录：快照不列、下载预览不可达、静态目录不能借它逃出（Task 2、5、15）。
3. 工作区超 20,000 个文件或本轮新增超 200 个：事件带截断标记，界面说「没列全」，不崩（Task 5、8）。
4. 令牌过期、人被移出群、员工被删后：旧链接和已发 cookie 都 404，已开 WebSocket 断开（Task 16、19）。
5. 独立端口下浏览器 cookie 不按端口隔离：应用 cookie 会带到内容端口，程序也能往同主机写 cookie。内容源不读不转发应用 cookie，不放行程序 `Set-Cookie`（域名模式放行但去 `Domain`）（Task 16、19）。

---

## 期 1：审批默认关 + 证据门查实物 + 员工侧提示（服务器）

### Task 1: 「改动之前先问」首次授工具时不再默认开

**Files:**
- Modify: `server/src/plugins/personal-defaults.ts`（约 875 行 `askBeforeChangesFirst`）、`CHANGELOG.md`
- Modify: `server/tests/personal-defaults-boundaries.integration.test.ts`、`personal-defaults-scope.integration.test.ts`、`personal-defaults.integration.test.ts`（先 `grep -n "approval_preferences\|askBefore\|settings_changed"`，同类期望一并改）

**Interfaces:**
- Produces: 首次授工具不再写 `approval_preferences` 行（`askBeforeChangesFirst?.()` 三处调用不动）；已有行保留，无迁移。

要改的期望（逐条写进 PR）：boundaries 343 行 `toBe(true)` 改 `not.toBe(true)`，其后查 `approval.settings_changed` 审计行的断言改为「没有该事件」；scope 315、331、339 行 `[{ enabled: true }]` 改 `[]`；347 行不动。

- [ ] **Step 1: 改期望并追加**

```ts
test("a person who turned it on keeps it on", async () => {
  await asOwner(() => approvals.policy?.setPreferences(OWNER, { enabled: true }));
  await asOwner(() => store.listForAgent(BOT));
  expect(await preference()).toBe(true);
});
```
- [ ] **Step 2:** `bun test server/tests/personal-defaults-boundaries.integration.test.ts server/tests/personal-defaults-scope.integration.test.ts`，期望新期望 FAIL。
- [ ] **Step 3:** 删掉该工厂实现、改文件头说明，不动表默认值（本来 false）。CHANGELOG：新员工默认不再逐条询问写文件/跑命令，底线（删除、对外发送、危险命令、敏感路径）照问，要逐条问的人在「设置 → 审批」打开，已有设置不动。
- [ ] **Step 4:** 跑 Step 2 的命令（及上面追加的既有测试），期望 PASS。
- [ ] **Step 5:** 提交。

### Task 2: 电脑端 stat、网关 `statFile`，证据门对 `workspace_file` 查实物

**Files:**
- Create: `agent-computer/tests/workspace-stat.test.ts`（照 `workspace-download.test.ts`）、`server/src/tasks/file-evidence.ts`、`server/tests/file-evidence.test.ts`
- Modify: `agent-computer/src/workspace.ts`（`stat`）、`agent-computer/src/index.ts`（`/files/list` 旁加 `POST /files/stat`）、`server/src/computer/gateway.ts`（照 `listFiles` 用内部 `post`，不走 `govern`）、`server/src/tasks/evidence-gate.ts`、`delivery-tools.ts`（421 行传 `agentId`）、`server/src/index.ts`（3095 行传探针）、`projector.ts`（`DeliverableRef.unverifiedFiles?: string[]`）、`app/src/lib/tasks/delivery.ts`（`workspace_file` 行加 `unverified?: boolean`）、追加 `server/tests/delivery-tools.integration.test.ts`

**Interfaces:**
- Produces（电脑端）: `Workspace.stat(requested: string): Promise<{ path: string; kind: "file" | "folder"; bytes: number; modifiedMs: number }>`，用 `resolvePath(requested, false)`，不存在抛 `WorkspaceFileNotFoundError`，越界（含符号链接）抛 `WorkspacePathError`；路由 `POST /files/stat {path}` 成功 200 同结构。
- Produces（服务器）: `gateway.statFile(seat: ComputerSeat, i: { path: string }, signal?: AbortSignal): Promise<{ kind: "file" | "folder"; bytes: number } | "absent" | null>`（`null` = 设备 seat，核不了）；`type FileProbe = (i: { tenantId: string; agentId: string; path: string }) => ReturnType<ComputerGateway["statFile"]>`；`verifyWorkspaceFiles(i: { tenantId: string; agentId: string; paths: readonly string[]; probe: FileProbe }): Promise<{ failures: { path: string; reason: "missing" | "empty" }[]; unverified: string[] }>`；`createEvidenceGate(database, options?: { fileProbe?: FileProbe })`，`checkEvidence` 入参加 `agentId`，缺省探针则跳过。
- 挡回：`工作区文件「<名>」不存在或是空的，先把它真正存到工作区再交。`（`missing: [名]`）；目录视为存在。

- [ ] **Step 1: 写失败测试**

```ts
test("stat reports size; links and .. are refused", async () => {   // agent-computer
  await writeFile(join(root, "a.pptx"), Buffer.alloc(10)); await symlink(join(outside, "secret.txt"), join(root, "l.txt"));
  expect(await workspace().stat("a.pptx")).toMatchObject({ kind: "file", bytes: 10 });
  await expect(workspace().stat("l.txt")).rejects.toBeInstanceOf(WorkspacePathError);
});
test("missing vs empty; device seat unverified", async () => {        // server
  const probe: FileProbe = async ({ path }) => path === "a" ? { kind: "file", bytes: 5 } : path === "z" ? { kind: "file", bytes: 0 } : "absent";
  expect((await verifyWorkspaceFiles({ ...base, paths: ["a", "z", "n"], probe })).failures).toEqual([{ path: "z", reason: "empty" }, { path: "n", reason: "missing" }]);
  expect((await verifyWorkspaceFiles({ ...base, paths: ["a"], probe: async () => null })).unverified).toEqual(["a"]);
});
```
集成追加：探针答 `"absent"` 时 `deliver_task` 结果 `bounced === true`、`missing` 含该路径、卡状态不变；存在时 `delivered === true`。
- [ ] **Step 2:** `bun test agent-computer/tests/workspace-stat.test.ts server/tests/file-evidence.test.ts`，期望 FAIL。
- [ ] **Step 3:** 电脑端实现 `stat` 与路由（一次 stat 系统调用，不读内容）。
- [ ] **Step 4:** 服务器实现 `statFile`、`verifyWorkspaceFiles`（并发上限 4），在 `workspaceFilePathOf` 通过后调用，`unverified` 写进 `ref.unverifiedFiles`。
- [ ] **Step 5:** 上述两个测试加 `agent-computer/tests/workspace-download.test.ts`、`delivery-tools.integration.test.ts`，期望 PASS。
- [ ] **Step 6:** 提交。

### Task 3: 只有 `note` 却提到实物词，第一次挡回

**Files:**
- Create: `server/src/tasks/physical-gate.ts`（照 `fastpath-gate.ts`）、`server/tests/physical-gate.test.ts`
- Modify: `server/src/tasks/delivery-tools.ts`（证据门与快路径核对之后、`delivered` 之前）

**Interfaces:**
- Produces: `PHYSICAL_GATE_ENV = "XIONGBAO_PHYSICAL_GATE"`（`off` 关，默认开）；`PHYSICAL_BOUNCE_KEY = "physicalDeliverableBounce"`；`NO_FILE_PHRASE = "这件活没有文件产物"`；`PHYSICAL_WORDS = ["文件","网页","程序","PPT","文档","表格","视频","图片"]`；`uncheckedPhysical(i: { items: readonly DeliveryItem[]; criteria: string | null; title: string | null; messages: readonly unknown[] }): boolean`（真 = 应挡回；`title` 取卡标题，没有传 null）；`physicalBounceReason(): string` =「只给了文字结论，但这件活要的是实物。把产物存成文件放在工作区，用 workspace_file 交付；确实没有文件产物，就在 note 里写「这件活没有文件产物」。」
- 规则：items 全是 `note`、criteria/title/item 标题含实物词、note 不含 `NO_FILE_PHRASE`、最后一条用户消息之后的历史没有 `PHYSICAL_BOUNCE_KEY`，才挡回；结果 JSON 带该键为 true，卡不动。

- [ ] **Step 1: 写失败测试**

```ts
const note = [{ kind: "note", ref: "已完成" }] as const;
test("bounces once, not again after its own bounce", () => {
  expect(uncheckedPhysical({ items: note, criteria: "做一份PPT", title: null, messages: [] })).toBe(true);
  const messages = [{ role: "user", content: "做" }, { role: "tool", content: JSON.stringify({ bounced: true, [PHYSICAL_BOUNCE_KEY]: true }) }];
  expect(uncheckedPhysical({ items: note, criteria: "PPT", title: null, messages })).toBe(false);
});
// 另测：NO_FILE_PHRASE 放行；上一轮的标记不算；带 workspace_file 不挡
```
- [ ] **Step 2:** `bun test server/tests/physical-gate.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现，读历史照 `fastpath-gate.ts` 的 `Turn` 类型。
- [ ] **Step 4:** 跑 Step 2 的命令（及上面追加的既有测试），期望 PASS。
- [ ] **Step 5:** 提交。

### Task 4: 员工侧提示

**Files:**
- Create: `server/tests/delivery-prompt-files.test.ts`
- Modify: `server/src/tasks/delivery-tools.ts`（`HAND_IN_WITH_FILES`、`deliver_task` 说明约 395 行）、`server/src/agents/prompt-slim.ts`（231 行）；超限才改 `prompt-budget.test.ts`

**Interfaces:**
- Produces: 两处各加一句（`app` 等 Task 20 再补）：`交付的是文件/网页就把它存在工作区里，作为 workspace_file 交付；不要只把内容贴在对话里。确实没有文件产物，就在 note 里写「这件活没有文件产物」。`

- [ ] **Step 1: 写失败测试**：`deliveryProtocolGuidance` 输出与 `TOOL_BRIEFS` 交付条目都含 `不要只把内容贴在对话里` 与导入的 `NO_FILE_PHRASE`。
- [ ] **Step 2:** `bun test server/tests/delivery-prompt-files.test.ts`，期望 FAIL。
- [ ] **Step 3:** 加句，跑 `prompt-budget.test.ts`；超限先压缩措辞，仍超就停下请用户批准上调（该测试注释有先例），不自行改上限。
- [ ] **Step 4:** 跑 Step 2 的命令（及上面追加的既有测试），期望 PASS。
- [ ] **Step 5:** 提交。

**期 1 收尾：** 本期合成一个 PR、CI 全绿合入。

---

## 期 2：产物登记与下载（服务器 + 界面）

### Task 5: 电脑端一轮文件快照与对比

**Files:**
- Create: `shared/turn-artifacts.ts`、`agent-computer/tests/workspace-turn-changes.test.ts`
- Modify: `agent-computer/src/workspace.ts`（复用 `walkTree`）、`agent-computer/src/index.ts`（`/files/mark`、`/files/changes`）

**Interfaces:**
- Produces（`shared/turn-artifacts.ts`）：`TURN_ARTIFACTS_EVENT = "computer.turn_artifacts"`；`ARTIFACT_SCAN_LIMIT = 20_000`；`ARTIFACT_LIST_LIMIT = 200`；`ARTIFACT_IGNORED_FOLDERS = ["tool-outputs","node_modules","__pycache__",".git"] as const`；`isIgnoredArtifactPath(path: string): boolean`（任一段在清单里或以 `.` 开头）；`type TurnArtifact = { path: string; bytes: number; modifiedMs: number; change: "new" | "modified" }`；`type TurnArtifactsValue = { botId: string; seat: string; files: TurnArtifact[]; scanned: number; scanTruncated: boolean; omitted: number }`。
- `Workspace.mark(markId: string): Promise<{ scanned: number; scanTruncated: boolean }>`；`Workspace.changedSince(markId: string): Promise<{ files: TurnArtifact[]; scanned: number; scanTruncated: boolean; omitted: number } | null>`（mark 不存在如电脑重启 → `null`）。路由 `POST /files/mark {mark}`、`POST /files/changes {mark}`。
- 实现：快照存 `Workspace` 实例的 Map（`path → size+mtimeMs`，最多 50 个 mark），`changedSince` 重扫对比后删该 mark；不记 0 字节文件、删掉的、符号链接；扫描上限做成 `createWorkspace` 可选参数供测试调小。

- [ ] **Step 1: 写失败测试**

```ts
test("new, modified, untouched", async () => {
  const ws = workspace(); await writeFile(join(root, "old.txt"), "a"); await writeFile(join(root, "keep.txt"), "k");
  await ws.mark("r1"); await writeFile(join(root, "deck.pptx"), "x".repeat(50)); await writeFile(join(root, "old.txt"), "ab");
  expect((await ws.changedSince("r1"))?.files.map((f) => [f.path, f.change]).sort()).toEqual([["deck.pptx", "new"], ["old.txt", "modified"]]);
});
// 另测：tool-outputs/、隐藏目录、0 字节文件、指向外面的符号链接不列；205 个变化列 200、omitted 5；扫描上限 10 时 scanTruncated；未知 mark 为 null
```
- [ ] **Step 2:** `bun test agent-computer/tests/workspace-turn-changes.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令（及上面追加的既有测试），期望 PASS。
- [ ] **Step 5:** 提交。

### Task 6: 服务器每轮首尾记产物事件（单聊、群聊同一处）

**Files:**
- Create: `server/src/computer/turn-artifacts.ts`、`server/tests/turn-artifacts.test.ts`
- Modify: `server/src/computer/gateway.ts`、`server/src/copilot.ts`（约 2832 行 `observe`，在 `withRunSideEvents` 内层包一层）、`server/src/index.ts`（传网关与取 seat 的函数）

**Interfaces:**
- Produces: `gateway.markTurn(seat: ComputerSeat, markId: string, signal?: AbortSignal): Promise<void>`；`gateway.turnChanges(seat: ComputerSeat, markId: string, signal?: AbortSignal): Promise<{ files: TurnArtifact[]; scanned: number; scanTruncated: boolean; omitted: number } | null>`（内部 `post`，不走 `govern`；设备 seat 空操作/`null`）；
  `withTurnArtifacts(stream: Observable<BaseEvent>, turn: { runId: string; botId: string; seat: () => Promise<ComputerSeat | null> }, gateway: Pick<ComputerGateway, "markTurn" | "turnChanges">): Observable<BaseEvent>`：订阅时后台 `markTurn`（失败只打日志）；遇 `RUN_FINISHED` 先 `await turnChanges`，有文件就在它前面插一条 `CUSTOM` 事件 `{ name: TURN_ARTIFACTS_EVENT, value: TurnArtifactsValue }`（`seat` 用 `computerKeyText(seat.key)`）；`RUN_ERROR`/中止不插；事件给人看，不进 `isServerOnlyEvent`。
- 取 seat 照 `toolsForTurn` 同款（这一轮的 `ownerUserId`，群聊按发言员工各自的 `botId`）；先确认单聊、群聊、看板都经过 `observe`。交付后一轮即结束（`XIONGBAO_DELIVER_ENDS_TURN`），轮末对比已覆盖「交付时」。

- [ ] **Step 1: 写失败测试**（rxjs `of` 造流，网关用桩）

```ts
test("one artifacts event before RUN_FINISHED", async () => {
  const out = await collect(withTurnArtifacts(of(started, finished), turn, gw({ files: [{ path: "a.pptx", bytes: 9, modifiedMs: 1, change: "new" }], scanned: 3, scanTruncated: false, omitted: 0 })));
  expect(out.map((e) => e.type)).toEqual(["RUN_STARTED", "CUSTOM", "RUN_FINISHED"]);
  expect(out[1]).toMatchObject({ name: "computer.turn_artifacts", value: { botId: "bot-1", files: [{ path: "a.pptx" }] } });
});
// 另测：无变化、网关抛错、设备 seat、RUN_ERROR 都不插事件，也不让这一轮失败
```
- [ ] **Step 2:** `bun test server/tests/turn-artifacts.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现并接进 `observe`。
- [ ] **Step 4:** 跑 Step 2 的命令（及上面追加的既有测试），期望 PASS。
- [ ] **Step 5:** 提交。

### Task 7: 产物访问规则与下载路由

**Files:**
- Create: `server/src/computer/artifact-access.ts`、`server/tests/artifact-access.test.ts`、`server/tests/artifact-access.integration.test.ts`（initdb，真实群频道与两个成员：成员能取、非成员 404）
- Modify: `server/src/computer/routes.ts`（140–170 行守卫；808 行 `files/download`）、`server/src/index.ts`（依赖传进 `createComputerRoutes`）、追加 `server/tests/computer-download-routes.test.ts`

**Interfaces:**
- Produces: `type ArtifactScope = { channel?: string; run?: string; task?: string }`（查询参数同名）；`ArtifactAccessDeps = { channelFor(actor: AgentActor, channelId: string): Promise<{ agentIds: string[]; threadIds: string[] } | null>; runEvents(runId: string): Promise<BaseEvent[]>; cardFor(actor: AgentActor, taskId: string): Promise<{ botId: string; seat: string; workspaceFiles: string[] } | null> }`；`resolveArtifactAccess(i: { actor: AgentActor; botId: string; path: string; scope: ArtifactScope }, deps: ArtifactAccessDeps): Promise<{ seat: ComputerSeat } | null>`。
- 规则：无 scope = 现状（`canUseBot` + `seatFor(botId, actor.id)`）。`channel`+`run`：`channelFor` 非 null（能看这段对话，群聊即成员）且 `botId` 在 `agentIds`；run 属于该频道线程（照 `evidence-gate.ts` 的 `attachmentsInThread`）；run 事件里 `computer.turn_artifacts`（同 `botId`）列了此 `path`，或 `delivery.delivered` 的 `workspaceFiles` 含它；seat 用事件里的 `seat` 文本经 `parseComputerKey` 还原。`task`：卡可见、`path` 在 `workspaceFiles`、负责员工是 `botId`。不满足一律 `null`，路由答 404（同「没有此员工」）。
- 路由：有 scope 时守卫跳过 `canUseBot`，用其 seat 调 `gateway.downloadFile`；治理审计与 `downloadHeaders` 不变。

- [ ] **Step 1: 写失败测试**

```ts
test("a group member gets the seat of the run that announced the path", async () => {
  expect((await resolve({ path: "a.pptx", scope }))?.seat.key).toEqual({ kind: "person", personId: "owner-1" });
});
// 另测：没声明的路径、非成员、别的频道的 run 都为 null；交付卡的文件经 task 可达；'报告 #1?.pptx' 原样匹配
```
路由追加：带 `channel`、`run` 时响应头仍是 `application/octet-stream` + `attachment`；规则为 null 时 404 且网关未被调用。
- [ ] **Step 2:** `bun test server/tests/artifact-access.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令（及上面追加的既有测试），期望 PASS。
- [ ] **Step 5:** 提交。

### Task 8: 「本轮产物」读事件，带下载按钮（单聊、群聊）

**Files:**
- Modify: `app/src/lib/computers/artifact.ts`（加 `artifactHref`，原 `artifactDownloadHref` 不动）、`app/src/components/channels/turn-artifacts.tsx`（`turnArtifactNotes` 优先读事件）
- Create: `app/tests/turn-artifacts-event.test.tsx`

**Interfaces:**
- Consumes: `TURN_ARTIFACTS_EVENT`/`TurnArtifactsValue`（相对路径导入 `shared/turn-artifacts`）。
- Produces: `artifactHref(i: { botId: string; path: string; scope?: { channel: string; run: string } | { task: string } }): string | undefined`（`/api/computers/<bot>/files/download?path=…` 后接 `&channel=&run=` 或 `&task=`；路径经 `normalizedArtifactPath` 与 `encodeURIComponent`）；`turnArtifactEvents(messages): { runId: string; value: TurnArtifactsValue }[]`。
- 有事件按事件画（群聊按事件里 `botId` 各出链接）：每行文件名、大小、下载；`omitted>0` 写「这一轮还有 N 项没列出」，`scanTruncated` 写「工作区文件太多，这份清单可能没列全」；没有事件退回 `writtenPathsInTurn`。预览按钮 Task 13 加。

- [ ] **Step 1: 写失败测试**

```tsx
test("a script-made file gets a download link", () => {
  render(<Notes messages={[eventMsg({ botId: "b1", seat: "person:u1", files: [{ path: "out/报告 #1.pptx", bytes: 2048, modifiedMs: 1, change: "new" }], scanned: 4, scanTruncated: false, omitted: 0 })]} />);
  expect(screen.getByRole("link", { name: /下载/ }).getAttribute("href")).toBe("/api/computers/b1/files/download?path=out%2F%E6%8A%A5%E5%91%8A%20%231.pptx&channel=c1&run=r1");
});
// 另测：omitted、scanTruncated 的两句话；无事件退回老行为
```
- [ ] **Step 2:** `cd app && bun test tests/turn-artifacts-event.test.tsx`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令（及上面追加的既有测试），期望 PASS。
- [ ] **Step 5:** 提交。

### Task 9: 交付卡 `workspace_file` 行的下载按钮，交付事件补员工 id

**Files:**
- Modify: `server/src/tasks/delivery-tools.ts`（两处 `said(... delivered ...)` 的 value 加 `agentId`）、`server/src/channels/group.ts`（交付标记带 `agentId`）、`app/src/skins/xiongbao/delivery-chat.tsx`（`ChatDeliveryEvent`、`EvidenceItem`）、`app/src/routes/_authed/_app/tasks.$taskId.tsx`、`app/src/lib/tasks/delivery.ts`（改掉「另票再接」注释）、追加 `server/tests/delivery-events.test.ts`
- Create: `app/tests/delivery-evidence-download.test.tsx`

**Interfaces:**
- Produces: `delivery.delivered` 事件 value 增 `agentId: string`；`ChatDeliveryEvent.agentId?: string`（旧事件无，按无按钮画）。`workspace_file` 行有 `agentId` 出「下载」（`artifactHref({ botId: agentId, path, scope: { task: taskId } })`），`unverified` 时文件名后写「未核实」；任务页用卡的负责员工 id。

- [ ] **Step 1: 写失败测试**

```tsx
test("workspace_file row downloads through its card; no agentId, no button; unverified says 未核实", () => {
  expect(screen.getByRole("link", { name: "下载" }).getAttribute("href")).toBe("/api/computers/bot-1/files/download?path=reports%2Fa.xlsx&task=t1");
});
```
服务器：`expect(delivered.value).toMatchObject({ taskId: "t1", agentId: "bot-1" })`。
- [ ] **Step 2:** 跑两个测试，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** `bun test server/tests/delivery-events.test.ts server/tests/delivery-chat-replay.integration.test.ts` 与 `cd app && bun test tests/delivery-evidence-download.test.tsx`，期望 PASS。
- [ ] **Step 5:** 提交。

**期 2 收尾：** 界面有改动：**推送前截图给用户确认**（单聊、群聊「本轮产物」清单与交付卡下载按钮）。本期合成一个 PR、CI 全绿合入。

---

## 期 3：侧栏预览（界面 + 服务器 + 电脑端）

### Task 10: 电脑端 Office 转 PDF

**Files:**
- Create: `agent-computer/src/office-preview.ts`、`agent-computer/tests/office-preview.test.ts`
- Modify: `agent-computer/src/index.ts`（`POST /files/pdf`）

**Interfaces:**
- Consumes: Task 2 的 `Workspace.stat`（取 `modifiedMs`）；`commandsFor(seat)` 的 `CommandRunner`（员工用户身份）。
- Produces: `PREVIEW_CACHE_DIR = ".xb-preview"`（隐藏目录，快照已忽略）；`pdfCachePath(source: string, mtimeMs: number): string` = `.xb-preview/<sha1(source)前16位>-<取整mtime>.pdf`；`convertToPdf(i: { workspace: Workspace; run: CommandRunner; path: string; soffice?: string }): Promise<{ path: string; cached: boolean } | { unavailable: true }>`：缓存在则返回，否则经员工的 `run` 跑 `soffice --headless --convert-to pdf --outdir <缓存目录> <源>`，超时 60 秒；无 `soffice` 返回 `{ unavailable: true }`。路由 `POST /files/pdf {path}`。

- [ ] **Step 1: 写失败测试**（`CommandRunner` 用桩）

```ts
test("an edit changes the cache path", () => expect(pdfCachePath("a.pptx", 1)).not.toBe(pdfCachePath("a.pptx", 2)));
test("second call is a cache hit; no soffice is unavailable; a path outside the workspace is refused before any command", async () => { /* run 调用次数 */ });
```
- [ ] **Step 2:** `bun test agent-computer/tests/office-preview.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令，期望 PASS。
- [ ] **Step 5:** 提交。

### Task 11: 预览类型、内联响应头与服务器预览路由

**Files:**
- Create: `shared/preview-kind.ts`、`tests/preview-kind.test.ts`、`server/tests/computer-preview-routes.test.ts`（照 `computer-download-routes.test.ts`）
- Modify: `shared/file-download.ts`（只追加，`downloadHeaders` 不动）、`server/src/computer/gateway.ts`（`previewPdf`）、`server/src/computer/routes.ts`（`GET /:botId/files/preview`、`/files/text`，同样用 Task 7 的 `resolveArtifactAccess`）

**Interfaces:**
- Consumes: Task 10 的 `/files/pdf`。
- Produces（共用）: `type PreviewKind = "image" | "video" | "audio" | "pdf" | "html" | "markdown" | "csv" | "text" | "office" | "none"`；`previewKindOf(path: string): PreviewKind`（按扩展名不分大小写；图片仅 png/jpg/jpeg/gif/webp，**svg 归 `"none"`**；office 为 pptx/docx/xlsx 及 ppt/doc/xls/odp/odt/ods；代码与纯文本归 `"text"`）；`TEXT_PREVIEW_BYTES = 1_048_576`；`previewContentType(path: string): string | undefined`；`inlineHeaders(name: string, bytes: number, contentType: string): Record<string, string>`：`Content-Disposition: inline; …`（沿用 `contentDisposition` 转义）、`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`、`Content-Security-Policy: sandbox allow-scripts; default-src 'none'; img-src data: blob: 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`（不含 `allow-same-origin`）。
- Produces（服务器）: `gateway.previewPdf(seat, actor, i: { path: string }, signal?): Promise<{ body: ReadableStream<Uint8Array>; bytes: number } | { unavailable: true }>`（走 `govern("computer_download_file", …)`）。`GET /api/computers/:botId/files/preview?path=&channel=&run=&task=`：image/video/audio/pdf/html 用 `downloadFile` 流 + `inlineHeaders`；office 走 `previewPdf` 按 `application/pdf` 内联；markdown/csv/text/none 415；`unavailable` 答 200 `{ unavailable: true }`。`GET …/files/text` 答 `{ kind: "markdown" | "csv" | "text"; text: string; truncated: boolean; bytes: number }`，只读前 `TEXT_PREVIEW_BYTES` 字节后取消流，`TextDecoder("utf-8", { fatal: false })`；非文本类 415。

- [ ] **Step 1: 写失败测试**

```ts
test("kinds and inline headers", () => {
  expect(previewKindOf("a/b.PPTX")).toBe("office"); expect(previewKindOf("x.svg")).toBe("none");
  const h = inlineHeaders("a.html", 3, "text/html; charset=utf-8");
  expect(h["Content-Security-Policy"]).toStartWith("sandbox allow-scripts"); expect(h["Content-Security-Policy"]).not.toContain("allow-same-origin");
  expect(h["X-Content-Type-Options"]).toBe("nosniff"); expect(h["Content-Disposition"]).toStartWith("inline;");
});
test("text stops at 1MB and says truncated", async () => {
  const body = await (await get("big.txt", "text")).json();
  expect(body.truncated).toBe(true); expect(body.text.length).toBeLessThanOrEqual(1_048_576);
});
// 另测：html 内联且沙箱、svg 415；office 答 application/pdf 或 {unavailable:true}；访问规则为 null 时 404 且不碰网关
```
- [ ] **Step 2:** `bun test tests/preview-kind.test.ts server/tests/computer-preview-routes.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现共用的 `shared/preview-kind.ts` 与 `inlineHeaders`。
- [ ] **Step 4:** 实现 `previewPdf` 与两条路由。
- [ ] **Step 5:** 同命令加 `agent-computer/tests/file-download-http.test.ts`，期望 PASS。
- [ ] **Step 6:** 提交。

### Task 12: 预览面板组件

**Files:**
- Create: `app/src/components/channels/artifact-preview.tsx`、`app/src/lib/computers/preview.ts`、`app/tests/artifact-preview.test.tsx`

**Interfaces:**
- Produces: `type PreviewTarget = { botId: string; path: string; scope: { channel: string; run: string } | { task: string } }`；`encodePreview(t: PreviewTarget): string` / `decodePreview(v: string | undefined): PreviewTarget | undefined`（`base64url(JSON)`，坏值 `undefined`）；`<ArtifactPreview target={PreviewTarget} onClose={() => void} />`：image→`<img>`、video/audio→原生标签、pdf/office/html→`<iframe sandbox="allow-scripts">`（**不含 allow-same-origin**，src 指 Task 11 的 `/files/preview`）、markdown/csv/text→请求 `/files/text` 以纯文本或表格显示（不执行）；`unavailable`、`none`、415 画「预览不了这个类型」+「下载」；顶栏：下载、关闭、「在新标签页打开」（同一 `/files/preview` 地址）。

- [ ] **Step 1: 写失败测试**

```tsx
test("preview param round-trips; a bad value is undefined", () => {
  const t = { botId: "b", path: "a b/#.pdf", scope: { channel: "c", run: "r" } };
  expect(decodePreview(encodePreview(t))).toEqual(t); expect(decodePreview("%%")).toBeUndefined();
});
test("html/office iframe sandbox is exactly allow-scripts", () => expect(iframe.getAttribute("sandbox")).toBe("allow-scripts"));
// 另测：文本里的 <b>x</b> 显示为文字；svg 只给下载
```
- [ ] **Step 2:** `cd app && bun test tests/artifact-preview.test.tsx`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令，期望 PASS。
- [ ] **Step 5:** 提交。

### Task 13: DetailPanel 第三种内容「预览」，各入口点开（单聊、群聊）

**Files:**
- Modify: `app/src/routes/_authed/_app/channel/$channelId.tsx`（46 行 `chatSearchSchema` 加 `preview`；148 行 `DetailPanel` 的 `open`/`detail`/`title`/`detailWidth`）、`app/src/routes/_authed/_app/group/$channelId.tsx`（33 行 `validateSearch`；131 行 `DetailPanel` 现为 `open={false}`，接上 `detail`）、`app/src/components/channels/turn-artifacts.tsx`、`app/src/skins/xiongbao/delivery-chat.tsx`、`app/src/skins/xiongbao/conversation-sidebar/outputs.tsx`（三处加「预览」）、`app/src/lib/computers/preview.ts`
- Create: `app/tests/detail-panel-preview.test.tsx`（照 `detail-panel.test.tsx`）

**Interfaces:**
- Produces: 两路由 search 支持 `preview?: string`；`usePreviewTarget(): { target: PreviewTarget | undefined; open(t: PreviewTarget): void; close(): void }`（读写当前路由 `preview` 参数；打开时清 `watch`/`settings`，互斥）；`PREVIEW_PANEL_WIDTH = 560`。

- [ ] **Step 1: 写失败测试**

```tsx
test("?preview opens the pane in a single chat and in a group; a malformed param leaves it closed", () => { /* 两路由 */ });
test("opening a preview closes the live screen; clicking 预览 on a turn-artifact row sets the param", () => { /* ... */ });
```
- [ ] **Step 2:** `cd app && bun test tests/detail-panel-preview.test.tsx`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令（及上面追加的既有测试），期望 PASS。
- [ ] **Step 5:** 提交。

**期 3 收尾：** 界面**推送前截图给用户确认**（图片、PDF、HTML、PPT 转 PDF、文本，单聊与群聊）。本期合成一个 PR、CI 全绿合入。

---

## 期 4：内容源与静态网页访问（服务器，含安全审查）

### Task 14: 配置与令牌

**Files:**
- Create: `server/src/content/token.ts`、`server/tests/content-config.test.ts`、`server/tests/content-token.test.ts`
- Modify: `server/src/config.ts`（`DeploymentConfig.content`，解析照 `chatServerComputerToolsEnabled`「写错就抛」，挂进 `loadConfig`）

**Interfaces:**
- Produces: `DeploymentConfig.content: { port?: number; domain?: string }`。`XIONGBAO_CONTENT_PORT`：整数 1024–65535，不等于 `serverPort`/`appPort`，未设 = 不开独立端口；`XIONGBAO_CONTENT_DOMAIN`：不带协议、端口的主机名，写错抛错；都设时域名优先。
  `OPEN_TOKEN_TTL_MS = 30 * 60_000`；`type ContentTarget = { kind: "dir"; path: string } | { kind: "app"; port: number; path: string }`；`type ContentGrant = { person: string; bot: string; seat: string; channel?: string; run?: string; task?: string; target: ContentTarget; exp: number }`；`issueOpenToken(g: ContentGrant, key: string): string`、`readOpenToken(t: string | undefined, key: string, now: number): ContentGrant | null`（`auth/signed-value.ts` 的 `sign`/`verify`，label `"content-open"`，值 `base64url(JSON)`，过期 null）；`renewedGrant(g: ContentGrant, now: number): ContentGrant`（`exp = now + OPEN_TOKEN_TTL_MS`）；`hostCodeOf(g: ContentGrant): string`（域名模式子域，`sha256(person|bot|target)` 前 16 位 hex）。cookie 值用另一 label `"content-session"`。

- [ ] **Step 1: 写失败测试**

```ts
test("port range and bare domain", () => {
  expect(() => loadConfig({ ...base, XIONGBAO_CONTENT_PORT: "80" })).toThrow();
  expect(loadConfig({ ...base, XIONGBAO_CONTENT_PORT: "3773" }).content.port).toBe(3773);
  expect(() => loadConfig({ ...base, XIONGBAO_CONTENT_DOMAIN: "https://a.com" })).toThrow();
});
test("a token reads back until 30 minutes, then not; another key, an edited body or the other label is rejected", () => {
  const t = issueOpenToken({ ...grant, exp: now + OPEN_TOKEN_TTL_MS }, KEY);
  expect(readOpenToken(t, KEY, now + OPEN_TOKEN_TTL_MS - 1)?.bot).toBe("bot-1");
  expect(readOpenToken(t, KEY, now + OPEN_TOKEN_TTL_MS + 1)).toBeNull();
});
```
- [ ] **Step 2:** `bun test server/tests/content-config.test.ts server/tests/content-token.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令，期望 PASS。
- [ ] **Step 5:** 提交。

### Task 15: 静态目录服务

**Files:**
- Create: `server/src/content/static.ts`、`server/tests/content-static.test.ts`；Modify: `server/src/computer/gateway.ts`（`serveFile`）

**Interfaces:**
- Produces: `resolveServedPath(dir: string, rel: string): string | null`（`dir` 工作区相对目录；`rel` 先 `decodeURIComponent`，失败 null；空或以 `/` 结尾补 `index.html`；含 `..` 段、`\`、NUL、绝对路径一律 null）；`gateway.serveFile(seat: ComputerSeat, i: { path: string }, signal?: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; bytes: number } | null>`（内部 `transport.download`，**不**逐次 `govern`——「打开」那一次已按 `computer_download_file` 治理审计；电脑端 `workspace.download` 仍做链接与越界检查；找不到 null）；`serveStatic(g: ContentGrant & { target: { kind: "dir"; path: string } }, rel: string, gateway: Pick<ComputerGateway, "serveFile">, signal?: AbortSignal): Promise<Response>`：`Content-Type` 来自 `previewContentType`（缺省 `application/octet-stream`），一律 `X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`；404 用不含路径的固定文案。

- [ ] **Step 1: 写失败测试**

```ts
test.each(["../x", "a/../../x", "a\\..\\x", "%2e%2e/x", "a%00b", "/etc/passwd"])("refuses %s", (rel) => expect(resolveServedPath("site", rel)).toBeNull());
test("index and decoding", () => {
  expect(resolveServedPath("site", "docs/")).toBe("site/docs/index.html");
  expect(resolveServedPath("site", "a%20b/%E6%8A%A5%E5%91%8A.html")).toBe("site/a b/报告.html");
});
test("nosniff and type; a link escape the computer refuses is a plain 404", async () => { /* serveFile → null */ });
```
- [ ] **Step 2:** `bun test server/tests/content-static.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令，期望 PASS。
- [ ] **Step 5:** 提交。

### Task 16: 内容服务器、打开接口、令牌换 cookie，部署文档与端口映射

**Files:**
- Create: `server/src/content/server.ts`、`open-routes.ts`（同目录）、`server/tests/content-server.test.ts`、`content-open-routes.test.ts`
- Create: `server/tests/content-compose.test.ts`
- Modify: `docker-compose.yml`（242 行 `ports:` 旁加内容端口映射，服务环境写 `XIONGBAO_CONTENT_PORT: "3773"`，照 `APP_PORT` 几行，保持 loopback 绑定并注释公网部署需改对外绑定）、`Dockerfile`（530 行旁 `EXPOSE 3773`）、`docs/deployment-xiongbao.md`（新增「内容源端口」：京东云安全组多放行 3773/TCP；泛子域名要泛 DNS、泛证书、反代把 `*.apps.<域名>` 转到内容端口）、`docs/configuration.md`、`CHANGELOG.md`
- Modify: `server/src/http-server.ts`（有 `content.port` 时再起一个 `Bun.serve`；域名模式同监听按 `Host` 分流）、`server/src/index.ts`（接线；审计 `recordAuditEvent`，`eventType: "content.opened"`）、`server/src/app.ts`（挂 `open-routes`）

**Interfaces:**
- Produces: `POST /api/computers/:botId/open`，体 `{ kind: "dir"; path: string } | { kind: "app"; port: number; path?: string }` 加 `channel?`/`run?`/`task?`（鉴权同 Task 7；`dir` 经 `statFile` 确认是目录且有 `index.html`，否则 404）；成功 `{ url: string; mode: "port" | "domain"; expiresAt: string; replaces: boolean }`，未配内容源 `{ available: false; reason: string }`。`url`：端口模式 `<公开主机名>:<port>/__open/<令牌>`，域名模式 `https://<hostCodeOf>.<domain>/__open/<令牌>`；`replaces`：端口模式下同一人已有另一个打开的目标。
- `createContentServer(deps): { fetch(request: Request): Promise<Response> }`：`GET /__open/<令牌>` 令牌有效则 `Set-Cookie: xb_content=<会话令牌>; HttpOnly; Path=/; SameSite=Lax`（HTTPS 加 `Secure`）并 302 到目标根（`dir` 为 `/u/<令牌>/`，`app` 为 `/`+path，地址栏不带令牌），无效 404；`GET /u/<令牌>/<相对路径>` 走 `serveStatic`，带 `Referrer-Policy: no-referrer`；其余路径按 cookie 找该浏览器当前目标（`dir` 走静态，`app` 留给 Task 19），无 cookie 404；剩余不足一半时 `renewedGrant` 重发 cookie，续期时 `deps.stillAllowed(grant): Promise<boolean>`（成员资格、员工仍在、卡仍可见）为假则 404 并清 cookie；只认 `xb_content`，不读不转发应用 cookie。

- [ ] **Step 1: 写失败测试**

```ts
test("/__open sets an HttpOnly cookie and redirects without the token", async () => {
  const res = await server.fetch(new Request(`http://c/__open/${appToken}`));
  expect(res.status).toBe(302); expect(res.headers.get("set-cookie")).toMatch(/xb_content=.*HttpOnly/); expect(res.headers.get("location")).toBe("/");
});
// 另测：过期或伪造令牌 404、应用 cookie 不起作用；根路径请求跟 cookie 的目标；第二次打开替换第一次并 replaces；被移出群的人在下次续期被切断并清 cookie；域名模式 cookie 只在自己子域有效
// 打开接口：未登录 401；非成员 404；无 index.html 404；未配内容源 { available: false }；成功写一条不含令牌的审计
```
- [ ] **Step 2:** `bun test server/tests/content-server.test.ts server/tests/content-open-routes.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现内容服务器与打开接口。
- [ ] **Step 4:** 写部署文档与配置；`content-compose.test.ts` 读文本断言 compose 含 `XIONGBAO_CONTENT_PORT` 与 `3773` 映射、`Dockerfile` 含 `EXPOSE 3773`、部署文档含「安全组」与 `3773`。
- [ ] **Step 5:** 跑 Step 2 的测试加 `server/tests/content-compose.test.ts`，期望 PASS。
- [ ] **Step 6:** 提交。

### Task 17: 界面：用内容源打开静态网页，未配时降级

**Files:**
- Modify: `app/src/components/channels/artifact-preview.tsx`、`app/src/lib/computers/preview.ts`；Create: `app/tests/artifact-open.test.tsx`

**Interfaces:**
- Produces: `openTarget(botId: string, body: OpenBody): Promise<OpenResult>`（`POST /api/computers/:botId/open`；`OpenResult = { available: false; reason: string } | { available: true; url: string; mode: "port" | "domain"; expiresAt: string; replaces: boolean }`）。html 与网页目录先试 `openTarget`：可用则 iframe 指向 `url`，`sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`（此时「同源」指内容源，不是应用源），「在新标签页打开」指同一地址；不可用回 Task 12 的沙箱预览，顶部固定降级说明：`没有配置内容源，网页在受限沙箱里显示，部分功能可能不可用。`；`replaces` 为真写 `已替换你之前打开的程序`；令牌到期 iframe 失败时显示「已过期，重新打开」。

- [ ] **Step 1: 写失败测试**

```tsx
test("available: iframe src starts with the content origin; unavailable: fallback note and the app-origin iframe never gets allow-same-origin", () => { /* ... */ });
test("replaces shows the notice; expiry shows 重新打开", () => { /* ... */ });
```
- [ ] **Step 2:** `cd app && bun test tests/artifact-open.test.tsx`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令，期望 PASS。
- [ ] **Step 5:** 提交。

**期 4 收尾：** **合入前做一次安全审查**（`security-review` 技能，对照规格「安全」与反目标，专审：响应头、cookie 不隔离端口、令牌绑定与撤销、`resolveServedPath` 与符号链接、审计不含令牌），结论贴 PR；界面**推送前截图给用户确认**（预览里的网页、降级说明）。本期合成一个 PR、CI 全绿合入。

---

## 期 5：运行中程序转发（电脑端 + 服务器 + 界面，含安全审查）

### Task 18: 电脑端监听表归属检查与转发接口（HTTP、WebSocket）

**Files:**
- Create: `agent-computer/src/listeners.ts`、`forward.ts`（同目录）、`agent-computer/tests/listeners.test.ts`、`forward-http.test.ts`（照 `file-download-http.test.ts` 起子进程，开关 `XIONGBAO_FORWARD_HTTP=1`）
- Modify: `agent-computer/src/per-bot.ts`（`employeeUid`）、`agent-computer/src/index.ts`（鉴权后 `/exec` 旁加 `ALL /forward/<port>/<path…>`；`/stream` 同处加 `GET /forward-ws/<port>/<path…>` 的 `server.upgrade`）

**Interfaces:**
- Produces: `FORWARD_PORT_MIN = 1024`、`FORWARD_PORT_MAX = 65535`；`parseProcNetTcp(text: string): { port: number; uid: number; inode: string; address: string }[]`（只取状态 `0A`，`tcp`/`tcp6` 通用）；`type ForwardVerdict = "ok" | "out-of-range" | "no-listener" | "not-yours" | "self"`；`checkForwardPort(i: { port: number; uid: number | null; tables: string[]; selfPorts: readonly number[] }): ForwardVerdict`（非整数或越界 `out-of-range`；在 `selfPorts` 即 agent-computer 自己的监听端口 `self`；无回环或通配监听 `no-listener`；监听 uid 与员工 uid 不同 `not-yours`；`uid` 为 null（共享电脑模式）只做范围、自身、有监听三项）；`employeeUid(botId: string, options?: { passwd?: string }): number | null`（读 `/etc/passwd` 找 `xb-${botKeyOf(botId)}`）。
- `FORWARD_MAX_REQUEST_BYTES = 10 * 1024 * 1024`、`FORWARD_MAX_RESPONSE_BYTES = 100 * 1024 * 1024`、`FORWARD_HEADER_TIMEOUT_MS = 60_000`；`forwardHttp(i: { request: Request; port: number; path: string; verdict: ForwardVerdict }): Promise<Response>`：`verdict !== "ok"` 答 403 `{ error }`（不泄露别人端口信息）；否则 `fetch("http://127.0.0.1:<port><path>", { redirect: "manual", signal })`，去 hop-by-hop 头，响应超限截断，请求体超限 413。`/forward/…` 与其它接口同用 computer token，归属检查在这里，座位取请求头。

- [ ] **Step 1: 写失败测试**（`sample` 用真实 `/proc/net/tcp` 文本）

```ts
test("only LISTEN rows; another employee's listener is refused; own port is self", () => {
  expect(parseProcNetTcp(sample).map((r) => r.port)).toEqual([8080, 3000]);
  expect(checkForwardPort({ port: 8080, uid: 1001, tables: [sample], selfPorts: [3002] })).toBe("not-yours");
  expect(checkForwardPort({ port: 3002, uid: 1000, tables: [sample], selfPorts: [3002] })).toBe("self");
});
test.each([80, 1023, 65536, 0, 3.5, Number.NaN])("port %p is out of range", (port) => expect(checkForwardPort({ port, uid: 1, tables: [sample], selfPorts: [] })).toBe("out-of-range"));
// 转发（子进程里起回环小服务充当员工程序）：GET、POST 到员工自己的监听；无监听与电脑自己的端口 403、无 token 401；程序的 302 原样返回不跟随；响应超限截断、请求超限 413；WebSocket 经 /forward-ws 回声
```
- [ ] **Step 2:** `bun test agent-computer/tests/listeners.test.ts` 与 `XIONGBAO_FORWARD_HTTP=1 bun test agent-computer/tests/forward-http.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现 `listeners.ts` 与 `employeeUid`。
- [ ] **Step 4:** 实现 `forward.ts` 与 `index.ts` 的两条路由。
- [ ] **Step 5:** 同命令，期望 PASS。
- [ ] **Step 6:** 提交。

### Task 19: 服务器转发，内容源接上运行中程序

**Files:**
- Create: `server/src/content/forward.ts`、`server/tests/content-forward.test.ts`
- Modify: `server/src/computer/gateway.ts`（`forwardHttp`、`forwardSocket`，复用 `client.ts` 的鉴权头与出口策略）、`server/src/content/server.ts`

**Interfaces:**
- Produces: `gateway.forwardHttp(seat: ComputerSeat, i: { port: number; method: string; path: string; headers: Headers; body: ReadableStream<Uint8Array> | null }, signal?: AbortSignal): Promise<Response>`；`gateway.forwardSocket(seat: ComputerSeat, port: number, path: string): { url: string; headers: Record<string, string> }`（computer token 与座位头，供内容服务器建上游 WebSocket，照 `http-server.ts` 的 `/stream` 代理）。
  `forwardToApp(g: ContentGrant & { target: { kind: "app" } }, request: Request, deps): Promise<Response>`：只转 HTTP/WS（其余方法 405）；请求删 `Cookie`、`Authorization`、`X-Forwarded-*`、`Host`；响应删 `Set-Cookie`（端口模式）或去 `Domain` 属性（域名模式）、删 `Strict-Transport-Security`；`Location` 相对或指向 `127.0.0.1:<port>`/`localhost:<port>` 的改写成路径，指向别的主机的删 `Location` 并答 502；按员工限流 `FORWARD_RATE_PER_MINUTE = 600`（超出 429）；WebSocket 在令牌到期时主动关闭，续期时 `stillAllowed` 为假也关闭；审计只在「打开」时写。

- [ ] **Step 1: 写失败测试**

```ts
test("the person's cookies and authorization never reach the program", async () => { /* 上游看不到 */ });
// 另测：端口模式丢 Set-Cookie、域名模式去 Domain；重定向到别的主机 502、到程序自己的改写成路径；一分钟第 601 个请求 429（按员工计）；WebSocket 在令牌到期与人被移出群时关闭（假时钟）
```
- [ ] **Step 2:** `bun test server/tests/content-forward.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令（及上面追加的既有测试），期望 PASS。
- [ ] **Step 5:** 提交。

### Task 20: 交付项 `app`（证据门实请求首页）

**Files:**
- Create: `server/tests/delivery-app-item.test.ts`
- Modify: `server/src/tasks/evidence-gate.ts`（`DELIVERY_ITEM_KINDS` 加 `"app"`，`DeliveryItem` 加 `port?: number; path?: string`，options 加 `appProbe`）、`delivery-tools.ts`（`deliverSchema` 的 item 接受 `port`、`path`，`ref` 对 `app` 可省；`HAND_IN_WITH_FILES`）、`projector.ts`（`DeliverableRef.apps?: { port: number; path: string; title: string }[]`）、`server/src/index.ts`（探针经 `gateway.forwardHttp` GET 首页，10 秒超时）、`server/src/agents/prompt-slim.ts`、`app/src/lib/tasks/delivery.ts`（`EvidenceRow` 加 `{ kind: "app"; port: number; path: string; label: string }`）

**Interfaces:**
- Produces: `type AppProbe = (i: { tenantId: string; agentId: string; port: number; path: string }) => Promise<{ status: number } | { refused: string } | null>`（`null` = 设备 seat，标未核实）。规则：`port` 为 1024–65535 整数，否则挡回 `程序「<名>」的端口要在 1024 到 65535 之间。`；`path` 缺省 `"/"` 且以 `/` 开头；title 必填；探针 2xx/3xx 通过，否则（含 `refused`）挡回 `程序「<名>」在端口 <port> 上打不开（HTTP <status> 或没有在监听）。先把它跑起来再交。`；`app` 与 `workspace_file` 同算实物，Task 3 对带 `app` 的交付放行。
- 提示句补成规格原句：`交付的是文件/网页/程序就把它存在工作区里并作为 workspace_file / app 交付；不要只把内容贴在对话里。`（`HAND_IN_WITH_FILES` 与 `prompt-slim.ts` 交付段）。

- [ ] **Step 1: 写失败测试**

```ts
test.each([80, 70000, 3.5])("port %p bounces", async (port) => { /* ... */ });
test("an app item lands in ref.apps; the prompt names app", () => {
  expect(ref.apps).toEqual([{ port: 8000, path: "/", title: "待办" }]); expect(deliveryProtocolGuidance(...)).toContain("workspace_file / app");
});
// 另测：200、302 通过；404、无监听挡回；设备 seat 不探针
```
- [ ] **Step 2:** `bun test server/tests/delivery-app-item.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令（及上面追加的既有测试），期望 PASS。
- [ ] **Step 5:** 提交。

### Task 21: 界面「打开」按钮与交付卡的程序行

**Files:**
- Create: `app/tests/delivery-app-open.test.tsx`
- Modify: `app/src/skins/xiongbao/delivery-chat.tsx`（`EvidenceItem` 画 `app` 行）、`app/src/routes/_authed/_app/tasks.$taskId.tsx`、`app/src/components/channels/artifact-preview.tsx`、`app/src/lib/computers/preview.ts`（`PreviewTarget` 加 `app` 变体 `{ botId; app: { port: number; path: string }; scope }`）

**Interfaces:**
- Consumes: Task 17 的 `openTarget`，体 `{ kind: "app", port, path }`；点「打开」先调它，再把 `PreviewTarget` 写进 `preview` 参数让侧栏显示。`replaces` 为真显示「已替换你之前打开的程序」；未配内容源时「打开」置灰并写 `没有配置内容源，不能打开程序`。

- [ ] **Step 1: 写失败测试**

```tsx
test("an app row shows title, port and an open button; open calls the endpoint with kind app and shows the pane", async () => { /* ... */ });
test("without a content origin the button is disabled with the reason; replaced notice shows", () => { /* ... */ });
```
- [ ] **Step 2:** `cd app && bun test tests/delivery-app-open.test.tsx`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令，期望 PASS。
- [ ] **Step 5:** 提交。

**期 5 收尾：** **合入前做一次安全审查**（`security-review` 技能，专审：只转到本员工 `127.0.0.1` 非保留端口、uid 归属、不跟随重定向、体积/时长/限流、WebSocket 到期与撤销、Cookie 剥离、审计），结论贴 PR；界面**推送前截图给用户确认**。本期合成一个 PR、CI 全绿合入。

---

## 期 6：验收题组与真实模型评测、验收文档

### Task 22: 七道判分函数

**Files:**
- Create: `scripts/e2e/employee-eval/check-deliverables.ts`、`check-deliverables.test.ts`、`fixtures/deliverables/<题名>/TASK.md`（中文题面）及每类合格、不合格最小样例各一（各小于 50KB）
- Modify: `scripts/e2e/employee-eval/lib.ts`（`DELIVERABLES_SUITE`、`TaskName`、`TASK_TITLES`、`selectTasks` 认 `deliverables`，仍不进 `all`/`hard`）、`checkers.ts`（`CHECKERS` 登记）、追加 `hard-suite.test.ts`

**Interfaces:**
- Produces: `DELIVERABLES_SUITE = ["deliv-pptx","deliv-docx","deliv-xlsx","deliv-web","deliv-app","deliv-image","deliv-video"] as const`；`checkDelivPptx(dir: string): CheckResult` 等（沿用 `check()`/`result()`）。pptx：python-pptx 能打开、页数 ≥ 5；docx：能打开且含指定标题；xlsx：表头等于指定、公式单元格缓存值等于金标（`openpyxl data_only=True`）；web：有 `index.html` 且引用的相对资源都在；app：服务脚本和页面文件在，交付里有 `app` 项（Task 23 传入）；image：魔数正确、宽高 > 0；video：`ffprobe` 读到 1–30 秒且有视频流。

- [ ] **Step 1: 写失败测试**

```ts
test("a 5-slide pptx passes, a 2-slide one fails with the count in the detail", () => { /* 夹具 */ });
// 另测：docx 缺标题、xlsx 公式无缓存值、web 缺资源都失败
test("selectTasks('deliverables', HARD_SUITE) gives seven; 'all' and 'hard' unchanged", () => { /* ... */ });
```
- [ ] **Step 2:** `bun test scripts/e2e/employee-eval/check-deliverables.test.ts scripts/e2e/employee-eval/hard-suite.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现（本机缺 python-pptx/ffprobe 时用例跳过并打印原因，CI 步骤里装）。
- [ ] **Step 4:** 跑 Step 2 的命令，期望 PASS。
- [ ] **Step 5:** 提交。

### Task 23: 服务器侧判分（下载、预览、内容源、浏览器交互）与群聊路径

**Files:**
- Create: `scripts/e2e/employee-eval/deliverables-server.ts`、`deliverables-server.test.ts`
- Modify: `records.ts`（`EvalPath` 加 `"group"`）、`chat-path.ts`（`EVAL_PATHS`、`parseEvalPath`、群聊发起与读流）、`run-xiongbao.ts`（交付题的跑法与结果拷贝）、追加 `chat-path.test.ts`

**Interfaces:**
- Produces: `serverChecks(i: { base: string; cookie: string; botId: string; channelId: string; runId: string; task: (typeof DELIVERABLES_SUITE)[number]; files: string[] }): Promise<Check[]>`：每个产物请求 `files/download`（200、`attachment`、字节数等于电脑上的）与 `files/preview`（按类型 200 且 `nosniff`；pptx/docx/xlsx 答 `{ unavailable: true }` 视为失败）；web、app 经 `POST /open` 拿 `url` 换 cookie，请求首页 200，再用 Playwright Chromium 交互（web：点按钮、页面文字变化；app：POST 新增一条待办再 GET 读到、DELETE 后读不到）。群聊路径：新建含该员工的 shared 群聊，发题，读群聊运行流到结束，归一成与 chat 路径同一结果结构。

- [ ] **Step 1: 写失败测试**（桩 HTTP 服务器，不跑真模型）

```ts
test("a download with the wrong disposition fails; an unavailable office preview fails the pptx task", async () => { /* ... */ });
// 另测：app 题新增后列表看不到就失败；parseEvalPath 认 chat、board、group
```
- [ ] **Step 2:** `bun test scripts/e2e/employee-eval/deliverables-server.test.ts scripts/e2e/employee-eval/chat-path.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 Step 2 的命令，期望 PASS。
- [ ] **Step 5:** 提交。

### Task 24: 工作流输入、报告与验收文档，真实模型跑通

**Files:**
- Create: `docs/delivery-acceptance-2026-11-23-deliverables.md`（在 `xiongbao/docs/`）：7 题 × 单聊/群聊共 14 格，每格记通过/失败、重跑次数、运行链接，末尾判定「14 项全部通过（含重跑）才算达成」
- Modify: `.github/workflows/model-e2e.yml`（仓库根）：`tasks` 说明加 `deliverables`；`paths` 选项加 `group`、`chat,group`；employee-eval-xiongbao 作业装 `python-pptx python-docx openpyxl`、`ffmpeg`、Playwright Chromium（照 `ci.yml` 的 `computer-browser` 作业）并设 `XIONGBAO_CONTENT_PORT`；新增输入 `rerun_failed`（默认 `1`）
- Modify: `scripts/e2e/employee-eval/records.ts`（结果带 `reruns`）、`report.ts`，追加 `report-paths.test.ts`

**Interfaces:**
- Produces: 结果记录 `{ task: string; path: "chat" | "group"; passed: boolean; reruns: 0 | 1 }`；`renderReport` 渲染 7×2 表并输出「达成/未达成」。

- [ ] **Step 1: 写失败测试**：14 项全过（含一次重跑）输出「达成」；缺一项，或某项重跑后仍失败输出「未达成」，并列出 `reruns`。
- [ ] **Step 2:** `bun test scripts/e2e/employee-eval/report-paths.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现报告与工作流改动。
- [ ] **Step 4:** 跑 Step 2 的命令，期望 PASS。
- [ ] **Step 5:** 提交；在 Actions 手动触发 `model-e2e`（`suite=employee-eval`、`tasks=deliverables`、`paths=chat,group`），把运行链接与每项结果（含重跑次数）填进验收文档并提交。有失败项就回到对应期修，不改判分放水。

**期 6 收尾：** 验收文档 14 项全过项目才算达成。本期合成一个 PR、CI 全绿合入。

取舍备案：一轮产物对比选「电脑端存快照、服务器只拿差异」（Task 5）；令牌用现有 `signed-value` 签名（Task 14）；缓存目录 `.xb-preview`（Task 10）。
