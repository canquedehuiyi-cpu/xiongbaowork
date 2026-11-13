# ArkUI 编码规则索引

这些规则按任务读取，不要求每次修改扫描全表。语法限制适用于对应 ArkTS 编译模式；迁移判断需看项目版本和实际诊断。

| 文件 | 何时读取 |
|---|---|
| [00-arkts-syntax](00-arkts-syntax.md) | TS 转 ArkTS、对象类型、空安全、语言级错误 |
| [01-import](01-import.md) | API 导入、Kit、全局组件、符号未找到 |
| [02-uicontext](02-uicontext.md) | 多窗口、异步回调、UI 上下文和全局接口 |
| [03-component](03-component.md) | struct、命名冲突、生命周期、自定义组件 |
| [04-build](04-build.md) | 声明式 UI 描述、根节点、渲染时修改状态 |
| [05-state](05-state.md) | V1/V2、状态不刷新、Builder、跨组件通信 |
| [06-rendering](06-rendering.md) | ForEach、LazyForEach、Repeat、稳定 key |
| [07-attribute-params](07-attribute-params.md) | 构造字段、回调类型、易混 API |
| [08-navigation](08-navigation.md) | Router/Navigation、路由表、参数、返回栈 |
| [09-dialog](09-dialog.md) | AlertDialog、ActionSheet、Sheet、控制器 |
| [10-style](10-style.md) | Extend、Styles、stateStyles、动画、主题 |
| [11-extension](11-extension.md) | Modifier、节点、手势、拖拽 |
| [12-layout](12-layout.md) | 容器子组件、嵌套滚动、测量 |
| [13-performance](13-performance.md) | 更新开销、复用、泄漏、可见性 |
| [14-deprecated](14-deprecated.md) | 版本迁移与废弃提示 |

改动前确认目标版本；改动后检查对应编译诊断和用户流程。规则不是一次性全项目迁移清单。
