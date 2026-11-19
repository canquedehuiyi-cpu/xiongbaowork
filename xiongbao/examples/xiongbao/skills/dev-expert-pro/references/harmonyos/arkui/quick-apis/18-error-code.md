# 18. 错误诊断入口

> 来源：新版 `hmos-arkui-develop-skill`；集成与版本范围见 [知识库入口](../index.md)。

先保留完整错误文本、文件行号与工具版本。单个数字可能对应一类错误，不能仅按编号猜根因。

| 诊断线索 | 优先检查 |
|---|---|
| 100003 / Router 栈限制 | [导航](../quick-rules/08-navigation.md) |
| 100005 / 100006 / Navigation 目标创建 | [路由映射与 NavDestination](../quick-rules/08-navigation.md) |
| 100021 / 节点修改失败 | [节点所有权](../quick-rules/11-extension.md) |
| 10505001 / 属性不存在 | [实际 API](../quick-rules/07-attribute-params.md)、[真实命名冲突](../quick-rules/03-component.md) |
| 10605038 / arkts-no-untyped-obj-literals | [对象类型上下文](../quick-rules/00-arkts-syntax.md) |
| 10605040 / arkts-no-obj-literals-as-types | [具名类型](../quick-rules/00-arkts-syntax.md) |
| 10905202 / Button 内容冲突 | [构造与 children](../quick-rules/04-build.md) |
| 130000 / 130002 / 监听器诊断 | [状态体系与回调身份](../quick-rules/05-state.md)，再查具体 API 声明 |
| 140109 / Builder 参数变更 | [Builder 输入所有权](../quick-rules/05-state.md) |
| arkts-no-decl-merging | [同作用域声明与模块边界](../quick-rules/03-component.md) |
| arkts-no-destruct-* / arkts-no-any-unknown / arkts-no-spread | [目标语言模式的语法约束](../quick-rules/00-arkts-syntax.md) |

这些是原参考的诊断定位线索，不是跨所有 SDK 固定不变的错误码字典。
