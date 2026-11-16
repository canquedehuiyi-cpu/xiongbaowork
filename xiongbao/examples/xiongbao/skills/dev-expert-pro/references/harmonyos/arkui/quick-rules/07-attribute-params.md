# 属性、参数与易混 API

以目标 SDK 声明确认组件、Options 和回调。编译器的 `Did you mean` 是线索，不能不核对语义就直接采纳。

| 易错写法/说法 | 正确区分 |
|---|---|
| Button 不支持 fontColor | `Button('文字').fontColor(...)` 有对应属性；自定义 children 的样式按子组件设置 |
| `TimePicker({ useMilitaryTime: true })` | `useMilitaryTime` 是组件链式属性；对话框 Options 有对应字段 |
| `DatePicker(...).onDateAccept(...)` | 组件事件与 DatePickerDialog 的接受回调分开；组件常用 `onDateChange` |
| `MenuItem({ value, icon })` | 组件 Options 常用 `content`、`startIcon`、`endIcon`；不要与其他菜单类型混淆 |
| `Shape({ viewPort: ... })` | Shape 构造与 `.viewPort(...)` 方法分开 |
| `Tabs(controller)` | 检查 Options 中 `controller` 字段 |
| `.margin(10, 20)` | 单值或带 top/right 等字段的 Options |
| `PersistentStorage.persistProps([{ key, default }])` | 对应字段是 `defaultValue` |
| Flex 完全不支持 space | 新版本 `space` 可接 `FlexSpaceOptions`，不是任意数字 |
| Stack 没有 alignContent 方法 | API 24 声明有 `.alignContent(Alignment)`；不可借用 Row 的 justifyContent |
| ListItemGroup 没有 divider | API 24 声明有 `.divider(...)`；区分 List 与分组各自分隔范围 |
| LengthMetrics.vp 是臆造 | 目标 SDK 支持此工厂时可以使用，需正确导入 |
| animation curve 只能枚举 | 某些声明支持 `Curve \| string \| ICurve`；使用合法格式，不一概禁止字符串 |
| overlay 只能传 Builder | 支持的重载包括文本或 Builder 等，不能直接传执行后的 UI 组件表达式 |
| Badge style 每个字段必填 | `style` 是必填对象，但 badgeSize/badgeColor 等字段可有默认值 |

回调参数不能自行收窄。如 TextPicker 可能返回 `string | string[]` 和 `number | number[]`；Video 的播放进度是带 time 的对象；Popup 状态回调带 isVisible。

组件属性并非跨组件通用：Text 的 textOverflow Options 与输入框的对应参数可能不同；Row/Column 的交叉轴枚举不同。安全组件也可能提供一般组件没有的属性名，如 bgColor，不能全局禁止该名字。

资源与枚举：
- 使用项目真实存在的 app 资源。`app_icon` 和 `startIcon` 都不是每个工程必然存在。
- 系统颜色资源能帮助主题适配，不能因一次名称错误全改成硬编码 hex。
- Image 支持的 Resource/URI/PixelMap 等输入按声明选择，不把所有字符串图源禁掉。
- 系统符号与枚举表是名称线索，最低 API 版本和拼写仍查目标 SDK。

[基础组件](../quick-apis/02-basic-components.md) · [枚举](../quick-apis/16-enums.md) · [资源名](../quick-apis/17-resources.md)
