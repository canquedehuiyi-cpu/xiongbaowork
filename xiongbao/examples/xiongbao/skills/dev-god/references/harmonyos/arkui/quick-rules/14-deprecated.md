# 版本迁移与废弃提示

“有替代接口”“官方不推荐”“从某 API 标记 deprecated”“当前 SDK 不再支持”是不同状态。确认具体符号的声明与版本，不批量禁用整类接口。

| 现有用法 | 评估方向 |
|---|---|
| `@ohos.*` 导入 | 若目标版本和项目支持 Kit，新增代码可选对应 `@kit.*`；旧导入不自动失效 |
| 全局 UI API | 多实例/异步场景优先 UIContext 实例入口；核对替代 API 最低版本 |
| Router / pageTransition | 新页面架构可评估 Navigation；既有页面继续维护或按明确迁移计划调整 |
| CustomDialogController | 新需求可评估 PromptAction 的自定义弹窗能力；不要未经验证替换所有现有控制器 |
| V1 static 初始化 | 避免依赖不被执行的组件静态代码块，迁移初始化位置即可，不强制改 V2 |
| Swiper 等废弃枚举 | 查声明的 @deprecated/@useinstead 和实际布局差异后替换 |

迁移要验证 API 兼容下限、状态同步、返回栈、关闭生命周期和原页面交互。对于未要求迁移的任务，采用完成需求所需的局部修改。

[导入](01-import.md) · [上下文](02-uicontext.md) · [导航](08-navigation.md)
