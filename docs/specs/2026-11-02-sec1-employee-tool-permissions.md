# SEC1 员工级工具权限设计规格

- 日期：2026-11-02
- 状态：**草案，含待决策项**。动工前需要产品和安全负责人拍板，本文不含代码。
- 故事：`docs/acceptance/STORIES.md` SEC1（D11）。故事原文：员工级危险命令审批、敏感文件路径审批、每个工具"直接 / 询问 / 禁用"三态，以及企业模式入口；执行侧遵循配置，被拒绝或待审批的动作不产生副作用。
- 相关：F3（网关下发到 runner）、`docs/specs/2026-10-06-qoderwake-replica.md` D11（"平台控制目录、租户控制装配"）。

---

## 1. 现状（基线：`claude/magical-archimedes-8a6ljj`）

### 1.1 审批规则（按"人"存，规则里可以指定员工）

- `server/src/db/schema/approvals.ts`：
  - `approval_rules` 表：字段为 `ownerUserId`、`botId`、`toolRef`、`effect`、`scope`、`behaviour`。前四个都支持 `*` 通配，由 `globMatches` 匹配。`behaviour` 的 CHECK 约束只允许 `allow | pre_approved | ask | hand_off` 四个值。
  - `approval_team_rules` 表：管理员设的规则，成员看到的是锁定行。
  - `approval_preferences` 表（每人一行）：`enabled`（相当于"改动前先问我"）、`autoReview`、`hostCommands ∈ {ask, allow, never}`。
  - `approval_team_settings` 表（全租户一行，`id = team`）：`enforceAutoReview`、`customRulesEnabled`、`hostCommandsCap`。
- `server/src/approvals/policy.ts` 的 `decideAction()` 按以下顺序判定：
  1. `safetyRequirement()`：关键词底线。凭据、安全设置、支付类动作一律 `hand_off`。注意它通过 `NOT_ACCOUNT_ACTIONS`（`/^(computer_(write_file|read_file|list_files|run_command)|host\/)/`）明确**跳过**命令、文件动作和 `host/*`。
  2. `strictestRule()`：团队规则和个人规则里取最严的一条，严格程度由 `RANK` 定义（allow < pre_approved < ask < hand_off），平局时团队规则胜。
  3. `reviewAction()`：只有个人开了 `autoReview`（或团队 `enforceAutoReview`）、或命中 `pre_approved` 规则时才调用 LLM 复核，出错时按"需要审批"处理（fail closed）。复核**会**看到命令：`reviewable()` 对一切非读动作为真，复核给出 `needs_approval` / `hand_off` 时命令同样会被拦下。但它是可选的、非确定性的；复核的安全类别 `SAFETY_CATEGORIES` 只有 credentials、security_settings、payments，**没有危险命令这一类**，而且对 `NOT_ACCOUNT_ACTIONS` 连这三类安全判定也忽略。
  4. 如果 `askBeforeChanges` 为真，非读操作返回 `ask`；否则返回 `allow`。
- `server/src/approvals/service.ts` 的 `evaluate()`：查规则时用的是 `store.rules(candidate.actorId)`，也就是**发起这次运行的人**自己的规则，而不是员工所有者的规则。
- 审批闸门有四个调用点：`computer/gateway.ts:723`（浏览器、shell、文件）、`plugins/store.ts:7369`（MCP 工具）、`host-access/broker.ts:268`（本机命令）、`agents/handoff-tool.ts:137`（交接）。

### 1.2 本机命令策略（按人设置，团队封顶）

- `policy.ts` 的 `effectiveHostCommandPolicy(member, cap)` 取两者中更严的一个；`service.ts:505` 的 `hostCommandPolicy()` 调用它；`index.ts:1281` 把结果注入 `createHostAccessBroker({ commandPolicy })`（`host-access/broker.ts:46`）。策略为 `never` 时，命令在到达电脑之前就被拒绝。
- **这条策略只管 `host/*`**，也就是桌面 host-access broker 这条路径。runner 上执行的 `computer_run_command` 走的是 `computer/gateway.ts`：先在 `:343` 用 `resolveDevice` 解析设备，再用 `runnerAddress` 投递，**不会读 `hostCommandPolicy`**。

### 1.3 策略网关与企业管控

- `server/src/computer/policy.ts` 的 `evaluateActionPolicy()`：用 CEL 写的 deny 和 allow 规则，deny 优先，默认拒绝，规则出错也按拒绝处理。`PolicyContext` 包含 `bot.id`、`command`、`file.{path,name,extension}`。规则是**部署级**的，由运维编写（`index.ts:865/975` 里的 `policyStore.get()`）。
- `server/src/admin/controls.ts` 的 `decideFromSnapshot()`：企业管控，通过 `setPolicyOverlay` 叠在网关前面，包括能力开关（useBots、cloudComputer、cloudBrowser、cloudNetwork）、MCP 白名单和网络策略。
- 网关 `gateway.ts:656` 的执行顺序是：先做策略判定，再写审计行；判定结果为不放行时抛出 `ActionRefusedError`，之后才进入审批闸门，最后才执行 `run(address)`。所以"被拒绝的动作没有副作用"在结构上已经成立。

### 1.4 一套休眠的结构

`server/src/db/schema/security-policy-fences.ts` 里的 `agent_security_policies` 表，主键是 `(tenantId, agentId)`，`config` 字段是 jsonb，形状正好就是 SEC1 要的：`enterpriseMode`、`dangerousCommandsEnabled`、`sensitivePathsEnabled`、`sensitivePaths`、`toolModes`。但文件头写着 "Historical structure only"，CHECK 约束把 `enterpriseMode` 固定为 `false`，RLS 要求 `owner_user_id = tenant_id`，而且没有任何代码写它。`server/tests/recovery-security-policy-fences.test.ts` 专门锁定了它的休眠状态。

### 1.5 已有测试

- `server/tests/approvals-policy.test.ts`，覆盖：`never` 在到达电脑之前被拒；无人值守时持久等待且不发送；拒绝后不发送；交接后从不代执行；凭据和支付始终交给本人。
- `server/tests/approvals-policy.integration.test.ts`：团队封顶取更严；个人与团队规则叠加取最严。
- `app/tests/approvals-rules.test.tsx`：四种行为的规则创建。

---

## 2. 差距

| # | 故事要求 | 差距 |
| --- | --- | --- |
| G1 | 每个工具三态，包括"禁用" | 规则行为里没有 deny；`never` 只存在于 host 命令策略 |
| G2 | "员工级"配置 | 规则按发起人（`actorId`）查找。同一个员工被另一个成员使用时，员工所有者给它设的规则不生效；host 命令策略按人而不是按员工 |
| G3 | 危险命令审批 | 没有确定性分类器；关键词底线跳过命令，LLM 复核默认关闭、且没有"危险命令"类别，只能偶然拦下 |
| G4 | 敏感文件路径审批 | server、runner、desktop 三处都没有路径匹配 |
| G5 | 企业模式入口 | 没有路由和界面；`agent_security_policies` 处于休眠 |
| G6 | 执行侧遵循配置 | runner 上的命令不受 `hostCommandsCap` 约束（§1.2） |
| G7 | 测试 | 没有"员工配置驱动 runner 侧闸门"的测试 |

---

## 3. 方案

### 方案 A：启用 `agent_security_policies`，作为员工安全配置的唯一来源

- 写入方：新增 `server/src/agents/security-policy-store.ts`，在 `runAsTenant` 中读写，修订号自增。读取方：网关和审批闸门都按 `candidate.botId` 读取员工配置。
- `toolModes: { [toolRef]: "direct" | "ask" | "disabled" }`，命令和路径的开关直接用现成字段。
- 优点：表结构现成，按员工而不是按人存放，天然解决 G2。
- 缺点：员工配置与 `approval_rules` 成了两套并行的规则体系，界面和"取最严"的逻辑要合并两处；需要放开休眠围栏（GRANT、写入方、修改 recovery 测试的预期），属于**有意改变设计**，必须有人签字确认。

### 方案 B：扩展 `approval_rules`，命令和路径另做两个底线（推荐）

- 规则 `behaviour` 增加 `deny`（禁用），`RANK` 中 `deny` 最高。员工页上的三态就是写一条规则：`{botId: <员工>, toolRef, effect: "*", scope: "*"}`，其中"直接"对应 `allow`，"询问"对应 `ask`，"禁用"对应 `deny`。团队规则同样可以写 `deny`。
- 规则查找从"只查发起人"改为"发起人的规则加上员工所有者给该员工设的规则"，然后取最严。所有者规则在界面上标注为"员工所有者设定"。
- 危险命令和敏感路径做成 `policy.ts` 里的两个纯函数 `dangerousCommand(command)` 和 `sensitivePath(file)`，与 `safetyRequirement()` 同级，命中后**至少**返回 `ask`。员工级的开关和路径清单存放位置见 D3。
- 优点：复用现成的叠加、锁定行、审批收件箱来源标签和撤销逻辑，界面改动最小。
- 缺点：需要一次 CHECK 迁移；规则按人存放，"员工所有者的规则对其他人也生效"是一项语义变化。

### 方案 C：把员工配置编译成 CEL 覆盖层

- 每个租户由员工配置生成形如 `deny: bot.id == "x" && tool.name == "computer_run_command" && command.matches(...)` 的规则，通过 `setPolicyOverlay` 叠加。
- 优点：执行点只有一个，就是网关。
- 缺点：`policyStore` 是部署级的，而覆盖层是同步快照（参照 `admin/controls.ts` 的 LISTEN/NOTIFY 机制），按租户编译的复杂度很高；CEL 只能表达"拒绝"，表达不了"询问"；`plugins/store.ts` 的 MCP 路径也要再接一遍。**不推荐**。

---

## 4. 推荐：方案 B

### 4.1 数据模型与迁移大纲

1. 迁移写进 recovery overlay：`server/recovery/recovery-20261018-v1/sql/0111_rule_deny.sql`（及其 journal 条目）。`server/drizzle/` 停在 0080 且被 overlay 测试冻结，`scripts/migrate.ts` 的 `mergedMigrationsFolder()` 把两者合并后执行，overlay 只能追加；当前 overlay 最后一个是 `0110_approval_continuation_tenant_policies.sql`。迁移内容：重建 `approval_rules_behaviour_check` 和 `approval_team_rules_behaviour_check`，加入 `'deny'`。这是纯扩展，旧行不受影响。
   **上线顺序**：先发布能识别 `deny` 的代码，代码遇到未知行为一律按最严处理；之后再执行迁移。
2. 员工级的命令和路径设置（存放位置待 D3 决定）：
   - B1：新表 `agent_security_settings(tenant_id, agent_id PK, dangerous_commands: 'off'|'ask', sensitive_paths: text[], sensitive_paths_mode: 'off'|'ask', updated_by, updated_at)`，RLS 与 `agent_profiles` 的所有者一致。
   - B2：启用 `agent_security_policies`，只用其中的 `dangerousCommandsEnabled`、`sensitivePathsEnabled`、`sensitivePaths` 三个字段，并用 CHECK 约束把 `toolModes` 限定为 `{}`，避免出现两个事实来源。
3. 团队级：`approval_team_settings` 增加 `enforceDangerousCommands boolean`。值为真时所有员工强制"询问"，成员不能关闭（**待决策 D10**）。

### 4.2 判定顺序（与现有机制的交互规则）

对每个候选动作，从上往下判定，**先命中者生效，后面的层只能让结果更严**：

1. **企业管控与 CEL**（`decideFromSnapshot` 和 `evaluateActionPolicy`）：保持不变。拒绝时写审计行并抛出 `ActionRefusedError`，不会进入审批。
2. **禁用（deny 规则）**：任何一层（团队、员工所有者、发起人）出现匹配的 `deny`，就在闸门处返回拒绝，并写审计行，`source` 记为该规则所在的层。不创建审批请求，也不能"允许一次"。
   **待决策 D4**：被禁用的工具是否同时从模型可见的工具列表中移除。
3. **安全底线**（`safetyRequirement`）：保持不变。"直接"不能越过它。
4. **危险命令和敏感路径**：开关打开（员工设置打开，或团队强制打开）并且命中时，结果至少为 `ask`。对 `computer_run_command`（容器和 runner 都算）以及 `host/*` 同样生效。
5. **规则取最严**：团队规则、员工所有者规则、发起人规则三层合并，`RANK` 为 allow < pre_approved < ask < hand_off < deny；`pre_approved` 时仍然调用 LLM 复核。
6. **host 命令封顶**：`hostCommandsCap` 继续约束 `host/*`。**待决策 D5**：是否把封顶也应用到 runner 上的 `computer_run_command`。建议应用，否则 F2 上线后会多出一条绕过封顶的路径。
7. `customRulesEnabled = false` 时，个人规则失效。**建议**这种情况下 `deny` 和"询问"类的个人规则仍然生效，因为它们只会收紧权限（**待决策 D6**）。

待审批的动作沿用现有机制：无人值守的运行通过 `HeadlessToolSuspension` 持久等待，有人在场的运行提示模型等待；被拒绝的动作不会发出。

### 4.3 危险命令分类器（初版）

- 用确定性正则作为底线，不调用 LLM：`rm -rf`/`rm -r /`、`mkfs`、`dd of=`、`chmod -R 777`、`chown -R`、`curl … | sh`、`wget … | bash`、`sudo`、`shutdown`/`reboot`、`git push --force`、`git reset --hard`、`del /s`、`Remove-Item -Recurse`、`format <盘符>:`（只匹配 Windows 格式化盘符，不能裸匹配 `format`，否则 `git log --format` 也会命中）、`reg delete`，以及重定向写入 `/etc` 或 `C:\Windows`。
- 宁可误报（多点一次确认），也不漏报。规则清单写进 `policy.ts`，并附表驱动的单元测试。
- **待决策 D7**：是否允许租户自定义追加危险命令模式。

### 4.4 敏感路径（初版默认清单）

`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.ssh/**`、`.aws/**`、`.git/config`、`*credentials*`、`*.kdbx`。匹配对象是 `gateway.ts` 的 `describeFile()` 产出的 `file.path/name/extension`。runner 的工作区已经有 `createWorkspace` 的路径约束，这里管的是工作区内部的敏感文件。

### 4.5 界面大纲

- **员工详情 → "权限"标签页**（新增）：
  - 工具清单 = 内置 `computer_*` + 已授权的 MCP 工具（来自 `pluginGrants`）+ `host/*`。每行一个"直接 / 询问 / 禁用"三段开关。团队规则以锁定行显示（沿用 `approvals.tsx` 的样式），并注明"管理员设定"。
  - "危险命令需审批"开关；"敏感文件需审批"开关，以及可编辑的路径清单（默认值不可删，只能停用，**待决策 D8**）。
- **审批页**（`app/src/routes/_authed/_app/approvals.tsx`）：规则列表增加"禁用"这一行为，来源标签增加"员工所有者"。
- **企业模式入口**：只对管理员显示，跳转到现有的企业管控页（`admin/controls.ts` 对应的界面）。**待决策 D1**：企业模式是否进入 v1.0。

---

## 5. 待决策汇总

| 编号 | 问题 | 建议 |
| --- | --- | --- |
| D1 | **待决策**：企业模式是否进入 v1.0，入口放在哪里 | v1.0 只提供入口链接，不新增能力 |
| D2 | **待决策**：选方案 A 还是方案 B | B |
| D3 | **待决策**：命令和路径设置用新表（B1）还是启用休眠表（B2） | B1；B2 需要签字放开 recovery 围栏 |
| D4 | **待决策**：被禁用的工具是否对模型隐藏 | 隐藏，同时闸门仍然拒绝（双保险） |
| D5 | **待决策**：`hostCommandsCap` 是否覆盖 runner 命令 | 覆盖 |
| D6 | **待决策**：自定义规则关闭时，收紧类规则是否仍然生效 | 仍然生效 |
| D7 | **待决策**：租户能否追加危险命令模式 | v1.0 不开放 |
| D8 | **待决策**：默认敏感路径能否删除 | 只能停用 |
| D9 | **待决策**：员工所有者的规则是否对其他使用者也生效（语义变化） | 生效，并在界面上标注 |
| D10 | **待决策**：是否提供团队级"强制危险命令审批"开关 | 提供，仅管理员可改 |

---

## 6. 验收测试

服务端测试一律使用 `runAsTenant`；新增测试文件后运行 `bun scripts/ci/server-shards.mjs --write`。

1. `approvals-policy.test.ts`（纯函数层）：
   - `deny` 规则是最严的，它与 `allow` 冲突时 `deny` 胜，与团队 `ask` 冲突时也是 `deny` 胜。
   - 员工设为"直接"时，支付类动作仍然 `hand_off`。
   - `dangerousCommand("rm -rf ~")` 命中，`dangerousCommand("ls -la")` 不命中（表驱动，正反例各 15 条以上）。
   - `sensitivePath(".ssh/id_rsa")` 命中，`sensitivePath("src/index.ts")` 不命中。
2. `approvals-policy.integration.test.ts`（真库）：
   - 成员 B 使用员工 X，X 的所有者 A 给 X 设了禁用：B 的调用被拒，审计行的 `source` 为 owner 层。
   - 团队开启 `enforceDangerousCommands`，成员关掉员工开关后，危险命令仍需审批。
   - `deny` 迁移前写入的旧行在迁移后仍能正常读取。
3. `device-safety.integration.test.ts`（runner 侧）：
   - 员工 X 禁用 `computer_run_command`：网关拒绝，runner 一条帧都收不到，journal 为空。
   - 员工 X 开启危险命令审批，执行 `rm -rf`：创建待审批请求，runner 收不到帧；批准之后 runner 恰好执行一次。
   - `hostCommandsCap = never` 时，runner 命令被拒（前提是 D5 选择覆盖）。
4. `app/tests/approvals-rules.test.tsx` 和新增的员工权限页测试：
   - 三段开关写出对应的规则；锁定行不能修改；"禁用"在审批页显示正确的标签。
5. 回归：现有的 `approvals-policy*` 和 `recovery-security-policy-fences.test.ts` 全部保持通过。如果选了 B2，recovery 测试的预期变化必须作为单独的一个评审项。
