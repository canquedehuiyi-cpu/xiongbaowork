## 7. 安全组件

> 来源：新版 `hmos-arkui-develop-skill`；集成与版本范围见 [知识库入口](../index.md)。

### SaveButton / PasteButton

免权限安全按钮。

**构造：**

```typescript
SaveButton(options: SaveButtonOptions)
PasteButton(options: PasteButtonOptions)
```

**通用属性方法 (Security 组件特有)：**

| 方法 | 说明 |
|------|------|
| `.iconColor(color)` | 图标颜色 |
| `.fontColor(color)` | 字体颜色 |
| `.bgColor(color)` | 背景颜色 |
| `.borderWidth(Length)` | 边框宽度 |
| `.borderRadius(Length)` | 圆角 |
| `.iconSize(Size)` | 图标尺寸 |
| `.fontWeight(FontWeight)` | 字重 |
| `.fontSize(Length)` | 字号 |
| `.fontStyle(FontStyle)` | 字体样式 |
| `.description(ResourceStr)` | 描述文本 |
| `.textIconSpace(Length)` | 文字图标间距 |

---
