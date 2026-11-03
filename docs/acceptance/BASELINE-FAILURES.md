# 首轮全量 CI 真实失败清单

规则：这里只记录 GitHub Actions 实际跑出的结果，不写推断。每个失败要么已修复（注明提交和验证它的运行），要么还开着（注明去向）。不允许用 skip、continue-on-error 或放宽断言的方式让它"消失"。

## 运行 1：PR #1 head `7b46ce7`（run 41432178680，2026-11-02）

这是代码第一次在完整组合下运行：PG17 + pgvector，非超级用户 `openbot_app`，6 个 server 分片。

| job | 结果 | 合计 |
| --- | --- | --- |
| static | 红：lint 通过，app typecheck 报 TS2769（`app/tests/autonomous-screen.test.tsx:439`） | — |
| app-test | 绿 | 0 fail |
| server-test 1 | 红 | 691 pass / 63 fail / 13 errors |
| server-test 2 | 红 | 1337 pass / 142 fail / 1 error |
| server-test 3 | 红 | 525 pass / 26 fail |
| server-test 4 | 红 | 625 pass / 119 fail |
| server-test 5 | 红 | 917 pass / 3 fail（基线 2aacf0f 也是这 3 个） |
| server-test 6 | 红 | 373 pass / 62 fail / 4 errors |
| image | 红：构建成功，s6 脚本没有执行位，容器起不来 | — |

主要根因及去向：

| 根因 | 影响 | 去向 |
| --- | --- | --- |
| `migrate.ts` 只跑 `drizzle/` 0000–0080，没跑 recovery 0081–0107；缺 `audit_events.subject_tenant_id`、`plugin_grants.assembly_binding`、`tasks.trigger_source` 及 56 张表（审计缺陷 #2） | 约 400 个失败 | PR #2 提交 927c4e7，已在运行 2 验证 |
| otel mock 漏导出 `otelConfigured`，泄漏到分片 1 的其他文件 | import error | PR #2 提交 f6781a8 |
| app typecheck TS2769 | static 红 | PR #2 提交 e0ec00f，已在运行 2 验证（static 绿） |
| `docker/s6` 脚本 mode 为 100644 | image 红 | PR #2 提交 4864e65，已在运行 2 验证（容器已能启动 PG 并完成迁移） |

## 运行 2：PR #2 head `6894772`（run 41433297602）

修复迁移后，server 失败从约 415 个降到 24 个。static 转绿。

| 分片 | head 结果 | 剩余失败簇 |
| --- | --- | --- |
| 1 | 948 pass / 16 fail / 4 errors | D06 四个审批集成套件 `BLOCKED_NOT_DISPOSABLE`；审批恢复 `approval_recovery_blocked`（6 个）；`approvals-continuation-recovery` 0≠1（2 个）；audit-retention `connection` 不是函数（4 个） |
| 2 | 1478 pass / 5 skip / 1 fail / 1 error | `continuation-target-store` `BLOCKED_NOT_DISPOSABLE` |
| 3 | 562 pass / 4 fail | role writer 未初始化 → email-signup 级联 3 个；SCIM reprovision 409 |
| 4 | 785 pass / 1 fail | role writer 未初始化（organization-store） |
| 5 | 919 pass / 1 fail | 12 张 `flow_source_*` 表的 RLS 不覆盖全部四个命令（`rls-write-scope`） |
| 6 | 488 pass / 1 skip / 1 fail | load-order 源码守卫：D06 套件绕过共享 DB 测试助手 |
| image | 红 | `ROLE_WRITER_DATABASE_URL is required`：仓库里没有任何地方开通 `openbot_role_writer` |

另外：基线 2aacf0f 早于迁移修复，它的日志永远无法解析，导致报告整体判为"未验证"。改为只由 head 决定门禁，基线解析不了时只省略对比部分。见 PR #2 中的 `scripts/ci/test-report.mjs`。

以上失败簇都在 PR #2 继续修复，修完后在此补上提交号和运行号。

## 运行 3–6：逐个根因修复（PR #2）

| 运行 | head | 结果 | 本轮修复 |
| --- | --- | --- | --- |
| 41436886165 | bbd3848 | static、app、server 1/3/4/6 绿；server 2（8）、server 5（2）、image 红 | role writer 开通（0109、镜像、CI、测试助手）、flow_source 显式拒绝（0108）、D06 一次性库、otel/postgres mock 泄漏、审批恢复 |
| 41438689485 | 49ce9ab | server 5 转绿；server 2（8）、image 红 | `roles.ts` 的 MAINTAIN 权限按 PG 版本分支（镜像是 PG16）；冻结文件改用已批准的 lint inverse；rls-write-scope 不再把排除式 `NOT IN ('system',…)` 和 EXISTS 子查询误判为可写平台行 |
| 41439837095 | 0b6ff84 | server 2 由 8 个失败降到 1 个；image 红 | 迁移 0110：continuation 账本按租户可读、可锁，app 角色不能改账本；就绪门先于 role writer 启动，owner URL 以 `rls-not-enforced` 被拒 |
| 41440346726 | dd13a9f | server 2 剩 4 个 | 测试中模拟租约过期改走 fixture 角色 |
| 41440923225 | a3a64b5 | **9/9 全绿**（static、app-test、server-test 1–6、image） | 0110 允许本租户推进自己的 step（reserved → running → terminal） |

PR #10（= a3a64b5 + 缺陷 #8）的 run 41441075576 同样 9/9 全绿。

这是交付 CI 第一次在完整组合下全绿：PG17、非超级用户且无 BYPASSRLS 的 `openbot_app`、独立的 role writer、6 个 server 分片零失败、镜像启动并通过 smoke 断言。仍保留的 `continue-on-error` 只用于基线对比步骤；门禁步骤只看 head 的零失败。
