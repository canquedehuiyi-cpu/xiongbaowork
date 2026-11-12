# slug 冲突与丢弃记录

本文件由 `bun run port:capabilities` 生成，用于人工复核同名与丢弃。

## 同名冲突

| 基础 slug | 来源 | 最终 slug |
| --- | --- | --- |
| dev-expert | skills/dev-expert__indiv-weishui__skillhub/SKILL.md | dev-expert--indiv-weishui |
| dev-expert | skills/dev-expert__skillhub/SKILL.md | dev-expert--skillhub |
| dev-expert | skills/dev-expert__user_814dbe54__skillhub/SKILL.md | dev-expert--user-814dbe54 |
| frontend-dev | plugins/marketplaces/experts/plugins/frontend-developer/skills/frontend-dev/SKILL.md | frontend-developer--frontend-dev |
| frontend-dev | plugins/marketplaces/experts/plugins/senior-developer/skills/frontend-dev/SKILL.md | senior-developer--frontend-dev |
| fullstack-dev | skills/fullstack-dev/SKILL.md | fullstack-dev |
| fullstack-dev | plugins/marketplaces/experts/plugins/frontend-developer/skills/fullstack-dev/SKILL.md | frontend-developer--fullstack-dev |
| fullstack-dev | plugins/marketplaces/experts/plugins/senior-developer/skills/fullstack-dev/SKILL.md | senior-developer--fullstack-dev |
| github | skills/github/SKILL.md | github |
| github | plugins/marketplaces/experts/plugins/frontend-developer/skills/github/SKILL.md | frontend-developer--github |

规则：只有一个来源时保留裸 slug；有多个来源时，唯一处在最高优先层（用户级）的那个保留裸 slug，
否则全部加 `--<来源>` 后缀。三条 `dev-expert` 都装在用户级，因此三个都带后缀，没有谁覆盖谁。

## 丢弃

| kind | 归属 | 丢弃物 | 原因 |
| --- | --- | --- | --- |
| agent | engineering-workflow-coach | plugins/marketplaces/experts/plugins/ex_eqoqYRT1NIwb/.codebuddy-plugin/plugin.json | 与 engineering-workflow-skills 同名同版本且内容一致（按 plugin.json + agents/*.md 的 sha256 去重） |
| connector | github | connectors-marketplace/connectors/github/mcp.json | WorkBuddy auth_mode=server-side 无 openbot 等价物（平台代持凭证），本包按 user-oauth 声明，凭证需自行提供 |
| connector | github | connectors-marketplace/connectors/github/skill/SKILL.md | 连接器附带的 SKILL.md 只是教模型如何安装该连接器 |
| connector | tapd | connectors-marketplace/connectors/tapd/skills/SKILL.md | 连接器附带的 SKILL.md 只是教模型如何安装该连接器 |
| skill | browser-use | plugins/marketplaces/experts/plugins/senior-developer/skills/browser-use/SKILL.md | 与 plugins/marketplaces/experts/plugins/frontend-developer/skills/browser-use/SKILL.md 内容一致（sha256 fb839ae844ae…） |
| skill | engineering-workflow | plugins/marketplaces/experts/plugins/ex_eqoqYRT1NIwb/skills/engineering-workflow/SKILL.md | 所属专家包 ex_eqoqYRT1NIwb 是被丢弃的重复下载 |

## 警告

无。

