# Claude交付与Root独立验证合同

日期：2026-11-02。开发作者为Claude Code；本Root负责独立验证。所有下列命令是**待执行说明**，本次文档工作没有执行它们。

## 先交可审查的包

每包提供：repo/branch/精确commit、parent、目标故事/原包、实际before与after文件清单（mode/blob/bytes/SHA256）、最小diff、功能变化、兼容项、实际测试及NOT_RUN项、资源/环境/网络/PG门、回滚点。≤8件，独立审查结束再下包。有问题回Claude同包修，Root不改同一包Source后再自审。

当前代码参考D06 `2aacf0f19fdaaeeb4414d4ee4c09cef1f2fc7634`，tree `ea48fde7a70474c5d51ad567e6cc6f9ffb063fb5`。其他基线应另列差异，不套用这份调用计数。

## 执行前置必须实际证成

1. 获准云端、真实目录/HEAD和持有者明确；原卷/两child未恢复不能冒已恢复，新检出也不能冒原卷。
2. Bun应为1.3.14，revision预期 `1.3.14+0d9b296af\n`。曾固定官方ZIP35595658B/SHA256 `a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7`；仅locator/hash不等下载、dist、身份或执行已证。
3. D06原锁文件453991B/SHA256 `c5b3f3c17b2159e033c7cf8911780b98d0ebeba93756e175e32064b15849e670` / blob `3482ff729f744a05ecd986478f34e0cb46dc6730`。不得升级、改锁、运行安装脚本或用缺少完整依赖的stub代替。
4. 依赖完整性、缓存/离线布局、实际装载路径、cwd、环境/配置/凭据和网络隔离必须独立静态审后实际确认；不能因为bun.lock存在就宣布依赖可用。
5. 保持app/server的bunfig及preload、alias和原测试正文。app/server均会加载server/scripts/test-preload.ts和app/tests/preload.ts；eventsource ESM、Vertex fail-loud mock、DOM register/import/unregister均不能关闭来绕过失败。
6. 指定测试不得访问真实模型provider/生产/赠额/计费。真实PG测试单独授权与隔离，不能挪用生产库。
7. 使用适用的真实资源/限时/清理门。旧R8的45秒earliest-origin、2秒cleanup、原60/30 envelope及共享压力STOP等不得悄悄放宽；full sumRSS、外部SIGKILL/PID1回收等未证项仍开放。若方案不适合下一阶段，先给完整可审方案，不把旧例外当新通用批准。

## 精确执行顺序

两个package都没有test script；入口为Bun native test。每条保持对应package cwd，用独立受控调用与真实退出码；不要在Root Windows执行。

| 次序 | cwd | 待执行命令 | 当前固定提交的预期定义数 | 现状 |
| --- | --- | --- | ---: | --- |
| 1 | openbot/app | `bun test ./tests/quota-error-contract.test.ts` | 16 | NOT_RUN |
| 2 | openbot/server | `bun test ./tests/quota-error-contract.test.ts` | 6 | NOT_RUN |
| 3 | openbot/app | `bun test ./tests/autonomous-screen.test.tsx` | 13 | NOT_RUN |
| 4 | openbot/server | `bun test ./tests/autonomous-summary.test.ts` | 6 | PG_GATE_PENDING / NOT_RUN |

前三项合35个**定义**，不是已执行35项。实际固定Source如计数不同，先报具体定义名/参数化展开和差异，不改预期去造通过。app提示候选的22/29/30及K2的85定义均另有范围，不能叠加成全套通过。

app quota-error-contract9325B，SHA `3b57e284...`；D06 app autonomous-screen21679B，SHA `66bfeba91df99a4f041d53235bdb509176be0fc02bc40e5192a60c0bb297ffc9`。短SHA只作索引，验收必须从精确Git提交取全文自算完整值；不得把短SHA当完整校验。

D06 app应覆盖真实DELETE未决后二击仍1请求、ACK后GET未回窗口、另一agent inactive autonomous缓存证明all族失效，保原既有测试正文。不能以生产store stub或新实例掩盖同实例状态问题。

## D06服务端PG门

只接受明确的 `TEST_DATABASE_URL`，拒空、非PG及指向openbot生产库的配置；测试pool最大2。**字符串检查不等真实隔离**：还需验证数据库/schema/角色、RLS/FORCE RLS、租户上下文、owner与运行期非超级用户/无BYPASSRLS区别、清理和事务/audit实际行为。给两租户、平台目录与私有凭据的正反向结果。不得因为SQL/snapshot有策略就认定实际PG强制隔离。

该门未通过时第四条保持BLOCKED，不提前跑、不用普通DATABASE_URL替代、不建临时假schema后冒充正式迁移成功。正式schema/SQL/snapshot/journal、实际迁移runner和driver COMMIT/same-tx audit是独立证据层。

## 真实结果格式

每条交付原始命令/确切cwd/HEAD、Bun+依赖装载、环境白名单（不含值）、受控资源/超时/清理结果、起止时间、exit code、测试名与pass/fail/skip多重集、Unhandled error和完整安全输出文件的bytes/SHA。不能仅给截图“绿了”或汇总总数；历史参数化超时族应比较失败名多重集。

有错误先保原结局，不重放未知操作。修复后Claude给新commit与delta；Root核差异、按适用范围复验。未变化的已闭独审不无限重复，组合/依赖/行为变化则必须重新证成对应范围。

## 后续商用验收

35项局部CPU测试通过仍不足：再按状态JSON和原路线图验77故事/18包以及7最终门，包括同最终SHA正式镜像8GET+未知API404、真实PG隔离、原完整CI无fail/Unhandled、WakerFlow生命周期/重启、真实用户设备/审批/离线、真实模型正确计量与计费、干净Win/Linux客户部署。当前不授provider/付费/生产/新资源；需要这些门时提出具体可审决定。

在7门和逐项商业要求都未证成前，Root保持“未交付商业验收完成”。用户已停止原开发调度，本合同不会自动恢复原writer或启动Claude。
