# 布局与容器

| 容器 | 常见直接子组件要求 |
|---|---|
| List | ListItem / ListItemGroup |
| Grid | GridItem |
| Tabs | TabContent |
| WaterFlow | FlowItem；header/footer 等按具体重载处理 |

条件渲染和迭代控制不会取消子组件约束。区分直接子组件和其内部内容；不要把容器限制误套到后代任意层级。

- LazyForEach/Repeat 虚拟滚动需要支持的容器与可确定的布局范围。检查列表高度、嵌套滚动和子项测量，避免一次布局所有数据。
- Scroll 自身不是所有列表懒加载方案的替代品；有长列表优先选择相应虚拟化容器。
- Row/Column 交叉轴枚举分别为 VerticalAlign/HorizontalAlign；Flex 的方向和换行共同影响对齐。
- RelativeContainer 的被引用锚点需要可解析 ID；确认锚点所属范围和链约束，不能把所有子组件都强制打 ID 当作修复。
- 安全区、键盘、旋转、分屏、系统字体缩放和滚动冲突需按目标页面检查。

[布局 API](../quick-apis/01-layout.md) · [渲染](06-rendering.md)
