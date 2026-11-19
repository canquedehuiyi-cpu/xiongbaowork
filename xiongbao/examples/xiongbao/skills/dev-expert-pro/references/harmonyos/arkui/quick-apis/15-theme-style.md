## 15. 主题与样式

> 来源：新版 `hmos-arkui-develop-skill`；集成与版本范围见 [知识库入口](../index.md)。

| API | 签名 | 说明 |
|-----|------|------|
| **WithTheme** | `WithTheme({theme}) { ... }` | 为子树绑定主题 |
| **@Styles** | `@Styles function name() { .width(100).height(100) }` | 通用样式提取 |
| **@Extend** | `@Extend(Component) function name(params) { ... }` | 组件扩展方法 |
| **stateStyles** | `.stateStyles({ normal: ..., pressed: ..., disabled: ..., focused: ..., selected: ... })` | 组件属性方法，具体样式值遵守 SDK 类型 |

---
