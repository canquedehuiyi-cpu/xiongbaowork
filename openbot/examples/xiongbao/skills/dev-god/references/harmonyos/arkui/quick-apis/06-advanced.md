## 6. 高级/组合组件

> 来源：新版 `hmos-arkui-develop-skill`；集成与版本范围见 [知识库入口](../index.md)。

这是能力与声明文件定位表。多数 options 为示意，不能按表中省略字段生成对象；高级组件还需查目标版本 Kit 导出、V1/V2 以及设备支持。

| 组件 | 构造签名 | 分类 | 核心说明 |
|------|---------|------|---------|
| **XComponent** | `XComponent({id, type: XComponentType, libraryname?, controller?})` | 渲染 | 支持 EGL/OpenGLES 渲染，type: surface/texture/component |
| **RichEditor** | `RichEditor(options: RichEditorOptions)` | 编辑 | 富文本编辑器，支持图文混排、自定义菜单 |
| **RichText** | `RichText(content: string)` | 展示 | 富文本展示，支持 HTML 子集 |
| **TreeView** | `TreeView(...)`（查 TreeView 声明） | 树形 | 树形列表 |
| **Chip** | `Chip(options: ChipOptions)` | 标签 | 标签、图标与关闭能力需按 ChipOptions 当前字段填写 |
| **ChipGroup** | `ChipGroup(options)` | 标签组 | 管理多个 Chip |
| **ComposeListItem** | `ComposeListItem(options)` | 列表项 | 组合列表项 |
| **ComposeTitleBar** | `ComposeTitleBar(options)` | 标题栏 | 主标题栏 |
| **EditableTitleBar** | `EditableTitleBar(options)` | 标题栏 | 可编辑标题栏 |
| **SelectTitleBar** | `SelectTitleBar(options)` | 标题栏 | 选择型标题栏 |
| **TabTitleBar** | `TabTitleBar(options)` | 标题栏 | Tab 型标题栏 |
| **ToolBar / ToolBarV2** | `ToolBar(options)` / `ToolBarV2(options)` | 工具栏 | 底部工具栏 |
| **SubHeader / SubHeaderV2** | `SubHeader(options)` | 子标题 | 分组标题 |
| **Filter** | `Filter(options)` | 过滤器 | 筛选 |
| **SwipeRefresher** | `SwipeRefresher(options)` | 刷新 | 下拉刷新 |
| **SegmentButton / V2** | `SegmentButton(options)` | 分段按钮 | — |
| **ProgressButton / V2** | `ProgressButton(options)` | 进度按钮 | — |
| **DownloadFileButton** | `DownloadFileButton(options)` | 下载按钮 | — |
| **ArcButton** | `ArcButton(options)` | 圆形按钮 | 手表端 |
| **ArcSlider** | `ArcSlider(options)` | 圆形滑块 | 手表端 |
| **SplitLayout** | `SplitLayout(options)` | 分栏布局 | — |
| **FoldSplitContainer** | `FoldSplitContainer(options)` | 折叠分栏 | — |
| **MultiNavigation** | `MultiNavigation(options)` | 多级导航 | — |
| **GridObjectSortComponent** | `GridObjectSortComponent(options)` | 排序 | 网格排序 |
| **ExceptionPrompt** | `ExceptionPrompt(options)` | 提示 | 异常提示 |
| **FullScreenLaunchComponent** | `FullScreenLaunchComponent(options)` | 全屏启动 | — |

---
