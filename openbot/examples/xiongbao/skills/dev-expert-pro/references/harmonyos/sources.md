# 鸿蒙资料来源与使用边界

本知识模块在 2026-10-08 根据用户提供的本机资料整合，作为编程大神的按需参考，不注册独立角色或额外 Skill。

| 来源资料 | 本包采用的内容 | 适配方式 |
| --- | --- | --- |
| `hmos-arkui-develop-skill` | [ArkUI API 卡片与编码规则](arkui/index.md) | 保留主题检索结构，校准已确认的错误、冲突和过度强制规则；不复制另一份总控入口 |
| `arkts-error-fixes`，并参考 `arkts-grammar-standards` / `arkui-knowledge` | [编译错误诊断](compile-errors.md) | 按错误证据整理修复路径，舍弃未经目标 SDK 验证的强制类型转换和过时模板 |
| `hmos-runtime-fix-skill` 的错误知识 | [运行时诊断](runtime/index.md) | 保留症状检索，区分原因候选与已证实根因；不包含上游采集器、执行器或安装逻辑 |

新版资料来自用户本机技能集合，其集合版本标记为 `0.2.1`；各子目录的标记为技能名称，不能据此推导独立版本号或适用的 HarmonyOS SDK 版本。旧版资料没有统一的可核实版本号。本说明不声称新旧名称构成官方迁移关系。

运行时上游入口注明知识来自 [HarmonyOS Skills 的 hmos-jscrash-analysis](https://gitcode.com/HarmonyOS_Skills/harmonyos-agent-skills/tree/main/03-solutions/quality/stability/hmos-jscrash-analysis)。其余 API/规则以所提供文件为来源，不冒称整个整合包经华为认证。原始声明及可核对的上游链接按内容保留，不将第三方资料改称本产品原创，也不以本文件另行授予第三方内容许可证。

本模块增加了编译期与运行时分流、按需读取、环境版本核对和实际复验要求。资料中的示例和参数卡未在全部 SDK、设备或宿主逐项实测；有冲突时，定位当前工程的 SDK 声明与对应官方文档，修正针对当前任务的使用方式，不能通过删校验或换新 SDK 强行套用卡片。构建通过、安装成功和目标页面交互通过分别保留证据。
