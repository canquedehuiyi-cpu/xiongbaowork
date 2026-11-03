# 77 故事待合并对照表

**这不是验收证据。** `STORIES.md` 的规则不变：一个故事只有在 `main` 上有对应测试通过，才算"已验收"。本表只说明每个故事的证据将来从哪个未合并的 PR 来；PR 合并、测试在 `main` 上通过之后，才能把 `STORIES.md` 对应行改成"已验收"，并在那里写测试文件和提交号。

数据截至 2026-11-02，来源：

- 开放 PR：`gh api 'repos/canquedehuiyi-cpu/xiongbaowork/pulls?state=open&per_page=100' --paginate`（共 90 个，#1–#90，全部为 draft）。
- CI：每个 PR head 提交的 check-runs。"CI 绿"指 9 项必需检查 static、app-test、server-test (1)–(6)、image 的最新一次都是 `success`。90 个 PR 中只有 #1 不绿（`7b46ce7`，即首轮 CI 的红灯基线，其失败已由 #2 修复，见 `BASELINE-FAILURES.md`）；其余 89 个 9/9 绿。
- 故事与 PR 的对应：PR 标题和正文写明的故事编号，再用各 PR 相对其 base 的测试文件 diff 里出现的故事编号核对。PR 没写故事编号的，不算对应；只在备注里写"相关"。
- 待决事项：<https://claude.ai/artifact/FTJJFsCy13JAG1GEKS7EBV>。截至本表，11 项都还没有保存选择。

注意：

- 大多数 PR 是叠加栈（base 是另一个 PR 的分支）。表里的"CI 绿"是该 head 在自己的组合下跑出的结果，不等于合入 `main` 后仍然绿。每合一个，下游要合入新 base 并重跑 CI。
- 测试文件路径都相对于 `openbot/`。只列 PR 自己新增或修改、且与该故事有关的测试；因合入其他分支而出现在 diff 里的测试不重复列。

## 推荐合并顺序

对应待决事项 `merge-order`（尚未确认）：

1. **#53**（Drizzle 语句按构建时的租户执行；G01-D 测试依赖它）
2. **#18**（模型 token 计量，缺陷 #11）
3. **#9**（凭据按租户隔离 + vault AAD，缺陷 #9 第一部分）
4. **叠加迁移 0111–0121**：按实际落地顺序重新编号，overlay journal 必须连续递增。各迁移所在 PR：0111 #9、0112 #10、0113 #15、0114 #17、0115 #24、0116 #26、0117 #40、0118 #44、0120 #51、0121 #68。没有任何开放 PR 带 0119。
5. **G01 栈**：#8 → #11 → #14 → #17 → #22 → #24 → #68 → **#71**
6. **#72–#88**（G01-D 测试加帧，B01–B16，以及 #88 governrun）
7. 其余功能栈。另有两条硬约束：
   - **#3 先于 #89**（#89 在 #3 的管理员限制上加套餐变更审计）
   - **#16 和 #62 先于 #90**（#90 的 base 是 #62，并已合入 #16）

## 故事对照

状态取值：待合并（CI 绿） / 待合并（CI 红/未跑） / 无对应 PR / 需人工决定（写明待决事项）。

| 故事 | 对应 PR（编号 / 分支） | 覆盖测试（PR 上） | head SHA | CI（9 项） | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | #48 `feat/d05-p7-board-labels` | `app/tests/tasks-workbench-filters.test.ts`、`server/tests/tasks-routes-filters.integration.test.ts` | 734358b3af | 绿 | 待合并（CI 绿） | 侧边栏"工作管理"标题；统计条与触发方式联动 |
| A2 | 无 | — | — | — | 无对应 PR | |
| A3 | #48 `feat/d05-p7-board-labels` | `app/tests/tasks-workbench-filters.test.ts`、`app/tests/tasks-workbench-board-consistency.test.tsx` | 734358b3af | 绿 | 待合并（CI 绿） | 来源标签、已结束-已完成/失败、执行者链接 |
| A4 | #48 `feat/d05-p7-board-labels` | `app/tests/tasks-workbench-filters.test.ts`、`server/tests/tasks-routes-filters.integration.test.ts` | 734358b3af | 绿 | 待合并（CI 绿） | PR 自述缺口：状态和数据周期仍是按钮组，不是下拉 |
| A5 | #26 `feat/d05-p1-archive-keeps-failure`<br>#48 `feat/d05-p7-board-labels` | #26：`app/tests/tasks-attention-lane.test.ts`、`server/tests/tasks-projector.test.ts`<br>#48：`app/tests/tasks-workbench-board-consistency.test.tsx` | 7bd109e355<br>734358b3af | 绿<br>绿 | 待合并（CI 绿） | 归档失败任务保持失败；中间泳道改名"需要操作" |
| A6 | 无 | — | — | — | 无对应 PR | |
| A7 | #26 `feat/d05-p1-archive-keeps-failure` | `app/tests/tasks-attention-lane.test.ts`、`server/tests/tasks-projector.test.ts` | 7bd109e355 | 绿 | 待合并（CI 绿） | 只覆盖归档后的失败任务离开"需要操作"；空态文案未见对应测试 |
| A8 | #37 `feat/d05-p2-board-approvals`<br>#60 `feat/d05-p9-questions-park` | #37：`app/tests/tasks-approval-actions.test.tsx`、`server/tests/tasks-approval-decision.integration.test.ts`<br>#60：`server/tests/approvals-question-board.test.ts`、`app/tests/tasks-approval-actions.test.tsx` | ea11b060a6<br>c753945693 | 绿<br>绿 | 待合并（CI 绿） | #60 补上"提问"类需要操作 |
| A9 | #59 `feat/d05-p8-deliverables` | `server/tests/task-deliverable.test.ts`、`app/tests/tasks-deliverable.test.tsx` | 55343237f7 | 绿 | 待合并（CI 绿） | #59 叠在 #19 上 |
| B1 | #39 `feat/d05-p6-mention-group-members`<br>#28 `feat/d05-p5-waker-dispatch-in-a-1-1-channel` | #39：`app/tests/composer-mention-affordance.test.ts`<br>#28：`app/tests/channel-dispatch-composer.test.tsx` | eae1787a0a<br>b648ddeb16 | 绿<br>绿 | 待合并（CI 绿） | #28 让 1:1 频道也能 @；#39 列出 Group 成员 |
| B2 | #28 `feat/d05-p5-waker-dispatch-in-a-1-1-channel` | `server/tests/channel-dispatch.test.ts`、`server/tests/channel-dispatch.integration.test.ts`、`app/tests/channel-dispatch-composer.test.tsx` | b648ddeb16 | 绿 | 待合并（CI 绿） | 叠在 #16 上 |
| B3 | #28 `feat/d05-p5-waker-dispatch-in-a-1-1-channel` | `server/tests/channel-dispatch.test.ts`、`server/tests/channel-dispatch.integration.test.ts` | b648ddeb16 | 绿 | 待合并（CI 绿） | |
| B4 | 无 | — | — | — | 无对应 PR | #22/#24/#68 正文里的 "B3/B4" 指 G01-B 包，不是本故事 |
| C1 | #42 `feat/d06-7-breaker-overview`<br>#64 `feat/d06-6-automations-ui`<br>#70 `feat/c1-autonomous-switches` | #42：`server/tests/autonomous-summary.test.ts`<br>#64：`app/tests/automations-section.test.tsx`<br>#70：`app/tests/autonomous-switches.test.tsx` | a15166addb<br>54b7ce79e1<br>c6a7433019 | 绿<br>绿<br>绿 | 待合并（CI 绿） | |
| C2 | #41 `feat/d06-1-proactive-card`<br>#67 `feat/c2-trigger-source-writers`<br>#58 `feat/d06-3-automation-runtime` | #41：`server/tests/proactive.test.ts`、`server/tests/tasks-projector.test.ts`<br>#67：`server/tests/unattended-single-card.integration.test.ts`、`server/tests/routine-runner.test.ts`、`server/tests/responsibilities-engine.test.ts`<br>#58：`server/tests/automation-waker-executor.test.ts` | 5505007220<br>1988805b37<br>1f9a8f2b16 | 绿<br>绿<br>绿 | 待合并（CI 绿） | 看板上的来源子标签在 #48；#67 自述 `wake_up`/`automation:*` 子标签仍回落为"例行" |
| C3 | #42 `feat/d06-7-breaker-overview`<br>#58 `feat/d06-3-automation-runtime` | #42：`server/tests/routine-runner.test.ts`、`app/tests/tasks-attention-region.test.tsx`<br>#58：`server/tests/automation-waker-executor.test.ts` | a15166addb<br>1f9a8f2b16 | 绿<br>绿 | 待合并（CI 绿） | #42 是 routine 熔断，#58 是自动任务熔断 |
| C4 | 无 | — | — | — | 无对应 PR | |
| H1 | #51 `feat/p4-h1a-platform-model-pool-data`<br>#55 `feat/p4-h1b-platform-model-pool-api`<br>#57 `feat/p4-h1c-platform-model-pool-ui` | #51：`server/tests/platform-model-pool.integration.test.ts`、`server/tests/recovery-platform-model-pool.test.ts`<br>#55：`server/tests/platform-model-pool-routes.test.ts`<br>#57：`app/tests/platform-model-pool.test.tsx` | 013de53264<br>99879d60f3<br>257872a2a7 | 绿<br>绿<br>绿 | 待合并（CI 绿） | 这三个 PR 做的是平台模型池；池里放哪些模型待 `free-pool` 决定，不影响代码合并 |
| H2 | #55 `feat/p4-h1b-platform-model-pool-api`<br>#57 `feat/p4-h1c-platform-model-pool-ui` | #55：`server/tests/platform-model-pool-routes.test.ts`、`app/tests/agent-dialog-built-in-edit.test.tsx`<br>#57：`app/tests/platform-model-pool.test.tsx` | 99879d60f3<br>257872a2a7 | 绿<br>绿 | 待合并（CI 绿） | |
| H3 | 无 | — | — | — | 无对应 PR | #18 只计量绑定模型的调用，没写 H3 |
| H4 | 无 | — | — | — | 无对应 PR | |
| H5 | #5 `fix/p1-quota-default-limits` | `server/tests/model-library-routes.test.ts` | d917ec2573 | 绿 | 待合并（CI 绿） | PR 没写故事编号；按缺陷 #13（服务端拒删使用中的模型，返回 409 和引用数）对应 |
| H6 | #57 `feat/p4-h1c-platform-model-pool-ui` | `app/tests/platform-model-pool.test.tsx` | 257872a2a7 | 绿 | 待合并（CI 绿） | |
| I1 | #38 `feat/d05-p4-editable-templates` | `server/tests/pipeline-template-edit.test.ts`、`server/tests/pipeline-routes.test.ts`、`app/tests/pipelines-template-edit.test.tsx` | 469427f5b3 | 绿 | 待合并（CI 绿） | |
| I2 | #27 `feat/d05-p3-pre-dispatch-per-step-authorizati`<br>#65 `feat/d05-p10-group-dispatch` | #27：`server/tests/pipeline-run.test.ts`、`server/tests/pipeline-routes.test.ts`<br>#65：`app/tests/tasks-dispatch-group.test.tsx` | 66afe42f60<br>3f8b508893 | 绿<br>绿 | 待合并（CI 绿） | #48 也声明 I2（交接/步骤卡标签） |
| I3 | #60 `feat/d05-p9-questions-park` | `server/tests/approvals-question-board.test.ts`、`app/tests/tasks-approval-actions.test.tsx` | c753945693 | 绿 | 待合并（CI 绿） | PR 自述未做：流水线步骤及其父卡在提问时挂起 |
| I4 | 无 | — | — | — | 无对应 PR | |
| I5 | 无 | — | — | — | 无对应 PR | |
| I6 | #27 `feat/d05-p3-pre-dispatch-per-step-authorizati` | `server/tests/pipeline-run.test.ts`、`server/tests/pipeline-routes.test.ts`、`app/tests/pipelines-dispatch-refusal.test.tsx` | 66afe42f60 | 绿 | 待合并（CI 绿） | #38 测试里也检查编辑后仍逐步校验 |
| D1 | #29 `feat/d07-d07-wp1-waker-cards-avatar-bot-lifec` | `app/tests/wakers-screen.test.tsx` | 44f145573a | 绿 | 待合并（CI 绿） | |
| D2 | #29 `feat/d07-d07-wp1-waker-cards-avatar-bot-lifec`<br>#30 `feat/d07-d07-wp4-choosable-avatar-seed` | #29：`app/tests/wakers-screen.test.tsx`<br>#30：`app/tests/create-agent-avatar.test.tsx`、`server/tests/agent-profile-store.integration.test.ts`、`server/tests/agent-routes.test.ts` | 44f145573a<br>7d271e7e38 | 绿<br>绿 | 待合并（CI 绿） | |
| D3 | #39 `feat/d05-p6-mention-group-members`（部分） | `app/tests/composer-mention-affordance.test.ts` | eae1787a0a | 绿 | 待合并（CI 绿） | 只覆盖 @ 列表中的 Group 成员；创建 Group 未见对应 PR |
| D4 | #29 `feat/d07-d07-wp1-waker-cards-avatar-bot-lifec` | `app/tests/wakers-screen.test.tsx` | 44f145573a | 绿 | 待合并（CI 绿） | PR 把"暂停"改为 `bot_lifecycle` 暂停，替换了旧断言，请复核 |
| D5 | #25 `feat/d07-wp2-agent-audit-trail`<br>#43 `feat/d07-wp3-employee-detail` | #25：`server/tests/agent-audit-trail.integration.test.ts`、`server/tests/bot-lifecycle-routes.test.ts`<br>#43：`app/tests/waker-detail.test.tsx` | 577753c8d7<br>45a6a734b7 | 绿<br>绿 | 待合并（CI 绿） | #25 开放点：管理员可看任意 Bot 的全部审计行 |
| D6 | 无 | — | — | — | 无对应 PR | #31 只让人设区遵守 `canManage`，属 D7 |
| D7 | #29 `feat/d07-d07-wp1-waker-cards-avatar-bot-lifec`<br>#31 `feat/d07-d07-wp5-assembly-page-acceptance-cov` | #29：`app/tests/wakers-screen.test.tsx`<br>#31：`app/tests/assemble-screen.test.tsx` | 44f145573a<br>2a509a545e | 绿<br>绿 | 待合并（CI 绿） | |
| E1 | #69 `feat/d08-7-aggregate-view` | `app/tests/resources-aggregate.test.tsx` | 1de5eccc99 | 绿 | 待合并（CI 绿） | 故事写"四区一屏"，加上 E4 的模型区实际是五区 |
| E2 | #32 `feat/d08-d08-6-one-group-expansion-helper-for` | `app/tests/crew-grant.test.ts`、`app/tests/admin-skill-crew-grant.test.tsx`、`app/tests/admin-plugin-crew-grant.test.tsx` | 477cc69b8b | 绿 | 待合并（CI 绿） | |
| E3 | #44 `feat/d08-4-install-listings`<br>#66 `feat/d08-5-listing-ui` | #44：`server/tests/plugin-self-install.integration.test.ts`<br>#66：`app/tests/admin-install-listing.test.tsx`、`app/tests/assemble-self-install.test.tsx`、`app/tests/plugin-mutation-refresh.test.ts` | 07595a8967<br>8ed4f347c2 | 绿<br>绿 | 待合并（CI 绿） | |
| E4 | #69 `feat/d08-7-aggregate-view` | `app/tests/resources-aggregate.test.tsx` | 1de5eccc99 | 绿 | 待合并（CI 绿） | |
| F1 | 无 | — | — | — | 无对应 PR | |
| F2 | 无 | — | — | — | 无对应 PR | |
| F3 | #19 `fix/p1-device`（部分） | `server/tests/device-selection.test.ts` | de3ffe7e6f | 绿 | 待合并（CI 绿） | `STORIES.md` 标为"部分（缺陷 #12）"；#19 修缺陷 #12（设备模式网关、按任务固定设备） |
| F4 | 无 | — | — | — | 无对应 PR | 相关：#19 让离线设备的命令/文件动作排队、回线后执行，但没写 F4，也不含卡片/看板的设备状态 |
| F5 | 无 | — | — | — | 无对应 PR | |
| F6 | 无 | — | — | — | 无对应 PR | |
| J1 | 无 | — | — | — | 无对应 PR | 相关：#3（只认可信地址晋升管理员）、#4（不把第三方登录关联到密码账号），都没写 J1 |
| J2 | 无 | — | — | — | 无对应 PR | 未确定：#10（RLS 默认拒绝，缺陷 #8）和 G01 栈（缺陷 #4）加固 RLS，但都没写 J2 |
| J3 | 无 | — | — | — | 无对应 PR | 未确定：同 J2 |
| J4 | 无 | — | — | — | 无对应 PR | 相关：#9、#12、#15（缺陷 #9，凭据按租户隔离与 AAD 封装），都没写 J4 |
| J5 | 无 | — | — | — | 无对应 PR | 管理员审计页的范围另有待决事项 `audit-scope` |
| J6 | 无 | — | — | — | 无对应 PR | |
| K1 | #51 `feat/p4-h1a-platform-model-pool-data`<br>#55 `feat/p4-h1b-platform-model-pool-api`<br>#57 `feat/p4-h1c-platform-model-pool-ui` | #51：`server/tests/platform-model-pool.integration.test.ts`<br>#55：`server/tests/platform-model-pool-routes.test.ts`<br>#57：`app/tests/platform-model-pool.test.tsx` | 013de53264<br>99879d60f3<br>257872a2a7 | 绿<br>绿<br>绿 | 需人工决定（`free-pool`） | Free 档的"平台目录基础模型"要先定池里放哪些模型、`OPENBOT_POOL_*` 密钥和预算上限；Free 默认限额本身由 #5（缺陷 #7）落实 |
| K2 | #18 `fix/p1-metering`<br>#49 `feat/p4-k2-token-panel` | #18：`server/tests/model-token-metering.test.ts`<br>#49：`server/tests/quota-token-usage.integration.test.ts`、`app/tests/quota-panel.test.tsx` | 7c930574a3<br>35179d495e | 绿<br>绿 | 待合并（CI 绿） | 缺陷 #11。默认/套餐模型的调用仍不计量；真实调用对账见门 6（#52，待决事项 `model-e2e`） |
| K3 | #54 `feat/p4-k3-payment-provider`<br>#3 `fix/p1-plan-admin-and-verified-admin`<br>#89 `feat/plan-change-audit` | #54：`server/tests/payment-provider.test.ts`、`server/tests/quota.test.ts`、`app/tests/quota-panel.test.tsx`<br>#3：`server/tests/quota.test.ts`、`app/tests/quota-panel.test.tsx`<br>#89：`server/tests/plan-change-audit.integration.test.ts` | 3cc67b9505<br>15d5b22e58<br>79b647f45a | 绿<br>绿<br>绿 | 需人工决定（`payments`） | #89 按推荐选项实现（只手动切换 + 审计），但选择尚未保存；#3 修缺陷 #5（自升 Pro） |
| K4 | #50 `feat/p4-k4-quota-guidance-ui` | `app/tests/quota-guidance.test.tsx`、`app/tests/query-client.test.ts` | ed91204f39 | 绿 | 待合并（CI 绿） | 对话轮次的配额错误留给 K4b |
| G1 | 未确定 | — | — | — | 无对应 PR | 相关：#21 把默认租户包改为 `examples/qoderwake`（缺陷 #14 第二部分），但没写 G1 |
| G2 | 无 | — | — | — | 无对应 PR | |
| WF1 | #33 `feat/wf-a-flow-store`<br>#45 `feat/wf-c-flow-api`<br>#47 `feat/wf-d-flow-app` | #33：`server/tests/wakerflows-store.integration.test.ts`<br>#45：`server/tests/wakerflow-routes.test.ts`<br>#47：`app/tests/wakerflows-screen.test.tsx` | efe7fda7a9<br>985f120b59<br>8ec5be6a31 | 绿<br>绿<br>绿 | 需人工决定（`wakerflow-entry`） | #47 暂把入口放在能力与资源；入口位置待定 |
| WF2 | #35 `feat/wf-b-plan-generation`<br>#47 `feat/wf-d-flow-app` | #35：`server/tests/wakerflow-generator.test.ts`、`server/tests/wakerflow-generation-requests.integration.test.ts`<br>#47：`app/tests/wakerflows-screen.test.tsx` | 662809d3ef<br>8ec5be6a31 | 绿<br>绿 | 待合并（CI 绿） | 平台模型默认不可选（`allowPlatformModel: false`） |
| WF3 | #33 `feat/wf-a-flow-store`<br>#35 `feat/wf-b-plan-generation`<br>#45 `feat/wf-c-flow-api`<br>#47 `feat/wf-d-flow-app` | #33：`server/tests/wakerflows-store.integration.test.ts`<br>#35：`server/tests/wakerflow-generation-requests.integration.test.ts`<br>#45：`server/tests/wakerflow-routes.test.ts`<br>#47：`app/tests/wakerflows-screen.test.tsx` | efe7fda7a9<br>662809d3ef<br>985f120b59<br>8ec5be6a31 | 绿<br>绿<br>绿<br>绿 | 待合并（CI 绿） | |
| WF4 | #33 `feat/wf-a-flow-store`<br>#45 `feat/wf-c-flow-api`<br>#62 `feat/wf-e-flow-runs` | #33：`server/tests/wakerflows-store.integration.test.ts`<br>#45：`server/tests/wakerflow-run.integration.test.ts`<br>#62：`app/tests/wakerflow-runs.test.tsx`、`server/tests/wakerflow-task-open.integration.test.ts` | efe7fda7a9<br>985f120b59<br>64e8952be6 | 绿<br>绿<br>绿 | 待合并（CI 绿） | 查收只按 Flow 名打开看板，不能直达单张卡 |
| WF5 | #45 `feat/wf-c-flow-api`<br>#62 `feat/wf-e-flow-runs` | #45：`server/tests/wakerflow-run.integration.test.ts`<br>#62：`app/tests/wakerflow-runs.test.tsx` | 985f120b59<br>64e8952be6 | 绿<br>绿 | 待合并（CI 绿） | 重启恢复（WF-F，#90）见门 4 |
| WF6 | #45 `feat/wf-c-flow-api` | `server/tests/wakerflow-run.integration.test.ts` | 985f120b59 | 绿 | 待合并（CI 绿） | |
| AUT1 | #40 `feat/d06-2-automation-data-plane`<br>#58 `feat/d06-3-automation-runtime`<br>#64 `feat/d06-6-automations-ui` | #40：`server/tests/automations-store.integration.test.ts`、`server/tests/automations-model.test.ts`、`server/tests/automation-tenant-policies.test.ts`<br>#58：`server/tests/automation-sweep.integration.test.ts`、`server/tests/automation-routes.test.ts`<br>#64：`app/tests/automation-form.test.tsx`、`app/tests/automations-section.test.tsx` | 8e8e6cc586<br>1f9a8f2b16<br>54b7ce79e1 | 绿<br>绿<br>绿 | 待合并（CI 绿） | |
| AUT2 | #63 `feat/d06-5-hook-ingress`<br>#64 `feat/d06-6-automations-ui` | #63：`server/tests/automation-ingress.test.ts`、`server/tests/automation-ingress.integration.test.ts`<br>#64：`app/tests/automations-section.test.tsx` | 6a80b06225<br>54b7ce79e1 | 绿<br>绿 | 待合并（CI 绿） | |
| AUT3 | #40 `feat/d06-2-automation-data-plane`<br>#58 `feat/d06-3-automation-runtime`<br>#64 `feat/d06-6-automations-ui` | #40：`server/tests/automations-store.integration.test.ts`<br>#58：`server/tests/automation-waker-executor.test.ts`<br>#64：`app/tests/automation-form.test.tsx` | 8e8e6cc586<br>1f9a8f2b16<br>54b7ce79e1 | 绿<br>绿<br>绿 | 待合并（CI 绿） | 只有 Waker 目标可运行；WakerFlow 目标在注册 WakerFlow 执行器之前会被拒绝 |
| AUT4 | #40 `feat/d06-2-automation-data-plane`<br>#58 `feat/d06-3-automation-runtime`<br>#64 `feat/d06-6-automations-ui` | #40：`server/tests/automations-store.integration.test.ts`<br>#58：`server/tests/automation-sweep.integration.test.ts`<br>#64：`app/tests/automations-section.test.tsx` | 8e8e6cc586<br>1f9a8f2b16<br>54b7ce79e1 | 绿<br>绿<br>绿 | 待合并（CI 绿） | |
| RES1 | #46 `feat/d08-1-knowledge-base`<br>#61 `feat/d08-3-knowledge-ui` | #46：`server/tests/knowledge-base.integration.test.ts`、`server/tests/knowledge-tools.test.ts`<br>#61：`app/tests/knowledge-screen.test.tsx`、`app/tests/assemble-knowledge.test.tsx` | 0a747c16bd<br>ffd939503f | 绿<br>绿 | 待合并（CI 绿） | |
| RES2 | 无 | — | — | — | 无对应 PR | v1.0 后 |
| ROLE1 | 无 | — | — | — | 无对应 PR | v1.0 后 |
| WF7 | 无 | — | — | — | 无对应 PR | v1.0 后 |
| WF8 | 无 | — | — | — | 无对应 PR | v1.0 后 |
| WF9 | 无 | — | — | — | 无对应 PR | v1.0 后 |
| SEC1 | 无 | — | — | — | 无对应 PR | |
| WIN1 | #13 `ci/complete-workspaces-windows` | `scripts/ci/windows-runner-probe.ts`（新 CI job `WIN1 device CLI probe (windows-latest)`） | 45f2971fbc | 绿 | 待合并（CI 绿） | 该 head 上 WIN1 探针 job 和 desktop Windows job 也是 success；它们不在 9 项必需检查之内 |
| DEV1 | 无 | — | — | — | 无对应 PR | |

### 按状态计数

| 状态 | 故事数 |
| --- | --- |
| 待合并（CI 绿） | 45 |
| 待合并（CI 红/未跑） | 0 |
| 无对应 PR | 29 |
| 需人工决定 | 3（K1 `free-pool`、K3 `payments`、WF1 `wakerflow-entry`） |
| 合计 | 77 |

无对应 PR 的 29 个：A2、A6、B4、C4、H3、H4、I4、I5、D6、F1、F2、F4、F5、F6、J1–J6、G1、G2、RES2、ROLE1、WF7、WF8、WF9、SEC1、DEV1。其中 RES2、ROLE1、WF7–WF9 已按 MVP 决定移到 v1.0 后。

## 审计缺陷与 PR

PR 编号取自各 PR 标题和正文。缺陷 #2 的验证过程见 `BASELINE-FAILURES.md`。

| 缺陷 | 内容 | PR | head SHA | CI |
| --- | --- | --- | --- | --- |
| #2 | `migrate.ts` 不跑 recovery 叠加迁移，及首轮 CI 红灯 | #2 `claude/magical-archimedes-8a6ljj`（base #1 `fix/ci-runnable`） | d0beb345c3 | 绿（#1 本身 `7b46ce7` 红，即首轮基线） |
| #3 | 抢注即成平台管理员 | #3 `fix/p1-plan-admin-and-verified-admin`；跟进 #4 `fix/p1-refuse-link-to-password` | 15d5b22e58；26ffe0d9d1 | 绿；绿 |
| #4 | 后台路径没有可信租户 | G01 栈：#8、#11、#14、#17、#22、#24、#68、#71；G01-D 测试 #72–#88；前置 #53 | #71 head 1199b0ae9e | 全部绿 |
| #5 | 任意用户可自升 Pro | #3；审计跟进 #89 `feat/plan-change-audit` | 15d5b22e58；79b647f45a | 绿；绿 |
| #6 | 模型探测 SSRF | #6 `fix/p1-ssrf-model-probe`；跟进 #7 `fix/p1-ssrf-mcp-agent-endpoints` | 7811d3c13c；74a6dad94b | 绿；绿 |
| #7 | 没有订阅就不限额 | #5 `fix/p1-quota-default-limits` | d917ec2573 | 绿 |
| #8 | RLS 强制默认只告警；app 角色有 CREATE | #10 `fix/p1-rls-enforce-app-role` | a1f2791022 | 绿 |
| #9 | 唯一键不按租户；vault 不绑定 AAD | #9 `fix/p1-tenant-unique-keys-vault-aad`、#12 `fix/p1-vault-reseal-skill-slugs`、#15 `fix/p1-tenant-skill-slugs` | 887af63113、340ef1b2a6、84db05734e | 绿 |
| #10 | 重启后无人回收遗弃的运行 | #16 `fix/p1-restart-recovery` | 51e80a1a43 | 绿 |
| #11 | 没有 token 计量 | #18 `fix/p1-metering`；读取侧 #49；真实调用对账 #52 | 7c930574a3；35179d495e；cbcc0ba17d | 绿 |
| #12 | 设备模式没有网关 | #19 `fix/p1-device` | de3ffe7e6f | 绿 |
| #13 | 服务端删除模型不检查引用 | #5 `fix/p1-quota-default-limits` | d917ec2573 | 绿 |
| #14 | 品牌（桌面端、服务端报错、默认租户包） | #20 `fix/p1-brand`、#21 `fix/p1-brand-default-package` | 3f5ce57a12、c61c3e64b4 | 绿 |

## 最终门相关 PR（不是故事）

| 门 | PR | 待决事项 |
| --- | --- | --- |
| 1 正式镜像 | #34 `feat/r1-release-ghcr`（tag → GHCR digest → 门 1） | `release` |
| 3 全套测试与严格 CI | #13 `ci/complete-workspaces-windows`（其余 workspace、Windows job） | — |
| 4 WakerFlow 闭环与重启恢复 | #45、#62；#90 `feat/wf-f-restart-recovery`（按推荐选项"标失败、不重放"实现） | `wf-restart` |
| 6 真实模型计费 | #52 `feat/p4-g6-model-e2e-harness`（手动触发的对账工作流） | `model-e2e` |
| 7 干净部署 | #36 `feat/r2-deploy-manual`（Linux 部分） | `release` |

G01-D 收尾（删除无帧时的 `system` 回退）还要等 `shared-visibility`、`team-rules`、`decision-tests` 三项决定，这三项不对应任何故事。
