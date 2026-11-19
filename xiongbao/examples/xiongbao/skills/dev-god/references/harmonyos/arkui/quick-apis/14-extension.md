## 14. 自定义扩展与节点入口

> 来源：新版 `hmos-arkui-develop-skill`；集成与版本范围见 [知识库入口](../index.md)。

此表用于定位类型，不是可直接复制的完整实现。泛型、方法签名和可修改属性应查看目标 SDK。

| 能力 | 查找类型/方法 | 用途 |
|---|---|---|
| 属性修饰 | AttributeModifier、applyNormalAttribute | 复用组件属性配置 |
| 属性更新 | AttributeUpdater | 与组件绑定的更新策略 |
| 绘制修饰 | DrawModifier | 绘制阶段扩展 |
| 手势修饰 | GestureModifier | 动态手势配置 |
| 内容修饰 | ContentModifier | 组件自定义内容，依具体组件声明 |
| 帧节点 | `new FrameNode(uiContext)` | 自定义节点；区分只读系统代理 |
| 绘制节点 | `new RenderNode()` | 属性与 draw 方法按声明使用，不假造 setter |
| Builder 节点 | `new BuilderNode(uiContext, options?)` | build/update/dispose 等需按所有权配套 |
| 节点控制器 | NodeController / makeNode | 配合 NodeContainer 挂载 |

[扩展约束](../quick-rules/11-extension.md)
