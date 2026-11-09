# 上游同步点

本目录（`openbot/`）是 [CopilotKit/openbot](https://github.com/CopilotKit/openbot) 的二次开发版本，
在保留上游全部功能的基础上叠加熊宝的多租户、计费、员工/群组、设备端等能力。

| 项 | 值 |
| --- | --- |
| 分叉点 | `63f99cf`（2026-10-05，#734） |
| 当前已同步到 | `6fb38c8b`（上游 #784，2026-10-13） |

## 同步方法

不导入上游历史。每一阶段用三方合并，以「上次同步点」为共同祖先：

```bash
git merge-tree --write-tree --merge-base=<上次同步点> <本仓库 openbot 子树提交> <上游目标提交>
```

解决冲突后作为普通提交进 PR，并更新上表。冲突的取舍原则：

- 上游的结构性改动（如 f4bc60b 统一 Bot 构建入口）照收，把我们新增的扩展点并入上游的新结构。
- 我们的多租户（RLS、租户帧）、计费、员工/群组、设备端等能力一律保留。
- 上游新增的数据库迁移改编为 recovery overlay，按合入顺序续号（`when` 严格递增），新表补 `tenant_id` 与 RLS。
- 界面文案保持中文与熊宝品牌。

## 已恢复的分叉时删除项

- R0：CopilotKit Intelligence 改为**可选接入**（`INTELLIGENCE_API_KEY`），恢复自动学习的设置、
  管理页与技能下发、self-host banner 的付费判断；对话线程仍留在本地 PostgreSQL，学习证据不会
  自动送进 Intelligence（见 `docs/automatic-learning.md` 顶部说明）。

## 各阶段记录

### M1：同步到 `bbd882c8`（v0.1.2）

统一 Bot 构建入口（f4bc60b `ActorAgentResolver`），我们的扩展点作为尾参数并入。

### M2：同步到 `6fb38c8b`（#784，toolkit 抽取）

**收进来的上游改动**

- `@openbot/toolkit`：回合引擎（`run-turn`）、无界面工具、对话租约、历史清洗、CopilotKit 适配层。
  toolkit 保持与上游同构，不引用服务端代码；我们的需求作为端口（`toolkit/src/ports.ts`）并入：
  `modelNamedIn`、`answered`（按租户记模型用量、交付附件，故事 H4 / A9）、`scope`（看板卡片归属，
  WP-1.2）。服务端在 `server/src/routines/run-turn.ts` 统一填好这些端口，服务端所有调用都从这里拿。
- 关联外部账号（#763，Slack 关联码 / GitHub 登录）：两张表按人隔离；“这个外部账号是谁”“关联码
  发给了谁”两处以 platform 帧读，写入一律以本人租户。界面在 设置 → 已连接的账号。
- 记忆可放进 Intelligence（#773）、自动分配学习容器（#774）、默认开启记忆来源和后台调研（#776）、
  启动时检查模型可用性（#782）与 Intelligence 授权（#771）、Web Bot Auth 与有头浏览器（#772/#775）、
  验证码在密码之后再问（#780）、审计导出 CSV（#751）、提案重名提示（#778）、等待中卡片的私密登录（#777）、
  “每个可写文件夹的命令都要先问”（#759）。凡是依赖 Intelligence 的，都只在配置了 `INTELLIGENCE_API_KEY`
  时生效。
- 迁移：上游 0053–0056 改编为 overlay `0155_identity_links`、`0156_memory_on_intelligence`、
  `0157_default_opt_outs`、`0158_sign_in_code_step`；R0 的自动学习迁移为 `0154_learning`
  （0146、0152、0153 是 MCP 会话的迁移，按字节一致收入。main 与 v0.2.5 已带着 0152、0153 发布，所以 R0、M2
  的迁移编号排在 0153 之后，when 也更大，否则在已升级的库上会被跳过）。

**有意不收或改写的部分**

- #757（应用账号可归团队，Shared 应用审批）与 #765（侧栏只剩 Bots 与 Skills 的新信息架构）不收：
  前者与插件改造一起交给 MCP 会话处理，后者与我们的员工 / 群组信息架构冲突。
- #784 对 `server/src/index.ts` 的拆分（`*-wiring.ts`、`http-server.ts`、两个 sweep 文件）不采用：
  我们的入口跑在 `startupLifecycle.run` 里并带租户帧与配额等接线，这些装配仍内联在 `index.ts`，
  上游拆出的文件因此未收入。#784 对 `server/src/plugins/**` 的拆分同样留给 MCP 会话。
- 记忆默认项（#776）会在一个人第一次和某位员工单独对话后，为这位员工开启后台调研（每四小时），
  会产生模型用量；不需要时设 `OPENBOT_PROACTIVE_DEFAULTS=false` / `OPENBOT_MEMORY_SOURCE_DEFAULTS=false`。
