# 列表与条件渲染

- ForEach/LazyForEach 的 key 参数在接口中可选；动态列表建议显式使用稳定且唯一的业务 ID。不要把推荐误报成语法必填。
- 索引 key 对插入、删除和排序不稳定。key 标识项的身份，项内状态还需正常观察；不要每次刷新随机生成 key 来强制重建。
- ForEach/LazyForEach/Repeat 不是真实布局容器，不给它们链 `.width()` 等容器属性。
- LazyForEach 用支持懒加载的父组件，并通过实现的 IDataSource/DataChangeListener 通知变化。不要期待替换普通 dataSource 字段就自动通知框架；通知方法名逐项对照 SDK，不猜 `onDataReload` 等名字。
- List/Grid/WaterFlow/Swiper 等对懒加载、子项尺寸、多个生成器混用的支持取决于具体容器和 API 版本。确保尺寸可测和真实滚动，不一概禁用合法混合布局。
- Repeat 的普通渲染和 virtualScroll 兼容范围不同。API 版本、状态体系与模板复用策略分别核对；`totalCount` 在已知数据长度时不一定必填。
- `cachedCount` 可在支持的滚动容器上配置；Repeat `.template()` 的 options 也可包含缓存选项。没有独立 `.cachedCount()`/`.totalCount()` 链时不凭空补上。
- 条件切换可能销毁分支组件；需跨分支保留状态时提升状态所有者。空分支不自动代表非法代码，但要明确空态体验。

[API 卡](../quick-apis/13-rendering.md) · [容器约束](12-layout.md)
