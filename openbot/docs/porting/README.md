# 能力资源移植（WorkBuddy → 熊宝数字员工）

> 移植方案：`docs/plans/2026-11-12-能力资源移植方案.md`（仓库根）。
> 本目录是移植的**交付物**：审计表是"到底移植成功了百分之几"的唯一可信答案，不用文件数汇报。

## L0 里现在有什么

| 资源 | 数量 | 说明 |
| --- | --- | --- |
| 员工（agent） | 28 | 5 个种子角色 + 23 个移植（3 支专家团的 lead 与成员含在内） |
| 技能（skill） | 109 | 全部可见、可授予；**62 条 `full`，11 条 `degraded`，36 条 `blocked`**（包内记录，与 `tool-ref-audit.md` 同源） |
| 团队（team） | 3 | 软件工坊 / 卡尔的人感PPT专家团 / 软件公司（teams.yaml → 频道 + 成员 + 授予） |
| 连接器（connector） | 3 | github（user-oauth）/ tapd、tencent-docs（deployment-bearer，**待绑定**） |

**口径（分层版，R18）**：109 条技能全部可见可授予；`full` 开箱即用；`degraded` 是"能用但按正文
走会撞墙"——正文引用了未入包的附件（`references/` 里被拒的文件、`assets/`、`scripts/` 等），
判定原因见 `_porting.reason` 与 `reason_ref`；`blocked` 是审计判定的
"本环境不可执行"（员工没有本地 shell / 无脚本通道 / 引用了平台私有身份 / 技能本体只对宿主成立），
不是"没移植"——每一条的判定原因见 `tool-ref-audit.md` 的逐条表，UI 的「我的」页给每条技能发了三档徽章
（完整可用 / 部分可用 / 暂不可用）。**对外不要用"24% 不可移植"这类两档表述。**

## 管道怎么跑

| 命令 | 作用 |
| --- | --- |
| `bun run port:capabilities` | 从本机 WorkBuddy 装量读原始目录 → 归一化 → 工具引用审计 → 产出包与报告（写入 `examples/xiongbao`） |
| `bun run port:capabilities -- --verify ./examples/xiongbao` | 校验包：9 个许可字段齐备，且 `capability-manifest.yaml` 首行与 `tool-ref-audit.md` 头部的 `audit_rules_sha256` 一致，缺一 exit 1 |
| `bun run port:assemble` | 把管道产物落位成品牌包文件（幂等：跑两次 `diff -r` 无差异） |
| `bun run port:verdict-refresh -- --package examples/xiongbao` | 按包内 `_porting.dropped` 与 `assets` 重算档位，只改 `_porting.runnable` 及其 `reason`/`reason_ref` 三行、manifest 同名行同步（源侧漂移、管道跑不动时的兜底；`--check` 只报告不写盘，不一致 exit 1） |
| `bun run port:audit-report -- --package examples/xiongbao` | 按包内记录的档位重写该包的 `tool-ref-audit.md`（证据优先取规则表重扫，扫不到的用 `_porting.reason_ref`）。包比审计更乐观直接报错；`--check` 只比对不写盘，不一致 exit 1 |

转换器源码在 `tools/port-capabilities/`，与交付物同仓。

## 交付物（本目录）

| 文件 | 内容 |
| --- | --- |
| `tool-ref-audit.md` | 每个技能 / 员工一行的审计判定（slug / runnable / 决定性命中原文 + 行号 / 成因）。**由工具生成，不手改** |
| `manifest.md` | `capability-manifest.yaml` 的字段契约与校验规则 |
| `slug-conflicts.md` | 同名 slug 的处理记录与丢弃清单的整理版 |

## 端到端验证

`server/tests/port-l0-endtoend.integration.test.ts` 是移植成功的**链级**证明（CI 上对 PostgreSQL 跑）：
真实包同步 → 28 员工与唯一 avatar_seed → 35 条 blocked 如实落库 → `/技能` 的 instructions 前插进
本轮 prompt 且"声明工具不给授权" → 团队 lead `@成员` 的 hop 进队列、投递可读、**删掉 bot grant 同一
操作被拒** → 链深在 `maxDepth` 处被拦（`depth_cap`）→ 连接器绑凭证 → 刷新工具 → 授予 → 真实 MCP
线上 `callTool` 走通。

单测只证明"每一节车厢是好的"，这条链证明的是"它们挂在一起能跑"——`_porting.runnable`
的缺口（35 条 blocked 被静默当 full 加载）就是这条链抓出来的，任何合成 fixture 都测不到它。

## 许可边界（R1/R2）

- 9 个许可字段缺一，条目不进包——转换器硬校验，不靠人记。
- `redistributable: false` 的正文不进仓。
- 凭据永不入仓：连接器只落服务行与 `credential_env` 名，值由部署环境提供（`.gitignore` 挡
  `.credentials.v3.json`；入仓前 grep）。
