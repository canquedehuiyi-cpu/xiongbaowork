# slug 冲突与丢弃记录（整理版）

> 权威数据由 `bun run port:capabilities` 生成，落在 `examples/xiongbao/slug-conflicts.md`，随包交付；
> 本文是给人读的整理版，记录**规则**与**当时的判定**。两者不一致时以生成文件为准，并回头改本文。

## 为什么会有冲突

三条来源汇入同一个 slug 命名空间：本包种子（`skills.yaml` 既有条目）、WorkBuddy 用户级技能、
专家包内技能。`skills.slug` 全局唯一，而 `plugin_grants.ref` 对技能存的就是 slug——**slug 一变，
既有授权按设计静默失效**（R17），所以冲突不能静默覆盖，只能归一化 + 记录 + 拒绝覆盖。

## 归一化规则

1. 只有一个来源 → 保留裸 slug。
2. 多个来源 → 唯一处在**最高优先层（用户级）**的那个保留裸 slug；否则全部加 `--<来源>` 后缀。
3. **裸名一律给用户级；包内那份加包名后缀**（R12：`fullstack-dev` 同时是包内技能与用户级技能，
   两者脚本不同，裸名抢位会让其中一个悄悄失效）。

## 本包的判定（节选，全文见生成文件）

| 基础 slug | 来源 | 最终 slug |
| --- | --- | --- |
| dev-expert | skills/dev-expert__indiv-weishui__skillhub | dev-expert--indiv-weishui |
| dev-expert | skills/dev-expert__skillhub | dev-expert--skillhub |
| dev-expert | skills/dev-expert__user_814dbe54__skillhub | dev-expert--user-814dbe54 |
| frontend-dev | frontend-developer 包 | frontend-developer--frontend-dev |
| frontend-dev | senior-developer 包 | senior-developer--frontend-dev |
| fullstack-dev | 用户级 | fullstack-dev（裸名） |
| fullstack-dev | frontend-developer 包 | frontend-developer--fullstack-dev |
| fullstack-dev | senior-developer 包 | senior-developer--fullstack-dev |
| github | 用户级 | github（裸名） |
| github | frontend-developer 包 | frontend-developer--github |

三条 `dev-expert` 都装在用户级，因此三个都带后缀，没有谁覆盖谁。

## slug 稳定性义务（R17）

- **slug 规则一经落进生产包不许改**，只能加映射。
- 哈希兜底种子必须是**源码身份**（`<包>/<技能目录>`，相对路径、与正文和绝对路径无关）——
  换机器 slug 不变；`shortenSlug` 定位为永久兜底，触发即报警。
- 单测证明"同内容不同 source root → slug 完全相同"。

## 丢弃记录（为什么不入仓）

| kind | 归属 | 丢弃物 | 原因 |
| --- | --- | --- | --- |
| agent | engineering-workflow-coach | 专家包 plugin.json | 与 engineering-workflow-skills 同名同版本且内容一致（sha256 去重） |
| connector | github | connectors-marketplace 的 mcp.json | WorkBuddy `auth_mode=server-side` 无 openbot 等价物（平台代持凭证），本包按 user-oauth 声明 |
| connector | github / tapd | 连接器附带的 SKILL.md | 只教模型如何安装该连接器，不是能力 |
| skill | 各技能 | 超上限的 references 附件 | 逐条记进该技能 `_porting.dropped`，理由写明（R7：token 成本） |
