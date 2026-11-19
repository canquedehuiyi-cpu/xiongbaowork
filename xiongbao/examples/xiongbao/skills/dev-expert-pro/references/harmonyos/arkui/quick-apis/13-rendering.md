## 13. 渲染控制

> 来源：新版 `hmos-arkui-develop-skill`；集成与版本范围见 [知识库入口](../index.md)。

| 语法 | 入口摘要 | 注意 |
|---|---|---|
| if/else | 条件渲染 UI 分支 | 不在条件中修改状态 |
| ForEach | `ForEach(arr, itemGenerator, keyGenerator?)` | key 可选；动态数据建议稳定唯一业务 key |
| LazyForEach | `LazyForEach(dataSource, itemGenerator, keyGenerator?)` | IDataSource 和变更通知，需匹配容器 |
| Repeat | `Repeat<T>(arr)` | 普通/虚拟模式和状态体系的支持范围查版本 |

API 24 RepeatAttribute 的常用方法：each、key、virtualScroll、template、templateId。virtualScroll 的 options 可包含 `totalCount`；template 的 options 可包含 `cachedCount`。不要把 options 字段写成并不存在的 `.totalCount()` 或 `.cachedCount()` 链。滚动容器自己的 cachedCount 是另一个接口。

[渲染规则](../quick-rules/06-rendering.md) · [布局规则](../quick-rules/12-layout.md)
